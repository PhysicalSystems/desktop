// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test"
import { createWorkcellAccount, validateRoomRequest, workcellRequestFailure, WORKCELL_SCOPE } from "./workcell-account"
const close: (() => void)[] = []
afterEach(() => {
  for (const item of close.splice(0)) item()
})
const account = { id: "a", name: "Operator", email: "operator@example.invalid" }
const token = `ps_workcell_account_${"A".repeat(43)}`
const expiresAt = "2099-01-01T00:00:00Z"
function fixture() {
  const control = {
    stored: undefined as unknown,
    scope: WORKCELL_SCOPE,
    token,
    revoked: false,
    opened: [] as string[],
    paths: [] as string[],
    pending: false,
    badPath: false,
    available: true,
    missing: false,
    slow: undefined as Promise<Response> | undefined,
    metadataError: undefined as { status: number; code: string } | undefined,
  }
  const client = createWorkcellAccount({
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
          verificationPath: control.badPath ? "https://evil.test/" : "/workcells/connect?code=ABCDEF1234567890",
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
      if (path.endsWith("/slow") && control.slow) return control.slow
      if (control.missing) return new Response("", { status: 404 })
      if (control.metadataError)
        return Response.json({ code: control.metadataError.code }, { status: control.metadataError.status })
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
test("independent workcell consent persists its token only in the native store", async () => {
  const { client, control } = fixture()
  await client.signIn()
  await until(() => client.snapshot().status === "signed_in")
  expect(control.opened).toEqual(["https://physicalsystems.ai/workcells/connect?code=ABCDEF1234567890"])
  expect(JSON.stringify(client.snapshot())).not.toContain(token)
  expect(client.snapshot().sessionId).toBe("s")
  expect(JSON.stringify(control.stored)).toContain(token)
  expect(await client.request("GET", "/api/workcells")).toEqual({ workcells: [], accepted: true })
  await client.signOut()
  expect(client.snapshot().sessionId).toBeNull()
  expect(control.stored).toBeUndefined()
  await expect(client.request("GET", "/api/workcells")).rejects.toThrow("WORKCELL_SIGN_IN_REQUIRED")
})

test("workcell grant carries bounded saved conversations and messages without AI or execution access", async () => {
  const { client, control } = fixture()
  await client.signIn()
  await until(() => client.snapshot().status === "signed_in")
  const conversation = "/api/workcells/room-a/conversations/chat-a"
  for (const path of [
    "/api/workcells/room-a/conversations?limit=100",
    "/api/workcells/room-a/conversations?cursor=room_cursor-2&limit=100",
    conversation,
    `${conversation}/events?after=1&limit=100`,
    `${conversation}/messages?before=50&limit=100`,
  ])
    expect(await client.request("GET", path)).toMatchObject({ accepted: true })
  await client.request("POST", "/api/workcells/room-a/conversations", {
    requestId: "request-1",
    title: "Private questions",
    visibility: "private",
  })
  await client.request("POST", `${conversation}/messages`, { requestId: "request-2", content: "Desktop note" })
  const count = control.paths.length
  for (const path of [
    `${conversation}/runtime`,
    `${conversation}/prompts`,
    `${conversation}/abort`,
    `${conversation}/messages?before=0&limit=100`,
    `${conversation}/messages?before=1&limit=101`,
    "/api/workcells/room-a/conversations?limit=201",
    "/api/workcells/room-a/conversations?cursor=x&limit=100&token=secret",
  ])
    await expect(client.request("GET", path)).rejects.toThrow("INVALID_WORKCELL_REQUEST")
  await expect(
    client.request("POST", `${conversation}/messages`, {
      requestId: "request-3",
      content: "Start robot",
      execute: true,
    }),
  ).rejects.toThrow("INVALID_WORKCELL_REQUEST")
  expect(control.paths).toHaveLength(count)
})

test("saved message HTTP failures retain their retry status in the bounded native reply", async () => {
  const { client, control } = fixture()
  await client.signIn()
  await until(() => client.snapshot().status === "signed_in")
  for (const status of [400, 408, 409, 429, 503]) {
    control.metadataError = { status, code: status === 409 ? "idempotency_conflict" : "private-server-error" }
    const reply = await client
      .request("POST", "/api/workcells/a/conversations/b/messages", { requestId: "request-1", content: "Note" })
      .then(() => undefined, workcellRequestFailure)
    expect(reply).toEqual({ ok: false, error: status === 409 ? "IDEMPOTENCY_CONFLICT" : "WORKCELL_HTTP_ERROR", status })
  }
  expect(workcellRequestFailure(new Error("private server credentials"))).toEqual({ ok: false, error: "UNAVAILABLE" })
  expect(client.snapshot().status).toBe("signed_in")
})
test("models-only grants and tokens are never accepted as workcell authorization", async () => {
  for (const change of ["scope", "token"] as const) {
    const { client, control } = fixture()
    if (change === "scope") control.scope = "models:read"
    else control.token = `ps_model_account_${"A".repeat(43)}`
    await client.signIn()
    await until(() => client.snapshot().status === "signed_out")
    expect(control.stored).toBeUndefined()
    expect(client.snapshot().error).toBe("INVALID_RESPONSE")
  }
})
test("the renderer cannot use its proxy for filesystem, auth, hardware, foreign or unbounded requests", () => {
  for (const path of [
    "https://evil.test",
    "//evil.test",
    "/api/workcells/../files",
    "/api/workcells/desktop/account",
    "/api/workcells/cell/run",
    "/api/workcells/a/events?after=0&limit=101",
    "/api/workcells/a/events?after=0&limit=10&token=x",
  ]) {
    expect(() => validateRoomRequest("GET", path)).toThrow()
  }
  expect(() => validateRoomRequest("GET", "/api/workcells/a/events?after=0&limit=100")).not.toThrow()
  expect(() =>
    validateRoomRequest("POST", "/api/workcells/a/messages", { requestId: "request-123", content: "Hello" }),
  ).not.toThrow()
  expect(() =>
    validateRoomRequest("POST", "/api/workcells/a/messages", {
      requestId: "request-123",
      content: "Hello",
      execute: true,
    }),
  ).toThrow()
  expect(() =>
    validateRoomRequest("POST", "/api/workcells/a/messages", { requestId: "request-123", content: "x".repeat(8001) }),
  ).toThrow()
})
test("revocation removes the workcell credential and cancels access", async () => {
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
  const stale = client.request("GET", "/api/workcells/slow")
  control.revoked = true
  await expect(client.request("GET", "/api/workcells")).rejects.toThrow("ACCESS_REVOKED")
  finish(Response.json({ workcell: { id: "slow" } }))
  await expect(stale).rejects.toThrow("WORKCELL_SESSION_CHANGED")
})
test("a removed room fails closed without discarding a valid account for other rooms", async () => {
  const { client, control } = fixture()
  await client.signIn()
  await until(() => client.snapshot().status === "signed_in")
  control.missing = true
  await expect(client.request("GET", "/api/workcells/missing")).rejects.toThrow("WORKCELL_ACCESS_REVOKED")
  expect(client.snapshot().status).toBe("signed_in")
})

test("native creation and metadata updates accept only the exact bounded non-executing schema", () => {
  const id = "fce739a6-cb75-4c86-b376-d4b6414f1766"
  const create = { requestId: id, name: "Workcell", task: "Sort blocks" }
  expect(() => validateRoomRequest("POST", "/api/workcells", create)).not.toThrow()
  expect(() => validateRoomRequest("PATCH", `/api/workcells/${id}`, { ...create, expectedRevision: 0 })).not.toThrow()
  for (const body of [
    { ...create, companyId: id },
    { ...create, cwd: "C:/private" },
    { ...create, connection: {} },
    { ...create, ownerUserId: "other" },
    { ...create, runtimeSessionId: "session" },
    { ...create, robot: { status: "online" } },
    { ...create, task: "" },
    { ...create, objects: "x".repeat(2001) },
  ])
    expect(() => validateRoomRequest("POST", "/api/workcells", body)).toThrow()
  for (const revision of [undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "0"])
    expect(() =>
      validateRoomRequest("PATCH", `/api/workcells/${id}`, { ...create, expectedRevision: revision }),
    ).toThrow()
  for (const path of [
    "/api/workcells/a",
    `/api/workcells/${id}/messages`,
    `/api/workcells/${id}?x=1`,
    "https://foreign.invalid",
  ])
    expect(() => validateRoomRequest("PATCH", path, { ...create, expectedRevision: 0 })).toThrow()
})

test("metadata conflicts and a read-only workcell preserve the separate native account grant", async () => {
  const { client, control } = fixture()
  await client.signIn()
  await until(() => client.snapshot().status === "signed_in")
  const id = "fce739a6-cb75-4c86-b376-d4b6414f1766"
  for (const [status, code, expected] of [
    [409, "metadata_conflict", "METADATA_CONFLICT"],
    [409, "idempotency_conflict", "IDEMPOTENCY_CONFLICT"],
    [403, "read_only", "WORKCELL_READ_ONLY"],
  ] as const) {
    control.metadataError = { status, code }
    await expect(
      client.request("PATCH", `/api/workcells/${id}`, {
        requestId: id,
        expectedRevision: 0,
        name: "Workcell",
        task: "Task",
      }),
    ).rejects.toThrow(expected)
    expect(client.snapshot().status).toBe("signed_in")
    expect(control.stored).toBeDefined()
  }
})
