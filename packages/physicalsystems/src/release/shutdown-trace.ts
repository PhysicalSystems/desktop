// SPDX-License-Identifier: Apache-2.0
import type { ChildProcess } from "node:child_process"

export const shutdownPhases = [
  "OPERATOR_BEFORE",
  "WORKER_CLOSE_BEFORE",
  "WORKER_CLOSE_AFTER",
  "ATTACHMENT_CLEANUP_BEFORE",
  "ATTACHMENT_CLEANUP_AFTER",
  "WORKER_EXIT_BEFORE",
  "WORKER_EXIT_REQUESTED",
  "WORKER_EXIT_AFTER",
  "OPERATOR_AFTER",
  "SERVERS_BEFORE",
  "SERVERS_AFTER",
  "QUIT_FINISH",
  "BLOCKED",
] as const

export const shutdownBlockedReasons = [
  "NONE",
  "OPERATOR_REQUEST_UNCONFIRMED",
  "OPERATOR_SERVICE_UNAVAILABLE",
  "ATTACHMENT_CLEANUP_UNCONFIRMED",
  "PROCESS_EXIT_UNCONFIRMED",
  "UNKNOWN",
] as const

export type ShutdownPhase = (typeof shutdownPhases)[number]
export type ShutdownBlockedReason = (typeof shutdownBlockedReasons)[number]

/** These observations never establish exit or authorize cleanup. Separate bounded
 * line buffers prevent partial/oversized private log lines becoming markers. */
export function observeShutdownTrace(
  child: Pick<ChildProcess, "stdout" | "stderr">,
  now: () => number = () => performance.now(),
) {
  let phase: ShutdownPhase | "NOT_OBSERVED" = "NOT_OBSERVED"
  let elapsedMs: number | null = null
  let receivedAt: number | null = null
  let sincePhase = 0
  let blockedReason: ShutdownBlockedReason = "NONE"
  let blockedAtPhase: Exclude<ShutdownPhase, "BLOCKED"> | null = null
  const timestamp = () => {
    try {
      const value = now()
      return Number.isFinite(value) ? value : null
    } catch {
      return null
    }
  }
  const listeners = [child.stdout, child.stderr].flatMap((stream) => {
    if (!stream) return []
    let pending = ""
    let oversized = false
    const data = (chunk: unknown) => {
      if (typeof chunk !== "string" && !Buffer.isBuffer(chunk)) return
      for (const character of typeof chunk === "string" ? chunk : chunk.toString("utf8")) {
        if (character !== "\n") {
          if (oversized) continue
          if (pending.length >= 192) {
            pending = ""
            oversized = true
          } else pending += character
          continue
        }
        const match = oversized
          ? null
          : /^PHYSICALSYSTEMS_SHUTDOWN_([A-Z_]+) elapsed=(0|[1-9][0-9]{0,6}) reason=([A-Z_]+)\r?$/.exec(pending)
        pending = ""
        oversized = false
        if (!match || !shutdownPhases.includes(match[1] as ShutdownPhase)) continue
        if (!shutdownBlockedReasons.includes(match[3] as ShutdownBlockedReason)) continue
        if ((match[1] === "BLOCKED") === (match[3] === "NONE")) continue
        const elapsed = Number(match[2])
        if (elapsed > 3_600_000 || (elapsedMs !== null && elapsed < elapsedMs)) continue
        blockedAtPhase =
          match[1] !== "BLOCKED" ? null : phase !== "BLOCKED" && phase !== "NOT_OBSERVED" ? phase : blockedAtPhase
        phase = match[1] as ShutdownPhase
        elapsedMs = elapsed
        receivedAt = timestamp()
        sincePhase = 0
        blockedReason = match[3] as ShutdownBlockedReason
      }
    }
    stream.on("data", data)
    return [
      {
        stream,
        data,
        clear: () => {
          pending = ""
        },
      },
    ]
  })
  return {
    snapshot() {
      const time = timestamp()
      if (receivedAt !== null && time !== null)
        sincePhase = Math.min(3_600_000, Math.max(sincePhase, Math.trunc(time - receivedAt)))
      return Object.freeze({
        phase,
        elapsedMs,
        sincePhaseMs: receivedAt === null || time === null ? null : sincePhase,
        blockedReason,
        blockedAtPhase,
      })
    },
    close() {
      for (const listener of listeners) {
        listener.stream.off("data", listener.data)
        listener.clear()
      }
    },
  }
}
