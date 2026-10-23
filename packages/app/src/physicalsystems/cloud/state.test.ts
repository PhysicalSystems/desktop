// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { createCloudConversationClient, readSnapshot, conversationPath } from "./state"
import type { CloudConversationOptions, CloudConversationSnapshot } from "./types"

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
    values,
  }
}
const snapshot: CloudConversationSnapshot = {
  conversation: { id: "chat-1", workcellId: "room-1", title: "Task", visibility: "private", canWrite: true },
  session: null,
  messages: [],
  status: { type: "idle" },
  permissions: [],
  runtime: { status: "ready" },
}
const options = (request: CloudConversationOptions["transport"]["request"]): CloudConversationOptions => ({
  accountKey: "user-a",
  workcellId: "room-1",
  conversationId: "chat-1",
  transport: { request },
})

test("empty configured conversations and unavailable workers are explicit, with no invented session", () => {
  expect(readSnapshot(snapshot, "room-1", "chat-1").session).toBeNull()
  expect(readSnapshot({ ...snapshot, runtime: { status: "unavailable" } }, "room-1", "chat-1").runtime.status).toBe(
    "unavailable",
  )
  expect(() => readSnapshot(snapshot, "room-2", "chat-1")).toThrow("INVALID_CLOUD_SNAPSHOT")
  expect(() => readSnapshot({ ...snapshot, messages: [{}] }, "room-1", "chat-1")).toThrow("INVALID_CLOUD_SNAPSHOT")
  expect(() => conversationPath("room-1", "../session")).toThrow("INVALID_CONVERSATION_ID")
})

test("uncertain prompts survive remount, only exact retries reuse their request ID", async () => {
  const saved = storage()
  const calls: unknown[] = []
  const first = createCloudConversationClient(
    options(async (_method, path, body) => {
      calls.push({ path, body })
      throw new Error("network")
    }),
    saved,
  )
  await expect(first.submit("Plan a workcell")).rejects.toThrow("network")
  const previous = first.pending()
  first.dispose()
  const next = createCloudConversationClient(
    options(async (_method, path, body) => {
      calls.push({ path, body })
      return { ...(body as object), admitted: true }
    }),
    saved,
  )
  expect(next.pending()).toEqual(previous)
  await expect(next.submit("Another task")).rejects.toThrow("CLOUD_PROMPT_UNCONFIRMED")
  await next.submit("Plan a workcell")
  expect(calls).toHaveLength(2)
  expect(calls[1]).toEqual(calls[0])
  expect(next.pending()).toBeUndefined()
  expect(saved.values.size).toBe(0)
})

test("prompt recovery remains scoped to account and conversation, without any credentials", async () => {
  const saved = storage()
  const first = createCloudConversationClient(
    options(async () => {
      throw new Error("network")
    }),
    saved,
  )
  await expect(first.submit("Private task")).rejects.toThrow()
  const other = createCloudConversationClient({ ...options(async () => snapshot), accountKey: "user-b" }, saved)
  expect(other.pending()).toBeUndefined()
  expect([...saved.values.keys()]).toEqual(["physicalsystems.cloud-prompt.v1.user-a.room-1.chat-1"])
  expect([...saved.values.values()][0]).not.toContain("token")
})

test("definitive failures resolve a prompt, while 408, 429, 5xx retain it", async () => {
  for (const status of [400, 409, 408, 429, 503]) {
    const client = createCloudConversationClient(
      options(async () => {
        throw Object.assign(new Error("failure"), { status })
      }),
      storage(),
    )
    await expect(client.submit("Plan a task")).rejects.toThrow("failure")
    expect(Boolean(client.pending())).toBe([408, 429, 503].includes(status))
  }
})

test("late account responses cannot populate a replacement view or clear unresolved prompts", async () => {
  const saved = storage()
  let resolve: (value: unknown) => void = () => {}
  const client = createCloudConversationClient(
    options(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    ),
    saved,
  )
  const pending = client.submit("Task A")
  const request = client.pending()!
  client.dispose()
  resolve({ requestId: request.requestId, admitted: true })
  await expect(pending).rejects.toThrow("CLOUD_SESSION_CHANGED")
  expect(saved.values.size).toBe(1)
  const read = createCloudConversationClient(
    options(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    ),
    storage(),
  )
  const result = read.snapshot()
  read.dispose()
  resolve(snapshot)
  await expect(result).rejects.toThrow("CLOUD_SESSION_CHANGED")
})

test("corrupt or inaccessible recovery storage never dispatches a new prompt", async () => {
  let calls = 0
  const input = options(async () => {
    calls++
    return snapshot
  })
  const client = createCloudConversationClient(input, {
    getItem: () => "bad-json",
    setItem: () => {},
    removeItem: () => {},
  })
  await expect(client.snapshot()).resolves.toEqual(snapshot)
  await expect(client.submit("Task")).rejects.toThrow("CLOUD_PROMPT_RECOVERY_REQUIRED")
  expect(calls).toBe(1)
})

test("prompt length matches the 32,000-character gateway contract", async () => {
  let calls = 0
  const client = createCloudConversationClient(
    options(async (_method, _path, body) => {
      calls++
      return { ...(body as object), admitted: true }
    }),
    storage(),
  )
  await expect(client.submit("a".repeat(32001))).rejects.toThrow("INVALID_CLOUD_PROMPT")
  expect(calls).toBe(0)
  await expect(client.submit("a".repeat(32000))).resolves.toMatchObject({ admitted: true })
  expect(calls).toBe(1)
})
