// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import { tmpdir } from "node:os"
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { createProjectWorkcells } from "./workcell-project"
import { createCredentialVault } from "./credentials"
import { validateRoomRequest } from "./workcell-account"
import type { WorkcellAccountState } from "./workcell-account-types"

const id = "fce739a6-cb75-4c86-b376-d4b6414f1766"
const metadata = { name: "Simulation test", task: "Move a test block", objects: "block", volume: "", location: "" }
const room = () => ({
  ...metadata,
  id,
  metadataRevision: 0,
  companyId: null,
  permissions: { canRead: true, canPost: true },
})
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep + "ps-workcell-link-"))
      throw new Error("Unexpected fixture directory")
    await rm(root, { recursive: true, force: true })
  }
})

function fixture() {
  const account: WorkcellAccountState = {
    revision: 0,
    sessionId: "session-a",
    status: "signed_in",
    account: { id: "account-a", name: "A", email: "a@example.invalid" },
    pending: null,
    error: null,
  }
  const control = {
    account,
    generation: 0,
    automatic: true,
    journal: undefined as unknown,
    exists: true,
    failWrite: false,
    calls: [] as { method: unknown; path: unknown; body: unknown }[],
    request: async (_method: unknown, _path: unknown, _body: unknown): Promise<unknown> => ({ workcell: room() }),
  }
  const input = {
    account: {
      snapshot: () => structuredClone(account),
      generation: () => control.generation,
      automaticSyncEnabled: () => control.automatic,
      request: async (method: unknown, path: unknown, body?: unknown) => {
        validateRoomRequest(method, path, body)
        control.calls.push({ method, path, body: structuredClone(body) })
        return control.request(method, path, body)
      },
    },
    projectExists: async (projectId: string) => control.exists && ["project-one", "project-two"].includes(projectId),
    store: {
      read: async () => structuredClone(control.journal),
      write: async (value: unknown) => {
        if (control.failWrite) throw new Error("Disk unavailable")
        control.journal = structuredClone(value)
      },
    },
  }
  return { control, input, client: createProjectWorkcells(input) }
}
function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test("approved metadata is durable before dispatch and exact lost-response retry survives restart", async () => {
  const { client, control, input } = fixture()
  let first = true
  control.request = async (_method, _path, body) => {
    expect(JSON.stringify(control.journal)).toContain((body as { requestId: string }).requestId)
    if (first) {
      first = false
      throw new Error("Response lost after server committed")
    }
    return { workcell: room(), replayed: true }
  }
  const pending = await client.dispatch({ operation: "create", projectId: "project-one", metadata })
  expect(pending.status).toBe("pending")
  expect(pending.pendingMetadata).toEqual(metadata)
  const restarted = createProjectWorkcells(input)
  expect((await restarted.dispatch({ operation: "inspect", projectId: "project-one" })).status).toBe("pending")
  await restarted.dispatch({
    operation: "create",
    projectId: "project-one",
    metadata: { ...metadata, name: "Different" },
  })
  expect(control.calls).toHaveLength(1)
  expect((await restarted.dispatch({ operation: "retry", projectId: "project-one" })).status).toBe("linked")
  expect(control.calls[1]).toEqual(control.calls[0])
  expect(Object.keys(control.calls[0].body as object).sort()).toEqual(["requestId", ...Object.keys(metadata)].sort())
})

test("native raw requests reject authority and private local data before network or journal writes", async () => {
  for (const raw of [
    { operation: "create", projectId: "project-one", metadata: { ...metadata, cwd: "C:/private" } },
    { operation: "create", projectId: "project-one", metadata: { ...metadata, connection: { secret: "private" } } },
    { operation: "create", projectId: "project-one", metadata: { ...metadata, companyId: id } },
    { operation: "create", projectId: "project-one", metadata: { ...metadata, name: " " } },
    { operation: "create", projectId: "project-one", metadata: { ...metadata, task: "x".repeat(8001) } },
    { operation: "link", projectId: "project-one", workcellId: "../desktop/account" },
    { operation: "inspect", projectId: "project-one", path: "https://other.invalid" },
    { operation: "retry", projectId: "project-one", metadata },
  ]) {
    const { client, control } = fixture()
    await expect(client.dispatch(raw)).rejects.toThrow()
    expect(control.calls).toHaveLength(0)
    expect(control.journal).toBeUndefined()
  }
  const { client, control } = fixture()
  expect((await client.dispatch({ operation: "create", projectId: "missing", metadata })).errorCode).toBe(
    "PROJECT_NOT_FOUND",
  )
  control.failWrite = true
  expect((await client.dispatch({ operation: "create", projectId: "project-one", metadata })).errorCode).toBe(
    "PROJECT_LINK_STORE_UNAVAILABLE",
  )
  expect(control.calls).toHaveLength(0)
})

