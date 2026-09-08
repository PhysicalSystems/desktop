// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { createHash, generateKeyPairSync } from "node:crypto"
import { mkdtemp, readFile, realpath, rm, writeFile, access } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { runOwnedProviderBrowserReview, type OwnedProviderReviewSession } from "./owned-provider-review"
import { ownedReviewBrowserEnvironment, reviewBrowserProcess, startOwnedReviewBrowser } from "./owned-review-browser"
import { providerAccountMarker } from "./provider-account"

const keys = generateKeyPairSync("rsa", { modulusLength: 3072 })
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")

async function fixture(
  options: {
    uploadFails?: boolean
    browserCleanupFails?: boolean
    nativeCleanupFails?: boolean
    handoff?: boolean
  } = {},
) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "owned-provider-review-")))
  const root = await realpath(await mkdtemp(join(temporary, "phase-")))
  const artifact = join(temporary, "installer")
  await writeFile(artifact, "immutable-inert-artifact")
  const state = {
    nativeStopped: false,
    browserStopped: false,
    removed: false,
    uploaded: false,
    calls: 0,
    nativeEnv: {} as NodeJS.ProcessEnv,
    sealed: "",
    lifecycle: [] as string[],
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
    platform: "linux-x64" as const,
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
    runtimeEnvironment: { PHYSICALSYSTEMS_ALLOW_DEVICES: "0", HOME: join(root, "app") },
    async withSession<T>(environment: NodeJS.ProcessEnv, review: (session: OwnedProviderReviewSession) => Promise<T>) {
      state.nativeEnv = environment
      state.lifecycle.push("launch")
      try {
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
            return true
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
    platform: "linux" as const,
    timeoutMs: 1000,
    pollMs: 1,
    async startBrowser(input: { env: NodeJS.ProcessEnv; root: string }) {
      return {
        environment: ownedReviewBrowserEnvironment(input.root, input.env),
        async confirmHandoff() {
          return options.handoff !== false
        },
        async stop(stop: { retainProfile?: boolean } = {}) {
          state.lifecycle.push("browser-stop")
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
      expect(name).toMatch(/^provider-review-123-2-linux-x64-[a-f0-9]{12}-[a-f0-9]{12}$/)
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
        connected = true
        stderr.write(providerAccountMarker("set", credential, { saved: true }, state.nativeEnv))
        stderr.write(providerAccountMarker("all", {}, { [credential.key]: credential.info }, state.nativeEnv))
        return response({ status: "complete" })
      }
      if (init?.method === "DELETE" && parsed.pathname === "/api/credential/cred_inert") {
        connected = false
        state.removed = true
      }
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
    expect(
      await runOwnedProviderBrowserReview(
        { ...f.input, env: { ...f.input.env, RUNNER_OS: "Windows" } },
        { ...f.io, platform: "win32" },
      ),
    ).toEqual({ status: "BLOCKED", reason: "BROWSER_OWNERSHIP_UNAVAILABLE" })
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

test("failed handoff/upload/cleanup cannot return observed and do not leak error details", async () => {
  for (const options of [
    { handoff: false },
    { uploadFails: true },
    { browserCleanupFails: true },
    { nativeCleanupFails: true },
  ]) {
    const f = await fixture(options)
    try {
      await expect(runOwnedProviderBrowserReview(f.input, f.io)).rejects.toThrow(
        options.browserCleanupFails || options.nativeCleanupFails
          ? "PROVIDER_REVIEW_CLEANUP_UNCONFIRMED"
          : "PROVIDER_REVIEW_UNCONFIRMED",
      )
      expect(f.state.lifecycle).toContain("browser-stop")
      if (options.nativeCleanupFails)
        expect(
          await access(f.input.root).then(
            () => true,
            () => false,
          ),
        ).toBe(true)
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
