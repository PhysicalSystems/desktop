// SPDX-License-Identifier: Apache-2.0
import { createEffect, createMemo, For, onCleanup, Show, untrack, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { Portal } from "solid-js/web"
import { useLocation } from "@solidjs/router"
import { useLanguage } from "../context/language"
import { ServerConnection, useServer } from "../context/server"
import { useTabs } from "../context/tabs"
import { useGlobal } from "../context/global"
import { normalizeSessionInfo } from "../utils/session"
import { createConversationStarter } from "./conversation"
import { Persist, persisted } from "../utils/persist"
import { requireServerKey } from "../utils/session-route"
import { usePhysicalSystems } from "./context"
import { PhysicalPanel } from "./panel"
import { MigrationHistory } from "./migration"
import { ProjectCredentials } from "./credentials"
import { physicalTimestamp } from "./state"
import type { PhysicalConversation, PhysicalProject } from "./types"
import "./physicalsystems.css"

function ConnectionStatus(props: { project: PhysicalProject }) {
  const language = useLanguage()
  const status = () => props.project.connection.status
  return (
    <span class="ps-connection" data-status={status()}>
      <i aria-hidden="true" />
      {language.t(
        status() === "connected"
          ? "physicalsystems.connection.connected"
          : status() === "connecting"
            ? "physicalsystems.connection.connecting"
            : status() === "reconnecting"
              ? "physicalsystems.connection.reconnecting"
              : status() === "offline"
                ? "physicalsystems.connection.offline"
                : "physicalsystems.connection.unknown",
      )}
    </span>
  )
}

function ProjectCreate(props: { close: () => void }) {
  const physical = usePhysicalSystems()!
  const language = useLanguage()
  const [state, setState] = createStore({
    name: "",
    cwd: "",
    kind: "simulation" as "simulation" | "local" | "ssh",
    endpoint: "",
    username: "",
    port: 22,
    remotePort: 8876,
  })
  const dialog: { element?: HTMLDialogElement } = {}
  createEffect(() => dialog.element?.show())
  const create = async (event: SubmitEvent) => {
    event.preventDefault()
    const connection =
      state.kind === "simulation"
        ? { type: state.kind }
        : state.kind === "local"
          ? { type: state.kind, nodeUrl: state.endpoint }
          : {
              type: state.kind,
              host: state.endpoint,
              username: state.username,
              port: state.port,
              remotePort: state.remotePort,
            }
    const result = await physical.send({
      type: "project.create",
      name: state.name.trim(),
      cwd: state.cwd.trim() || undefined,
      connection,
    })
    if (result) props.close()
  }
  return (
    <Portal>
      <dialog
        class="ps-dialog"
        ref={(element) => (dialog.element = element)}
        onCancel={props.close}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault()
            props.close()
          }
        }}
        aria-modal="false"
        aria-labelledby="ps-project-create-title"
      >
        <form onSubmit={create} class="ps-stack">
          <h2 id="ps-project-create-title">{language.t("physicalsystems.project.create")}</h2>
          <label>
            {language.t("physicalsystems.project.name")}
            <input
              autofocus
              required
              maxlength={160}
              value={state.name}
              onInput={(event) => setState("name", event.currentTarget.value)}
            />
          </label>
          <label>
            {language.t("physicalsystems.project.directory")}
            <input value={state.cwd} onInput={(event) => setState("cwd", event.currentTarget.value)} />
          </label>
          <label>
            {language.t("physicalsystems.project.connection")}
            <select
              value={state.kind}
              onChange={(event) => setState("kind", event.currentTarget.value as typeof state.kind)}
            >
              <option value="simulation">{language.t("physicalsystems.project.simulation")}</option>
              <option value="local">{language.t("physicalsystems.project.local")}</option>
              <option value="ssh">{language.t("physicalsystems.project.ssh")}</option>
            </select>
          </label>
          <Show when={state.kind !== "simulation"}>
            <label>
              {language.t("physicalsystems.project.endpoint")}
              <input
                required
                value={state.endpoint}
                onInput={(event) => setState("endpoint", event.currentTarget.value)}
              />
            </label>
          </Show>
          <Show when={state.kind === "ssh"}>
            <label>
              {language.t("physicalsystems.project.username")}
              <input
                required
                value={state.username}
                onInput={(event) => setState("username", event.currentTarget.value)}
              />
            </label>
            <label>
              {language.t("physicalsystems.project.port")}
              <input
                type="number"
                min="1"
                max="65535"
                value={state.port}
                onInput={(event) => setState("port", Number(event.currentTarget.value))}
              />
            </label>
            <label>
              {language.t("physicalsystems.project.remotePort")}
              <input
                type="number"
                min="1"
                max="65535"
                value={state.remotePort}
                onInput={(event) => setState("remotePort", Number(event.currentTarget.value))}
              />
            </label>
          </Show>
          <Show when={physical.state.failures.action}>
            <p role="alert" class="ps-error">
              {physical.state.failures.action}
            </p>
          </Show>
          <div class="ps-actions">
            <button type="button" onClick={props.close}>
              {language.t("physicalsystems.cancel")}
            </button>
            <button class="ps-primary" type="submit" disabled={physical.state.pending.action}>
              {language.t("physicalsystems.project.create")}
            </button>
          </div>
        </form>
      </dialog>
    </Portal>
  )
}

