// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test"
import { ChildProcess } from "node:child_process"
import { mkdtemp, mkdir, realpath, rm, stat, rename, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { PassThrough } from "node:stream"
import { gunzipSync } from "node:zlib"
import { browserObservationError } from "./browser-observation"
import type { BrowserDiagnosticContext } from "./browser-diagnostic"
import type { OwnedReviewBrowser } from "./owned-review-browser"
import {
  openWindowsLoopbackURL,
  runWindowsLoopbackDiagnostic,
  windowsLoopbackOpenArguments,
  windowsLoopbackOpenScript,
} from "./windows-loopback-diagnostic"

const directories: string[] = []
afterEach(async () => {
  for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true })
})
const context: BrowserDiagnosticContext = {
  sourceRevision: "a".repeat(40),
  runId: "123",
  runAttempt: 1,
  platform: "windows-x64",
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
async function fixture() {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "inert-os-loopback-")))
  directories.push(temporary)
  const root = join(temporary, "review")
  await mkdir(root)
  const env: NodeJS.ProcessEnv = {
    CI: "true",
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    RUNNER_OS: "Windows",
    GITHUB_RUN_ID: "123",
    RUNNER_TEMP: temporary,
    SystemRoot: "C:\\Windows",
  }
  const events: string[] = []
  let ownedURL = ""
  const browser: OwnedReviewBrowser = {
    environment: {},
    confirmHandoff: async (url) => {
      expect(url).toBe(ownedURL)
      events.push("confirm")
      return true
    },
    observation: () => ({
      browserPhase: "handoff-targets",
      handoffPhase: "targets",
      handoffUnknownProcesses: 0,
      handoffListenerOwned: true,
    }),
    stop: async () => {
      events.push("stop")
    },
    releaseController: () => {
      events.push("release")
    },
  }
  const acquire = async (input: { probeURL: string }) => {
    ownedURL = input.probeURL
    events.push("acquire")
    return browser
  }
  const open: typeof openWindowsLoopbackURL = async (input) => {
    expect(input.url).toBe(ownedURL)
    events.push("open")
    expect(await (await fetch(input.url, { signal: AbortSignal.timeout(1000) })).text()).toContain(
      "provider sign-in are not tested",
    )
    return true
  }
  const run = (options: Parameters<typeof runWindowsLoopbackDiagnostic>[2] = {}) =>
    runWindowsLoopbackDiagnostic(
      context,
      { env, root },
      { platform: "win32", acquire, open, timeoutMs: 2000, quiescenceTimeoutMs: 100, ...options },
    )
  return { root, env, events, browser, acquire, open, run, url: () => ownedURL }
}

test("OS-only diagnostic requires one owned GET and exact browser target, then cleans up without product qualification", async () => {
  const f = await fixture()
  const result = await f.run()
  expect(f.events).toEqual(["acquire", "open", "confirm", "stop"])
  expect(result).toMatchObject({
    mode: "windows-os-loopback",
    result: "COMPLETE",
    acquisition: "READY",
    osLoopbackHandoff: "OBSERVED",
    cleanup: "STOPPED",
    retentionRequired: false,
    desktop: "NOT_TESTED",
    productOpener: "NOT_TESTED",
    browserHandoff: "NOT_TESTED",
    providerLogin: "NOT_TESTED",
    qualification: false,
    publication: false,
  })
  expect(result.browserObservation).toMatchObject({
    openerAcknowledged: true,
    requestObserved: true,
    handoffQuiescence: "settled",
    handoffUnknownProcesses: 0,
  })
  expect(result.sourceRevision).toBe(context.sourceRevision)
  expect(JSON.stringify(result)).not.toContain(f.url())
  expect(JSON.stringify(result)).not.toContain(f.root)
  await expect(stat(f.root)).rejects.toThrow()
})

test("CDP visibility before GET waits for the actual owned request without repeating OS open", async () => {
  const f = await fixture()
  let request: Promise<unknown> | undefined
  f.browser.confirmHandoff = async (url) => {
    f.events.push("confirm")
    request = new Promise<void>((resolve, reject) =>
      setTimeout(() => {
        fetch(url)
          .then((response) => response.text())
          .then(() => resolve(), reject)
      }, 10),
    )
    return true
  }
  const result = await f.run({
    open: async () => {
      f.events.push("open")
      return true
    },
  })
  await request
  expect(result.result).toBe("COMPLETE")
  expect(f.events).toEqual(["acquire", "open", "confirm", "stop"])
})

