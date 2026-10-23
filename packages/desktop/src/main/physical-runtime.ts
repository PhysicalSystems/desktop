import { join } from "node:path"
import { app } from "electron"
import { createPhysicalHost } from "./physical"
import { registerPhysicalIpc } from "./physical-ipc"
import { setupPreviewUpdater } from "./preview-updater"
import { PHYSICAL_IDENTITY } from "./constants"
import type { createShutdownCoordinator } from "../../../physicalsystems/src/lifecycle"

let runtime: ReturnType<typeof createPhysicalHost> | undefined
let stopping = false
let stopServer: (() => Promise<void>) | undefined
export function physicalRuntime() {
  if (stopping) throw new Error("APPLICATION_CLOSING")
  return runtime ??= createPhysicalHost(join(process.env.PHYSICALSYSTEMS_DATA_DIR!, "operator"))
}
export function ownPhysicalServer(stop: () => Promise<void>) { stopServer = stop }
export async function closePhysicalOperator() {
  stopping = true
  try { await (await runtime)?.close() } catch (error) { stopping = false; throw error }
}
export async function stopPhysicalServer() { await stopServer?.() }
export function installPhysicalBridge(physical: Awaited<ReturnType<typeof createPhysicalHost>>, shutdown: ReturnType<typeof createShutdownCoordinator>) {
  const updater = setupPreviewUpdater({
    identity: PHYSICAL_IDENTITY,
    async shutdown(launch) { if (!await shutdown.update(launch)) throw new Error("UPDATE_SHUTDOWN_UNCONFIRMED") },
    resume() { if (!shutdown.clearUpdateUncertainty()) throw new Error("UPDATE_HANDOFF_ACTIVE") },
  })
  registerPhysicalIpc({ physical, updater })
  void updater.start()
  const timer = setInterval(() => void updater.check(), 10 * 60 * 1000)
  timer.unref()
  app.once("will-quit", () => clearInterval(timer))
}
