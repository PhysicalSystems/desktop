// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import {
  browserObservationError,
  browserSyscallFailure,
  readBrowserObservation,
  createBrowserStderrObservation,
  createWindowsBrowserStderrObservation,
} from "./browser-observation"

test("browser failure keeps only fixed phase/count metadata through cleanup wrappers", () => {
  const startup = browserObservationError("PROVIDER_REVIEW_BROWSER_CLEANUP_UNCONFIRMED", Error("PRIVATE-CONTENT"), {
    browserPhase: "cleanup-identity",
    failedBrowserPhase: "identity-executable",
    cleanupFailurePhase: "cleanup-identity",
    pidObserved: true,
    birthVerified: false,
    cdpReady: false,
    syscallFailure: "EACCES",
  })
  const wrapped = browserObservationError("BROWSER_HANDOFF_CLEANUP_UNCONFIRMED", startup, {
    reviewPhase: "browser-cleanup",
    failedReviewPhase: "browser-acquisition",
    openerAcknowledged: false,
    requestObserved: false,
  })
  expect(wrapped.message).toBe("BROWSER_HANDOFF_CLEANUP_UNCONFIRMED")
  expect(readBrowserObservation(wrapped)).toEqual({
    ...readBrowserObservation(startup),
    reviewPhase: "browser-cleanup",
    failedReviewPhase: "browser-acquisition",
    openerAcknowledged: false,
    requestObserved: false,
  })
  expect(JSON.stringify(readBrowserObservation(wrapped))).not.toContain("PRIVATE")
  expect(Object.isFrozen(readBrowserObservation(wrapped))).toBe(true)
  expect(browserSyscallFailure({ code: "EACCES" })).toBe("EACCES")
  expect(browserSyscallFailure({ code: "EBUSY", path: "PRIVATE" })).toBe("EBUSY")
  expect(browserSyscallFailure({ code: "ENOTEMPTY", path: "PRIVATE" })).toBe("ENOTEMPTY")
  expect(browserSyscallFailure({ code: "PRIVATE" })).toBe("OTHER")
})

test("unknown fields/values, URLs, unsafe counts and getter failures cannot enter browser receipts", () => {
  for (const browserObservation of [
    { browserPhase: "ready", url: "PRIVATE" },
    { browserPhase: "PRIVATE" },
    { browserPhase: "ready", targetCount: -1 },
    { browserPhase: "ready", targetCount: 65537 },
    { browserPhase: "ready", targetCount: 1.5 },
    { browserPhase: "ready", cdpReady: "true" },
    { browserPhase: "ready", syscallFailure: "PRIVATE" },
    { browserPhase: "identity-argv", argvFields: -1 },
    { browserPhase: "identity-argv", argvFields: 65537 },
    { browserPhase: "identity-argv", profileTokenMatched: "PRIVATE" },
    { browserPhase: "identity-argv", processState: "PRIVATE" },
    { browserPhase: "identity-argv", exitCode: 256 },
    { browserPhase: "identity-argv", stderrCategory: "PRIVATE" },
    { browserPhase: "cleanup-observe", inspectPhase: "PRIVATE" },
    { browserPhase: "cleanup-observe", sameSession: "PRIVATE" },
    { browserPhase: "windows-preflight", windowsNativePhase: "PRIVATE" },
    { browserPhase: "identity-stat", failedWindowsObservePhase: "PRIVATE" },
    { browserPhase: "identity-stat", childExitedAtFailure: "PRIVATE" },
    { browserPhase: "identity-stat", profileLocalStatePresent: "PRIVATE" },
    { browserPhase: "windows-preflight", machineRemoteDebugging: "restricted" },
    { browserPhase: "windows-preflight", userDeveloperTools: "PRIVATE" },
    { browserPhase: "windows-preflight", windowsNativeOutcome: "PRIVATE" },
    { browserPhase: "cdp-targets", windowsDebugMessage: "PRIVATE" },
    { browserPhase: "cdp-targets", readinessTargetCount: 65537 },
    { browserPhase: "cdp-targets", readinessPortLineHasCR: "PRIVATE" },
    {},
    [],
    null,
  ])
    expect(readBrowserObservation({ browserObservation })).toBeUndefined()
  expect(
    readBrowserObservation({
      get browserObservation() {
        throw Error("PRIVATE")
      },
    }),
  ).toBeUndefined()
  expect(
    readBrowserObservation({
      browserObservation: { browserPhase: "identity-argv", argvFields: 1, profileTokenMatched: true },
    }),
  ).toEqual({ browserPhase: "identity-argv", argvFields: 1, profileTokenMatched: true })
})

