// SPDX-License-Identifier: Apache-2.0
import { app, safeStorage } from "electron"
import { createDesktopAccountStore } from "../../../physicalsystems/src/desktop-account-store"
import { createDesktopAccount } from "../../../physicalsystems/src/desktop-account"
import { openPhysicalExternalURL } from "./external-opener"

export function createDesktopIdentity() {
  return createDesktopAccount({
    store: createDesktopAccountStore(app.getPath("userData"), safeStorage),
    openBrowser: openPhysicalExternalURL,
  })
}
