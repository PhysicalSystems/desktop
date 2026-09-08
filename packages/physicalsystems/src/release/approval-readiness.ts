// SPDX-License-Identifier: Apache-2.0

/** Validate the complete legacy StatusMap before treating a missing session as
 * idle. This read-only prerequisite neither admits approval nor retries it. */
export async function legacyApprovalReady(
  response: Pick<Response, "status" | "json">,
  sessionId: string,
  controlsReady: () => Promise<boolean>,
): Promise<boolean> {
  try {
    if (response.status !== 200) throw new Error()
    const body: unknown = await response.json()
    if (!record(body)) throw new Error()
    let busy = false
    for (const [key, value] of Object.entries(body)) {
      if (!status(value)) throw new Error()
      if (key === sessionId) busy = value.type !== "idle"
    }
    if (busy) return false
    return (await controlsReady()) === true
  } catch {
    // Neither server messages/actions nor parse/transport details belong in a receipt.
    throw new Error("PACKAGED_APPROVAL_NOT_READY")
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function status(value: unknown): value is Record<string, unknown> {
  if (!record(value)) return false
  if (value.type === "idle" || value.type === "busy") return true
  // Mirrors SessionStatusEvent.Info and schema.ts NonNegativeInt without adding
  // the schema package to the dependency-free native qualification bootstrap.
  if (value.type !== "retry" || typeof value.message !== "string") return false
  if (!Number.isSafeInteger(value.attempt) || (value.attempt as number) < 0) return false
  if (!Number.isSafeInteger(value.next) || (value.next as number) < 0) return false
  const action = value.action
  if (action === undefined) return true
  if (!record(action)) return false
  if (!["reason", "provider", "title", "message", "label"].every((key) => typeof action[key] === "string")) return false
  return action.link === undefined || typeof action.link === "string"
}
