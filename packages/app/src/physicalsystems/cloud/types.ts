// SPDX-License-Identifier: Apache-2.0
import type { SessionInfo, SessionMessageInfo } from "@opencode-ai/client/promise"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import type { WorkcellRoomData, WorkcellTransport } from "../rooms/types"

/** Account authorization and canonical OpenCode session mapping belong to the host gateway. */
export type CloudConversationSnapshot = {
  conversation: {
    id: string
    workcellId: string
    title: string
    visibility: "private" | "team"
    canWrite: boolean
  }
  session: SessionInfo | null
  messages: SessionMessageInfo[]
  status: SessionStatus
  permissions: []
  runtime: { status: "ready" | "unavailable" }
}

export type CloudPromptAdmission = { requestId: string; admitted: boolean }
export type CloudConversationOptions = {
  /** Stable, non-secret account ID. Replace transport or dispose on every sign-in change. */
  accountKey: string
  workcellId: string
  conversationId: string
  transport: WorkcellTransport
  theme?: "light" | "dark"
  /** Optional authenticated room context; never treated as assistant history. */
  workcell?: WorkcellRoomData
}
