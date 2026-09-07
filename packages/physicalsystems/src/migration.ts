// SPDX-License-Identifier: Apache-2.0
import { constants } from "node:fs"
import { lstat, open, realpath, mkdir, link, unlink, readdir } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import type { LegacyArchive, LegacyArchiveSummary, LegacyConversation, LegacyMessage, LegacyProject } from "./migration-types"

const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
const archiveID = /^legacy-[a-f0-9]{64}$/
const maxCatalog = 5 * 1024 * 1024
const maxTranscript = 10 * 1024 * 1024
const maxArchive = 50 * 1024 * 1024
const maxEntries = 100_000

export type LegacyImportPreview = {
  sourceDirectory: string
  archive: LegacyArchive
  summary: LegacyArchiveSummary
}

/** Called only after an explicit native directory choice. No ambient data lookup. */
export async function previewLegacyImport(sourceDir: string): Promise<LegacyImportPreview> {
  const root = await directory(sourceDir)
  const catalogBytes = await readBounded(root, "catalog.json", maxCatalog)
  const catalog = object(parse(catalogBytes, "catalog"), ["schemaVersion", "revision", "projects", "connections", "conversations", "selection", "preferences"])
  if (catalog.schemaVersion !== 1) throw invalid("Unsupported catalog version; use a compatible build or choose another copy.")
  if (!Number.isSafeInteger(catalog.revision) || Number(catalog.revision) < 0) throw invalid("Invalid catalog revision.")
  const projects = collection(catalog.projects)
  const connections = collection(catalog.connections)
  const conversations = collection(catalog.conversations)
  object(catalog.selection, ["projectId", "conversationId"])
  object(catalog.preferences, ["devicesOpen", "theme"])
  const warnings = ["Historical copies only. Old approvals, pending turns, captures and runs are inactive. Connections remain offline.", "Tool payloads, images, reasoning, credential references and configuration are excluded. Transcripts include historical branches."]
  const sources = [{ file: "catalog.json", sha256: digest(catalogBytes) }]
  const result: LegacyProject[] = []
  let size = catalogBytes.length
  const transcripts = new Map<string, { sourceDigest: string; messages: LegacyMessage[] }>()
  for (const connection of connections) {
    object(connection, ["id", "type", "label", "nodeUrl", "host", "username", "port", "remotePort", "keyPath", "knownHostsPath", "credentialRef", "expectedNodeId", "autoConnect"])
    if (!["local", "ssh", "simulation"].includes(String(connection.type))) throw invalid("Unsupported connection type.")
  }
  for (const conversation of conversations) {
    object(conversation, ["id", "projectId", "title", "sessionId", "sessionFile", "archived", "draft", "createdAt", "updatedAt"])
    if (!projects.some((project) => project.id === conversation.projectId)) throw invalid("A conversation refers to a missing project.")
  }
  for (const project of projects) {
    object(project, ["id", "name", "connectionId", "collapsed", "archived", "cwd", "createdAt", "lastConversationId"])
    const connection = connections.find((item) => item.id === project.connectionId)
    if (project.connectionId && !connection) throw invalid("A project refers to a missing connection.")
    const imported: LegacyProject = {
      id: String(project.id), name: clean(text(project.name, 256)),
      connection: { kind: (connection?.type ?? "local") as LegacyProject["connection"]["kind"], label: clean(text(connection?.label ?? "", 256)), status: "offline" },
      conversations: [],
    }
    if (project.cwd !== undefined) {
      const cwd = text(project.cwd, 4096)
      if (!isAbsolute(cwd)) throw invalid("A project folder is not absolute.")
      imported.cwd = clean(cwd)
    }
    for (const conversation of conversations.filter((item) => item.projectId === project.id)) {
      const entry: LegacyConversation = { id: String(conversation.id), title: clean(text(conversation.title, 256)), draft: clean(text(conversation.draft ?? "", 128 * 1024)), archived: conversation.archived === true, messages: [] }
      if (conversation.sessionFile !== undefined) {
        const file = text(conversation.sessionFile, 512)
        if (!/^harness\/harness-sessions\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.jsonl$/.test(file)) throw invalid("A transcript reference escapes its supported directory.")
        if (!transcripts.has(file)) {
          const bytes = await readBounded(root, file, maxTranscript).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error
            warnings.push(`Transcript missing for ${entry.title}; its title and draft are preserved. Restore a complete source copy and preview again.`)
            return undefined
          })
          if (bytes) {
            size += bytes.length
            if (size > maxArchive) throw invalid("The selected history exceeds the supported import size. Export smaller copies.")
            const sourceDigest = digest(bytes)
            const messages = transcript(bytes)
            transcripts.set(file, { sourceDigest, messages })
            sources.push({ file, sha256: sourceDigest })
          }
        }
        const saved = transcripts.get(file)
        if (saved) {
          entry.sourceDigest = saved.sourceDigest
          entry.messages = saved.messages
        }
      }
      imported.conversations.push(entry)
    }
    result.push(imported)
  }
  // A live source may append during preview; reject changes instead of mixing revisions.
  for (const source of sources) {
    if (digest(await readBounded(root, source.file, source.file === "catalog.json" ? maxCatalog : maxTranscript)) !== source.sha256) {
      throw invalid("Source changed while reading. Choose a stable copy and retry the preview.")
    }
  }
  const content = { schemaVersion: 1 as const, sourceSchemaVersion: 1 as const, authority: "none" as const, readOnly: true as const, projects: result, warnings, sources }
  const archive = { ...content, id: `legacy-${digest(JSON.stringify(content))}` }
  if (Buffer.byteLength(JSON.stringify(archive)) > maxArchive) throw invalid("The projected archive is too large.")
  return { sourceDirectory: root, archive, summary: summarize(archive) }
}

