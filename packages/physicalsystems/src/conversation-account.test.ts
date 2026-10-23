// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test"
import {
  createConversationAccount,
  validateConversationRequest,
  conversationRequestFailure,
  CONVERSATION_SCOPE,
} from "./conversation-account"
import { validateRoomRequest } from "./workcell-account"
const roomId = "11111111-1111-4111-8111-111111111111"
const conversationId = "22222222-2222-4222-8222-222222222222"
const conversationPath = `/api/workcells/${roomId}/conversations/${conversationId}`
const close: (() => void)[] = []
afterEach(() => {
  for (const item of close.splice(0)) item()
})
const account = { id: "a", name: "Operator", email: "operator@example.invalid" }
const token = `ps_conversation_account_${"A".repeat(43)}`
const expiresAt = "2099-01-01T00:00:00Z"
function fixture() {
  const control = {
    stored: undefined as unknown,
    scope: CONVERSATION_SCOPE,
    token,
    revoked: false,
    opened: [] as string[],
    paths: [] as string[],
    pending: false,
    badPath: false,
    available: true,
    missing: false,
    status: 200,
    responseBytes: 0,
    slow: undefined as Promise<Response> | undefined,
  }
  const client = createConversationAccount({
    store: {
      available: () => control.available,
      get: async () => control.stored,
      set: async (value) => {
        control.stored = value
      },
      clear: async () => {
        control.stored = undefined
      },
    },
    openBrowser: async (url) => {
      control.opened.push(url)
      return true
    },
    changed: () => {},
    pollDelay: 1,
    fetch: async (url, options) => {
      const path = new URL(String(url)).pathname
      control.paths.push(path)
      if (path.endsWith("/start"))
        return Response.json({
          deviceCode: "device",
          userCode: "ABCDEF1234567890",
          expiresAt,
          intervalSeconds: 1,
          verificationPath: control.badPath ? "https://evil.test/" : "/conversations/connect?code=ABCDEF1234567890",
        })
      if (path.endsWith("/poll"))
        return Response.json(
          control.pending
            ? { pending: true }
            : { token: control.token, sessionId: "s", expiresAt, account, scope: control.scope },
        )
      if (path.endsWith("/account"))
        return control.revoked
          ? new Response("", { status: 401 })
          : Response.json({ account, session: { id: "s", expiresAt, scope: control.scope } })
      if (path.endsWith("/session") || path.endsWith("/cancel")) return new Response(null, { status: 204 })
      expect(new Headers(options?.headers).get("Authorization")).toBe(`Bearer ${token}`)
      if (path.endsWith(roomId) && control.slow) return control.slow
      if (control.missing) return new Response("", { status: 404 })
      if (control.status !== 200) return new Response("", { status: control.status })
      if (control.responseBytes) return Response.json({ data: "x".repeat(control.responseBytes) })
      return control.revoked ? new Response("", { status: 403 }) : Response.json({ workcells: [], accepted: true })
    },
  })
  close.push(client.dispose)
  return { client, control }
}
async function until(condition: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error("Condition not reached")
}
test("independent cloud conversation consent persists its token only in the native store", async () => {
  const { client, control } = fixture()
  await client.signIn()
  await until(() => client.snapshot().status === "signed_in")
  expect(control.opened).toEqual(["https://physicalsystems.ai/conversations/connect?code=ABCDEF1234567890"])
  expect(JSON.stringify(client.snapshot())).not.toContain(token)
  expect(JSON.stringify(control.stored)).toContain(token)
  expect(await client.request("GET", "/api/workcells")).toEqual({ workcells: [], accepted: true })
  await client.signOut()
  expect(control.stored).toBeUndefined()
  await expect(client.request("GET", "/api/workcells")).rejects.toThrow("CONVERSATION_SIGN_IN_REQUIRED")
})
test("workcell and model grants never authorize cloud execution", async () => {
  for (const change of ["model-scope", "model-token", "workcell-scope", "workcell-token"] as const) {
    const { client, control } = fixture()
    if (change === "model-scope") control.scope = "models:read"
    if (change === "model-token") control.token = `ps_model_account_${"A".repeat(43)}`
    if (change === "workcell-scope") control.scope = "workcells:read workcells:write"
    if (change === "workcell-token") control.token = `ps_workcell_account_${"A".repeat(43)}`
    await client.signIn()
    await until(() => client.snapshot().status === "signed_out")
    expect(control.stored).toBeUndefined()
    expect(client.snapshot().error).toBe("INVALID_RESPONSE")
  }
})
test("the renderer can only address bounded cloud conversation operations", () => {
  for (const path of [
    "https://evil.test",
    "//evil.test",
    "/api/conversations/desktop/account",
    "/api/workcells/desktop/account",
    "/api/workcells/../files",
    "/api/workcells/cell/run",
    `${conversationPath}/runtime?directory=/private`,
    `${conversationPath}/runtime/`,
    `${conversationPath}/events?after=0&limit=101`,
    `${conversationPath}/events?after=0&limit=10&token=x`,
  ])
    expect(() => validateConversationRequest("GET", path)).toThrow()
  for (const path of [
    "/api/workcells",
    `/api/workcells/${roomId}`,
    `/api/workcells/${roomId}/conversations`,
    conversationPath,
    `${conversationPath}/runtime`,
    `${conversationPath}/events?after=0&limit=100`,
  ])
    expect(() => validateConversationRequest("GET", path)).not.toThrow()
  expect(() => validateConversationRequest("GET", conversationPath, {})).toThrow()
  const prompt = { requestId: crypto.randomUUID(), text: "What is the next step?" }
  expect(() => validateConversationRequest("POST", `${conversationPath}/prompts`, prompt)).not.toThrow()
  for (const extra of [
    { directory: "/tmp" },
    { agent: "build" },
    { model: "other" },
    { tools: { bash: true } },
    { sessionId: "session_other" },
  ])
    expect(() => validateConversationRequest("POST", `${conversationPath}/prompts`, { ...prompt, ...extra })).toThrow()
  expect(() =>
    validateConversationRequest("POST", `${conversationPath}/prompts`, { ...prompt, text: "x".repeat(32000) }),
  ).not.toThrow()
  for (const text of ["", "  ", "x".repeat(32001)])
    expect(() => validateConversationRequest("POST", `${conversationPath}/prompts`, { ...prompt, text })).toThrow()
  expect(() =>
    validateConversationRequest("POST", `${conversationPath}/prompts`, { ...prompt, requestId: "old-request-id" }),
  ).toThrow()
  expect(() =>
    validateConversationRequest("POST", `/api/workcells/${roomId}/messages`, {
      requestId: prompt.requestId,
      content: "Hi",
    }),
  ).toThrow()
  expect(() =>
    validateConversationRequest("POST", `${conversationPath}/messages`, { requestId: prompt.requestId, content: "Hi" }),
  ).not.toThrow()
  expect(() =>
    validateConversationRequest("POST", `${conversationPath}/messages`, {
      requestId: prompt.requestId,
      content: "x".repeat(8001),
    }),
  ).toThrow()
  const creation = { requestId: prompt.requestId, title: "Operations", visibility: "private" }
  expect(() => validateConversationRequest("POST", `/api/workcells/${roomId}/conversations`, creation)).not.toThrow()
  expect(() =>
    validateConversationRequest("POST", `/api/workcells/${roomId}/conversations`, {
      ...creation,
      visibility: "public",
    }),
  ).toThrow()
  expect(() =>
    validateConversationRequest("POST", `/api/workcells/${roomId}/conversations`, {
      ...creation,
      ownerUserId: "other",
    }),
  ).toThrow()
})
test("revocation removes the conversation credential and cancels access", async () => {
  const { client, control } = fixture()
  await client.signIn()
  await until(() => client.snapshot().status === "signed_in")
  control.revoked = true
  await expect(client.request("GET", "/api/workcells")).rejects.toThrow("ACCESS_REVOKED")
  expect(client.snapshot().status).toBe("signed_out")
  expect(control.stored).toBeUndefined()
})
test("untrusted consent destinations and an unavailable secure store fail closed", async () => {
  const { client, control } = fixture()
  control.badPath = true
  await client.signIn()
  expect(control.opened).toHaveLength(0)
  expect(client.snapshot().error).toBe("INVALID_RESPONSE")
  control.available = false
  await client.signIn()
  expect(client.snapshot().error).toBe("SECURE_STORE_UNAVAILABLE")
})
test("canceling a pending login cannot later install a credential", async () => {
  const { client, control } = fixture()
  control.pending = true
  await client.signIn()
  await client.cancelSignIn()
  control.pending = false
  await new Promise((resolve) => setTimeout(resolve, 15))
  expect(client.snapshot().status).toBe("signed_out")
  expect(control.stored).toBeUndefined()
})

