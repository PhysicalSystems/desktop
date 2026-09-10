// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, readFile, readdir } from "node:fs/promises"
import path from "node:path"
import {
  publicReviewDigest,
  unsignedWindowsPreviewWarning,
  validateDistributionFacts,
  validateReview,
  verifyPublicDownloads,
} from "./public-downloads"
import type { PublicDistributionFacts, PublicDistributionReview } from "./public-downloads"

const repository = "PhysicalSystems/physicalsystems"
const apiRoot = `https://api.github.com/repos/${repository}`
const owner = "Physical Systems public desktop publisher v1"
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>
export type QualifiedDistribution = {
  schemaVersion: 1
  kind: "qualified-public-desktop-distribution"
  facts: PublicDistributionFacts
  qualificationBundleSha256: string
}
export type PreparedPublication = {
  schemaVersion: 1
  kind: "prepared-public-desktop-publication"
  qualificationSha256: string
  sourceRevision: string
  releaseId: number
  tag: string
  assets: { id: number; name: string; bytes: number; sha256: string }[]
}
type RemoteAsset = { id: number; name: string; size: number; state: string; digest?: string | null }
type RemoteRelease = {
  id: number
  tag_name: string
  draft: boolean
  prerelease: boolean
  body: string
  assets: RemoteAsset[]
}

function exact(input: unknown, keys: string[]) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid publication record")
  const record = input as Record<string, unknown>
  if (Object.keys(record).length !== keys.length || Object.keys(record).some((key) => !keys.includes(key)))
    throw new Error("Unexpected publication record fields")
  return record
}
function parseJson(bytes: string): unknown {
  try {
    return JSON.parse(bytes) as unknown
  } catch {
    throw new Error("Publication evidence must be valid JSON")
  }
}
function sha(input: Uint8Array | string) {
  return createHash("sha256").update(input).digest("hex")
}
function anchored(input: unknown, expected: string) {
  if (!/^[a-f0-9]{64}$/.test(expected) || publicReviewDigest(input) !== expected)
    throw new Error("Publication record differs from its independently trusted digest")
}
export function validateQualifiedDistribution(input: unknown, expectedSha256: string): QualifiedDistribution {
  anchored(input, expectedSha256)
  const data = exact(input, ["schemaVersion", "kind", "facts", "qualificationBundleSha256"])
  if (
    data.schemaVersion !== 1 ||
    data.kind !== "qualified-public-desktop-distribution" ||
    typeof data.qualificationBundleSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(data.qualificationBundleSha256)
  )
    throw new Error("Explicit public qualification is required; internal candidates are ineligible")
  return {
    schemaVersion: 1,
    kind: "qualified-public-desktop-distribution",
    facts: validateDistributionFacts(data.facts),
    qualificationBundleSha256: data.qualificationBundleSha256,
  }
}

/** Reads only an allowlisted, nonsymlinked bundle. This verifies the producer's
 * evidence and bytes; it does not infer missing native qualification or sign files.
 */
export async function verifyQualifiedBundle(input: {
  directory: string
  expectedSha256: string
  sourceRevision: string
}) {
  const root = path.resolve(input.directory)
  const read = async (name: string, maximum: number) => {
    const file = path.join(root, name)
    const stat = await lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maximum)
      throw new Error(`Invalid qualified bundle file: ${name}`)
    return readFile(file)
  }
  const stat = await lstat(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Qualification bundle must be a real directory")
  const data = validateQualifiedDistribution(
    parseJson((await read("qualified-distribution.json", 1024 ** 2)).toString()),
    input.expectedSha256,
  )
  if (data.facts.sourceRevision !== input.sourceRevision || !/^[a-f0-9]{40}$/.test(input.sourceRevision))
    throw new Error("Qualification belongs to a different reviewed source")
  const reports = [
    ...new Set([
      data.qualificationBundleSha256,
      data.facts.windowsSigning.verificationReportSha256,
      ...data.facts.assets.map((asset) => asset.qualification.reportSha256),
    ]),
  ]
  const expected = [
    "qualified-distribution.json",
    ...reports.map((digest) => `${digest}.json`),
    ...data.facts.assets.map((asset) => asset.name),
  ].sort()
  if (JSON.stringify((await readdir(root)).sort()) !== JSON.stringify(expected))
    throw new Error("Qualification bundle must contain only the exact installers and referenced public-safe receipts")
  for (const digest of reports) {
    const bytes = await read(`${digest}.json`, 2 * 1024 ** 2)
    if (sha(bytes) !== digest) throw new Error("Qualification receipt bytes differ from their trusted digest")
    parseJson(bytes.toString())
  }
  for (const asset of data.facts.assets) {
    const file = path.join(root, asset.name)
    const stat = await lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== asset.bytes)
      throw new Error("Installer size differs from the qualified bytes")
    const hash = createHash("sha256")
    for await (const chunk of createReadStream(file)) hash.update(chunk)
    if (hash.digest("hex") !== asset.sha256) throw new Error("Installer bytes differ from qualification")
  }
  return data
}

