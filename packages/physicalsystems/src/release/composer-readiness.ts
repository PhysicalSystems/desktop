// SPDX-License-Identifier: Apache-2.0
type Conversation = { id: string; serverId: string; sessionId: string }

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
  model: string | null
  agent: string | null
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
  if (input.model?.trim() !== "Synthetic workflow fixture" || input.agent?.trim() !== "physical-systems")
    return "MODEL_NOT_READY"
  return "READY"
}
