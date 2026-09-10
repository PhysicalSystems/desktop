// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { composerReadiness, managedWorkspaceReadiness } from "./composer-readiness"

test("native smoke waits for the automatically created managed workspace and its bound chat", () => {
  const conversation = { id: "conversation-fixture", serverId: "sidecar", sessionId: "session-fixture" }
  const snapshot = {
    deviceConnectionsEnabled: false,
    activeCaptures: [],
    activeRuns: [],
    activeProjectId: "project-fixture",
    activeConversationId: conversation.id,
    conversation,
    projects: [
      {
        id: "project-fixture",
        cwd: "/owned/operator/projects/project-fixture",
        connection: { kind: "simulation" },
        conversations: [conversation],
      },
    ],
  }
  const read: typeof managedWorkspaceReadiness = Function(`return (${managedWorkspaceReadiness.toString()})`)()
  const input = { managedRoot: "/owned/operator/projects", snapshot }
  expect(read({ ...input, snapshot: { ...snapshot, projects: [] } })).toBe("PACKAGED_PROJECT_NOT_CREATED")
  expect(read({ ...input, snapshot: { ...snapshot, hostUnavailable: true } })).toBe("PACKAGED_PROJECT_NOT_CREATED")
  for (const pending of [
    { ...snapshot, activeProjectId: null },
    { ...snapshot, activeConversationId: null },
    { ...snapshot, conversation: undefined },
    { ...snapshot, conversation: { ...conversation, serverId: "other-server" } },
    { ...snapshot, conversation: { ...conversation, sessionId: "other-session" } },
    { ...snapshot, projects: [{ ...snapshot.projects[0]!, conversations: [] }] },
  ])
    expect(read({ ...input, snapshot: pending })).toBe("PACKAGED_CONVERSATION_NOT_READY")
  expect(read(input)).toBe("READY")
  expect(
    read({
      managedRoot: "C:\\owned\\operator\\projects",
      snapshot: {
        ...snapshot,
        projects: [{ ...snapshot.projects[0]!, cwd: "C:\\owned\\operator\\projects\\project-fixture" }],
      },
    }),
  ).toBe("READY")
})

test("managed workspace readiness retains hardware isolation and rejects extra or foreign projects", () => {
  const conversation = { id: "conversation-fixture", serverId: "sidecar", sessionId: "session-fixture" }
  const project = {
    id: "project-fixture",
    cwd: "/owned/operator/projects/project-fixture",
    connection: { kind: "simulation" },
    conversations: [conversation],
  }
  const snapshot = {
    deviceConnectionsEnabled: false,
    activeCaptures: [],
    activeRuns: [],
    activeProjectId: project.id,
    activeConversationId: conversation.id,
    conversation,
    projects: [project],
  }
  const read: typeof managedWorkspaceReadiness = Function(`return (${managedWorkspaceReadiness.toString()})`)()
  const input = { managedRoot: "/owned/operator/projects", snapshot }
  expect(read({ ...input, snapshot: { ...snapshot, deviceConnectionsEnabled: true } })).toBe(
    "PACKAGED_DEVICE_CONNECTIONS_ENABLED",
  )
  expect(read({ ...input, snapshot: { ...snapshot, deviceConnectionsEnabled: true, projects: [] } })).toBe(
    "PACKAGED_DEVICE_CONNECTIONS_ENABLED",
  )
  expect(read({ ...input, snapshot: { ...snapshot, activeCaptures: [{}] } })).toBe(
    "PACKAGED_HARDWARE_OPERATIONS_ACTIVE",
  )
  expect(read({ ...input, snapshot: { ...snapshot, activeRuns: [{}] } })).toBe("PACKAGED_HARDWARE_OPERATIONS_ACTIVE")
  for (const projects of [
    [project, { ...project, id: "extra-project" }],
    [{ ...project, connection: { kind: "local" } }],
    [{ ...project, connection: { kind: "ssh" } }],
    [{ ...project, cwd: undefined }],
    [{ ...project, cwd: "/owned/operator/projects-other/project-fixture" }],
    [{ ...project, cwd: "/owned/operator/projects/another-project" }],
    [{ ...project, id: "../project-fixture" }],
  ])
    expect(read({ ...input, snapshot: { ...snapshot, projects } })).toBe("PACKAGED_PROFILE_NOT_ISOLATED")
})

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
    modelId: "fixture",
    providerId: "fixture",
    agentId: "physical-systems",
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
    { ...input, modelId: null },
    { ...input, modelId: "Loading" },
    { ...input, providerId: null },
    { ...input, providerId: "another-provider" },
    { ...input, agentId: null },
    { ...input, agentId: "build" },
    { ...input, agentId: " physical-systems " },
  ])
    expect(read(pending)).toBe("MODEL_NOT_READY")
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
