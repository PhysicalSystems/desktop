import { expect, test } from "bun:test"
import { workcellAccountBridge } from "./workcell-account"
import type { WorkcellRequestResult } from "./workcell-account"

test("workcell IPC replies preserve definitive and uncertain message errors after context serialization", async () => {
  const state = {
    revision: 1,
    sessionId: "public-grant-id",
    status: "signed_in" as const,
    account: { id: "a", name: "Operator", email: "a@example.invalid" },
    pending: null,
    error: null,
  }
  const read = async () => state
  for (const result of [
    { ok: true, value: { accepted: true, message: { id: "saved-message" } } },
    { ok: false, error: "WORKCELL_SIGN_IN_REQUIRED" },
    { ok: false, error: "WORKCELL_ACCESS_REVOKED" },
    { ok: false, error: "WORKCELL_HTTP_ERROR", status: 400 },
    { ok: false, error: "IDEMPOTENCY_CONFLICT", status: 409 },
    { ok: false, error: "WORKCELL_HTTP_ERROR", status: 408 },
    { ok: false, error: "WORKCELL_HTTP_ERROR", status: 503 },
    { ok: false, error: "WORKCELL_HTTP_ERROR", status: 429 },
  ] satisfies WorkcellRequestResult[]) {
    const bridge = workcellAccountBridge({
      snapshot: read,
      refresh: read,
      signIn: read,
      cancelSignIn: read,
      signOut: read,
      subscribe: () => () => {},
      request: async (...args) => {
        expect(args).toEqual([
          "POST",
          "/api/workcells/a/conversations/b/messages",
          { requestId: "request-1", content: "Note" },
        ])
        return JSON.parse(JSON.stringify(result))
      },
    })
    expect(await bridge.snapshot()).toEqual(state)
    const request = bridge.request("POST", "/api/workcells/a/conversations/b/messages", {
      requestId: "request-1",
      content: "Note",
    })
    if (result.ok) {
      expect(await request).toEqual(result.value)
      continue
    }
    await expect(request).rejects.toMatchObject({ message: result.error, code: result.error, status: result.status })
  }
})
