import type { UpdaterState } from "@opencode-ai/app/updater"
import { compareVersion } from "../../../physicalsystems/src/release/inputs"

export type { UpdaterState } from "@opencode-ai/app/updater"

export type UpdaterReadyRecord = { version: string }

export type UpdaterBackend = {
  checkForUpdates(): Promise<{ isUpdateAvailable?: boolean; updateInfo?: { version?: string } } | null | undefined>
  downloadUpdate(progress: (percent: number) => void): Promise<unknown>
  quitAndInstall(): void
}

type UpdaterPersistence = {
  get(): UpdaterReadyRecord | undefined | Promise<UpdaterReadyRecord | undefined>
  set(value: UpdaterReadyRecord): void | Promise<void>
  clear(): void | Promise<void>
}

export function createUpdaterController(input: {
  enabled: boolean
  currentVersion: string
  backend: UpdaterBackend
  persistence: UpdaterPersistence
  install: (launch: () => void) => Promise<void>
  confirmInstall: (version: string) => Promise<boolean>
  log?: (message: string, data?: object) => void
}) {
  let state: UpdaterState = input.enabled ? { status: "idle" } : { status: "disabled" }
  let pending: Promise<UpdaterState> | undefined
  const listeners = new Set<(state: UpdaterState) => void>()

  const transition = (next: UpdaterState) => {
    input.log?.("updater state changed", { from: state.status, to: next.status })
    state = next
    listeners.forEach((listener) => listener(state))
    return state
  }

  const check = () => {
    if (!input.enabled) return Promise.resolve(state)
    if (state.status === "ready" || state.status === "installing") return Promise.resolve(state)
    if (pending) return pending

    pending = (async () => {
      transition({ status: "checking" })
      const result = await input.backend.checkForUpdates()
      const version = result?.updateInfo?.version
      if (!result?.isUpdateAvailable || !version || compareVersion(version, input.currentVersion) <= 0) {
        await input.persistence.clear()
        return transition({ status: "up-to-date" })
      }

      return transition({ status: "available", version })
    })()
      .catch((error) =>
        transition({ status: "error", message: error instanceof Error ? error.message : String(error) }),
      )
      .finally(() => {
        pending = undefined
      })
    return pending
  }

  const download = () => {
    if (pending) return pending
    if (state.status !== "available") return Promise.resolve(state)
    const version = state.version
    transition({ status: "downloading", version })
    pending = (async () => {
      await input.persistence.clear()
      await input.backend.downloadUpdate((percent) => {
        if (state.status !== "downloading" || !Number.isFinite(percent)) return
        transition({ status: "downloading", version, percent: Math.max(0, Math.min(100, percent)) })
      })
      // Backend contract: resolve only after checksum and publisher verification.
      // A persisted version never bypasses that verification on the next launch.
      await input.persistence.set({ version })
      return transition({ status: "ready", version })
    })()
      .catch((error) =>
        transition({ status: "error", message: error instanceof Error ? error.message : String(error) }),
      )
      .finally(() => {
        pending = undefined
      })
    return pending
  }

  return {
    getState: () => state,
    subscribe(listener: (state: UpdaterState) => void) {
      listeners.add(listener)
      listener(state)
      return () => listeners.delete(listener)
    },
    async start() {
      if (!input.enabled) return state
      // Cached version metadata is not authority to download, install or restart.
      await input.persistence.clear()
      return check()
    },
    check,
    download,
    async install() {
      if (state.status !== "ready") throw new Error("Update is not ready to install")
      const version = state.version
      transition({ status: "installing", version })
      try {
        if (!(await input.confirmInstall(version))) {
          transition({ status: "ready", version })
          return
        }
        await input.install(() => input.backend.quitAndInstall())
        // Electron schedules quitting asynchronously; do not allow a second install.
      } catch (error) {
        transition({ status: "ready", version })
        throw error
      }
    },
  }
}

export type UpdaterController = ReturnType<typeof createUpdaterController>
