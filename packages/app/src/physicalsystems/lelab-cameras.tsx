// SPDX-License-Identifier: Apache-2.0
import { createEffect, For, onCleanup, Show, untrack } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLanguage } from "../context/language"
import { Persist, persisted } from "../utils/persist"
import type { LeLabCameraBridge, LeLabErrorCode, LeLabRobot } from "../../../physicalsystems/src/lelab-types"
import { createLeLabPreview } from "./lelab-preview"

export function LeLabCameras(props: { bridge: LeLabCameraBridge; scope: string }) {
  const language = useLanguage()
  const [saved, setSaved] = persisted(
    Persist.window("physicalsystems.lelab-cameras"),
    createStore({ url: "http://127.0.0.1:8000", robotName: "" }),
  )
  const [state, setState] = createStore({
    on: false,
    loading: false,
    settings: false,
    robots: [] as LeLabRobot[],
    selected: "",
    error: undefined as LeLabErrorCode | undefined,
    frames: {} as Partial<Record<string, string>>,
    errors: {} as Partial<Record<string, LeLabErrorCode>>,
  })
  const frames = new Map<string, { url?: string; pending?: string; deadline: number }>()
  const clearFrame = (id: string) => {
    const frame = frames.get(id)
    if (frame?.url) URL.revokeObjectURL(frame.url)
    if (frame?.pending) URL.revokeObjectURL(frame.pending)
    frames.delete(id)
    setState("frames", id, undefined)
  }
  const preview = createLeLabPreview(props.bridge, {
    clear() {
      for (const id of frames.keys()) clearFrame(id)
      setState("error", undefined)
      setState("errors", reconcile({}))
    },
    robots(robots, selected) {
      setState({ robots, selected, loading: false })
      if (!selected && robots.length) setState("settings", true)
      if (selected) setSaved("robotName", selected)
    },
    error(id, code) {
      if (!id) return setState({ error: code, loading: false, settings: true })
      clearFrame(id)
      setState("errors", id, code)
    },
    frame(id, received) {
      const now = Date.now()
      const expires = received.receivedAt + 4000
      if (!Number.isFinite(expires) || received.receivedAt > now || expires <= now) {
        clearFrame(id)
        setState("errors", id, "TIMEOUT")
        return
      }
      const previous = frames.get(id)
      if (previous?.pending) URL.revokeObjectURL(previous.pending)
      const pending = URL.createObjectURL(new Blob([new Uint8Array(received.bytes)], { type: received.contentType }))
      const frame: { url?: string; pending?: string; deadline: number } = {
        url: previous?.url,
        pending,
        // Receiving bytes must not extend the lifetime of previously displayed pixels.
        deadline: previous?.url ? previous.deadline : expires,
      }
      frames.set(id, frame)
      const image = new Image()
      image.src = pending
      void image.decode().then(
        () => {
          if (frames.get(id) !== frame || !state.on || expires <= Date.now()) return
          if (frame.url) URL.revokeObjectURL(frame.url)
          frame.url = pending
          frame.pending = undefined
          frame.deadline = expires
          setState("frames", id, pending)
          setState("errors", id, undefined)
        },
        () => {
          if (frames.get(id) !== frame) return
          clearFrame(id)
          setState("errors", id, "INVALID_RESPONSE")
        },
      )
    },
  })
  const off = () => {
    setState({ on: false, loading: false })
    preview.stop()
  }
  const start = () => {
    setState({ on: true, loading: true, robots: [], selected: "" })
    void preview.start(saved.url, saved.robotName)
  }
  createEffect(() => {
    props.scope
    untrack(off)
  })
  const freshness = setInterval(() => {
    for (const [id, frame] of frames) {
      if (frame.deadline > Date.now()) continue
      clearFrame(id)
      setState("errors", id, "TIMEOUT")
    }
  }, 500)
  onCleanup(() => {
    off()
    clearInterval(freshness)
  })
  const selected = () => state.robots.find((item) => item.name === state.selected)
  return (
    <section
      class="ps-card ps-lelab-cameras"
      data-ps-lelab-cameras
      aria-label={language.t("physicalsystems.lelab.title")}
    >
      <div class="ps-heading">
        <button
          type="button"
          role="switch"
          aria-checked={state.on}
          aria-label={language.t("physicalsystems.lelab.title")}
          data-ps-lelab-toggle
          onClick={() => (state.on ? off() : start())}
        >
          <span class="ps-lelab-switch" data-on={state.on} aria-hidden="true">
            <i />
          </span>
          {language.t("physicalsystems.lelab.title")}
          <span class="ps-muted">
            {language.t(state.on ? "physicalsystems.lelab.on" : "physicalsystems.lelab.off")}
          </span>
        </button>
        <Show when={state.on}>
          <span class="ps-muted ps-lelab-robot">{state.selected}</span>
          <button type="button" onClick={start} disabled={state.loading}>
            {language.t("physicalsystems.refresh")}
          </button>
        </Show>
      </div>
      <Show when={state.on}>
        <div class="ps-lelab-body ps-stack">
          <details open={state.settings} onToggle={(event) => setState("settings", event.currentTarget.open)}>
            <summary>{language.t("physicalsystems.lelab.connection")}</summary>
            <label>
              {language.t("physicalsystems.lelab.address")}
              <input
                type="url"
                value={saved.url}
                onInput={(event) => {
                  preview.stop()
                  setState({ loading: false, robots: [], selected: "" })
                  setSaved("url", event.currentTarget.value)
                }}
              />
            </label>
            <p class="ps-muted">{language.t("physicalsystems.lelab.connectionHelp")}</p>
            <button type="button" onClick={start} disabled={state.loading}>
              {language.t("physicalsystems.lelab.connect")}
            </button>
            <Show when={state.robots.length}>
              <label>
                {language.t("physicalsystems.lelab.robot")}
                <select
                  value={state.selected}
                  onChange={(event) => {
                    setSaved("robotName", event.currentTarget.value)
                    start()
                  }}
                >
                  <option value="" disabled>
                    {language.t("physicalsystems.lelab.selectRobot")}
                  </option>
                  <For each={state.robots}>{(robot) => <option value={robot.name}>{robot.name}</option>}</For>
                </select>
              </label>
            </Show>
          </details>
          <Show when={state.loading}>
            <p role="status">{language.t("physicalsystems.lelab.loading")}</p>
          </Show>
          <Show when={state.error}>
            {(code) => (
              <p class="ps-error" role="status">
                {language.t(`physicalsystems.lelab.error.${code()}`)}
              </p>
            )}
          </Show>
          <Show when={!state.loading && !state.error && !state.robots.length}>
            <p class="ps-muted">{language.t("physicalsystems.lelab.noRobots")}</p>
          </Show>
          <Show when={selected() && !selected()!.cameras.length}>
            <p class="ps-muted">{language.t("physicalsystems.lelab.noCameras")}</p>
          </Show>
          <div class="ps-lelab-grid">
            <For each={selected()?.cameras}>
              {(camera) => (
                <figure class="ps-lelab-camera" data-ps-lelab-camera={camera.id}>
                  <div class="ps-lelab-image">
                    <Show
                      when={state.frames[camera.id]}
                      fallback={
                        <p role="status">
                          {language.t(
                            state.errors[camera.id]
                              ? `physicalsystems.lelab.error.${state.errors[camera.id]!}`
                              : "physicalsystems.lelab.waiting",
                          )}
                        </p>
                      }
                    >
                      <img
                        src={state.frames[camera.id]}
                        alt={language.t("physicalsystems.lelab.frame", { name: camera.name })}
                      />
                    </Show>
                  </div>
                  <figcaption>
                    <strong>{camera.name}</strong>
                    <span class="ps-muted">
                      {camera.width} × {camera.height}
                    </span>
                  </figcaption>
                </figure>
              )}
            </For>
          </div>
        </div>
      </Show>
    </section>
  )
}
