// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { createConversationDraft, createMemberConversationClient } from "./members"
import type { CloudConversationOptions, MemberMessage } from "./types"

function storage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size
    },
    values,
  }
}
function message(sequence: number, content = `Message ${sequence}`): MemberMessage {
  return {
    id: `message-${sequence}`,
    workcellId: "room-1",
    conversationId: "chat-1",
    sequence,
    role: "user",
    authorId: "user-a",
    authorName: "Alice",
    content,
    createdAt: "2026-10-23T10:00:00Z",
  }
}
function options(request: CloudConversationOptions["transport"]["request"]): CloudConversationOptions {
  return {
    accountKey: "user-a",
    workcellId: "room-1",
    conversationId: "chat-1",
    transport: { request },
    allowAi: false,
  }
}
function conversation(messages: MemberMessage[], more = false) {
  return {
    id: "chat-1",
    workcellId: "room-1",
    title: "Shared task",
    visibility: "private",
    permissions: { canRead: true, canPost: true },
    messages,
    messagesHasMore: more,
    messagesBefore: more ? messages[0].sequence : null,
    lastEventSequence: messages.at(-1)?.sequence ?? 0,
  }
}

test("member sends survive lost receipts, two tabs, expiry and restart without becoming AI requests", async () => {
  const saved = storage()
  const receipts = new Map<string, MemberMessage>()
  const calls: { requestId: string; content: string }[] = []
  let lost = true
  let expired = false
  const input = options(async (method, path, body) => {
    expect(method).toBe("POST")
    expect(path).toBe("/api/workcells/room-1/conversations/chat-1/messages")
    const payload = body as { requestId: string; content: string }
    calls.push(payload)
    if (expired) throw Object.assign(new Error("expired"), { status: 401 })
    const replayed = receipts.has(payload.requestId)
    const item = receipts.get(payload.requestId) ?? message(receipts.size + 1, payload.content)
    receipts.set(payload.requestId, item)
    if (lost) {
      lost = false
      throw new Error("receipt lost")
    }
    return { conversation: conversation([...receipts.values()]), message: item, replayed }
  })
  const first = createMemberConversationClient(input, saved)
  const second = createMemberConversationClient(input, saved)
  await expect(first.submit("First tab")).rejects.toThrow("receipt lost")
  const pending = first.pending()!
  await second.submit("Second tab")
  expect(receipts.size).toBe(2)
  expect(saved.length).toBe(1)
  expect([...saved.values.values()][0]).toContain(pending.requestId)
  first.dispose()
  second.dispose()
  const restored = createMemberConversationClient(input, saved)
  expect(restored.pending()).toEqual(pending)
  expired = true
  await expect(restored.submit(pending.content)).rejects.toThrow("expired")
  expect(saved.length).toBe(1)
  restored.dispose()
  expect(createMemberConversationClient({ ...input, accountKey: "user-b" }, saved).pending()).toBeUndefined()
  expect(createMemberConversationClient({ ...input, conversationId: "chat-2" }, saved).pending()).toBeUndefined()
  expired = false
  const reauthorized = createMemberConversationClient(input, saved)
  await reauthorized.submit(pending.content)
  expect(calls.at(-1)).toEqual(calls[0])
  expect(receipts.size).toBe(2)
  expect(saved.length).toBe(0)
})

test("late receipts cannot clear a disposed account's pending intent", async () => {
  const saved = storage()
  let resolve: (value: unknown) => void = () => {}
  const client = createMemberConversationClient(
    options(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    ),
    saved,
  )
  const result = client.submit("Keep this send")
  client.dispose()
  resolve({ conversation: conversation([]), message: message(1, "Keep this send"), replayed: false })
  await expect(result).rejects.toThrow("CLOUD_SESSION_CHANGED")
  expect(saved.length).toBe(1)
})

test("history pagination and forward replay never skip a busy conversation or duplicate receipts", async () => {
  const history = Array.from({ length: 250 }, (_, index) => message(index + 1))
  history[0] = { ...history[0], role: "system", authorId: null, authorName: null, content: "Task received" }
  history[249] = { ...history[249], role: "system", authorId: null, authorName: null, content: "Planned task blocked" }
  const after: number[] = []
  const client = createMemberConversationClient(
    options(async (_method, path) => {
      if (!path.includes("?")) return { conversation: conversation(history.slice(-100), history.length > 100) }
      const url = new URL(path, "https://fixture.invalid")
      if (url.pathname.endsWith("/messages")) {
        const before = Number(url.searchParams.get("before"))
        const previous = history.filter((item) => item.sequence < before)
        const page = previous.slice(-100)
        return {
          messages: page,
          hasMore: previous.length > 100,
          nextBefore: previous.length > 100 ? page[0].sequence : null,
          lastEventSequence: history.length,
        }
      }
      const cursor = Number(url.searchParams.get("after"))
      after.push(cursor)
      const remaining = history.filter((item) => item.sequence > cursor)
      const page = remaining.slice(0, 100)
      return {
        events: page.map((item) => ({
          workcellId: "room-1",
          conversationId: "chat-1",
          sequence: item.sequence,
          type: "message.posted",
          message: item,
        })),
        nextCursor: page.at(-1)?.sequence ?? cursor,
        hasMore: remaining.length > 100,
        lastEventSequence: history.length,
      }
    }),
    storage(),
  )
  expect((await client.snapshot()).messages).toHaveLength(100)
  history.push(...Array.from({ length: 200 }, (_, index) => message(index + 251)))
  history[250] = { ...history[250], role: "system", authorId: null, authorName: null, content: "Planning update" }
  expect((await client.snapshot()).catchingUp).toBe(true)
  await client.earlier()
  const caught = await client.snapshot()
  expect(caught.catchingUp).toBe(false)
  expect(after).toEqual([250, 350])
  const complete = await client.earlier()
  expect(complete!.messages.map((item) => item.sequence)).toEqual(Array.from({ length: 450 }, (_, index) => index + 1))
  expect(complete!.messagesHasMore).toBe(false)
  expect((await client.snapshot()).messages).toHaveLength(450)
})

