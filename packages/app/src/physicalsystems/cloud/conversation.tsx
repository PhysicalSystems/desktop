// SPDX-License-Identifier: Apache-2.0
import { batch, createEffect, createMemo, ErrorBoundary, For, onCleanup, Show, untrack } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { DialogProvider } from "@opencode/ui/context/dialog"
import { FileComponentProvider } from "@opencode/ui/context/file"
import { DataProvider } from "@opencode/session-ui/context"
import { createReactiveTimelineProjection } from "@opencode/session-ui/timeline/projection"
import { createSessionTimelineRowRenderer } from "@opencode/session-ui/timeline/row"
import { ComposerEditor } from "../../composer/editor/editor"
import { createComposerEditor } from "../../composer/editor/interaction"
import type { ComposerPersistedState } from "../../composer/types"
import { roomText } from "../rooms/copy"
import { cloudText } from "./copy"
import { cloudAccessDenied, createCloudConversationClient } from "./state"
import type { CloudConversationOptions, CloudConversationSnapshot, MemberConversation } from "./types"
import { createConversationDraft, createMemberConversationClient } from "./members"

/** The existing OpenCode renderer and editor; this component owns no model/tool execution. */
export function CloudConversation(props: CloudConversationOptions) {
  return (
    <ErrorBoundary
      fallback={
        <p class="ps-cloud-notice" role="alert">
          {cloudText("invalid")}
        </p>
      }
    >
      <CloudConversationContent {...props} />
    </ErrorBoundary>
  )
}

