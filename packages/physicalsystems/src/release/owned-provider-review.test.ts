// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { createHash, generateKeyPairSync } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, access } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { runOwnedProviderBrowserReview, type OwnedProviderReviewSession } from "./owned-provider-review"
import { ownedReviewBrowserEnvironment, reviewBrowserProcess, startOwnedReviewBrowser } from "./owned-review-browser"
import { readBrowserObservation } from "./browser-observation"
import { providerAccountMarker } from "./provider-account"
import { qualificationEnvironment } from "./qualification"

const keys = generateKeyPairSync("rsa", { modulusLength: 3072 })
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")

async function fixture(
  options: {
    uploadFails?: boolean
    browserCleanupFails?: boolean
    nativeCleanupFails?: boolean
    handoff?: boolean
    opened?: boolean
    rejectedOpen?: boolean
    targetRead?: "delayed" | "pending"
    credentialRemovalFails?: boolean
    pending?: boolean
    writeTemporaryFile?: boolean
  } = {},
) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "owned-provider-review-")))
  const root = await realpath(await mkdtemp(join(temporary, "phase-")))
  const artifact = join(temporary, "installer")
  await writeFile(artifact, "immutable-inert-artifact")
  const state = {
    nativeStopped: false,
    browserStopped: false,
    retained: false,
    removed: false,
    attemptCancelled: false,
    uploaded: false,
    calls: 0,
    nativeEnv: {} as NodeJS.ProcessEnv,
    sealed: "",
    lifecycle: [] as string[],
    settleTarget: () => {},
    confirmationActive: false,
  }
  const stderr = new PassThrough()
  let connected = false
  const credential = {
    key: "physicalsystems.v2." + hash("openai"),
    info: {
      kind: "physicalsystems-v2-credential",
      record: {
        id: "cred_inert",
        integrationID: "openai",
        value: {
          type: "oauth",
          methodID: "chatgpt-headless",
          access: "PRIVATE-TOKEN-CANARY",
          refresh: "PRIVATE-REFRESH",
          metadata: { accountID: "PRIVATE-ACCOUNT" },
        },
      },
    },
  }
  const context = {
    runId: "123",
    runAttempt: 2,
    sourceRevision: "a".repeat(40),
    artifactSha256: hash("immutable-inert-artifact"),
    releaseInputsSha256: "b".repeat(64),
    platform: "linux-x64" as "linux-x64" | "windows-x64",
  }
  const env: NodeJS.ProcessEnv = {
    CI: "true",
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    RUNNER_OS: "Linux",
    RUNNER_TEMP: temporary,
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "2",
    ACTIONS_RUNTIME_TOKEN: "PRIVATE-ACTIONS-TOKEN",
    PHYSICALSYSTEMS_PROVIDER_REVIEW_SOURCE_SHA: context.sourceRevision,
    PHYSICALSYSTEMS_EXPECTED_INPUTS_SHA256: context.releaseInputsSha256,
    PS_PROVIDER_REVIEW: "openai-device",
    PS_PROVIDER_REVIEW_PUBLIC_KEY_PEM: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    PS_PROVIDER_REVIEW_KEY_SHA256: hash(keys.publicKey.export({ type: "spki", format: "der" })),
  }
  const input = {
    env,
    root,
    artifact,
    context,
    runtimeEnvironment: qualificationEnvironment({}, join(root, "application")) as NodeJS.ProcessEnv,
    async withSession<T>(environment: NodeJS.ProcessEnv, review: (session: OwnedProviderReviewSession) => Promise<T>) {
      state.nativeEnv = environment
      state.lifecycle.push("launch")
      try {
        if (options.writeTemporaryFile) {
          await mkdir(environment.TEMP!, { recursive: true })
          await writeFile(join(environment.TEMP!, "inert-app.tmp"), "inert temporary app data")
        }
        return await review({
          child: { stderr },
          attachment: {
            url: "http://127.0.0.1:2345",
            username: "opencode",
            password: "PRIVATE-ATTACHMENT",
            directory: root,
          },
          async openBrowser(url: string) {
            expect(url).toBe("https://auth.openai.com/codex/device")
            if (options.rejectedOpen) throw Error("PRIVATE-OPENER-OUTCOME-LOST")
            return options.opened !== false
          },
        })
      } finally {
        state.lifecycle.push("native-stop")
        if (options.nativeCleanupFails) throw Error("PRIVATE-STOP")
        state.nativeStopped = true
      }
    },
  }
  const io = {
    platform: "linux" as "linux" | "win32",
    timeoutMs: 1000,
    pollMs: 1,
    async startBrowser(input: { env: NodeJS.ProcessEnv; root: string }) {
      return {
        environment:
          io.platform === "win32"
            ? {
                HOME: input.root,
                APPDATA: join(input.root, "AppData", "Roaming"),
                TEMP: input.root,
                TMP: input.root,
              }
            : ownedReviewBrowserEnvironment(input.root, input.env),
        async confirmHandoff(_url: string, input: { signal?: AbortSignal } = {}) {
          if (options.targetRead) {
            state.lifecycle.push("target-start")
            state.confirmationActive = true
            const pending = new Promise<void>((resolve) => {
              state.settleTarget = resolve
            })
            if (options.targetRead === "delayed")
              input.signal?.addEventListener(
                "abort",
                () => {
                  state.lifecycle.push("target-cancel")
                  setTimeout(state.settleTarget, 10)
                },
                { once: true },
              )
            await pending
            state.confirmationActive = false
            state.lifecycle.push("target-settled")
          }
          return options.handoff !== false
        },
        releaseController() {
          state.lifecycle.push("browser-release")
        },
        async stop(stop: { retainProfile?: boolean } = {}) {
          expect(state.confirmationActive).toBe(false)
          state.lifecycle.push("browser-stop")
          state.retained = stop.retainProfile === true
          if (options.browserCleanupFails) throw Error("PRIVATE-BROWSER-STOP")
          if (options.nativeCleanupFails) expect(stop.retainProfile).toBe(true)
          state.browserStopped = true
          if (!stop.retainProfile) await rm(input.root, { recursive: true })
        },
      }
    },
    async uploadArtifact(
      name: string,
      files: string[],
      directory: string,
      options: { retentionDays: number; compressionLevel: number },
    ) {
      expect(state.nativeStopped).toBe(false)
      expect(state.browserStopped).toBe(false)
      expect(name).toMatch(/^provider-review-123-2-(?:linux|windows)-x64-[a-f0-9]{64}-[a-f0-9]{64}$/)
      expect(files).toEqual([join(directory, "provider-review.sealed.json")])
      expect(options).toEqual({ retentionDays: 1, compressionLevel: 0 })
      state.sealed = await readFile(files[0]!, "utf8")
      if (options && state.sealed.includes("PRIVATE")) throw Error("plaintext")
      state.uploaded = true
      return { id: 456, digest: "c".repeat(64) }
    },
    fetcher: (async (url: URL | RequestInfo, init?: RequestInit) => {
      state.calls++
      const parsed = new URL(String(url))
      expect(parsed.origin).toBe("http://127.0.0.1:2345")
      expect(parsed.searchParams.get("location[directory]")).toBe(root)
      const response = (data: unknown) =>
        new Response(JSON.stringify({ location: { directory: root }, data }), { status: 200 })
      if (init?.method === "GET" && parsed.pathname === "/api/integration/openai")
        return response({
          id: "openai",
          methods: [{ type: "oauth", id: "chatgpt-headless" }],
          connections: connected ? [{ type: "credential", id: "cred_inert" }] : [],
        })
      if (init?.method === "POST")
        return response({
          attemptID: "con_inert",
          mode: "auto",
          url: "https://auth.openai.com/codex/device",
          instructions: "Enter code: PRIVATE-CODE",
          time: { created: Date.now(), expires: Date.now() + 600000 },
        })
      if (init?.method === "GET" && parsed.pathname === "/api/integration/attempt/con_inert") {
        expect(state.uploaded).toBe(true)
        if (options.pending) return response({ status: "pending" })
        connected = true
        stderr.write(providerAccountMarker("set", credential, { saved: true }, state.nativeEnv))
        stderr.write(providerAccountMarker("all", {}, { [credential.key]: credential.info }, state.nativeEnv))
        return response({ status: "complete" })
      }
      if (init?.method === "DELETE" && parsed.pathname === "/api/credential/cred_inert") {
        if (options.credentialRemovalFails) throw Error("PRIVATE-REMOVE-OUTCOME-LOST")
        connected = false
        state.removed = true
      }
      if (init?.method === "DELETE" && parsed.pathname === "/api/integration/attempt/con_inert")
        state.attemptCancelled = true
      if (init?.method === "DELETE") return new Response(null, { status: 204 })
      throw Error("PRIVATE-FIXTURE-FAILURE")
    }) as typeof fetch,
  }
  if (options.uploadFails)
    io.uploadArtifact = async () => {
      throw Error("PRIVATE-UPLOAD-ERROR")
    }
  return { input, io, state, cleanup: () => rm(temporary, { recursive: true, force: true }) }
}

