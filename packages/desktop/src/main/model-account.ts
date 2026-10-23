// SPDX-License-Identifier: Apache-2.0
import { unlink } from "node:fs/promises"
import { join } from "node:path"
import { app, BrowserWindow, safeStorage } from "electron"
import { createCredentialVault } from "../../../physicalsystems/src/credentials"
import { createModelAccount } from "../../../physicalsystems/src/model-account"
import type { DesktopAccount } from "../../../physicalsystems/src/desktop-account"
import { trustedRenderer } from "../../../physicalsystems/src/renderer-authority"
import { openPhysicalExternalURL } from "./external-opener"

export function createDesktopModelAccount(shared: DesktopAccount) {
  const file = join(app.getPath("userData"), "company-account.enc")
  const vault = createCredentialVault(file, safeStorage)
  const models = createModelAccount({
    shared,
    store: {
      available: () =>
        safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== "basic_text",
      get: async () => ((await vault.request("all", {})) as Record<string, unknown>).account ?? null,
      set: async (info) => {
        await vault.request("set", { key: "account", info })
      },
      // Dedicated account file: logout remains possible even when the keyring is locked.
      clear: async () => {
        await unlink(file).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error
        })
      },
    },
    openBrowser: openPhysicalExternalURL,
    changed: (state) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (
          !window.isDestroyed() &&
          trustedRenderer({
            windowMatches: true,
            mainFrame: true,
            url: window.webContents.getURL(),
            developmentURL: process.env.ELECTRON_RENDERER_URL,
            packaged: app.isPackaged,
          })
        )
          window.webContents.send("physicalsystems:models-state", state)
      }
    },
  })
  let identity = ""
  const unsubscribe = shared.subscribe((state) => {
    const next = JSON.stringify([state.status, state.account?.id, state.sessionId, state.pending, state.error])
    if (next === identity) return
    identity = next
    models.syncShared()
  })
  return {
    ...models,
    dispose() {
      unsubscribe()
      models.dispose()
    },
  }
}