function CloudConversationContent(props: CloudConversationOptions) {
  const client = createCloudConversationClient(props)
  const members = createMemberConversationClient(props)
  const drafts = { message: createConversationDraft(props, "message"), ai: createConversationDraft(props, "ai") }
  const [state, setState] = createStore<{
    member?: MemberConversation
    snapshot?: CloudConversationSnapshot
    mode: "message" | "ai"
    loading: boolean
    error: "failed" | "denied" | "invalid" | ""
    aiError: boolean
    promptError: "unconfirmed" | "promptFailed" | "length" | "memberLength" | "queued" | ""
    storageError: boolean
    sending: boolean
    uncertain: boolean
    earlier: boolean
  }>({
    mode: "message",
    loading: true,
    error: "",
    aiError: false,
    promptError: "",
    storageError: false,
    sending: false,
    uncertain: false,
    earlier: false,
  })
  const draft = createStore<ComposerPersistedState>({ prompt: [], context: { items: [] } })
  let closed = false
  let fetching = false
  let fetchingAi = false
  let refreshAgain = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let aiTimer: ReturnType<typeof setTimeout> | undefined
  let retryAt = 0
  let failures = 0
  const denied = () => state.error === "denied"
  const text = () => draft[0].prompt.map((part) => (part.type === "text" ? part.content : "")).join("")
  const canPost = () => state.member?.permissions.canPost === true && !denied()
  const writable = () =>
    canPost() &&
    (state.mode === "message" ||
      (props.allowAi !== false && state.snapshot?.runtime.status === "ready" && state.snapshot.conversation.canWrite))
  const pendingText = (mode: "message" | "ai") =>
    mode === "message" ? members.pending()?.content : client.pending()?.text
  const restore = (mode: "message" | "ai") => {
    try {
      const pending = pendingText(mode)
      const value = pending ?? drafts[mode].read()
      batch(() => {
        setState({
          mode,
          uncertain: Boolean(pending),
          promptError: pending ? (mode === "message" ? "queued" : "unconfirmed") : "",
        })
        draft[1]("prompt", value ? [{ type: "text", content: value, start: 0, end: value.length }] : [])
        draft[1]("cursor", value.length)
      })
    } catch {
      setState("storageError", true)
    }
  }
  restore("message")
  createEffect(() => {
    const value = text()
    const mode = state.mode
    // Pending sends are immutable; an unrelated draft in another tab is not overwritten on recovery.
    if (denied() || pendingText(mode)) return
    try {
      drafts[mode].save(value)
      setState("storageError", false)
    } catch {
      setState("storageError", true)
    }
  })
  const fail = (error: unknown) => {
    if (closed) return
    if (cloudAccessDenied(error)) {
      setState({ member: undefined, snapshot: undefined, error: "denied", uncertain: false, promptError: "" })
      draft[1]("prompt", [])
      members.dispose()
      client.dispose()
      clearTimeout(timer)
      clearTimeout(aiTimer)
      return
    }
    setState("error", error instanceof Error && /INVALID_.*SNAPSHOT/.test(error.message) ? "invalid" : "failed")
  }
  const refresh = async () => {
    if (closed || denied() || document.hidden) return
    if (fetching) {
      refreshAgain = true
      return
    }
    fetching = true
    clearTimeout(timer)
    let received = false
    try {
      const member = await members.snapshot()
      if (!closed) {
        setState("member", reconcile(member))
        setState("error", "")
        received = true
      }
    } catch (error) {
      fail(error)
    } finally {
      fetching = false
      if (!closed) {
        setState("loading", false)
        if (!denied()) {
          // Bound catch-up to 100 events per second, below the account request budget.
          const delay = refreshAgain ? 0 : state.member?.catchingUp && !state.error ? 1000 : 5000
          refreshAgain = false
          timer = setTimeout(() => void refresh(), delay)
        }
      }
    }
    if (received && !closed && canPost() && members.pending() && !state.sending && Date.now() >= retryAt)
      void send(true, true)
  }
  const refreshAi = async () => {
    if (props.allowAi === false || closed || denied() || document.hidden || fetchingAi) return
    fetchingAi = true
    clearTimeout(aiTimer)
    try {
      const snapshot = await client.snapshot()
      if (!closed) {
        setState("snapshot", reconcile(snapshot))
        setState("aiError", false)
      }
    } catch (error) {
      if (cloudAccessDenied(error)) fail(error)
      else if (!closed) setState("aiError", true)
    } finally {
      fetchingAi = false
      if (!closed && !denied())
        aiTimer = setTimeout(() => void refreshAi(), state.snapshot?.status.type === "busy" ? 1500 : 5000)
    }
  }
  const send = async (retry = false, automatic = false) => {
    const mode = automatic ? "message" : state.mode
    if (state.sending || !canPost() || (!automatic && !writable()) || (!retry && state.uncertain)) return
    const value = pendingText(mode) ?? text()
    if (!value.trim() || value.length > (mode === "message" ? 8000 : 32000)) {
      if (!automatic) setState("promptError", mode === "message" ? "memberLength" : "length")
      return
    }
    setState({ sending: true, promptError: "" })
    try {
      if (mode === "message") await members.submit(value)
      else await client.submit(value)
      if (closed) return
      // A recovered send can coexist with a newer draft from another tab.
      if (drafts[mode].read().trim() === value.trim()) drafts[mode].clear()
      if (state.mode === mode) restore(mode)
      failures = 0
      retryAt = Date.now() + 5000
      if (mode === "message") await refresh()
      else await refreshAi()
    } catch (error) {
      if (closed) return
      if (cloudAccessDenied(error)) {
        fail(error)
        return
      }
      const uncertain = Boolean(pendingText(mode))
      if (state.mode === mode)
        setState({
          uncertain,
          promptError: uncertain ? (mode === "message" ? "queued" : "unconfirmed") : "promptFailed",
        })
      if (mode === "message") retryAt = Date.now() + Math.min(60000, 5000 * 2 ** Math.min(failures++, 4))
    } finally {
      if (!closed) setState("sending", false)
    }
  }
  const composer = createComposerEditor({
    store: draft,
    commands: () => [],
    context: () => [],
    searchContextFiles: () => [],
    view: {
      placeholder: () => cloudText(state.mode === "message" ? "messagePlaceholder" : "placeholder"),
      submit: {
        available: () => writable() && !state.sending && !state.uncertain && !state.storageError,
        stopping: () => false,
        onSubmit: () => void send(),
        onStop: () => {},
      },
    },
  })
  const cloudComposer = {
    ...composer,
    openShell: () => {},
    onInput(value: string, prompt?: ComposerPersistedState["prompt"], cursor?: number) {
      if (value !== "!") {
        composer.onInput(value, prompt, cursor)
        return
      }
      draft[1]("prompt", [{ type: "text", content: value, start: 0, end: 1 }])
      draft[1]("cursor", cursor ?? 1)
      composer.dispatch({ type: "popover.close" })
    },
  }
  const canUseTaskDetails = () => writable() && !state.sending && !state.uncertain && text().length === 0
  const useTaskDetails = () => {
    const room = props.workcell
    if (!room || room.id !== props.workcellId || !canUseTaskDetails()) return
    const value = `${cloudText("taskDetailsPrompt")}\n${JSON.stringify({ name: room.name, task: room.task, objects: room.objects, location: room.location }, null, 2)}\n\n`
    draft[1]("prompt", [{ type: "text", content: value, start: 0, end: value.length }])
    draft[1]("cursor", value.length)
    setState("promptError", "")
    composer.restoreFocus(value.length)
  }
  const earlier = async () => {
    if (state.earlier || denied()) return
    setState("earlier", true)
    try {
      const member = await members.earlier()
      if (!closed && member) setState("member", reconcile(member))
    } catch (error) {
      fail(error)
    } finally {
      if (!closed) setState("earlier", false)
    }
  }
  createEffect(() => {
    untrack(() => {
      void refresh()
      void refreshAi()
    })
  })
  const onFocus = () => {
    if (!document.hidden) {
      void refresh()
      void refreshAi()
    }
  }
  const onOnline = () => {
    retryAt = 0
    onFocus()
  }
  window.addEventListener("focus", onFocus)
  window.addEventListener("online", onOnline)
  document.addEventListener("visibilitychange", onFocus)
  onCleanup(() => {
    closed = true
    clearTimeout(timer)
    clearTimeout(aiTimer)
    members.dispose()
    client.dispose()
    window.removeEventListener("focus", onFocus)
    window.removeEventListener("online", onOnline)
    document.removeEventListener("visibilitychange", onFocus)
  })
  const session = () => state.snapshot?.session ?? undefined
  const data = createMemo(() => ({
    session: session() ? [session()!] : [],
    session_status: session() ? { [session()!.id]: state.snapshot!.status } : {},
    session_diff: {},
  }))
  return (
    <section class="ps-cloud-conversation" aria-label={cloudText("title")}>
      <header class="ps-cloud-header">
        <span>{cloudText("title")}</span>
        <Show when={state.member}>
          {(member) => <span class="ps-cloud-scope">{cloudText(member().visibility)}</span>}
        </Show>
      </header>
      <Show when={state.member}>
        <h1>{state.member!.title}</h1>
      </Show>
      <Show when={state.member && !denied() && props.workcell?.id === props.workcellId && props.workcell}>
        {(room) => (
          <details class="ps-cloud-context">
            <summary>{cloudText("task")}</summary>
            <h2>{room().name}</h2>
            <p>{room().task}</p>
            <dl>
              <dt>{roomText("objects")}</dt>
              <dd>{room().objects || roomText("unprovided")}</dd>
              <dt>{roomText("location")}</dt>
              <dd>{room().location || roomText("unprovided")}</dd>
            </dl>
            <div class="ps-cloud-notice">
              <button type="button" disabled={!canUseTaskDetails()} onClick={useTaskDetails}>
                {cloudText("useTaskDetails")}
              </button>
              <p>{cloudText("taskDetailsHint")}</p>
            </div>
          </details>
        )}
      </Show>
      <Show when={state.loading}>
        <p role="status" class="ps-cloud-notice">
          {cloudText("loading")}
        </p>
      </Show>
      <Show when={state.error}>
        <div class="ps-cloud-notice" role="alert">
          <p>{cloudText(state.error as "failed" | "denied" | "invalid")}</p>
          <Show when={!denied()}>
            <button type="button" onClick={() => void refresh()}>
              {cloudText("retry")}
            </button>
          </Show>
        </div>
      </Show>
      <Show when={state.member}>
        <section class="ps-cloud-members" aria-label={cloudText("messages")}>
          <h2>{cloudText("messages")}</h2>
          <Show when={state.member!.messagesHasMore}>
            <button class="ps-cloud-earlier" type="button" disabled={state.earlier} onClick={() => void earlier()}>
              {cloudText("earlier")}
            </button>
          </Show>
          <For each={state.member!.messages} fallback={<p class="ps-cloud-empty">{cloudText("emptyMessages")}</p>}>
            {(message) => (
              <article class="ps-cloud-member">
                <header>
                  <strong>
                    {message.role === "system" ? cloudText("system") : message.authorName || cloudText("member")}
                  </strong>
                  <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString()}</time>
                </header>
                <p>{message.content}</p>
              </article>
            )}
          </For>
          <Show when={state.member!.catchingUp}>
            <p class="ps-cloud-notice" role="status">
              {cloudText("catchingUp")}
            </p>
          </Show>
        </section>
        <Show when={props.allowAi !== false && state.snapshot && state.snapshot.messages.length > 0}>
          <section class="ps-cloud-ai-history" aria-label={cloudText("aiHistory")}>
            <h2>{cloudText("aiHistory")}</h2>
            <DialogProvider>
              <FileComponentProvider component={() => null}>
                <DataProvider data={data()} directory="" sessionID={session()?.id}>
                  <CloudTimeline snapshot={state.snapshot!} />
                </DataProvider>
              </FileComponentProvider>
            </DialogProvider>
          </section>
        </Show>
        <Show when={!state.member!.permissions.canPost}>
          <p class="ps-cloud-notice">{cloudText("readonly")}</p>
        </Show>
        <Show when={canPost()}>
          <div class="ps-cloud-mode" role="group" aria-label={cloudText("sendMode")}>
            <button
              type="button"
              aria-pressed={state.mode === "message"}
              disabled={state.sending}
              onClick={() => restore("message")}
            >
              {cloudText("messageMode")}
            </button>
            <Show when={props.allowAi !== false}>
              <button
                type="button"
                aria-pressed={state.mode === "ai"}
                disabled={state.sending}
                onClick={() => restore("ai")}
              >
                {cloudText("aiMode")}
              </button>
            </Show>
          </div>
          <p class="ps-cloud-notice">{cloudText(state.mode === "message" ? "messageHint" : "aiHint")}</p>
          <Show when={state.mode === "ai" && (state.aiError || state.snapshot?.runtime.status !== "ready")}>
            <p class="ps-cloud-notice" role="status">
              {cloudText("unavailable")}
            </p>
          </Show>
          <Show when={writable()}>
            <div class="ps-cloud-composer">
              <ComposerEditor
                controller={cloudComposer}
                disabled={state.sending || state.uncertain}
                readOnly={state.sending || state.uncertain}
              />
            </div>
          </Show>
          <Show when={state.storageError}>
            <p class="ps-cloud-notice" role="alert">
              {cloudText("storageFailed")}
            </p>
          </Show>
          <Show when={state.sending}>
            <p role="status" class="ps-cloud-notice">
              {cloudText("sending")}
            </p>
          </Show>
          <Show when={state.promptError}>
            <div class="ps-cloud-notice" role="alert">
              <p>
                {cloudText(state.promptError as "unconfirmed" | "promptFailed" | "length" | "memberLength" | "queued")}
              </p>
              <Show when={state.uncertain}>
                <button type="button" disabled={state.sending || !writable()} onClick={() => void send(true)}>
                  {cloudText("retry")}
                </button>
              </Show>
            </div>
          </Show>
        </Show>
      </Show>
    </section>
  )
}
function CloudTimeline(props: { snapshot: CloudConversationSnapshot }) {
  const projection = createReactiveTimelineProjection({
    sessionMessages: () => props.snapshot.messages,
    status: () => props.snapshot.status,
    reasoningMode: () => "compact",
  })
  const [open, setOpen] = createStore<Record<string, boolean | undefined>>({})
  const renderer = createSessionTimelineRowRenderer({
    sessionID: () => props.snapshot.session?.id ?? "",
    status: () => props.snapshot.status,
    projection,
    presentation: () => undefined,
    reasoningMode: () => "compact",
    shellToolDefaultOpen: () => false,
    editToolDefaultOpen: () => false,
    disclosure: { value: (key) => open[key], set: (key, value) => setOpen(key, value) },
  })
  return (
    <div class="ps-cloud-timeline">
      <For each={projection.rows()} fallback={<p class="ps-cloud-empty">{cloudText("empty")}</p>}>
        {(row) => <renderer.Row row={() => row} />}
      </For>
    </div>
  )
}
