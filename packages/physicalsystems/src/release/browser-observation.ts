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
  "policy-read",
  "policy-compare",
  "policy-write",
  "policy-readback",
  "process-tree",
  "process-identity",
  "listener",
  "policy-restore",
  "policy-keys",
  "process-signal",
  "process-wait",
  "output",
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
  inspectPhase?: "proc-stat" | "proc-status" | "cmdline" | "uid" | "crashpad-executable" | "birth"
  sameSession?: boolean
  databaseMatched?: boolean
  ownedProcesses?: number
  targetCount?: number
  syscallFailure?: "ENOENT" | "ESRCH" | "EACCES" | "EPERM" | "OTHER"
  windowsNativePhase?: (typeof windowsPhases)[number]
  failedWindowsNativePhase?: (typeof windowsPhases)[number]
  windowsNativeOutcome?: "timeout" | "signal" | "exit" | "start" | "output-limit" | "invalid-json" | "unknown"
  policyOwned?: boolean
  sidMatched?: boolean
  observedProcesses?: number
  unknownProcesses?: number
  listenerProcesses?: number
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
]
const counts = [
  "ownedProcesses",
  "targetCount",
  "argvFields",
  "argvReads",
  "emptyArgvReads",
  "observedProcesses",
  "unknownProcesses",
  "listenerProcesses",
]
function validate(value: unknown): BrowserObservation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    const allowed = ["windowsNativePhase", "failedWindowsNativePhase"].includes(key)
      ? windowsPhases
      : ["browserPhase", "failedBrowserPhase", "cleanupFailurePhase"].includes(key)
        ? phases
        : ["reviewPhase", "failedReviewPhase"].includes(key)
          ? reviews
          : key === "windowsNativeOutcome"
            ? ["timeout", "signal", "exit", "start", "output-limit", "invalid-json", "unknown"]
            : key === "syscallFailure"
              ? ["ENOENT", "ESRCH", "EACCES", "EPERM", "OTHER"]
              : key === "processState"
                ? ["R", "S", "D", "T", "t", "I", "P", "Z", "X", "x"]
                : key === "termination"
                  ? ["SIGABRT", "SIGSEGV", "SIGTRAP", "SIGTERM", "SIGKILL", "OTHER"]
                  : key === "stderrCategory"
                    ? ["sandbox", "display", "dbus", "other"]
                    : key === "inspectPhase"
                      ? ["proc-stat", "proc-status", "cmdline", "uid", "crashpad-executable", "birth"]
                      : undefined
    if (
      allowed
        ? !(allowed as readonly unknown[]).includes(item)
        : bools.includes(key)
          ? typeof item !== "boolean"
          : counts.includes(key)
            ? !Number.isInteger(item) || Number(item) < 0 || Number(item) > 65536
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
  return ["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(code ?? "")
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