test("owned wrapper uploads only ciphertext while polling and cleans native before browser", async () => {
  const f = await fixture()
  try {
    const result = await runOwnedProviderBrowserReview(f.input, f.io)
    expect(result.status).toBe("OBSERVED")
    expect(JSON.stringify(result)).not.toContain("PRIVATE")
    expect(JSON.stringify(result)).not.toContain("PASS")
    expect(f.state.sealed).not.toContain("PRIVATE")
    expect(f.state.nativeEnv.ACTIONS_RUNTIME_TOKEN).toBeUndefined()
    expect(f.state.nativeEnv.PS_PROVIDER_REVIEW_PUBLIC_KEY_PEM).toBeUndefined()
    expect(f.state.nativeEnv.PHYSICALSYSTEMS_ALLOW_DEVICES).toBe("0")
    expect(f.state.lifecycle).toEqual(["launch", "native-stop", "browser-stop"])
    expect(f.state.removed).toBe(true)
    expect(
      await access(f.input.root).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
  } finally {
    await f.cleanup()
  }
})

test("disabled, unsupported ownership, changed anchors and inherited credentials never start OAuth", async () => {
  const f = await fixture()
  try {
    expect(await runOwnedProviderBrowserReview({ ...f.input, env: {} }, f.io)).toEqual({
      status: "NOT_TESTED",
      reason: "NO_SELECTED_PROVIDER",
    })
    await expect(
      runOwnedProviderBrowserReview(
        { ...f.input, env: { ...f.input.env, RUNNER_OS: "Windows" } },
        { ...f.io, platform: "win32" },
      ),
    ).rejects.toThrow("PROVIDER_REVIEW_UNCONFIRMED")
    for (const input of [
      { ...f.input, context: { ...f.input.context, sourceRevision: "f".repeat(40) } },
      { ...f.input, runtimeEnvironment: { ...f.input.runtimeEnvironment, ACTIONS_RUNTIME_TOKEN: "PRIVATE" } },
      { ...f.input, env: { ...f.input.env, CI: "false" } },
    ])
      await expect(runOwnedProviderBrowserReview(input, f.io)).rejects.toThrow()
    expect(f.state.calls).toBe(0)
    expect(f.state.lifecycle).toEqual([])
  } finally {
    await f.cleanup()
  }
})

test("Windows provider review keeps qualified app temp separate and preserves cleanup failures", async () => {
  for (const browserCleanupFails of [false, true]) {
    const f = await fixture({ writeTemporaryFile: true, browserCleanupFails })
    try {
      f.io.platform = "win32"
      f.input.env.RUNNER_OS = "Windows"
      f.input.context.platform = "windows-x64"
      const temporary = f.input.runtimeEnvironment.TEMP!
      const start = f.io.startBrowser
      f.io.startBrowser = async (input) => {
        const browser = await start(input)
        f.input.runtimeEnvironment.TEMP = input.root
        f.input.runtimeEnvironment.TMP = input.root
        return browser
      }
      const outcome = runOwnedProviderBrowserReview(f.input, f.io)
      if (browserCleanupFails) await expect(outcome).rejects.toThrow("PROVIDER_REVIEW_CLEANUP_UNCONFIRMED")
      else expect((await outcome).status).toBe("OBSERVED")
      expect(f.state.nativeEnv.TEMP).toBe(temporary)
      expect(f.state.nativeEnv.TMP).toBe(temporary)
      expect(f.state.nativeEnv.TMPDIR).toBe(temporary)
      expect(f.state.nativeEnv.HOME).toBe(join(f.input.root, "browser"))
      expect(f.state.nativeEnv.APPDATA).toBe(join(f.input.root, "browser", "AppData", "Roaming"))
      expect(f.state.lifecycle).toEqual(["launch", "native-stop", "browser-stop"])
      expect(
        await access(join(temporary, "inert-app.tmp")).then(
          () => true,
          () => false,
        ),
      ).toBe(browserCleanupFails)
      expect(
        await access(f.input.root).then(
          () => true,
          () => false,
        ),
      ).toBe(browserCleanupFails)
    } finally {
      await f.cleanup()
    }
  }
})

test("Windows provider review rejects missing or non-owned app temp before acquiring the browser", async () => {
  for (const key of ["TEMP", "TMP"] as const) {
    for (const invalid of [undefined, "", "relative", "browser", "outside", "traversal"]) {
      const f = await fixture()
      let acquired = false
      try {
        f.io.platform = "win32"
        f.input.env.RUNNER_OS = "Windows"
        f.input.context.platform = "windows-x64"
        f.input.runtimeEnvironment[key] =
          invalid === "browser"
            ? join(f.input.root, "browser")
            : invalid === "outside"
              ? join(f.input.env.RUNNER_TEMP!, "ambient")
              : invalid === "traversal"
                ? f.input.runtimeEnvironment[key] + "/../tmp"
                : invalid
        f.io.startBrowser = async () => {
          acquired = true
          throw Error("inert unexpected acquisition")
        }
        await expect(runOwnedProviderBrowserReview(f.input, f.io)).rejects.toThrow()
        expect(acquired).toBe(false)
        expect(f.state.calls).toBe(0)
        expect(f.state.lifecycle).toEqual([])
      } finally {
        await f.cleanup()
      }
    }
  }
})

test("actual-provider wrapper retains private paths when the OS opener outcome is unconfirmed", async () => {
  for (const options of [{ opened: false }, { rejectedOpen: true }]) {
    const f = await fixture(options)
    try {
      await expect(runOwnedProviderBrowserReview(f.input, f.io)).rejects.toThrow("PROVIDER_REVIEW_CLEANUP_UNCONFIRMED")
      expect(f.state.nativeStopped).toBe(true)
      expect(f.state.browserStopped).toBe(true)
      expect(f.state.retained).toBe(true)
      await access(f.input.root)
    } finally {
      await f.cleanup()
    }
  }
})

test("failed handoff/upload remains unobserved and failed native/browser cleanup retains private paths", async () => {
  for (const options of [
    { handoff: false },
    { uploadFails: true },
    { browserCleanupFails: true },
    { nativeCleanupFails: true },
  ]) {
    const f = await fixture(options)
    try {
      const cleanupFailed = options.nativeCleanupFails || options.browserCleanupFails || false
      const error = await runOwnedProviderBrowserReview(f.input, f.io).catch((error) => error)
      expect(error.message).toBe(cleanupFailed ? "PROVIDER_REVIEW_CLEANUP_UNCONFIRMED" : "PROVIDER_REVIEW_UNCONFIRMED")
      expect(f.state.lifecycle).toContain("browser-stop")
      expect(
        await access(f.input.root).then(
          () => true,
          () => false,
        ),
      ).toBe(cleanupFailed)
      expect(JSON.stringify(readBrowserObservation(error))).not.toContain("PRIVATE")
    } finally {
      await f.cleanup()
    }
  }
})

test("browser environment rejects ambient loader/credential hooks and process parser preserves ownership fields", async () => {
  const env = ownedReviewBrowserEnvironment("/owned", {
    DISPLAY: ":99",
    TOKEN: "private",
    NODE_OPTIONS: "private",
    PATH: "/ambient",
  })
  expect(env).toMatchObject({ HOME: "/owned", DISPLAY: ":99", PATH: "/usr/bin:/bin", BROWSER: "/owned/browser" })
  expect(JSON.stringify(env)).not.toContain("private")
  const stat = "451 (chrome (review)) S " + [1, 451, 451, ...Array(15).fill(0), 9988, 0].join(" ")
  expect(reviewBrowserProcess(stat)).toEqual({ pid: 451, group: 451, session: 451, birth: "9988", state: "S" })
  expect(() => reviewBrowserProcess("invalid")).toThrow("PROVIDER_REVIEW_BROWSER_UNCONFIRMED")
  await expect(startOwnedReviewBrowser({ root: "/", env: {} })).rejects.toThrow(
    "PUBLIC_QUALIFICATION_REQUIRES_DISPOSABLE_RUNNER",
  )
})

test("failed browser/native acquisition retains private paths when no owner is returned", async () => {
  for (const phase of ["browser", "native"] as const) {
    const f = await fixture()
    try {
      const withSession =
        phase === "native"
          ? async () => {
              throw Error("PRIVATE-PARTIAL-NATIVE")
            }
          : f.input.withSession
      const startBrowser =
        phase === "browser"
          ? async () => {
              throw Error("PRIVATE-PARTIAL-BROWSER")
            }
          : f.io.startBrowser
      await expect(
        runOwnedProviderBrowserReview({ ...f.input, withSession }, { ...f.io, startBrowser }),
      ).rejects.toThrow("PROVIDER_REVIEW_CLEANUP_UNCONFIRMED")
      expect(
        await access(f.input.root).then(
          () => true,
          () => false,
        ),
      ).toBe(true)
      expect(f.state.calls).toBe(0)
    } finally {
      await f.cleanup()
    }
  }
})

test("provider eligibility timeout drains the exact target task before native cleanup, or retains without browser operations", async () => {
  for (const targetRead of ["delayed", "pending"] as const) {
    const f = await fixture({ targetRead })
    try {
      const error = await runOwnedProviderBrowserReview(f.input, { ...f.io, quiescenceTimeoutMs: 100 }).catch(
        (error) => error,
      )
      expect(error.message).toBe(
        targetRead === "delayed" ? "PROVIDER_REVIEW_UNCONFIRMED" : "PROVIDER_REVIEW_CLEANUP_UNCONFIRMED",
      )
      expect(f.state.uploaded).toBe(false)
      expect(readBrowserObservation(error)).toMatchObject({
        handoffQuiescence: targetRead === "delayed" ? "settled" : "unconfirmed",
        failedReviewPhase: "target",
      })
      if (targetRead === "delayed") {
        expect(f.state.lifecycle).toEqual([
          "launch",
          "target-start",
          "target-cancel",
          "target-settled",
          "native-stop",
          "browser-stop",
        ])
        expect(f.state.nativeStopped).toBe(true)
        expect(f.state.retained).toBe(false)
        expect(
          await access(f.input.root).then(
            () => true,
            () => false,
          ),
        ).toBe(false)
      } else {
        expect(f.state.lifecycle).toEqual(["launch", "target-start", "native-stop", "browser-release"])
        await access(f.input.root)
        f.state.settleTarget()
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(f.state.browserStopped).toBe(false)
        await access(f.input.root)
      }
    } finally {
      f.state.settleTarget()
      await f.cleanup()
    }
  }
}, 20000)

test("failed credential removal propagates cleanup uncertainty and preserves private review state", async () => {
  const f = await fixture({ credentialRemovalFails: true })
  try {
    const error = await runOwnedProviderBrowserReview(f.input, f.io).catch((error) => error)
    expect(error.message).toBe("PROVIDER_REVIEW_CLEANUP_UNCONFIRMED")
    expect(f.state.removed).toBe(false)
    expect(f.state.retained).toBe(true)
    expect(f.state.nativeStopped).toBe(true)
    expect(f.state.browserStopped).toBe(true)
    expect(JSON.stringify(error)).not.toContain("PRIVATE")
    await access(f.input.root)
  } finally {
    await f.cleanup()
  }
})

test("expired approval remains unobserved while confirmed credential and native cleanup permits owned path removal", async () => {
  for (const nativeCleanupFails of [false, true]) {
    const f = await fixture({ pending: true, nativeCleanupFails })
    try {
      const error = await runOwnedProviderBrowserReview(f.input, { ...f.io, timeoutMs: 100 }).catch((error) => error)
      expect(error.message).toBe(
        nativeCleanupFails ? "PROVIDER_REVIEW_CLEANUP_UNCONFIRMED" : "PROVIDER_REVIEW_UNCONFIRMED",
      )
      expect(f.state.uploaded).toBe(true)
      expect(f.state.attemptCancelled).toBe(true)
      expect(f.state.removed).toBe(false)
      expect(f.state.nativeStopped).toBe(!nativeCleanupFails)
      expect(f.state.browserStopped).toBe(true)
      expect(f.state.retained).toBe(nativeCleanupFails)
      expect(f.state.lifecycle).toEqual(["launch", "native-stop", "browser-stop"])
      expect(
        await access(f.input.root).then(
          () => true,
          () => false,
        ),
      ).toBe(nativeCleanupFails)
      expect(JSON.stringify(readBrowserObservation(error))).not.toContain("PRIVATE")
    } finally {
      await f.cleanup()
    }
  }
})

test("challenge publication must settle before cleanup can remove its owned files", async () => {
  for (const outcome of ["rejected", "pending"] as const) {
    const f = await fixture()
    const upload = Promise.withResolvers<{ id: number; digest: string }>()
    const finished = Promise.withResolvers<void>()
    let settled = false
    const running = runOwnedProviderBrowserReview(f.input, {
      ...f.io,
      async uploadArtifact(_name, files) {
        try {
          expect(await readFile(files[0]!, "utf8")).not.toContain("PRIVATE")
          if (outcome === "rejected") throw new Error("PRIVATE UPLOAD REJECTION")
          return await upload.promise
        } finally {
          settled = true
          finished.resolve()
        }
      },
    })
    try {
      // Exercise the existing 30-second publication boundary with inert I/O;
      // no native execution, network request, or production timeout override.
      const error = await running.catch((error) => error)
      expect(error.message).toBe(
        outcome === "pending" ? "PROVIDER_REVIEW_CLEANUP_UNCONFIRMED" : "PROVIDER_REVIEW_UNCONFIRMED",
      )
      expect(settled).toBe(outcome === "rejected")
      expect(f.state.attemptCancelled).toBe(true)
      expect(f.state.nativeStopped).toBe(true)
      expect(f.state.browserStopped).toBe(true)
      expect(f.state.retained).toBe(outcome === "pending")
      expect(
        await access(join(f.input.root, "challenge", "provider-review.sealed.json")).then(
          () => true,
          () => false,
        ),
      ).toBe(outcome === "pending")
      expect(JSON.stringify(readBrowserObservation(error))).not.toContain("PRIVATE")
      upload.resolve({ id: 456, digest: "c".repeat(64) })
      await finished.promise
      expect(
        await access(f.input.root).then(
          () => true,
          () => false,
        ),
      ).toBe(outcome === "pending")
    } finally {
      upload.resolve({ id: 456, digest: "c".repeat(64) })
      await running.catch(() => {})
      await finished.promise
      await f.cleanup()
    }
  }
}, 40000)
