// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from "node:crypto"
import type { WorkcellAccountState } from "./workcell-account-types"
import type { ProjectWorkcellMetadata, ProjectWorkcellState, ProjectWorkcellSummary } from "./workcell-project-types"

type Pending = {
  operation: "create" | "sync" | "ensure"
  requestId: string
  metadata: ProjectWorkcellMetadata
  expectedRevision?: number
}
type Entry = {
  origin: string
  accountId: string
  projectId: string
  workcell: ProjectWorkcellSummary | null
  pending?: Pending
  conflict?: boolean
  accessLost?: boolean
}
type Journal = { version: 1; entries: Record<string, Entry> }
type Input = {
  account: {
    snapshot(): WorkcellAccountState
    generation(): number
    automaticSyncEnabled?(): boolean
    request(method: unknown, path: unknown, body?: unknown): Promise<unknown>
  }
  projectExists(id: string): Promise<boolean>
  store: { read(): Promise<unknown>; write(value: Journal): Promise<void> }
  origin?: string
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const metadataFields = ["name", "task", "objects", "volume", "location"]

/** Native account-bound associations. The operator's versioned project state stays unchanged. */
export function createProjectWorkcells(input: Input) {
  const origin = input.origin ?? "https://physicalsystems.ai"
  if (
    new URL(origin).origin !== origin ||
    (origin !== "https://physicalsystems.ai" && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))
  )
    throw new Error("INVALID_WORKCELL_ORIGIN")
  let queue = Promise.resolve<unknown>(undefined)

  async function run(
    raw: unknown,
    expectedAccount: string | null,
    expectedGeneration: number,
  ): Promise<ProjectWorkcellState> {
    const request = record(raw)
    if (
      !Object.keys(request).every((key) => ["operation", "projectId", "metadata", "workcellId"].includes(key)) ||
      !["inspect", "refresh", "create", "link", "sync", "retry", "ensure"].includes(String(request.operation)) ||
      typeof request.projectId !== "string" ||
      !request.projectId ||
      request.projectId.length > 200
    )
      throw new Error("INVALID_PROJECT_REQUEST")
    const projectId = request.projectId
    const operation = request.operation as string
    if (
      ["create", "sync", "ensure"].includes(operation) !== (request.metadata !== undefined) ||
      (operation === "link") !== (request.workcellId !== undefined)
    )
      throw new Error("INVALID_PROJECT_REQUEST")
    const metadata =
      request.metadata === undefined ? undefined : readProjectMetadata(request.metadata, operation === "ensure")
    if (
      operation === "ensure" &&
      (/\p{Cc}/u.test(projectId) || Object.keys(metadata!).some((key) => !["name", "task"].includes(key)))
    )
      throw new Error("INVALID_PROJECT_REQUEST")
    if (operation === "link" && (typeof request.workcellId !== "string" || !uuid.test(request.workcellId)))
      throw new Error("INVALID_PROJECT_REQUEST")
    const account = input.account.snapshot()
    const generation = input.account.generation()
    const accountId = account.status === "signed_in" ? (account.account?.id ?? null) : null
    const empty = (status: ProjectWorkcellState["status"], errorCode?: string): ProjectWorkcellState => ({
      projectId,
      accountId,
      status,
      workcell: null,
      ...(errorCode ? { errorCode } : {}),
    })
    if (expectedAccount !== accountId || expectedGeneration !== generation)
      return { projectId, accountId: null, status: "signed_out", workcell: null, errorCode: "WORKCELL_SESSION_CHANGED" }
    const current = () =>
      input.account.generation() === generation &&
      input.account.snapshot().status === "signed_in" &&
      input.account.snapshot().account?.id === accountId
    const guard = () => {
      if (!current()) throw new Error("WORKCELL_SESSION_CHANGED")
      if (operation === "ensure" && !input.account.automaticSyncEnabled?.()) throw new Error("AUTOMATIC_SYNC_DISABLED")
    }
    if (!(await input.projectExists(projectId))) return empty("unavailable", "PROJECT_NOT_FOUND")
    if (!accountId) return empty("signed_out", "WORKCELL_SIGN_IN_REQUIRED")
    if (operation === "ensure" && !input.account.automaticSyncEnabled?.())
      return empty("unavailable", "AUTOMATIC_SYNC_DISABLED")
    if (!current()) return empty("unavailable", "WORKCELL_SESSION_CHANGED")
    let journal: Journal
    try {
      journal = readJournal(await input.store.read())
    } catch {
      return empty("unavailable", "PROJECT_LINK_STORE_UNAVAILABLE")
    }
    if (!current()) return empty("unavailable", "WORKCELL_SESSION_CHANGED")
    const key = createHash("sha256")
      .update(JSON.stringify([origin, accountId, projectId]))
      .digest("hex")
    // The first durable entry is also the local ownership record. Never upload a
    // previously associated project to a newly signed-in account automatically.
    if (
      !journal.entries[key] &&
      Object.values(journal.entries).some(
        (item) => item.origin === origin && item.projectId === projectId && item.accountId !== accountId,
      )
    )
      return empty("unavailable", "PROJECT_ACCOUNT_MISMATCH")
    let entry: Entry = journal.entries[key] ?? { origin, accountId, projectId, workcell: null }
    if (entry.origin !== origin || entry.accountId !== accountId || entry.projectId !== projectId)
      return empty("unavailable", "PROJECT_LINK_STORE_UNAVAILABLE")
    const state = (errorCode?: string): ProjectWorkcellState => ({
      projectId,
      accountId,
      status: entry.accessLost
        ? "unavailable"
        : entry.conflict
          ? "conflict"
          : entry.pending
            ? "pending"
            : entry.workcell
              ? "linked"
              : "local",
      workcell: entry.workcell && !entry.accessLost ? structuredClone(entry.workcell) : null,
      ...(entry.pending
        ? { pendingMetadata: structuredClone(entry.pending.metadata), pendingOperation: entry.pending.operation }
        : {}),
      ...(errorCode || entry.accessLost ? { errorCode: errorCode ?? "WORKCELL_ACCESS_REVOKED" } : {}),
    })
    const save = async (next: Entry) => {
      guard()
      if (!journal.entries[key] && Object.keys(journal.entries).length >= 256)
        throw new Error("PROJECT_LINK_STORE_UNAVAILABLE")
      const updated = { ...journal, entries: { ...journal.entries, [key]: next } }
      try {
        await input.store.write(updated)
      } catch {
        throw new Error("PROJECT_LINK_STORE_UNAVAILABLE")
      }
      guard()
      journal = updated
      entry = next
    }
    const send = async () => {
      const pending = entry.pending
      if (!pending || entry.conflict) throw new Error("PROJECT_LINK_PENDING")
      guard()
      if (!(await input.projectExists(projectId))) throw new Error("PROJECT_NOT_FOUND")
      guard()
      const result = await input.account.request(
        pending.operation === "sync" ? "PATCH" : "POST",
        pending.operation === "ensure"
          ? "/api/workcells/ensure"
          : pending.operation === "create"
            ? "/api/workcells"
            : `/api/workcells/${entry.workcell!.id}`,
        {
          requestId: pending.requestId,
          ...pending.metadata,
          ...(pending.operation === "ensure" ? { localProjectId: projectId } : {}),
          ...(pending.operation === "sync" ? { expectedRevision: pending.expectedRevision } : {}),
        },
      )
      guard()
      const workcell = readWorkcell(record(result).workcell)
      if (pending.operation === "sync" && workcell.id !== entry.workcell?.id) throw new Error("INVALID_RESPONSE")
      if (pending.operation !== "sync" && record(record(result).workcell).companyId !== null)
        throw new Error("INVALID_RESPONSE")
      await save({ origin, accountId, projectId, workcell })
      return state()
    }
    try {
      if (operation === "inspect") return state()
      if (operation === "retry") return await send()
      if (operation === "ensure") {
        guard()
        if (entry.accessLost || entry.conflict) return state()
        if (entry.pending) return await send()
        if (entry.workcell) return state()
      }
      if (operation === "refresh") {
        // A lost response must be reconciled with the same UUID and exact payload.
        if (entry.pending && !entry.conflict) return state()
        if (!entry.workcell) return state()
        const result = await input.account.request("GET", `/api/workcells/${entry.workcell.id}`)
        guard()
        const workcell = readWorkcell(record(result).workcell)
        if (workcell.id !== entry.workcell.id) throw new Error("INVALID_RESPONSE")
        await save({ origin, accountId, projectId, workcell })
        return state()
      }
      if (entry.accessLost) return state("WORKCELL_ACCESS_REVOKED")
      if (entry.pending) return state("PROJECT_LINK_PENDING")
      if (operation === "link") {
        if (entry.workcell) return state("PROJECT_ALREADY_LINKED")
        const result = await input.account.request("GET", `/api/workcells/${request.workcellId}`)
        guard()
        const workcell = readWorkcell(record(result).workcell)
        if (workcell.id !== request.workcellId) throw new Error("INVALID_RESPONSE")
        await save({ origin, accountId, projectId, workcell })
        return state()
      }
      if (operation === "create" && entry.workcell) return state("PROJECT_ALREADY_LINKED")
      if (operation === "sync" && (!entry.workcell || !entry.workcell.canWrite)) return state("WORKCELL_READ_ONLY")
      const pending: Pending = {
        operation: operation as Pending["operation"],
        requestId: randomUUID(),
        metadata: metadata!,
        ...(operation === "sync" ? { expectedRevision: entry.workcell!.metadataRevision } : {}),
      }
      await save({ ...entry, pending, conflict: false })
      return await send()
    } catch (error) {
      const code = error instanceof Error ? error.message : "UNAVAILABLE"
      if (!current())
        return {
          projectId,
          accountId: null,
          status: "signed_out",
          workcell: null,
          errorCode: "WORKCELL_SESSION_CHANGED",
        }
      if (["METADATA_CONFLICT", "IDEMPOTENCY_CONFLICT"].includes(code) && entry.pending) {
        try {
          await save({ ...entry, conflict: true })
        } catch {
          return empty("unavailable", "PROJECT_LINK_STORE_UNAVAILABLE")
        }
        return state(code)
      }
      if (["WORKCELL_ACCESS_REVOKED", "WORKCELL_READ_ONLY", "INVALID_RESPONSE"].includes(code) && entry.workcell) {
        try {
          await save({ ...entry, accessLost: true })
        } catch {
          return empty("unavailable", "PROJECT_LINK_STORE_UNAVAILABLE")
        }
        return state(code)
      }
      if (["WORKCELL_ACCESS_REVOKED", "WORKCELL_READ_ONLY", "INVALID_RESPONSE", "PROJECT_NOT_FOUND"].includes(code))
        return empty("unavailable", code)
      return state(code === "PROJECT_LINK_STORE_UNAVAILABLE" ? code : "UNAVAILABLE")
    }
  }
  return {
    dispatch(raw: unknown) {
      // Serialize durable writes across windows and projects; requests never adopt another account mid-flight.
      const account = input.account.snapshot()
      const accountId = account.status === "signed_in" ? (account.account?.id ?? null) : null
      const generation = input.account.generation()
      const copied = structuredClone(raw)
      const operation = queue.catch(() => {}).then(() => run(copied, accountId, generation))
      queue = operation
      return operation
    },
  }
}

