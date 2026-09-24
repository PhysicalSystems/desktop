// SPDX-License-Identifier: Apache-2.0
import { unlink } from "node:fs/promises"
import { join } from "node:path"
import { app, BrowserWindow, safeStorage } from "electron"
import { createCredentialVault } from "../../../physicalsystems/src/credentials"
import { createModelAccount } from "../../../physicalsystems/src/model-account"
import { trustedRenderer } from "../../../physicalsystems/src/renderer-authority"
import { openExternalURL } from "./windows"

export function createDesktopModelAccount() {
  const file = join(app.getPath("userData"), "company-account.enc")
  const vault = createCredentialVault(file, safeStorage)
  return createModelAccount({
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
    openBrowser: openExternalURL,
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
}