test("missing GET and rejected browser target fail independently even after OS acknowledgment", async () => {
  for (const missing of ["request", "target"]) {
    const f = await fixture()
    if (missing === "target")
      f.browser.confirmHandoff = async () => {
        f.events.push("confirm")
        return false
      }
    const result = await f.run({
      timeoutMs: 250,
      open:
        missing === "request"
          ? async () => {
              f.events.push("open")
              return true
            }
          : f.open,
    })
    expect(result.result).toBe("FAILED")
    expect(result.osLoopbackHandoff).toBe("UNCONFIRMED")
    expect(result.cleanup).toBe("STOPPED")
    expect(result.retentionRequired).toBe(false)
    expect(result.browserObservation?.requestObserved).toBe(missing !== "request")
    expect(f.events).toEqual(["acquire", "open", "confirm", "stop"])
  }
})

test("false, late and close-unconfirmed OS opener outcomes never authorize target reads or browser cleanup", async () => {
  for (const outcome of ["false", "late", "unclosed", "pending"]) {
    const f = await fixture()
    const result = await f.run({
      timeoutMs: 10,
      quiescenceTimeoutMs: 40,
      open: async () => {
        f.events.push("open")
        if (outcome === "false") return false
        if (outcome === "late") return new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 25))
        if (outcome === "pending") return new Promise<boolean>(() => {})
        throw browserObservationError("PROVIDER_REVIEW_WINDOWS_UNCONFIRMED", Error("PRIVATE-TRANSPORT-CREDENTIAL"), {
          browserPhase: "cleanup-quiescence",
          handoffQuiescence: "unconfirmed",
          windowsNativeOutcome: "unknown",
        })
      },
    })
    expect(f.events).toEqual(["acquire", "open", "release"])
    expect(result).toMatchObject({
      result: "FAILED",
      cleanup: "UNCONFIRMED",
      retentionRequired: true,
      osLoopbackHandoff: "UNCONFIRMED",
    })
    expect(await stat(f.root)).toBeDefined()
    expect(JSON.stringify(result)).not.toContain("PRIVATE")
    if (outcome === "late") expect(result.browserObservation?.handoffDeadlineExpired).toBe(true)
    if (outcome === "unclosed")
      expect(result.browserObservation).toMatchObject({
        windowsNativeOutcome: "unknown",
        handoffQuiescence: "unconfirmed",
      })
  }
})

test("deadline cancels and drains an exact target read before cleanup, and late success remains ineligible", async () => {
  const f = await fixture()
  f.browser.confirmHandoff = async (_url, { signal } = {}) => {
    f.events.push("confirm")
    await new Promise<void>((resolve) =>
      signal!.addEventListener("abort", () => setTimeout(resolve, 10), { once: true }),
    )
    f.events.push("confirmed-closed")
    return true
  }
  const result = await f.run({
    timeoutMs: 15,
    open: async () => {
      f.events.push("open")
      return true
    },
  })
  expect(f.events).toEqual(["acquire", "open", "confirm", "confirmed-closed", "stop"])
  expect(result).toMatchObject({ result: "FAILED", cleanup: "STOPPED", osLoopbackHandoff: "UNCONFIRMED" })
  expect(result.browserObservation).toMatchObject({ handoffDeadlineExpired: true, handoffQuiescence: "settled" })
})

test("unquiescent target read releases only controller handles and preserves its state", async () => {
  const f = await fixture()
  f.browser.confirmHandoff = async () => {
    f.events.push("confirm")
    return new Promise<boolean>(() => {})
  }
  const result = await f.run({
    timeoutMs: 10,
    quiescenceTimeoutMs: 5,
    open: async () => {
      f.events.push("open")
      return true
    },
  })
  expect(f.events).toEqual(["acquire", "open", "confirm", "release"])
  expect(result).toMatchObject({ result: "FAILED", cleanup: "UNCONFIRMED", retentionRequired: true })
  expect(result.browserObservation?.handoffQuiescence).toBe("unconfirmed")
  expect(await stat(f.root)).toBeDefined()
})

test("factory and cleanup uncertainty retain private state and only fixed diagnostic facts", async () => {
  for (const phase of ["acquire", "stop"]) {
    const f = await fixture()
    if (phase === "stop")
      f.browser.stop = async () => {
        f.events.push("stop")
        throw browserObservationError("PROVIDER_REVIEW_WINDOWS_UNCONFIRMED", Error("PRIVATE-PROFILE"), {
          browserPhase: "cleanup-profile",
          cleanupFailurePhase: "cleanup-profile",
          syscallFailure: "EACCES",
        })
      }
    const result = await f.run({
      acquire:
        phase === "acquire"
          ? async () => {
              throw Error("PRIVATE-PROFILE")
            }
          : f.acquire,
    })
    expect(result).toMatchObject({ result: "FAILED", cleanup: "UNCONFIRMED", retentionRequired: true })
    expect(JSON.stringify(result)).not.toContain("PRIVATE")
    expect(await stat(f.root)).toBeDefined()
    if (phase === "stop")
      expect(result.browserObservation).toMatchObject({
        cleanupFailurePhase: "cleanup-profile",
        syscallFailure: "EACCES",
      })
  }
})

