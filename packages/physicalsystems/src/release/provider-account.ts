// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto"
import type { ChildProcess } from "node:child_process"

const digest = (value: string) => createHash("sha256").update(value).digest("hex")

/** Called only after the actual provider vault has acknowledged a write.
 * Ordinary desktop use emits nothing. Neither tokens nor account IDs leave main. */
export function providerAccountMarker(operation: unknown, input: unknown, result: unknown, env: NodeJS.ProcessEnv) {
  if (
    env.PHYSICALSYSTEMS_PROVIDER_REVIEW !== "openai-device" ||
    env.PHYSICALSYSTEMS_QUALIFICATION_TRACE !== "1" ||
    !/^[a-f0-9]{64}$/.test(env.PHYSICALSYSTEMS_PROVIDER_REVIEW_NONCE ?? "")
  )
    return
  const name = "physicalsystems.v2." + digest("openai")
  const read = operation === "all"
  if (!result || typeof result !== "object") return
  if (!read && (operation !== "set" || !("saved" in result) || result.saved !== true)) return
  if (!read && (!input || typeof input !== "object" || !("key" in input) || input.key !== name || !("info" in input)))
    return
  const info = read ? (result as Record<string, unknown>)[name] : (input as { info: unknown }).info
  if (
    !info ||
    typeof info !== "object" ||
    !("kind" in info) ||
    info.kind !== "physicalsystems-v2-credential" ||
    !("record" in info)
  )
    return
  const record = info.record
  if (
    !record ||
    typeof record !== "object" ||
    !("integrationID" in record) ||
    record.integrationID !== "openai" ||
    !("id" in record) ||
    typeof record.id !== "string" ||
    !/^cred_[a-zA-Z0-9]{1,128}$/.test(record.id) ||
    !("value" in record)
  )
    return
  const value = record.value
  if (
    !value ||
    typeof value !== "object" ||
    !("type" in value) ||
    value.type !== "oauth" ||
    !("methodID" in value) ||
    value.methodID !== "chatgpt-headless" ||
    !("metadata" in value)
  )
    return
  if (
    !("access" in value) ||
    typeof value.access !== "string" ||
    !value.access ||
    !("refresh" in value) ||
    typeof value.refresh !== "string" ||
    !value.refresh
  )
    return
  const metadata = value.metadata
  if (
    !metadata ||
    typeof metadata !== "object" ||
    !("accountID" in metadata) ||
    typeof metadata.accountID !== "string" ||
    !metadata.accountID ||
    metadata.accountID.length > 512
  )
    return
  const nonce = env.PHYSICALSYSTEMS_PROVIDER_REVIEW_NONCE!
  return `PHYSICALSYSTEMS_PROVIDER_ACCOUNT_${read ? "READ" : "WRITE"} ${digest(nonce)} ${record.id} ${digest(JSON.stringify([nonce, "openai", record.id, metadata.accountID]))}\n`
}

/** Parse only fixed markers from the independently owned app's private log.
 * A matching credential ID comes from the exact completed V2 OAuth attempt. */
export function observeProviderAccount(log: string, nonce: string, credentialID: string) {
  if (
    Buffer.byteLength(log) > 1024 * 1024 ||
    !/^[a-f0-9]{64}$/.test(nonce) ||
    !/^cred_[a-zA-Z0-9]{1,128}$/.test(credentialID)
  )
    throw new Error("PROVIDER_REVIEW_ACCOUNT_UNCONFIRMED")
  const writePrefix = `PHYSICALSYSTEMS_PROVIDER_ACCOUNT_WRITE ${digest(nonce)} ${credentialID} `
  const readPrefix = `PHYSICALSYSTEMS_PROVIDER_ACCOUNT_READ ${digest(nonce)} ${credentialID} `
  const lines = log.split("\n").map((line) => line.replace(/\r$/, ""))
  const values = new Set(
    lines
      .filter((line) => line.startsWith(writePrefix) || line.startsWith(readPrefix))
      .map((line) => line.slice(line.startsWith(writePrefix) ? writePrefix.length : readPrefix.length)),
  )
  if (!values.size) return
  if (values.size !== 1 || !/^[a-f0-9]{64}$/.test([...values][0]!))
    throw new Error("PROVIDER_REVIEW_ACCOUNT_UNCONFIRMED")
  return {
    credentialID,
    accountFingerprint: [...values][0]!,
    nativeWriteObserved: lines.some((line) => line.startsWith(writePrefix)),
    nativeReadObserved: lines.some((line) => line.startsWith(readPrefix)),
  }
}

/** Listen before the OAuth request. Retain fixed markers only, with bounded
 * partial-line storage; arbitrary application output is never returned. */
export function watchProviderAccount(child: Pick<ChildProcess, "stderr">, nonce: string) {
  let tail = ""
  const markers = new Set<string>()
  let overflow = false
  const listen = (chunk: Buffer | string) => {
    const lines = (tail + chunk.toString()).split("\n")
    tail = lines.pop()!.slice(-512)
    for (const line of lines) {
      if (
        !/^PHYSICALSYSTEMS_PROVIDER_ACCOUNT_(READ|WRITE) [a-f0-9]{64} cred_[a-zA-Z0-9]{1,128} [a-f0-9]{64}\r?$/.test(
          line,
        )
      )
        continue
      if (markers.size >= 8 && !markers.has(line)) {
        overflow = true
        continue
      }
      markers.add(line)
    }
  }
  child.stderr?.on("data", listen)
  return {
    result(credentialID: string) {
      if (overflow) throw new Error("PROVIDER_REVIEW_ACCOUNT_UNCONFIRMED")
      return observeProviderAccount([...markers].join("\n"), nonce, credentialID)
    },
    dispose() {
      child.stderr?.off("data", listen)
      markers.clear()
      tail = ""
    },
  }
}
