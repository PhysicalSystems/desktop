// SPDX-License-Identifier: Apache-2.0
export * as PhysicalSystemsPlugin from "./physicalsystems.js"

import { SystemPart } from "@opencode/ai"
import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { Agent } from "@opencode/schema/agent"
import { PhysicalSystems } from "./physical-bridge.js"
import { physicalPrompt } from "./physical-prompt.js"

export const Plugin = define({
  id: "physicalsystems.authority",
  effect: Effect.fn("PhysicalSystems.Plugin")(function* (ctx) {
    const tools = yield* Effect.promise(() => PhysicalSystems.tools(ctx.location.directory))
    yield* ctx.agent.transform((editor) => {
      for (const agent of editor.list()) {
        if (!["title", "summary", "compaction"].includes(agent.id)) editor.remove(agent.id)
      }
      editor.update("physical-systems", (agent) => {
        agent.name = Agent.Name.make("Physical Systems")
        agent.description = "Inspect, plan and compare physical-system investigations"
        agent.mode = "primary"
        agent.system = physicalPrompt
        agent.permissions = [{ action: "*", resource: "*", effect: "deny" }, ...[...PhysicalSystems.names, "question"].map((action) => ({ action, resource: "*", effect: "allow" as const }))]
      })
      editor.default("physical-systems")
    })
    yield* ctx.tool.transform((editor) => {
      for (const tool of editor.list()) if (tool.name !== "question") editor.remove(tool.id)
      for (const tool of tools) editor.add(tool)
    })
    const prompt = (event: { system: SystemPart[] }) => Effect.sync(() => {
      event.system.push(SystemPart.make(PhysicalSystems.authorityPrompt))
    })
    yield* ctx.session.hook("context", prompt)
    yield* ctx.session.hook("compaction", prompt)
    yield* ctx.session.hook("generate", prompt)
    yield* ctx.session.hook("title", prompt)
  }),
})
