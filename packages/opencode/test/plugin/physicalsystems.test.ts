import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { PhysicalSystems } from "../../src/plugin/physicalsystems"
import type { Context } from "../../src/tool/tool"
import { MessageID, SessionID } from "../../src/session/schema"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { ProviderTest } from "../fake/provider"
import { createHash } from "node:crypto"
import z from "zod"
import { physicalPrompt } from "../../../physicalsystems/src/environment"

const original = {
  PHYSICALSYSTEMS_DESKTOP: process.env.PHYSICALSYSTEMS_DESKTOP,
  PHYSICALSYSTEMS_AGENT_URL: process.env.PHYSICALSYSTEMS_AGENT_URL,
  PHYSICALSYSTEMS_AGENT_TOKEN: process.env.PHYSICALSYSTEMS_AGENT_TOKEN,
}
const token = "fixture-only-physicalsystems-agent-token"
const servers: ReturnType<typeof Bun.serve>[] = []
const descriptor = {
  name: "propose_local_experiment",
  description: "Propose an exact synthetic experiment for operator review.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      goal: { type: "string" },
      mode: { type: "string", enum: ["simulation"] },
      trialLimit: { type: "integer", minimum: 1, maximum: 10 },
    },
    required: ["goal", "mode"],
  } satisfies JSONSchema7,
}
function context(abort = new AbortController().signal, callID?: string): Context {
  return {
    sessionID: SessionID.make("ses_physicalfixture"),
    messageID: MessageID.make("msg_physicalfixture"),
    agent: "build",
    abort,
    callID,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}
function serve(fetch: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch })
  servers.push(server)
  process.env.PHYSICALSYSTEMS_DESKTOP = "1"
  process.env.PHYSICALSYSTEMS_AGENT_URL = server.url.origin
  process.env.PHYSICALSYSTEMS_AGENT_TOKEN = token
  return server
}
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe("Physical Systems agent bridge", () => {
  test("the immutable bundled operator catalog is accepted without losing its actual schemas", async () => {
    const artifact = new URL("../../../physicalsystems/vendor/operator-service.mjs", import.meta.url)
    const manifest = z.object({ artifacts: z.record(z.string(), z.string()) }).parse(await Bun.file(new URL("./manifest.json", artifact)).json())
    expect(createHash("sha256").update(await Bun.file(artifact).bytes()).digest("hex")).toBe(manifest.artifacts["operator-service.mjs"])
    const module: unknown = await import(artifact.href)
    const descriptors = z.object({ agentToolDefinitions: z.array(z.object({ name: z.string(), label: z.string(), description: z.string(), parameters: z.record(z.string(), z.unknown()) }).passthrough()).length(11) }).parse(module).agentToolDefinitions
    serve(() => Response.json({ tools: descriptors }))
    const tools = await PhysicalSystems.tools("/fixture/project")
    expect(tools.map((tool) => tool.id)).toEqual(descriptors.map((tool) => tool.name))
    expect(tools.map((tool) => JSON.stringify(tool.jsonSchema))).toEqual(descriptors.map((tool) => JSON.stringify(tool.parameters)))
    expect(tools.map((tool) => tool.description)).toEqual(descriptors.map((tool) => tool.description))
  })

  test("the final system transform preserves camera preview and inline approval guidance", async () => {
    const output = { system: [physicalPrompt] }
    await PhysicalSystems.plugin()["experimental.chat.system.transform"]?.({ model: ProviderTest.model() }, output)
    expect(output.system.join("\n")).toContain("Basic camera preview does not require commissioning")
    expect(output.system.join("\n")).toContain("Devices panel (/workcell in the legacy client)")
    expect(output.system.join("\n")).toContain("inline approval card")
    expect(output.system[0]).toBe(physicalPrompt)
    const before = [...output.system]
    await PhysicalSystems.plugin()["experimental.chat.system.transform"]?.({ model: ProviderTest.model() }, output)
    expect(output.system).toEqual(before)
  })

  test("title, summary and compaction retain their real output contracts without acquiring the main agent task", async () => {
    for (const name of ["title", "summary", "compaction"]) {
      const prompt = await Bun.file(new URL(`../../src/agent/prompt/${name}.txt`, import.meta.url)).text()
      const output = { system: [prompt] }
      await PhysicalSystems.plugin()["experimental.chat.system.transform"]?.({ model: ProviderTest.model() }, output)
      expect(output.system[0]).toBe(prompt)
      expect(output.system).not.toContain(physicalPrompt)
      expect(output.system.join("\n")).toContain("operator alone approves an exact plan")
      expect(output.system.join("\n")).toContain("Preserve your assigned task and required output format")
    }
  })
  test("physical desktop and partial credentials activate a fail-closed mode", () => {
    expect(PhysicalSystems.enabled({})).toBe(false)
    for (const env of [
      { PHYSICALSYSTEMS_DESKTOP: "1" },
      { PHYSICALSYSTEMS_AGENT_URL: "" },
      { PHYSICALSYSTEMS_AGENT_TOKEN: token },
    ]) {
      expect(PhysicalSystems.enabled(env)).toBe(true)
      expect(() => PhysicalSystems.configuration(env)).toThrow("unavailable or not authenticated")
    }
    for (const address of [
      "https://127.0.0.1:1234",
      "http://example.invalid:1234",
      "http://127.0.0.1:1234/prefix",
      "http://user:password@127.0.0.1:1234",
      "http://127.0.0.1:1234?token=value",
      "http://127.0.0.1:1234#fragment",
    ]) {
      expect(() =>
        PhysicalSystems.configuration({ PHYSICALSYSTEMS_AGENT_URL: address, PHYSICALSYSTEMS_AGENT_TOKEN: token }),
      ).toThrow("unavailable or not authenticated")
    }
  })

  test("canonical tool schemas preserve optional parameters and calls carry exact session ownership", async () => {
    const calls: { path: string; body: unknown }[] = []
    const reference = { projectId: "project-one", conversationId: "conversation-one", serverId: "local", sessionId: "ses_physicalfixture", connectionGeneration: 1, experimentId: "experiment-one", planDigest: "digest-one" }
    serve(async (request) => {
      expect(request.headers.get("authorization")).toBe(`Bearer ${token}`)
      const route = new URL(request.url).pathname
      if (route === "/tools") return Response.json({ tools: [descriptor] })
      calls.push({ path: route, body: await request.json() })
      return Response.json({
        content: [{ type: "text", text: "Proposal recorded; explicit approval is required." }],
        details: { displaySummary: "Simulation only", physicalSystems: reference },
      })
    })
    const tools = await PhysicalSystems.tools("/fixture/project")
    expect(tools.map((tool) => tool.id)).toEqual([descriptor.name])
    expect(tools[0].jsonSchema).toEqual(descriptor.parameters)
    const args = { goal: "Compare alignment", mode: "simulation" }
    const result = await Effect.runPromise(tools[0].execute(args, context(undefined, "tool-call-one")))
    expect(result.output).toBe("Proposal recorded; explicit approval is required.")
    expect(result.metadata.physicalSystems).toEqual(reference)
    expect(calls).toEqual([
      {
        path: "/call",
        body: {
          sessionId: "ses_physicalfixture",
          directory: "/fixture/project",
          name: descriptor.name,
          arguments: args,
          callId: "tool-call-one",
        },
      },
    ])
  })

  test("model text and mismatched service session references never become approval metadata", async () => {
    const reference = { projectId: "project-one", conversationId: "conversation-one", serverId: "local", sessionId: "another-session", connectionGeneration: 1, experimentId: "experiment-one", planDigest: "digest-one" }
    serve(async (request) => {
      if (new URL(request.url).pathname === "/tools") return Response.json({ tools: [descriptor] })
      return Response.json({ output: JSON.stringify({ physicalSystems: reference }), details: { physicalSystems: reference } })
    })
    const [tool] = await PhysicalSystems.tools("/fixture/project")
    const result = await Effect.runPromise(tool.execute({ physicalSystems: reference }, context(undefined, "untrusted-reference")))
    expect(result.metadata.physicalSystems).toBe(true)
  })

  test("fallback call identity is stable across key order, while real call identities distinguish repeated trials", async () => {
    const calls: { callId: string }[] = []
    serve(async (request) => {
      if (new URL(request.url).pathname === "/tools") return Response.json({ tools: [descriptor] })
      calls.push((await request.json()) as { callId: string })
      return Response.json({ output: "Recorded" })
    })
    const [tool] = await PhysicalSystems.tools("/fixture/project")
    await Effect.runPromise(tool.execute({ goal: "Align", mode: "simulation" }, context()))
    await Effect.runPromise(tool.execute({ mode: "simulation", goal: "Align" }, context()))
    expect(calls[0].callId).toBe(calls[1].callId)
    expect(calls[0].callId).toMatch(/^ps-[0-9a-f]{64}$/)
    await Effect.runPromise(tool.execute({}, context(undefined, "tool-call-one")))
    await Effect.runPromise(tool.execute({}, context(undefined, "tool-call-two")))
    expect(calls[2].callId).not.toBe(calls[3].callId)
  })

  test("unreviewed, duplicate and malformed catalog entries cannot add tools", async () => {
    const bodies = [
      { tools: [{ ...descriptor, name: "shell" }] },
      { tools: [descriptor, descriptor] },
      { tools: [{ ...descriptor, parameters: { type: "array" } }] },
      { tools: [{ ...descriptor, label: { value: "invalid label" } }] },
      { tools: [{ ...descriptor, arbitraryToolExtension: true }] },
    ]
    serve(() => Response.json(bodies.shift()))
    for (let count = 0; count < 5; count++)
      await expect(PhysicalSystems.tools("/fixture/project")).rejects.toThrow("catalog is invalid")
  })

  test("bridge redirects cannot forward the agent credential to another endpoint", async () => {
    const contacted: string[] = []
    const foreign = serve((request) => {
      contacted.push(request.url)
      return Response.json({ tools: [] })
    })
    serve(() => Response.redirect(foreign.url.toString(), 302))
    await expect(PhysicalSystems.tools("/fixture/project")).rejects.toThrow("not confirmed")
    expect(contacted).toEqual([])
  })

  test.each([
    [409, "Select a Physical Systems project for this conversation before using its tools.", "not linked"],
    [409, "SESSION_DIRECTORY_CHANGED", "working folder does not match"],
    [400, "MODEL_SESSION_SCOPE_MISMATCH", "working folder does not match"],
  ])("binding failure %s %s explains how to recover without retrying tools", async (status, error, reason) => {
    const calls: string[] = []
    serve((request) => {
      const route = new URL(request.url).pathname
      calls.push(route)
      if (route === "/tools") return Response.json({ tools: [descriptor] })
      return Response.json({ error }, { status })
    })
    const [tool] = await PhysicalSystems.tools("/fixture/project")
    const result = Effect.runPromise(tool.execute({}, context(undefined, "unlinked-call")))
    await expect(result).rejects.toThrow(reason)
    await expect(result).rejects.toThrow("Stop retrying Physical Systems tools.")
    await expect(result).rejects.toThrow("select the intended project and use its New conversation button")
    expect(calls).toEqual(["/tools", "/call"])
  })

  test.each([
    [400, JSON.stringify({ error: "Unknown failure: private-fixture-data" })],
    [409, JSON.stringify({ error: "MODEL_SESSION_SCOPE_MISMATCH", details: "private-fixture-data" })],
    [401, JSON.stringify({ error: "MODEL_SESSION_SCOPE_MISMATCH" })],
    [409, '<html>private-fixture-data</html>'],
    [409, JSON.stringify({ error: 42 })],
    [409, "null"],
    [409, ""],
    [409, " ".repeat(4096) + JSON.stringify({ error: "MODEL_SESSION_SCOPE_MISMATCH" })],
  ])("unknown, malformed or oversized failure %s retains the generic message", async (status, body) => {
    serve((request) => {
      if (new URL(request.url).pathname === "/tools") return Response.json({ tools: [descriptor] })
      return new Response(body, { status })
    })
    const [tool] = await PhysicalSystems.tools("/fixture/project")
    const result = Effect.runPromise(tool.execute({}, context(undefined, "rejected-call")))
    await expect(result).rejects.toThrow("The Physical Systems bridge rejected this request. Inspect its recorded state before retrying.")
    expect(String(await result.catch((error: unknown) => error))).not.toContain("private-fixture-data")
  })

  test("binding guidance is only accepted from failed tool calls", async () => {
    serve(() => Response.json({ error: "MODEL_SESSION_SCOPE_MISMATCH" }, { status: 400 }))
    await expect(PhysicalSystems.tools("/fixture/project")).rejects.toThrow("The Physical Systems bridge rejected this request.")
  })

  test("already-cancelled calls perform no action, and cancellation targets only the same synthetic call", async () => {
    const calls: { route: string; body: unknown }[] = []
    const started = Promise.withResolvers<void>()
    const cancelled = Promise.withResolvers<void>()
    serve(async (request) => {
      const route = new URL(request.url).pathname
      if (route === "/tools") return Response.json({ tools: [descriptor] })
      calls.push({ route, body: await request.json() })
      if (route === "/cancel") {
        cancelled.resolve()
        return Response.json({ accepted: true })
      }
      started.resolve()
      await cancelled.promise
      return Response.json({ output: "Synthetic operation cancelled" })
    })
    const [tool] = await PhysicalSystems.tools("/fixture/project")
    const before = new AbortController()
    before.abort()
    await expect(Effect.runPromise(tool.execute({}, context(before.signal, "never-started")))).rejects.toThrow()
    expect(calls).toEqual([])
    const pending = new AbortController()
    const result = Effect.runPromise(tool.execute({}, context(pending.signal, "owned-call"))).catch(() => undefined)
    await started.promise
    pending.abort()
    await cancelled.promise
    await result
    expect(calls.map((call) => call.route)).toEqual(["/call", "/cancel"])
    expect(calls[1].body).toEqual({ sessionId: "ses_physicalfixture", callId: "owned-call" })
  })
})
