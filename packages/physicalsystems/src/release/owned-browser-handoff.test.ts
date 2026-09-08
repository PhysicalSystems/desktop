// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { runOwnedBrowserHandoffReview } from "./owned-browser-handoff"
import type { OwnedProviderReviewSession } from "./owned-provider-review"
import { validateBrowserProbeURL } from "./owned-review-browser"
import { qualificationFailureCode } from "./qualification"
import { browserObservationError, readBrowserObservation } from "./browser-observation"

async function fixture(
  options: {
    opened?: boolean
    target?: boolean
    request?: boolean
    lateRequest?: boolean
    pendingOpen?: boolean
    rejectedOpen?: boolean
    nativeCleanupFails?: boolean
    browserCleanupFails?: boolean
    browserStartFails?: boolean
    observedBrowserStartFails?: boolean
  } = {},
) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "browser-handoff-fixture-")))
  const root = await realpath(await mkdtemp(join(temporary, "phase-")))
  const artifact = join(temporary, "installer")
  await writeFile(artifact, "inert-installer")
  const context = {
    runId: "123",
    runAttempt: 1,
    sourceRevision: "a".repeat(40),
    artifactSha256: createHash("sha256").update("inert-installer").digest("hex"),
    releaseInputsSha256: "b".repeat(64),
    platform: "linux-x64" as "linux-x64" | "windows-x64",
  }
  const state = {
    events: [] as string[],
    url: "",
    nonce: "",
    nativeEnv: {} as NodeJS.ProcessEnv,
    nativeStarted: false,
    retained: false,
    settleOpen: () => {},
  }
  const input = {
    env: {
      CI: "true",
      GITHUB_ACTIONS: "true",
      RUNNER_ENVIRONMENT: "github-hosted",
      RUNNER_OS: "Linux",
      RUNNER_TEMP: temporary,
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "1",
      PHYSICALSYSTEMS_PROVIDER_REVIEW_SOURCE_SHA: context.sourceRevision,
      PHYSICALSYSTEMS_EXPECTED_INPUTS_SHA256: context.releaseInputsSha256,
      PS_BROWSER_REVIEW: "1",
      PS_PROVIDER_REVIEW: "disabled",
    },
    root,
    artifact,
    context,
    runtimeEnvironment: { PHYSICALSYSTEMS_ALLOW_DEVICES: "0" },
    async withSession<T>(environment: NodeJS.ProcessEnv, review: (session: OwnedProviderReviewSession) => Promise<T>) {
      state.nativeStarted = true
      state.nativeEnv = environment
      try {
        return await review({
          child: { stderr: new PassThrough() },
          attachment: {
            url: "http://127.0.0.1:2345",
            directory: root,
            username: "opencode",
            password: "unused-private",
          },
          async openBrowser(url: string) {
            state.events.push("native-open")
            expect(url).toBe(state.url)
            expect(url).not.toContain("openai")
            if (options.rejectedOpen) throw Error("private-opener-response-lost")
            if (options.pendingOpen) {
              await new Promise<void>((resolve) => {
                state.settleOpen = resolve
              })
              return true
            }
            if (options.lateRequest) {
              void new Promise((resolve) => setTimeout(resolve, 10)).then(() => fetch(url)).catch(() => {})
            } else if (options.request !== false && options.opened !== false) {
              const response = await fetch(url)
              expect(response.status).toBe(200)
              expect(await response.text()).toContain("No provider sign-in")
            }
            return options.opened !== false
          },
        })
      } finally {
        state.events.push("native-stop")
        if (options.nativeCleanupFails) throw Error("private-native-cleanup")
      }
    },
  }
  const io = {
    platform: "linux" as "linux" | "win32",
    timeoutMs: 100,
    async startBrowser(value: { env: NodeJS.ProcessEnv; root: string; probeURL?: string }) {
      if (options.observedBrowserStartFails)
        throw browserObservationError("PROVIDER_REVIEW_BROWSER_CLEANUP_UNCONFIRMED", Error("PRIVATE"), {
          browserPhase: "cleanup-identity",
          failedBrowserPhase: "identity-executable",
          cleanupFailurePhase: "cleanup-identity",
          pidObserved: true,
          birthVerified: false,
          cdpReady: false,
        })
      if (options.browserStartFails) throw Error("private-partial-start")
      expect(value.probeURL).toBeDefined()
      state.url = value.probeURL!
      state.nonce = state.url.slice(state.url.lastIndexOf("/") + 1)
      expect(validateBrowserProbeURL(state.url)).toBe(state.url)
      return {
        environment: { HOME: value.root },
        async confirmHandoff(url: string) {
          expect(url).toBe(state.url)
          state.events.push("owned-target")
          return options.target !== false
        },
        async stop(stop: { retainProfile?: boolean } = {}) {
          state.events.push("browser-stop")
          state.retained = stop.retainProfile === true
          if (options.nativeCleanupFails) expect(stop.retainProfile).toBe(true)
          if (options.browserCleanupFails) throw Error("private-browser-cleanup")
          if (!stop.retainProfile) await rm(value.root, { recursive: true })
        },
      }
    },
  }
  return { input, io, state, cleanup: () => rm(temporary, { recursive: true, force: true }) }
}

