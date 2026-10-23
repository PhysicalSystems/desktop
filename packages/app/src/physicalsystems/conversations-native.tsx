// SPDX-License-Identifier: Apache-2.0
import { batch, createEffect, createMemo, For, onCleanup, onMount, Show, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { useTheme } from "@opencode/ui/theme/context"
import { useLanguage } from "../runtime/i18n/language"
import { usePlatform } from "../runtime/platform/platform"
import { CloudConversation } from "./cloud/conversation"
import type {
  ConversationAccountBridge,
  ConversationAccountState,
} from "../../../physicalsystems/src/conversation-account-types"
import type { WorkcellRoomData, WorkcellTransport } from "./rooms/types"
import "./cloud/conversation.css"
import "./conversations-native.css"

type Conversation = {
  id: string
  workcellId: string
  title: string
  visibility: "private" | "team"
  isDefault: boolean
  permissions: { canRead: boolean; canPost: boolean }
}
type ConversationList = {
  conversations: Conversation[]
  defaultConversationId: string | null
  hasMore: boolean
  permissions: { canCreate: boolean; canCreateTeam: boolean }
}

export function NativeCloudConversations(props: {
  bridge: ConversationAccountBridge
  close(): void
  openUpdates?(): void
}) {
  const language = useLanguage()
  const platform = usePlatform()
  const theme = useTheme()
  const [state, setState] = createStore({
    account: undefined as ConversationAccountState | undefined,
    rooms: [] as WorkcellRoomData[],
    room: undefined as WorkcellRoomData | undefined,
    workcellId: "",
    conversations: [] as Conversation[],
    conversationId: "",
    permissions: { canCreate: false, canCreateTeam: false },
    hasMore: false,
    title: "",
    visibility: "private" as "private" | "team",
    accountBusy: false,
    creating: false,
    loading: false,
    error: false,
  })
  let closed = false
  let listRevision = 0
  let roomRevision = 0
  let selectionRevision = 0
  let pending: { key: string; requestId: string } | undefined
  const identity = () =>
    state.account?.status === "signed_in" ? `${state.account.account?.id}:${state.account.sessionId}` : ""
  const current = (account: string) => !closed && account !== "" && identity() === account
  const update = (account: ConversationAccountState) => {
    if (closed || (state.account && account.revision < state.account.revision)) return
    batch(() => {
      setState("account", account)
      if (account.status !== "signed_in") {
        pending = undefined
        setState({
          rooms: [],
          workcellId: "",
          conversations: [],
          conversationId: "",
          room: undefined,
          title: "",
          visibility: "private",
          creating: false,
          loading: false,
          permissions: { canCreate: false, canCreateTeam: false },
        })
      }
    })
  }
  onMount(() => {
    const unsubscribe = props.bridge.subscribe(update)
    void props.bridge.refresh().then(update, () => {
      if (!closed) setState("error", true)
    })
    onCleanup(unsubscribe)
  })
  onCleanup(() => {
    closed = true
    pending = undefined
  })
  const loadRooms = async () => {
    const account = identity()
    const ticket = ++listRevision
    await props.bridge
      .request("GET", "/api/workcells")
      .then((value) => {
        if (!current(account) || ticket !== listRevision) return
        const rooms = (value as { workcells: WorkcellRoomData[] }).workcells
        if (!Array.isArray(rooms)) throw new Error("INVALID_WORKCELL_LIST")
        setState({ rooms, error: false })
        if (!rooms.some((room) => room.id === state.workcellId)) setState("workcellId", rooms[0]?.id ?? "")
      })
      .catch(() => {
        if (current(account) && ticket === listRevision) setState("error", true)
      })
  }
  const loadConversations = async (selected?: string) => {
    const account = identity()
    const workcellId = state.workcellId
    const ticket = ++roomRevision
    if (!workcellId || !account) return
    const active = () => current(account) && state.workcellId === workcellId && ticket === roomRevision
    setState("loading", true)
    const results = await Promise.allSettled([
      props.bridge.request("GET", `/api/workcells/${workcellId}/conversations`),
      props.bridge.request("GET", `/api/workcells/${workcellId}`),
    ])
    if (!active()) return
    setState("loading", false)
    const list = results[0]
    if (list.status === "rejected") {
      setState({
        conversations: [],
        conversationId: "",
        error: true,
        permissions: { canCreate: false, canCreateTeam: false },
      })
      return
    }
    const data = list.value as ConversationList
    if (
      !Array.isArray(data.conversations) ||
      !data.permissions ||
      data.conversations.some((item) => item.workcellId !== workcellId || !item.permissions?.canRead)
    ) {
      setState({
        conversations: [],
        conversationId: "",
        error: true,
        permissions: { canCreate: false, canCreateTeam: false },
      })
      return
    }
    const conversations = data.conversations.filter((item) => !item.isDefault)
    setState({ conversations, permissions: data.permissions, hasMore: data.hasMore, error: false })
    const wanted = selected ?? state.conversationId
    setState("conversationId", conversations.find((item) => item.id === wanted)?.id ?? conversations[0]?.id ?? "")
    const room =
      results[1].status === "fulfilled" ? (results[1].value as { workcell?: WorkcellRoomData }).workcell : undefined
    setState("room", room?.id === workcellId ? room : undefined)
  }
  createEffect(() => {
    const account = identity()
    const revision = state.account?.revision
    if (account && revision !== undefined) untrack(() => void loadRooms())
  })
  createEffect(() => {
    const account = identity()
    const room = state.workcellId
    untrack(() => {
      selectionRevision++
      pending = undefined
      setState({
        conversations: [],
        conversationId: "",
        room: undefined,
        title: "",
        visibility: "private",
        creating: false,
        permissions: { canCreate: false, canCreateTeam: false },
      })
      if (account && room) void loadConversations()
    })
  })
  const call = async (operation: () => Promise<ConversationAccountState>) => {
    if (state.accountBusy) return
    setState({ accountBusy: true, error: false })
    await operation()
      .then(update, () => {
        if (!closed) setState("error", true)
      })
      .finally(() => {
        if (!closed) setState("accountBusy", false)
      })
  }
  const create = async () => {
    if (state.creating || !state.permissions.canCreate || !state.title.trim()) return
    const account = identity()
    const workcellId = state.workcellId
    const title = state.title.trim()
    const visibility = state.visibility
    if (!account || !workcellId || (visibility === "team" && !state.permissions.canCreateTeam)) return
    const key = JSON.stringify([account, workcellId, title, visibility])
    if (pending?.key !== key) pending = { key, requestId: crypto.randomUUID() }
    const requestId = pending.requestId
    const ticket = selectionRevision
    const active = () => current(account) && state.workcellId === workcellId && ticket === selectionRevision
    setState({ creating: true, error: false })
    await props.bridge
      .request("POST", `/api/workcells/${workcellId}/conversations`, { requestId, title, visibility })
      .then(async (value) => {
        if (!active()) return
        const conversation = (value as { conversation: Conversation }).conversation
        if (!conversation || conversation.workcellId !== workcellId) throw new Error("INVALID_CONVERSATION")
        pending = undefined
        setState("title", "")
        await loadConversations(conversation.id)
      })
      .catch(() => {
        if (active()) setState("error", true)
      })
      .finally(() => {
        if (active()) setState("creating", false)
      })
  }
  const transport: WorkcellTransport = {
    request: async (method, path, body, signal) => {
      if (signal?.aborted) throw new Error("ABORTED")
      const result = await props.bridge.request(method, path, body)
      if (signal?.aborted) throw new Error("ABORTED")
      return result
    },
  }
  const selection = createMemo(() => {
    const grantKey = identity()
    const accountKey = state.account?.account?.id
    return grantKey && accountKey && state.workcellId && state.conversationId
      ? { accountKey, grantKey, workcellId: state.workcellId, conversationId: state.conversationId }
      : undefined
  })
  return (
    <section class="ps-cloud-rooms ps-native-conversations">
      <div class="ps-heading">
        <strong>{language.t("physicalsystems.conversations.title")}</strong>
        <Show when={props.openUpdates}>
          <button onClick={() => props.openUpdates?.()}>{language.t("physicalsystems.conversations.updates")}</button>
        </Show>
        <button onClick={props.close}>{language.t("physicalsystems.rooms.back")}</button>
      </div>
      <Show when={state.error || state.account?.error}>
        <p role="alert" class="ps-error">
          {language.t("physicalsystems.rooms.error")}
        </p>
      </Show>
      <Show
        when={state.account?.status === "signed_in"}
        fallback={
          <div class="ps-stack">
            <p>{language.t("physicalsystems.conversations.signInDescription")}</p>
            <Show
              when={state.account?.pending}
              fallback={
                <button disabled={state.accountBusy} onClick={() => void call(() => props.bridge.signIn())}>
                  {language.t("physicalsystems.conversations.signIn")}
                </button>
              }
            >
              {(pending) => (
                <>
                  <p>{language.t("physicalsystems.rooms.verify", { code: pending().userCode })}</p>
                  <button onClick={() => void platform.openExternal(pending().verificationUrl)}>
                    {language.t("physicalsystems.rooms.openBrowser")}
                  </button>
                  <button disabled={state.accountBusy} onClick={() => void call(() => props.bridge.cancelSignIn())}>
                    {language.t("physicalsystems.cancel")}
                  </button>
                </>
              )}
            </Show>
          </div>
        }
      >
        <div class="ps-cloud-room-toolbar">
          <label>
            {language.t("physicalsystems.rooms.choose")}{" "}
            <select value={state.workcellId} onChange={(event) => setState("workcellId", event.currentTarget.value)}>
              <For each={state.rooms}>{(room) => <option value={room.id}>{room.name}</option>}</For>
            </select>
          </label>
          <label>
            {language.t("physicalsystems.conversations.choose")}{" "}
            <select
              value={state.conversationId}
              disabled={state.loading}
              onChange={(event) => setState("conversationId", event.currentTarget.value)}
            >
              <For each={state.conversations}>
                {(conversation) => (
                  <option value={conversation.id}>
                    {conversation.title} ·{" "}
                    {language.t(
                      conversation.visibility === "team"
                        ? "physicalsystems.conversations.team"
                        : "physicalsystems.conversations.private",
                    )}
                  </option>
                )}
              </For>
            </select>
          </label>
          <button
            disabled={state.accountBusy}
            onClick={() =>
              void call(() => props.bridge.refresh()).then(() => {
                if (identity()) void loadConversations()
              })
            }
          >
            {language.t("physicalsystems.refresh")}
          </button>
          <button disabled={state.accountBusy} onClick={() => void call(() => props.bridge.signOut())}>
            {language.t("physicalsystems.account.signOut")}
          </button>
        </div>
        <Show when={state.permissions.canCreate}>
          <form
            class="ps-native-conversation-create"
            onSubmit={(event) => {
              event.preventDefault()
              void create()
            }}
          >
            <label>
              {language.t("physicalsystems.conversations.new")}{" "}
              <input
                value={state.title}
                maxLength={120}
                required
                onInput={(event) => setState("title", event.currentTarget.value)}
              />
            </label>
            <label>
              {language.t("physicalsystems.conversations.visibility")}{" "}
              <select
                value={state.visibility}
                onChange={(event) => setState("visibility", event.currentTarget.value === "team" ? "team" : "private")}
              >
                <option value="private">{language.t("physicalsystems.conversations.private")}</option>
                <Show when={state.permissions.canCreateTeam}>
                  <option value="team">{language.t("physicalsystems.conversations.team")}</option>
                </Show>
              </select>
            </label>
            <button type="submit" disabled={state.creating || !state.title.trim()}>
              {language.t("physicalsystems.conversations.create")}
            </button>
          </form>
        </Show>
        <Show when={state.loading}>
          <p role="status">{language.t("physicalsystems.conversations.loading")}</p>
        </Show>
        <Show
          when={selection()}
          keyed
          fallback={
            <Show when={!state.loading}>
              <p>
                {language.t(state.workcellId ? "physicalsystems.conversations.empty" : "physicalsystems.rooms.empty")}
              </p>
            </Show>
          }
        >
          {(selected) => (
            <div class="ps-cloud-root">
              <CloudConversation {...selected} transport={transport} theme={theme.mode()} workcell={state.room} />
            </div>
          )}
        </Show>
        <Show when={state.hasMore}>
          <p>{language.t("physicalsystems.conversations.more")}</p>
        </Show>
        <button onClick={() => void platform.openExternal("https://physicalsystems.ai/dashboard/workcells")}>
          {language.t("physicalsystems.rooms.openWeb")}
        </button>
      </Show>
    </section>
  )
}
