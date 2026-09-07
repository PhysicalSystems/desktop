// SPDX-License-Identifier: Apache-2.0
import type { ChildProcess } from "node:child_process"

export const credentialBackends = ["windows_dpapi", "gnome_libsecret", "kwallet", "kwallet5", "kwallet6"] as const
export type CredentialBackend = (typeof credentialBackends)[number]

/** Fixed availability metadata only; never reads a credential or substitutes encryption. */
export function credentialBackend(
  storage: {
    isEncryptionAvailable(): boolean
    getSelectedStorageBackend?(): string
  },
  platform: NodeJS.Platform = process.platform,
): CredentialBackend | undefined {
  if (!storage.isEncryptionAvailable()) return
  if (platform === "win32") return "windows_dpapi"
  if (platform !== "linux") return
  const selected = storage.getSelectedStorageBackend?.()
  return credentialBackends.find((value) => value !== "windows_dpapi" && value === selected)
}

/** Observe only a fixed trace from the owned main process after a successful
 * native vault operation. Missing/mixed backends cannot become a native PASS. */
export function observeCredentialBackend(child: ChildProcess, platform: NodeJS.Platform = process.platform) {
  let tail = ""
  let backend: CredentialBackend | undefined
  let mixed = false
  const observe = (chunk: Buffer | string) => {
    const input = tail + chunk.toString()
    const end = input.lastIndexOf("\n")
    const lines = end < 0 ? [] : input.slice(0, end).split("\n")
    tail = (end < 0 ? input : input.slice(end + 1)).slice(-128)
    for (const line of lines) {
      const value = credentialBackends.find((name) => line.replace(/\r$/, "") === `PHYSICALSYSTEMS_CREDENTIAL_${name}`)
      if (!value) continue
      if (backend && backend !== value) mixed = true
      backend = value
    }
  }
  child.stderr?.on("data", observe)
  return {
    result() {
      const expected = platform === "win32" ? "windows_dpapi" : platform === "linux" ? "gnome_libsecret" : undefined
      if (!expected || mixed || backend !== expected) throw new Error("CREDENTIAL_PROBE_BACKEND_UNCONFIRMED")
      return backend
    },
    dispose() {
      child.stderr?.off("data", observe)
      tail = ""
    },
  }
}
