// SPDX-License-Identifier: Apache-2.0
import { agentState } from "./agent-status"

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** /api/session/active is a complete snapshot of foreground execution owners. */
export function v2AgentState(value: unknown, sessionId: string) {
  if (!record(value) || !record(value.data)) return agentState(undefined, sessionId)
  const status: Record<string, { type: "busy" }> = {}
  for (const [id, item] of Object.entries(value.data)) {
    if (!record(item) || item.type !== "running") return agentState(undefined, sessionId)
    status[id] = { type: "busy" }
  }
  return agentState(status, sessionId)
}

/** V2 stores admitted input in its durable inbox before projecting a message.
 * The route already fixes the Session; metadata ties both representations to
 * this operator request, so retries cannot accept a different prompt. */
export function v2ContinuationEvidence(value: unknown, messageId: string, sessionId: string, requestId: string) {
  if (!record(value)) return value
  const payload = record(value.payload) ? value.payload : value
  const marker = record(payload.metadata) ? payload.metadata.physicalSystemsContinuation : undefined
  if (value.id !== messageId || value.type !== "user" ||
    (value.sessionID !== undefined && value.sessionID !== sessionId) ||
    typeof payload.text !== "string" || payload.files !== undefined || payload.agents !== undefined || payload.skills !== undefined ||
    !record(marker) || marker.requestId !== requestId || marker.sessionId !== sessionId) return value
  return { info: { id: messageId, sessionID: sessionId, role: "user", agent: "physical-systems" }, parts: [{ type: "text", text: payload.text }] }
}