test("Windows startup stderr records fixed messages without exporting debug URLs or private text", () => {
  const observed = createWindowsBrowserStderrObservation()
  expect(observed.snapshot()).toEqual({ windowsDebugMessage: "none", stderrTruncated: false })
  for (const [text, expected] of [
    ["PRIVATE unrelated startup output", "other"],
    ["DevTools listening on ws://127.0.0.1:23456/PRIVATE", "listening"],
    ["Cannot start http server for devtools.", "bind-failed"],
    ["DevTools remote debugging requires a non-default data directory.", "default-profile"],
    ["DevTools remote debugging is disallowed by the system admin.", "policy-denied"],
  ] as const) {
    observed.observe(Buffer.from(text.slice(0, 20)))
    observed.observe(Buffer.from(text.slice(20)))
    expect(observed.snapshot().windowsDebugMessage).toBe(expected)
    expect(JSON.stringify(observed.snapshot())).not.toContain("PRIVATE")
    const value = { browserPhase: "cdp-targets" as const, ...observed.snapshot() }
    expect(readBrowserObservation({ browserObservation: value })).toEqual(value)
  }
  const bounded = createWindowsBrowserStderrObservation()
  bounded.observe(Buffer.alloc(65537, 120))
  bounded.observe(Buffer.from("DevTools remote debugging is disallowed by the system admin."))
  expect(bounded.snapshot()).toEqual({ windowsDebugMessage: "other", stderrTruncated: true })
})

test("bounded private stderr observes fixed categories across chunks and never retains text", () => {
  const observer = createBrowserStderrObservation()
  observer.observe(Buffer.from("PRIVATE URL token Failed to connect to the bus"))
  expect(observer.snapshot()).toEqual({ stderrCategory: "dbus", stderrTruncated: false })
  observer.observe(Buffer.from("Missing X server or $DISPLAY"))
  expect(observer.snapshot().stderrCategory).toBe("display")
  observer.observe(Buffer.from("Failed to move to new name"))
  observer.observe(Buffer.from("space: Operation not permitted PRIVATE"))
  expect(observer.snapshot().stderrCategory).toBe("sandbox")
  expect(JSON.stringify(observer.snapshot())).not.toContain("PRIVATE")
  const bounded = createBrowserStderrObservation()
  bounded.observe(Buffer.alloc(65537, 120))
  bounded.observe(Buffer.from("No usable sandbox"))
  expect(bounded.snapshot()).toEqual({ stderrCategory: "other", stderrTruncated: true })
  expect(
    readBrowserObservation({
      browserObservation: {
        browserPhase: "identity-argv",
        processState: "Z",
        processExited: true,
        exitCode: 1,
        stderrCategory: "sandbox",
        emptyArgvReads: 1,
      },
    }),
  ).toEqual({
    browserPhase: "identity-argv",
    processState: "Z",
    processExited: true,
    exitCode: 1,
    stderrCategory: "sandbox",
    emptyArgvReads: 1,
  })
})

test("cleanup branch observation carries only exact scope booleans and a fixed inspection phase", () => {
  const value = {
    browserPhase: "cleanup-observe",
    inspectPhase: "uid",
    sameSession: false,
    databaseMatched: true,
    ownedProcesses: 2,
  } as const
  expect(readBrowserObservation({ browserObservation: value })).toEqual(value)
})

