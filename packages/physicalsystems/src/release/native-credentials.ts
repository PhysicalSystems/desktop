// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { lstat, open, readdir, realpath } from "node:fs/promises"
import { constants } from "node:fs"
import { isAbsolute, join, sep } from "node:path"

export type CredentialProbeRequest = (
  route: string,
  init: { method: "PUT" | "DELETE"; body?: { type: "api"; key: string }; signal: AbortSignal },
) => Promise<unknown>

/** Observations only: the caller must independently verify real packaged app
 * shutdown/restart, native backend availability and exact-artifact identity.
 * No secret-reading endpoint, encryption substitute or native PASS is provided. */
export function createNativeCredentialProbe(options: { timeoutMs?: number } = {}) {
  const timeoutMs = options.timeoutMs ?? 6500
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 6500)
    throw new Error("CREDENTIAL_PROBE_TIMEOUT_INVALID")
  const providerID = "physicalsystems-vault-fixture"
  const canary = `ps-native-probe-${randomBytes(32).toString("hex")}`
  const expectedHeader = Buffer.from(`Bearer ${canary}`)
  let observation: { prompt: string; expected: "present" | "absent"; observed: boolean; valid: boolean } | undefined

  async function mutate(request: CredentialProbeRequest, method: "PUT" | "DELETE") {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        Promise.resolve().then(() =>
          request(`/auth/${providerID}`, {
            method,
            ...(method === "PUT" ? { body: { type: "api" as const, key: canary } } : {}),
            signal: controller.signal,
          }),
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            reject(new Error("CREDENTIAL_PROBE_AUTH_UNCONFIRMED"))
          }, timeoutMs)
        }),
      ])
      if (result !== true) throw new Error("CREDENTIAL_PROBE_AUTH_UNCONFIRMED")
    } catch {
      throw new Error("CREDENTIAL_PROBE_AUTH_UNCONFIRMED")
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    providerID,
    save: (request: CredentialProbeRequest) => mutate(request, "PUT"),
    remove: (request: CredentialProbeRequest) => mutate(request, "DELETE"),
    beginObservation(expected: "present" | "absent") {
      if (!["present", "absent"].includes(expected)) throw new Error("CREDENTIAL_PROBE_EXPECTATION_INVALID")
      if (observation) throw new Error("CREDENTIAL_PROBE_OBSERVATION_PENDING")
      observation = {
        prompt: `Record inert credential check ${randomBytes(24).toString("hex")}.`,
        expected,
        observed: false,
        valid: true,
      }
      return observation.prompt
    },
    /** Call only for the inert fixture's parsed chat-completions request. */
    observeProviderRequest(input: { authorization: unknown; messages: unknown }) {
      if (!observation || !Array.isArray(input.messages)) return false
      const prompt = observation.prompt
      const matches = input.messages.some((message) => {
        if (!message || typeof message !== "object" || message.role !== "user") return false
        return (
          message.content === prompt ||
          (Array.isArray(message.content) &&
            message.content.some(
              (part: unknown) =>
                !!part &&
                typeof part === "object" &&
                "type" in part &&
                part.type === "text" &&
                "text" in part &&
                part.text === prompt,
            ))
        )
      })
      if (!matches) return false
      const header =
        typeof input.authorization === "string" && input.authorization.length <= 512
          ? Buffer.from(input.authorization)
          : Buffer.alloc(0)
      const matched = header.length === expectedHeader.length && timingSafeEqual(header, expectedHeader)
      const absent = input.authorization === undefined || input.authorization === null
      observation.observed = true
      observation.valid &&= observation.expected === "present" ? matched : absent
      return true
    },
    finishObservation() {
      const current = observation
      observation = undefined
      if (!current?.observed || !current.valid) throw new Error("CREDENTIAL_PROBE_RETRIEVAL_UNCONFIRMED")
      return {
        requestObserved: true as const,
        authorizationMatched: current.expected === "present",
        authorizationAbsent: current.expected === "absent",
      }
    },
    async inspectFiles(profile: string) {
      try {
        if (!isAbsolute(profile)) throw new Error()
        const rootStat = await lstat(profile)
        if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error()
        const root = await realpath(profile)
        const operator = join(root, "operator")
        const operatorStat = await lstat(operator)
        if (!operatorStat.isDirectory() || operatorStat.isSymbolicLink() || (await realpath(operator)) !== operator)
          throw new Error()
        // Inspect only fixed provider-vault paths, never the separate operator
        // credential store, runtime attachment, profile tree or a live keyring.
        const file = join(operator, "provider-credentials.enc")
        const before = await lstat(file)
        if (
          !before.isFile() ||
          before.isSymbolicLink() ||
          before.nlink !== 1 ||
          !before.size ||
          before.size > 1024 ** 2
        )
          throw new Error()
        const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
        const bytes = await (async () => {
          const stat = await handle.stat()
          if (
            !stat.isFile() ||
            stat.dev !== before.dev ||
            stat.ino !== before.ino ||
            stat.size !== before.size ||
            stat.nlink !== 1
          )
            throw new Error()
          const buffer = Buffer.alloc(stat.size)
          let count = 0
          while (count < buffer.length) {
            const result = await handle.read(buffer, count, buffer.length - count, count)
            if (!result.bytesRead) throw new Error()
            count += result.bytesRead
          }
          const after = await handle.stat()
          if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)
            throw new Error()
          return buffer
        })().finally(() => handle.close())
        if (bytes.includes(Buffer.from(canary)) || bytes.includes(Buffer.from(canary, "utf16le"))) throw new Error()
        if (
          (await readdir(operator)).some(
            (name) => name.startsWith("provider-credentials.enc.") && name.endsWith(".tmp"),
          )
        )
          throw new Error()
        // The bundled v1 Auth fallback uses XDG_DATA_HOME/opencode/auth.json.
        // Walk fixed parents without following symlinks; absence is expected in
        // this fresh test profile, even after successful native credential writes.
        let legacy = root
        for (const part of ["data", "opencode", "auth.json"]) {
          legacy = join(legacy, part)
          const stat = await lstat(legacy).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined
            throw error
          })
          if (!stat) break
          if (stat.isSymbolicLink() || !legacy.startsWith(root + sep) || part === "auth.json" || !stat.isDirectory())
            throw new Error()
        }
        return {
          vaultPresent: true as const,
          vaultBytes: bytes.length,
          vaultSha256: createHash("sha256").update(bytes).digest("hex"),
          canaryAbsentFromVaultBytes: true as const,
          legacyAuthFileAbsent: true as const,
        }
      } catch {
        throw new Error("CREDENTIAL_PROBE_STORAGE_UNCONFIRMED")
      }
    },
  }
}
