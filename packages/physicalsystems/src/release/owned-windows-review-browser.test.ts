// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import type { ChildProcess } from "node:child_process"
import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  startOwnedWindowsReviewBrowser,
  windowsReviewOwnership,
  windowsReviewPolicy,
  windowsReviewProcesses,
} from "./owned-windows-review-browser"
import type { WindowsReviewNative, WindowsReviewProcess } from "./windows-review-native"
import {
  windowsReviewNative,
  windowsReviewNativeFailure,
  windowsReviewNativeResult,
  windowsReviewNativeArguments,
  windowsReviewNativeEnvironment,
  windowsReviewNativeScript,
} from "./windows-review-native"
import { browserObservationError, readBrowserObservation } from "./browser-observation"
import { qualificationFailureCode } from "./qualification"

const executable = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
const processRecord = (profile: string): WindowsReviewProcess => ({
  pid: 4100,
  parent: 100,
  birth: "134000000000000001",
  session: 2,
  sid: "S-1-5-21-111-222-333-1001",
  executable,
  args: [executable, `--user-data-dir=${profile}`, "about:blank"],
})

async function fixture(
  options: {
    ambient?: boolean
    policySetLost?: boolean
    restoreFails?: boolean
    stopLost?: boolean
    reusedPid?: boolean
    wrongRootSid?: boolean
    reuseOrphanAfterStop?: boolean
    nativeFailure?: "preflight" | "set" | "observe" | "restore"
    unready?: "missing-port" | "crlf-port" | "wrong-listener" | "targets-unavailable" | "wrong-target"
  } = {},
) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "windows-review-fixture-")))
  const root = await realpath(await mkdtemp(join(temporary, "owned-")))
  const before = {
    keys: [true, true, true],
    value: { kind: "ExpandString" as const, data: "C:\\PRIVATE-PREVIOUS-POLICY\\%USERNAME%" },
  }
  const state = {
    calls: [] as string[],
    schemes: [] as string[],
    profile: "",
    policy: structuredClone(before) as ReturnType<typeof windowsReviewPolicy>,
    running: false,
    handoff: false,
    stopped: false,
    reused: false,
    restored: false,
    orphan: false,
    observedRoots: [] as number[][],
    unrefs: 0,
    nativeEnv: {} as NodeJS.ProcessEnv,
    targetQueries: 0,
  }
  const child = Object.assign(new EventEmitter(), {
    pid: 4100,
    exitCode: null,
    signalCode: null,
    unref() {
      state.unrefs++
    },
  }) as unknown as ChildProcess
  const native: WindowsReviewNative = async (request) => {
    state.calls.push(request.operation)
    if (request.operation === options.nativeFailure && request.operation !== "set")
      throw windowsReviewNativeFailure(
        "PRIVATE-NATIVE-ERROR\nPHYSICALSYSTEMS_WINDOWS_BROWSER_PHASE_" +
          (request.operation === "preflight"
            ? "association-progid"
            : request.operation === "restore"
              ? "policy-restore"
              : "process-identity"),
      )
    if ("scheme" in request) state.schemes.push(request.scheme)
    if (request.operation === "preflight")
      return {
        executable,
        sid: processRecord("").sid,
        policy: structuredClone(before),
        processes: options.ambient ? [processRecord("C:\\ambient")] : [],
      }
    if (request.operation === "set") {
      expect(request.before).toEqual(before)
      state.profile = request.profile
      state.policy = { keys: [true, true, true], value: { kind: "String", data: request.profile } }
      if (options.nativeFailure === "set")
        throw windowsReviewNativeFailure("PHYSICALSYSTEMS_WINDOWS_BROWSER_PHASE_policy-write")
      if (options.policySetLost) throw Error("PRIVATE-POLICY-WRITE-RESPONSE-LOST")
      return { written: true }
    }
    if (request.operation === "observe") {
      state.observedRoots.push([...request.observedPids])
      if (state.running && options.unready !== "missing-port")
        await writeFile(
          join(state.profile, "DevToolsActivePort"),
          options.unready === "crlf-port" ? "23456\r\n/devtools/browser/inert\r\n" : "23456\n/devtools/browser/inert\n",
        )
      const main = processRecord(state.profile)
      if (options.wrongRootSid) main.sid = "S-1-5-21-999-222-333-1001"
      if (state.reused) main.birth = "134000000000000999"
      const processes = state.running
        ? [
            main,
            { ...main, pid: 4101, parent: 4100, birth: "134000000000000002", args: [executable, "--type=utility"] },
          ]
        : []
      // A non-Edge helper is visible through its live parent initially. Once
      // the parent exits it is discoverable only through retained query roots.
      if (state.orphan && (state.running || request.observedPids.includes(4102)))
        processes.push({
          ...main,
          pid: 4102,
          parent: 4101,
          birth: options.reuseOrphanAfterStop && state.stopped ? "134000000000000999" : "134000000000000003",
          executable: "C:\\Windows\\unexpected-helper.exe",
          args: ["C:\\Windows\\unexpected-helper.exe"],
        })
      return {
        processes,
        listening: state.running && request.port ? [options.unready === "wrong-listener" ? 4999 : 4100] : [],
        policyOwned: state.policy.value?.data === state.profile,
      }
    }
    if (request.operation === "stop") {
      expect(request.processes.map((item) => item.pid).sort()).toEqual([4100, 4101])
      expect(request.processes.every((item) => item.sid === processRecord("").sid)).toBe(true)
      state.running = false
      state.stopped = true
      if (options.stopLost) throw Error("PRIVATE-STOP-RESPONSE-LOST")
      return { stopped: true }
    }
    if (request.operation === "restore") {
      expect(state.running).toBe(false)
      if (state.stopped) expect(request.observedPids).toEqual([4100, 4101])
      expect(request.before).toEqual(before)
      if (options.restoreFails) throw Error("PRIVATE-CONCURRENT-POLICY")
      state.policy = structuredClone(before)
      state.restored = true
      return { restored: true }
    }
    throw Error("unexpected")
  }
  const input = {
    root,
    env: {
      CI: "true",
      GITHUB_ACTIONS: "true",
      RUNNER_ENVIRONMENT: "github-hosted",
      RUNNER_OS: "Windows",
      GITHUB_RUN_ID: "123",
      RUNNER_TEMP: temporary,
      SystemRoot: "C:\\Windows",
      ACTIONS_RUNTIME_TOKEN: "PRIVATE-RUNTIME-TOKEN",
    },
  }
  const io = {
    native,
    platform: "win32" as const,
    timeoutMs: 100,
    pollMs: 1,
    spawn: (exe: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      expect(exe).toBe(executable)
      expect(args).toContain(`--user-data-dir=${state.profile}`)
      expect(args).toContain("--remote-debugging-port=0")
      state.nativeEnv = options.env ?? {}
      state.running = true
      return child
    },
    targets: async (origin: string) => {
      state.targetQueries++
      expect(origin).toBe("http://127.0.0.1:23456")
      if (options.unready === "targets-unavailable") return undefined
      if (options.unready === "wrong-target") return [{ type: "page", url: "https://PRIVATE-UNKNOWN-TARGET" }]
      return [{ type: "page", url: state.handoff ? "https://auth.openai.com/codex/device" : "about:blank" }]
    },
  }
  return { input, io, state, before, cleanup: () => rm(temporary, { recursive: true, force: true }) }
}

