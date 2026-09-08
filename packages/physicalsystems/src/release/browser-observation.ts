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
  ownedProcesses?: number
  targetCount?: number
  syscallFailure?: "ENOENT" | "ESRCH" | "EACCES" | "EPERM" | "OTHER"
}
const codes = [
  "PROVIDER_REVIEW_BROWSER_UNCONFIRMED",
  "PROVIDER_REVIEW_BROWSER_CLEANUP_UNCONFIRMED",
  "PROVIDER_REVIEW_UNCONFIRMED",
  "PROVIDER_REVIEW_CLEANUP_UNCONFIRMED",
  "BROWSER_HANDOFF_UNCONFIRMED",
  "BROWSER_HANDOFF_CLEANUP_UNCONFIRMED",
] as const
const bools = ["pidObserved", "birthVerified", "cdpReady", "openerAcknowledged", "requestObserved"]
const counts = ["ownedProcesses", "targetCount"]
function validate(value: unknown): BrowserObservation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    const allowed = ["browserPhase", "failedBrowserPhase", "cleanupFailurePhase"].includes(key)
      ? phases
      : ["reviewPhase", "failedReviewPhase"].includes(key)
        ? reviews
        : key === "syscallFailure"
          ? ["ENOENT", "ESRCH", "EACCES", "EPERM", "OTHER"]
          : undefined
    if (
      allowed
        ? !(allowed as readonly unknown[]).includes(item)
        : bools.includes(key)
          ? typeof item !== "boolean"
          : counts.includes(key)
            ? !Number.isInteger(item) || Number(item) < 0 || Number(item) > 65536
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
