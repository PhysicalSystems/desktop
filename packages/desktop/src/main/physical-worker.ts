// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto"
import { resolve, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { admitContinuation } from "../../../physicalsystems/src/continuation"
import { agentState } from "../../../physicalsystems/src/agent-status"
import { createAgentGateway } from "../../../physicalsystems/src/gateway"
import type { AgentBinding } from "../../../physicalsystems/src/gateway"
import type { PhysicalSnapshot } from "@opencode-ai/app/physicalsystems-types"

type Port = { postMessage(value: unknown): void; on(name: string, listener: (message: { data: Record<string, unknown> }) => void): void }
type Operator = {
  snapshot(): PhysicalSnapshot
  subscribe(listener: (snapshot: PhysicalSnapshot) => void): () => void
  command(name: string, payload: Record<string, unknown>): Promise<unknown>
  agentCall(request: { agentToken: string; name: string; arguments: Record<string, unknown>; callId: string; signal?: AbortSignal }): Promise<unknown>
  close(): Promise<void>
}
type ModelServer = { url: string; password: string }

const parent = (process as NodeJS.Process & { parentPort?: Port }).parentPort
if (!parent) throw new Error("OPERATOR_PARENT_REQUIRED")
const port = parent
const bindings = new Map<string, AgentBinding>()
const native = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
let service: Operator | undefined
let gateway: Awaited<ReturnType<typeof createAgentGateway>> | undefined
let server: ModelServer | undefined
let closed = false
let statusTask: Promise<void> | undefined
let statusTimer: ReturnType<typeof setTimeout> | undefined
const statusCache = new Map<string, string>()

function syncStatus(): Promise<void> {
  if (statusTask) return statusTask
  if (!server || !service || closed) return Promise.resolve()
  clearTimeout(statusTimer)
  statusTask = (async () => {
    const groups = Map.groupBy([...bindings.values()], (binding) => binding.directory)
    for (const [directory, owners] of groups) {
      const status = await modelRequest("/session/status", directory).then((response) => response.json()).catch(() => undefined)
      for (const owner of owners) {
        const next = agentState(status, owner.sessionId)
        const key = JSON.stringify(next)
        if (statusCache.get(owner.sessionId) === key) continue
        await service!.command("session.agentState", { projectId: owner.projectId, conversationId: owner.conversationId, serverId: owner.serverId, sessionId: owner.sessionId, ...next }).then(() => statusCache.set(owner.sessionId, key)).catch(() => {})
      }
    }
  })().finally(() => {
    statusTask = undefined
    if (!closed) statusTimer = setTimeout(() => void syncStatus(), 1000)
  })
  return statusTask
}

function nativeVault(vault: "provider" | "operator", operation: string, payload: Record<string, unknown>): Promise<unknown> {
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { native.delete(id); reject(new Error("CREDENTIAL_REQUEST_TIMEOUT")) }, 6500)
    native.set(id, { resolve, reject, timer })
    port.postMessage({ event: "credential", id, vault, operation, payload })
  })
}

