import { afterEach, expect } from "bun:test"
import { Cause, Effect } from "effect"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ToolRegistry } from "../../src/tool/registry"
import { Plugin } from "../../src/plugin"
import { MCP } from "../../src/mcp"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionID } from "../../src/session/schema"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Auth } from "../../src/auth"
import { Account } from "../../src/account/account"
import { Config } from "../../src/config/config"
import { Npm } from "@opencode-ai/core/npm"
import { AuthTest } from "../fake/auth"
import { AccountTest } from "../fake/account"
import { NpmTest } from "../fake/npm"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const original = {
  PHYSICALSYSTEMS_DESKTOP: process.env.PHYSICALSYSTEMS_DESKTOP,
  PHYSICALSYSTEMS_AGENT_URL: process.env.PHYSICALSYSTEMS_AGENT_URL,
  PHYSICALSYSTEMS_AGENT_TOKEN: process.env.PHYSICALSYSTEMS_AGENT_TOKEN,
}
const servers: ReturnType<typeof Bun.serve>[] = []
const it = testEffect(
  LayerNode.compile(LayerNode.group([ToolRegistry.node, Plugin.node, MCP.node, SessionPrompt.node, Config.node]), [
    [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true })],
    [Auth.node, AuthTest.empty],
    [Account.node, AccountTest.empty],
    [Npm.node, NpmTest.noop],
  ]),
)

afterEach(async () => {
  await disposeAllInstances()
  for (const server of servers.splice(0)) server.stop(true)
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

it.instance(
  "physical mode excludes ambient tools/plugins/MCP and denies direct shell/custom-command entry points",
  () =>
    Effect.gen(function* () {
      const fixture = yield* TestInstance
      const requests: string[] = []
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          requests.push(new URL(request.url).pathname)
          return Response.json({
            tools: [
              {
                name: "inspect_local_experiment",
                description: "Inspect the synthetic experiment.",
                parameters: { type: "object", properties: {}, additionalProperties: false },
              },
            ],
          })
        },
      })
      servers.push(server)
      process.env.PHYSICALSYSTEMS_DESKTOP = "1"
      process.env.PHYSICALSYSTEMS_AGENT_URL = server.url.origin
      process.env.PHYSICALSYSTEMS_AGENT_TOKEN = "fixture-only-physicalsystems-agent-token"
      yield* Effect.promise(() =>
        Bun.write(
          path.join(fixture.directory, ".opencode", "tool", "ambient.ts"),
          'throw new Error("An ambient tool module was evaluated")',
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(fixture.directory, "ambient-plugin.ts"),
          'throw new Error("An ambient plugin module was evaluated")',
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(fixture.directory, "opencode.json"),
          JSON.stringify({
            plugin: [pathToFileURL(path.join(fixture.directory, "ambient-plugin.ts")).href],
            mcp: { ambient: { type: "remote", url: server.url.origin + "/ambient-mcp" } },
          }),
        ),
      )
      const registry = yield* ToolRegistry.Service
      const plugin = yield* Plugin.Service
      const mcp = yield* MCP.Service
      const prompt = yield* SessionPrompt.Service
      const config = yield* Config.Service
      expect((yield* registry.ids()).toSorted()).toEqual(["inspect_local_experiment", "question"])
      expect((yield* registry.all()).map((tool) => tool.id).toSorted()).toEqual([
        "inspect_local_experiment",
        "question",
      ])
      expect((yield* plugin.list()).length).toBe(1)
      expect((yield* config.get()).plugin_origins?.length).toBe(1)
      expect(Object.keys(yield* mcp.tools())).toEqual([])
      yield* mcp.add("direct", { type: "remote", url: server.url.origin + "/direct-mcp" })
      expect(Object.keys(yield* mcp.clients())).toEqual([])
      expect(yield* prompt.resolvePromptParts("Inspect @/fixture/secret.txt")).toEqual([
        { type: "text", text: "Inspect @/fixture/secret.txt" },
      ])
      const sessionID = SessionID.make("ses_physicalauthority")
      const denied = yield* Effect.all([
        prompt.shell({ sessionID, agent: "build", command: "echo forbidden" }).pipe(Effect.exit),
        prompt.command({ sessionID, command: "ambient", arguments: "" }).pipe(Effect.exit),
        registry.named().pipe(Effect.exit),
      ])
      expect(denied.every((exit) => exit._tag === "Failure")).toBe(true)
      for (const exit of denied) {
        if (exit._tag === "Failure") expect(Cause.pretty<unknown>(exit.cause)).toContain("unavailable in Physical Systems")
      }
      expect(requests).toEqual(["/tools"])
    }),
)