test("browser-only fixture requires actual local HTTP and owned target; returns no provider claim", async () => {
  for (const platform of ["linux", "win32"] as const) {
    const f = await fixture()
    try {
      f.io.platform = platform
      f.input.env.RUNNER_OS = platform === "linux" ? "Linux" : "Windows"
      f.input.context.platform = platform === "linux" ? "linux-x64" : "windows-x64"
      const result = await runOwnedBrowserHandoffReview(f.input, f.io)
      expect(result.status).toBe("OBSERVED")
      if (result.status !== "OBSERVED") throw Error("unobserved")
      expect(result.providerSignIn).toBe("NOT_TESTED")
      expect(JSON.stringify(result)).not.toContain(f.state.nonce)
      expect(JSON.stringify(result)).not.toContain("PASS")
      expect(f.state.nativeEnv.PHYSICALSYSTEMS_PROVIDER_REVIEW).toBe("")
      expect(f.state.events).toEqual(["native-open", "owned-target", "native-stop", "browser-stop"])
      expect(
        await fetch(f.state.url).then(
          () => true,
          () => false,
        ),
      ).toBe(false)
      expect(
        await access(f.input.root).then(
          () => true,
          () => false,
        ),
      ).toBe(false)
    } finally {
      await f.cleanup()
    }
  }
})

test("outer failed acquisition retains the exact safe browser boundary after cleanup wrapping", async () => {
  const f = await fixture({ observedBrowserStartFails: true })
  try {
    const error = await runOwnedBrowserHandoffReview(f.input, f.io).then(
      () => undefined,
      (error) => error,
    )
    expect(error.message).toBe("BROWSER_HANDOFF_CLEANUP_UNCONFIRMED")
    expect(readBrowserObservation(error)).toEqual({
      browserPhase: "cleanup-identity",
      failedBrowserPhase: "identity-executable",
      cleanupFailurePhase: "cleanup-identity",
      pidObserved: true,
      birthVerified: false,
      cdpReady: false,
      reviewPhase: "browser-cleanup",
      failedReviewPhase: "browser-acquisition",
      openerAcknowledged: false,
      requestObserved: false,
    })
    expect(f.state.nativeStarted).toBe(false)
    expect(JSON.stringify(readBrowserObservation(error))).not.toContain("PRIVATE")
  } finally {
    await f.cleanup()
  }
})

test("server request and exact target are independent required observations after acknowledged handoff", async () => {
  for (const options of [{ request: false }, { target: false }]) {
    const f = await fixture(options)
    try {
      await expect(runOwnedBrowserHandoffReview(f.input, f.io)).rejects.toThrow("BROWSER_HANDOFF_UNCONFIRMED")
      expect(f.state.events).toContain("native-stop")
      expect(f.state.events).toContain("browser-stop")
    } finally {
      await f.cleanup()
    }
  }
})

test("pending, false or rejected native opener outcomes retain private paths even after app cleanup", async () => {
  for (const options of [{ pendingOpen: true }, { opened: false }, { rejectedOpen: true }]) {
    const f = await fixture(options)
    try {
      await expect(runOwnedBrowserHandoffReview(f.input, { ...f.io, timeoutMs: 20 })).rejects.toThrow(
        "BROWSER_HANDOFF_CLEANUP_UNCONFIRMED",
      )
      expect(f.state.events).toEqual(["native-open", "native-stop", "browser-stop"])
      expect(f.state.retained).toBe(true)
      await access(f.input.root)
      expect(
        await fetch(f.state.url).then(
          () => true,
          () => false,
        ),
      ).toBe(false)
      f.state.settleOpen()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(f.state.events).not.toContain("owned-target")
      expect(f.state.events.filter((event) => event === "native-open")).toHaveLength(1)
      await access(f.input.root)
    } finally {
      f.state.settleOpen()
      await f.cleanup()
    }
  }
})

test("a target observed before its HTTP request is awaited without opening the browser twice", async () => {
  const f = await fixture({ lateRequest: true })
  try {
    const result = await runOwnedBrowserHandoffReview(f.input, f.io)
    expect(result.status).toBe("OBSERVED")
    expect(f.state.events.filter((event) => event === "native-open")).toHaveLength(1)
  } finally {
    await f.cleanup()
  }
})

test("unconfirmed native/browser acquisition or cleanup retains private paths and closes the fixture", async () => {
  for (const options of [{ nativeCleanupFails: true }, { browserCleanupFails: true }, { browserStartFails: true }]) {
    const f = await fixture(options)
    try {
      await expect(runOwnedBrowserHandoffReview(f.input, f.io)).rejects.toThrow("BROWSER_HANDOFF_CLEANUP_UNCONFIRMED")
      expect(
        await access(f.input.root).then(
          () => true,
          () => false,
        ),
      ).toBe(true)
      if (f.state.url)
        expect(
          await fetch(f.state.url).then(
            () => true,
            () => false,
          ),
        ).toBe(false)
    } finally {
      await f.cleanup()
    }
  }
})

test("browser review remains opt-in and never accepts an arbitrary provider or loopback URL", async () => {
  const f = await fixture()
  try {
    expect(await runOwnedBrowserHandoffReview({ ...f.input, env: {} }, f.io)).toEqual({
      status: "NOT_TESTED",
      reason: "NO_BROWSER_REVIEW",
    })
    expect(f.state.nativeStarted).toBe(false)
    for (const url of [
      "https://auth.openai.com/codex/device",
      "http://localhost:2345/physicalsystems-browser-review/" + "a".repeat(64),
      "http://127.0.0.1:65536/physicalsystems-browser-review/" + "a".repeat(64),
      "http://127.0.0.1:2345/arbitrary",
    ])
      expect(() => validateBrowserProbeURL(url)).toThrow()
    for (const code of ["BROWSER_HANDOFF_UNCONFIRMED", "BROWSER_HANDOFF_CLEANUP_UNCONFIRMED"] as const) {
      expect(qualificationFailureCode(new Error(code))).toBe(code)
      expect(qualificationFailureCode(new Error(code + " private-error"))).toBe("QUALIFICATION_UNEXPECTED_ERROR")
    }
  } finally {
    await f.cleanup()
  }
})
