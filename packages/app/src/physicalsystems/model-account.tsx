// SPDX-License-Identifier: Apache-2.0
import { createContext, onCleanup, onMount, useContext, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import type {
  ModelAccountBridge,
  ModelAccountState,
  RobotModelSelection,
} from "../../../physicalsystems/src/model-account-types"

function createAccount(bridge?: ModelAccountBridge) {
  const [state, setState] = createStore<{ snapshot?: ModelAccountState; pending: boolean; failed: boolean }>({
    pending: false,
    failed: false,
  })
  const update = (snapshot: ModelAccountState) => {
    if (state.snapshot && snapshot.revision < state.snapshot.revision) return
    setState({ snapshot, failed: false })
  }
  const call = async (operation: () => Promise<ModelAccountState> | undefined) => {
    if (!bridge || state.pending) return
    setState({ pending: true, failed: false })
    await operation()
      ?.then(update, () => setState("failed", true))
      .finally(() => setState("pending", false))
  }
  return {
    enabled: Boolean(bridge),
    state,
    update,
    refresh: () => call(() => bridge?.refresh()),
    signIn: () => call(() => bridge?.signIn()),
    signOut: () => call(() => bridge?.signOut()),
    cancel: () => call(() => bridge?.cancelSignIn()),
    company: (id: string) => call(() => bridge?.company(id)),
    select: (selection: RobotModelSelection | null) => call(() => bridge?.select(selection)),
  }
}
const Context = createContext<ReturnType<typeof createAccount>>()
export function ModelAccountProvider(props: ParentProps<{ bridge?: ModelAccountBridge }>) {
  const account = createAccount(props.bridge)
  onMount(() => {
    const unsubscribe = props.bridge?.subscribe(account.update)
    void account.refresh()
    onCleanup(() => unsubscribe?.())
  })
  return <Context.Provider value={account}>{props.children}</Context.Provider>
}
export function useModelAccount() {
  return useContext(Context)
}
