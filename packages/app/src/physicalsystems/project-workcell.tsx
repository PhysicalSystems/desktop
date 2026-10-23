// SPDX-License-Identifier: Apache-2.0
import { For, onCleanup, onMount, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Portal } from "solid-js/web"
import { useLanguage } from "../runtime/i18n/language"
import { usePlatform } from "../runtime/platform/platform"
import type { PhysicalProject } from "./types"
import type { WorkcellAccountBridge, WorkcellAccountState } from "../../../physicalsystems/src/workcell-account-types"
import type {
  ProjectWorkcellBridge,
  ProjectWorkcellMetadata,
  ProjectWorkcellState,
} from "../../../physicalsystems/src/workcell-project-types"
import "./project-workcell.css"

export function ProjectWorkcell(props: {
  project: PhysicalProject
  bridge: ProjectWorkcellBridge
  account: WorkcellAccountBridge
  close(): void
}) {
  const language = useLanguage()
  const platform = usePlatform()
  const projectId = props.project.id
  const [state, setState] = createStore({
    account: undefined as WorkcellAccountState | undefined,
    link: undefined as ProjectWorkcellState | undefined,
    rooms: [] as { id: string; name: string }[],
    selected: "",
    mode: "create" as "create" | "link",
    name: props.project.name.slice(0, 120),
    task: "",
    objects: "",
    volume: "",
    location: "",
    busy: true,
    error: false,
    listError: false,
  })
  const lifetime = { disposed: false, request: 0 }
  const dialog: { element?: HTMLDialogElement } = {}
  const current = (accountId: string | undefined, revision: number | undefined) =>
    !lifetime.disposed &&
    state.account?.status === "signed_in" &&
    state.account.account?.id === accountId &&
    state.account.revision === revision
  const publish = (value: ProjectWorkcellState) => {
    if (value.projectId !== projectId || value.accountId !== state.account?.account?.id) return
    setState("link", reconcile(value))
    const metadata = value.pendingMetadata ?? value.workcell
    if (metadata)
      setState({
        name: metadata.name,
        task: metadata.task,
        objects: metadata.objects ?? "",
        volume: metadata.volume ?? "",
        location: metadata.location ?? "",
      })
  }
  const load = async () => {
    const accountId = state.account?.account?.id
    const revision = state.account?.revision
    const request = ++lifetime.request
    setState({ busy: true, error: false, listError: false })
    await Promise.all([
      props.bridge.refresh(projectId).then(
        (value) => {
          if (current(accountId, revision) && request === lifetime.request) publish(value)
        },
        () => {
          if (current(accountId, revision) && request === lifetime.request) setState("error", true)
        },
      ),
      props.account
        .request("GET", "/api/workcells")
        .then((value) => {
          if (!current(accountId, revision) || request !== lifetime.request) return
          const rooms = (value as { workcells?: { id: string; name: string }[] }).workcells
          if (
            !Array.isArray(rooms) ||
            rooms.some((room) => !room || typeof room.id !== "string" || typeof room.name !== "string")
          )
            throw new Error("INVALID_RESPONSE")
          setState("rooms", rooms)
          if (!rooms.some((room) => room.id === state.selected)) setState("selected", "")
        })
        .catch(() => {
          if (current(accountId, revision) && request === lifetime.request) setState("listError", true)
        }),
    ])
    if (!lifetime.disposed && request === lifetime.request) setState("busy", false)
  }
  const accountChanged = (value: WorkcellAccountState) => {
    if (lifetime.disposed || (state.account && value.revision < state.account.revision)) return
    const previous = state.account
    const changed =
      previous?.revision !== value.revision ||
      previous?.account?.id !== value.account?.id ||
      previous?.status !== value.status
    setState("account", value)
    if (!changed) return
    ++lifetime.request
    setState({
      link: undefined,
      rooms: [],
      selected: "",
      task: "",
      objects: "",
      volume: "",
      location: "",
      name: props.project.name.slice(0, 120),
      error: false,
      busy: false,
    })
    if (value.status === "signed_in") void load()
  }
  onMount(() => {
    dialog.element?.showModal()
    const unsubscribe = props.account.subscribe(accountChanged)
    void props.account.refresh().then(accountChanged, () => setState({ busy: false, error: true }))
    onCleanup(() => {
      lifetime.disposed = true
      ++lifetime.request
      unsubscribe()
    })
  })
  const accountCall = async (operation: () => Promise<WorkcellAccountState>) => {
    if (state.busy) return
    setState({ busy: true, error: false })
    await operation().then(accountChanged, () => {
      if (!lifetime.disposed) setState("error", true)
    })
    if (!lifetime.disposed && state.account?.status !== "signed_in") setState("busy", false)
  }
  const call = async (operation: () => Promise<ProjectWorkcellState>) => {
    if (state.busy || state.account?.status !== "signed_in") return
    const accountId = state.account.account?.id
    const revision = state.account.revision
    const request = ++lifetime.request
    setState({ busy: true, error: false })
    await operation().then(
      (value) => {
        if (current(accountId, revision) && request === lifetime.request) publish(value)
      },
      () => {
        if (current(accountId, revision) && request === lifetime.request) setState("error", true)
      },
    )
    if (!lifetime.disposed && request === lifetime.request) setState("busy", false)
  }
  const metadata = (): ProjectWorkcellMetadata => ({
    name: state.name.trim(),
    task: state.task.trim(),
    objects: state.objects.trim(),
    volume: state.volume.trim(),
    location: state.location.trim(),
  })
  const immutable = () =>
    state.busy ||
    Boolean(state.link?.pendingOperation) ||
    state.link?.status === "conflict" ||
    Boolean(state.link?.workcell && !state.link.workcell.canWrite)
  const status = () => state.link?.status ?? "signed_out"
  const error = () => {
    if (state.link?.errorCode === "PROJECT_ACCOUNT_MISMATCH")
      return language.t("physicalsystems.projectWebsite.accountMismatch")
    if (state.link?.errorCode === "METADATA_CONFLICT") return language.t("physicalsystems.projectWebsite.conflict")
    if (state.link?.errorCode === "WORKCELL_ACCESS_REVOKED") return language.t("physicalsystems.projectWebsite.revoked")
    if (state.link?.errorCode === "PROJECT_LINK_STORE_UNAVAILABLE")
      return language.t("physicalsystems.projectWebsite.storageError")
    if (state.link?.errorCode === "WORKCELL_READ_ONLY") return language.t("physicalsystems.projectWebsite.readOnly")
    return language.t("physicalsystems.projectWebsite.error")
  }
  return (
    <Portal>
      <dialog
        ref={(element) => (dialog.element = element)}
        class="ps-dialog ps-project-website"
        aria-labelledby="ps-project-website-title"
        onCancel={props.close}
      >
        <div class="ps-stack">
          <div class="ps-heading">
            <h2 id="ps-project-website-title">
              {language.t("physicalsystems.projectWebsite.title", { name: props.project.name })}
            </h2>
            <button type="button" onClick={props.close}>
              {language.t("physicalsystems.projectWebsite.close")}
            </button>
          </div>
          <p class="ps-muted">{language.t("physicalsystems.projectWebsite.description")}</p>
          <Show
            when={state.account?.status === "signed_in"}
            fallback={
              <div class="ps-stack">
                <p>{language.t("physicalsystems.projectWebsite.signIn")}</p>
                <Show
                  when={state.account?.pending}
                  fallback={
                    <button disabled={state.busy} onClick={() => void accountCall(() => props.account.signIn())}>
                      {language.t("physicalsystems.rooms.signIn")}
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
                      <button
                        disabled={state.busy}
                        onClick={() => void accountCall(() => props.account.cancelSignIn())}
                      >
                        {language.t("physicalsystems.account.cancel")}
                      </button>
                    </>
                  )}
                </Show>
              </div>
            }
          >
            <div class="ps-project-website-account">
              <span>
                {language.t("physicalsystems.projectWebsite.account", { email: state.account?.account?.email ?? "" })}
              </span>
              <button disabled={state.busy} onClick={() => void accountCall(() => props.account.signOut())}>
                {language.t("physicalsystems.account.signOut")}
              </button>
            </div>
            <p role="status">
              {state.busy
                ? language.t("physicalsystems.projectWebsite.loading")
                : language.t(`physicalsystems.projectWebsite.status.${status()}`)}
            </p>
            <Show when={state.link?.status === "local"}>
              <label>
                {language.t("physicalsystems.projectWebsite.action")}
                <select
                  disabled={state.busy}
                  value={state.mode}
                  onChange={(event) => setState("mode", event.currentTarget.value as "create" | "link")}
                >
                  <option value="create">{language.t("physicalsystems.projectWebsite.create")}</option>
                  <option value="link">{language.t("physicalsystems.projectWebsite.existing")}</option>
                </select>
              </label>
            </Show>
            <Show
              when={
                state.link &&
                (state.link.workcell ||
                  state.link.pendingOperation ||
                  (state.link.status === "local" && state.mode === "create"))
              }
              fallback={
                <Show when={state.link?.status === "local"}>
                  <label>
                    {language.t("physicalsystems.rooms.choose")}
                    <select
                      disabled={state.busy}
                      value={state.selected}
                      onChange={(event) => setState("selected", event.currentTarget.value)}
                    >
                      <option value="">{language.t("physicalsystems.projectWebsite.choose")}</option>
                      <For each={state.rooms}>{(room) => <option value={room.id}>{room.name}</option>}</For>
                    </select>
                  </label>
                  <button
                    disabled={state.busy || !state.selected}
                    onClick={() => void call(() => props.bridge.link(projectId, state.selected))}
                  >
                    {language.t("physicalsystems.projectWebsite.link")}
                  </button>
                  <Show when={state.listError}>
                    <p role="alert" class="ps-error">
                      {language.t("physicalsystems.projectWebsite.listError")}
                    </p>
                  </Show>
                </Show>
              }
            >
              <form
                class="ps-stack"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (!immutable())
                    void call(() =>
                      state.link?.workcell
                        ? props.bridge.sync(projectId, metadata())
                        : props.bridge.create(projectId, metadata()),
                    )
                }}
              >
                <fieldset disabled={immutable()} class="ps-stack">
                  <label>
                    {language.t("physicalsystems.projectWebsite.name")}
                    <input
                      required
                      maxlength={120}
                      value={state.name}
                      onInput={(event) => setState("name", event.currentTarget.value)}
                    />
                  </label>
                  <label>
                    {language.t("physicalsystems.projectWebsite.task")}
                    <textarea
                      required
                      maxlength={8000}
                      rows={4}
                      value={state.task}
                      onInput={(event) => setState("task", event.currentTarget.value)}
                    />
                  </label>
                  <details>
                    <summary>{language.t("physicalsystems.projectWebsite.details")}</summary>
                    <div class="ps-stack">
                      <label>
                        {language.t("physicalsystems.projectWebsite.objects")}
                        <textarea
                          maxlength={2000}
                          rows={2}
                          value={state.objects}
                          onInput={(event) => setState("objects", event.currentTarget.value)}
                        />
                      </label>
                      <label>
                        {language.t("physicalsystems.projectWebsite.volume")}
                        <input
                          maxlength={500}
                          value={state.volume}
                          onInput={(event) => setState("volume", event.currentTarget.value)}
                        />
                      </label>
                      <label>
                        {language.t("physicalsystems.projectWebsite.location")}
                        <input
                          maxlength={1000}
                          value={state.location}
                          onInput={(event) => setState("location", event.currentTarget.value)}
                        />
                      </label>
                    </div>
                  </details>
                  <button type="submit" disabled={!state.name.trim() || !state.task.trim()}>
                    {language.t(
                      state.link?.workcell
                        ? "physicalsystems.projectWebsite.sync"
                        : "physicalsystems.projectWebsite.create",
                    )}
                  </button>
                </fieldset>
              </form>
            </Show>
            <Show when={state.link?.workcell && !state.link.workcell.canWrite}>
              <p class="ps-muted">{language.t("physicalsystems.projectWebsite.readOnly")}</p>
            </Show>
            <Show when={state.link?.pendingOperation && state.link?.status !== "conflict"}>
              <button disabled={state.busy} onClick={() => void call(() => props.bridge.retry(projectId))}>
                {language.t("physicalsystems.projectWebsite.retry")}
              </button>
            </Show>
            <div class="ps-actions">
              <button disabled={state.busy} onClick={() => void load()}>
                {language.t(
                  state.link?.status === "conflict"
                    ? "physicalsystems.projectWebsite.readLatest"
                    : "physicalsystems.refresh",
                )}
              </button>
              <Show when={state.link?.workcell}>
                {(workcell) => (
                  <button
                    onClick={() =>
                      void platform.openExternal(
                        `https://physicalsystems.ai/dashboard/workcells/${encodeURIComponent(workcell().id)}`,
                      )
                    }
                  >
                    {language.t("physicalsystems.projectWebsite.open")}
                  </button>
                )}
              </Show>
            </div>
          </Show>
          <Show when={state.error || state.link?.errorCode || state.account?.error}>
            <p role="alert" class="ps-error">
              {error()}
            </p>
          </Show>
        </div>
      </dialog>
    </Portal>
  )
}
