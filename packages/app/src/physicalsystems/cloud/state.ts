// SPDX-License-Identifier: Apache-2.0
import type { CloudConversationOptions, CloudConversationSnapshot, CloudPromptAdmission } from "./types"
import { roomAccessDenied, workcellPath } from "../rooms/state"

export function conversationPath(workcellId: string, conversationId: string) {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(conversationId)) throw new Error("INVALID_CONVERSATION_ID")
  return `${workcellPath(workcellId)}/conversations/${encodeURIComponent(conversationId)}`
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

export function readSnapshot(value: unknown, workcellId: string, conversationId: string): CloudConversationSnapshot {
  if (!record(value) || !record(value.conversation) || !record(value.runtime) || !record(value.status))
    throw new Error("INVALID_CLOUD_SNAPSHOT")
  const conversation = value.conversation
  if (
    conversation.id !== conversationId ||
    conversation.workcellId !== workcellId ||
    typeof conversation.title !== "string" ||
    !["private", "team"].includes(String(conversation.visibility)) ||
    typeof conversation.canWrite !== "boolean" ||
    !["ready", "unavailable"].includes(String(value.runtime.status)) ||
    !["idle", "busy", "retry"].includes(String(value.status.type)) ||
    !Array.isArray(value.messages) ||
    !Array.isArray(value.permissions) ||
    value.permissions.length !== 0
  )
    throw new Error("INVALID_CLOUD_SNAPSHOT")
  if (value.session === null) {
    if (value.messages.length) throw new Error("INVALID_CLOUD_SNAPSHOT")
  } else if (
    !record(value.session) ||
    typeof value.session.id !== "string" ||
    !value.session.id ||
    !record(value.session.location) ||
    typeof value.session.location.directory !== "string" ||
    !record(value.session.time) ||
    typeof value.session.time.created !== "number"
  )
    throw new Error("INVALID_CLOUD_SNAPSHOT")
  // The gateway owns the canonical protocol validation; reject malformed envelopes
  // before handing their messages to the unmodified OpenCode projection.
  if (
    value.messages.some(
      (message) =>
        !record(message) ||
        typeof message.id !== "string" ||
        typeof message.type !== "string" ||
        !record(message.time) ||
        typeof message.time.created !== "number",
    )
  )
    throw new Error("INVALID_CLOUD_SNAPSHOT")
  return value as CloudConversationSnapshot
}

type PendingPrompt = { requestId: string; text: string }
type PendingStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

export function createCloudConversationClient(options: CloudConversationOptions, storage?: PendingStorage) {
  if (!/^[A-Za-z0-9_:@-]{1,160}$/.test(options.accountKey)) throw new Error("INVALID_CLOUD_ACCOUNT_KEY")
  const path = conversationPath(options.workcellId, options.conversationId)
  const key = `physicalsystems.cloud-prompt.v1.${options.accountKey}.${options.workcellId}.${options.conversationId}`
  const controller = new AbortController()
  let disposed = false
  let pending: PendingPrompt | undefined
  let recoveryFailed = false
  try {
    storage ??= sessionStorage
    const saved = storage.getItem(key)
    if (saved) {
      const value: unknown = JSON.parse(saved)
      if (
        !record(value) ||
        typeof value.requestId !== "string" ||
        !/^[A-Za-z0-9_-]{8,100}$/.test(value.requestId) ||
        typeof value.text !== "string" ||
        !value.text.trim() ||
        value.text.length > 32000
      )
        throw new Error("INVALID_CLOUD_PROMPT")
      pending = { requestId: value.requestId, text: value.text }
    }
  } catch {
    recoveryFailed = true
  }
  let posting = false
  const active = () => !disposed
  const check = () => {
    if (!active()) throw new Error("CLOUD_SESSION_CHANGED")
  }
  return {
    pending: () => pending && { ...pending },
    async snapshot() {
      const value = await options.transport.request("GET", `${path}/runtime`, undefined, controller.signal)
      check()
      return readSnapshot(value, options.workcellId, options.conversationId)
    },
    async submit(text: string): Promise<CloudPromptAdmission> {
      check()
      if (recoveryFailed || !storage) throw new Error("CLOUD_PROMPT_RECOVERY_REQUIRED")
      if (posting) throw new Error("CLOUD_PROMPT_PENDING")
      if (!text.trim() || text.length > 32000) throw new Error("INVALID_CLOUD_PROMPT")
      if (pending && text !== pending.text) throw new Error("CLOUD_PROMPT_UNCONFIRMED")
      pending ??= { requestId: crypto.randomUUID(), text }
      const request = { ...pending }
      // Persist before dispatch so a reload cannot turn an uncertain POST into a new prompt.
      storage.setItem(key, JSON.stringify(request))
      posting = true
      try {
        const result = await options.transport.request("POST", `${path}/prompts`, request, controller.signal)
        check()
        if (!record(result) || result.requestId !== request.requestId || result.admitted !== true)
          throw new Error("CLOUD_PROMPT_UNCONFIRMED")
        storage.removeItem(key)
        pending = undefined
        return result as CloudPromptAdmission
      } catch (error) {
        const status = record(error) ? error.status : undefined
        if (active() && typeof status === "number" && status >= 400 && status < 500 && ![408, 429].includes(status)) {
          storage.removeItem(key)
          pending = undefined
        }
        throw error
      } finally {
        posting = false
      }
    },
    dispose() {
      disposed = true
      pending = undefined
      controller.abort()
    },
  }
}

export function cloudAccessDenied(error: unknown) {
  return (
    roomAccessDenied(error) ||
    (record(error) &&
      /^(?:CLOUD_SESSION_CHANGED|CONVERSATION_ACCESS_REVOKED|CONVERSATION_SIGN_IN_REQUIRED|CONVERSATION_SESSION_CHANGED)$/.test(
        String(error.code ?? error.message),
      ))
  )
}
