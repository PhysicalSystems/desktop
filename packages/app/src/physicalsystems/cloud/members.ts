// SPDX-License-Identifier: Apache-2.0
import { cloudAccessDenied, conversationPath } from "./state"
import type { CloudConversationOptions, MemberConversation, MemberMessage } from "./types"

export type ConversationStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">
type PendingMessage = { requestId: string; content: string }

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function sequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

export function conversationStorageKey(options: CloudConversationOptions, kind: string) {
  if (!/^[A-Za-z0-9_:@-]{1,160}$/.test(options.accountKey)) throw new Error("INVALID_CLOUD_ACCOUNT_KEY")
  conversationPath(options.workcellId, options.conversationId)
  return `physicalsystems.cloud-${kind}.v1.${options.accountKey}.${options.workcellId}.${options.conversationId}`
}

export function createConversationDraft(
  options: CloudConversationOptions,
  kind: "message" | "ai",
  storage?: ConversationStorage,
) {
  const key = conversationStorageKey(options, `${kind}-draft`)
  const limit = kind === "message" ? 8000 : 32000
  return {
    read() {
      const value = (storage ?? localStorage).getItem(key) ?? ""
      if (value.length > limit) throw new Error("INVALID_CLOUD_DRAFT")
      return value
    },
    save(value: string) {
      if (value.length > limit) throw new Error("INVALID_CLOUD_DRAFT")
      if (value) (storage ?? localStorage).setItem(key, value)
      else (storage ?? localStorage).removeItem(key)
    },
    clear() {
      ;(storage ?? localStorage).removeItem(key)
    },
  }
}

function readMessage(value: unknown, options: CloudConversationOptions): MemberMessage {
  if (
    !record(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    value.workcellId !== options.workcellId ||
    value.conversationId !== options.conversationId ||
    !sequence(value.sequence) ||
    value.sequence < 1 ||
    !["user", "system"].includes(String(value.role)) ||
    !(value.authorId === null || typeof value.authorId === "string") ||
    !(value.authorName === null || typeof value.authorName === "string") ||
    typeof value.content !== "string" ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt))
  )
    throw new Error("INVALID_MEMBER_SNAPSHOT")
  return value as MemberMessage
}

function readMessages(value: unknown, options: CloudConversationOptions) {
  if (!Array.isArray(value) || value.length > 100) throw new Error("INVALID_MEMBER_SNAPSHOT")
  const messages = value.map((message) => readMessage(message, options))
  if (messages.some((message, index) => index > 0 && message.sequence <= messages[index - 1].sequence))
    throw new Error("INVALID_MEMBER_SNAPSHOT")
  return messages
}

function readConversation(value: unknown, options: CloudConversationOptions): MemberConversation {
  if (
    !record(value) ||
    value.id !== options.conversationId ||
    value.workcellId !== options.workcellId ||
    typeof value.title !== "string" ||
    !["private", "team"].includes(String(value.visibility)) ||
    !record(value.permissions) ||
    value.permissions.canRead !== true ||
    typeof value.permissions.canPost !== "boolean" ||
    !sequence(value.lastEventSequence) ||
    typeof value.messagesHasMore !== "boolean"
  )
    throw new Error("INVALID_MEMBER_SNAPSHOT")
  const messages = readMessages(value.messages, options)
  const before = value.messagesBefore ?? (value.messagesHasMore ? messages[0]?.sequence : null)
  const lastEventSequence = value.lastEventSequence
  if (
    messages.some((message) => message.sequence > lastEventSequence) ||
    (value.messagesHasMore && (!sequence(before) || before < 1 || before !== messages[0]?.sequence))
  )
    throw new Error("INVALID_MEMBER_SNAPSHOT")
  return { ...value, messages, messagesBefore: value.messagesHasMore ? before : null } as MemberConversation
}

function mergeMessages(previous: MemberMessage[], incoming: MemberMessage[]) {
  const messages = new Map(previous.map((message) => [message.id, message]))
  for (const message of incoming) {
    const existing = messages.get(message.id)
    if (existing && JSON.stringify(existing) !== JSON.stringify(message)) throw new Error("INVALID_MEMBER_SNAPSHOT")
    messages.set(message.id, message)
  }
  return [...messages.values()].sort((left, right) => left.sequence - right.sequence)
}