test("owned Windows browser verifies exact native process/CDP and restores prior policy only after shutdown", async () => {
  for (const stopLost of [false, true]) {
    const f = await fixture({ stopLost })
    try {
      const browser = await startOwnedWindowsReviewBrowser(f.input, f.io)
      expect(f.state.calls[0]).toBe("preflight")
      expect(f.state.nativeEnv.ACTIONS_RUNTIME_TOKEN).toBeUndefined()
      expect(JSON.stringify(browser.environment)).not.toContain("PRIVATE")
      f.state.handoff = true
      expect(await browser.confirmHandoff("https://auth.openai.com/codex/device")).toBe(true)
      await browser.stop()
      expect(f.state.stopped).toBe(true)
      expect(f.state.restored).toBe(true)
      expect(f.state.policy).toEqual(f.before)
      expect(f.state.calls.indexOf("restore")).toBeGreaterThan(f.state.calls.indexOf("stop"))
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

test("an unknown orphan remains observed after its Edge parents exit; reuse never grants kill or cleanup authority", async () => {
  for (const reuseOrphanAfterStop of [false, true]) {
    const f = await fixture({ reuseOrphanAfterStop })
    try {
      const browser = await startOwnedWindowsReviewBrowser(f.input, f.io)
      f.state.orphan = true
      await expect(browser.stop()).rejects.toThrow("PROVIDER_REVIEW_BROWSER_CLEANUP_UNCONFIRMED")
      expect(f.state.stopped).toBe(true)
      expect(f.state.calls.filter((call) => call === "stop")).toHaveLength(1)
      expect(f.state.observedRoots.at(-1)).toEqual([4100, 4101, 4102])
      expect(f.state.calls).not.toContain("restore")
      expect(f.state.restored).toBe(false)
      await access(join(f.input.root, "profile"))
    } finally {
      await f.cleanup()
    }
  }
})

test("ambient browser, unknown startup identity, PID reuse and failed policy restoration never authorize cleanup", async () => {
  const ambient = await fixture({ ambient: true })
  try {
    await expect(startOwnedWindowsReviewBrowser(ambient.input, ambient.io)).rejects.toThrow(
      "PROVIDER_REVIEW_WINDOWS_UNCONFIRMED",
    )
    expect(ambient.state.calls).toEqual(["preflight"])
  } finally {
    await ambient.cleanup()
  }
  for (const options of [{ wrongRootSid: true }, { reusedPid: true }, { restoreFails: true }]) {
    const f = await fixture(options)
    try {
      if (options.wrongRootSid)
        await expect(startOwnedWindowsReviewBrowser(f.input, f.io)).rejects.toThrow(
          "PROVIDER_REVIEW_BROWSER_CLEANUP_UNCONFIRMED",
        )
      else {
        const browser = await startOwnedWindowsReviewBrowser(f.input, f.io)
        f.state.reused = options.reusedPid === true
        await expect(browser.stop()).rejects.toThrow("PROVIDER_REVIEW_BROWSER_CLEANUP_UNCONFIRMED")
      }
      if (!options.restoreFails) expect(f.state.calls).not.toContain("stop")
      expect(f.state.restored).toBe(false)
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

test("lost policy-write response reconciles exact prior state; retained profiles still require policy restoration", async () => {
  const lost = await fixture({ policySetLost: true })
  try {
    await expect(startOwnedWindowsReviewBrowser(lost.input, lost.io)).rejects.toThrow(
      "PROVIDER_REVIEW_WINDOWS_UNCONFIRMED",
    )
    expect(lost.state.restored).toBe(true)
    expect(lost.state.calls).not.toContain("stop")
  } finally {
    await lost.cleanup()
  }
  const f = await fixture()
  try {
    const browser = await startOwnedWindowsReviewBrowser(f.input, f.io)
    await browser.stop({ retainProfile: true })
    expect(f.state.restored).toBe(true)
    expect(
      await access(f.input.root).then(
        () => true,
        () => false,
      ),
    ).toBe(true)
  } finally {
    await f.cleanup()
  }
})

test("Windows ownership rejects unrelated, recycled and malformed process/policy observations", () => {
  const main = processRecord("C:\\owned")
  const other = {
    ...main,
    pid: 9999,
    parent: 42,
    args: [executable, "https://example.com"],
    birth: "134000000000000003",
  }
  const input = {
    processes: [main, other],
    known: new Map([[main.pid, main]]),
    root: main,
    executable,
    profile: "C:\\owned",
    sid: main.sid,
  }
  expect(windowsReviewOwnership(input).unknown.map((item) => item.pid)).toEqual([9999])
  expect(() => windowsReviewOwnership({ ...input, processes: [{ ...main, birth: "134000000000000002" }] })).toThrow()
  expect(() => windowsReviewProcesses([main, main])).toThrow()
  expect(() => windowsReviewPolicy({ keys: [false, true, true], value: null })).toThrow()
  expect(() => windowsReviewPolicy({ keys: [true, true, true], value: { kind: "Binary", data: "private" } })).toThrow()
  if (process.platform !== "win32")
    expect(() => windowsReviewNative({}, "/tmp")).toThrow("PROVIDER_REVIEW_WINDOWS_UNCONFIRMED")
})

test("loopback review checks the actual HTTP association and permits only its exact owned URL", async () => {
  const f = await fixture()
  const probeURL = "http://127.0.0.1:23456/physicalsystems-browser-review/" + "c".repeat(64)
  f.io.targets = async () => [{ type: "page", url: f.state.handoff ? probeURL : "about:blank" }]
  try {
    const browser = await startOwnedWindowsReviewBrowser({ ...f.input, probeURL }, f.io)
    await expect(browser.confirmHandoff("https://auth.openai.com/codex/device")).rejects.toThrow()
    f.state.handoff = true
    expect(await browser.confirmHandoff(probeURL)).toBe(true)
    await browser.stop()
    expect(f.state.schemes.length).toBeGreaterThan(1)
    expect(new Set(f.state.schemes)).toEqual(new Set(["http"]))
  } finally {
    await f.cleanup()
  }
})

test("provider diagnostics retain only fixed reviewed failure codes", () => {
  for (const code of [
    "PROVIDER_REVIEW_UNCONFIRMED",
    "PROVIDER_REVIEW_ACCOUNT_UNCONFIRMED",
    "PROVIDER_REVIEW_CLEANUP_UNCONFIRMED",
    "PROVIDER_REVIEW_BROWSER_UNCONFIRMED",
    "PROVIDER_REVIEW_BROWSER_CLEANUP_UNCONFIRMED",
    "PROVIDER_REVIEW_WINDOWS_UNCONFIRMED",
  ] as const) {
    const error = new Error(code)
    error.stack = "PRIVATE-CREDENTIAL-PATH"
    expect(qualificationFailureCode(error)).toBe(code)
    expect(qualificationFailureCode(new Error(`${code} PRIVATE-CREDENTIAL-PATH`))).toBe(
      "QUALIFICATION_UNEXPECTED_ERROR",
    )
  }
})

test("Windows acquisition and cleanup preserve exact fixed native phases without private values", async () => {
  for (const nativeFailure of ["preflight", "set", "observe", "restore"] as const) {
    const f = await fixture({ nativeFailure })
    try {
      const error =
        nativeFailure === "restore"
          ? await (await startOwnedWindowsReviewBrowser(f.input, f.io)).stop().catch((error: unknown) => error)
          : await startOwnedWindowsReviewBrowser(f.input, f.io).catch((error: unknown) => error)
      const observation = readBrowserObservation(
        browserObservationError("BROWSER_HANDOFF_CLEANUP_UNCONFIRMED", error, {
          reviewPhase: "browser-cleanup",
          failedReviewPhase: "browser-acquisition",
        }),
      )
      expect(observation).toBeDefined()
      if (nativeFailure === "preflight") {
        expect(observation?.failedBrowserPhase).toBe("windows-preflight")
        expect(observation?.failedWindowsNativePhase).toBe("association-progid")
        expect(observation?.pidObserved).toBe(false)
      } else if (nativeFailure === "set") {
        expect(observation?.failedBrowserPhase).toBe("windows-policy-write")
        expect(observation?.failedWindowsNativePhase).toBe("policy-write")
        expect(f.state.restored).toBe(true)
      } else if (nativeFailure === "observe") {
        expect(observation?.failedBrowserPhase).toBe("identity-stat")
        expect(observation?.cleanupFailurePhase).toBe("cleanup-observe")
        expect(observation?.failedWindowsNativePhase).toBe("process-identity")
      } else {
        expect(observation?.cleanupFailurePhase).toBe("windows-policy-restore")
        expect(observation?.windowsNativePhase).toBe("policy-restore")
        expect(observation?.ownedProcesses).toBe(0)
      }
      expect(JSON.stringify(observation)).not.toContain("PRIVATE")
      if (f.state.profile) expect(JSON.stringify(observation)).not.toContain(f.state.profile)
      if (["observe", "restore"].includes(nativeFailure)) {
        expect(f.state.unrefs).toBeGreaterThan(0)
        await access(f.input.root)
      }
    } finally {
      await f.cleanup()
    }
  }
})

test("native phase parser accepts only one authored marker, never raw native errors or identities", () => {
  const privateValue = "PRIVATE-PATH-SID-CREDENTIAL"
  const result = windowsReviewNativeFailure(`${privateValue}\nPHYSICALSYSTEMS_WINDOWS_BROWSER_PHASE_signature\n`)
  expect(readBrowserObservation(result)?.windowsNativePhase).toBe("signature")
  expect(JSON.stringify(readBrowserObservation(result))).not.toContain(privateValue)
  for (const value of [
    privateValue,
    `PHYSICALSYSTEMS_WINDOWS_BROWSER_PHASE_${privateValue}`,
    "PHYSICALSYSTEMS_WINDOWS_BROWSER_PHASE_signature\nPHYSICALSYSTEMS_WINDOWS_BROWSER_PHASE_signature",
    "x".repeat(1024 * 1024 + 1),
  ])
    expect(readBrowserObservation(windowsReviewNativeFailure(value))?.windowsNativePhase).toBeUndefined()
})

test("native timeout preserves the last live checkpoint through the actual result decoder and cleanup wrapper", () => {
  const privateValue = "PRIVATE-SID-PATH-TOKEN"
  const stderr = [
    "PHYSICALSYSTEMS_WINDOWS_BROWSER_PHASE_bootstrap",
    "PHYSICALSYSTEMS_WINDOWS_BROWSER_PHASE_input-read",
    "PHYSICALSYSTEMS_WINDOWS_BROWSER_PHASE_input-parse",
    "PHYSICALSYSTEMS_WINDOWS_BROWSER_PHASE_add-type",
    privateValue,
    "PHYSICALSYSTEMS_WINDOWS_BROWSER_PHASE_add-type PRIVATE",
    "PHYSICALSYSTEMS_WINDOWS_BROWSER_PHASE_unrecognized",
  ].join("\r\n")
  let failure: unknown
  try {
    windowsReviewNativeResult({
      stdout: "",
      stderr,
      error: { killed: true, signal: "SIGTERM", code: null, message: privateValue },
    })
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(Error)
  const wrapped = browserObservationError("BROWSER_HANDOFF_CLEANUP_UNCONFIRMED", failure, {
    browserPhase: "windows-preflight",
    failedBrowserPhase: "windows-preflight",
    reviewPhase: "browser-cleanup",
  })
  expect(readBrowserObservation(wrapped)).toEqual({
    browserPhase: "windows-preflight",
    failedBrowserPhase: "windows-preflight",
    reviewPhase: "browser-cleanup",
    windowsNativePhase: "add-type",
    windowsNativeOutcome: "timeout",
  })
  expect(JSON.stringify(readBrowserObservation(wrapped))).not.toContain(privateValue)
  expect(
    readBrowserObservation(windowsReviewNativeFailure("", "x".repeat(1024 * 1024) + stderr))?.windowsNativePhase,
  ).toBeUndefined()
  expect(
    readBrowserObservation(windowsReviewNativeFailure("", "PHYSICALSYSTEMS_WINDOWS_BROWSER_PHASE_input-read\n"))
      ?.windowsNativePhase,
  ).toBe("input-read")
})

test("native result decoder keeps success JSON unchanged and classifies only fixed callback outcomes", () => {
  const value = { private: "PRIVATE-NATIVE-RETURN-VALUE", values: [1, 2] }
  expect(
    windowsReviewNativeResult({
      stdout: `\uFEFF${JSON.stringify(value)}`,
      stderr: "PHYSICALSYSTEMS_WINDOWS_BROWSER_PHASE_output\n",
    }),
  ).toEqual(value)
  for (const [error, outcome] of [
    [{ code: "ETIMEDOUT" }, "timeout"],
    [{ signal: "SIGKILL" }, "signal"],
    [{ code: 1 }, "exit"],
    [{ code: "ENOENT", path: "PRIVATE" }, "start"],
    [{ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true }, "output-limit"],
    [{ message: "PRIVATE" }, "unknown"],
    [undefined, "invalid-json"],
  ] as const) {
    let failure: unknown
    try {
      windowsReviewNativeResult({
        stdout: "PRIVATE invalid JSON",
        stderr: "PHYSICALSYSTEMS_WINDOWS_BROWSER_PHASE_input-parse\nPRIVATE",
        error,
      })
    } catch (error) {
      failure = error
    }
    const observation = readBrowserObservation(failure)
    expect(observation?.windowsNativeOutcome).toBe(outcome)
    expect(observation?.windowsNativePhase).toBe("input-parse")
    expect(JSON.stringify(observation)).not.toContain("PRIVATE")
  }
})

test("the real encoded diagnostic script fits CreateProcess including executable and argument overhead", () => {
  const args = windowsReviewNativeArguments("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
  expect(args.slice(0, -1)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"])
  expect(Buffer.from(args.at(-1)!, "base64").toString("utf16le")).toBe(windowsReviewNativeScript)
  expect(() => windowsReviewNativeArguments(`C:\\${"x".repeat(2048)}\\powershell.exe`)).toThrow(
    "PROVIDER_REVIEW_WINDOWS_UNCONFIRMED",
  )
})

test("native module discovery uses the fixed OS module directory and an exclusively owned cache", () => {
  const env = windowsReviewNativeEnvironment(
    {
      SystemRoot: "C:\\Windows",
      ProgramFiles: "C:\\Program Files",
      PSModulePath: "PRIVATE-MODULES",
      PSMODULEPATH: "PRIVATE-MODULES-UPPER",
      PSModuleAnalysisCachePath: "PRIVATE-CACHE",
      PSModuleAutoLoadingPreference: "PRIVATE-AUTOLOAD",
      PSDisableModuleAnalysisCacheCleanup: "PRIVATE-CLEANUP",
      USERPROFILE: "PRIVATE-PROFILE",
      LOCALAPPDATA: "PRIVATE-PROFILE",
      PATH: "PRIVATE-PATH",
      NODE_OPTIONS: "PRIVATE-LOADER",
    },
    "C:\\runner\\owned-browser",
  )
  expect(env.PSModulePath).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules")
  expect(env.PSModuleAnalysisCachePath).toBe("C:\\runner\\owned-browser\\ModuleAnalysisCache")
  expect(env.TEMP).toBe("C:\\runner\\owned-browser")
  expect(env.ProgramFiles).toBe("C:\\Program Files")
  expect(env.PATH).toBe("C:\\Windows\\System32")
  expect(JSON.stringify(env)).not.toContain("PRIVATE")
  expect(env.PSMODULEPATH).toBeUndefined()
  expect(windowsReviewNativeEnvironment({ SYSTEMROOT: "D:\\Windows" }, "D:\\owned").PSModulePath).toBe(
    "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules",
  )
  for (const SystemRoot of [undefined, "relative", "C:\\Windows\\..\\other", 'C:\\bad"path'])
    expect(() => windowsReviewNativeEnvironment({ SystemRoot }, "C:\\owned")).toThrow(
      "PROVIDER_REVIEW_WINDOWS_UNCONFIRMED",
    )
  const reset = "$env:PSModulePath = [IO.Path]::Combine($PSHOME,'Modules')"
  expect(windowsReviewNativeScript.indexOf(reset)).toBeGreaterThan(0)
  expect(windowsReviewNativeScript.indexOf(reset)).toBeLessThan(windowsReviewNativeScript.indexOf("ConvertFrom-Json"))
})

test("failed native readiness retains its port, listener and target facts after confirmed cleanup", async () => {
  for (const unready of [
    "missing-port",
    "crlf-port",
    "wrong-listener",
    "targets-unavailable",
    "wrong-target",
  ] as const) {
    const f = await fixture({ unready })
    try {
      const error = await startOwnedWindowsReviewBrowser(f.input, f.io).catch((error: unknown) => error)
      const observation = readBrowserObservation(error)
      expect(observation?.browserPhase).toBe("stopped")
      expect(observation?.failedBrowserPhase).toBe("cdp-targets")
      expect(observation?.cdpReady).toBe(false)
      expect(observation?.ownedProcesses).toBe(0)
      expect(observation?.listenerProcesses).toBe(0)
      expect(observation?.readinessPolls).toBeGreaterThan(1)
      expect(observation?.readinessPortFilePresent).toBe(unready !== "missing-port")
      expect(observation?.readinessPortLineHasCR).toBe(unready === "crlf-port")
      expect(observation?.readinessPortParsed).toBe(!["missing-port", "crlf-port"].includes(unready))
      expect(observation?.readinessUnknownProcesses).toBe(0)
      expect(observation?.readinessTargetCount).toBe(unready === "wrong-target" ? 1 : 0)
      expect(observation?.readinessBlankTarget).toBe(false)
      const queried = ["targets-unavailable", "wrong-target"].includes(unready)
      expect(observation?.readinessTargetQueried).toBe(queried)
      expect(observation?.readinessListenerOwned).toBe(queried)
      expect(observation?.readinessTargetsAvailable).toBe(unready === "wrong-target")
      expect(observation?.readinessListeners).toBe(["missing-port", "crlf-port"].includes(unready) ? 0 : 1)
      expect(f.state.targetQueries > 0).toBe(queried)
      expect(f.state.restored).toBe(true)
      expect(JSON.stringify(observation)).not.toContain("PRIVATE")
      expect(JSON.stringify(observation)).not.toContain("23456")
      await expect(access(f.input.root)).rejects.toThrow()
    } finally {
      await f.cleanup()
    }
  }
})
