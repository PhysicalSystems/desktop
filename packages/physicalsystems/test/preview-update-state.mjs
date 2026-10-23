// SPDX-License-Identifier: Apache-2.0
import { Database } from "bun:sqlite"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

// These functions are also serialized into the installed renderer. Keep them
// self-contained so the probe exercises each installed generation's real bridge.
export function previewStorageReady(api) {
  return Boolean(api && ((api.storeItems && api.storeUpdate) || (api.storeGet && api.storeSet)))
}

export function checkPreviewUpdater(bridges) {
  const updater = bridges.electron?.updater ?? bridges.api?.updater
  if (typeof updater?.check !== "function") throw Error("PREVIEW_UPDATE_BRIDGE_UNAVAILABLE")
  return updater.check()
}

export async function writePreviewSetting(api, name, key, value) {
  if (typeof api.storeUpdate === "function" && typeof api.storeItems === "function") {
    // Consume any startup snapshot before checking a subsequent write.
    await api.storeItems(name)
    await api.storeUpdate(name, { [key]: value }, [])
    return
  }
  if (typeof api.storeSet !== "function") throw Error("PREVIEW_UPDATE_STORAGE_UNAVAILABLE")
  await api.storeSet(name, key, value)
}

export async function readPreviewSetting(api, name, key) {
  if (typeof api.storeItems === "function") return (await api.storeItems(name)).items[key]
  if (typeof api.storeGet !== "function") throw Error("PREVIEW_UPDATE_STORAGE_UNAVAILABLE")
  return api.storeGet(name, key)
}

/** Pick storage from the verified running payload, never from leftover profile
 * files: a V1 target must not pass by reading a V2 database it cannot use. */
export async function readPersistedPreviewSetting({ archive, userData, name, key }) {
  let sqlite = false
  try {
    archive.read("out/preload/index.cjs")
    sqlite = true
  } catch (error) {
    if (error?.message !== "PACKAGED_RUNTIME_READ_FAILED") throw error
    archive.read("out/preload/index.js")
  }
  if (!sqlite) return JSON.parse(await readFile(join(userData, name), "utf8"))[key]
  const db = new Database(join(userData, "drafts.sqlite"), { readonly: true })
  try {
    return db.query("SELECT value FROM state WHERE name = ? AND key = ?").get(name, key)?.value
  } finally {
    db.close()
  }
}
