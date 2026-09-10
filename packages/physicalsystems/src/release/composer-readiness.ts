// SPDX-License-Identifier: Apache-2.0
type Conversation = { id: string; serverId: string; sessionId: string }

/** Self-contained so the native smoke observes actual first-launch state in the renderer. */
export function managedWorkspaceReadiness(input: {
  managedRoot: string
  snapshot: {
    hostUnavailable?: boolean
    deviceConnectionsEnabled: boolean
    activeCaptures: unknown[]
    activeRuns: unknown[]
    activeProjectId?: string | null
    activeConversationId?: string | null
    conversation?: Conversation | null
    projects: { id: string; cwd?: string; connection: { kind: string }; conversations: Conversation[] }[]
  }
}) {
  const s = input.snapshot
  if (s.deviceConnectionsEnabled !== false) return "PACKAGED_DEVICE_CONNECTIONS_ENABLED"
  if (s.activeCaptures.length || s.activeRuns.length) return "PACKAGED_HARDWARE_OPERATIONS_ACTIVE"
  if (s.hostUnavailable || !s.projects.length) return "PACKAGED_PROJECT_NOT_CREATED"
  const p = s.projects[0]!
  // Compare the exact managed child directory on both Windows and Linux.
  const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/$/, "")
  if (
    s.projects.length !== 1 ||
    !p.id ||
    /[/\\]/.test(p.id) ||
    p.connection.kind !== "simulation" ||
    !p.cwd ||
    normalize(p.cwd) !== normalize(input.managedRoot) + "/" + p.id
  )
    return "PACKAGED_PROFILE_NOT_ISOLATED"
  const c = s.conversation
  if (
    s.activeProjectId !== p.id ||
    p.conversations.length !== 1 ||
    c?.serverId !== "sidecar" ||
    !c.sessionId ||
    c.id !== s.activeConversationId ||
    p.conversations[0]!.id !== c.id ||
    p.conversations[0]!.sessionId !== c.sessionId ||
    p.conversations[0]!.serverId !== c.serverId
  )
    return "PACKAGED_CONVERSATION_NOT_READY"
  return "READY"
}

/** Read semantic IDs from the real controls, independent of translated labels. */
export function composerSelection(root: {
  querySelectorAll(selector: string): ArrayLike<{ getAttribute(name: string): string | null }>
}) {
  const models = root.querySelectorAll('[data-action="prompt-model"]')
  const agents = root.querySelectorAll('[data-action="prompt-agent"]')
  return {
    modelId: models.length === 1 ? models[0]!.getAttribute("data-model-id") : null,
    providerId: models.length === 1 ? models[0]!.getAttribute("data-provider-id") : null,
    agentId: agents.length === 1 ? agents[0]!.getAttribute("data-agent-id") : null,
  }
}

/** Self-contained so qualification evaluates this same predicate in the renderer. */
export function composerReadiness(input: {
  expectedProjectId: string
  snapshot: {
    hostUnavailable?: boolean
    activeProjectId?: string | null
    activeConversationId?: string | null
    conversation?: Conversation | null
    projects: { id: string; conversations?: Conversation[] }[]
  }
  routeKeys: string[]
  route: string | null
  modelId: string | null
  providerId: string | null
  agentId: string | null
}): "READY" | "CONVERSATION_NOT_READY" | "MODEL_NOT_READY" {
  const s = input.snapshot
  const c = s.conversation
  const p = s.projects.find((project) => project.id === input.expectedProjectId)
  if (
    !input.expectedProjectId ||
    s.hostUnavailable ||
    s.activeProjectId !== input.expectedProjectId ||
    c?.serverId !== "sidecar" ||
    !c.sessionId ||
    !p?.conversations?.some(
      (item) =>
        item.id === s.activeConversationId &&
        item.id === c.id &&
        item.sessionId === c.sessionId &&
        item.serverId === c.serverId,
    ) ||
    input.routeKeys.length !== 1 ||
    input.route !== "/server/c2lkZWNhcg/session/" + c.sessionId
  )
    return "CONVERSATION_NOT_READY"
  if (input.modelId !== "fixture" || input.providerId !== "fixture" || input.agentId !== "physical-systems")
    return "MODEL_NOT_READY"
  return "READY"
}
