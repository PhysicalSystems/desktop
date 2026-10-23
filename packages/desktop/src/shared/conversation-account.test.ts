import { expect, test } from "bun:test"
import { conversationAccountBridge } from "./conversation-account"
import type { ConversationRequestResult } from "./conversation-account"

test("the renderer reconstructs cloud request errors after the native context boundary", async () => {
  const state = {
    revision: 0,
    sessionId: null,
    status: "signed_out" as const,
    account: null,
    pending: null,
    error: null,
  }
  const read = async () => state
  for (const result of [
    { ok: true, value: { workcells: [] } },
    { ok: false, error: "CONVERSATION_SIGN_IN_REQUIRED" },
    { ok: false, error: "INVALID_CONVERSATION_REQUEST" },
    { ok: false, error: "CONVERSATION_HTTP_ERROR", status: 503 },
    { ok: false, error: "CONVERSATION_HTTP_ERROR", status: 429 },
  ] satisfies ConversationRequestResult[]) {
    const bridge = conversationAccountBridge({
      snapshot: read,
      refresh: read,
      signIn: read,
      cancelSignIn: read,
      signOut: read,
      subscribe: () => () => {},
      request: async (...args) => {
        expect(args).toEqual(["GET", "/api/workcells"])
        return structuredClone(result)
      },
    })
    expect(await bridge.snapshot()).toEqual(state)
    if (result.ok) {
      expect(await bridge.request("GET", "/api/workcells")).toEqual(result.value)
      continue
    }
    await expect(bridge.request("GET", "/api/workcells")).rejects.toMatchObject({
      message: result.error,
      code: result.error,
      status: result.status,
    })
  }
})
