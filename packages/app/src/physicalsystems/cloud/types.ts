// SPDX-License-Identifier: Apache-2.0
import type { SessionInfo, SessionMessageInfo } from "@opencode/client/promise"
import type { SessionStatus } from "@opencode/client/promise"
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
  /** Workcell-only grants can exchange saved messages without requesting AI execution scope. */
  allowAi?: boolean
  theme?: "light" | "dark"
  /** Optional authenticated room context; never treated as assistant history. */
  workcell?: WorkcellRoomData
}

export type MemberMessage = {
  id: string
  workcellId: string
  conversationId: string
  sequence: number
  role: "user" | "system"
  authorId: string | null
  authorName: string | null
  content: string
  createdAt: string
}

export type MemberConversation = {
  id: string
  workcellId: string
  title: string
  visibility: "private" | "team"
  permissions: { canRead: true; canPost: boolean }
  messages: MemberMessage[]
  messagesHasMore: boolean
  messagesBefore: number | null
  lastEventSequence: number
  catchingUp?: boolean
}
