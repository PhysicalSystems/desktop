import { render, Portal } from "solid-js/web"
import { createSessionTimelineRowRenderer } from "@opencode/session-ui/timeline/row"
import { timelinePresets } from "@opencode/session-ui/timeline/detail"
import { createTimelineDetail, createTimelineProjection } from "../../../src/session/timeline/projection"
import { DataProvider } from "@opencode/session-ui/context"
import { DialogProvider } from "@opencode/ui/context/dialog"
import { PhysicalSystemsProvider } from "../../../src/physicalsystems/context"
import { PhysicalSystemsLayout } from "../../../src/physicalsystems/layout"
import { PhysicalOperations } from "../../../src/physicalsystems/operations"
import { setLocation, location, sessions, setTabInfo, tabKey, navigation, portal } from "./mocks"
import type { PhysicalCommand, PhysicalSnapshot } from "../../../src/physicalsystems/types"
import { createStore } from "solid-js/store"
import { For, Show } from "solid-js"
import { modelBridge, models } from "./models"
import { RobotModelPicker } from "../../../src/physicalsystems/robot-model-picker"
import { cloudAccounts, conversationBridge, roomsBridge, projectWorkcellBridge } from "./cloud-accounts"

const [fixture, setFixture] = createStore({
  gate: true,
  forged: false,
  foreignSession: false,
  timelinePreset: "compact",
})
const state: PhysicalSnapshot = {
  revision: 1,
  serviceId: "service-fixture",
  activeProjectId: "project-a",
  activeConversationId: "conversation-a",
  connectionGeneration: 7,
  projects: [
    {
      id: "project-a",
      name: "Alignment lab",
      cwd: "/fixture/a",
      connection: {
        kind: "simulation",
        label: "Synthetic fixture",
        status: "offline",
        observedAt: null,
        deviceCount: null,
        inUseCount: null,
      },
      conversations: [
        { id: "conversation-a", title: "Alignment experiment", sessionId: "session-a", serverId: "sidecar" },
      ],
    },
    {
      id: "project-b",
      name: "Other project",
      cwd: "/fixture/b",
      connection: {
        kind: "local",
        label: "Unconnected Node",
        status: "offline",
        observedAt: null,
        deviceCount: null,
        inUseCount: null,
      },
      conversations: [
        { id: "conversation-b", title: "Separate conversation", sessionId: "session-b", serverId: "sidecar" },
      ],
    },
  ],
  conversation: { id: "conversation-a", title: "Alignment experiment", sessionId: "session-a", serverId: "sidecar" },
  workcell: null,
  setupReport: null,
  experiments: {
    availability: "simulation-only",
    current: {
      id: "experiment-a",
      goal: "Compare synthetic offsets <img src=x onerror=alert(1)>",
      planDigest: "digest-a",
      phase: "PROPOSED",
      trialLimit: 3,
      expiresAt: Date.now() + 120000,
      trials: [],
    },
    history: [],
  },
  activeRuns: [],
  activeCaptures: [],
  activeExperiments: [
    {
      projectId: "project-a",
      projectName: "Alignment lab",
      conversationId: "conversation-a",
      serverId: "sidecar",
      sessionId: "session-a",
      connectionGeneration: 7,
      canStop: true,
      experiment: {
        id: "experiment-a",
        goal: "Alignment",
        planDigest: "digest-a",
        phase: "PROPOSED",
        trialLimit: 3,
        trials: [],
      },
    },
  ],
}
if ((window as typeof window & { __fixtureEmpty?: boolean }).__fixtureEmpty) {
  state.projects = []
  state.activeProjectId = null
  state.activeConversationId = null
  state.conversation = null
  state.activeExperiments = []
  state.experiments = null
  setLocation("pathname", "/")
}
const fixtureWindow = window as typeof window & {
  __fixture: {
    cloudAccounts: typeof cloudAccounts
    models: typeof models
    portal: typeof portal
    state: PhysicalSnapshot
    calls: PhysicalCommand[]
    emit: (patch?: Partial<PhysicalSnapshot>) => void
    gate: (value: boolean) => void
    forge: (value: boolean) => void
    foreignSession: (value: boolean) => void
    timelinePreset: (value: string) => void
    route: (value: string, directory?: string) => void
    failBinding: boolean
    failProjectCreate: boolean
    holdNavigation: boolean
    flushNavigation: () => void
    release?: () => void
    hold: boolean
    recoverCalls: number
    recoverReject: boolean
    imports: string[]
    errors: string[]
    sessions: typeof sessions
    pathname: () => string
    camera: (id: string, ttl?: number, candidate?: string, capture?: string) => void
    holdFrame: boolean
    failFrame: boolean
    releaseFrame?: () => void
  }
}
const listeners = new Set<(value: PhysicalSnapshot) => void>()
fixtureWindow.__fixture = {
  cloudAccounts,
  models,
  portal,
  state,
  calls: [],
  hold: false,
  failBinding: false,
  failProjectCreate: Boolean(
    (window as typeof window & { __fixtureFailProjectCreate?: boolean }).__fixtureFailProjectCreate,
  ),
  get holdNavigation() {
    return navigation.hold
  },
  set holdNavigation(value) {
    navigation.hold = value
  },
  flushNavigation: navigation.flush,
  recoverCalls: 0,
  recoverReject: false,
  imports: [],
  errors: [],
  sessions,
  holdFrame: false,
  failFrame: false,
  pathname: () => location.pathname,
  camera(id, ttl = 6000, candidate = "camera-a", capture = "capture-a") {
    state.projects.find((project) => project.id === state.activeProjectId)!.connection.status = "connected"
    state.workcell = {
      camera: {
        availability: "available",
        previewFrameId: id,
        receivedAt: Date.now(),
        stopCaptureSessionId: capture,
        frame: {
          frameId: id,
          candidateId: candidate,
          candidateDigest: `digest-${candidate}`,
          captureSessionId: capture,
          capture: { clockSessionId: "fixture-clock" },
          source: { hardwareIdentity: candidate, kind: "fixture", identityStability: "stable" },
        },
        status: {
          phase: "live",
          captureSessionId: capture,
          selectedCandidateId: candidate,
          frameFresh: true,
          frameAgeMs: 0,
          staleAfterMs: ttl,
          availableCameras: [candidate, "other-camera"].map((candidateId) => ({
            candidateId,
            candidateDigest: `digest-${candidateId}`,
          })),
        },
      },
    }
    state.activeCaptures = [
      {
        projectId: state.activeProjectId!,
        conversationId: state.activeConversationId!,
        serverId: state.conversation!.serverId,
        sessionId: state.conversation!.sessionId,
        connectionGeneration: state.connectionGeneration,
        captureSessionId: capture,
        canStop: true,
      },
    ]
    fixtureWindow.__fixture.emit()
  },
  emit(patch) {
    Object.assign(state, patch)
    state.revision += 1
    listeners.forEach((listener) => listener(structuredClone(state)))
  },
  gate: (value) => setFixture("gate", value),
  forge: (value) => setFixture("forged", value),
  foreignSession: (value) => setFixture("foreignSession", value),
  timelinePreset: (value) => setFixture("timelinePreset", value),
  route(value, directory) {
    const match = /^\/server\/([^/]+)\/session\/([^/]+)$/.exec(value)
    if (match && directory) setTabInfo(tabKey({ server: atob(match[1]), sessionId: match[2] }), { directory })
    setLocation("pathname", value)
  },
}
window.addEventListener("error", (event) => fixtureWindow.__fixture.errors.push(event.message))
window.addEventListener("unhandledrejection", (event) => fixtureWindow.__fixture.errors.push(String(event.reason)))
window.api = {
  physicalSystems: {
    ...((window as typeof window & { __fixtureCloud?: boolean }).__fixtureCloud
      ? { conversations: conversationBridge, rooms: roomsBridge }
      : {}),
    ...((window as typeof window & { __fixtureProjectLink?: boolean }).__fixtureProjectLink
      ? { projectWorkcells: projectWorkcellBridge }
      : {}),
    models: modelBridge,
    snapshot: async () => structuredClone(state),
    async recover() {
      fixtureWindow.__fixture.recoverCalls++
      if (fixtureWindow.__fixture.recoverReject) throw new Error("fixture recovery failed")
      if (state.hostUnavailable) state.serviceId = `recovered-service-${fixtureWindow.__fixture.recoverCalls}`
      state.revision = 1
      state.hostUnavailable = false
      state.closeBlocked = false
      return structuredClone(state)
    },
    migration: {
      async preview() {
        return {
          token: "trusted-preview-token",
          id: "archive-fixture",
          projectCount: 1,
          conversationCount: 1,
          messageCount: 1,
          projects: [{ name: "Imported lab", conversationCount: 1, messageCount: 1 }],
          warnings: [],
        }
      },
      async commit(token) {
        fixtureWindow.__fixture.imports.push(token)
        return {
          id: "archive-fixture",
          projectCount: 1,
          conversationCount: 1,
          messageCount: 1,
          projects: [{ name: "Imported lab", conversationCount: 1, messageCount: 1 }],
          warnings: [],
        }
      },
      async list() {
        return []
      },
      async read() {
        return {
          schemaVersion: 1,
          sourceSchemaVersion: 1,
          id: "archive-fixture",
          authority: "none",
          readOnly: true,
          warnings: [],
          sources: [],
          projects: [
            {
              id: "legacy-project",
              name: "Imported lab",
              connection: { kind: "local", label: "Old Node", status: "offline" },
              conversations: [
                {
                  id: "legacy-conversation",
                  title: "Historical experiment",
                  draft: "**Literal saved draft**",
                  archived: false,
                  messages: [
                    {
                      id: "old-approval",
                      parentId: null,
                      role: "assistant",
                      sourceType: "message",
                      text: "APPROVED <img src=x onerror=alert(1)> experiment.approveAndContinue",
                    },
                  ],
                },
              ],
            },
          ],
        }
      },
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async command(request) {
      fixtureWindow.__fixture.calls.push(request)
      if (request.type === "project.create") {
        if (fixtureWindow.__fixture.failProjectCreate) throw new Error("Fixture project creation failed")
        const id = `project-created-${state.projects.length}`
        state.projects.push({
          id,
          name: request.name,
          cwd: request.cwd || `/fixture/managed/${id}`,
          connection: {
            kind: request.connection.type,
            label: "Synthetic fixture",
            status: "connected",
            observedAt: null,
            deviceCount: null,
            inUseCount: null,
          },
          conversations: [],
        })
        state.activeProjectId = id
        state.activeConversationId = null
        state.conversation = null
      }
      if (request.type === "experiment.approveAndContinue" && fixtureWindow.__fixture.hold)
        await new Promise<void>((resolve) => (fixtureWindow.__fixture.release = resolve))
      if (request.type === "session.select") {
        const project = state.projects.find((project) => project.id === request.projectId)!
        state.activeProjectId = project.id
        state.activeConversationId = request.conversationId
        state.conversation = project.conversations.find((conversation) => conversation.id === request.conversationId)!
      }
      if (request.type === "session.bind") {
        if (fixtureWindow.__fixture.failBinding)
          throw new Error("Error invoking remote method 'physicalsystems:command': Error: MODEL_SESSION_SCOPE_MISMATCH")
        const project = state.projects.find((project) => project.id === request.projectId)!
        const conversation = project.conversations.find(
          (conversation) => conversation.sessionId === request.sessionId && conversation.serverId === request.serverId,
        ) ?? {
          id: `binding-${request.sessionId}`,
          title: request.title ?? "New conversation",
          serverId: request.serverId,
          sessionId: request.sessionId,
        }
        if (!project.conversations.includes(conversation)) project.conversations.push(conversation)
        state.activeProjectId = project.id
        state.activeConversationId = conversation.id
        state.conversation = conversation
      }
      if (request.type === "experiment.stop") state.activeExperiments = []
      if (request.type === "workcell.camera.stop") {
        state.workcell!.camera!.stopPending = true
        state.activeCaptures = []
      }
      if (request.type === "workcell.camera.frame") {
        if (fixtureWindow.__fixture.holdFrame)
          await new Promise<void>((resolve) => (fixtureWindow.__fixture.releaseFrame = resolve))
        if (fixtureWindow.__fixture.failFrame) throw new Error("fixture frame fetch failed")
        const canvas = document.createElement("canvas")
        canvas.width = canvas.height = 2
        canvas.getContext("2d")!.fillRect(0, 0, 2, 2)
        state.commandResult = {
          frame: {
            ...request,
            id: request.frameId,
            contentType: "image/jpeg",
            captureSessionId: state.workcell!.camera!.frame!.captureSessionId,
            bytes: Array.from(atob(canvas.toDataURL("image/jpeg").split(",")[1]), (value) => value.charCodeAt(0)),
          },
        }
      }
      fixtureWindow.__fixture.emit()
      return structuredClone(state)
    },
  },
}
if ((window as typeof window & { __fixtureWithoutBridge?: boolean }).__fixtureWithoutBridge) window.api = undefined

function ComposerFixture(props: { name: string }) {
  return (
    <div data-fixture-composer={props.name}>
      <input data-fixture-control="file" type="file" class="fixture-hidden" />
      <button data-fixture-control="button" type="button" class="fixture-composer-button">
        Fixture composer button
      </button>
      <button data-fixture-control="disabled" type="button" class="fixture-composer-button" disabled>
        Disabled fixture button
      </button>
      <label data-fixture-control="label">Fixture composer label</label>
      <input data-fixture-control="text" class="fixture-composer-text" />
      <textarea data-fixture-control="textarea" class="fixture-composer-text" />
      <select data-fixture-control="select" class="fixture-composer-text">
        <option>Fixture choice</option>
      </select>
    </div>
  )
}

function TimelineFixture() {
  const detail = createTimelineDetail(
    () => timelinePresets.find((preset) => preset.id === fixture.timelinePreset)!.value,
  )
  const projection = createTimelineProjection({
    sessionMessages: () => [
      { id: "msg_user", type: "user", text: "Propose a synthetic experiment", time: { created: 1 } },
      {
        id: "msg_assistant",
        type: "assistant",
        agent: "physical-systems",
        model: { providerID: "fixture", id: "fixture", variant: "default" },
        content: [
          {
            type: "tool",
            id: "proposal-part",
            name: "propose_local_experiment",
            time: { created: 2, completed: 3 },
            state: {
              status: "completed",
              input: {},
              content: [{ type: "text", text: "Synthetic plan proposed" }],
              metadata: {
                physicalSystems: {
                  projectId: "project-a",
                  conversationId: "conversation-a",
                  serverId: "sidecar",
                  sessionId: fixture.foreignSession ? "session-b" : "session-a",
                  experimentId: "experiment-a",
                  planDigest: fixture.forged ? "forged-digest" : "digest-a",
                },
              },
            },
          },
        ],
        time: { created: 2, completed: 3 },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    ],
    status: () => ({ type: "idle" }),
    reasoningMode: () => "compact",
    timelineDetail: detail,
  })
  const [open, setOpen] = createStore<Record<string, boolean | undefined>>({})
  const renderer = createSessionTimelineRowRenderer({
    sessionID: () => "session-a",
    status: () => ({ type: "idle" }),
    projection,
    presentation: () => undefined,
    reasoningMode: () => "compact",
    shellToolDefaultOpen: () => false,
    editToolDefaultOpen: () => false,
    timelineDetail: detail,
    disclosure: { value: (key) => open[key], set: (key, value) => setOpen(key, value) },
  })
  return (
    <div data-fixture-timeline>
      <For each={projection.rows()}>{(row) => <renderer.Row row={() => row} />}</For>
    </div>
  )
}

render(
  () => (
    <PhysicalSystemsProvider>
      <Portal>
        <div style={{ position: "absolute", left: "-10000px", top: "0" }} aria-hidden="true">
          <ComposerFixture name="outside" />
        </div>
      </Portal>
      <PhysicalOperations />
      <Show when={fixture.gate} fallback={<p id="connection-gate-error">Fixture model server unavailable</p>}>
        <PhysicalSystemsLayout>
          <div style={{ padding: "24px", overflow: "auto" }}>
            <p>Fixture native conversation content</p>
            <ComposerFixture name="inside" />
            <RobotModelPicker />
            <DataProvider
              data={{ session: [], session_status: {}, session_diff: {} }}
              directory="/fixture/a"
              sessionID="session-a"
            >
              <DialogProvider>
                <TimelineFixture />
              </DialogProvider>
            </DataProvider>
          </div>
        </PhysicalSystemsLayout>
      </Show>
    </PhysicalSystemsProvider>
  ),
  document.getElementById("root")!,
)
