import { createSignal, onCleanup } from "solid-js"
import type { UpdaterState } from "@opencode/app/updater"
import type { Platform } from "@opencode/app/desktop"
import type { ElectronAPI } from "../api-types"
import { setPinchZoomEnabled, webviewZoom } from "../window/zoom"
import { windowFullscreen } from "../window/fullscreen"
import { DragCancelEvent } from "../../shared/ipc-transport"
import { createExtensionBridge } from "../extensions"
import { createDesktopFiles } from "./files"
import { createDesktopMenuAction } from "./menu"
import { createDesktopNotify } from "./notifications"
import { createDesktopStorage } from "./storage"

export type DesktopWindowState = {
  id: string
  version: string
}

export function createDesktopPlatform(api: ElectronAPI, windowState: DesktopWindowState): Platform {
  const os = desktopOS()
  const [updaterState, setUpdaterState] = createSignal<UpdaterState>({ status: "disabled" })
  const subscription = api.awaitInitialization().then(() => window.electron.updater.subscribe(setUpdaterState)).catch(() => () => {})
  onCleanup(() => { void subscription.then((unsubscribe) => unsubscribe()) })

  return {
    platform: "desktop",
    updater: { ...window.electron.updater, state: updaterState },
    os,
    version: windowState.version,
    windowID: windowState.id,
    ...createDesktopFiles(api, os),
    ...createDesktopStorage(api),
    exportDebugLogs: () => api.exportDebugLogs(),
    setForceFocus: (enabled) => api.setForceFocus(enabled),
    recordFatalRendererError: (error) => api.recordFatalRendererError(error),
    restart: async () => api.relaunch(),
    notify: createDesktopNotify(api),
    fetch: (input, init) => {
      if (input instanceof Request) return fetch(input)

      return fetch(input, init)
    },
    webviewZoom,
    windowFullscreen,
    getPinchZoomEnabled: () => api.getPinchZoomEnabled(),
    setPinchZoomEnabled,
    onDragCancel: (callback) => {
      window.addEventListener(DragCancelEvent, callback)

      return () => window.removeEventListener(DragCancelEvent, callback)
    },
    runDesktopMenuAction: createDesktopMenuAction(api),
    checkAppExists: async (appName) => {
      return api.checkAppExists(appName)
    },
    extensions: createExtensionBridge(),
  }
}

function desktopOS() {
  if (navigator.userAgent.includes("Mac")) return "macos"

  if (navigator.userAgent.includes("Windows")) return "windows"

  if (navigator.userAgent.includes("Linux")) return "linux"

  return undefined
}
