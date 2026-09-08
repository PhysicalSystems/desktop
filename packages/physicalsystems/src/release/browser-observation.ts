// SPDX-License-Identifier: Apache-2.0
const phases = [
  "context",
  "directories",
  "spawn",
  "identity-stat",
  "identity-session",
  "identity-executable",
  "identity-uid",
  "identity-argv",
  "port-file",
  "cdp-targets",
  "ready",
  "handoff-targets",
  "cleanup-quiescence",
  "cleanup-identity",
  "cleanup-observe",
  "cleanup-signal",
  "cleanup-wait",
  "cleanup-profile",
  "stopped",
  "windows-preflight",
  "windows-preflight-shape",
  "windows-policy-write",
  "windows-policy-restore",
  "windows-port-reserve",
  "windows-port-release",
] as const
const windowsPhases = [
  "bootstrap",
  "input-read",
  "input-parse",
  "registry-open",
  "caller-identity",
  "add-type",
  "machine-policy",
  "ambient-browser",
  "association-progid",
  "association-executable",
  "signature",
  "debug-policy",
  "policy-read",
  "policy-compare",
  "policy-write",
  "policy-readback",
  "process-tree",
  "retained-input",
  "retained-query",
  "retained-self",
  "retained-other",
  "process-identity",
  "listener",
  "policy-restore",
  "policy-keys",
  "process-signal",
  "process-wait",
  "output",
] as const
const windowsObservePhases = [
  "native",
  "response",
  "processes",
  "retained-identity",
  "listener-shape",
  "ownership",
  "policy",
  "complete",
] as const
const reviews = [
  "context",
  "browser-acquisition",
  "app-session",
  "opener",
  "target",
  "request",
  "browser-cleanup",
  "review-cleanup",
] as const
export type BrowserObservation = {
  browserPhase?: (typeof phases)[number]
  failedBrowserPhase?: (typeof phases)[number]
  cleanupFailurePhase?: (typeof phases)[number]
  reviewPhase?: (typeof reviews)[number]
  failedReviewPhase?: (typeof reviews)[number]
  pidObserved?: boolean
  birthVerified?: boolean
  cdpReady?: boolean
  openerAcknowledged?: boolean
  requestObserved?: boolean
  profileTokenMatched?: boolean
  argvFields?: number
  argvReads?: number
  emptyArgvReads?: number
  processState?: "R" | "S" | "D" | "T" | "t" | "I" | "P" | "Z" | "X" | "x"
  processExited?: boolean
  exitCode?: number
  termination?: "SIGABRT" | "SIGSEGV" | "SIGTRAP" | "SIGTERM" | "SIGKILL" | "OTHER"
  stderrCategory?: "sandbox" | "display" | "dbus" | "other"
  stderrTruncated?: boolean
  windowsDebugMessage?: "none" | "other" | "listening" | "bind-failed" | "default-profile" | "policy-denied"
  inspectPhase?: "proc-stat" | "proc-status" | "cmdline" | "uid" | "crashpad-executable" | "birth"
  sameSession?: boolean
  databaseMatched?: boolean
  ownedProcesses?: number
  targetCount?: number
  syscallFailure?: "ENOENT" | "ESRCH" | "EACCES" | "EPERM" | "EBUSY" | "ENOTEMPTY" | "OTHER"
  windowsNativePhase?: (typeof windowsPhases)[number]
  failedWindowsNativePhase?: (typeof windowsPhases)[number]
  windowsNativeOutcome?: "timeout" | "signal" | "exit" | "start" | "output-limit" | "invalid-json" | "unknown"
  windowsObservePhase?: (typeof windowsObservePhases)[number]
  failedWindowsObservePhase?: (typeof windowsObservePhases)[number]
  machineRemoteDebugging?: "absent" | "allow" | "deny" | "invalid"
  userRemoteDebugging?: "absent" | "allow" | "deny" | "invalid"
  machineDeveloperTools?: "absent" | "restricted" | "allow" | "deny" | "invalid"
  userDeveloperTools?: "absent" | "restricted" | "allow" | "deny" | "invalid"
  childExitedAtFailure?: boolean
  profileMarkerReadComplete?: boolean
  profileLocalStatePresent?: boolean
  profilePreferencesPresent?: boolean
  policyOwned?: boolean
  sidMatched?: boolean
  observedProcesses?: number
  unknownProcesses?: number
  listenerProcesses?: number
  readinessPolls?: number
  readinessListeners?: number
  readinessUnknownProcesses?: number
  readinessTargetCount?: number
  readinessPortFilePresent?: boolean
  readinessPortParsed?: boolean
  readinessPortLineHasCR?: boolean
  readinessListenerOwned?: boolean
  readinessTargetQueried?: boolean
  readinessTargetsAvailable?: boolean
  readinessBlankTarget?: boolean
  readinessPortAllocated?: boolean
  readinessPortReleased?: boolean
  readinessDebugPortMatched?: boolean
  readinessDebugAddressMatched?: boolean
  handoffPhase?: "context" | "native" | "ownership" | "targets" | "complete"
  handoffOutcome?: "pending" | "matched" | "not-matched" | "canceled" | "failed"
  handoffQuiescence?: "settled" | "unconfirmed"
  handoffDeadlineExpired?: boolean
  handoffPolicyOwned?: boolean
  handoffListenerOwned?: boolean
  handoffTargetsAvailable?: boolean
  handoffTargetMatched?: boolean
  handoffPolls?: number
  handoffListeners?: number
  handoffUnknownProcesses?: number
  handoffUnknownExecutableProcesses?: number
  handoffUnknownSidProcesses?: number
  handoffUnknownSessionProcesses?: number
  handoffUnknownBirthProcesses?: number
  handoffUnknownProfileOrAncestryProcesses?: number
  handoffUnknownCrashpadTypeProcesses?: number
  handoffUnknownCrashpadDatabaseProcesses?: number
  handoffTargetCount?: number
  handoffWindowsNativePhase?: (typeof windowsPhases)[number]
  handoffWindowsNativeOutcome?: BrowserObservation["windowsNativeOutcome"]
  directoryFailurePhase?: "parent-canonical" | "parent-identity" | "root-identity" | "remove" | "absence-check"
  directoryRemovalAttempt?: number
  directorySyscall?: "rm" | "lstat" | "realpath" | "readdir" | "other" | "absent"
  directoryErrorPath?: "root" | "parent" | "descendant" | "other" | "absent"
  directoryInventory?: "complete" | "bounded" | "identity-unconfirmed" | "read-failed"
  directoryEntries?: number
  directoryDirectories?: number
  directoryFiles?: number
  directoryLinks?: number
  /** POSIX mode metadata only; not Windows readonly, ACL or lock evidence. */
  directoryNonWritableMode?: number
  directoryReadFailures?: number
  directoryInventoryDepth?: number
}
const codes = [
  "PROVIDER_REVIEW_BROWSER_UNCONFIRMED",
  "PROVIDER_REVIEW_WINDOWS_UNCONFIRMED",
  "PROVIDER_REVIEW_BROWSER_CLEANUP_UNCONFIRMED",
  "PROVIDER_REVIEW_UNCONFIRMED",
  "PROVIDER_REVIEW_CLEANUP_UNCONFIRMED",
  "BROWSER_HANDOFF_UNCONFIRMED",
  "BROWSER_HANDOFF_CLEANUP_UNCONFIRMED",
] as const
const bools = [
  "handoffDeadlineExpired",
  "handoffPolicyOwned",
  "handoffListenerOwned",
  "handoffTargetsAvailable",
  "handoffTargetMatched",
  "childExitedAtFailure",
  "profileMarkerReadComplete",
  "profileLocalStatePresent",
  "profilePreferencesPresent",
  "pidObserved",
  "birthVerified",
  "cdpReady",
  "openerAcknowledged",
  "requestObserved",
  "profileTokenMatched",
  "processExited",
  "stderrTruncated",
  "sameSession",
  "databaseMatched",
  "policyOwned",
  "sidMatched",
  "readinessPortFilePresent",
  "readinessPortParsed",
  "readinessPortLineHasCR",
  "readinessListenerOwned",
  "readinessTargetQueried",
  "readinessTargetsAvailable",
  "readinessBlankTarget",
  "readinessPortAllocated",
  "readinessPortReleased",
  "readinessDebugPortMatched",
  "readinessDebugAddressMatched",
]
const counts = [
  "handoffPolls",
  "handoffListeners",
  "handoffUnknownProcesses",
  "handoffUnknownExecutableProcesses",
  "handoffUnknownSidProcesses",
  "handoffUnknownSessionProcesses",
  "handoffUnknownBirthProcesses",
  "handoffUnknownProfileOrAncestryProcesses",
  "handoffUnknownCrashpadTypeProcesses",
  "handoffUnknownCrashpadDatabaseProcesses",
  "handoffTargetCount",
  "ownedProcesses",
  "targetCount",
  "argvFields",
  "argvReads",
  "emptyArgvReads",
  "observedProcesses",
  "unknownProcesses",
  "listenerProcesses",
  "readinessPolls",
  "readinessListeners",
  "readinessUnknownProcesses",
  "readinessTargetCount",
]
const directoryCounts = [
  "directoryEntries",
  "directoryDirectories",
  "directoryFiles",
  "directoryLinks",
  "directoryNonWritableMode",
  "directoryReadFailures",
]
const directoryEnums = new Map<string, readonly string[]>([
  ["directoryFailurePhase", ["parent-canonical", "parent-identity", "root-identity", "remove", "absence-check"]],
  ["directorySyscall", ["rm", "lstat", "realpath", "readdir", "other", "absent"]],
  ["directoryErrorPath", ["root", "parent", "descendant", "other", "absent"]],
  ["directoryInventory", ["complete", "bounded", "identity-unconfirmed", "read-failed"]],
])
function validate(value: unknown): BrowserObservation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    const allowed =
      directoryEnums.get(key) ??
      (key === "handoffPhase"
        ? ["context", "native", "ownership", "targets", "complete"]
        : key === "handoffOutcome"
          ? ["pending", "matched", "not-matched", "canceled", "failed"]
          : key === "handoffQuiescence"
            ? ["settled", "unconfirmed"]
            : ["windowsObservePhase", "failedWindowsObservePhase"].includes(key)
              ? windowsObservePhases
              : ["machineRemoteDebugging", "userRemoteDebugging"].includes(key)
                ? ["absent", "allow", "deny", "invalid"]
                : ["machineDeveloperTools", "userDeveloperTools"].includes(key)
                  ? ["absent", "restricted", "allow", "deny", "invalid"]
                  : ["windowsNativePhase", "failedWindowsNativePhase", "handoffWindowsNativePhase"].includes(key)
                    ? windowsPhases
                    : ["browserPhase", "failedBrowserPhase", "cleanupFailurePhase"].includes(key)
                      ? phases
                      : ["reviewPhase", "failedReviewPhase"].includes(key)
                        ? reviews
                        : ["windowsNativeOutcome", "handoffWindowsNativeOutcome"].includes(key)
                          ? ["timeout", "signal", "exit", "start", "output-limit", "invalid-json", "unknown"]
                          : key === "syscallFailure"
                            ? ["ENOENT", "ESRCH", "EACCES", "EPERM", "EBUSY", "ENOTEMPTY", "OTHER"]
                            : key === "processState"
                              ? ["R", "S", "D", "T", "t", "I", "P", "Z", "X", "x"]
                              : key === "termination"
                                ? ["SIGABRT", "SIGSEGV", "SIGTRAP", "SIGTERM", "SIGKILL", "OTHER"]
                                : key === "windowsDebugMessage"
                                  ? ["none", "other", "listening", "bind-failed", "default-profile", "policy-denied"]
                                  : key === "stderrCategory"
                                    ? ["sandbox", "display", "dbus", "other"]
                                    : key === "inspectPhase"
                                      ? ["proc-stat", "proc-status", "cmdline", "uid", "crashpad-executable", "birth"]
                                      : undefined)
    const maximum =
      key === "directoryRemovalAttempt" || key === "directoryInventoryDepth"
        ? 4
        : directoryCounts.includes(key)
          ? 128
          : counts.includes(key)
            ? 65536
            : undefined
    if (
      allowed
        ? !(allowed as readonly unknown[]).includes(item)
        : bools.includes(key)
          ? typeof item !== "boolean"
          : maximum !== undefined
            ? !Number.isInteger(item) || Number(item) < 0 || Number(item) > maximum
            : key === "exitCode"
              ? !Number.isInteger(item) || Number(item) < 0 || Number(item) > 255
              : true
    )
      return
    result[key] = item
  }
  if (!result.browserPhase && !result.reviewPhase) return
  return Object.freeze(result) as BrowserObservation
}

