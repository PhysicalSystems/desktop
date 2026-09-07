// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test"
import { createAgentGateway } from "./gateway"
import type { AgentGatewayOptions } from "./gateway"

const token = "fixture-private-token-".repeat(3)
const closing: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of closing.splice(0)) await close() })
async function fixture(invoke: AgentGatewayOptions["invoke"] = async (value) => ({ name: value.name })) {
  const gateway = await createAgentGateway({ token, tools: () => [{ name: "inspect_local_experiment" }],
    binding: (id) => id === "session-a" ? { sessionId: id, directory: "/fixture", projectId: "p", conversationId: "c", serverId: "local", agentToken: "private-owner" } : undefined,
    invoke })
  closing.push(gateway.close)
  const call = (path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(gateway.url + path, {
    method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined,
  })
  return { ...gateway, call }
}
const request = { sessionId: "session-a", directory: "/fixture", name: "inspect_local_experiment", arguments: {}, callId: "call-1" }

test("private gateway rejects renderer origins, credentials and operator routes", async () => {
  const gateway = await fixture()
  expect((await gateway.call("/tools", undefined, { Authorization: "Bearer wrong" })).status).toBe(403)
  expect((await gateway.call("/tools", undefined, { Origin: "oc://renderer" })).status).toBe(403)
  expect((await gateway.call("/approve", request)).status).toBe(404)
  expect((await gateway.call("/command", request)).status).toBe(404)
  expect((await gateway.call("/auth", { operation: "all" })).status).toBe(403)
  expect((await gateway.call("/tools")).status).toBe(200)
})

test("session identity and directory are required before invocation", async () => {
  let calls = 0
  const gateway = await fixture(async (input) => { calls++; expect(input.agentToken).toBe("private-owner"); return { ok: true } })
  expect((await gateway.call("/call", { ...request, sessionId: "other" })).status).toBe(409)
  expect((await gateway.call("/call", { ...request, directory: "/other" })).status).toBe(409)
  expect(calls).toBe(0)
  expect((await gateway.call("/call", request)).status).toBe(200)
  expect(calls).toBe(1)
})

test("a duplicate in-flight request cannot dispatch twice; cancel targets the original call", async () => {
  let calls = 0
  let started!: () => void
  const ready = new Promise<void>((resolve) => { started = resolve })
  const gateway = await fixture(async ({ signal }) => {
    calls++; started()
    return await new Promise((resolve) => signal.addEventListener("abort", () => resolve({ stopped: true }), { once: true }))
  })
  const first = gateway.call("/call", request)
  await ready
  expect((await gateway.call("/call", request)).status).toBe(409)
  expect(await (await gateway.call("/cancel", { ...request, callId: "other" })).json()).toEqual({ cancelled: false })
  expect(await (await gateway.call("/cancel", request)).json()).toEqual({ cancelled: true })
  expect(await (await first).json()).toEqual({ stopped: true })
  expect(calls).toBe(1)
})

test("cancel while first-session binding is pending prevents invocation after binding completes", async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let invocations = 0
  let bindings = 0
  const gateway = await createAgentGateway({
    token, tools: () => [],
    binding: async (id) => {
      bindings++
      entered.resolve()
      await release.promise
      return { sessionId: id, directory: "/fixture", projectId: "p", conversationId: "c", serverId: "local", agentToken: "private-owner" }
    },
    invoke: async () => { invocations++; return {} },
  })
  closing.push(gateway.close)
  const post = (route: string, input: unknown) => fetch(gateway.url + route, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(input) })
  const first = post("/call", request)
  await entered.promise
  expect((await post("/call", request)).status).toBe(409)
  expect(await (await post("/cancel", { sessionId: request.sessionId, callId: request.callId })).json()).toEqual({ cancelled: true })
  release.resolve()
  expect((await first).status).toBe(400)
  expect(invocations).toBe(0)
  expect(bindings).toBe(1)
})

test("a cancellation received before its reordered call prevents later invocation", async () => {
  let calls = 0
  const gateway = await fixture(async () => { calls++; return {} })
  expect(await (await gateway.call("/cancel", { sessionId: request.sessionId, callId: request.callId })).json()).toEqual({ cancelled: false })
  expect((await gateway.call("/call", request)).status).toBe(409)
  expect((await gateway.call("/call", request)).status).toBe(409)
  expect(calls).toBe(0)
})

test("cancellation memory is bounded and expires after five minutes without evicting an active tombstone", async () => {
  let clock = 1_000
  let calls = 0
  const gateway = await createAgentGateway({ token, now: () => clock, tools: () => [],
    binding: (id) => ({ sessionId: id, directory: "/fixture", projectId: "p", conversationId: "c", serverId: "local", agentToken: "private-owner" }),
    invoke: async () => { calls++; return {} },
  })
  closing.push(gateway.close)
  const post = (route: string, input: unknown) => fetch(gateway.url + route, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(input) })
  for (let index = 0; index < 4096; index++) {
    const response = await post("/cancel", { sessionId: request.sessionId, callId: `cancel-${index}` })
    expect(response.status).toBe(200)
    await response.arrayBuffer()
  }
  expect((await post("/cancel", { sessionId: request.sessionId, callId: "over-capacity" })).status).toBe(503)
  expect((await post("/call", { ...request, callId: "cancel-0" })).status).toBe(409)
  expect((await post("/call", { ...request, callId: "over-capacity" })).status).toBe(503)
  expect(calls).toBe(0)
  clock += 300_000
  expect((await post("/call", { ...request, callId: "fresh-intent" })).status).toBe(200)
  expect(calls).toBe(1)
}, 30_000)

test("gateway cleanup is idempotent and releases its listener", async () => {
  const gateway = await fixture()
  const closing = gateway.close()
  expect(gateway.close()).toBe(closing)
  await closing
  await gateway.close()
  await expect(gateway.call("/tools")).rejects.toThrow()
})

test("cleanup aborts the exact in-flight agent request without requiring a successful response", async () => {
  const entered = Promise.withResolvers<void>()
  const cancelled = Promise.withResolvers<void>()
  const gateway = await fixture(async ({ signal }) => {
    entered.resolve()
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => { cancelled.resolve(); resolve() }, { once: true }))
    return { cancelled: true }
  })
  const pending = gateway.call("/call", request).catch(() => undefined)
  await entered.promise
  await gateway.close()
  await cancelled.promise
  await pending
})
