// SPDX-License-Identifier: Apache-2.0
import { createContext, createMemo, onCleanup, onMount, useContext, type ParentProps } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLanguage } from "../context/language"
import { acceptsSnapshot } from "./state"
import type { PhysicalCommand, PhysicalScope, PhysicalSnapshot, PhysicalSystemsBridge } from "./types"

export function createPhysicalSystems(
  bridge: PhysicalSystemsBridge | undefined,
  failure: () => string,
  timeout: () => string,
  bindingFailure: () => string = failure,
) {
  const [state, setState] = createStore<{
    snapshot?: PhysicalSnapshot
    unavailable: boolean
    error: string
    pending: Record<string, boolean>
    failures: Record<string, string>
    view?: { serverId: string; sessionId: string }
    panel: "devices" | "setup" | "run" | "experiments"
    panelOpen: boolean
    sidebarOpen: boolean
    binding: boolean
  }>({
    unavailable: false,
    error: "",
    pending: {},
    failures: {},
    panel: "devices",
    panelOpen: true,
    sidebarOpen: true,
    binding: false,
  })
  const update = (next: PhysicalSnapshot) => {
    if (!acceptsSnapshot(state.snapshot, next)) {
      if (state.snapshot && next.serviceId !== state.snapshot.serviceId) setState("unavailable", true)
      return
    }
    setState("snapshot", reconcile(next))
    setState("unavailable", Boolean(next.hostUnavailable))
  }
  const refresh = () => bridge?.snapshot().then(update, () => setState("unavailable", true))
  const project = createMemo(() => state.snapshot?.projects.find((item) => item.id === state.snapshot?.activeProjectId))
  const bound = createMemo(() =>
    Boolean(
      state.view &&
        state.snapshot?.conversation?.sessionId === state.view.sessionId &&
        state.snapshot?.conversation?.serverId === state.view.serverId &&
        !state.binding,
    ),
  )
  const scope = (): PhysicalScope | undefined => {
    const snapshot = state.snapshot
    if (!bound() || !snapshot?.activeProjectId || !snapshot.activeConversationId) return
    return {
      projectId: snapshot.activeProjectId,
      conversationId: snapshot.activeConversationId,
      connectionGeneration: snapshot.connectionGeneration,
      serverId: snapshot.conversation?.serverId,
      sessionId: snapshot.conversation?.sessionId,
    }
  }
  // Stop uses a separate key and transport request, never the ordinary action latch.
  const send = async (request: PhysicalCommand, key = "action") => {
    if (!bridge || state.pending[key]) return
    setState("pending", key, true)
    setState("failures", key, "")
    const timer = { id: undefined as ReturnType<typeof setTimeout> | undefined }
    const result = await Promise.race([
      bridge.command(request).then((next) => {
        update(next)
        return next
      }),
      new Promise<never>((_, reject) => {
        timer.id = setTimeout(
          () => reject(new Error(timeout())),
          request.type === "workcell.commissioning.inspect" ? 45_000 : 8000,
        )
      }),
    ])
      .catch((error: unknown) => {
        if (error instanceof Error && error.message === "OPERATOR_SERVICE_UNAVAILABLE") setState("unavailable", true)
        setState(
          "failures",
          key,
          error instanceof Error && /\bMODEL_SESSION_SCOPE_MISMATCH$/.test(error.message)
            ? bindingFailure()
            : error instanceof Error && !/^[A-Z][A-Z_]+$/.test(error.message)
              ? error.message
              : failure(),
        )
        return undefined
      })
      .finally(() => {
        clearTimeout(timer.id)
        setState("pending", key, false)
      })
    return result
  }
  return {
    state,
    setState,
    enabled: Boolean(bridge),
    project,
    bound,
    scope,
    update,
    refresh,
    send,
    canRecover: Boolean(bridge?.recover),
    async recover() {
      if (!bridge?.recover || state.pending.recover || (!state.unavailable && !state.snapshot?.hostUnavailable)) return
      setState("pending", "recover", true)
      setState("failures", "recover", "")
      await bridge
        .recover()
        .then(
          (next) => {
            if (!acceptsSnapshot(undefined, next)) {
              setState("failures", "recover", failure())
              return
            }
            // A new service identity is accepted only after this explicit operator action.
            setState("snapshot", reconcile(next))
            setState("unavailable", Boolean(next.hostUnavailable))
          },
          () => setState("failures", "recover", failure()),
        )
        .finally(() => setState("pending", "recover", false))
    },
    subscribe: () => bridge?.subscribe(update),
  }
}

type PhysicalSystemsContext = ReturnType<typeof createPhysicalSystems>
const Context = createContext<PhysicalSystemsContext>()

export function PhysicalSystemsProvider(props: ParentProps<{ bridge?: PhysicalSystemsBridge }>) {
  const language = useLanguage()
  const controller = createPhysicalSystems(
    props.bridge ?? window.api?.physicalSystems,
    () => language.t("physicalsystems.error"),
    () => language.t("physicalsystems.timeout"),
    () => language.t("physicalsystems.conversation.scopeMismatch"),
  )
  onMount(() => {
    const unsubscribe = controller.subscribe()
    void controller.refresh()
    onCleanup(() => unsubscribe?.())
  })
  return <Context.Provider value={controller}>{props.children}</Context.Provider>
}

export function usePhysicalSystems() {
  return useContext(Context)
}