/** Only fixed enums, counts and booleans survive arbitrary error metadata. */
export function readBrowserObservation(error: unknown): BrowserObservation | undefined {
  try {
    return validate((error as { browserObservation?: unknown })?.browserObservation)
  } catch {
    return
  }
}

export function browserObservationError(code: (typeof codes)[number], error: unknown, update: BrowserObservation) {
  const result = new Error(code)
  const observation = validate({ ...readBrowserObservation(error), ...update })
  if (observation) Object.defineProperty(result, "browserObservation", { value: observation })
  return result
}

export function browserSyscallFailure(error: unknown): BrowserObservation["syscallFailure"] {
  const code = (error as NodeJS.ErrnoException)?.code
  return ["ENOENT", "ESRCH", "EACCES", "EPERM", "EBUSY", "ENOTEMPTY"].includes(code ?? "")
    ? (code as "ENOENT" | "ESRCH" | "EACCES" | "EPERM")
    : "OTHER"
}

/** Drain stderr privately; keep only one fixed category and bounded overlap.
 * A DBus warning is an observation, not a claim that it caused startup failure. */
export function createBrowserStderrObservation() {
  let bytes = 0,
    tail = "",
    truncated = false
  let category: NonNullable<BrowserObservation["stderrCategory"]> = "other"
  const priority = { other: 0, dbus: 1, display: 2, sandbox: 3 }
  return {
    observe(chunk: Uint8Array) {
      const left = 65536 - bytes
      if (chunk.length > left) truncated = true
      const part = chunk.subarray(0, Math.max(0, left))
      bytes += part.length
      const text = tail + Buffer.from(part).toString("utf8")
      const found =
        /No usable sandbox|Failed to move to new namespace|SUID sandbox helper binary|Running as root without|Failed to initialize.{0,80}sandbox/i.test(
          text,
        )
          ? "sandbox"
          : /Missing X server|The platform failed to initialize|Unable to open X display|Could not connect to.{0,80}display/i.test(
                text,
              )
            ? "display"
            : /Failed to connect to the bus|Failed to connect to.{0,80}D-Bus|Could not parse server address/i.test(text)
              ? "dbus"
              : "other"
      if (priority[found] > priority[category]) category = found
      tail = bytes < 65536 ? text.slice(-256) : ""
    },
    snapshot: () => ({ stderrCategory: category, stderrTruncated: truncated }),
  }
}

