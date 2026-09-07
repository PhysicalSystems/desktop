// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { admitContinuation, continuationMessageId } from "./continuation"
const input = { requestId: "request-1", sessionId: "session-1", text: "Continue exact experiment" }
const record = { info: { id: continuationMessageId(input.requestId, input.sessionId), sessionID: input.sessionId, role: "user", agent: "physical-systems" }, parts: [{ type: "text", text: input.text }] }

test("204 alone cannot claim durable continuation admission", async () => {
  let posts = 0
  await expect(admitContinuation(input, { read: async () => undefined, post: async () => { posts++ }, delay: async () => {} })).rejects.toThrow("UNCONFIRMED")
  expect(posts).toBe(1)
  await expect(admitContinuation({ ...input, retry: true }, { read: async () => undefined, post: async () => { posts++ } })).rejects.toThrow("UNCONFIRMED")
  expect(posts).toBe(1)
})

test("lost acknowledgement resolves through exact stored message without reposting", async () => {
  let posts = 0
  const accepted = await admitContinuation({ ...input, retry: true }, { read: async () => record, post: async () => { posts++ } })
  expect(accepted).toEqual({ accepted: true, duplicate: true, requestId: input.requestId })
  expect(posts).toBe(0)
  await expect(admitContinuation(input, { read: async () => ({ ...record, info: { ...record.info, sessionID: "other" } }), post: async () => {} })).rejects.toThrow("CONFLICT")
})

test("first admission waits for stored exact user message", async () => {
  let posted = false
  const result = await admitContinuation(input, { read: async () => posted ? record : undefined, post: async () => { posted = true } })
  expect(result.accepted).toBe(true)
  expect(result.duplicate).toBe(false)
})

test("continuation IDs are session-scoped and extra parts cannot claim exact admission", async () => {
  expect(continuationMessageId("same", "a")).not.toBe(continuationMessageId("same", "b"))
  await expect(admitContinuation(input, { read: async () => ({ ...record, parts: [...record.parts, { type: "text", text: "unreviewed" }] }), post: async () => {} })).rejects.toThrow("CONFLICT")
})
