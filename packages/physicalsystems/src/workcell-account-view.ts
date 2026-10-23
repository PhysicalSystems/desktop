// SPDX-License-Identifier: Apache-2.0
import type { DesktopAccount } from "./desktop-account"
import type { createWorkcellAccount } from "./workcell-account"
import type { WorkcellAccountState } from "./workcell-account-types"

/** Old scoped credentials remain usable until the user chooses the unified account sign-in. */
export function createWorkcellAccountView(
  shared: DesktopAccount,
  legacy: ReturnType<typeof createWorkcellAccount>,
  changed: (state: WorkcellAccountState) => void,
) {
  let revision = 0
  const listeners = new Set<(state: WorkcellAccountState) => void>()
  const snapshot = () => ({ ...(shared.managed() ? shared.snapshot() : legacy.snapshot()), revision })
  const publish = () => {
    revision++
    const state = snapshot()
    changed(state)
    for (const listener of listeners) listener(state)
    return state
  }
  const unsubscribe = shared.subscribe(() => {
    if (shared.managed()) publish()
  })
  return {
    snapshot,
    generation: () => (shared.managed() ? shared.generation() * 2 + 1 : legacy.generation() * 2),
    automaticSyncEnabled: () => shared.managed() && shared.snapshot().status === "signed_in",
    legacyChanged() {
      if (!shared.managed()) publish()
    },
    async refresh() {
      await shared.refresh()
      if (!shared.managed()) await legacy.refresh()
      return publish()
    },
    async signIn() {
      await shared.signIn()
      return publish()
    },
    async cancelSignIn() {
      await (shared.managed() ? shared.cancelSignIn() : legacy.cancelSignIn())
      return publish()
    },
    async signOut() {
      await (shared.managed() ? shared.signOut() : legacy.signOut())
      return publish()
    },
    request(method: unknown, path: unknown, body?: unknown) {
      return shared.managed() ? shared.request(method, path, body) : legacy.request(method, path, body)
    },
    subscribe(listener: (state: WorkcellAccountState) => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      unsubscribe()
      listeners.clear()
      legacy.dispose()
    },
  }
}
