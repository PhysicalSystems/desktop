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

  async function connections(run: V2CredentialProbeRequest) {
    const result = await request(run, `/api/integration/${providerID}`, { method: "GET" })
    if (!result || typeof result !== "object" || !("data" in result)) throw new Error()
    const data = result.data
    if (
      !data ||
      typeof data !== "object" ||
      !("id" in data) ||
      data.id !== providerID ||
      !("connections" in data) ||
      !Array.isArray(data.connections)
    )
      throw new Error()
    return data.connections.map((connection: unknown) => {
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
  }

  return {
    providerID,
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
    /** A nonce-matched request arrived; finishObservation still validates auth. */
    observationReady: () => state.observed,
    finishObservation: probe.finishObservation,
    async save(run: V2CredentialProbeRequest) {
      try {
        if (state.credentialID || (await connections(run)).length) throw new Error()
        await probe.save(async (_route, init) => {
          state.canary = init.body!.key
          const result = await request(run, `/api/integration/${providerID}/connect/key`, {
            method: "POST",
            body: { key: state.canary, label: "Inert native V2 qualification fixture" },
          })
          if (result !== undefined) throw new Error()
          return true
        })
        const ids = await connections(run)
        if (ids.length !== 1) throw new Error()
        state.credentialID = ids[0]
      } catch {
        throw new Error("V2_CREDENTIAL_PROBE_AUTH_UNCONFIRMED")
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
