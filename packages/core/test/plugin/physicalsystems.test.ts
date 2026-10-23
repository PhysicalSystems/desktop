// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Agent } from "@opencode/core/agent"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { AgentPlugin } from "@opencode/core/plugin/agent"
import { PhysicalSystemsPlugin } from "@opencode/core/plugin/physicalsystems"
import { PhysicalSystems } from "@opencode/core/plugin/physical-bridge"
import { Tool } from "@opencode/core/tool"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { physicalPrompt } from "@opencode/core/plugin/physical-prompt"
import { physicalPrompt as desktopPrompt } from "../../../physicalsystems/src/environment"
import { createAgentGateway } from "../../../physicalsystems/src/gateway"
import { PluginTestLayer } from "./fixture"

test("V2 actual registry admits reviewed Physical Systems tools and cannot regain shell or code execution", async () => {
  const token = "physical-v2-inert-token-123456789"
  const calls: unknown[] = []
  const gateway = await createAgentGateway({
    token,
    tools: () => [{ name: "inspect_physical_system", description: "Fixture inspection", parameters: { type: "object", properties: {}, additionalProperties: false } }],
    binding: (id, directory) => ({ projectId: "project", conversationId: "conversation", serverId: "sidecar", sessionId: id, directory: directory!, agentToken: "operator-owned-inert-token" }),
    invoke: async (request) => { calls.push(request); return { output: "synthetic inspection" } },
  })
  const keys = ["PHYSICALSYSTEMS_DESKTOP", "PHYSICALSYSTEMS_AGENT_URL", "PHYSICALSYSTEMS_AGENT_TOKEN"] as const
  const prior = keys.map((key) => process.env[key])
  Object.assign(process.env, { PHYSICALSYSTEMS_DESKTOP: "1", PHYSICALSYSTEMS_AGENT_URL: gateway.url, PHYSICALSYSTEMS_AGENT_TOKEN: token })
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const plugin = yield* Plugin.Service
      const host = yield* PluginHost.make(plugin)
      const agents = yield* Agent.Service
      const tools = yield* Tool.Service
      yield* AgentPlugin.Plugin.effect(host)
      yield* PhysicalSystemsPlugin.Plugin.effect(host)
      expect((yield* agents.resolve())?.id).toBe(Agent.ID.make("physical-systems"))
      expect(yield* agents.get(Agent.ID.make("build"))).toBeUndefined()
      expect((yield* agents.get(Agent.ID.make("title")))?.system).toContain("title")
      yield* tools.transform((editor) => editor.add({ name: "shell", description: "Must never run", input: { type: "object" }, options: { codemode: false }, execute: () => Effect.die("SHELL_EXECUTED") }))
      const snapshot = yield* tools.snapshot([])
      expect(snapshot.definitions.map((tool) => tool.name)).toEqual(["inspect_physical_system"])
      expect(snapshot.codeModeCatalog).toBeUndefined()
      const context = { sessionID: Session.ID.make("ses_physical"), messageID: SessionMessage.ID.make("msg_physical"), agent: Agent.ID.make("physical-systems") }
      expect((yield* snapshot.execute({ ...context, call: { type: "tool-call", id: "tool_1", name: "inspect_physical_system", input: {} } })).output).toBe("synthetic inspection")
      const rejected = yield* snapshot.execute({ ...context, call: { type: "tool-call", id: "tool_2", name: "shell", input: {} } }).pipe(Effect.exit)
      expect(rejected._tag).toBe("Failure")
      const hooks = yield* PluginHooks.Service
      const request = yield* hooks.trigger("session", "title", { sessionID: context.sessionID, model: { providerID: Provider.ID.make("fixture"), id: Model.ID.make("fixture") }, system: [], messages: [], options: {} })
      expect(request.system.some((part) => part.text.includes("operator alone approves"))).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(PluginTestLayer)))
    expect(calls).toHaveLength(1)
    expect(physicalPrompt).toBe(desktopPrompt)
  } finally {
    keys.forEach((key, index) => { if (prior[index] === undefined) delete process.env[key]; else process.env[key] = prior[index] })
    await gateway.close()
  }
}, 30000)

test("V2 physical tool bridge rejects unreviewed catalog names and non-loopback authority", async () => {
  expect(() => PhysicalSystems.configuration({ PHYSICALSYSTEMS_AGENT_URL: "https://example.com", PHYSICALSYSTEMS_AGENT_TOKEN: "long-enough-inert-token-123456789012345" })).toThrow()
  const gateway = await createAgentGateway({ token: "long-enough-inert-token-123456789012345", tools: () => [{ name: "shell", description: "Not reviewed", parameters: { type: "object" } }], binding: () => undefined, invoke: async () => { throw new Error("UNEXPECTED") } })
  try {
    await expect(PhysicalSystems.tools("fixture", { PHYSICALSYSTEMS_AGENT_URL: gateway.url, PHYSICALSYSTEMS_AGENT_TOKEN: "long-enough-inert-token-123456789012345" })).rejects.toThrow("catalog is invalid")
  } finally { await gateway.close() }
})

