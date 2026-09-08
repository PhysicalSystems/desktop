// SPDX-License-Identifier: Apache-2.0
import { agentState } from "../agent-status"

/** Validate the complete legacy StatusMap before treating a missing session as
 * idle. This read-only prerequisite neither admits approval nor retries it. */
export async function legacyApprovalReady(
  response: Pick<Response, "status" | "json">,
  sessionId: string,
  controlsReady: () => Promise<boolean>,
): Promise<boolean> {
  try {
    if (response.status !== 200) throw new Error()
    const next = agentState(await response.json(), sessionId)
    if (next.error !== null) throw new Error()
    if (next.busy) return false
    return (await controlsReady()) === true
  } catch {
    // Neither server messages/actions nor parse/transport details belong in a receipt.
    throw new Error("PACKAGED_APPROVAL_NOT_READY")
  }
}
