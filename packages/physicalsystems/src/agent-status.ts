// SPDX-License-Identifier: Apache-2.0
/** Missing status is unknown/busy until an authoritative status snapshot arrives. */
export function agentState(status: unknown, sessionId: string) {
  if (!record(status))
    return {
      busy: true,
      error: "The assistant connection is unavailable. Reconnect before continuing; Stop remains available.",
    }
  let busy = false
  // Legacy idle sessions are omitted, so only a fully valid StatusMap can
  // establish that an absent session is idle. Envelopes/errors are not maps.
  for (const [key, value] of Object.entries(status)) {
    if (!info(value))
      return { busy: true, error: "The assistant status is unconfirmed. Refresh its connection before continuing." }
    if (key === sessionId) busy = value.type !== "idle"
  }
  return { busy, error: null }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function info(value: unknown): value is Record<string, unknown> {
  if (!record(value)) return false
  if (value.type === "idle" || value.type === "busy") return true
  // Mirrors SessionStatusEvent.Info and schema.ts NonNegativeInt without
  // introducing a schema runtime dependency into the desktop worker.
  if (value.type !== "retry" || typeof value.message !== "string") return false
  if (!Number.isSafeInteger(value.attempt) || (value.attempt as number) < 0) return false
  if (!Number.isSafeInteger(value.next) || (value.next as number) < 0) return false
  const action = value.action
  if (action === undefined) return true
  if (!record(action)) return false
  if (!["reason", "provider", "title", "message", "label"].every((key) => typeof action[key] === "string")) return false
  return action.link === undefined || typeof action.link === "string"
}