test("account switch hides old results, preserves old pending recovery and rejects queued old-account actions", async () => {
  const { client, control } = fixture()
  const started = deferred<void>()
  const response = deferred<unknown>()
  control.request = async () => {
    started.resolve()
    return response.promise
  }
  const first = client.dispatch({ operation: "create", projectId: "project-one", metadata })
  await started.promise
  const queued = client.dispatch({ operation: "create", projectId: "project-two", metadata })
  control.account.account = { id: "account-b", name: "B", email: "b@example.invalid" }
  control.generation++
  response.resolve({ workcell: room() })
  for (const result of await Promise.all([first, queued])) {
    expect(result.workcell).toBeNull()
    expect(result.errorCode).toBe("WORKCELL_SESSION_CHANGED")
  }
  expect(control.calls).toHaveLength(1)
  expect((await client.dispatch({ operation: "inspect", projectId: "project-one" })).errorCode).toBe(
    "PROJECT_ACCOUNT_MISMATCH",
  )
  control.account.account = { id: "account-a", name: "A", email: "a@example.invalid" }
  control.generation++
  expect((await client.dispatch({ operation: "inspect", projectId: "project-one" })).status).toBe("pending")
  expect((await client.dispatch({ operation: "retry", projectId: "project-one" })).status).toBe("linked")
})

test("grant revocation removes visible linked metadata without deleting another account's journal", async () => {
  const { client, control } = fixture()
  await client.dispatch({ operation: "link", projectId: "project-one", workcellId: id })
  const saved = structuredClone(control.journal)
  control.request = async () => {
    control.account.status = "signed_out"
    control.account.account = null
    control.generation++
    throw new Error("ACCESS_REVOKED")
  }
  const state = await client.dispatch({ operation: "refresh", projectId: "project-one" })
  expect(state.status).toBe("signed_out")
  expect(state.workcell).toBeNull()
  expect(control.journal).toEqual(saved)
})

test("conflicting metadata requires explicit refresh before a newly reviewed update", async () => {
  const { client, control } = fixture()
  await client.dispatch({ operation: "link", projectId: "project-one", workcellId: id })
  control.request = async (method, _path, body) => {
    if (method === "PATCH" && (body as { expectedRevision: number }).expectedRevision === 0)
      throw new Error("METADATA_CONFLICT")
    return { workcell: { ...room(), name: "Website edit", metadataRevision: method === "PATCH" ? 2 : 1 } }
  }
  const conflict = await client.dispatch({
    operation: "sync",
    projectId: "project-one",
    metadata: { ...metadata, task: "Reviewed update" },
  })
  expect(conflict.status).toBe("conflict")
  expect(conflict.pendingMetadata?.task).toBe("Reviewed update")
  const latest = await client.dispatch({ operation: "refresh", projectId: "project-one" })
  expect(latest.status).toBe("linked")
  expect(latest.workcell?.metadataRevision).toBe(1)
  expect(latest.pendingMetadata).toBeUndefined()
  const synced = await client.dispatch({
    operation: "sync",
    projectId: "project-one",
    metadata: { ...metadata, name: "Website edit" },
  })
  expect(synced.workcell?.metadataRevision).toBe(2)
  expect((control.calls.at(-1)?.body as { expectedRevision: number }).expectedRevision).toBe(1)
})

test("unreadable rooms cannot be linked; viewers can link but cannot change metadata", async () => {
  const { client, control } = fixture()
  control.request = async () => {
    throw new Error("WORKCELL_ACCESS_REVOKED")
  }
  expect((await client.dispatch({ operation: "link", projectId: "project-one", workcellId: id })).status).toBe(
    "unavailable",
  )
  expect(control.journal).toBeUndefined()
  control.request = async () => ({ workcell: { ...room(), permissions: { canRead: true, canPost: false } } })
  expect(
    (await client.dispatch({ operation: "link", projectId: "project-one", workcellId: id })).workcell?.canWrite,
  ).toBe(false)
  expect((await client.dispatch({ operation: "sync", projectId: "project-one", metadata })).errorCode).toBe(
    "WORKCELL_READ_ONLY",
  )
  expect(control.calls.every((call) => call.method === "GET")).toBe(true)
})

