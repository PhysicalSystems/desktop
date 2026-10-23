import { app } from "electron"
import { desktopIdentity } from "../../../physicalsystems/src/release/identity"

type Channel = "local" | "dev" | "beta" | "prod"
const raw = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = raw === "local" || raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"
export const VERSION = app.isPackaged ? app.getVersion() : (process.env.OPENCODE_VERSION ?? app.getVersion())
export const PHYSICAL_IDENTITY = desktopIdentity(import.meta.env.PHYSICALSYSTEMS_BUILD_IDENTITY)
export const APP_NAME = PHYSICAL_IDENTITY.runtimeName
export const APP_ID = PHYSICAL_IDENTITY.appId
// Only the independently verified Physical Systems preview feed has update authority.
export const UPDATER_ENABLED = false
