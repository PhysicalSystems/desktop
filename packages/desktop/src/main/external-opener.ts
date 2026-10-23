import { shell } from "electron"
import { createExternalURLOpener, snapshotExternalLaunchEnvironment } from "./files/external-url"

const environment = snapshotExternalLaunchEnvironment(process.env)
export const openPhysicalExternalURL = createExternalURLOpener({ platform: process.platform, environment, open: (url) => shell.openExternal(url) })