test("cross-conversation receipts and corrupt outboxes cannot confirm or dispatch a replacement send", async () => {
  const saved = storage()
  const client = createMemberConversationClient(
    options(async () => ({
      conversation: conversation([]),
      message: { ...message(1, "Private"), conversationId: "other" },
      replayed: false,
    })),
    saved,
  )
  await expect(client.submit("Private")).rejects.toThrow("INVALID_MEMBER_SNAPSHOT")
  expect(saved.length).toBe(1)
  const key = saved.key(0)!
  saved.setItem(key, "broken-json")
  let calls = 0
  const recovered = createMemberConversationClient(
    options(async () => {
      calls++
      return {}
    }),
    saved,
  )
  await expect(recovered.submit("Replacement")).rejects.toThrow("MEMBER_RECOVERY_REQUIRED")
  expect(calls).toBe(0)
})

test("drafts persist without being sends and stay scoped by account, conversation and action", () => {
  const saved = storage()
  const input = options(async () => {
    throw new Error("Drafts must not send")
  })
  createConversationDraft(input, "message", saved).save("Unsent draft")
  expect(createConversationDraft(input, "message", saved).read()).toBe("Unsent draft")
  expect(createConversationDraft(input, "ai", saved).read()).toBe("")
  expect(createConversationDraft({ ...input, accountKey: "other" }, "message", saved).read()).toBe("")
  expect(createConversationDraft({ ...input, conversationId: "other" }, "message", saved).read()).toBe("")
  expect(() => createConversationDraft(input, "message", saved).save("a".repeat(8001))).toThrow("INVALID_CLOUD_DRAFT")
  createConversationDraft(input, "message", saved).clear()
  expect(saved.length).toBe(0)
})

test.each(["history", "events"])(
  "concurrent earlier/live responses resolving %s first retain both histories",
  async (order) => {
    const history = Array.from({ length: 201 }, (_, index) => message(index + 1))
    let initial = true
    let historyResponse: (value: unknown) => void = () => {}
    let eventResponse: (value: unknown) => void = () => {}
    let registered: () => void = () => {}
    const ready = new Promise<void>((resolve) => {
      registered = resolve
    })
    const cursors: number[] = []
    const client = createMemberConversationClient(
      options(async (_method, path) => {
        if (!path.includes("?"))
          return { conversation: conversation(history.slice(initial ? 100 : 101, initial ? 200 : 201), true) }
        if (path.includes("/messages?"))
          return new Promise((resolve) => {
            historyResponse = resolve
          })
        const after = Number(new URL(path, "https://fixture.invalid").searchParams.get("after"))
        cursors.push(after)
        if (cursors.length === 1)
          return new Promise((resolve) => {
            eventResponse = resolve
            registered()
          })
        return { events: [], nextCursor: after, hasMore: false, lastEventSequence: 201 }
      }),
      storage(),
    )
    await client.snapshot()
    initial = false
    const older = client.earlier()
    const newer = client.snapshot()
    await ready
    const earlierPage = { messages: history.slice(0, 100), hasMore: false, nextBefore: null, lastEventSequence: 999 }
    const livePage = {
      events: [
        {
          workcellId: "room-1",
          conversationId: "chat-1",
          sequence: 201,
          type: "message.posted",
          message: history[200],
        },
      ],
      nextCursor: 201,
      hasMore: false,
      lastEventSequence: 201,
    }
    if (order === "history") {
      historyResponse(earlierPage)
      await older
      eventResponse(livePage)
      await newer
    }
    if (order === "events") {
      eventResponse(livePage)
      await newer
      historyResponse(earlierPage)
      await older
    }
    const result = await client.snapshot()
    expect(result.messages.map((item) => item.sequence)).toEqual(Array.from({ length: 201 }, (_, index) => index + 1))
    expect(result.messagesHasMore).toBe(false)
    expect(cursors).toEqual([200, 201])
  },
)
