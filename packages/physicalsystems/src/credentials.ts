// SPDX-License-Identifier: Apache-2.0
import { mkdir, lstat, readFile, open, rename, unlink } from "node:fs/promises"
import { dirname } from "node:path"
import { randomUUID } from "node:crypto"

export type Encryption = {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): string
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

/** Separate native encrypted provider vault. No plaintext fallback or ambient import. */
export function createCredentialVault(file: string, encryption: Encryption) {
  let queue = Promise.resolve<unknown>(undefined)
  function available() {
    if (!encryption.isEncryptionAvailable() || encryption.getSelectedStorageBackend?.() === "basic_text") {
      throw new Error("NATIVE_CREDENTIAL_STORE_UNAVAILABLE")
    }
  }
  async function read() {
    const stat = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
      return undefined
    })
    if (!stat) return {} as Record<string, unknown>
    available()
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error("INVALID_CREDENTIAL_STORE")
    const value: unknown = JSON.parse(encryption.decryptString(await readFile(file)))
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_CREDENTIAL_STORE")
    return value as Record<string, unknown>
  }
  async function write(value: Record<string, unknown>) {
    available()
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    const temporary = `${file}.${randomUUID()}.tmp`
    const encrypted = encryption.encryptString(JSON.stringify(value))
    if (encrypted.length > 1024 * 1024) throw new Error("CREDENTIAL_STORE_FULL")
    const handle = await open(temporary, "wx", 0o600)
    await (async () => {
      await handle.writeFile(encrypted)
      await handle.sync()
    })().finally(() => handle.close())
    await rename(temporary, file).catch(async (error) => { await unlink(temporary).catch(() => {}); throw error })
  }
  return {
    async request(operation: string, input: Record<string, unknown>) {
      const task = queue.catch(() => {}).then(async () => {
        if (operation === "all") return read()
        if (!["set", "remove"].includes(operation) || typeof input.key !== "string" || !/^[a-zA-Z0-9._/-]{1,256}$/.test(input.key)) {
          throw new Error("INVALID_CREDENTIAL_REQUEST")
        }
        const key = input.key.replace(/\/+$/, "")
        if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("INVALID_CREDENTIAL_REQUEST")
        const value = await read()
        if (operation === "remove") delete value[key]
        if (operation === "set") {
          if (!input.info || typeof input.info !== "object" || Array.isArray(input.info)) throw new Error("INVALID_CREDENTIAL_REQUEST")
          value[key] = input.info
        }
        await write(value)
        return { saved: true }
      })
      queue = task
      return task
    },
  }
}
