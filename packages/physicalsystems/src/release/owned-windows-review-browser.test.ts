// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { statSync } from "node:fs"
import { PassThrough, Writable } from "node:stream"
import type { ChildProcess } from "node:child_process"
import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  startOwnedWindowsReviewBrowser,
  reserveWindowsReviewPort,
  windowsReviewOwnership,
  windowsReviewPolicy,
  windowsReviewDebugPolicyObservation,
  windowsReviewProcesses,
} from "./owned-windows-review-browser"
import type { WindowsReviewNative, WindowsReviewProcess } from "./windows-review-native"
import {
  windowsReviewNative,
  dispatchWindowsReviewNative,
  windowsReviewNativeFailure,
  windowsReviewNativeResult,
  windowsReviewNativeArguments,
  windowsReviewScriptBootstrap,
  windowsReviewNativeEnvironment,
  windowsReviewNativeScript,
} from "./windows-review-native"
import { browserObservationError, readBrowserObservation } from "./browser-observation"
import { qualificationFailureCode } from "./qualification"

const executable = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
const resolvedCommand = `"${executable}" -- "%1"`
const processRecord = (profile: string): WindowsReviewProcess => ({
  pid: 4100,
  parent: 100,
  birth: "134000000000000001",
  session: 2,
  sid: "S-1-5-21-111-222-333-1001",
  executable,
  args: [
    executable,
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=23456",
    "--remote-debugging-address=127.0.0.1",
    "about:blank",
  ],
})