export function readProjectMetadata(value: unknown, draft = false): ProjectWorkcellMetadata {
  const data = record(value)
  if (!Object.keys(data).every((key) => metadataFields.includes(key))) throw new Error("INVALID_PROJECT_METADATA")
  for (const [key, maximum] of [
    ["name", 120],
    ["task", 8000],
    ["objects", 2000],
    ["volume", 500],
    ["location", 1000],
  ] as const) {
    const field = data[key]
    if (field === undefined && key !== "name" && key !== "task") continue
    if (
      typeof field !== "string" ||
      field.length > maximum ||
      ((key === "name" || (key === "task" && !draft)) && !field.trim())
    )
      throw new Error("INVALID_PROJECT_METADATA")
  }
  return Object.fromEntries(
    Object.entries(data)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, (value as string).trim()]),
  ) as ProjectWorkcellMetadata
}
function readWorkcell(value: unknown): ProjectWorkcellSummary {
  const data = record(value)
  if (
    typeof data.id !== "string" ||
    !uuid.test(data.id) ||
    !Number.isSafeInteger(data.metadataRevision) ||
    Number(data.metadataRevision) < 0 ||
    record(data.permissions).canRead !== true ||
    typeof record(data.permissions).canPost !== "boolean"
  )
    throw new Error("INVALID_RESPONSE")
  const metadata = readProjectMetadata(Object.fromEntries(metadataFields.map((key) => [key, data[key]])), true)
  if (metadataFields.some((key) => typeof data[key] !== "string")) throw new Error("INVALID_RESPONSE")
  return {
    ...(metadata as Required<ProjectWorkcellMetadata>),
    id: data.id,
    metadataRevision: data.metadataRevision as number,
    canWrite: record(data.permissions).canPost as boolean,
  }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_PROJECT_REQUEST")
  return value as Record<string, unknown>
}
function readJournal(value: unknown): Journal {
  if (value === null || value === undefined) return { version: 1, entries: {} }
  const data = record(value)
  const entries = record(data.entries)
  if (
    data.version !== 1 ||
    Object.keys(data).some((key) => !["version", "entries"].includes(key)) ||
    Object.keys(entries).length > 256
  )
    throw new Error("INVALID_PROJECT_JOURNAL")
  for (const [key, value] of Object.entries(entries)) {
    const entry = record(value)
    if (
      !/^[0-9a-f]{64}$/.test(key) ||
      typeof entry.origin !== "string" ||
      typeof entry.accountId !== "string" ||
      typeof entry.projectId !== "string" ||
      Object.keys(entry).some(
        (key) => !["origin", "accountId", "projectId", "workcell", "pending", "conflict", "accessLost"].includes(key),
      ) ||
      (entry.conflict !== undefined && typeof entry.conflict !== "boolean") ||
      (entry.accessLost !== undefined && typeof entry.accessLost !== "boolean")
    )
      throw new Error("INVALID_PROJECT_JOURNAL")
    if (entry.workcell !== null) {
      const workcell = record(entry.workcell)
      readWorkcell({ ...workcell, permissions: { canRead: true, canPost: workcell.canWrite } })
      if (Object.keys(workcell).some((key) => ![...metadataFields, "id", "metadataRevision", "canWrite"].includes(key)))
        throw new Error("INVALID_PROJECT_JOURNAL")
    }
    if (entry.pending !== undefined) {
      const pending = record(entry.pending)
      if (
        !["create", "sync", "ensure"].includes(String(pending.operation)) ||
        typeof pending.requestId !== "string" ||
        !uuid.test(pending.requestId) ||
        Object.keys(pending).some((key) => !["operation", "requestId", "metadata", "expectedRevision"].includes(key))
      )
        throw new Error("INVALID_PROJECT_JOURNAL")
      const metadata = readProjectMetadata(pending.metadata, pending.operation === "ensure")
      if (pending.operation === "ensure" && Object.keys(metadata).some((key) => !["name", "task"].includes(key)))
        throw new Error("INVALID_PROJECT_JOURNAL")
      if (
        pending.operation === "sync" &&
        (!entry.workcell || !Number.isSafeInteger(pending.expectedRevision) || Number(pending.expectedRevision) < 0)
      )
        throw new Error("INVALID_PROJECT_JOURNAL")
      if (pending.operation !== "sync" && (entry.workcell !== null || pending.expectedRevision !== undefined))
        throw new Error("INVALID_PROJECT_JOURNAL")
    }
  }
  return data as Journal
}