test("handoff facts remain fixed and distinct from cleanup process snapshots", () => {
  const observed = {
    browserPhase: "handoff-targets",
    handoffPhase: "native",
    handoffOutcome: "canceled",
    handoffQuiescence: "settled",
    handoffDeadlineExpired: true,
    handoffPolicyOwned: true,
    handoffListenerOwned: true,
    handoffTargetsAvailable: false,
    handoffTargetMatched: false,
    handoffPolls: 1,
    handoffListeners: 1,
    handoffUnknownProcesses: 0,
    handoffUnknownExecutableProcesses: 0,
    handoffUnknownSidProcesses: 0,
    handoffUnknownSessionProcesses: 0,
    handoffUnknownBirthProcesses: 0,
    handoffUnknownProfileOrAncestryProcesses: 0,
    handoffUnknownCrashpadTypeProcesses: 0,
    handoffUnknownCrashpadDatabaseProcesses: 0,
    handoffTargetCount: 0,
    handoffWindowsNativePhase: "listener",
    handoffWindowsNativeOutcome: "timeout",
  } as const
  expect(readBrowserObservation({ browserObservation: observed })).toEqual(observed)
  const failure = browserObservationError("BROWSER_HANDOFF_UNCONFIRMED", undefined, observed)
  const cleanup = browserObservationError("BROWSER_HANDOFF_CLEANUP_UNCONFIRMED", failure, {
    browserPhase: "cleanup-profile",
    observedProcesses: 0,
  })
  expect(readBrowserObservation(cleanup)).toMatchObject({
    ...observed,
    browserPhase: "cleanup-profile",
    observedProcesses: 0,
  })
  for (const invalid of [
    { handoffPhase: "PRIVATE" },
    { handoffOutcome: "PASS" },
    { handoffQuiescence: "PRIVATE" },
    { handoffListenerOwned: "PRIVATE" },
    { handoffTargetCount: 65537 },
    { handoffWindowsNativePhase: "PRIVATE" },
    { handoffWindowsNativeOutcome: "PRIVATE" },
  ]) {
    expect(readBrowserObservation({ browserObservation: { ...observed, ...invalid } })).toBeUndefined()
  }
})

test("handoff ownership reasons admit bounded counts only, with no process identity metadata", () => {
  for (const key of [
    "handoffUnknownExecutableProcesses",
    "handoffUnknownSidProcesses",
    "handoffUnknownSessionProcesses",
    "handoffUnknownBirthProcesses",
    "handoffUnknownProfileOrAncestryProcesses",
    "handoffUnknownCrashpadTypeProcesses",
    "handoffUnknownCrashpadDatabaseProcesses",
  ]) {
    for (const value of [0, 1, 65536]) {
      const observation = { browserPhase: "handoff-targets" as const, [key]: value }
      expect(readBrowserObservation({ browserObservation: observation })).toEqual(observation)
    }
    for (const value of [-1, 1.5, 65537, NaN, "PRIVATE-PID-PATH-ARGV", { pid: 4100 }])
      expect(
        readBrowserObservation({ browserObservation: { browserPhase: "handoff-targets", [key]: value } }),
      ).toBeUndefined()
  }
  for (const key of ["unknownPid", "unknownPath", "unknownArgs", "unknownSid"])
    expect(
      readBrowserObservation({ browserObservation: { browserPhase: "handoff-targets", [key]: "PRIVATE" } }),
    ).toBeUndefined()
})

test("directory failure observations admit fixed categories and tightly bounded metadata only", () => {
  const value = {
    browserPhase: "cleanup-profile",
    directoryFailurePhase: "remove",
    directoryRemovalAttempt: 4,
    directorySyscall: "rm",
    directoryErrorPath: "descendant",
    directoryInventory: "bounded",
    directoryEntries: 128,
    directoryDirectories: 10,
    directoryFiles: 115,
    directoryLinks: 3,
    directoryNonWritableMode: 1,
    directoryReadFailures: 0,
    directoryInventoryDepth: 4,
  } as const
  expect(readBrowserObservation({ browserObservation: value })).toEqual(value)
  for (const key of ["directoryFailurePhase", "directorySyscall", "directoryErrorPath", "directoryInventory"])
    expect(readBrowserObservation({ browserObservation: { ...value, [key]: "PRIVATE-PATH" } })).toBeUndefined()
  for (const key of [
    "directoryRemovalAttempt",
    "directoryEntries",
    "directoryDirectories",
    "directoryFiles",
    "directoryLinks",
    "directoryNonWritableMode",
    "directoryReadFailures",
    "directoryInventoryDepth",
  ]) {
    const maximum = ["directoryRemovalAttempt", "directoryInventoryDepth"].includes(key) ? 4 : 128
    for (const invalid of [-1, 1.5, maximum + 1, "PRIVATE"])
      expect(readBrowserObservation({ browserObservation: { ...value, [key]: invalid } })).toBeUndefined()
  }
  for (const key of ["directoryPath", "directoryFileNames", "directoryLockOwner", "directoryAcl"])
    expect(readBrowserObservation({ browserObservation: { ...value, [key]: "PRIVATE" } })).toBeUndefined()
})