/** Publish an immutable sanitized copy. Repeating the same import is a no-op. */
export async function commitLegacyImport(preview: LegacyImportPreview, targetDir: string): Promise<LegacyArchiveSummary> {
  const archive = validateArchive(preview.archive)
  if (!isAbsolute(targetDir)) throw invalid("The import destination must be absolute.")
  // Resolve the nearest existing ancestor before mkdir: an alias must not create
  // an import directory inside the original data tree even on a failed import.
  let ancestor = resolve(targetDir)
  while (!(await lstat(ancestor).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
    return undefined
  }))) ancestor = dirname(ancestor)
  const destination = relative(preview.sourceDirectory, resolve(await realpath(ancestor), relative(ancestor, resolve(targetDir))))
  if (!destination || (!destination.startsWith(`..${sep}`) && destination !== ".." && !isAbsolute(destination))) throw invalid("The import destination must be separate from the original data directory.")
  await mkdir(targetDir, { recursive: true, mode: 0o700 })
  const root = await directory(targetDir)
  const filename = `${archive.id}.json`
  const bytes = Buffer.from(JSON.stringify(archive) + "\n")
  const existing = await readBounded(root, filename, maxArchive).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
    return undefined
  })
  if (existing) {
    if (!existing.equals(bytes)) throw invalid("An existing import differs from its recorded digest. Preserve it and select a new recovery directory.")
    return summarize(archive)
  }
  const temporary = join(root, `.${archive.id}.${randomUUID()}.tmp`)
  const handle = await open(temporary, "wx", 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    // Hard-link publication is atomic and cannot overwrite another import.
    await link(temporary, join(root, filename)).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error
      if (!(await readBounded(root, filename, maxArchive)).equals(bytes)) throw invalid("Conflicting imported archive. Existing files were preserved.")
    })
    if (process.platform !== "win32") {
      const dir = await open(root, "r")
      try { await dir.sync() } finally { await dir.close() }
    }
  } finally {
    await handle.close().catch(() => {})
    await unlink(temporary).catch(() => {})
  }
  return summarize(archive)
}

export async function listLegacyImports(targetDir: string): Promise<LegacyArchiveSummary[]> {
  const root = await directory(targetDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
    return undefined
  })
  if (!root) return []
  const files = (await readdir(root)).filter((file) => /^legacy-[a-f0-9]{64}\.json$/.test(file)).sort()
  if (files.length > 1000) throw invalid("Too many imported archives. Preserve them and choose a smaller import directory.")
  const summaries: LegacyArchiveSummary[] = []
  for (const file of files) summaries.push(summarize(await readLegacyImport(root, file.slice(0, -5))))
  return summaries
}

export async function readLegacyImport(targetDir: string, id: string): Promise<LegacyArchive> {
  if (!archiveID.test(id)) throw invalid("Invalid imported archive identifier.")
  const archive = validateArchive(parse(await readBounded(await directory(targetDir), `${id}.json`, maxArchive), "imported archive"))
  if (archive.id !== id) throw invalid("Imported archive identity differs from its filename.")
  return archive
}

