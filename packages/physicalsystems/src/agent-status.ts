// SPDX-License-Identifier: Apache-2.0
/** Missing status is unknown/busy until an authoritative status snapshot arrives. */
export function agentState(status: unknown, sessionId: string) {
  if (!status || typeof status !== "object" || Array.isArray(status)) return { busy: true, error: "The assistant connection is unavailable. Reconnect before continuing; Stop remains available." }
  const value = (status as Record<string, unknown>)[sessionId]
  if (value === undefined) return { busy: false, error: null }
  if (!value || typeof value !== "object" || !["idle", "busy", "retry"].includes(String((value as { type?: unknown }).type))) return { busy: true, error: "The assistant status is unconfirmed. Refresh its connection before continuing." }
  return { busy: (value as { type: string }).type !== "idle", error: null }
}
