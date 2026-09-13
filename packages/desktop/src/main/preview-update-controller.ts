import type { UpdaterState } from "@opencode-ai/app/updater"
import type { DesktopUpdateDiscoveryResult } from "./desktop-update-discovery"
import type { PreviewUpdateAsset } from "./preview-update-download"
import { compareVersion } from "../../../physicalsystems/src/release/inputs"

type Available = Extract<DesktopUpdateDiscoveryResult, { status: "available" }>
export type PreviewUpdateAttempt = { from: string; to: string; sha256: string }

/** Preview installation is explicit. HTTPS release metadata and the complete
 * installer hash are checked independently of OS elevation or code signing.
 * A journal records an attempted handoff; it never authorizes another install.
 */
export function createPreviewUpdateController(input: {
  enabled: boolean
  platform: "win32" | "linux"
  currentVersion: string
  supported(): Promise<boolean>
  discover(): Promise<DesktopUpdateDiscoveryResult>
  download(asset: PreviewUpdateAsset, progress: (percent: number) => void): Promise<string>
  verify(file: string, asset: PreviewUpdateAsset): Promise<void>
  confirm(version: string): Promise<boolean>
  shutdown(install: () => Promise<void>): Promise<void>
  install(file: string, version: string, asset: PreviewUpdateAsset): Promise<void>
  finish(): void
  recover(attempt: PreviewUpdateAttempt): Promise<{ status: "installed" | "not-installed" | "uncertain" }>
  resume(): void
  journal: {
    get(): PreviewUpdateAttempt | undefined
    set(attempt: PreviewUpdateAttempt): void
    clear(): void
  }
  message(code: "checkFailed" | "changed" | "failed" | "pending" | "uncertain" | "shutdown"): string
  uncertain(error: unknown): boolean
}) {
  let state: UpdaterState = input.enabled ? { status: "idle", mode: "preview" } : { status: "disabled" }
  let pending: Promise<UpdaterState> | undefined
  let installing: Promise<void> | undefined
  let selected: Available | undefined
  let downloaded: { file: string; asset: PreviewUpdateAsset; version: string } | undefined
  let started: Promise<UpdaterState> | undefined
  let recoveryChecked = false
  let recovering: Promise<UpdaterState> | undefined
  const listeners = new Set<(state: UpdaterState) => void>()
  const transition = (value: UpdaterState) => {
    state = value.status === "disabled" ? value : { ...value, mode: "preview" }
    listeners.forEach((listener) => listener(state))
    return state
  }
  const error = (code: Parameters<typeof input.message>[0]) =>
    transition({ status: "error", message: input.message(code) })
  const matches = (left: Available, right: DesktopUpdateDiscoveryResult) =>
    right.status === "available" &&
    right.channel === "preview" &&
    right.unsignedWindowsPreview &&
    right.version === left.version &&
    JSON.stringify(right.assets) === JSON.stringify(left.assets)
  const asset = (release: Available) =>
    release.assets.find((item) =>
      item.name.endsWith(input.platform === "win32" ? "-windows-x64.exe" : "-linux-x64.deb"),
    )

  const check = (): Promise<UpdaterState> => {
    if (recovering) return recovering
    if (!input.enabled || ["disabled", "ready", "installing", "blocked"].includes(state.status))
      return Promise.resolve(state)
    if (pending) return pending
    pending = (async () => {
      transition({ status: "checking" })
      if (!recoveryChecked) {
        try {
          const previous = input.journal.get()
          if (previous && (compareVersion(input.currentVersion, previous.to) < 0 || !(await input.supported())))
            return transition({
              status: "blocked",
              version: previous.to,
              message: input.message("pending"),
              recoverable: true,
            })
          if (previous) input.journal.clear()
          recoveryChecked = true
        } catch {
          return transition({ status: "blocked", version: input.currentVersion, message: input.message("pending") })
        }
      }
      if (!(await input.supported())) return transition({ status: "disabled" })
      const result = await input.discover()
      selected = undefined
      if (result.status === "up-to-date") return transition({ status: "up-to-date" })
      // This explicitly reviewed path covers unsigned previews only. Signed
      // stable update activation retains its independent qualification policy.
      if (
        result.status !== "available" ||
        result.channel !== "preview" ||
        !result.unsignedWindowsPreview ||
        !asset(result)
      )
        return error("checkFailed")
      selected = result
      return transition({ status: "available", version: result.version })
    })()
      .catch(() => error("checkFailed"))
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
    start(): Promise<UpdaterState> {
      if (started) return started
      started = check()
      return started
    },
    check,
    recover(): Promise<UpdaterState> {
      if (recovering) return recovering
      if (state.status !== "blocked" || !state.recoverable || installing) return Promise.resolve(state)
      const blocked = state
      transition({ status: "checking" })
      recovering = (async () => {
        const attempt = input.journal.get()
        if (!attempt) return transition(blocked)
        const result = await input.recover(attempt)
        if (result.status === "uncertain") return transition({ ...blocked, message: input.message("pending") })
        input.resume()
        if (result.status === "installed") {
          transition({ status: "installing", version: attempt.to })
          await input.shutdown(async () => {})
          input.finish()
          return state
        }
        input.journal.clear()
        recoveryChecked = true
        downloaded = undefined
        selected = undefined
        return transition({ status: "idle" })
      })()
        .catch(() => transition(blocked))
        .finally(() => {
          recovering = undefined
        })
      return recovering.then((next) => (next.status === "idle" ? check() : next))
    },
    download(): Promise<UpdaterState> {
      if (pending) return pending
      if (state.status !== "available" || !selected) return Promise.resolve(state)
      const release = selected
      const target = asset(release)!
      downloaded = undefined
      transition({ status: "downloading", version: release.version, percent: 0 })
      pending = (async () => {
        if (!matches(release, await input.discover())) return error("changed")
        const file = await input.download(target, (percent) => {
          if (state.status === "downloading" && Number.isFinite(percent))
            transition({
              status: "downloading",
              version: release.version,
              percent: Math.max(0, Math.min(100, percent)),
            })
        })
        downloaded = { file, asset: target, version: release.version }
        return transition({ status: "ready", version: release.version })
      })()
        .catch(() => error("failed"))
        .finally(() => {
          pending = undefined
        })
      return pending
    },
    install(): Promise<void> {
      if (installing) return installing
      if (state.status !== "ready" || !downloaded || !selected)
        return Promise.reject(new Error(input.message("failed")))
      const ready = downloaded
      const release = selected
      transition({ status: "installing", version: ready.version })
      installing = (async () => {
        if (!(await input.confirm(ready.version))) {
          transition({ status: "ready", version: ready.version })
          return
        }
        if (!matches(release, await input.discover())) {
          error("changed")
          throw new Error(input.message("changed"))
        }
        await input.verify(ready.file, ready.asset)
        if (!(await input.supported())) throw new Error(input.message("failed"))
        await input.shutdown(async () => {
          // Cleanup can take time. Rehash again immediately before handoff.
          await input.verify(ready.file, ready.asset)
          input.journal.set({ from: input.currentVersion, to: ready.version, sha256: ready.asset.sha256 })
          try {
            await input.install(ready.file, ready.version, ready.asset)
          } catch (cause) {
            if (input.uncertain(cause)) {
              transition({
                status: "blocked",
                version: ready.version,
                message: input.message("uncertain"),
                recoverable: true,
              })
            } else {
              input.journal.clear()
              error("failed")
            }
            throw cause
          }
        })
        // No installer is relaunched on startup or from stored metadata. A new
        // application must acknowledge its actual compiled version at start.
        input.finish()
      })()
        .catch((cause) => {
          if (state.status === "blocked") throw new Error(state.message)
          if (state.status !== "error") error("shutdown")
          throw new Error(state.status === "error" ? state.message : input.message("failed"))
        })
        .finally(() => {
          installing = undefined
        })
      return installing
    },
  }
}
