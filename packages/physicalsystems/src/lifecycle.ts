// SPDX-License-Identifier: Apache-2.0
export type ShutdownIntent = "quit" | "relaunch"

/** Preserve the operator window until both owned services confirm cleanup. */
export function createShutdownCoordinator(options: {
  closeOperator(): Promise<unknown>
  stopServers(): Promise<unknown>
  finish(intent: ShutdownIntent): void
  blocked(error: unknown): void
}) {
  let preparing: Promise<boolean> | undefined
  let prepared = false
  let pending: Promise<boolean> | undefined
  let requesting = false
  let complete = false
  let relaunch = false
  let updating = false
  let updateScheduled = false

  // The installer schedules exit itself, after the same cleanup used by quit.
  function prepare(): Promise<boolean> {
    if (prepared) return Promise.resolve(true)
    if (preparing) return preparing
    preparing = (async () => {
      try {
        await options.closeOperator()
        await options.stopServers()
        prepared = true
        return true
      } catch (error) {
        options.blocked(error)
        return false
      }
    })().finally(() => { preparing = undefined })
    return preparing
  }

  return {
    prepare,
    update(launch: () => void): Promise<boolean> {
      // A regular shutdown cannot become an installer handoff midway through.
      if (requesting || complete || updating || updateScheduled) return Promise.resolve(false)
      updating = true
      return (async () => {
        try {
          if (!await prepare()) return false
          launch()
          updateScheduled = true
          return true
        } catch (error) {
          options.blocked(error)
          return false
        } finally {
          updating = false
        }
      })()
    },
    request(intent: ShutdownIntent): Promise<boolean> {
      if (complete) return Promise.resolve(true)
      // During cleanup/launch the installer owns exit. After synchronous launch,
      // permit its deferred quit, but never schedule a competing old-app relaunch.
      if (updating || (updateScheduled && intent === "relaunch")) return Promise.resolve(false)
      if (intent === "relaunch") relaunch = true
      if (pending) return pending
      if (requesting) return Promise.resolve(false)
      requesting = true
      pending = (async () => {
        try {
          if (!await prepare()) return false
          complete = true
          options.finish(relaunch ? "relaunch" : "quit")
          return true
        } catch (error) {
          options.blocked(error)
          return false
        } finally {
          pending = undefined
          requesting = false
          if (!complete) relaunch = false
        }
      })()
      return pending
    },
  }
}

/** A timeout leaves the original work intact so an explicit retry can observe it. */
export function waitForShutdownStep(work: Promise<unknown>, timeoutMs: number, errorCode: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(errorCode)), timeoutMs)
    work.then(() => { clearTimeout(timer); resolve() }, (error) => { clearTimeout(timer); reject(error) })
  })
}

/** An acknowledgement or a sent signal is not confirmation of process exit. */
export function waitForProcessExit(exit: Promise<unknown>, timeoutMs: number): Promise<void> {
  return waitForShutdownStep(exit, timeoutMs, "PROCESS_EXIT_UNCONFIRMED")
}

/** Terminate only after owned service and credential cleanup has completed.
 * A stop result, including false during an exit race, never replaces exit proof. */
export async function closeOwnedProcess(options: {
  cleanup(): Promise<unknown>
  exited(): boolean
  requestStop(): boolean
  exit: Promise<unknown>
  timeoutMs: number
}): Promise<void> {
  await options.cleanup()
  if (!options.exited()) options.requestStop()
  await waitForProcessExit(options.exit, options.timeoutMs)
}

/** Available from fork time, even if the model server never becomes ready. */
export function createProcessStopper(options: {
  exit: Promise<unknown>
  exited(): boolean
  requestStop(): void
  forceStop(): void
  graceMs: number
  forcedMs: number
}) {
  let stopping: Promise<void> | undefined
  return {
    stop(): Promise<void> {
      if (stopping) return stopping
      if (options.exited()) return Promise.resolve()
      options.requestStop()
      stopping = (async () => {
        try { await waitForProcessExit(options.exit, options.graceMs) }
        catch {
          // For the owned model server only, after operator cleanup confirms.
          if (!options.exited()) options.forceStop()
          await waitForProcessExit(options.exit, options.forcedMs)
        }
      })().catch((error) => { stopping = undefined; throw error })
      return stopping
    },
  }
}
