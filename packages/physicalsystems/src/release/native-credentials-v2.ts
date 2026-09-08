// SPDX-License-Identifier: Apache-2.0
import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { createNativeCredentialProbe } from "./native-credentials"

/** The caller binds every request to its authenticated, owned sidecar and exact
 * Location. GET returns the decoded wire envelope; successful mutations return
 * undefined only after the expected HTTP 204. Never log request bodies. */
export type V2CredentialProbeRequest = (
  route: string,
  init: { method: "GET" | "POST" | "DELETE"; body?: { key: string; label: string }; signal: AbortSignal },
) => Promise<unknown>

type IntegrationBoundary =
  | "idle"
  | "integration-request"
  | "integration-envelope"
  | "integration-data"
  | "integration-id"
  | "integration-connections"
  | "integration-methods"
  | "preexisting-connection"
  | "integration-pending"
  | "integration-ready"

/** Inert transport/storage observations, not native encryption qualification.
 * The caller independently proves artifact identity and actual process restarts.
 * Uses the same V2 integration/credential routes as the rendered provider dialog. */
export function createNativeV2CredentialProbe(options: { timeoutMs?: number; providerID?: "openai" } = {}) {
  const timeoutMs = options.timeoutMs ?? 6500
  const probe = createNativeCredentialProbe({ timeoutMs })
  if (options.providerID !== undefined && options.providerID !== "openai")
    throw new Error("V2_CREDENTIAL_PROBE_PROVIDER_INVALID")
  const providerID = options.providerID ?? "physicalsystems-v2-vault-fixture"
  const state: { canary?: string; credentialID?: string; observed: boolean; removed: boolean } = {
    observed: false,
    removed: false,
  }
  let integrationState: { boundary: IntegrationBoundary; shape?: ReturnType<typeof integrationShape> } = {
    boundary: "idle",
  }

  async function request(
    run: V2CredentialProbeRequest,
    route: string,
    init: Omit<Parameters<V2CredentialProbeRequest>[1], "signal">,
  ) {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        Promise.resolve().then(() => run(route, { ...init, signal: controller.signal })),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            reject(new Error())
          }, timeoutMs)
        }),
      ])
    } catch {
      throw new Error("V2_CREDENTIAL_PROBE_AUTH_UNCONFIRMED")
    } finally {
      clearTimeout(timer)
    }
  }

  async function integration(run: V2CredentialProbeRequest, allowPending = false) {
    integrationState = { boundary: "integration-request" }
    const result = await request(run, `/api/integration/${providerID}`, { method: "GET" })
    integrationState = { boundary: "integration-envelope", shape: integrationShape(result, providerID) }
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error()
    integrationState.boundary = "integration-data"
    const data = "data" in result ? result.data : undefined
    // HttpApiEndpoint's JSON codec encodes UndefinedOr as null. An absent
    // integration is pending only during the explicitly read-only preflight;
    // post-write readback and removal still require an actual integration.
    if (allowPending && (data === undefined || data === null)) {
      if (
        !("location" in result) ||
        !result.location ||
        typeof result.location !== "object" ||
        !("directory" in result.location) ||
        typeof result.location.directory !== "string" ||
        !result.location.directory
      )
        throw new Error()
      integrationState.boundary = "integration-pending"
      return undefined
    }
    if (!data || typeof data !== "object") throw new Error()
    integrationState.boundary = "integration-id"
    if (!("id" in data) || data.id !== providerID) throw new Error()
    integrationState.boundary = "integration-connections"
    if (!("connections" in data) || !Array.isArray(data.connections)) throw new Error()
    const ids = data.connections.map((connection: unknown) => {
      if (
        !connection ||
        typeof connection !== "object" ||
        !("type" in connection) ||
        connection.type !== "credential" ||
        !("id" in connection) ||
        typeof connection.id !== "string" ||
        !/^cred_[a-zA-Z0-9]{1,128}$/.test(connection.id)
      )
        throw new Error()
      return connection.id
    })
    integrationState.boundary = "integration-ready"
    return { ids, methods: "methods" in data ? data.methods : undefined }
  }
  const connections = async (run: V2CredentialProbeRequest) => {
    const current = await integration(run)
    if (!current) throw new Error()
    return current.ids
  }
  const saveState = { phase: "idle", readinessReads: 0, readbackReads: 0, writes: 0 }
  let saveAttempted = false

  return {
    providerID,
    saveCheckpoint: () => ({ ...saveState }),
    /** Fixed shape and counts only; never retain server data, IDs or labels. */
    integrationCheckpoint: () => structuredClone(integrationState),
    logFilter: probe.logFilter,
    beginObservation(expected: "present" | "absent") {
      const prompt = probe.beginObservation(expected)
      state.observed = false
      return prompt
    },
    observeProviderRequest(input: Parameters<typeof probe.observeProviderRequest>[0]) {
      const matched = probe.observeProviderRequest(input)
      state.observed ||= matched
      return matched
    },
    /** Read-only restart readiness; never accepts a different or extra credential. */
    async savedConnectionReady(run: V2CredentialProbeRequest) {
      try {
        if (!state.credentialID || state.removed) throw new Error()
        const current = await integration(run, true)
        if (!current) return false
        const ids = current.ids
        if (ids.length > 1 || (ids.length && ids[0] !== state.credentialID)) throw new Error()
        return ids.length === 1
      } catch {
        throw new Error("V2_CREDENTIAL_PROBE_AUTH_UNCONFIRMED")
      }
    },
    /** Registration may lag after restart; absence is never inferred from it. */
    async removedConnectionReady(run: V2CredentialProbeRequest) {
      try {
        if (!state.removed || !state.credentialID) throw new Error()
        const current = await integration(run, true)
        if (!current) return false
        if (current.ids.length) throw new Error()
        return true
      } catch {
        throw new Error("V2_CREDENTIAL_PROBE_REMOVAL_UNCONFIRMED")
      }
    },
    /** A nonce-matched request arrived; finishObservation still validates auth. */
    observationReady: () => state.observed,
    finishObservation: probe.finishObservation,
    async save(run: V2CredentialProbeRequest) {
      if (saveAttempted) throw new Error("V2_CREDENTIAL_PROBE_SAVE_WRITE_UNCONFIRMED")
      saveAttempted = true
      try {
        saveState.phase = "preflight"
        if (state.credentialID) throw new Error()
        let ready = false
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          saveState.readinessReads++
          const current = await integration(run, true)
          if (!current) {
            await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))))
            continue
          }
          integrationState.boundary = "preexisting-connection"
          if (current.ids.length) throw new Error()
          integrationState.boundary = "integration-methods"
          if (
            !Array.isArray(current.methods) ||
            current.methods.some((method) => !method || typeof method !== "object" || !("type" in method))
          )
            throw new Error()
          saveState.phase = "method"
          if (current.methods.some((method) => method.type === "key")) {
            ready = true
            break
          }
          await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))))
        }
        if (!ready) throw new Error()
        saveState.phase = "write"
        saveState.writes++
        await probe.save(async (_route, init) => {
          state.canary = init.body!.key
          const result = await request(run, `/api/integration/${providerID}/connect/key`, {
            method: "POST",
            body: { key: state.canary, label: "Inert native V2 qualification fixture" },
          })
          if (result !== undefined) throw new Error()
          return true
        })
        saveState.phase = "readback"
        const until = Date.now() + timeoutMs
        while (Date.now() < until) {
          saveState.readbackReads++
          const ids = await connections(run)
          if (ids.length > 1) throw new Error()
          if (ids.length === 1) {
            state.credentialID = ids[0]
            saveState.phase = "complete"
            return
          }
          await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, until - Date.now()))))
        }
        throw new Error()
      } catch {
        throw new Error(`V2_CREDENTIAL_PROBE_SAVE_${saveState.phase.toUpperCase()}_UNCONFIRMED`)
      }
    },
    async remove(run: V2CredentialProbeRequest) {
      try {
        const ids = await connections(run)
        if (!state.credentialID || ids.length !== 1 || ids[0] !== state.credentialID) throw new Error()
        if ((await request(run, `/api/credential/${state.credentialID}`, { method: "DELETE" })) !== undefined)
          throw new Error()
        if ((await connections(run)).length) throw new Error()
        state.removed = true
      } catch {
        throw new Error("V2_CREDENTIAL_PROBE_AUTH_UNCONFIRMED")
      }
    },
    /** After a real restart, the removed integration must be disconnected and
     * unavailable to the actual V2 model runner. API failures are not absence. */
    async assertRemoved(run: V2CredentialProbeRequest) {
      try {
        if (!state.removed || !state.credentialID || (await connections(run)).length) throw new Error()
        const result = await request(run, "/api/model", { method: "GET" })
        if (!result || typeof result !== "object" || !("data" in result) || !Array.isArray(result.data))
          throw new Error()
        if (
          result.data.some(
            (model: unknown) =>
              !model ||
              typeof model !== "object" ||
              !("id" in model) ||
              typeof model.id !== "string" ||
              !("providerID" in model) ||
              typeof model.providerID !== "string" ||
              model.providerID === providerID,
          )
        )
          throw new Error()
        return { api: "v2-integration" as const, credentialAbsent: true as const, catalogUnavailable: true as const }
      } catch {
        throw new Error("V2_CREDENTIAL_PROBE_REMOVAL_UNCONFIRMED")
      }
    },
    /** Inspect only a caller-owned profile after native writes have settled.
     * Full DB/WAL/journal bytes are bounded; no row contents or paths are returned.
     * The basename must come from trusted qualifier configuration, never discovery. */
    async inspectFiles(profile: string, options: { databaseName: string }) {
      try {
        if (
          !state.canary ||
          !isAbsolute(profile) ||
          !/^opencode(?:-[a-zA-Z0-9._-]{1,64})?\.db$/.test(options.databaseName)
        )
          throw new Error()
        const vault = await probe.inspectFiles(profile)
        const root = await realpath(profile)
        let parent = root
        for (const part of ["data", "opencode"]) {
          parent = join(parent, part)
          const stat = await lstat(parent)
          if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(parent)) !== parent) throw new Error()
        }
        const inspected: { kind: "database" | "wal" | "journal"; bytes: number }[] = []
        for (const entry of [
          { suffix: "", kind: "database" },
          { suffix: "-wal", kind: "wal" },
          { suffix: "-journal", kind: "journal" },
        ] as const) {
          const file = join(parent, options.databaseName + entry.suffix)
          const before = await lstat(file).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT" && entry.suffix) return undefined
            throw error
          })
          if (!before) continue
          if (
            !before.isFile() ||
            before.isSymbolicLink() ||
            before.nlink !== 1 ||
            before.size > 64 * 1024 * 1024 ||
            (!entry.suffix && !before.size)
          )
            throw new Error()
          const handle = await open(
            file,
            constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
          )
          try {
            const stat = await handle.stat()
            if (
              !stat.isFile() ||
              stat.dev !== before.dev ||
              stat.ino !== before.ino ||
              stat.nlink !== 1 ||
              stat.size !== before.size
            )
              throw new Error()
            const patterns = [Buffer.from(state.canary), Buffer.from(state.canary, "utf16le")]
            const overlap = Math.max(...patterns.map((pattern) => pattern.length)) - 1
            let pending = Buffer.alloc(0)
            let count = 0
            while (count < stat.size) {
              const chunk = Buffer.alloc(Math.min(65536, stat.size - count))
              const result = await handle.read(chunk, 0, chunk.length, count)
              if (!result.bytesRead) throw new Error()
              count += result.bytesRead
              pending = Buffer.concat([pending, chunk.subarray(0, result.bytesRead)])
              if (patterns.some((pattern) => pending.includes(pattern))) throw new Error()
              pending = pending.subarray(Math.max(0, pending.length - overlap))
            }
            const after = await handle.stat()
            if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)
              throw new Error()
            inspected.push({ kind: entry.kind, bytes: count })
          } finally {
            await handle.close()
          }
        }
        return { ...vault, api: "v2-integration" as const, inspected, canaryAbsentFromDatabaseBytes: true as const }
      } catch {
        throw new Error("V2_CREDENTIAL_PROBE_STORAGE_UNCONFIRMED")
      }
    },
  }
}

