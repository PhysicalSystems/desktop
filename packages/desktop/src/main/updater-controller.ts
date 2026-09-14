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

type Blocked = Extract<UpdaterState, { status: "blocked" }>
export type UpdaterFailure = {
  state: Extract<UpdaterState, { status: "error" | "blocked" | "ready" }>
  message: string
}
export type UpdaterOperations = {
  start?(): void | Promise<void>
  check(): Promise<Extract<UpdaterState, { status: "available" | "up-to-date" | "disabled" | "blocked" | "error" }>>
  download(version: string, progress: (percent: number) => void): Promise<void | UpdaterFailure>
  confirmInstall(version: string): Promise<boolean>
  install(version: string): Promise<void | UpdaterFailure>
  failure(error: unknown, operation: "check" | "download" | "install", version?: string): UpdaterFailure
  recovery?: {
    inspect(): Promise<{ status: "installed" | "not-installed" } | { status: "uncertain"; message?: string }>
    finish(): Promise<void>
  }
}

type NativeInput = {
  currentVersion: string
  backend: UpdaterBackend
  persistence: UpdaterPersistence
  install: (launch: () => void) => Promise<void>
  confirmInstall: (version: string) => Promise<boolean>
}

export function createUpdaterController(input: {
  enabled: boolean
  mode?: "preview"
  log?: (message: string, data?: object) => void
  operations: UpdaterOperations
}) {
  const operations = input.operations
  const decorate = (value: UpdaterState): UpdaterState =>
    input.mode && value.status !== "disabled" ? { ...value, mode: input.mode } : value
  let state = decorate(input.enabled ? { status: "idle" } : { status: "disabled" })
  let pending: Promise<UpdaterState> | undefined
  let installing: Promise<void> | undefined
  let started: Promise<UpdaterState> | undefined
  let initialized = false
  const listeners = new Set<(state: UpdaterState) => void>()
  const transition = (next: UpdaterState) => {
    input.log?.("updater state changed", { from: state.status, to: next.status })
    state = decorate(next)
    listeners.forEach((listener) => listener(state))
    return state
  }
  const check = (): Promise<UpdaterState> => {
    // Native confirmation must remain observable while install awaits its
    // response. Reporting this state does not start another update operation.
    if (state.status === "installing") return Promise.resolve(state)
    if (pending) return pending
    if (!input.enabled || ["disabled", "ready", "blocked"].includes(state.status)) return Promise.resolve(state)
    transition({ status: "checking" })
    pending = (async () => {
      if (!initialized) {
        if (operations.start) await operations.start()
        initialized = true
      }
      return transition(await operations.check())
    })()
      .catch((error) => transition(operations.failure(error, "check").state))
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
      return () => {
        listeners.delete(listener)
      }
    },
    start() {
      return (started ??= check())
    },
    check,
    download(): Promise<UpdaterState> {
      if (pending) return pending
      if (state.status !== "available") return Promise.resolve(state)
      const version = state.version
      transition({ status: "downloading", version })
      pending = (async () => {
        const result = await operations.download(version, (percent) => {
          if (state.status !== "downloading" || !Number.isFinite(percent)) return
          transition({ status: "downloading", version, percent: Math.max(0, Math.min(100, percent)) })
        })
        return transition(result?.state ?? { status: "ready", version })
      })()
        .catch((error) => transition(operations.failure(error, "download", version).state))
        .finally(() => {
          pending = undefined
        })
      return pending
    },
    install(): Promise<void> {
      if (installing) return installing
      if (pending || state.status !== "ready") return Promise.reject(new Error("Update is not ready to install"))
      const version = state.version
      let failure: UpdaterFailure | undefined
      transition({ status: "installing", version })
      // Download/recovery callers wait for confirmation and shutdown. Check can
      // observe installing; the void promise preserves the install rejection.
      pending = (async () => {
        if (!(await operations.confirmInstall(version))) return transition({ status: "ready", version })
        failure = (await operations.install(version)) ?? undefined
        return failure ? transition(failure.state) : state
      })()
        .catch((error) => {
          failure = operations.failure(error, "install", version)
          return transition(failure.state)
        })
        .finally(() => {
          pending = undefined
        })
      installing = pending
        .then(() => {
          if (failure) throw new Error(failure.message)
        })
        .finally(() => {
          installing = undefined
        })
      return installing
    },
    recover(): Promise<UpdaterState> {
      if (pending) return pending
      const recovery = operations.recovery
      if (state.status !== "blocked" || !state.recoverable || !recovery) return Promise.resolve(state)
      const blocked: Blocked = state
      transition({ status: "checking" })
      pending = (async () => {
        const result = await recovery.inspect()
        if (result.status === "uncertain") return transition({ ...blocked, message: result.message ?? blocked.message })
        if (result.status === "not-installed") return transition({ status: "idle" })
        transition({ status: "installing", version: blocked.version })
        await recovery.finish()
        return state
      })()
        .catch(() => transition(blocked))
        .then((next) => {
          // A proven cancellation allows discovery, never another installation.
          if (next.status !== "idle") return next
          transition({ status: "checking" })
          return operations
            .check()
            .then(transition)
            .catch((error) => transition(operations.failure(error, "check").state))
        })
        .finally(() => {
          pending = undefined
        })
      return pending
    },
  }
}

export function createNativeUpdaterOperations(input: NativeInput): UpdaterOperations {
  return {
    start: () => input.persistence.clear(),
    async check() {
      const result = await input.backend.checkForUpdates()
      const version = result?.updateInfo?.version
      if (!result?.isUpdateAvailable || !version || compareVersion(version, input.currentVersion) <= 0) {
        await input.persistence.clear()
        return { status: "up-to-date" }
      }
      return { status: "available", version }
    },
    async download(version, progress) {
      await input.persistence.clear()
      await input.backend.downloadUpdate(progress)
      // The backend resolves only after checksum and publisher verification.
      // Persisted metadata never authorizes installation on a subsequent launch.
      await input.persistence.set({ version })
    },
    confirmInstall: input.confirmInstall,
    install: () => input.install(() => input.backend.quitAndInstall()),
    failure(error, operation, version) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        state: operation === "install" && version ? { status: "ready", version } : { status: "error", message },
        message,
      }
    },
  }
}

export type UpdaterController = ReturnType<typeof createUpdaterController>
