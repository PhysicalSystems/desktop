// SPDX-License-Identifier: Apache-2.0
import { writeSync } from "node:fs"
import { startupPhases } from "../../../physicalsystems/src/release/startup-phases"

export { startupPhases }

/** Optional CI checkpoints contain only fixed literals. Synchronous writes keep
 * an earlier marker observable if the following native call blocks startup. */
export function startupTrace(
  phase: (typeof startupPhases)[number],
  io: { env?: NodeJS.ProcessEnv; write?: (fd: number, message: string) => unknown } = {},
) {
  try {
    if ((io.env ?? process.env).PHYSICALSYSTEMS_QUALIFICATION_TRACE !== "1" || !startupPhases.includes(phase)) return
    ;(io.write ?? writeSync)(2, `PHYSICALSYSTEMS_STARTUP_${phase}\n`)
  } catch {
    // Diagnostics must never alter startup when stderr is absent or unwritable.
  }
}
