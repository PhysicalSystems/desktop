// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { composerReadiness } from "./composer-readiness"

test("delayed project binding, route, provider model and agent selection admit only the complete matching conversation", () => {
  const conversation = { id: "conversation-fixture", serverId: "sidecar", sessionId: "session-fixture" }
  const input = {
    expectedProjectId: "project-fixture",
    snapshot: {
      activeProjectId: "project-fixture",
      activeConversationId: conversation.id,
      conversation,
      projects: [{ id: "project-fixture", conversations: [conversation] }],
    },
    routeKeys: ["opencode.desktop.window.fixture.last-active-url"],
    route: "/server/c2lkZWNhcg/session/session-fixture",
    model: "Synthetic workflow fixture",
    agent: "physical-systems",
  }
  const read: typeof composerReadiness = Function(`return (${composerReadiness.toString()})`)()
  expect(read(input)).toBe("READY")
  for (const pending of [
    { ...input, snapshot: { ...input.snapshot, conversation: undefined } },
    { ...input, snapshot: { ...input.snapshot, activeProjectId: "another-project" } },
    { ...input, snapshot: { ...input.snapshot, hostUnavailable: true } },
    { ...input, snapshot: { ...input.snapshot, activeConversationId: "another-conversation" } },
    { ...input, snapshot: { ...input.snapshot, conversation: { ...conversation, sessionId: "another-session" } } },
    { ...input, route: "/server/c2lkZWNhcg/session/old-session" },
    { ...input, routeKeys: [] },
    { ...input, routeKeys: ["first", "second"] },
  ])
    expect(read(pending)).toBe("CONVERSATION_NOT_READY")
  for (const pending of [
    { ...input, model: null },
    { ...input, model: "Loading" },
    { ...input, agent: null },
    { ...input, agent: "build" },
  ])
    expect(read(pending)).toBe("MODEL_NOT_READY")
  expect(read({ ...input, model: " Synthetic workflow fixture " })).toBe("READY")
})

test("inert provider confirms only a tool-enabled request containing the exact known synthetic prompt", async () => {
  const { startFixtureProvider, qualificationPrompt } = await import(
    new URL("../../test/fixture-provider.mjs", import.meta.url).href
  )
  const provider = await startFixtureProvider()
  try {
    for (const [content, tools, admitted] of [
      ["unrelated fixture text", [{ function: { name: "propose_local_experiment" } }], false],
      [qualificationPrompt, [], false],
      [qualificationPrompt, [{ function: { name: "propose_local_experiment" } }], true],
    ]) {
      const response = await fetch(provider.url + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content }], tools }),
      })
      expect(response.ok).toBe(true)
      await response.body?.cancel()
      expect(provider.calls.at(-1).syntheticPrompt).toBe(admitted)
      expect(JSON.stringify(provider.calls)).not.toContain(qualificationPrompt)
    }
  } finally {
    await provider.close()
  }
})
