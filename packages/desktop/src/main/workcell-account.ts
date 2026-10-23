// SPDX-License-Identifier: Apache-2.0
import { unlink } from "node:fs/promises"
import { join } from "node:path"
import { app, BrowserWindow, safeStorage } from "electron"
import { createCredentialVault } from "../../../physicalsystems/src/credentials"
import { createWorkcellAccount } from "../../../physicalsystems/src/workcell-account"
import { createWorkcellAccountView } from "../../../physicalsystems/src/workcell-account-view"
import type { DesktopAccount } from "../../../physicalsystems/src/desktop-account"
import type { WorkcellAccountState } from "../../../physicalsystems/src/workcell-account-types"
import { trustedRenderer } from "../../../physicalsystems/src/renderer-authority"
import { openPhysicalExternalURL } from "./external-opener"
export function createDesktopWorkcellAccount(shared: DesktopAccount) {
  const file = join(app.getPath("userData"), "workcell-account.enc")
  const vault = createCredentialVault(file, safeStorage)
  let notifyLegacy = () => {}
  const legacy = createWorkcellAccount({
    store: {
      available: () =>
        safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== "basic_text",
      get: async () => ((await vault.request("all", {})) as Record<string, unknown>).account ?? null,
      set: async (info) => {
        await vault.request("set", { key: "account", info })
      },
      clear: async () => {
        await unlink(file).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error
        })
      },
    },
    openBrowser: openPhysicalExternalURL,
    changed: () => notifyLegacy(),
  })
  const changed = (state: WorkcellAccountState) => {
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
        window.webContents.send("physicalsystems:workcells-state", state)
    }
  }
  const view = createWorkcellAccountView(shared, legacy, changed)
  notifyLegacy = view.legacyChanged
  return view
}