function transcript(bytes: Buffer): LegacyMessage[] {
  const lines = bytes.toString("utf8").split("\n").filter((line) => line.trim())
  if (lines.length > maxEntries) throw invalid("The transcript contains too many entries.")
  const header = parse(Buffer.from(lines.shift() ?? ""), "transcript header")
  if (!isRecord(header) || header.type !== "session" || header.version !== 3 || typeof header.id !== "string") {
    throw invalid("Unsupported transcript schema. Version 3 history is supported; keep other versions in the old app.")
  }
  const ids = new Set<string>()
  return lines.map((line) => {
    const entry = parse(Buffer.from(line), "transcript entry")
    if (!isRecord(entry) || typeof entry.type !== "string" || typeof entry.id !== "string" || !identifier.test(entry.id) || ids.has(entry.id)) throw invalid("Invalid or duplicate historical entry.")
    ids.add(entry.id)
    if (entry.parentId !== null && (typeof entry.parentId !== "string" || !identifier.test(entry.parentId))) throw invalid("Invalid historical branch reference.")
    const result: LegacyMessage = { id: entry.id, parentId: entry.parentId as string | null, sourceType: text(entry.type, 128), role: "historical", text: "Historical record retained by reference; its payload is excluded." }
    if (typeof entry.timestamp === "string") result.timestamp = text(entry.timestamp, 64)
    if (entry.type === "message" && isRecord(entry.message)) {
      const message = entry.message
      if (message.role === "user" || message.role === "assistant") {
        result.role = message.role
        result.text = clean(typeof message.content === "string" ? text(message.content, maxTranscript) : Array.isArray(message.content) ? message.content.flatMap((part) => isRecord(part) && part.type === "text" && typeof part.text === "string" ? [text(part.text, maxTranscript)] : []).join("\n") : "")
        const tools = Array.isArray(message.content) ? message.content.flatMap((part) => isRecord(part) && part.type === "toolCall" && typeof part.name === "string" ? [clean(text(part.name, 256))] : []) : []
        if (tools.length) result.text += `${result.text ? "\n\n" : ""}Historical tools: ${tools.join(", ")}. Arguments and approval authority excluded.`
        if (!result.text) result.text = "Non-text historical content excluded."
      }
      if (message.role === "toolResult") result.text = `Historical tool result: ${clean(text(message.toolName ?? "unknown", 256))}. Payload and approval authority excluded.`
    }
    if (["compaction", "branch_summary"].includes(entry.type) && typeof entry.summary === "string") result.text = clean(text(entry.summary, maxTranscript))
    return result
  })
}

function validateArchive(value: unknown): LegacyArchive {
  const record = object(value, ["schemaVersion", "sourceSchemaVersion", "id", "authority", "readOnly", "projects", "warnings", "sources"])
  if (record.schemaVersion !== 1 || record.sourceSchemaVersion !== 1 || record.authority !== "none" || record.readOnly !== true || typeof record.id !== "string" || !archiveID.test(record.id)) throw invalid("Unsupported imported archive.")
  if (!Array.isArray(record.projects) || !Array.isArray(record.warnings) || !Array.isArray(record.sources)) throw invalid("Malformed imported archive.")
  collection(record.projects).forEach((project) => {
    object(project, ["id", "name", "cwd", "connection", "conversations"])
    text(project.name, 256)
    if (project.cwd !== undefined) text(project.cwd, 4096)
    const connection = object(project.connection, ["kind", "label", "status"])
    if (connection.status !== "offline" || !["local", "ssh", "simulation"].includes(String(connection.kind))) throw invalid("An imported connection must remain offline.")
    text(connection.label, 256)
    collection(project.conversations).forEach((conversation) => {
      object(conversation, ["id", "title", "draft", "archived", "sourceDigest", "messages"])
      text(conversation.title, 256)
      text(conversation.draft, 128 * 1024)
      if (typeof conversation.archived !== "boolean") throw invalid("Invalid imported archive flag.")
      if (conversation.sourceDigest !== undefined && !/^[a-f0-9]{64}$/.test(text(conversation.sourceDigest, 64))) throw invalid("Invalid transcript digest.")
      if (!Array.isArray(conversation.messages) || conversation.messages.length > maxEntries) throw invalid("Invalid imported messages.")
      conversation.messages.forEach((item) => {
        const message = object(item, ["id", "parentId", "timestamp", "role", "text", "sourceType"])
        if (!identifier.test(text(message.id, 128)) || (message.parentId !== null && !identifier.test(text(message.parentId, 128)))) throw invalid("Invalid imported message identity.")
        if (!["user", "assistant", "historical"].includes(String(message.role))) throw invalid("Invalid imported message role.")
        text(message.text, maxTranscript)
        text(message.sourceType, 128)
        if (message.timestamp !== undefined) text(message.timestamp, 64)
      })
    })
  })
  record.warnings.forEach((warning) => text(warning, 4096))
  record.sources.forEach((source) => {
    const value = object(source, ["file", "sha256"])
    text(value.file, 512)
    if (!/^[a-f0-9]{64}$/.test(text(value.sha256, 64))) throw invalid("Invalid source digest.")
  })
  const { id, ...content } = record
  if (`legacy-${digest(JSON.stringify(content))}` !== id) throw invalid("Imported archive digest does not match. Preserve the file and import a fresh source copy.")
  if (Buffer.byteLength(JSON.stringify(value)) > maxArchive) throw invalid("Imported archive exceeds its size limit.")
  return record as unknown as LegacyArchive
}

