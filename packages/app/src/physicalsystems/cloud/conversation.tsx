// SPDX-License-Identifier: Apache-2.0
import { createEffect, createMemo, ErrorBoundary, For, onCleanup, Show, untrack } from "solid-js"
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
import type { CloudConversationOptions, CloudConversationSnapshot } from "./types"

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
  const [state, setState] = createStore<{
    snapshot?: CloudConversationSnapshot
    loading: boolean
    error: "failed" | "denied" | "invalid" | ""
    promptError: "unconfirmed" | "promptFailed" | "length" | ""
    sending: boolean
    uncertain: boolean
  }>({ loading: true, error: "", promptError: "", sending: false, uncertain: false })
  const draft = createStore<ComposerPersistedState>({ prompt: [], context: { items: [] } })
  const client = createCloudConversationClient(props)
  const pending = client.pending()
  if (pending) {
    draft[1]("prompt", [{ type: "text", content: pending.text, start: 0, end: pending.text.length }])
    setState({ uncertain: true, promptError: "unconfirmed" })
  }
  let closed = false
  let fetching = false
  let refreshAgain = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const denied = () => state.error === "denied"
  const writable = () =>
    state.snapshot?.conversation.canWrite === true && state.snapshot.runtime.status === "ready" && !denied()
  const text = () => draft[0].prompt.map((part) => (part.type === "text" ? part.content : "")).join("")
  const clear = () => {
    draft[1]("prompt", [])
    draft[1]("cursor", 0)
  }
  const fail = (error: unknown) => {
    if (closed) return
    if (cloudAccessDenied(error)) {
      setState({ snapshot: undefined, error: "denied", uncertain: false, promptError: "" })
      clear()
      client.dispose()
      clearTimeout(timer)
      return
    }
    setState("error", error instanceof Error && error.message === "INVALID_CLOUD_SNAPSHOT" ? "invalid" : "failed")
  }
  const refresh = async () => {
    if (closed || denied()) return
    if (fetching) {
      refreshAgain = true
      return
    }
    fetching = true
    clearTimeout(timer)
    try {
      const snapshot = await client.snapshot()
      if (!closed) {
        setState("snapshot", reconcile(snapshot))
        setState("error", "")
      }
    } catch (error) {
      fail(error)
    } finally {
      fetching = false
      if (!closed) {
        setState("loading", false)
        if (!denied()) {
          const delay = refreshAgain ? 0 : state.snapshot?.status.type === "busy" ? 1500 : 5000
          refreshAgain = false
          timer = setTimeout(() => void refresh(), delay)
        }
      }
    }
  }
  const send = async (retry = false) => {
    if (!writable() || state.sending || (state.uncertain && !retry)) return
    const value = client.pending()?.text ?? text()
    if (!value.trim() || value.length > 32000) {
      setState("promptError", "length")
      return
    }
    setState({ sending: true, promptError: "" })
    try {
      await client.submit(value)
      if (closed) return
      clear()
      setState("uncertain", false)
      await refresh()
    } catch (error) {
      if (closed) return
      if (cloudAccessDenied(error)) {
        fail(error)
        return
      }
      const uncertain = Boolean(client.pending())
      setState({ uncertain, promptError: uncertain ? "unconfirmed" : "promptFailed" })
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
      placeholder: () => cloudText("placeholder"),
      submit: {
        available: () => writable() && !state.sending && !state.uncertain,
        stopping: () => false,
        onSubmit: () => void send(),
        onStop: () => {},
      },
    },
  })
  // This transport admits text only. Keep the canonical editor while removing
  // local attachment/shell affordances and treating a leading ! as plain text.
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
  const canUseTaskDetails = () =>
    writable() && !state.sending && !state.uncertain && text().length === 0 && !client.pending()
  const useTaskDetails = () => {
    const room = props.workcell
    if (!room || room.id !== props.workcellId || !canUseTaskDetails()) return
    const value = `${cloudText("taskDetailsPrompt")}\n${JSON.stringify({ name: room.name, task: room.task, objects: room.objects, location: room.location }, null, 2)}\n\n`
    draft[1]("prompt", [{ type: "text", content: value, start: 0, end: value.length }])
    draft[1]("cursor", value.length)
    setState("promptError", "")
    composer.restoreFocus(value.length)
  }
  createEffect(() => {
    untrack(() => void refresh())
  })
  const onFocus = () => void refresh()
  window.addEventListener("focus", onFocus)
  onCleanup(() => {
    closed = true
    clearTimeout(timer)
    client.dispose()
    window.removeEventListener("focus", onFocus)
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
        <Show when={state.snapshot}>
          {(snapshot) => <span class="ps-cloud-scope">{cloudText(snapshot().conversation.visibility)}</span>}
        </Show>
      </header>
      <Show when={state.snapshot}>
        <h1>{state.snapshot!.conversation.title}</h1>
      </Show>
      <Show when={state.snapshot && !denied() && props.workcell?.id === props.workcellId && props.workcell}>
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
      <Show when={state.snapshot}>
        <DialogProvider>
          <FileComponentProvider component={() => null}>
            <DataProvider data={data()} directory="" sessionID={session()?.id}>
              <CloudTimeline snapshot={state.snapshot!} />
            </DataProvider>
          </FileComponentProvider>
        </DialogProvider>
        <Show when={state.snapshot!.runtime.status === "unavailable"}>
          <p class="ps-cloud-notice" role="status">
            {cloudText("unavailable")}
          </p>
        </Show>
        <Show when={!state.snapshot!.conversation.canWrite}>
          <p class="ps-cloud-notice">{cloudText("readonly")}</p>
        </Show>
        <Show when={writable()}>
          <div class="ps-cloud-composer">
            <ComposerEditor
              controller={cloudComposer}
              disabled={state.sending || state.uncertain}
              readOnly={state.sending || state.uncertain}
            />
          </div>
          <Show when={state.sending}>
            <p role="status" class="ps-cloud-notice">
              {cloudText("sending")}
            </p>
          </Show>
          <Show when={state.promptError}>
            <div class="ps-cloud-notice" role="alert">
              <p>{cloudText(state.promptError as "unconfirmed" | "promptFailed" | "length")}</p>
              <Show when={state.uncertain}>
                <button type="button" disabled={state.sending} onClick={() => void send(true)}>
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
