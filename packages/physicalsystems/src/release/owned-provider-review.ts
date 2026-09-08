// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes } from "node:crypto"
import type { ChildProcess } from "node:child_process"
import { lstat, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { startOwnedReviewBrowser } from "./owned-review-browser"
import { startOwnedWindowsReviewBrowser } from "./owned-windows-review-browser"
import {
  runProviderBrowserReview,
  validateProviderBrowserReviewContext,
  type ProviderBrowserReviewContext,
} from "./provider-browser-review"
import { providerBrowserReviewTransport } from "./provider-browser-transport"
import { requireDisposablePublicRunner } from "./public-qualification"
import { sha256File } from "./qualification"
import { browserObservationError, type BrowserObservation } from "./browser-observation"

type ArtifactUploader = (
  name: string,
  files: string[],
  root: string,
  options: { retentionDays: number; compressionLevel: number },
) => Promise<{ id?: number; size?: number; digest?: string }>
export type OwnedProviderReviewSession = {
  child: Pick<ChildProcess, "stderr">
  attachment: Parameters<typeof providerBrowserReviewTransport>[0]
  openBrowser(url: string): Promise<boolean>
}
const failure = () => new Error("PROVIDER_REVIEW_UNCONFIRMED")

/** Optional real-provider phase, separate from the empty-PATH core smoke.
 * Only this running controller can upload the encrypted, time-limited challenge.
 * It returns observed facts, never a manually supplied qualification/PASS record. */
export async function runOwnedProviderBrowserReview(
  input: {
    env: NodeJS.ProcessEnv
    root: string
    artifact: string
    context: ProviderBrowserReviewContext
    runtimeEnvironment: NodeJS.ProcessEnv
    /** Resolve the callback value only after verified native process cleanup. */
    withSession<T>(
      environment: NodeJS.ProcessEnv,
      review: (session: OwnedProviderReviewSession) => Promise<T>,
    ): Promise<T>
  },
  io: {
    startBrowser?: typeof startOwnedReviewBrowser
    uploadArtifact?: ArtifactUploader
    fetcher?: typeof fetch
    platform?: NodeJS.Platform
    timeoutMs?: number
    pollMs?: number
  } = {},
) {
  const selection = input.env.PS_PROVIDER_REVIEW
  if (!selection || selection === "disabled")
    return { status: "NOT_TESTED" as const, reason: "NO_SELECTED_PROVIDER" as const }
  if (selection !== "openai-device") throw failure()
  const platform = io.platform ?? process.platform
  const root = await verifyOwnedReviewContext(input, platform)
  const nonce = randomBytes(32).toString("hex")
  const nonceSha256 = createHash("sha256").update(nonce).digest("hex")
  const browserRoot = join(root, "browser")
  const challengeRoot = join(root, "challenge")
  await Promise.all([mkdir(browserRoot, { mode: 0o700 }), mkdir(challengeRoot, { mode: 0o700 })])
  let browser: Awaited<ReturnType<typeof startOwnedReviewBrowser>> | undefined
  let uploaded: { artifactId: number; archiveSha256: string } | undefined
  let cleanupFailed = false
  let acquiring = false
  let openerUnconfirmed = false
  const observation: BrowserObservation = { reviewPhase: "context", openerAcknowledged: false }
  let observedError: unknown
  try {
    acquiring = true
    observation.reviewPhase = "browser-acquisition"
    browser = await (
      io.startBrowser ?? (platform === "win32" ? startOwnedWindowsReviewBrowser : startOwnedReviewBrowser)
    )({ env: input.env, root: browserRoot })
    acquiring = false
    // Runtime starts from the qualifier's scrubbed env. Never copy controller
    // env wholesale: Actions upload credentials stay exclusively in this process.
    acquiring = true
    observation.reviewPhase = "app-session"
    const outcome = await input.withSession(
      {
        ...input.runtimeEnvironment,
        ...browser.environment,
        PHYSICALSYSTEMS_ALLOW_DEVICES: "0",
        PHYSICALSYSTEMS_QUALIFICATION_TRACE: "1",
        PHYSICALSYSTEMS_PROVIDER_REVIEW: "openai-device",
        PHYSICALSYSTEMS_PROVIDER_REVIEW_NONCE: nonce,
      },
      async (session) => {
        let reviewFinished = false
        try {
          return await runProviderBrowserReview({
            provider: "openai-device",
            context: input.context,
            nonce,
            reviewerPublicKeyPem: input.env.PS_PROVIDER_REVIEW_PUBLIC_KEY_PEM ?? "",
            reviewerKeySha256: input.env.PS_PROVIDER_REVIEW_KEY_SHA256 ?? "",
            child: session.child,
            request: providerBrowserReviewTransport(session.attachment, io.fetcher),
            openBrowser: async (url) => {
              // False includes the product opener's own OS-handoff timeout;
              // only true acknowledgment settles this possible mutation.
              openerUnconfirmed = true
              observation.reviewPhase = "opener"
              const opened = await session.openBrowser(url)
              observation.openerAcknowledged = opened === true
              if (opened !== true) return false
              openerUnconfirmed = false
              if (reviewFinished) return false
              observation.reviewPhase = "target"
              return await browser!.confirmHandoff(url)
            },
            timeoutMs: io.timeoutMs,
            pollMs: io.pollMs,
            async publishChallenge(bytes) {
              if (uploaded || bytes.byteLength < 128 || bytes.byteLength > 65536) throw failure()
              const file = join(challengeRoot, "provider-review.sealed.json")
              await writeFile(file, bytes, { mode: 0o600, flag: "wx" })
              const name = `provider-review-${input.context.runId}-${input.context.runAttempt}-${input.context.platform}-${input.context.artifactSha256.slice(0, 12)}-${nonceSha256.slice(0, 12)}`
              const upload =
                io.uploadArtifact ??
                (async (...args: Parameters<ArtifactUploader>) => {
                  // Resolve the existing pinned desktop dependency, not an unrelated
                  // hoisted/transitive copy in another workspace package.
                  const require = createRequire(new URL("../../../desktop/package.json", import.meta.url))
                  const { DefaultArtifactClient } = (await import(
                    pathToFileURL(require.resolve("@actions/artifact")).href
                  )) as typeof import("@actions/artifact")
                  return new DefaultArtifactClient().uploadArtifact(...args)
                })
              const result = await upload(name, [file], challengeRoot, { retentionDays: 1, compressionLevel: 0 })
              if (!Number.isSafeInteger(result.id) || result.id! < 1 || !/^[a-f0-9]{64}$/.test(result.digest ?? ""))
                throw failure()
              uploaded = { artifactId: result.id!, archiveSha256: result.digest! }
            },
          })
        } catch (error) {
          observedError = error
          observation.failedReviewPhase ??= observation.reviewPhase
          return { status: "REVIEW_FAILED" as const }
        } finally {
          reviewFinished = true
        }
      },
    )
    acquiring = false
    const observed = outcome
    if (observed.status !== "OBSERVED" || !uploaded) throw failure()
    return { ...observed, challengeArtifact: uploaded, ownedBrowserProcessAndProfileCleanup: true as const }
  } catch (error) {
    observedError ??= error
    observation.failedReviewPhase ??= observation.reviewPhase
    throw browserObservationError("PROVIDER_REVIEW_UNCONFIRMED", observedError, observation)
  } finally {
    // A factory may have spawned before throwing. With no returned owner there
    // is no shutdown proof; preserve paths even if that factory tried cleanup.
    if (acquiring || openerUnconfirmed) cleanupFailed = true
    // withSession owns native shutdown. On rejection its cleanup is uncertain;
    // stop the browser, but retain the shared private QA paths.
    try {
      observation.reviewPhase = "browser-cleanup"
      await browser?.stop({ retainProfile: cleanupFailed })
    } catch (error) {
      observedError = error
      observation.failedReviewPhase ??= observation.reviewPhase
      cleanupFailed = true
    }
    if (!cleanupFailed)
      await rm(root, { recursive: true }).catch(() => {
        cleanupFailed = true
      })
    if (cleanupFailed) throw browserObservationError("PROVIDER_REVIEW_CLEANUP_UNCONFIRMED", observedError, observation)
  }
}

export async function verifyOwnedReviewContext(
  input: {
    env: NodeJS.ProcessEnv
    root: string
    artifact: string
    context: ProviderBrowserReviewContext
    runtimeEnvironment: NodeJS.ProcessEnv
  },
  platform: NodeJS.Platform,
) {
  validateProviderBrowserReviewContext(input.context)
  await requireDisposablePublicRunner(input.env, input.root, platform)
  if (
    input.context.platform !== (platform === "win32" ? "windows-x64" : "linux-x64") ||
    input.context.runId !== input.env.GITHUB_RUN_ID ||
    String(input.context.runAttempt) !== input.env.GITHUB_RUN_ATTEMPT ||
    input.context.sourceRevision !== input.env.PHYSICALSYSTEMS_PROVIDER_REVIEW_SOURCE_SHA ||
    input.context.releaseInputsSha256 !== input.env.PHYSICALSYSTEMS_EXPECTED_INPUTS_SHA256 ||
    input.runtimeEnvironment.PHYSICALSYSTEMS_ALLOW_DEVICES !== "0" ||
    Object.keys(input.runtimeEnvironment).some((key) =>
      /^(GITHUB_|ACTIONS_)|SECRET|TOKEN|PASSWORD|CREDENTIAL|^(NODE_OPTIONS|BUN_OPTIONS|NODE_PATH)$/.test(key),
    ) ||
    !(await lstat(input.artifact)).isFile() ||
    (await lstat(input.artifact)).isSymbolicLink() ||
    (await sha256File(input.artifact)) !== input.context.artifactSha256
  )
    throw failure()
  const root = await realpath(input.root)
  if ((await readdir(root)).length) throw failure()
  return root
}
