// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { v2AgentState, v2ContinuationEvidence } from "./v2-agent"
import { admitContinuation, continuationMessageId } from "./continuation"

test("V2 active snapshot distinguishes idle, running and unavailable", () => {
  expect(v2AgentState({ data: {} }, "ses_1")).toEqual({ busy: false, error: null })
  expect(v2AgentState({ data: { ses_1: { type: "running" } } }, "ses_1")).toEqual({ busy: true, error: null })
  for (const value of [undefined, {}, { data: [] }, { data: { ses_1: { type: "idle" } } }]) expect(v2AgentState(value, "ses_1").busy).toBe(true)
})

test("V2 continuation proves durable inbox admission, then reconciles projected retry", async () => {
  const request = { requestId: "req_1", sessionId: "ses_1", text: "Continue approved synthetic experiment" }
  const id = continuationMessageId(request.requestId, request.sessionId)
  const payload = { text: request.text, metadata: { physicalSystemsContinuation: { requestId: request.requestId, sessionId: request.sessionId } } }
  let stored: unknown
  const io = { read: async () => v2ContinuationEvidence(stored, id, request.sessionId, request.requestId), post: async () => { stored = { id, sessionID: request.sessionId, type: "user", payload, delivery: "steer" } } }
  expect(await admitContinuation(request, io)).toMatchObject({ accepted: true, duplicate: false })
  stored = { id, type: "user", ...payload }
  expect(await admitContinuation({ ...request, retry: true }, io)).toMatchObject({ accepted: true, duplicate: true })
  stored = { id, type: "user", ...payload, files: [{ uri: "file:///private" }] }
  await expect(admitContinuation({ ...request, retry: true }, io)).rejects.toThrow("CONTINUATION_MESSAGE_CONFLICT")
  stored = { id, type: "user", text: request.text }
  await expect(admitContinuation({ ...request, retry: true }, io)).rejects.toThrow("CONTINUATION_MESSAGE_CONFLICT")
})
