// SPDX-License-Identifier: Apache-2.0
export const migrationEnglish = {
  "physicalsystems.migration.open": "Imported history",
  "physicalsystems.migration.title": "Previous Physical Systems history",
  "physicalsystems.migration.close": "Close imported history",
  "physicalsystems.migration.choose": "Choose a previous data folder…",
  "physicalsystems.migration.preview": "Review the import",
  "physicalsystems.migration.summary":
    "{{projects}} projects · {{conversations}} conversations · {{messages}} historical entries",
  "physicalsystems.migration.projectSummary": "{{name}} · {{conversations}} conversations · {{messages}} entries",
  "physicalsystems.migration.confirm": "Import this historical copy",
  "physicalsystems.migration.cancel": "Cancel import",
  "physicalsystems.migration.empty": "No previous history has been imported.",
  "physicalsystems.migration.notice":
    "These are read-only historical copies. Imported approvals and pending actions cannot run, and imported connections stay offline. Originals are preserved.",
  "physicalsystems.migration.excluded":
    "Images, tool payloads, reasoning and credential storage are excluded. Recognizable secrets in text are redacted; review copied text before reusing it.",
  "physicalsystems.migration.pending": "Reading history…",
  "physicalsystems.migration.failure":
    "The history operation could not finish. Original data was preserved. Retry with a complete, stable copy.",
  "physicalsystems.migration.reload": "Reload imported copies",
  "physicalsystems.migration.back": "Back to imported copies",
  "physicalsystems.migration.offline": "Historical project · Offline",
  "physicalsystems.migration.noMessages": "No supported transcript is available for this conversation.",
  "physicalsystems.migration.draft": "Saved draft",
  "physicalsystems.migration.copy": "Copy draft",
  "physicalsystems.migration.copied": "Draft copied. Paste it into a new conversation when ready.",
  "physicalsystems.migration.clipboardFailure":
    "Clipboard access was unavailable. Select and copy the saved draft manually.",
  "physicalsystems.migration.role.user": "You",
  "physicalsystems.migration.role.assistant": "Physical Systems",
  "physicalsystems.migration.role.historical": "Historical record",
  "physicalsystems.migration.branch": "Source entry: {{id}} · Parent: {{parent}}",
  "physicalsystems.migration.root": "Beginning",
  "physicalsystems.migration.more": "Show the next historical entries",
} as const