export function PhysicalSystemsLayout(props: ParentProps) {
  const physical = usePhysicalSystems()
  return (
    <Show when={physical?.enabled} fallback={props.children}>
      <PhysicalWorkspace>{props.children}</PhysicalWorkspace>
    </Show>
  )
}

function PhysicalWorkspace(props: ParentProps) {
  const physical = usePhysicalSystems()!
  const language = useLanguage()
  const tabs = useTabs()
  const global = useGlobal()
  const server = useServer()
  const location = useLocation()
  const [saved, setSaved, , ready] = persisted(
    Persist.window("physicalsystems.ui"),
    createStore({ sidebarOpen: true, panelOpen: true }),
  )
  const [state, setState] = createStore({
    create: false,
    credentials: "",
    creatingConversation: false,
    hover: "",
    pinned: false,
    top: 0,
    left: 0,
    rename: "",
    name: "",
  })
  const anchors = new Map<string, HTMLButtonElement>()
  const popup: { element?: HTMLElement; timer?: ReturnType<typeof setTimeout>; restoring?: boolean } = {}
  const route = createMemo(() => {
    const match = /^\/server\/([^/]+)\/session\/([^/]+)$/.exec(location.pathname)
    if (!match) return
    return { serverId: String(requireServerKey(match[1])), sessionId: decodeURIComponent(match[2]) }
  })
  createEffect(() => {
    const identity = route()
    physical.setState("view", identity)
    if (!identity || state.creatingConversation || physical.state.binding) return
    const snapshot = physical.state.snapshot
    const project = snapshot?.projects.find((project) =>
      project.conversations.some(
        (conversation) => conversation.serverId === identity.serverId && conversation.sessionId === identity.sessionId,
      ),
    )
    const conversation = project?.conversations.find(
      (conversation) => conversation.serverId === identity.serverId && conversation.sessionId === identity.sessionId,
    )
    if (
      !project ||
      !conversation ||
      (snapshot?.activeProjectId === project.id && snapshot.activeConversationId === conversation.id)
    )
      return
    untrack(() => {
      if (!physical.state.pending.selection)
        void physical.send(
          { type: "session.select", projectId: project.id, conversationId: conversation.id },
          "selection",
        )
    })
  })
  const bind = async (projectId: string, identity: { serverId: string; sessionId: string; title?: string }) => {
    physical.setState("binding", true)
    const result = await physical.send({ type: "session.bind", projectId, ...identity }, "binding")
    physical.setState("binding", false)
    return Boolean(
      result &&
        result.activeProjectId === projectId &&
        result.conversation?.sessionId === identity.sessionId &&
        result.conversation.serverId === identity.serverId,
    )
  }
  createEffect(() => {
    if (!ready()) return
    physical.setState({ sidebarOpen: saved.sidebarOpen, panelOpen: saved.panelOpen })
  })
  createEffect(() => {
    if (ready()) setSaved("panelOpen", physical.state.panelOpen)
  })
  onCleanup(() => clearTimeout(popup.timer))
  const close = (restore = false) => {
    const anchor = anchors.get(state.hover)
    clearTimeout(popup.timer)
    setState({ hover: "", pinned: false, rename: "" })
    if (restore) {
      popup.restoring = true
      anchor?.focus()
      queueMicrotask(() => (popup.restoring = false))
    }
  }
  const show = (id: string) => {
    clearTimeout(popup.timer)
    if (state.pinned && state.hover !== id) return
    const box = anchors.get(id)?.getBoundingClientRect()
    if (!box) return
    setState({
      hover: id,
      top: Math.max(8, Math.min(box.top, window.innerHeight - 410)),
      left: Math.min(box.right + 8, window.innerWidth - 330),
    })
  }
  const scheduleClose = () => {
    clearTimeout(popup.timer)
    popup.timer = setTimeout(() => {
      if (
        !state.pinned &&
        !popup.element?.contains(document.activeElement) &&
        document.activeElement !== anchors.get(state.hover)
      )
        close()
    }, 260)
  }
  const hoverProject = () => physical.state.snapshot?.projects.find((project) => project.id === state.hover)
  const startConversation = createConversationStarter({
    async create(project, serverId) {
      const connection = server.list.find(
        (item) => ServerConnection.key(item) === serverId && ServerConnection.builtin(item),
      )
      if (!connection || !project.cwd) throw new Error(language.t("physicalsystems.conversation.createFailed"))
      return global
        .ensureServerCtx(connection)
        .sdk.api.session.create({
          agent: "physical-systems",
          location: { directory: project.cwd },
        })
        .then(normalizeSessionInfo)
    },
    bind: (project, serverId, session) => bind(project.id, { serverId, sessionId: session.id, title: session.title }),
  })
  const newConversation = async (project: PhysicalProject) => {
    const connection = server.list.find(
      (item) => ServerConnection.key(item) === server.key && ServerConnection.builtin(item),
    )
    if (!connection || !project.cwd || state.creatingConversation) return false
    const serverId = ServerConnection.key(connection)
    setState("creatingConversation", true)
    physical.setState("failures", "conversation", "")
    const session = await startConversation(project, serverId).catch(() => {
      physical.setState("failures", "conversation", language.t("physicalsystems.conversation.createFailed"))
      return undefined
    })
    if (!session) {
      setState("creatingConversation", false)
      return false
    }
    global.ensureServerCtx(connection).sync.session.remember(session)
    const tab = tabs.addSessionTab({ server: serverId, sessionId: session.id })
    if ("sessionId" in tab) tabs.rememberSessionInfo(tab, session)
    tabs.select(tab)
    setState("creatingConversation", false)
    close()
    return true
  }
  const selectConversation = async (project: PhysicalProject, conversation: PhysicalConversation) => {
    if (!conversation.serverId || !conversation.sessionId || state.creatingConversation) return false
    const selected = await physical.send(
      { type: "session.select", projectId: project.id, conversationId: conversation.id },
      "selection",
    )
    if (!selected) return false
    const tab = tabs.addSessionTab({
      server: ServerConnection.Key.make(conversation.serverId),
      sessionId: conversation.sessionId,
    })
    tabs.select(tab)
    close()
    return true
  }
  const selectProject = async (project: PhysicalProject) => {
    const recent =
      project.conversations.find((conversation) => conversation.id === physical.state.snapshot?.activeConversationId) ??
      project.conversations.findLast((conversation) => conversation.sessionId && conversation.serverId)
    if (recent) return selectConversation(project, recent)
    return newConversation(project)
  }
  return (
    <div class="ps-workspace" data-ps-workspace>
      <nav
        class="ps-projects"
        data-ps-projects
        data-collapsed={!physical.state.sidebarOpen}
        aria-label={language.t("physicalsystems.projects")}
      >
        <div class="ps-heading">
          <Show when={physical.state.sidebarOpen}>
            <strong>{language.t("physicalsystems.projects")}</strong>
          </Show>
          <button
            type="button"
            class="ps-create-project"
            aria-label={language.t("physicalsystems.project.create")}
            onClick={() => setState("create", true)}
          >
            +
          </button>
          <button
            type="button"
            aria-label={language.t(
              physical.state.sidebarOpen ? "physicalsystems.project.collapse" : "physicalsystems.project.expand",
            )}
            aria-expanded={physical.state.sidebarOpen}
            onClick={() => {
              close()
              setSaved("sidebarOpen", !physical.state.sidebarOpen)
            }}
          >
            {physical.state.sidebarOpen ? "‹" : "›"}
          </button>
        </div>
        <div class="ps-project-list">
          <For each={physical.state.snapshot?.projects}>
            {(project) => (
              <button
                type="button"
                ref={(element) => anchors.set(project.id, element)}
                class="ps-project-row"
                data-ps-project-row={project.id}
                aria-current={physical.state.snapshot?.activeProjectId === project.id ? "true" : undefined}
                aria-label={language.t("physicalsystems.project.details", { name: project.name })}
                aria-expanded={state.hover === project.id}
                aria-controls={state.hover === project.id ? "ps-project-hover" : undefined}
                onPointerEnter={() => show(project.id)}
                onPointerLeave={scheduleClose}
                onFocus={() => {
                  if (!popup.restoring) show(project.id)
                }}
                onBlur={scheduleClose}
                onKeyDown={(event) => {
                  if (event.key === "Escape") close(true)
                  if (event.key === "ArrowRight") {
                    event.preventDefault()
                    show(project.id)
                    queueMicrotask(() => popup.element?.querySelector<HTMLButtonElement>("button")?.focus())
                  }
                }}
                onClick={() => void selectProject(project)}
              >
                <span class="ps-project-symbol" aria-hidden="true">
                  {project.name.slice(0, 1).toUpperCase()}
                </span>
                <Show when={physical.state.sidebarOpen}>
                  <span class="ps-project-label">
                    <strong>{project.name}</strong>
                    <ConnectionStatus project={project} />
                  </span>
                  <span class="ps-project-dot" data-status={project.connection.status} aria-hidden="true" />
                </Show>
              </button>
            )}
          </For>
          <Show when={!physical.state.snapshot?.projects.length && physical.state.sidebarOpen}>
            <p class="ps-muted">{language.t("physicalsystems.project.empty")}</p>
          </Show>
        </div>
        <MigrationHistory />
      </nav>
      <div class="ps-conversation">
        <div class="ps-contextbar">
          <div>
            <Show when={physical.project()}>
              {(project) => (
                <>
                  <strong>{project().name}</strong>
                  <Show when={project().connection.kind === "simulation"}>
                    <span class="ps-muted" data-ps-connection-kind="simulation">
                      {language.t("physicalsystems.project.simulation")}
                    </span>
                  </Show>
                  <Show when={project().connection.label}>
                    <span class="ps-context-connection-label" title={project().connection.label}>
                      {project().connection.label}
                    </span>
                  </Show>
                  <ConnectionStatus project={project()} />
                </>
              )}
            </Show>
          </div>
          <div class="ps-actions">
            <Show when={route() && physical.project() && !physical.bound()}>
              <button
                type="button"
                disabled={physical.state.binding || physical.state.unavailable}
                onClick={() => {
                  const project = physical.project()
                  const identity = route()
                  if (project && identity) void bind(project.id, identity)
                }}
              >
                {language.t(
                  physical.state.binding ? "physicalsystems.conversation.binding" : "physicalsystems.conversation.bind",
                  { name: physical.project()?.name ?? "" },
                )}
              </button>
            </Show>
            <Show when={physical.project()}>
              {(project) => (
                <button
                  type="button"
                  class="ps-compose"
                  aria-label={language.t("physicalsystems.conversation.new")}
                  title={language.t("physicalsystems.conversation.new")}
                  disabled={
                    !project().cwd || !server.key || physical.state.pending.selection || state.creatingConversation
                  }
                  onClick={() => void newConversation(project())}
                >
                  <Icon name="edit" size="small" aria-hidden="true" />
                </button>
              )}
            </Show>
            <Show when={!physical.state.panelOpen}>
              <button
                type="button"
                aria-label={language.t("physicalsystems.panel.open")}
                onClick={() => physical.setState("panelOpen", true)}
              >
                {language.t("physicalsystems.name")}
              </button>
            </Show>
          </div>
        </div>
        <Show
          when={
            physical.state.failures.binding || physical.state.failures.selection || physical.state.failures.conversation
          }
        >
          <p class="ps-error" role="alert">
            {physical.state.failures.binding ||
              physical.state.failures.selection ||
              physical.state.failures.conversation}
          </p>
        </Show>
        <div class="ps-session-content">{props.children}</div>
      </div>
      <Show when={physical.state.panelOpen}>
        <PhysicalPanel />
      </Show>
      <Show when={hoverProject()}>
        {(project) => (
          <Portal>
            <section
              id="ps-project-hover"
              ref={(element) => (popup.element = element)}
              class="ps-project-hover"
              role="dialog"
              aria-label={language.t("physicalsystems.project.details", { name: project().name })}
              data-ps-project-hover={project().id}
              style={{ top: `${state.top}px`, left: `${state.left}px` }}
              onPointerEnter={() => clearTimeout(popup.timer)}
              onPointerLeave={scheduleClose}
              onFocusIn={() => clearTimeout(popup.timer)}
              onFocusOut={scheduleClose}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault()
                  close(true)
                }
              }}
            >
              <div class="ps-heading">
                <h2>{project().name}</h2>
                <div class="ps-actions">
                  <button
                    type="button"
                    aria-label={language.t(
                      state.pinned ? "physicalsystems.project.unpin" : "physicalsystems.project.pin",
                    )}
                    aria-pressed={state.pinned}
                    onClick={() => setState("pinned", !state.pinned)}
                  >
                    ⌖
                  </button>
                  <button
                    type="button"
                    aria-label={language.t("physicalsystems.project.close")}
                    onClick={() => close(true)}
                  >
                    ×
                  </button>
                </div>
              </div>
              <ConnectionStatus project={project()} />
              <p class="ps-muted">{project().connection.label}</p>
              <p class="ps-evidence">{project().cwd}</p>
              <p>
                {language.t("physicalsystems.project.devices", {
                  count: project().connection.deviceCount ?? language.t("physicalsystems.unverified"),
                })}
              </p>
              <p>
                {language.t("physicalsystems.project.inUse", {
                  count: project().connection.inUseCount ?? language.t("physicalsystems.unverified"),
                })}
              </p>
              <p class="ps-muted">
                {language.t("physicalsystems.project.observed", {
                  time:
                    physicalTimestamp(project().connection.observedAt, language.intl()) ??
                    language.t("physicalsystems.unverified"),
                })}
              </p>
              <Show when={project().connection.error}>
                <p class="ps-error" role="status">
                  {project().connection.error}
                </p>
              </Show>
              <div class="ps-actions">
                <button
                  type="button"
                  disabled={physical.state.pending.action || physical.state.unavailable}
                  onClick={() =>
                    void physical.send({
                      type:
                        project().connection.status === "connected" ? "connection.disconnect" : "connection.connect",
                      projectId: project().id,
                    })
                  }
                >
                  {language.t(
                    project().connection.status === "connected"
                      ? "physicalsystems.connection.disconnect"
                      : "physicalsystems.connection.connect",
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setState({ rename: project().id, name: project().name, pinned: true })}
                >
                  {language.t("physicalsystems.project.rename")}
                </button>
              </div>
              <Show when={state.rename === project().id}>
                <form
                  class="ps-actions"
                  onSubmit={async (event) => {
                    event.preventDefault()
                    const result = await physical.send({
                      type: "project.rename",
                      projectId: project().id,
                      name: state.name,
                    })
                    if (result) setState("rename", "")
                  }}
                >
                  <input
                    required
                    maxlength={160}
                    aria-label={language.t("physicalsystems.project.name")}
                    value={state.name}
                    onInput={(event) => setState("name", event.currentTarget.value)}
                  />
                  <button type="submit" disabled={physical.state.pending.action}>
                    {language.t("physicalsystems.save")}
                  </button>
                </form>
              </Show>
              <Show when={physical.state.failures.action}>
                <p class="ps-error" role="alert">
                  {physical.state.failures.action}
                </p>
              </Show>
              <Show when={project().connection.status === "offline" && project().connection.kind !== "simulation"}>
                <button
                  type="button"
                  onClick={() => {
                    setState("credentials", project().id)
                    close()
                  }}
                >
                  {language.t("physicalsystems.credentials.open")}
                </button>
              </Show>
              <button
                type="button"
                data-ps-view-devices
                disabled={physical.state.pending.selection || state.creatingConversation}
                onClick={async () => {
                  if (await selectProject(project())) physical.setState({ panel: "devices", panelOpen: true })
                }}
              >
                {language.t("physicalsystems.project.viewDevices")}
              </button>
              <h3>{language.t("physicalsystems.project.history")}</h3>
              <div class="ps-hover-history">
                <Show
                  when={project().conversations.length}
                  fallback={<p class="ps-muted">{language.t("physicalsystems.project.noHistory")}</p>}
                >
                  <For each={project().conversations}>
                    {(conversation) => (
                      <button
                        type="button"
                        disabled={!conversation.serverId || !conversation.sessionId || physical.state.pending.selection}
                        onClick={() => void selectConversation(project(), conversation)}
                      >
                        {conversation.title}
                      </button>
                    )}
                  </For>
                </Show>
              </div>
              <button
                type="button"
                disabled={
                  !project().cwd || !server.key || physical.state.pending.selection || state.creatingConversation
                }
                onClick={() => void newConversation(project())}
              >
                {language.t("physicalsystems.conversation.new")}
              </button>
            </section>
          </Portal>
        )}
      </Show>
      <Show when={physical.state.snapshot?.projects.find((project) => project.id === state.credentials)}>
        {(project) => <ProjectCredentials project={project()} close={() => setState("credentials", "")} />}
      </Show>
      <Show when={state.create}>
        <ProjectCreate close={() => setState("create", false)} />
      </Show>
    </div>
  )
}
