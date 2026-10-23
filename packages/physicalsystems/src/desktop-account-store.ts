// SPDX-License-Identifier: Apache-2.0
import { join } from "node:path"
import { mkdir, open, lstat, unlink } from "node:fs/promises"
import { createCredentialVault } from "./credentials"
import type { Encryption } from "./credentials"

/** Native identity storage. Non-secret markers remain usable with a locked keyring. */
export function createDesktopAccountStore(directory: string, encryption: Encryption) {
  const file = join(directory, "desktop-account.enc")
  const managed = join(directory, "desktop-account.managed")
  const signedOut = join(directory, "desktop-account.signed-out")
  const vault = createCredentialVault(file, encryption)
  async function exists(path: string) {
    return Boolean(
      await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error
        return undefined
      }),
    )
  }
  async function mark(path: string) {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const handle = await open(path, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error
      return undefined
    })
    if (!handle) {
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("SECURE_STORE_UNAVAILABLE")
      return
    }
    await handle
      .writeFile("1\n")
      .then(() => handle.sync())
      .finally(() => handle.close())
  }
  const remove = (path: string) =>
    unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
  return {
    available: () => encryption.isEncryptionAvailable() && encryption.getSelectedStorageBackend?.() !== "basic_text",
    managed: () => exists(managed),
    markManaged: () => mark(managed),
    async get() {
      // An interrupted logout, or a vault file Windows could not unlink, must
      // never restore the previous account on the next app launch.
      if (await exists(signedOut)) return null
      return ((await vault.request("all", {})) as Record<string, unknown>).account ?? null
    },
    async set(info: Record<string, unknown>) {
      await vault.request("set", { key: "account", info })
      // Clearing the logout marker is safe only after the replacement journal
      // has reached the encrypted vault. Core serializes this with sign-out.
      await remove(signedOut)
    },
    async clear() {
      await mark(signedOut)
      await remove(file)
    },
  }
}