function boundedRequest(request: Fetcher): Fetcher {
  return async (url, init) => {
    try {
      return await request(url, init)
    } catch {
      throw new Error("Public release transport failed; outcome may be unconfirmed, reconcile before retrying")
    }
  }
}

function client(token: string, request: Fetcher) {
  if (!token || /[\r\n]/.test(token)) throw new Error("A narrowly scoped public-release credential is required")
  return async (endpoint: string, method = "GET", body?: unknown, missing = false) => {
    const response = await request(`${apiRoot}/${endpoint}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (missing && response.status === 404) {
      await response.body?.cancel().catch(() => {})
      return null
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new Error(`Public release ${method} failed (${response.status}); reconcile before retrying`)
    }
    return boundedJson(response)
  }
}
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("GitHub returned an empty response")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read().catch(() => {
        throw new Error("Public release stream failed; reconcile before retrying")
      })
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 2 * 1024 ** 2) throw new Error("GitHub metadata exceeds the supported size")
      chunks.push(chunk.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString()) as unknown
  } catch {
    throw new Error("GitHub returned malformed release metadata")
  }
}
function remoteRelease(input: unknown, data: QualifiedDistribution, digest: string): RemoteRelease {
  if (!input || typeof input !== "object") throw new Error("Malformed GitHub release")
  const release = input as RemoteRelease
  if (
    !Number.isSafeInteger(release.id) ||
    release.id <= 0 ||
    release.tag_name !== data.facts.tag ||
    typeof release.draft !== "boolean" ||
    release.prerelease !== (data.facts.channel === "preview") ||
    release.body !== releaseBody(data, digest) ||
    !Array.isArray(release.assets)
  )
    throw new Error("Release reservation conflicts with the qualified distribution; no mutation was performed")
  const names = new Set<string>()
  for (const asset of release.assets) {
    const expected = data.facts.assets.find((item) => item.name === asset.name)
    if (
      !expected ||
      names.has(asset.name) ||
      !Number.isSafeInteger(asset.id) ||
      asset.id <= 0 ||
      asset.size !== expected.bytes ||
      asset.state !== "uploaded" ||
      (asset.digest != null && asset.digest !== `sha256:${expected.sha256}`)
    )
      throw new Error("Existing release asset conflicts with the qualified inventory; assets are never overwritten")
    names.add(asset.name)
  }
  return release
}
function releaseBody(data: QualifiedDistribution, digest: string) {
  const source = `https://github.com/PhysicalSystems/desktop/blob/${data.facts.sourceRevision}/release`
  const debian = data.facts.assets.find((asset) => asset.name.endsWith(".deb"))!
  return `${owner}

Version: ${data.facts.version}
Desktop source: ${data.facts.sourceRevision}
Qualified distribution SHA-256: ${digest}
${data.facts.windowsSigning.status === "unsigned-preview" ? `\n**${unsignedWindowsPreviewWarning}**\n` : ""}

## Install and remove

- **Windows x64:** open the downloaded ${data.facts.windowsSigning.status === "verified" ? "signed" : "unsigned preview"} \`.exe\` installer, then launch **Physical Systems** from Start. To uninstall, use Windows Settings → Apps → Installed apps → Physical Systems → Uninstall.
- **Linux x64 (.deb):** the normal Linux download. From the download directory, run \`sudo apt install ./${debian.name}\`, then launch **Physical Systems** from the application menu or run \`physical-systems-desktop\`. Remove the application with \`sudo apt remove physical-systems-desktop\`.
- **AppImage — advanced:** launch the original artifact with \`--appimage-extract-and-run\` only after configuring its explicit, artifact-specific Ubuntu AppArmor prerequisite. Downloading the file alone does not configure that prerequisite. Follow the [AppImage setup and removal guide](${source}/appimage-runtime.md#advanced-user-setup).

See the [installation guide for this exact source](${source}/install-desktop.md). Uninstalling the program is separate from deleting personal conversations and credentials.

## Qualified scope

${data.facts.assets.some((asset) => asset.qualification.checks["provider-browser-sign-in"] === "NOT_TESTED") ? "Provider sign-in has not been verified for this preview.\n\n" : ""}Native checks cover GitHub-hosted Windows 2025 and Ubuntu 24.04 x64; Linux compositor checks run under X11/Xvfb. They exercise actual application input, compositor painting and zoom restoration. Wayland, AppImage double-click/FUSE startup, physical display behavior, GPU hardware and optical flicker are not measured.

The workflow uses synthetic experiments with device access disabled. It does not establish live robot behavior or authorize hardware motion. Upgrade/recovery evidence uses a lower-version public lab from the same reviewed source/storage schema and Windows signing policy; it does not establish historical database migration or power-loss recovery.

## SHA-256

${data.facts.assets.map((asset) => `- \`${asset.name}\`: \`${asset.sha256}\``).join("\n")}
`
}

async function verifyRemoteAsset(input: {
  request: Fetcher
  token: string
  asset: RemoteAsset
  expected: PublicDistributionFacts["assets"][number]
}) {
  let url = `${apiRoot}/releases/assets/${input.asset.id}`
  for (let redirect = 0; redirect <= 3; redirect++) {
    const response = await input.request(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(300_000),
      headers: {
        Accept: "application/octet-stream",
        ...(url.startsWith(`${apiRoot}/`)
          ? { Authorization: `Bearer ${input.token}`, "X-GitHub-Api-Version": "2022-11-28" }
          : {}),
      },
    })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel().catch(() => {})
      const next = URL.parse(response.headers.get("location") ?? "")
      if (
        !next ||
        next.protocol !== "https:" ||
        next.port ||
        next.username ||
        next.password ||
        next.hash ||
        !["release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(next.hostname)
      )
        throw new Error("Draft asset redirected outside GitHub release storage")
      url = next.href
      continue
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {})
      throw new Error("Draft asset readback failed")
    }
    const reader = response.body.getReader()
    const hash = createHash("sha256")
    let size = 0
    try {
      for (;;) {
        const chunk = await reader.read().catch(() => {
          throw new Error("Public release stream failed; reconcile before retrying")
        })
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > input.expected.bytes) throw new Error("Draft asset exceeds its qualified size")
        hash.update(chunk.value)
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
    if (size !== input.expected.bytes || hash.digest("hex") !== input.expected.sha256)
      throw new Error("Draft asset bytes differ from the exact qualified installer")
    return
  }
  throw new Error("Draft asset exceeded the redirect limit")
}

/** Idempotent reservation and completion of one owned draft. Uploads are never
 * clobbered. Ambiguous network outcomes fail and the next run reconciles via GET.
 */
export async function preparePublicPublication(input: {
  directory: string
  expectedSha256: string
  sourceRevision: string
  token: string
  fetch?: Fetcher
}) {
  const data = await verifyQualifiedBundle(input)
  const request = boundedRequest(input.fetch ?? fetch)
  const api = client(input.token, request)
  const releases: unknown[] = []
  for (let page = 1; ; page++) {
    if (page > 1000) throw new Error("Complete public release history could not be established")
    const batch = await api(`releases?per_page=100&page=${page}`)
    if (!Array.isArray(batch)) throw new Error("Malformed release history")
    releases.push(...batch)
    if (batch.length < 100) break
  }
  const matches = releases.filter(
    (item) => item && typeof item === "object" && (item as RemoteRelease).tag_name === data.facts.tag,
  )
  if (matches.length > 1) throw new Error("Duplicate release reservations require explicit reconciliation")
  const existing = matches[0]
  const release = existing
    ? remoteRelease(existing, data, input.expectedSha256)
    : await (async () => {
        if (await api(`git/ref/tags/${encodeURIComponent(data.facts.tag)}`, "GET", undefined, true))
          throw new Error("Desktop version is already reserved by an existing tag")
        // Source and download repositories differ. Fix the download-repository tag to
        // its current immutable main commit; desktop source identity stays in the review.
        const main = (await api("git/ref/heads/main")) as { object?: { sha?: string } }
        if (!main.object?.sha || !/^[a-f0-9]{40}$/.test(main.object.sha))
          throw new Error("Download repository main is not immutable")
        return remoteRelease(
          await api("releases", "POST", {
            tag_name: data.facts.tag,
            target_commitish: main.object.sha,
            name: `Physical Systems Desktop ${data.facts.version}`,
            body: releaseBody(data, input.expectedSha256),
            draft: true,
            prerelease: data.facts.channel === "preview",
            make_latest: "false",
          }),
          data,
          input.expectedSha256,
        )
      })()
  for (const asset of data.facts.assets) {
    const existing = release.assets.find((item) => item.name === asset.name)
    if (existing) {
      await verifyRemoteAsset({ request, token: input.token, asset: existing, expected: asset })
      continue
    }
    if (!release.draft)
      throw new Error("Published release is incomplete; it will not be repaired or replaced automatically")
    const response = await request(
      `https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(asset.name)}`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(300_000),
        headers: {
          Authorization: `Bearer ${input.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/octet-stream",
          "Content-Length": String(asset.bytes),
        },
        body: Bun.file(path.join(input.directory, asset.name)),
      },
    )
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new Error(`Installer upload failed (${response.status}); rerun to reconcile the reserved draft`)
    }
    await boundedJson(response)
  }
  const completed = remoteRelease(await api(`releases/${release.id}`), data, input.expectedSha256)
  if (completed.id !== release.id || completed.assets.length !== data.facts.assets.length)
    throw new Error("Draft inventory is incomplete")
  for (const asset of data.facts.assets)
    await verifyRemoteAsset({
      request,
      token: input.token,
      asset: completed.assets.find((item) => item.name === asset.name)!,
      expected: asset,
    })
  const prepared: PreparedPublication = {
    schemaVersion: 1,
    kind: "prepared-public-desktop-publication",
    qualificationSha256: input.expectedSha256,
    sourceRevision: input.sourceRevision,
    releaseId: completed.id,
    tag: data.facts.tag,
    assets: data.facts.assets.map((asset) => ({
      id: completed.assets.find((item) => item.name === asset.name)!.id,
      name: asset.name,
      bytes: asset.bytes,
      sha256: asset.sha256,
    })),
  }
  return { prepared, preparedSha256: publicReviewDigest(prepared) }
}