test("a removed linked room stays hidden across restart until access is reverified", async () => {
  const { client, control, input } = fixture()
  await client.dispatch({ operation: "link", projectId: "project-one", workcellId: id })
  control.request = async () => {
    throw new Error("WORKCELL_ACCESS_REVOKED")
  }
  expect((await client.dispatch({ operation: "refresh", projectId: "project-one" })).workcell).toBeNull()
  const restarted = createProjectWorkcells(input)
  for (const request of [
    { operation: "inspect", projectId: "project-one" },
    { operation: "create", projectId: "project-one", metadata },
    { operation: "sync", projectId: "project-one", metadata },
  ]) {
    const state = await restarted.dispatch(request)
    expect(state.status).toBe("unavailable")
    expect(state.workcell).toBeNull()
  }
  expect(control.calls).toHaveLength(2)
  control.request = async () => ({ workcell: room() })
  expect((await restarted.dispatch({ operation: "refresh", projectId: "project-one" })).status).toBe("linked")
})

test("another service origin cannot adopt the existing mapping and corrupt journals are never overwritten", async () => {
  const { client, control, input } = fixture()
  await client.dispatch({ operation: "link", projectId: "project-one", workcellId: id })
  const other = createProjectWorkcells({ ...input, origin: "http://127.0.0.1:8999" })
  expect((await other.dispatch({ operation: "inspect", projectId: "project-one" })).status).toBe("local")
  control.journal = { version: 99, entries: {} }
  expect((await client.dispatch({ operation: "create", projectId: "project-two", metadata })).errorCode).toBe(
    "PROJECT_LINK_STORE_UNAVAILABLE",
  )
  expect(control.journal).toEqual({ version: 99, entries: {} })
  expect(control.calls).toHaveLength(1)
})

test("encrypted native journal restores a linked project without reading the local project directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "ps-workcell-link-"))
  roots.push(root)
  const key = randomBytes(32)
  const encryption = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => {
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, iv)
      return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()])
    },
    decryptString: (value: Buffer) => {
      const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12))
      decipher.setAuthTag(value.subarray(-16))
      return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString()
    },
  }
  const { input } = fixture()
  const file = join(root, "workcell-projects.enc")
  const make = () => {
    const vault = createCredentialVault(file, encryption)
    return createProjectWorkcells({
      ...input,
      store: {
        read: async () => ((await vault.request("all", {})) as Record<string, unknown>).journal,
        write: async (journal) => {
          await vault.request("set", { key: "journal", info: journal })
        },
      },
    })
  }
  await make().dispatch({ operation: "create", projectId: "project-one", metadata })
  expect((await make().dispatch({ operation: "inspect", projectId: "project-one" })).workcell?.id).toBe(id)
  const encrypted = await readFile(file)
  expect(encrypted.includes(Buffer.from("Simulation test"))).toBe(false)
  expect(encrypted.includes(Buffer.from("account-a"))).toBe(false)
})

