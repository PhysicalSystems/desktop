import type { BrowserWindow } from "electron"

type LaunchWindow = Pick<BrowserWindow, "isDestroyed" | "isMinimized" | "restore" | "show" | "focus">

/** The website may raise the app, but cannot select a project, submit a prompt,
 * pass credentials, or change the current session through this protocol. */
export function createDesktopLaunchController() {
  let pending = false

  function ready(window?: LaunchWindow | null) {
    if (!pending || !window || window.isDestroyed()) return
    pending = false
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  return {
    receive(value: unknown, window?: LaunchWindow | null) {
      if (typeof value !== "string" || !/^physicalsystems:/i.test(value)) return false
      // Consume invalid requests as well: never forward or log their arbitrary
      // paths, query parameters, fragments, or credentials as renderer links.
      if (value !== "physicalsystems://open") return true
      pending = true
      ready(window)
      return true
    },
    // Early/cold requests wait for the existing startup path to show a window.
    // They never create an extra window or enter the renderer deep-link queue.
    ready,
  }
}
