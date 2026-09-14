type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

// The upstream feed must not update this independently branded fork. Public
// previews supply their own validated release provider through the shared updater.
// Activating the native signed feed still requires release/desktop-updates.md.
export const UPDATER_ENABLED = false