async function modelRequest(route: string, directory: string, init?: RequestInit) {
  if (!server) throw new Error("MODEL_SERVER_UNAVAILABLE")
  const target = new URL(route, server.url)
  target.searchParams.set("directory", directory)
  const response = await fetch(target, {
    ...init, redirect: "error",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${Buffer.from(`opencode:${server.password}`).toString("base64")}`, ...init?.headers },
    signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(6500)]) : AbortSignal.timeout(6500),
  })
  if (!response.ok) throw new Error(`MODEL_REQUEST_${response.status}`)
  return response
}

async function start(data: Record<string, unknown>) {
  if (service || typeof data.dataDir !== "string" || typeof data.agentToken !== "string") throw new Error("INVALID_OPERATOR_START")
  const core = await import("virtual:physicalsystems-operator")
  service = await core.createOperatorService({
    dataDir: data.dataDir,
    secretStore: {
      read: async (key: string) => { const values = await nativeVault("operator", "all", {}) as Record<string, { value?: string }>; return values[key]?.value ?? null },
      write: (key: string, value: string) => nativeVault("operator", "set", { key, info: { value } }),
      delete: (key: string) => nativeVault("operator", "remove", { key }),
    },
    skillPackageRoot: join(dirname(fileURLToPath(import.meta.url)), "skills"),
    allowDeviceConnections: process.env.PHYSICALSYSTEMS_ALLOW_DEVICES === "1",
    submitContinuation: async (request: { binding: { sessionId: string; projectId: string }; text: string; requestId: string; signal?: AbortSignal; retry?: boolean }) => {
      request.signal?.throwIfAborted()
      const project = service?.snapshot().projects.find((item) => item.id === request.binding.projectId)
      if (!project?.cwd) throw new Error("PROJECT_DIRECTORY_UNAVAILABLE")
      return admitContinuation({ ...request, sessionId: request.binding.sessionId }, {
        read: async (messageID, signal) => {
          try { return await (await modelRequest(`/session/${encodeURIComponent(request.binding.sessionId)}/message/${messageID}`, project.cwd!, { signal })).json() }
          catch (error) { if (error instanceof Error && error.message === "MODEL_REQUEST_404") return undefined; throw error }
        },
        post: async (messageID, signal) => {
          await modelRequest(`/session/${encodeURIComponent(request.binding.sessionId)}/prompt_async`, project.cwd!, {
            method: "POST", signal, body: JSON.stringify({ messageID, agent: "physical-systems", parts: [{ type: "text", text: request.text }] }),
          })
        },
      })
    },
  }) as Operator
  gateway = await createAgentGateway({
    token: data.agentToken,
    port: typeof data.agentPort === "number" ? data.agentPort : undefined,
    tools: () => core.agentToolDefinitions,
    binding: async (id, directory) => {
      const known = bindings.get(id)
      if (known || !directory || !service) return known
      // The first tool may run before the new tab's route effect. Resolve only a
      // unique operator-created project, then verify the session with our server.
      const projects = service.snapshot().projects.filter((project) => project.cwd && resolve(project.cwd) === resolve(directory))
      if (projects.length !== 1) return
      await command({ type: "session.bind", projectId: projects[0].id, serverId: "sidecar", sessionId: id, activate: false })
      return bindings.get(id)
    },
    invoke: (request) => {
      if (!service || closed) throw new Error("OPERATOR_UNAVAILABLE")
      return service.agentCall(request)
    },
    auth: (operation, payload) => nativeVault("provider", operation, payload),
  })
  service.subscribe((snapshot) => port.postMessage({ event: "snapshot", snapshot }))
  port.postMessage({ event: "snapshot", snapshot: service.snapshot() })
  return { url: gateway.url }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

async function command(request: Record<string, unknown>) {
  if (!service || closed || typeof request.type !== "string") throw new Error("OPERATOR_UNAVAILABLE")
  const { type, ...payload } = request
  if (type === "session.bind") {
    if (!server || payload.serverId !== "sidecar") throw new Error("MODEL_SERVER_SCOPE_MISMATCH")
    const project = service.snapshot().projects.find((item) => item.id === payload.projectId)
    if (!project?.cwd || typeof payload.sessionId !== "string") throw new Error("INVALID_SESSION_BINDING")
    const info: unknown = await (await modelRequest(`/session/${encodeURIComponent(payload.sessionId)}`, project.cwd)).json()
    if (!record(info) || info.id !== payload.sessionId || typeof info.directory !== "string" || resolve(info.directory) !== resolve(project.cwd)) {
      throw new Error("MODEL_SESSION_SCOPE_MISMATCH")
    }
  }
  if (type === "experiment.approveAndContinue" || type === "experiment.continue") {
    const owner = [...bindings.values()].find((binding) => binding.projectId === payload.projectId && binding.conversationId === payload.conversationId)
    if (!owner) throw new Error("MODEL_SESSION_SCOPE_MISMATCH")
    const status = await modelRequest("/session/status", owner.directory, { signal: AbortSignal.timeout(1000) }).then((response) => response.json()).catch(() => undefined)
    const next = agentState(status, owner.sessionId)
    await service.command("session.agentState", { projectId: owner.projectId, conversationId: owner.conversationId, serverId: owner.serverId, sessionId: owner.sessionId, ...next })
    statusCache.set(owner.sessionId, JSON.stringify(next))
  }
  const result = await service.command(type, payload)
  if (type === "session.bind" && record(result) && typeof result.agentToken === "string" && record(result.binding)) {
    const binding = result.binding as unknown as AgentBinding
    const project = service.snapshot().projects.find((item) => item.id === binding.projectId)
    if (!project?.cwd) throw new Error("PROJECT_DIRECTORY_UNAVAILABLE")
    bindings.set(binding.sessionId, { ...binding, directory: project.cwd, agentToken: result.agentToken })
    clearTimeout(statusTimer)
    void syncStatus()
  }
  const snapshot = service.snapshot()
  if (record(result) && record(result.continuation)) return { ...snapshot, commandResult: { continuation: result.continuation } }
  if (type === "workcell.camera.frame") return { ...snapshot, commandResult: { frame: result } }
  return snapshot
}

port.on("message", ({ data }) => {
  if (data.event === "credential-result" && typeof data.id === "string") {
    const entry = native.get(data.id)
    if (!entry) return
    clearTimeout(entry.timer)
    native.delete(data.id)
    if (typeof data.error === "string") entry.reject(new Error(data.error))
    else entry.resolve(data.result)
    return
  }
  if (typeof data.id !== "string") return
  const id = data.id
  void (async () => {
    if (data.method === "start") return start(data)
    if (data.method === "server") {
      if (typeof data.url !== "string" || typeof data.password !== "string" || !/^http:\/\/127\.0\.0\.1:\d+$/.test(data.url)) throw new Error("INVALID_MODEL_SERVER")
      server = { url: data.url, password: data.password }
      return { configured: true }
    }
    if (data.method === "snapshot") return service?.snapshot()
    if (data.method === "command" && record(data.request)) return command(data.request)
    if (data.method === "close") {
      await service?.close()
      await gateway?.close()
      closed = true
      clearTimeout(statusTimer)
      return { closed: true }
    }
    if (data.method === "exit" && closed) return process.exit(0)
    throw new Error("UNKNOWN_OPERATOR_METHOD")
  })().then((result) => port.postMessage({ id, result }), (error: unknown) => {
    port.postMessage({ id, error: error instanceof Error ? error.message : "OPERATOR_REQUEST_FAILED" })
  })
})

port.on("close", () => {
  void service?.close().then(() => gateway?.close()).then(() => process.exit(0)).catch(() => {})
})