function summarize(archive: LegacyArchive): LegacyArchiveSummary {
  const projects = archive.projects.map((project) => ({ name: project.name, conversationCount: project.conversations.length, messageCount: project.conversations.reduce((total, conversation) => total + conversation.messages.length, 0) }))
  return { id: archive.id, projectCount: projects.length, conversationCount: projects.reduce((total, project) => total + project.conversationCount, 0), messageCount: projects.reduce((total, project) => total + project.messageCount, 0), projects, warnings: archive.warnings }
}

async function directory(path: string) {
  if (!isAbsolute(path)) throw invalid("Select an absolute directory.")
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid("Use a regular directory, not a symbolic link.")
  return realpath(path)
}

async function readBounded(root: string, file: string, max: number) {
  const path = resolve(root, file)
  const rel = relative(root, path)
  if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw invalid("A history path escapes its selected directory.")
  const parts = rel.split(sep)
  for (let index = 1; index <= parts.length; index++) {
    const stat = await lstat(join(root, ...parts.slice(0, index)))
    if (stat.isSymbolicLink() || (index < parts.length && !stat.isDirectory()) || (index === parts.length && !stat.isFile())) throw invalid("History paths must contain regular directories and files, without symbolic links.")
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > max) throw invalid("A history file is not a regular file of a supported size.")
    const bytes = Buffer.alloc(before.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!result.bytesRead) break
      offset += result.bytesRead
    }
    const after = await handle.stat()
    if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw invalid("A history file changed during reading. Preview a stable copy.")
    return bytes.subarray(0, offset)
  } finally { await handle.close() }
}

function collection(value: unknown) {
  if (!Array.isArray(value) || value.length > 10_000) throw invalid("Invalid catalog collection.")
  const ids = new Set<string>()
  return value.map((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || !identifier.test(item.id) || ids.has(item.id)) throw invalid("Invalid or duplicate catalog identifier.")
    ids.add(item.id)
    return item
  })
}

function object(value: unknown, fields: string[]) {
  if (!isRecord(value) || Object.keys(value).some((key) => !fields.includes(key))) throw invalid("Unsupported data fields. Credentials and execution state cannot be imported.")
  return value
}
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) }
function text(value: unknown, max: number) {
  if (typeof value !== "string" || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) throw invalid("Invalid history text.")
  return value
}
function clean(value: string) {
  return value.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[private key excluded]")
    .replace(/\b(?:sk-[a-zA-Z0-9_-]{16,}|gh[pousr]_[a-zA-Z0-9_]{20,})\b/g, "[credential excluded]")
    .replace(/(\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|authorization)\s*[:=]\s*)(?:Bearer\s+)?[^\s,;]+/gi, "$1[credential excluded]")
    .replace(/\bdata:image\/[^\s)"']+/gi, "[image excluded]")
}
function parse(bytes: Buffer, kind: string): unknown {
  try { return JSON.parse(bytes.toString("utf8")) } catch { throw invalid(`Invalid ${kind} JSON. Restore a complete source copy and preview again.`) }
}
function digest(value: string | Buffer) { return createHash("sha256").update(value).digest("hex") }
function invalid(message: string) { return new Error(`LEGACY_IMPORT_INVALID: ${message} Original files are unchanged.`) }