async function fixture(
  options: {
    ambient?: boolean
    policySetLost?: boolean
    restoreFails?: boolean
    stopLost?: boolean
    exitDuringStop?: boolean
    profileMarkers?: "files" | "symlink"
    startupMessage?: string
    malformedProcesses?: boolean
    reusedPid?: boolean
    wrongRootSid?: boolean
    reuseOrphanAfterStop?: boolean
    nativeFailure?: "preflight" | "set" | "observe" | "restore"
    unready?: "wrong-listener" | "targets-unavailable" | "wrong-target"
    reservationFails?: "allocation" | "release"
    debugFlag?: "missing-port" | "duplicate-port" | "wrong-port" | "wrong-address" | "duplicate-address"
  } = {},
) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "windows-review-fixture-")))
  const root = await realpath(await mkdtemp(join(temporary, "owned-")))
  const before = {
    keys: [true, true, true, true, true],
    value: { kind: "ExpandString" as const, data: "C:\\PRIVATE-PREVIOUS-LAUNCHER\\%USERNAME%" },
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
    portEvents: [] as string[],
  }
  const child = Object.assign(new EventEmitter(), {
    pid: 4100,
    stderr: new PassThrough(),
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
    if (request.operation === "preflight" || request.operation === "observe") state.schemes.push(request.scheme)
    if (request.operation === "set" || request.operation === "restore" || request.operation === "observe")
      expect(request.executable).toBe(executable)
    if (request.operation === "preflight")
      return {
        executable,
        resolvedCommand,
        sid: processRecord("").sid,
        policy: structuredClone(before),
        debugPolicy: {
          machineRemoteDebuggingAllowed: "absent",
          baseRemoteDebuggingAllowed: "allow",
          machineDeveloperToolsAvailability: "restricted",
          baseDeveloperToolsAvailability: "deny",
        },
        processes: options.ambient ? [processRecord("C:\\ambient")] : [],
      }
    if (request.operation === "set") {
      expect(request.before).toEqual(before)
      expect(request.beforeCommand).toBe(resolvedCommand)
      state.profile = request.profile
      if (options.profileMarkers) {
        await writeFile(join(request.profile, "Local State"), "PRIVATE-PROFILE-CONTENTS")
        if (options.profileMarkers === "files") {
          await mkdir(join(request.profile, "Default"))
          await writeFile(join(request.profile, "Default", "Preferences"), "PRIVATE-PREFERENCES")
        } else await symlink(temporary, join(request.profile, "Default"), "junction")
      }
      state.policy = {
        keys: [true, true, true, true, true],
        value: { kind: "String", data: `"${executable}" "--user-data-dir=${request.profile}" -- "%1"` },
      }
      if (options.nativeFailure === "set")
        throw windowsReviewNativeFailure("PHYSICALSYSTEMS_WINDOWS_BROWSER_PHASE_policy-write")
      if (options.policySetLost) throw Error("PRIVATE-POLICY-WRITE-RESPONSE-LOST")
      return { written: true }
    }
    if (request.operation === "observe") {
      state.observedRoots.push([...request.observedPids])
      const main = processRecord(state.profile)
      if (options.debugFlag === "missing-port")
        main.args = main.args.filter((arg) => !arg.startsWith("--remote-debugging-port="))
      if (options.debugFlag === "duplicate-port") main.args.push("--remote-debugging-port=23456")
      if (options.debugFlag === "wrong-port")
        main.args = main.args.map((arg) =>
          arg.startsWith("--remote-debugging-port=") ? "--remote-debugging-port=23457" : arg,
        )
      if (options.debugFlag === "wrong-address")
        main.args = main.args.map((arg) =>
          arg.startsWith("--remote-debugging-address=") ? "--remote-debugging-address=0.0.0.0" : arg,
        )
      if (options.debugFlag === "duplicate-address") main.args.push("--remote-debugging-address=127.0.0.1")
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
        processes: options.malformedProcesses && !state.stopped ? "PRIVATE-MALFORMED" : processes,
        listening: state.running && request.port ? [options.unready === "wrong-listener" ? 4999 : 4100] : [],
        policyOwned: state.policy.value?.data === `"${executable}" "--user-data-dir=${state.profile}" -- "%1"`,
      }
    }
    if (request.operation === "stop") {
      expect(request.processes.map((item) => item.pid).sort()).toEqual([4100, 4101])
      expect(request.processes.every((item) => item.sid === processRecord("").sid)).toBe(true)
      state.running = false
      state.stopped = true
      if (options.exitDuringStop) child.emit("close", 255)
      if (options.stopLost) throw Error("PRIVATE-STOP-RESPONSE-LOST")
      return { stopped: true }
    }
    if (request.operation === "restore") {
      expect(request.beforeCommand).toBe(resolvedCommand)
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
    reservePort: async () => {
      state.portEvents.push("reserve")
      if (options.reservationFails === "allocation") throw Error("PRIVATE-ALLOCATION")
      return {
        port: 23456,
        release: async () => {
          state.portEvents.push("release")
          if (options.reservationFails === "release") throw Error("PRIVATE-CLOSE")
        },
      }
    },
    spawn: (exe: string, args: readonly string[], spawnOptions: { env?: NodeJS.ProcessEnv }) => {
      expect(state.portEvents).toEqual(["reserve", "release"])
      state.portEvents.push("spawn")
      expect(exe).toBe(executable)
      expect(args).toContain(`--user-data-dir=${state.profile}`)
      expect(args).toContain("--remote-debugging-port=23456")
      state.nativeEnv = spawnOptions.env ?? {}
      state.running = true
      if (options.startupMessage) queueMicrotask(() => child.stderr!.emit("data", Buffer.from(options.startupMessage!)))
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

test("owned Windows browser verifies exact native process/CDP and restores the prior launcher registration only after shutdown", async () => {
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

test("a missing or malformed original launcher command prevents registry changes and browser launch", async () => {
  for (const command of [undefined, null, "", "PRIVATE\nCOMMAND", "PRIVATE\0COMMAND", "x".repeat(32769)]) {
    const f = await fixture()
    const native = f.io.native
    try {
      await expect(
        startOwnedWindowsReviewBrowser(f.input, {
          ...f.io,
          native: async (request) => {
            const value = await native(request)
            return request.operation === "preflight" ? { ...(value as object), resolvedCommand: command } : value
          },
        }),
      ).rejects.toThrow("PROVIDER_REVIEW_WINDOWS_UNCONFIRMED")
      expect(f.state.calls).toEqual(["preflight"])
      expect(f.state.portEvents).toEqual([])
      expect(f.state.running).toBe(false)
      expect(f.state.policy).toEqual(f.before)
    } finally {
      await f.cleanup()
    }
  }
})

test("Windows browser starts only after its private standard AppData directories exist", async () => {
  const f = await fixture()
  const spawn = f.io.spawn
  try {
    const browser = await startOwnedWindowsReviewBrowser(f.input, {
      ...f.io,
      spawn: (executable, args, options) => {
        // Model Shell's existing %USERPROFILE%\\AppData known-folder layout,
        // rather than accepting an uncreated arbitrary LOCALAPPDATA path.
        expect(options.env?.USERPROFILE).toBe(f.input.root)
        expect(options.env?.LOCALAPPDATA).toBe(join(f.input.root, "AppData", "Local"))
        expect(options.env?.APPDATA).toBe(join(f.input.root, "AppData", "Roaming"))
        expect(statSync(options.env!.LOCALAPPDATA!).isDirectory()).toBe(true)
        expect(statSync(options.env!.APPDATA!).isDirectory()).toBe(true)
        expect(args).toContain(`--user-data-dir=${join(f.input.root, "profile")}`)
        return spawn(executable, args, options)
      },
    })
    await browser.stop()
    expect(f.state.restored).toBe(true)
  } finally {
    await f.cleanup()
  }
})

test("a browser log claiming it is listening cannot substitute for native listener ownership", async () => {
  const f = await fixture({
    unready: "wrong-listener",
    startupMessage: "DevTools listening on ws://127.0.0.1:23456/PRIVATE-TARGET",
  })
  try {
    const error = await startOwnedWindowsReviewBrowser(f.input, f.io).catch((error) => error)
    expect(error.message).toBe("PROVIDER_REVIEW_WINDOWS_UNCONFIRMED")
    expect(readBrowserObservation(error)?.windowsDebugMessage).toBe("listening")
    expect(readBrowserObservation(error)?.cdpReady).toBe(false)
    expect(f.state.targetQueries).toBe(0)
    expect(f.state.restored).toBe(true)
    expect(JSON.stringify(readBrowserObservation(error))).not.toContain("PRIVATE")
  } finally {
    await f.cleanup()
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

test("ambient browser, unknown startup identity, PID reuse and failed launcher restoration never authorize cleanup", async () => {
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

test("lost launcher-write response reconciles exact prior state; retained profiles still require restoration", async () => {
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
  expect(() => windowsReviewPolicy({ keys: [false, true, true, true, true], value: null })).toThrow()
  expect(() =>
    windowsReviewPolicy({ keys: [true, true, true, true, true], value: { kind: "Binary", data: "private" } }),
  ).toThrow()
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

test("native transport gives slow signature preflight headroom while preserving single-call mutation deadlines", async () => {
  const policy = { keys: [false, false, false, false, false], value: null }
  const requests: Parameters<WindowsReviewNative>[0][] = [
    { operation: "preflight", scheme: "http" },
    {
      operation: "set",
      scheme: "http",
      executable,
      beforeCommand: resolvedCommand,
      profile: "C:\\owned\\profile",
      before: policy,
    },
    { operation: "observe", executable, profile: "C:\\owned\\profile", scheme: "http", observedPids: [] },
    { operation: "stop", processes: [] },
    {
      operation: "restore",
      scheme: "http",
      executable,
      beforeCommand: resolvedCommand,
      profile: "C:\\owned\\profile",
      before: policy,
      observedPids: [],
    },
  ]
  for (const request of requests) {
    let calls = 0
    let written = ""
    let observedDeadline = 0
    // A fake execFile callback models 20s of OS work without sleeping or
    // starting any native process. This previously exceeded every deadline.
    const result = dispatchWindowsReviewNative(request, (options, complete) => {
      calls++
      observedDeadline = options.timeout
      expect(Object.isFrozen(options)).toBe(true)
      return {
        stdin: new Writable({
          write(chunk, _encoding, done) {
            written += chunk.toString()
            done()
          },
          final(done) {
            queueMicrotask(() => {
              complete(
                options.timeout < 20000 ? { killed: true, signal: "SIGTERM", code: null, message: "PRIVATE" } : null,
                JSON.stringify({ fixtureOnly: true }),
                "PHYSICALSYSTEMS_WINDOWS_BROWSER_PHASE_signature\nPRIVATE",
              )
            })
            done()
          },
        }),
      }
    })
    if (request.operation === "preflight") {
      expect(await result).toEqual({ fixtureOnly: true })
      expect(observedDeadline).toBe(30000)
    } else {
      let failure: unknown
      try {
        await result
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(Error)
      expect(readBrowserObservation(failure)?.windowsNativeOutcome).toBe("timeout")
      expect(observedDeadline).toBe(12000)
      expect(JSON.stringify(readBrowserObservation(failure))).not.toContain("PRIVATE")
    }
    expect(JSON.parse(written)).toEqual(request)
    expect(calls).toBe(1)
  }
})

test("extended preflight never retries or accepts native trust failure or expiry", async () => {
  for (const error of [{ code: 1 }, { killed: true, signal: "SIGTERM", code: null }]) {
    let calls = 0
    const result = dispatchWindowsReviewNative({ operation: "preflight", scheme: "https" }, (options, complete) => {
      calls++
      expect(options.timeout).toBe(30000)
      return {
        stdin: new Writable({
          write(_chunk, _encoding, done) {
            done()
          },
          final(done) {
            queueMicrotask(() => complete(error, "PRIVATE", "PHYSICALSYSTEMS_WINDOWS_BROWSER_PHASE_signature\n"))
            done()
          },
        }),
      }
    })
    let failure: unknown
    try {
      await result
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect(readBrowserObservation(failure)).toMatchObject({
      windowsNativePhase: "signature",
      windowsNativeOutcome: "killed" in error ? "timeout" : "exit",
    })
    expect(JSON.stringify(readBrowserObservation(failure))).not.toContain("PRIVATE")
    expect(calls).toBe(1)
  }
})

test("the real encoded diagnostic script fits CreateProcess including executable and argument overhead", () => {
  const args = windowsReviewNativeArguments("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
  expect(args.slice(0, -1)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"])
  expect(Buffer.from(args.at(-1)!, "base64").toString("utf16le")).toBe(
    windowsReviewScriptBootstrap(windowsReviewNativeScript),
  )
  expect(() => windowsReviewNativeArguments(`C:\\${"x".repeat(20000)}\\powershell.exe`)).toThrow(
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
  for (const unready of ["wrong-listener", "targets-unavailable", "wrong-target"] as const) {
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
      expect(observation?.readinessPortAllocated).toBe(true)
      expect(observation?.readinessPortReleased).toBe(true)
      expect(observation?.readinessDebugPortMatched).toBe(true)
      expect(observation?.readinessDebugAddressMatched).toBe(true)
      expect(observation?.readinessUnknownProcesses).toBe(0)
      expect(observation?.readinessTargetCount).toBe(unready === "wrong-target" ? 1 : 0)
      expect(observation?.readinessBlankTarget).toBe(false)
      const queried = ["targets-unavailable", "wrong-target"].includes(unready)
      expect(observation?.readinessTargetQueried).toBe(queried)
      expect(observation?.readinessListenerOwned).toBe(queried)
      expect(observation?.readinessTargetsAvailable).toBe(unready === "wrong-target")
      expect(observation?.readinessListeners).toBe(1)
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

test("actual loopback reservation excludes a competing bind and releases before reuse", async () => {
  const reservation = await reserveWindowsReviewPort()
  const competitor = createServer((socket) => socket.destroy())
  const rebound = createServer((socket) => socket.destroy())
  try {
    expect(reservation.port).toBeGreaterThan(0)
    expect(reservation.port).toBeLessThanOrEqual(65535)
    const conflict = await new Promise<string | undefined>((resolve) => {
      competitor.once("error", (error: NodeJS.ErrnoException) => resolve(error.code))
      competitor.listen({ host: "127.0.0.1", port: reservation.port, exclusive: true }, () => resolve(undefined))
    })
    expect(conflict).toBe("EADDRINUSE")
    const release = reservation.release()
    expect(reservation.release()).toBe(release)
    await release
    await new Promise<void>((resolve, reject) => {
      rebound.once("error", reject)
      rebound.listen({ host: "127.0.0.1", port: reservation.port, exclusive: true }, resolve)
    })
    expect(rebound.listening).toBe(true)
  } finally {
    await reservation.release()
    await Promise.all(
      [competitor, rebound].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    )
  }
})

test("a pending bind is aborted and cannot turn not-running close into confirmed release", async () => {
  let signal: AbortSignal | undefined
  let closeCalls = 0,
    unrefs = 0
  const server = Object.assign(new EventEmitter(), {
    unref() {
      unrefs++
      return this
    },
    listen(options: { host: string; port: number; signal: AbortSignal }) {
      expect(options.host).toBe("127.0.0.1")
      expect(options.port).toBe(0)
      signal = options.signal
      expect(signal.aborted).toBe(false)
      return this
    },
    close(callback: (error: NodeJS.ErrnoException) => void) {
      closeCalls++
      queueMicrotask(() => callback(Object.assign(Error("PRIVATE"), { code: "ERR_SERVER_NOT_RUNNING" })))
      return this
    },
  }) as unknown as Server
  await expect(reserveWindowsReviewPort({ server: () => server, timeoutMs: 5 })).rejects.toThrow(
    "PROVIDER_REVIEW_BROWSER_CLEANUP_UNCONFIRMED",
  )
  expect(signal?.aborted).toBe(true)
  expect(closeCalls).toBe(1)
  expect(unrefs).toBeGreaterThan(0)
})

test("reservation and release precede the single native launch, without relying on a port file", async () => {
  const f = await fixture()
  try {
    const browser = await startOwnedWindowsReviewBrowser(f.input, f.io)
    expect(f.state.portEvents).toEqual(["reserve", "release", "spawn"])
    await expect(access(join(f.state.profile, "DevToolsActivePort"))).rejects.toThrow()
    expect(f.state.targetQueries).toBeGreaterThan(0)
    await browser.stop()
    expect(f.state.portEvents).toEqual(["reserve", "release", "spawn"])
  } finally {
    await f.cleanup()
  }
})

test("allocation or unconfirmed release never launches or queries a browser", async () => {
  for (const reservationFails of ["allocation", "release"] as const) {
    const f = await fixture({ reservationFails })
    try {
      const error = await startOwnedWindowsReviewBrowser(f.input, f.io).catch((error: unknown) => error)
      expect(error).toBeInstanceOf(Error)
      expect(f.state.portEvents).toEqual(reservationFails === "allocation" ? ["reserve"] : ["reserve", "release"])
      expect(f.state.targetQueries).toBe(0)
      expect(f.state.running).toBe(false)
      expect(readBrowserObservation(error)?.pidObserved).toBe(false)
      if (reservationFails === "release")
        expect((error as Error).message).toBe("PROVIDER_REVIEW_BROWSER_CLEANUP_UNCONFIRMED")
      await access(f.input.root)
    } finally {
      await f.cleanup()
    }
  }
})

test("stripped, duplicate or mismatched native debugging flags fail before any CDP query", async () => {
  for (const debugFlag of [
    "missing-port",
    "duplicate-port",
    "wrong-port",
    "wrong-address",
    "duplicate-address",
  ] as const) {
    const f = await fixture({ debugFlag })
    try {
      const error = await startOwnedWindowsReviewBrowser(f.input, f.io).catch((error: unknown) => error)
      expect(error).toBeInstanceOf(Error)
      expect(f.state.portEvents).toEqual(["reserve", "release", "spawn"])
      expect(f.state.targetQueries).toBe(0)
      expect(readBrowserObservation(error)?.failedBrowserPhase).toBe("identity-argv")
      expect(readBrowserObservation(error)?.birthVerified).toBe(true)
      expect(readBrowserObservation(error)?.browserPhase).toBe("stopped")
      expect(f.state.restored).toBe(true)
      expect(JSON.stringify(readBrowserObservation(error))).not.toContain("23456")
    } finally {
      await f.cleanup()
    }
  }
})

test("preflight policy observations preserve restricted semantics and reject raw values", () => {
  for (const value of [
    undefined,
    null,
    [],
    "PRIVATE",
    {
      machineRemoteDebuggingAllowed: "PRIVATE",
      baseRemoteDebuggingAllowed: "restricted",
      machineDeveloperToolsAvailability: 0,
      baseDeveloperToolsAvailability: {},
    },
  ]) {
    expect(windowsReviewDebugPolicyObservation(value)).toEqual({
      machineRemoteDebugging: "invalid",
      userRemoteDebugging: "invalid",
      machineDeveloperTools: "invalid",
      userDeveloperTools: "invalid",
    })
  }
  for (const state of ["absent", "allow", "deny", "invalid", "restricted"] as const) {
    const value = windowsReviewDebugPolicyObservation({
      machineRemoteDebuggingAllowed: state,
      baseRemoteDebuggingAllowed: state,
      machineDeveloperToolsAvailability: state,
      baseDeveloperToolsAvailability: state,
    })
    expect(value.machineRemoteDebugging).toBe(state === "restricted" ? "invalid" : state)
    expect(value.machineDeveloperTools).toBe(state)
  }
})

test("failure freezes metadata-only profile markers and child state before cleanup changes them", async () => {
  for (const profileMarkers of ["files", "symlink"] as const) {
    const f = await fixture({ unready: "wrong-listener", profileMarkers, exitDuringStop: true })
    try {
      const error = await startOwnedWindowsReviewBrowser(f.input, f.io).catch((error) => error)
      const observation = readBrowserObservation(error)
      expect(observation).toMatchObject({
        browserPhase: "stopped",
        failedBrowserPhase: "cdp-targets",
        failedWindowsObservePhase: "complete",
        machineRemoteDebugging: "absent",
        userRemoteDebugging: "allow",
        machineDeveloperTools: "restricted",
        userDeveloperTools: "deny",
        childExitedAtFailure: false,
        processExited: true,
        exitCode: 255,
        profileMarkerReadComplete: profileMarkers === "files",
        profileLocalStatePresent: true,
        profilePreferencesPresent: profileMarkers === "files",
      })
      expect(JSON.stringify(observation)).not.toContain("PRIVATE")
      expect(JSON.stringify(observation)).not.toContain(f.input.root)
      await expect(access(f.input.root)).rejects.toThrow()
    } finally {
      await f.cleanup()
    }
  }
})

test("malformed native process shape retains its first boundary through cleanup uncertainty", async () => {
  const f = await fixture({ malformedProcesses: true })
  try {
    const error = await startOwnedWindowsReviewBrowser(f.input, f.io).catch((error) => error)
    expect(readBrowserObservation(error)).toMatchObject({
      failedBrowserPhase: "identity-stat",
      failedWindowsObservePhase: "processes",
      childExitedAtFailure: false,
    })
    expect(f.state.calls).not.toContain("stop")
    expect(f.state.calls).not.toContain("restore")
    expect(JSON.stringify(readBrowserObservation(error))).not.toContain("PRIVATE")
  } finally {
    await f.cleanup()
  }
})
