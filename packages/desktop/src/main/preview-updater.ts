import { app, dialog } from "electron"
import Store from "electron-store"
import { join } from "node:path"
import { compareVersion } from "../../../physicalsystems/src/release/inputs"
import { checkDesktopUpdate } from "./desktop-update-discovery"
import { createPreviewUpdateController, type PreviewUpdateAttempt } from "./preview-update-controller"
import { downloadPreviewUpdate, reverifyPreviewUpdate } from "./preview-update-download"
import {
  inspectPreviewUpdateInstallation,
  installPreviewUpdate,
  PreviewUpdateInstallError,
} from "./preview-update-install"
import { nativeT } from "./native-translations"
import { setAppQuitting } from "./windows"
import { inspectPreviewUpdateRecovery } from "./preview-update-recovery"

type Identity = { kind: string; appId: string; productName: string }
export function previewUpdaterEligible(input: {
  packaged: boolean
  platform: string
  arch: string
  currentVersion: string
  identity: Identity
}) {
  if (
    !input.packaged ||
    !["win32", "linux"].includes(input.platform) ||
    input.arch !== "x64" ||
    input.identity.kind !== "public" ||
    input.identity.appId !== "systems.physical.desktop" ||
    input.identity.productName !== "Physical Systems" ||
    !input.currentVersion.includes("-beta.")
  )
    return false
  try {
    return compareVersion(input.currentVersion, "0.1.0-beta.1") >= 0
  } catch {
    return false
  }
}

export function setupPreviewUpdater(input: {
  identity: Identity
  shutdown(launch: () => Promise<void>): Promise<void>
  resume(): void
}) {
  const environment = {
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    currentVersion: app.getVersion(),
    identity: input.identity,
  }
  const installation = {
    platform: process.platform,
    arch: process.arch,
    executablePath: process.execPath,
    currentVersion: app.getVersion(),
  }
  // Renderer stores are confined to flat names in userData. Keeping this record
  // below a separate directory also excludes Windows short-name aliases.
  // A damaged JSON file must block updates through journal.get(), not abort
  // application startup before the controller can expose recovery information.
  let journalStore: Store | undefined
  const store = () =>
    (journalStore ??= new Store({
      cwd: join(app.getPath("userData"), "main"),
      name: "preview-update",
      fileExtension: "",
      accessPropertiesByDotNotation: false,
    }))
  const key = "attempt"
  return createPreviewUpdateController({
    enabled: previewUpdaterEligible(environment),
    platform: process.platform === "win32" ? "win32" : "linux",
    currentVersion: environment.currentVersion,
    supported: async () => Boolean(await inspectPreviewUpdateInstallation(installation)),
    discover: () => checkDesktopUpdate(environment),
    download: (asset, onProgress) =>
      downloadPreviewUpdate({
        asset,
        onProgress,
        directory: join(app.getPath("userData"), "preview-updates"),
      }),
    verify: reverifyPreviewUpdate,
    async confirm(version) {
      const response = await dialog.showMessageBox({
        type: "question",
        title: nativeT("desktop.updater.dialog.ready.title"),
        message: nativeT("desktop.updater.preview.confirm", { version }),
        detail: nativeT(
          process.platform === "win32" ? "desktop.updater.preview.windows" : "desktop.updater.preview.linux",
        ),
        buttons: [nativeT("desktop.updater.preview.install"), nativeT("desktop.updater.dialog.later")],
        defaultId: 1,
        cancelId: 1,
      })
      return response.response === 0
    },
    shutdown: input.shutdown,
    recover: (attempt) => inspectPreviewUpdateRecovery({ ...installation, attempt }),
    resume: input.resume,
    async install(installerPath, expectedVersion, asset) {
      await installPreviewUpdate({
        ...installation,
        installerPath,
        expectedVersion,
        verifyInstaller: () => reverifyPreviewUpdate(installerPath, asset),
      })
    },
    finish() {
      // Windows NSIS owns reopen-after-install. Debian has already confirmed
      // successful installation; relaunch only after the handoff is reserved.
      setImmediate(() => {
        setAppQuitting(true)
        if (process.platform === "linux") app.relaunch()
        app.quit()
      })
    },
    journal: {
      get() {
        const value = store().get(key)
        if (value === undefined) return
        if (
          !value ||
          typeof value !== "object" ||
          !("from" in value) ||
          !("to" in value) ||
          !("sha256" in value) ||
          typeof value.from !== "string" ||
          typeof value.to !== "string" ||
          typeof value.sha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(value.sha256) ||
          compareVersion(value.to, value.from) <= 0
        )
          throw new Error("INVALID_UPDATE_ATTEMPT")
        return { from: value.from, to: value.to, sha256: value.sha256 } satisfies PreviewUpdateAttempt
      },
      set: (value) => {
        store().set(key, value)
      },
      clear: () => {
        store().delete(key)
      },
    },
    message: (code) => nativeT(`desktop.updater.preview.${code}`),
    uncertain: (error) => error instanceof PreviewUpdateInstallError && error.installationUncertain,
  })
}