test("local or mismatched-platform diagnostic fails before browser acquisition", async () => {
  const f = await fixture()
  await expect(f.run({ platform: "linux" })).rejects.toThrow("BROWSER_DIAGNOSTIC_CONTEXT_UNCONFIRMED")
  await expect(
    runWindowsLoopbackDiagnostic(
      { ...context, platform: "linux-x64" },
      { env: f.env, root: f.root },
      { platform: "win32", acquire: f.acquire },
    ),
  ).rejects.toThrow("BROWSER_DIAGNOSTIC_CONTEXT_UNCONFIRMED")
  expect(f.events).toEqual([])
})

test("fixed OS script encodes exactly, uses URL association without a command shell, and bounds command length", () => {
  const args = windowsLoopbackOpenArguments("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
  expect(args.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"])
  const bootstrap = Buffer.from(args[4]!, "base64").toString("utf16le")
  const encoded = bootstrap.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)![1]!
  expect(gunzipSync(Buffer.from(encoded, "base64")).toString("utf8")).toBe(windowsLoopbackOpenScript)
  expect(windowsLoopbackOpenScript).toContain("$info.UseShellExecute=$true")
  expect(windowsLoopbackOpenScript).toContain("$info.FileName=$request.url")
  expect(windowsLoopbackOpenScript).not.toContain("Start-Process")
  expect(args.join(" ")).not.toContain("ExecutionPolicy")
  expect(() => windowsLoopbackOpenArguments("x".repeat(20000))).toThrow()
})

test("fixed opener transports only the validated loopback request and waits for actual helper close", async () => {
  const f = await fixture()
  const url = `http://127.0.0.1:43210/physicalsystems-browser-review/${"c".repeat(64)}`
  let input = ""
  const child = new ChildProcess()
  const stdin = new PassThrough()
  stdin.on("data", (chunk) => {
    input += chunk
  })
  Object.defineProperties(child, {
    stdin: { value: stdin },
    stdout: { value: new PassThrough() },
    stderr: { value: new PassThrough() },
  })
  let complete: ((error: unknown, stdout: string, stderr: string) => void) | undefined
  let settled = false
  const result = openWindowsLoopbackURL(
    { env: f.env, environment: {}, root: f.root, url },
    {
      platform: "win32",
      execute: (options, done) => {
        expect(options.timeout).toBe(12000)
        complete = done
        return child
      },
    },
  ).finally(() => {
    settled = true
  })
  while (!complete) await tick()
  expect(JSON.parse(input)).toEqual({ url })
  complete(null, '{"acknowledged":true}', "")
  await tick()
  expect(settled).toBe(false)
  child.emit("close", 0, null)
  expect(await result).toBe(true)
  for (const bad of [
    "https://example.test/",
    url + "?query=1",
    url.replace("127.0.0.1", "localhost"),
    url.replace("43210", "65536"),
  ]) {
    await expect(
      openWindowsLoopbackURL(
        { env: f.env, environment: {}, root: f.root, url: bad },
        {
          platform: "win32",
          execute: () => {
            throw Error("MUST-NOT-EXECUTE")
          },
        },
      ),
    ).rejects.toThrow()
  }
  stdin.destroy()
  child.stdout!.destroy()
  child.stderr!.destroy()
})

test("confirmed browser cleanup cannot delete a replaced outer diagnostic directory", async () => {
  const f = await fixture()
  f.browser.stop = async () => {
    f.events.push("stop")
    await rename(f.root, join(dirname(f.root), "retained-owned-root"))
    await mkdir(f.root)
    await writeFile(join(f.root, "foreign-marker"), "preserve")
  }
  const result = await f.run()
  expect(result).toMatchObject({ result: "FAILED", cleanup: "UNCONFIRMED", retentionRequired: true })
  expect(result.browserObservation?.directoryFailurePhase).toBe("root-identity")
  expect(await readFile(join(f.root, "foreign-marker"), "utf8")).toBe("preserve")
  expect(f.events).toEqual(["acquire", "open", "confirm", "stop"])
})
