// SPDX-License-Identifier: Apache-2.0
import { writeSync } from "node:fs"
import { shutdownBlockedReasons, shutdownPhases } from "../../../physicalsystems/src/release/shutdown-trace"
import type { ShutdownPhase } from "../../../physicalsystems/src/release/shutdown-trace"

/** Synchronous, opt-in markers survive a following blocked shutdown operation.
 * Clock/write failures and arbitrary error data cannot change shutdown behavior. */
export function createShutdownTrace(
  io: {
    env?: NodeJS.ProcessEnv
    write?: (fd: number, message: string) => unknown
    now?: () => number
  } = {},
) {
  let started: number | undefined
  let elapsed = 0
  return (phase: ShutdownPhase, error?: unknown) => {
    try {
      if ((io.env ?? process.env).PHYSICALSYSTEMS_QUALIFICATION_TRACE !== "1" || !shutdownPhases.includes(phase)) return
      const time = (io.now ?? (() => performance.now()))()
      if (!Number.isFinite(time)) return
      started ??= time
      elapsed = Math.min(3_600_000, Math.max(elapsed, Math.trunc(time - started)))
      let message: unknown
      try {
        if (phase === "BLOCKED" && error instanceof Error) message = error.message
      } catch {}
      const reason =
        phase !== "BLOCKED"
          ? "NONE"
          : (shutdownBlockedReasons.find((value) => value !== "NONE" && value === message) ?? "UNKNOWN")
      ;(io.write ?? writeSync)(2, `PHYSICALSYSTEMS_SHUTDOWN_${phase} elapsed=${elapsed} reason=${reason}\n`)
    } catch {
      // Optional diagnostic output must never interrupt or unblock shutdown.
    }
  }
}

export const shutdownTrace = createShutdownTrace()