test("revocation also invalidates an earlier successful response still in flight", async () => {
  const { client, control } = fixture()
  await client.signIn()
  await until(() => client.snapshot().status === "signed_in")
  let finish: (response: Response) => void = () => {}
  control.slow = new Promise((resolve) => {
    finish = resolve
  })
  const stale = client.request("GET", `/api/workcells/${roomId}`)
  control.revoked = true
  await expect(client.request("GET", "/api/workcells")).rejects.toThrow("ACCESS_REVOKED")
  finish(Response.json({ workcell: { id: "slow" } }))
  await expect(stale).rejects.toThrow("CONVERSATION_SESSION_CHANGED")
})
test("a removed room fails closed without discarding a valid account for other rooms", async () => {
  const { client, control } = fixture()
  await client.signIn()
  await until(() => client.snapshot().status === "signed_in")
  control.missing = true
  await expect(client.request("GET", `/api/workcells/${roomId}`)).rejects.toThrow("CONVERSATION_ACCESS_REVOKED")
  expect(client.snapshot().status).toBe("signed_in")
})
test("legacy workcell renderer authority cannot address cloud conversations", () => {
  expect(() => validateRoomRequest("GET", `${conversationPath}/runtime`)).toThrow()
  expect(() =>
    validateRoomRequest("POST", `${conversationPath}/prompts`, { requestId: crypto.randomUUID(), text: "Hi" }),
  ).toThrow()
})
test("the native IPC envelope preserves retry semantics without leaking server error bodies", async () => {
  const { client, control } = fixture()
  await client.signIn()
  await until(() => client.snapshot().status === "signed_in")
  for (const status of [400, 409, 408, 429, 503]) {
    control.status = status
    const result = await client
      .request("POST", `${conversationPath}/prompts`, { requestId: crypto.randomUUID(), text: "Hi" })
      .then(() => undefined, conversationRequestFailure)
    expect(result).toEqual({ ok: false, error: "CONVERSATION_HTTP_ERROR", status })
  }
  expect(conversationRequestFailure(new Error("secret remote message"))).toEqual({ ok: false, error: "UNAVAILABLE" })
  expect(client.snapshot().status).toBe("signed_in")
})
test("bounded runtime history supports the Platform snapshot size without widening account responses", async () => {
  const { client, control } = fixture()
  await client.signIn()
  await until(() => client.snapshot().status === "signed_in")
  control.responseBytes = 8000000
  expect((await client.request("GET", `${conversationPath}/runtime`)).data).toHaveLength(8000000)
  await expect(client.request("GET", `/api/workcells/${roomId}`)).rejects.toThrow("INVALID_RESPONSE")
  control.responseBytes = 9000000
  await expect(client.request("GET", `${conversationPath}/runtime`)).rejects.toThrow("INVALID_RESPONSE")
  expect(client.snapshot().status).toBe("signed_in")
})