/** Call exclusively in the protected approval job. A string or JSON field cannot
 * authenticate that approval: the workflow environment is the authority boundary.
 */
export async function publishPreparedPublication(input: {
  directory: string
  expectedSha256: string
  sourceRevision: string
  token: string
  prepared: unknown
  expectedPreparedSha256: string
  approvedRunUrl: string
  fetch?: Fetcher
  publicFetch?: Fetcher
}) {
  const data = await verifyQualifiedBundle(input)
  anchored(input.prepared, input.expectedPreparedSha256)
  const prepared = exact(input.prepared, [
    "schemaVersion",
    "kind",
    "qualificationSha256",
    "sourceRevision",
    "releaseId",
    "tag",
    "assets",
  ]) as PreparedPublication
  if (
    prepared.schemaVersion !== 1 ||
    prepared.kind !== "prepared-public-desktop-publication" ||
    prepared.qualificationSha256 !== input.expectedSha256 ||
    prepared.sourceRevision !== input.sourceRevision ||
    prepared.tag !== data.facts.tag ||
    !Number.isSafeInteger(prepared.releaseId) ||
    prepared.releaseId <= 0
  )
    throw new Error("Prepared draft is not bound to this qualification")
  const review: PublicDistributionReview = {
    schemaVersion: 1,
    kind: "approved-public-desktop-distribution",
    ...data.facts,
    releaseId: prepared.releaseId,
    approval: {
      decision: "approved",
      protectedRunUrl: input.approvedRunUrl,
      qualificationBundleSha256: data.qualificationBundleSha256,
    },
  }
  const reviewSha256 = publicReviewDigest(review)
  validateReview(review, reviewSha256)
  const request = boundedRequest(input.fetch ?? fetch)
  const api = client(input.token, request)
  const release = remoteRelease(await api(`releases/${prepared.releaseId}`), data, input.expectedSha256)
  const inventory = data.facts.assets.map((asset) => ({
    id: release.assets.find((item) => item.name === asset.name)?.id,
    name: asset.name,
    bytes: asset.bytes,
    sha256: asset.sha256,
  }))
  if (
    release.id !== prepared.releaseId ||
    release.assets.length !== data.facts.assets.length ||
    publicReviewDigest(inventory) !== publicReviewDigest(prepared.assets)
  )
    throw new Error("Draft asset identities changed after preparation; approval cannot cover replacement assets")
  for (const asset of data.facts.assets)
    await verifyRemoteAsset({
      request,
      token: input.token,
      asset: release.assets.find((item) => item.name === asset.name)!,
      expected: asset,
    })
  if (release.draft) {
    // If this acknowledgement is lost, do not retry a mutation in this run. A rerun
    // reads the same release ID first and can complete anonymous readback safely.
    const published = remoteRelease(
      await api(`releases/${release.id}`, "PATCH", { draft: false, make_latest: "false" }),
      data,
      input.expectedSha256,
    )
    if (published.id !== release.id || published.draft)
      throw new Error("Publication is unconfirmed; reconcile the reserved release ID")
  }
  const selection = await verifyPublicDownloads({
    review,
    expectedReviewSha256: reviewSha256,
    fetch: boundedRequest(input.publicFetch ?? fetch),
  }).catch(() => {
    throw new Error(
      "Anonymous download readback did not verify; preserve the previous website selection and retry readback",
    )
  })
  return { review, reviewSha256, selection }
}

