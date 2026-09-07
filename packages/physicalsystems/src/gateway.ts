// SPDX-License-Identifier: Apache-2.0
import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import { timingSafeEqual } from "node:crypto"
import { resolve } from "node:path"

export type AgentBinding = {
  agentToken: string
  directory: string
  projectId: string
  conversationId: string
  sessionId: string
  serverId: string
}

export type AgentGatewayOptions = {
  token: string
  port?: number
  now?(): number
  tools(): unknown
  binding(sessionId: string, directory?: string): AgentBinding | undefined | Promise<AgentBinding | undefined>
  invoke(request: { agentToken: string; name: string; arguments: Record<string, unknown>; callId: string; signal: AbortSignal }): Promise<unknown>
  auth?(operation: string, payload: Record<string, unknown>): Promise<unknown>
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function allowed(request: IncomingMessage, token: string) {
  const actual = Buffer.from(request.headers.authorization ?? "")
  const expected = Buffer.from(`Bearer ${token}`)
  return !request.headers.origin && actual.length === expected.length && timingSafeEqual(actual, expected)
}

function send(response: ServerResponse, status: number, body: unknown) {
  if (response.destroyed) return
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" })
  response.end(JSON.stringify(body))
}

async function body(request: IncomingMessage) {
  if (!request.headers["content-type"]?.startsWith("application/json")) throw new Error("CONTENT_TYPE_REQUIRED")
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 1024 * 1024) throw new Error("REQUEST_TOO_LARGE")
    chunks.push(Buffer.from(chunk))
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  if (!record(value)) throw new Error("INVALID_REQUEST")
  return value
}

/** Agent-only transport. Operator approval and device credentials have no route here. */
export async function createAgentGateway(options: AgentGatewayOptions) {
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)) throw new Error("INVALID_AGENT_PORT")
  if (options.token.length < 32) throw new Error("AGENT_TOKEN_REQUIRED")
  const running = new Map<string, AbortController>()
  const cancelled = new Map<string, number>()
  let closing: Promise<void> | undefined
  const now = options.now ?? Date.now
  const server = createServer((request, response) => {
    void (async () => {
      if (!allowed(request, options.token)) return send(response, 403, { error: "FORBIDDEN" })
      if (request.method === "GET" && request.url === "/tools") return send(response, 200, { tools: options.tools() })
      if (request.method !== "POST" || !["/call", "/cancel", "/auth"].includes(request.url ?? "")) {
        return send(response, 404, { error: "UNKNOWN_AGENT_OPERATION" })
      }
      const input = await body(request)
      if (request.url === "/auth") {
        if (!options.auth || typeof input.operation !== "string") return send(response, 403, { error: "AUTH_UNAVAILABLE" })
        return send(response, 200, await options.auth(input.operation, input))
      }
      if (typeof input.sessionId !== "string" || !input.sessionId || input.sessionId.length > 256 || input.sessionId.includes("\0") || typeof input.callId !== "string" || !input.callId || input.callId.length > 256 || input.callId.includes("\0")) {
        return send(response, 400, { error: "INVALID_AGENT_SCOPE" })
      }
      for (const [id, expires] of cancelled) if (expires <= now()) cancelled.delete(id)
      const key = `${input.sessionId}\0${input.callId}`
      if (request.url === "/cancel") {
        if (!cancelled.has(key) && cancelled.size >= 4096) return send(response, 503, { error: "CANCELLATION_CAPACITY_REACHED" })
        // A cancel can beat its call across separate HTTP connections. Keep a
        // bounded tombstone even when binding or request arrival has not begun.
        cancelled.set(key, now() + 300_000)
        running.get(key)?.abort()
        return send(response, 200, { cancelled: running.has(key) })
      }
      if (cancelled.has(key)) return send(response, 409, { error: "REQUEST_CANCELLED" })
      if (cancelled.size >= 4096 || running.size >= 128) return send(response, 503, { error: "AGENT_REQUEST_CAPACITY_REACHED" })
      if (typeof input.directory !== "string" || typeof input.name !== "string" || !record(input.arguments)) return send(response, 400, { error: "INVALID_TOOL_REQUEST" })
      if (running.has(key)) return send(response, 409, { error: "REQUEST_IN_PROGRESS" })
      const controller = new AbortController()
      running.set(key, controller)
      try {
        const binding = await options.binding(input.sessionId, input.directory)
        controller.signal.throwIfAborted()
        if (!binding) return send(response, 409, { error: "Select a Physical Systems project for this conversation before using its tools." })
        if (resolve(input.directory) !== resolve(binding.directory)) return send(response, 409, { error: "SESSION_DIRECTORY_CHANGED" })
        const result = await options.invoke({ agentToken: binding.agentToken, name: input.name, arguments: input.arguments, callId: input.callId, signal: controller.signal })
        send(response, 200, result)
      } finally { running.delete(key) }

    })().catch((error: unknown) => {
      send(response, 400, { error: error instanceof Error ? error.message : "AGENT_REQUEST_FAILED" })
    })
  })
  server.requestTimeout = 10_000
  server.headersTimeout = 10_000
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port ?? 0, "127.0.0.1", resolve) })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("AGENT_LISTENER_UNAVAILABLE")
  return {
    url: `http://127.0.0.1:${address.port}`,
    close() {
      if (closing) return closing
      for (const controller of running.values()) controller.abort()
      cancelled.clear()
      closing = new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
        server.closeAllConnections()
      })
      return closing
    },
  }
}
