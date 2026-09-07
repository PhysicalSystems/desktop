// SPDX-License-Identifier: Apache-2.0
export type LegacyMessage = {
  id: string
  parentId: string | null
  timestamp?: string
  role: "user" | "assistant" | "historical"
  text: string
  sourceType: string
}

export type LegacyConversation = {
  id: string
  title: string
  draft: string
  archived: boolean
  sourceDigest?: string
  messages: LegacyMessage[]
}

export type LegacyProject = {
  id: string
  name: string
  cwd?: string
  connection: { kind: "local" | "ssh" | "simulation"; label: string; status: "offline" }
  conversations: LegacyConversation[]
}

/** This archive is evidence only. It is never loaded as an OpenCode session. */
export type LegacyArchive = {
  schemaVersion: 1
  sourceSchemaVersion: 1
  id: string
  authority: "none"
  readOnly: true
  projects: LegacyProject[]
  warnings: string[]
  sources: { file: string; sha256: string }[]
}

export type LegacyArchiveSummary = {
  id: string
  projectCount: number
  conversationCount: number
  messageCount: number
  projects: { name: string; conversationCount: number; messageCount: number }[]
  warnings: string[]
}

export type LegacyPreview = LegacyArchiveSummary & { token: string }

export type LegacyMigrationBridge = {
  preview(): Promise<LegacyPreview | null>
  commit(token: string): Promise<LegacyArchiveSummary>
  list(): Promise<LegacyArchiveSummary[]>
  read(id: string): Promise<LegacyArchive>
}