/** Diagnostics inspect at most 256 entries per array; validation above remains
 * independent. This deliberately copies no names, IDs, labels or arbitrary keys. */
function integrationShape(result: unknown, providerID: string) {
  const kind = (value: unknown) =>
    value === undefined ? "missing" : value === null ? "null" : Array.isArray(value) ? "array" : typeof value
  const envelope = result !== null && typeof result === "object" && !Array.isArray(result)
  const data = envelope && "data" in result ? result.data : undefined
  const object = data !== null && typeof data === "object" && !Array.isArray(data)
  const connections = object && "connections" in data ? data.connections : undefined
  const methods = object && "methods" in data ? data.methods : undefined
  const connectionCounts = { credential: 0, env: 0, invalid: 0, invalidCredentialIds: 0 }
  const methodCounts = { key: 0, env: 0, oauth: 0, invalid: 0 }
  if (Array.isArray(connections))
    for (const item of connections.slice(0, 256)) {
      const type = item !== null && typeof item === "object" && !Array.isArray(item) ? item.type : undefined
      if (type === "credential") {
        connectionCounts.credential++
        if (typeof item.id !== "string" || !/^cred_[a-zA-Z0-9]{1,128}$/.test(item.id))
          connectionCounts.invalidCredentialIds++
      } else if (type === "env") connectionCounts.env++
      else connectionCounts.invalid++
    }
  if (Array.isArray(methods))
    for (const item of methods.slice(0, 256)) {
      const type = item !== null && typeof item === "object" && !Array.isArray(item) ? item.type : undefined
      if (type === "key") methodCounts.key++
      else if (type === "env") methodCounts.env++
      else if (type === "oauth") methodCounts.oauth++
      else methodCounts.invalid++
    }
  return {
    envelopeKind: kind(result),
    dataKind: kind(data),
    idMatches: object && "id" in data && data.id === providerID,
    connections: {
      kind: kind(connections),
      count: Array.isArray(connections) ? Math.min(connections.length, 256) : 0,
      truncated: Array.isArray(connections) && connections.length > 256,
      ...connectionCounts,
    },
    methods: {
      kind: kind(methods),
      count: Array.isArray(methods) ? Math.min(methods.length, 256) : 0,
      truncated: Array.isArray(methods) && methods.length > 256,
      ...methodCounts,
    },
  }
}
