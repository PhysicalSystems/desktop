// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  checkPreviewUpdater,
  previewStorageReady,
  readPersistedPreviewSetting,
  readPreviewSetting,
  writePreviewSetting,
} from "./preview-update-state.mjs"

const name = "opencode.preview-updater.dat"
const key = "preview-updater-test"

test("updater preservation uses each installed bridge and reads its acknowledged state", async () => {
  for (const version of [1, 2]) {
    const entries: Record<string, string> = {}
    let seeded = version === 2
    const api =
      version === 1
        ? {
            storeSet: async (_name: string, id: string, value: string) => {
              entries[id] = value
            },
            storeGet: async (_name: string, id: string) => entries[id],
          }
        : {
            storeUpdate: async (_name: string, insert: Record<string, string>, remove: string[]) => {
              Object.assign(entries, insert)
              remove.forEach((id) => delete entries[id])
            },
            storeItems: async () => {
              if (seeded) {
                seeded = false
                return { items: {} }
              }
              return { items: { ...entries } }
            },
          }
    expect(previewStorageReady(api)).toBe(true)
    await writePreviewSetting(api, name, key, "inert-nonce")
    expect(await readPreviewSetting(api, name, key)).toBe("inert-nonce")
    const updater = { check: async () => ({ status: "available", version }) }
    expect(await checkPreviewUpdater(version === 1 ? { api: { updater } } : { electron: { updater } })).toEqual({
      status: "available",
      version,
    })
  }
  expect(previewStorageReady({})).toBe(false)
  expect(() => checkPreviewUpdater({})).toThrow("PREVIEW_UPDATE_BRIDGE_UNAVAILABLE")
})

test("installed payload selects persistent state without accepting a stale other-generation copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "physical-preview-state-"))
  const archive = (version: number) => ({
    read(member: string) {
      if (member !== (version === 1 ? "out/preload/index.js" : "out/preload/index.cjs"))
        throw Error("PACKAGED_RUNTIME_READ_FAILED")
      return Buffer.from("inert-payload")
    },
  })
  try {
    const db = new Database(join(root, "drafts.sqlite"))
    db.exec("CREATE TABLE state (name TEXT, key TEXT, value TEXT)")
    db.query("INSERT INTO state VALUES (?, ?, ?)").run(name, key, "v2-nonce")
    db.close()
    await writeFile(join(root, name), JSON.stringify({ [key]: "v1-nonce" }))
    for (const version of [1, 2]) {
      expect(await readPersistedPreviewSetting({ archive: archive(version), userData: root, name, key })).toBe(
        `v${version}-nonce`,
      )
    }
    await rm(join(root, name))
    await expect(readPersistedPreviewSetting({ archive: archive(1), userData: root, name, key })).rejects.toThrow()
    await expect(
      readPersistedPreviewSetting({ archive: archive(2), userData: root, name, key: "missing" }),
    ).resolves.toBeUndefined()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