/** Observe startup messages only; a log line never proves listener ownership.
 * Drain and discard output, including any later provider text, after 64 KiB. */
export function createWindowsBrowserStderrObservation() {
  let bytes = 0,
    tail = "",
    truncated = false
  let message: NonNullable<BrowserObservation["windowsDebugMessage"]> = "none"
  const priority = { none: 0, other: 1, listening: 2, "bind-failed": 3, "default-profile": 4, "policy-denied": 5 }
  return {
    observe(chunk: Uint8Array) {
      const left = 65536 - bytes
      if (chunk.length > left) truncated = true
      const part = chunk.subarray(0, Math.max(0, left))
      bytes += part.length
      const text = tail + Buffer.from(part).toString("utf8")
      const found = /DevTools remote debugging is disallowed by the system admin/i.test(text)
        ? "policy-denied"
        : /DevTools remote debugging requires a non-default data directory/i.test(text)
          ? "default-profile"
          : /Cannot start http server for devtools/i.test(text)
            ? "bind-failed"
            : /DevTools listening on ws:\/\//i.test(text)
              ? "listening"
              : bytes
                ? "other"
                : "none"
      if (priority[found] > priority[message]) message = found
      tail = bytes < 65536 ? text.slice(-256) : ""
    },
    snapshot: () => ({ windowsDebugMessage: message, stderrTruncated: truncated }),
  }
}