/** The runner supplies these API responses before handling release credentials.
 * The run is still executing, so require its completed collector job instead of
 * requiring the entire pipeline to have succeeded. A publication-only retry may
 * reuse successful qualification from an earlier attempt of this same run.
 */
export function validatePublisherPrerequisites(input: {
  run: unknown
  attempt: unknown
  jobs: unknown
  environment: unknown
  runId: string
  runAttempt: string
  currentRunAttempt: string
  sourceRevision: string
}) {
  if (
    !/^[1-9]\d*$/.test(input.runId) ||
    !/^[1-9]\d*$/.test(input.runAttempt) ||
    !/^[1-9]\d*$/.test(input.currentRunAttempt) ||
    BigInt(input.runAttempt) > BigInt(input.currentRunAttempt) ||
    !/^[a-f0-9]{40}$/.test(input.sourceRevision)
  )
    throw new Error("Qualification run, attempt and source must be immutable identities")
  for (const [value, expectedAttempt, current] of [
    [input.run, input.currentRunAttempt, true],
    [input.attempt, input.runAttempt, input.runAttempt === input.currentRunAttempt],
  ] as const) {
    if (!value || typeof value !== "object") throw new Error("Qualification run could not be verified")
    const run = value as {
      id: number
      run_attempt: number
      status: string
      conclusion: string | null
      path: string
      head_sha: string
      head_branch: string
      event: string
      repository?: { full_name?: string }
      head_repository?: { full_name?: string }
    }
    if (
      String(run.id) !== input.runId ||
      String(run.run_attempt) !== expectedAttempt ||
      (current
        ? run.status !== "in_progress" || run.conclusion !== null
        : run.status !== "completed" || !["success", "failure", "cancelled"].includes(run.conclusion ?? "")) ||
      run.path !== ".github/workflows/desktop-public-release.yml" ||
      run.head_sha !== input.sourceRevision ||
      run.head_branch !== "main" ||
      run.event !== "workflow_dispatch" ||
      run.repository?.full_name !== "PhysicalSystems/desktop" ||
      run.head_repository?.full_name !== "PhysicalSystems/desktop"
    )
      throw new Error("Expected the executing owned release pipeline and its trusted public qualification attempt")
  }
  if (!input.jobs || typeof input.jobs !== "object") throw new Error("Qualification jobs are unavailable")
  const jobs = input.jobs as {
    total_count?: number
    jobs?: { run_id?: number; head_sha?: string; name?: string; status?: string; conclusion?: string }[]
  }
  if (!Array.isArray(jobs.jobs) || jobs.total_count !== jobs.jobs.length)
    throw new Error("Qualification job listing must be complete")
  const collectors = jobs.jobs.filter((job) => job?.name === "Verify Windows and Linux test results")
  if (
    collectors.length !== 1 ||
    String(collectors[0]!.run_id) !== input.runId ||
    collectors[0]!.head_sha !== input.sourceRevision ||
    collectors[0]!.status !== "completed" ||
    collectors[0]!.conclusion !== "success"
  )
    throw new Error("The exact qualification attempt must have one successful Windows/Linux collector job")
  if (!input.environment || typeof input.environment !== "object")
    throw new Error("Protected publication environment is unavailable")
  const environment = input.environment as {
    name: string
    protection_rules?: { type: string; reviewers?: unknown[] }[]
  }
  if (
    environment.name !== "desktop-public-release" ||
    !environment.protection_rules?.some(
      (rule) => rule.type === "required_reviewers" && Array.isArray(rule.reviewers) && rule.reviewers.length > 0,
    )
  )
    throw new Error("Configure required reviewers on desktop-public-release before preparing any draft")
}
