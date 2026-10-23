import { app } from "electron"
import type { Event } from "electron"
import { createDesktopLaunchController } from "../desktop-launch"

export const desktopLaunch = createDesktopLaunchController()

const secondInstance = (_event: Event, argv: string[]) => {
  argv.some((value) => desktopLaunch.receive(value))
}

const openUrl = (event: Event, url: string) => {
  if (desktopLaunch.receive(url)) event.preventDefault()
}

// The first window loads before the main lifecycle bundle. Keep website requests
// received in that interval pending until the normal window restore adopts it.
export function captureEarlyDesktopLaunch() {
  process.argv.some((value) => desktopLaunch.receive(value))
  app.on("second-instance", secondInstance)
  app.on("open-url", openUrl)
}

export function releaseEarlyDesktopLaunch() {
  app.off("second-instance", secondInstance)
  app.off("open-url", openUrl)
}
