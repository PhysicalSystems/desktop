// SPDX-License-Identifier: Apache-2.0
import { batch, createEffect, createMemo, For, onCleanup, onMount, Show, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { useTheme } from "@opencode/ui/theme/context"
import { useLanguage } from "../runtime/i18n/language"
import { usePlatform } from "../runtime/platform/platform"
import { CloudConversation } from "./cloud/conversation"
import { cloudAccessDenied } from "./cloud/state"
import { Icon } from "@opencode/ui/icon"
import type { WorkcellAccountBridge, WorkcellAccountState } from "../../../physicalsystems/src/workcell-account-types"
import type { WorkcellRoomData, WorkcellTransport } from "./rooms/types"
import type { ConversationAccountBridge } from "../../../physicalsystems/src/conversation-account-types"
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
  nextCursor: string | null
  permissions: { canCreate: boolean; canCreateTeam: boolean }
}

export function NativeCloudConversations(props: {
  bridge: WorkcellAccountBridge | ConversationAccountBridge
  allowAi?: boolean
  close(): void
  openSettings(): void
  switchAccountMode?(): void
}) {
  const language = useLanguage()
  const platform = usePlatform()
  const theme = useTheme()
  const [state, setState] = createStore({
    account: undefined as WorkcellAccountState | undefined,
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
    sidebarOpen: true,
    createOpen: false,
    workcellCreateOpen: false,
    workcellName: "",
    workcellTask: "",
    creatingWorkcell: false,
  })
  let closed = false
  let listRevision = 0
  let roomRevision = 0
  let selectionRevision = 0
  let pending: { key: string; requestId: string } | undefined
  let pendingWorkcell: { key: string; requestId: string } | undefined
  let listTimer: ReturnType<typeof setInterval> | undefined
  const identity = () =>
    state.account?.status === "signed_in" ? `${state.account.account?.id}:${state.account.sessionId}` : ""
  const current = (account: string) => !closed && account !== "" && identity() === account
  const update = (account: WorkcellAccountState) => {
    if (closed || (state.account && account.revision < state.account.revision)) return
    const changed = state.account?.account?.id !== account.account?.id || state.account?.sessionId !== account.sessionId
    batch(() => {
      setState("account", account)
      if (changed || account.status !== "signed_in") {
        pending = undefined
        pendingWorkcell = undefined
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
          workcellName: "",
          workcellTask: "",
          workcellCreateOpen: false,
          createOpen: false,
          creatingWorkcell: false,
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
    listTimer = setInterval(() => {
      if (!identity()) return
      void loadRooms()
      if (state.workcellId) void loadConversations()
    }, 10000)
  })
  onCleanup(() => {
    closed = true
    pending = undefined
    clearInterval(listTimer)
  })
  const loadRooms = async (selected?: string) => {
    const account = identity()
    const ticket = ++listRevision
    await props.bridge
      .request("GET", "/api/workcells")
      .then((value) => {
        if (!current(account) || ticket !== listRevision) return
        const rooms = (value as { workcells: WorkcellRoomData[] }).workcells
        if (!Array.isArray(rooms)) throw new Error("INVALID_WORKCELL_LIST")
        setState({ rooms, error: false })
        const wanted = selected ?? state.workcellId
        if (wanted !== state.workcellId || !rooms.some((room) => room.id === wanted))
          setState("workcellId", rooms.find((room) => room.id === wanted)?.id ?? rooms[0]?.id ?? "")
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
    const listAll = async () => {
      const conversations: Conversation[] = []
      const cursors = new Set<string>()
      let cursor = ""
      while (active()) {
        const query = cursor ? `cursor=${encodeURIComponent(cursor)}&limit=100` : "limit=100"
        const page = (await props.bridge.request(
          "GET",
          `/api/workcells/${workcellId}/conversations?${query}`,
        )) as ConversationList
        if (
          !Array.isArray(page.conversations) ||
          !page.permissions ||
          page.conversations.some((item) => item.workcellId !== workcellId || !item.permissions?.canRead)
        )
          throw new Error("INVALID_CONVERSATION_LIST")
        conversations.push(...page.conversations)
        if (!page.hasMore) return { ...page, conversations }
        if (!page.nextCursor || cursors.has(page.nextCursor) || conversations.length > 1000)
          throw new Error("INVALID_CONVERSATION_LIST")
        cursor = page.nextCursor
        cursors.add(cursor)
      }
      throw new Error("WORKCELL_SESSION_CHANGED")
    }
    const results = await Promise.allSettled([listAll(), props.bridge.request("GET", `/api/workcells/${workcellId}`)])
    if (!active()) return
    setState("loading", false)
    const list = results[0]
    if (list.status === "rejected") {
      setState("error", true)
      if (cloudAccessDenied(list.reason))
        setState({
          conversations: [],
          conversationId: "",
          room: undefined,
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
    const conversations = data.conversations
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
  const call = async (operation: () => Promise<WorkcellAccountState>) => {
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
        setState({ title: "", createOpen: false })
        await loadConversations(conversation.id)
      })
      .catch(() => {
        if (active()) setState("error", true)
      })
      .finally(() => {
        if (active()) setState("creating", false)
      })
  }
  const createWorkcell = async () => {
    if (state.creatingWorkcell || !state.workcellName.trim() || !state.workcellTask.trim()) return
    const account = identity()
    if (!account) return
    const metadata = {
      name: state.workcellName.trim(),
      task: state.workcellTask.trim(),
      objects: "",
      volume: "",
      location: "",
    }
    const key = JSON.stringify([account, metadata])
    if (pendingWorkcell?.key !== key) pendingWorkcell = { key, requestId: crypto.randomUUID() }
    setState({ creatingWorkcell: true, error: false })
    await props.bridge
      .request("POST", "/api/workcells", { ...metadata, requestId: pendingWorkcell.requestId })
      .then(async (value) => {
        if (!current(account)) return
        const workcell = (value as { workcell: WorkcellRoomData }).workcell
        if (!workcell?.id) throw new Error("INVALID_WORKCELL")
        pendingWorkcell = undefined
        setState({ workcellName: "", workcellTask: "", workcellCreateOpen: false })
        await loadRooms(workcell.id)
      })
      .catch(() => {
        if (current(account)) setState("error", true)
      })
      .finally(() => {
        if (current(account)) setState("creatingWorkcell", false)
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
  const selectedRoom = () => state.rooms.find((room) => room.id === state.workcellId)
  const status = (room: WorkcellRoomData) =>
    room.robot?.status === "online" ? "online" : room.robot?.status === "offline" ? "offline" : "unknown"
  return (
    <section class="ps-native-conversations" data-sidebar-open={state.sidebarOpen}>
      <nav class="ps-shared-sidebar" aria-label={language.t("physicalsystems.shared.workcells")}>
        <div class="ps-heading">
          <Show when={state.sidebarOpen}>
            <strong>{language.t("physicalsystems.name")}</strong>
          </Show>
          <button
            aria-label={language.t(
              state.sidebarOpen ? "physicalsystems.project.collapse" : "physicalsystems.project.expand",
            )}
            aria-expanded={state.sidebarOpen}
            onClick={() => setState("sidebarOpen", !state.sidebarOpen)}
          >
            {state.sidebarOpen ? "‹" : "›"}
          </button>
        </div>
        <Show when={state.sidebarOpen}>
          <div class="ps-shared-links">
            <Show when={!props.allowAi}>
              <button disabled={!identity()} onClick={() => setState("workcellCreateOpen", true)}>
                <Icon name="plus" />
                {language.t("physicalsystems.shared.newWorkcell")}
              </button>
            </Show>
            <button onClick={() => void platform.openExternal("https://physicalsystems.ai/dashboard/artefacts")}>
              <Icon name="filetree" />
              {language.t("physicalsystems.shared.artefacts")}
            </button>
            <button onClick={() => void platform.openExternal("https://physicalsystems.ai/dashboard/skills")}>
              <Icon name="flask" />
              {language.t("physicalsystems.shared.skills")}
            </button>
            <button onClick={() => void platform.openExternal("https://physicalsystems.ai/dashboard/planned")}>
              <Icon name="status" />
              {language.t("physicalsystems.shared.planned")}
            </button>
          </div>
          <div class="ps-shared-workcells">
            <p class="ps-muted">{language.t("physicalsystems.shared.workcells")}</p>
            <For each={state.rooms}>
              {(room) => (
                <div class="ps-shared-workcell">
                  <button
                    class="ps-shared-workcell-name"
                    aria-expanded={state.workcellId === room.id}
                    onClick={() => setState({ workcellId: room.id, workcellCreateOpen: false })}
                  >
                    <Icon name="folder" />
                    <span>{room.name}</span>
                    <i
                      class="ps-shared-status"
                      data-status={status(room)}
                      title={language.t(
                        status(room) === "online"
                          ? "physicalsystems.shared.online"
                          : status(room) === "offline"
                            ? "physicalsystems.shared.offline"
                            : "physicalsystems.shared.unknown",
                      )}
                    />
                  </button>
                  <Show when={state.workcellId === room.id}>
                    <div class="ps-shared-conversation-list">
                      <For each={state.conversations}>
                        {(conversation) => (
                          <button
                            aria-current={state.conversationId === conversation.id ? "page" : undefined}
                            onClick={() =>
                              setState({
                                conversationId: conversation.id,
                                createOpen: false,
                                workcellCreateOpen: false,
                              })
                            }
                            title={language.t(
                              conversation.visibility === "team"
                                ? "physicalsystems.conversations.team"
                                : "physicalsystems.conversations.private",
                            )}
                          >
                            <Icon name={conversation.visibility === "private" ? "lock" : "chat"} />
                            <span>{conversation.title}</span>
                          </button>
                        )}
                      </For>
                      <Show when={state.permissions.canCreate}>
                        <button onClick={() => setState({ createOpen: true, workcellCreateOpen: false })}>
                          <Icon name="plus" />
                          <span>{language.t("physicalsystems.conversations.new")}</span>
                        </button>
                      </Show>
                    </div>
                  </Show>
                </div>
              )}
            </For>
            <Show when={identity() && !state.rooms.length}>
              <p class="ps-muted">{language.t("physicalsystems.shared.empty")}</p>
            </Show>
          </div>
        </Show>
        <div class="ps-shared-sidebar-footer">
          <Show when={props.switchAccountMode}>
            <button
              aria-label={language.t(props.allowAi ? "physicalsystems.shared.open" : "physicalsystems.shared.ai")}
              title={language.t(props.allowAi ? "physicalsystems.shared.open" : "physicalsystems.shared.ai")}
              onClick={() => props.switchAccountMode?.()}
            >
              <Icon name="chat" />
              <Show when={state.sidebarOpen}>
                {language.t(props.allowAi ? "physicalsystems.shared.open" : "physicalsystems.shared.ai")}
              </Show>
            </button>
          </Show>
          <button
            aria-label={language.t("physicalsystems.shared.local")}
            title={language.t("physicalsystems.shared.local")}
            onClick={props.close}
          >
            <Icon name="monitor" />
            <Show when={state.sidebarOpen}>{language.t("physicalsystems.shared.local")}</Show>
          </button>
          <button
            aria-label={language.t("command.settings.open")}
            title={language.t("command.settings.open")}
            onClick={props.openSettings}
          >
            <Icon name="settings-gear" />
            <Show when={state.sidebarOpen}>{language.t("desktop.menu.settings")}</Show>
          </button>
          <Show
            when={state.account?.status === "signed_in"}
            fallback={
              <button
                aria-label={language.t("physicalsystems.account.signIn")}
                title={language.t("physicalsystems.account.signIn")}
                disabled={state.accountBusy}
                onClick={() => void call(() => props.bridge.signIn())}
              >
                <span class="ps-account-avatar">P</span>
                <Show when={state.sidebarOpen}>{language.t("physicalsystems.account.signIn")}</Show>
              </button>
            }
          >
            <details class="ps-shared-account">
              <summary
                aria-label={language.t("physicalsystems.account.title")}
                title={state.account?.account?.name || state.account?.account?.email}
              >
                <span class="ps-account-avatar">{state.account?.account?.name?.slice(0, 1).toUpperCase() || "P"}</span>
                <Show when={state.sidebarOpen}>
                  <span class="ps-account-name">{state.account?.account?.name || state.account?.account?.email}</span>
                </Show>
              </summary>
              <div class="ps-shared-account-menu">
                <p>{state.account?.account?.email}</p>
                <Show when={!props.allowAi && !state.account?.syncEnabled}>
                  <button disabled={state.accountBusy} onClick={() => void call(() => props.bridge.signIn())}>
                    {language.t("physicalsystems.account.enableSync")}
                  </button>
                </Show>
                <button disabled={state.accountBusy} onClick={() => void call(() => props.bridge.refresh())}>
                  {language.t("physicalsystems.refresh")}
                </button>
                <button disabled={state.accountBusy} onClick={() => void call(() => props.bridge.signOut())}>
                  {language.t("physicalsystems.account.signOut")}
                </button>
              </div>
            </details>
          </Show>
        </div>
      </nav>
      <div class="ps-shared-content">
        <header class="ps-shared-context">
          <div>
            <strong>{selectedRoom()?.name || language.t("physicalsystems.shared.workcells")}</strong>
            <span class="ps-muted">
              {language.t(props.allowAi ? "physicalsystems.shared.ai" : "physicalsystems.shared.synced")}
            </span>
          </div>
          <button
            disabled={state.accountBusy || !identity()}
            onClick={() => {
              void loadRooms()
              if (state.workcellId) void loadConversations()
            }}
          >
            {language.t("physicalsystems.refresh")}
          </button>
        </header>
        <Show when={state.error || state.account?.error}>
          <p role="alert" class="ps-error">
            {language.t("physicalsystems.rooms.error")}
          </p>
        </Show>
        <Show
          when={state.account?.status === "signed_in"}
          fallback={
            <div class="ps-shared-welcome">
              <h1>{language.t("physicalsystems.shared.welcome")}</h1>
              <p>
                {language.t(
                  props.allowAi
                    ? "physicalsystems.conversations.signInDescription"
                    : "physicalsystems.shared.signInDescription",
                )}
              </p>
              <Show
                when={state.account?.pending}
                fallback={
                  <button disabled={state.accountBusy} onClick={() => void call(() => props.bridge.signIn())}>
                    {language.t("physicalsystems.account.signIn")}
                  </button>
                }
              >
                {(pending) => (
                  <>
                    <p>
                      {pending().userCode
                        ? language.t("physicalsystems.rooms.verify", { code: pending().userCode! })
                        : language.t("physicalsystems.account.browserSignIn")}
                    </p>
                    <button onClick={() => void platform.openExternal(pending().verificationUrl)}>
                      {language.t("physicalsystems.rooms.openBrowser")}
                    </button>
                    <button disabled={state.accountBusy} onClick={() => void call(() => props.bridge.cancelSignIn())}>
                      {language.t("physicalsystems.cancel")}
                    </button>
                  </>
                )}
              </Show>
              <button onClick={props.close}>{language.t("physicalsystems.shared.local")}</button>
            </div>
          }
        >
          <Show when={state.workcellCreateOpen}>
            <form
              class="ps-native-conversation-create"
              onSubmit={(event) => {
                event.preventDefault()
                void createWorkcell()
              }}
            >
              <h2>{language.t("physicalsystems.shared.newWorkcell")}</h2>
              <label>
                {language.t("physicalsystems.projectWebsite.name")}
                <input
                  value={state.workcellName}
                  maxlength={120}
                  required
                  onInput={(event) => setState("workcellName", event.currentTarget.value)}
                />
              </label>
              <label>
                {language.t("physicalsystems.projectWebsite.task")}
                <textarea
                  value={state.workcellTask}
                  maxlength={4000}
                  required
                  onInput={(event) => setState("workcellTask", event.currentTarget.value)}
                />
              </label>
              <button
                type="submit"
                disabled={state.creatingWorkcell || !state.workcellName.trim() || !state.workcellTask.trim()}
              >
                {language.t("physicalsystems.shared.createWorkcell")}
              </button>
              <button
                type="button"
                disabled={state.creatingWorkcell}
                onClick={() => setState("workcellCreateOpen", false)}
              >
                {language.t("physicalsystems.cancel")}
              </button>
            </form>
          </Show>
          <Show when={state.createOpen && state.permissions.canCreate && !state.workcellCreateOpen}>
            <form
              class="ps-native-conversation-create"
              onSubmit={(event) => {
                event.preventDefault()
                void create()
              }}
            >
              <label>
                {language.t("physicalsystems.conversations.new")}
                <input
                  value={state.title}
                  maxlength={120}
                  required
                  onInput={(event) => setState("title", event.currentTarget.value)}
                />
              </label>
              <label>
                {language.t("physicalsystems.conversations.visibility")}
                <select
                  value={state.visibility}
                  onChange={(event) =>
                    setState("visibility", event.currentTarget.value === "team" ? "team" : "private")
                  }
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
              <button type="button" disabled={state.creating} onClick={() => setState("createOpen", false)}>
                {language.t("physicalsystems.cancel")}
              </button>
            </form>
          </Show>
          <Show when={!state.workcellCreateOpen && !state.createOpen}>
            <Show
              when={selection()}
              keyed
              fallback={
                <div class="ps-shared-welcome">
                  <p>
                    {language.t(
                      state.loading
                        ? "physicalsystems.conversations.loading"
                        : state.workcellId
                          ? "physicalsystems.conversations.empty"
                          : "physicalsystems.shared.empty",
                    )}
                  </p>
                  <Show when={!state.workcellId && !props.allowAi}>
                    <button onClick={() => setState("workcellCreateOpen", true)}>
                      {language.t("physicalsystems.shared.newWorkcell")}
                    </button>
                  </Show>
                </div>
              }
            >
              {(selected) => (
                <div class="ps-cloud-root">
                  <CloudConversation
                    {...selected}
                    transport={transport}
                    theme={theme.mode()}
                    workcell={state.room}
                    allowAi={props.allowAi === true}
                  />
                </div>
              )}
            </Show>
          </Show>
        </Show>
      </div>
    </section>
  )
}
