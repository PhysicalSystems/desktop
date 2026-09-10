import { app, dialog } from "electron"
import pkg from "electron-updater"
import { UPDATER_ENABLED } from "./constants"
import { createUpdaterController, type UpdaterReadyRecord } from "./updater-controller"
import { getLogger } from "./logging"
import { getStore } from "./store"
import { setAppQuitting } from "./windows"
import { nativeT } from "./native-translations"
import { launchUpdaterInstaller } from "./updater-install"

const { autoUpdater } = pkg
const key = "ready"

export function setupAutoUpdater(install: (launch: () => void) => Promise<void>) {
  const logger = getLogger()
  autoUpdater.logger = logger
  autoUpdater.channel = "latest"
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  logger.log("auto updater configured", {
    channel: autoUpdater.channel,
    allowPrerelease: autoUpdater.allowPrerelease,
    allowDowngrade: autoUpdater.allowDowngrade,
    currentVersion: app.getVersion(),
  })

  const store = getStore("opencode.updater")
  return createUpdaterController({
    enabled: UPDATER_ENABLED,
    currentVersion: app.getVersion(),
    backend: {
      checkForUpdates: () => autoUpdater.checkForUpdates(),
      downloadUpdate: (progress) => {
        const listener = (info: { percent: number }) => progress(info.percent)
        autoUpdater.on("download-progress", listener)
        return autoUpdater.downloadUpdate().finally(() => autoUpdater.removeListener("download-progress", listener))
      },
      quitAndInstall: () => launchUpdaterInstaller(autoUpdater, setAppQuitting),
    },
    persistence: {
      get() {
        const value = store.get(key)
        if (!value || typeof value !== "object" || !("version" in value) || typeof value.version !== "string") return
        return { version: value.version } satisfies UpdaterReadyRecord
      },
      set: (value) => store.set(key, value),
      clear: () => store.delete(key),
    },
    install,
    async confirmInstall(version) {
      const response = await dialog.showMessageBox({
        type: "question",
        title: nativeT("desktop.updater.dialog.ready.title"),
        message: nativeT("desktop.updater.dialog.ready.message", { version }),
        detail: nativeT("desktop.updater.dialog.restart.detail"),
        buttons: [nativeT("desktop.updater.dialog.restart"), nativeT("desktop.updater.dialog.later")],
        defaultId: 1,
        cancelId: 1,
      })
      return response.response === 0
    },
    log: (message, data) => logger.log(message, data),
  })
}

export async function showUpdaterDialog(controller: ReturnType<typeof setupAutoUpdater>, alertOnFail: boolean) {
  const state = await controller.check()
  if (state.status === "error") {
    if (!alertOnFail) return
    await dialog.showMessageBox({
      type: "error",
      message: nativeT("desktop.updater.dialog.checkFailed.message"),
      title: nativeT("desktop.updater.dialog.checkFailed.title"),
    })
    return
  }
  if (state.status === "up-to-date") {
    if (!alertOnFail) return
    await dialog.showMessageBox({
      type: "info",
      message: nativeT("desktop.updater.dialog.upToDate.message"),
      title: nativeT("desktop.updater.dialog.upToDate.title"),
    })
    return
  }
  if (state.status === "available") {
    const response = await dialog.showMessageBox({
      type: "info",
      title: nativeT("desktop.updater.dialog.available.title"),
      message: nativeT("desktop.updater.dialog.available.message", { version: state.version }),
      buttons: [nativeT("desktop.updater.dialog.download"), nativeT("desktop.updater.dialog.later")],
      defaultId: 1,
      cancelId: 1,
    })
    if (response.response !== 0) return
    const downloaded = await controller.download()
    if (downloaded.status === "error")
      await dialog.showMessageBox({
        type: "error",
        title: nativeT("desktop.updater.dialog.checkFailed.title"),
        message: nativeT("desktop.updater.dialog.downloadFailed.message"),
      })
    return
  }
  if (state.status !== "ready") return
  await controller.install().catch(async () => {
    await dialog.showMessageBox({
      type: "error",
      title: nativeT("desktop.updater.dialog.checkFailed.title"),
      message: nativeT("desktop.updater.dialog.installFailed.message"),
    })
  })
}