test("automatic draft registration binds the first account before network and retries the exact payload after restart", async () => {
  const { client, control, input } = fixture()
  control.request = async () => {
    throw new Error("Offline")
  }
  const pending = await client.dispatch({
    operation: "ensure",
    projectId: "project-one",
    metadata: { name: "Simulation test", task: "" },
  })
  expect(pending.status).toBe("pending")
  expect(pending.pendingOperation).toBe("ensure")
  const original = structuredClone(control.calls[0])
  expect(original.path).toBe("/api/workcells/ensure")
  expect(original.body).toEqual({
    requestId: expect.any(String),
    localProjectId: "project-one",
    name: "Simulation test",
    task: "",
  })
  expect(JSON.stringify(control.journal)).toContain((original.body as { requestId: string }).requestId)
  control.account.account = { id: "account-b", name: "B", email: "b@example.invalid" }
  control.generation++
  const restarted = createProjectWorkcells(input)
  const blocked = await restarted.dispatch({
    operation: "ensure",
    projectId: "project-one",
    metadata: { name: "Changed local name", task: "" },
  })
  expect(blocked.errorCode).toBe("PROJECT_ACCOUNT_MISMATCH")
  expect(blocked.workcell).toBeNull()
  expect(blocked.pendingMetadata).toBeUndefined()
  for (const operation of ["inspect", "refresh", "create"])
    expect(
      (
        await restarted.dispatch({
          operation,
          projectId: "project-one",
          ...(operation === "create" ? { metadata } : {}),
        })
      ).errorCode,
    ).toBe("PROJECT_ACCOUNT_MISMATCH")
  expect(control.calls).toHaveLength(1)
  control.account.account = { id: "account-a", name: "A", email: "a@example.invalid" }
  control.generation++
  control.request = async () => ({ workcell: { ...room(), task: "" }, replayed: true })
  const linked = await restarted.dispatch({
    operation: "ensure",
    projectId: "project-one",
    metadata: { name: "Changed local name", task: "" },
  })
  expect(linked.status).toBe("linked")
  expect(linked.workcell?.task).toBe("")
  expect(control.calls[1]).toEqual(original)
  await restarted.dispatch({
    operation: "ensure",
    projectId: "project-one",
    metadata: { name: "Changed local name", task: "" },
  })
  expect(control.calls).toHaveLength(2)
})

test("automatic registration requires the new disclosed session and retains existing manual mappings without cloud overwrites", async () => {
  const { client, control } = fixture()
  control.automatic = false
  expect(
    (
      await client.dispatch({
        operation: "ensure",
        projectId: "project-one",
        metadata: { name: "Simulation test", task: "" },
      })
    ).errorCode,
  ).toBe("AUTOMATIC_SYNC_DISABLED")
  expect(control.calls).toHaveLength(0)
  expect(control.journal).toBeUndefined()
  await client.dispatch({ operation: "link", projectId: "project-one", workcellId: id })
  control.automatic = true
  const linked = await client.dispatch({
    operation: "ensure",
    projectId: "project-one",
    metadata: { name: "Local name", task: "" },
  })
  expect(linked.workcell?.name).toBe(metadata.name)
  expect(control.calls).toHaveLength(1)
  expect(control.calls[0].method).toBe("GET")
  control.account.account = { id: "account-b", name: "B", email: "b@example.invalid" }
  control.generation++
  expect(
    (
      await client.dispatch({
        operation: "ensure",
        projectId: "project-one",
        metadata: { name: "Local name", task: "" },
      })
    ).errorCode,
  ).toBe("PROJECT_ACCOUNT_MISMATCH")
  expect(control.calls).toHaveLength(1)
})

test("failed ownership persistence, account changes during save and extra metadata never authorize automatic upload", async () => {
  const { client, control, input } = fixture()
  control.failWrite = true
  expect(
    (
      await client.dispatch({
        operation: "ensure",
        projectId: "project-one",
        metadata: { name: "Simulation test", task: "" },
      })
    ).errorCode,
  ).toBe("PROJECT_LINK_STORE_UNAVAILABLE")
  expect(control.calls).toHaveLength(0)
  control.failWrite = false
  const write = input.store.write
  input.store.write = async (value) => {
    await write(value)
    control.account.account = { id: "account-b", name: "B", email: "b@example.invalid" }
    control.generation++
  }
  const switched = await client.dispatch({
    operation: "ensure",
    projectId: "project-one",
    metadata: { name: "Simulation test", task: "" },
  })
  expect(switched.errorCode).toBe("WORKCELL_SESSION_CHANGED")
  expect(control.calls).toHaveLength(0)
  expect(
    (
      await client.dispatch({
        operation: "ensure",
        projectId: "project-one",
        metadata: { name: "Simulation test", task: "" },
      })
    ).errorCode,
  ).toBe("PROJECT_ACCOUNT_MISMATCH")
  for (const raw of [
    {
      operation: "ensure",
      projectId: "project-one",
      metadata: { name: "Simulation test", task: "", objects: "not in the automatic allowlist" },
    },
    { operation: "ensure", projectId: "project\nunsafe", metadata: { name: "Simulation test", task: "" } },
  ])
    await expect(client.dispatch(raw)).rejects.toThrow("INVALID_PROJECT_REQUEST")
  expect(control.calls).toHaveLength(0)
})