/** A saved-message transport. It never calls the AI runtime or prompts endpoints. */
export function createMemberConversationClient(options: CloudConversationOptions, storage?: ConversationStorage) {
  const path = conversationPath(options.workcellId, options.conversationId)
  const key = conversationStorageKey(options, "message-outbox")
  const controller = new AbortController()
  let disposed = false
  let pending: PendingMessage | undefined
  let recoveryFailed = false
  let posting = false
  let cached: MemberConversation | undefined
  let cursor = 0
  const savedRequests = () => {
    if (!storage) throw new Error("MEMBER_RECOVERY_REQUIRED")
    const keys = Array.from({ length: storage.length }, (_, index) => storage!.key(index))
      .filter((entry): entry is string => Boolean(entry?.startsWith(`${key}.`)))
      .sort()
    if (keys.length > 20) throw new Error("MEMBER_RECOVERY_REQUIRED")
    return keys.map((entry) => {
      const value: unknown = JSON.parse(storage!.getItem(entry) ?? "null")
      if (
        !record(value) ||
        typeof value.requestId !== "string" ||
        entry !== `${key}.${value.requestId}` ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.requestId) ||
        typeof value.content !== "string" ||
        !value.content.trim() ||
        value.content.length > 8000
      )
        throw new Error("INVALID_MEMBER_OUTBOX")
      return { requestId: value.requestId, content: value.content }
    })
  }
  try {
    storage ??= localStorage
    pending = savedRequests()[0]
  } catch {
    recoveryFailed = true
  }
  const check = () => {
    if (disposed) throw new Error("CLOUD_SESSION_CHANGED")
  }
  const request = async (method: "GET" | "POST", target: string, body?: unknown) => {
    const value = await options.transport.request(method, target, body, controller.signal)
    check()
    return value
  }
  const forget = () => {
    if (storage) for (const request of savedRequests()) storage.removeItem(`${key}.${request.requestId}`)
    pending = undefined
    cached = undefined
  }
  return {
    pending: () => pending && { ...pending },
    async snapshot() {
      const value = await request("GET", path)
      const detail = readConversation(record(value) ? value.conversation : undefined, options)
      if (!cached) {
        cursor = detail.lastEventSequence
        cached = detail
        return cached
      }
      // Replay the complete forward stream, not just the latest 100-message window.
      // Each refresh reads one page; catchingUp schedules the next page immediately.
      const page = await request("GET", `${path}/events?after=${cursor}&limit=100`)
      if (
        !record(page) ||
        !Array.isArray(page.events) ||
        page.events.length > 100 ||
        !sequence(page.nextCursor) ||
        page.nextCursor < cursor ||
        typeof page.hasMore !== "boolean" ||
        !sequence(page.lastEventSequence) ||
        page.nextCursor > page.lastEventSequence ||
        (page.hasMore && page.nextCursor <= cursor)
      )
        throw new Error("INVALID_MEMBER_SNAPSHOT")
      let previous = cursor
      const messages: MemberMessage[] = []
      for (const event of page.events) {
        if (
          !record(event) ||
          event.workcellId !== options.workcellId ||
          event.conversationId !== options.conversationId ||
          !sequence(event.sequence) ||
          event.sequence <= previous ||
          event.sequence > page.nextCursor
        )
          throw new Error("INVALID_MEMBER_SNAPSHOT")
        previous = event.sequence
        if (event.type === "message.posted") {
          const message = readMessage(event.message, options)
          if (message.sequence !== event.sequence) throw new Error("INVALID_MEMBER_SNAPSHOT")
          messages.push(message)
        }
      }
      cursor = page.nextCursor
      cached = {
        ...detail,
        messages: mergeMessages(cached.messages, messages),
        messagesHasMore: cached.messagesHasMore,
        messagesBefore: cached.messagesBefore,
        catchingUp: page.hasMore,
      }
      return cached
    },
    async earlier() {
      check()
      if (!cached?.messagesHasMore || cached.messagesBefore === null) return cached
      const before = cached.messagesBefore
      const value = await request("GET", `${path}/messages?before=${before}&limit=100`)
      if (!record(value) || typeof value.hasMore !== "boolean" || !sequence(value.lastEventSequence))
        throw new Error("INVALID_MEMBER_SNAPSHOT")
      const messages = readMessages(value.messages, options)
      if (
        messages.some((message) => message.sequence >= before) ||
        (value.hasMore &&
          (!sequence(value.nextBefore) || value.nextBefore < 1 || value.nextBefore !== messages[0]?.sequence)) ||
        (!value.hasMore && value.nextBefore !== null)
      )
        throw new Error("INVALID_MEMBER_SNAPSHOT")
      // History pagination cannot advance the live event cursor or drop new arrivals.
      cached = {
        ...cached,
        messages: mergeMessages(cached.messages, messages),
        messagesHasMore: value.hasMore,
        messagesBefore: value.hasMore ? (value.nextBefore as number) : null,
      }
      return cached
    },
    async submit(content: string) {
      check()
      if (recoveryFailed || !storage) throw new Error("MEMBER_RECOVERY_REQUIRED")
      if (posting) throw new Error("MEMBER_MESSAGE_PENDING")
      if (!content.trim() || content.trim().length > 8000) throw new Error("INVALID_MEMBER_MESSAGE")
      if (pending && content.trim() !== pending.content) throw new Error("MEMBER_MESSAGE_UNCONFIRMED")
      if (!pending && savedRequests().length >= 20) throw new Error("MEMBER_RECOVERY_REQUIRED")
      pending ??= { requestId: crypto.randomUUID(), content: content.trim() }
      const payload = { ...pending }
      const requestKey = `${key}.${payload.requestId}`
      const serialized = JSON.stringify(payload)
      const previous = storage.getItem(requestKey)
      if (previous && previous !== serialized) throw new Error("MEMBER_MESSAGE_UNCONFIRMED")
      storage.setItem(requestKey, serialized)
      posting = true
      try {
        const value = await request("POST", `${path}/messages`, payload)
        if (
          !record(value) ||
          !record(value.conversation) ||
          value.conversation.id !== options.conversationId ||
          value.conversation.workcellId !== options.workcellId ||
          typeof value.replayed !== "boolean"
        )
          throw new Error("MEMBER_MESSAGE_UNCONFIRMED")
        const message = readMessage(value.message, options)
        if (message.role !== "user" || message.content !== payload.content)
          throw new Error("MEMBER_MESSAGE_UNCONFIRMED")
        if (storage.getItem(requestKey) === serialized) storage.removeItem(requestKey)
        pending = savedRequests()[0]
        return message
      } catch (error) {
        const status = record(error) ? error.status : undefined
        if (
          !disposed &&
          !cloudAccessDenied(error) &&
          typeof status === "number" &&
          status >= 400 &&
          status < 500 &&
          ![408, 429].includes(status)
        ) {
          if (storage.getItem(requestKey) === serialized) storage.removeItem(requestKey)
          pending = savedRequests()[0]
        }
        throw error
      } finally {
        posting = false
      }
    },
    forget,
    dispose() {
      disposed = true
      pending = undefined
      cached = undefined
      controller.abort()
    },
  }
}
