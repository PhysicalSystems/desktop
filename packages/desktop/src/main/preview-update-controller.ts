import type { DesktopUpdateDiscoveryResult } from "./desktop-update-discovery"
import type { PreviewUpdateAsset } from "./preview-update-download"
import { compareVersion } from "../../../physicalsystems/src/release/inputs"
import { createUpdaterController, type UpdaterFailure } from "./updater-controller"

type Available = Extract<DesktopUpdateDiscoveryResult, { status: "available" }>
export type PreviewUpdateAttempt = { from: string; to: string; sha256: string }

/** Physical Systems release and journal policy; the shared updater owns state,
 * subscriptions and serialization for both native and preview operations. */
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
  let selected: Available | undefined
  let downloaded: { file: string; asset: PreviewUpdateAsset; version: string } | undefined
  let recoveryChecked = false
  const failure = (code: Parameters<typeof input.message>[0]): UpdaterFailure => ({
    state: { status: "error", message: input.message(code) },
    message: input.message(code),
  })
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

  return createUpdaterController({
    enabled: input.enabled,
    mode: "preview",
    operations: {
      async check() {
        if (!recoveryChecked) {
          try {
            const previous = input.journal.get()
            if (previous && (compareVersion(input.currentVersion, previous.to) < 0 || !(await input.supported())))
              return { status: "blocked", version: previous.to, message: input.message("pending"), recoverable: true }
            if (previous) input.journal.clear()
            recoveryChecked = true
          } catch {
            return { status: "blocked", version: input.currentVersion, message: input.message("pending") }
          }
        }
        if (!(await input.supported())) return { status: "disabled" }
        const result = await input.discover()
        selected = undefined
        if (result.status === "up-to-date") return { status: "up-to-date" }
        if (
          result.status !== "available" ||
          result.channel !== "preview" ||
          !result.unsignedWindowsPreview ||
          !asset(result)
        )
          return { status: "error", message: input.message("checkFailed") }
        selected = result
        return { status: "available", version: result.version }
      },
      async download(_version, progress) {
        const release = selected!
        const target = asset(release)!
        downloaded = undefined
        progress(0)
        if (!matches(release, await input.discover())) return failure("changed")
        const file = await input.download(target, progress)
        downloaded = { file, asset: target, version: release.version }
      },
      confirmInstall: input.confirm,
      async install() {
        const ready = downloaded!
        const release = selected!
        if (!matches(release, await input.discover())) return failure("changed")
        await input.verify(ready.file, ready.asset)
        if (!(await input.supported())) return failure("shutdown")
        let failed: UpdaterFailure | undefined
        try {
          await input.shutdown(async () => {
            // Cleanup can take time. Rehash immediately before native handoff.
            await input.verify(ready.file, ready.asset)
            input.journal.set({ from: input.currentVersion, to: ready.version, sha256: ready.asset.sha256 })
            try {
              await input.install(ready.file, ready.version, ready.asset)
            } catch (cause) {
              if (input.uncertain(cause)) {
                failed = {
                  state: {
                    status: "blocked",
                    version: ready.version,
                    message: input.message("uncertain"),
                    recoverable: true,
                  },
                  message: input.message("uncertain"),
                }
              } else {
                input.journal.clear()
                failed = failure("failed")
              }
              // Preserve the native cause for the owned-shutdown uncertainty gate.
              throw cause
            }
          })
          input.finish()
        } catch (cause) {
          if (failed) return failed
          throw cause
        }
      },
      failure(_error, operation) {
        return failure(operation === "check" ? "checkFailed" : operation === "download" ? "failed" : "shutdown")
      },
      recovery: {
        async inspect() {
          const attempt = input.journal.get()
          if (!attempt) return { status: "uncertain" }
          const result = await input.recover(attempt)
          if (result.status === "uncertain") return { status: "uncertain", message: input.message("pending") }
          input.resume()
          if (result.status === "not-installed") {
            input.journal.clear()
            recoveryChecked = true
            downloaded = undefined
            selected = undefined
          }
          return result
        },
        async finish() {
          await input.shutdown(async () => {})
          input.finish()
        },
      },
    },
  })
}
