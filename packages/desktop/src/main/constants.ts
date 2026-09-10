type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

// No upstream or unsigned artifacts may update this independently branded fork.
// Keep disabled until release/desktop-updates.md is qualified end to end;
// changing this flag alone is not sufficient or permitted release configuration.
export const UPDATER_ENABLED = false
