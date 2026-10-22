// SPDX-License-Identifier: Apache-2.0
/** @jsxImportSource solid-js */
import { createEffect, For, onCleanup, Show, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { roomText } from "./copy"
import { acceptsRoom, roomAccessDenied, roomResourceHref, workcellPath } from "./state"
import type { WorkcellEventPage, WorkcellMessage, WorkcellRoomData, WorkcellRoomOptions } from "./types"
import "./room.css"

/** One canonical room surface for Desktop and the existing Platform console. No model or execution authority. */
export function WorkcellRoom(props: WorkcellRoomOptions) {
  const [state, setState] = createStore({
    room: undefined as WorkcellRoomData | undefined,
    draft: "",
    pending: false,
    error: "",
    stale: false,
    denied: false,
    history: [] as WorkcellMessage[],
    historyCursor: 0,
    historyMore: true,
    historyPending: false,
    preparing: false,
  })
  let refresh = () => Promise.resolve()
  let request: { content: string; requestId: string } | undefined
  let active: AbortController | undefined
  const denied = () => {
    request = undefined
    active?.abort()
    setState({
      room: undefined,
      draft: "",
      history: [],
      denied: true,
      error: roomText("denied"),
      stale: false,
      pending: false,
    })
  }
  createEffect(() => {
    const id = props.workcellId
    const transport = props.transport
    const abort = new AbortController()
    active = abort
    setState({
      room: undefined,
      draft: "",
      pending: false,
      error: "",
      stale: false,
      denied: false,
      history: [],
      historyCursor: 0,
      historyMore: true,
      historyPending: false,
      preparing: false,
    })
    request = undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let cursor = 0
    let loading: Promise<void> | undefined
    const load = () =>
      (loading ??= transport
        .request("GET", workcellPath(id), undefined, abort.signal)
        .then((value) => {
          const next = (value as { workcell: WorkcellRoomData }).workcell
          if (abort.signal.aborted) return
          if (!acceptsRoom(state.room, next, id)) throw new Error("INVALID_WORKCELL_RESPONSE")
          cursor = Math.max(cursor, next.lastEventSequence)
          setState({ room: next, stale: false, error: "" })
        })
        .catch((error) => {
          if (!abort.signal.aborted && roomAccessDenied(error)) {
            denied()
            return
          }
          if (!abort.signal.aborted) setState(state.room ? { stale: true } : { error: roomText("unavailable") })
        })
        .finally(() => {
          loading = undefined
        }))
    refresh = load
    const poll = async () => {
      if (abort.signal.aborted) return
      if (!state.room) await load()
      else
        await transport
          .request("GET", `${workcellPath(id)}/events?after=${cursor}&limit=100`, undefined, abort.signal)
          .then(async (value) => {
            if (abort.signal.aborted) return
            const page = value as WorkcellEventPage
            if (!Array.isArray(page.events) || !Number.isSafeInteger(page.lastEventSequence))
              throw new Error("INVALID_EVENTS")
            if (page.lastEventSequence > cursor) await load()
            else setState("stale", false)
          })
          .catch((error) => {
            if (!abort.signal.aborted) {
              if (roomAccessDenied(error)) denied()
              else setState("stale", true)
            }
          })
      if (!abort.signal.aborted) timer = setTimeout(() => void poll(), 5000)
    }
    untrack(() => void poll())
    onCleanup(() => {
      abort.abort()
      clearTimeout(timer)
    })
  })
  const post = async (event: SubmitEvent) => {
    event.preventDefault()
    const content = state.draft.trim()
    if (!content || state.pending || !state.room?.permissions.canPost) return
    const id = props.workcellId
    const abort = active
    if (!request || request.content !== content) request = { content, requestId: crypto.randomUUID() }
    setState({ pending: true, error: "" })
    await props.transport
      .request("POST", `${workcellPath(id)}/messages`, request, abort?.signal)
      .then((value) => {
        if (abort?.signal.aborted) return
        const next = (value as { workcell: WorkcellRoomData }).workcell
        if (!acceptsRoom(state.room, next, id)) throw new Error("INVALID_WORKCELL_RESPONSE")
        setState("room", next)
        setState("draft", "")
        request = undefined
        void refresh()
      })
      .catch((error) => {
        if (!abort?.signal.aborted) {
          if (roomAccessDenied(error)) denied()
          else setState("error", roomText("failed"))
        }
      })
      .finally(() => {
        if (!abort?.signal.aborted) setState("pending", false)
      })
  }
  const history = async () => {
    if (state.historyPending || !state.historyMore || !state.room) return
    const abort = active
    setState("historyPending", true)
    await props.transport
      .request(
        "GET",
        `${workcellPath(props.workcellId)}/events?after=${state.historyCursor}&limit=100`,
        undefined,
        abort?.signal,
      )
      .then((value) => {
        if (abort?.signal.aborted) return
        const page = value as WorkcellEventPage
        if (
          !Array.isArray(page.events) ||
          !Number.isSafeInteger(page.nextCursor) ||
          page.nextCursor < state.historyCursor
        )
          throw new Error("INVALID_EVENTS")
        setState({
          history: [...state.history, ...page.events.flatMap((event) => (event.message ? [event.message] : []))],
          historyCursor: page.nextCursor,
          historyMore: page.hasMore,
        })
      })
      .catch((error) => {
        if (!abort?.signal.aborted) {
          if (roomAccessDenied(error)) denied()
          else setState("error", roomText("unavailable"))
        }
      })
      .finally(() => {
        if (!abort?.signal.aborted) setState("historyPending", false)
      })
  }
  const messages = () =>
    [
      ...new Map([...state.history, ...(state.room?.messages ?? [])].map((message) => [message.id, message])).values(),
    ].sort((a, b) => a.sequence - b.sequence)
  const prepare = async () => {
    const room = state.room
    const callback = props.onPrepareTask
    const abort = active
    if (!callback || !room || state.preparing) return
    setState("preparing", true)
    await Promise.resolve()
      .then(() => callback(room))
      .catch(() => {
        if (!abort?.signal.aborted) setState("error", roomText("prepareFailed"))
      })
      .finally(() => {
        if (!abort?.signal.aborted) setState("preparing", false)
      })
  }
  const link = (href: string, label: string) => (
    <a
      href={roomResourceHref(href)}
      onClick={(event) => {
        const target = roomResourceHref(href)
        if (!target) {
          event.preventDefault()
          return
        }
        if (props.navigate) {
          event.preventDefault()
          props.navigate(target)
        }
      }}
    >
      {label}
    </a>
  )
  return (
    <section class="ps-workcell-room" data-room-theme={props.theme ?? "dark"} aria-label={roomText("updates")}>
      <Show when={state.error}>
        <p class="pwr-notice pwr-error" role="alert">
          {state.error}{" "}
          <Show when={!state.denied}>
            <button onClick={() => void refresh()}>{roomText("refresh")}</button>
          </Show>
        </p>
      </Show>
      <Show when={state.stale}>
        <p class="pwr-notice" role="status">
          {roomText("stale")}
        </p>
      </Show>
      <Show
        when={state.room}
        fallback={
          <Show when={!state.denied && !state.error}>
            <p role="status">{roomText("loading")}</p>
          </Show>
        }
      >
        {(room) => (
          <>
            <header class="pwr-heading">
              <div>
                <p class="pwr-eyebrow">{room().companyName ?? roomText("updates")}</p>
                <h1>{room().name}</h1>
              </div>
              <span class="pwr-badge">{room().status}</span>
            </header>
            <Show when={props.onPrepareTask}>
              <div class="pwr-task-action">
                <button disabled={state.preparing} onClick={() => void prepare()}>
                  {roomText("prepare")}
                </button>
                <p class="pwr-muted">{roomText("prepareHint")}</p>
              </div>
            </Show>
            <div class="pwr-grid">
              <section class="pwr-conversation">
                <h2>{roomText("updates")}</h2>
                <Show when={room().messagesHasMore && state.historyMore}>
                  <p class="pwr-muted">{roomText(state.historyCursor ? "historyPartial" : "older")}</p>
                  <button disabled={state.historyPending} onClick={() => void history()}>
                    {roomText(
                      state.historyPending ? "historyLoading" : state.historyCursor ? "historyMore" : "history",
                    )}
                  </button>
                </Show>
                <div class="pwr-messages" role="log" aria-live="polite" aria-relevant="additions">
                  <For each={messages()} fallback={<p class="pwr-muted">{roomText("empty")}</p>}>
                    {(message) => (
                      <article class="pwr-message" data-role={message.role}>
                        <div>
                          <strong>{message.role === "system" ? roomText("system") : message.authorName}</strong>
                          <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString()}</time>
                        </div>
                        <p>{message.content}</p>
                      </article>
                    )}
                  </For>
                </div>
                <form class="pwr-compose" onSubmit={post}>
                  <label for={`pwr-update-${props.workcellId}`}>{roomText("add")}</label>
                  <textarea
                    id={`pwr-update-${props.workcellId}`}
                    value={state.draft}
                    maxlength={8000}
                    rows={3}
                    disabled={state.pending || !room().permissions.canPost}
                    onInput={(event) => setState("draft", event.currentTarget.value)}
                  />
                  <div>
                    <p class="pwr-muted">{room().permissions.canPost ? roomText("guidance") : roomText("readonly")}</p>
                    <button
                      class="pwr-primary"
                      type="submit"
                      disabled={state.pending || !state.draft.trim() || !room().permissions.canPost}
                    >
                      {roomText(state.pending ? "sending" : "send")}
                    </button>
                  </div>
                </form>
              </section>
              <aside class="pwr-sidebar">
                <section class="pwr-card">
                  <h2>{roomText("task")}</h2>
                  <p>{room().task}</p>
                  <dl>
                    <For
                      each={
                        [
                          ["objects", room().objects],
                          ["volume", room().volume],
                          ["location", room().location],
                        ] as const
                      }
                    >
                      {(item) => (
                        <>
                          <dt>{roomText(item[0])}</dt>
                          <dd>{item[1] || roomText("unprovided")}</dd>
                        </>
                      )}
                    </For>
                  </dl>
                </section>
                <section class="pwr-card">
                  <h2>{roomText("setup")}</h2>
                  <ol class="pwr-steps">
                    <For each={room().setupStages}>
                      {(stage) => (
                        <li data-complete={stage.status === "complete"}>
                          <strong>{stage.label}</strong>
                          <p>{stage.detail}</p>
                        </li>
                      )}
                    </For>
                  </ol>
                </section>
                <section class="pwr-card">
                  <h2>{roomText("telemetry")}</h2>
                  <p>{room().telemetry.reason || roomText("noTelemetry")}</p>
                  <Show when={room().telemetry.observedAt}>
                    <p class="pwr-muted">
                      {roomText("observed")}: {room().telemetry.observedAt}
                    </p>
                  </Show>
                </section>
                <section class="pwr-card">
                  <h2>{roomText(room().resources.scope === "company" ? "resources" : "personalResources")}</h2>
                  <p class="pwr-muted">
                    {roomText(room().resources.scope === "company" ? "resourcesNote" : "personalResourcesNote")}
                  </p>
                  <h3>{roomText("services")}</h3>
                  <For each={room().resources.services} fallback={<p class="pwr-muted">{roomText("noServices")}</p>}>
                    {(service) => <p>{link(service.href, `${service.workstation} · ${service.status}`)}</p>}
                  </For>
                  <h3>{roomText("models")}</h3>
                  <For each={room().resources.models} fallback={<p class="pwr-muted">{roomText("noModels")}</p>}>
                    {(model) => <p>{link(model.href, `${model.modelId} · ${model.version}`)}</p>}
                  </For>
                  <nav>
                    {link(room().resources.links.services, roomText("openServices"))}
                    {link(room().resources.links.models, roomText("openModels"))}
                    {link(room().resources.links.computeBilling, roomText("billing"))}
                  </nav>
                </section>
              </aside>
            </div>
          </>
        )}
      </Show>
    </section>
  )
}
