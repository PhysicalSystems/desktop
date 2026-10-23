// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes } from "node:crypto"
import type { WorkcellAccountState } from "./workcell-account-types"
import { readProjectMetadata } from "./workcell-project"

export const WORKCELL_SCOPE = "workcells:read workcells:write"
type Session = {
  token: string
  sessionId: string
  expiresAt: string
  account: NonNullable<WorkcellAccountState["account"]>
}
type Input = {
  store: { available(): boolean; get(): Promise<unknown>; set(session: Session): Promise<void>; clear(): Promise<void> }
  openBrowser(url: string): Promise<boolean>
  changed(state: WorkcellAccountState): void
  fetch?: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => ReturnType<typeof fetch>
  origin?: string
  now?: () => number
  pollDelay?: number
}
/** Native-only separate consent and credential owner. Never adopts or expands a models:read grant. */
export function createWorkcellAccount(input: Input) {
  const base = new URL(input.origin ?? "https://physicalsystems.ai")
  if (
    base.origin !== "https://physicalsystems.ai" &&
    !(base.protocol === "http:" && ["localhost", "127.0.0.1"].includes(base.hostname))
  )
    throw new Error("INVALID_WORKCELL_ORIGIN")
  const state: WorkcellAccountState = {
    revision: 0,
    sessionId: null,
    status: "signed_out",
    account: null,
    pending: null,
    error: null,
  }
  const now = input.now ?? Date.now
  let session: Session | undefined
  let attempt: { deviceCode: string; verifier: string; expiresAt: string; interval: number } | undefined
  let epoch = 0
  let restored = false
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let controller = new AbortController()
  let persistence = Promise.resolve()
  const snapshot = () => structuredClone(state)
  const publish = () => {
    state.revision++
    if (!disposed) input.changed(snapshot())
    return snapshot()
  }
  const active = (ticket: number) => !disposed && ticket === epoch
  const begin = () => {
    epoch++
    controller.abort()
    controller = new AbortController()
    clearTimeout(timer)
    return epoch
  }
  const persist = (operation: () => Promise<void>) => {
    const work = persistence.catch(() => {}).then(operation)
    persistence = work
    return work
  }
  const clear = async () => {
    session = undefined
    state.sessionId = null
    state.account = null
    await persist(() => input.store.clear())
  }
  async function http(path: string, options: { method?: string; body?: unknown; token?: string } = {}) {
    const response = await (input.fetch ?? fetch)(base.origin + path, {
      method: options.method ?? (options.body ? "POST" : "GET"),
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      headers: {
        "Content-Type": "application/json",
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    })
    if (response.status === 404 && /^\/api\/workcells\/[A-Za-z0-9_-]+(?:\/|$)/.test(path))
      throw new Error("WORKCELL_ACCESS_REVOKED")
    if (response.status === 403 && options.method === "PATCH") throw new Error("WORKCELL_READ_ONLY")
    if ([401, 403, 410].includes(response.status))
      throw new Error(response.status === 410 ? "SIGN_IN_EXPIRED" : "ACCESS_REVOKED")
    if (!response.ok && response.status !== 409)
      throw Object.assign(new Error("WORKCELL_HTTP_ERROR"), { status: response.status })
    if (response.status === 204) return {}
    const reader = response.body?.getReader()
    if (!reader) throw new Error("INVALID_RESPONSE")
    let bytes = 0
    let body = ""
    const decoder = new TextDecoder()
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        bytes += part.value.byteLength
        if (bytes > 2000000) throw new Error("INVALID_RESPONSE")
        body += decoder.decode(part.value, { stream: true })
      }
      const value = record(JSON.parse(body + decoder.decode()))
      if (!response.ok) {
        if (value.code === "metadata_conflict") throw new Error("METADATA_CONFLICT")
        if (value.code === "idempotency_conflict")
          throw Object.assign(new Error("IDEMPOTENCY_CONFLICT"), { status: 409 })
        throw Object.assign(new Error("WORKCELL_HTTP_ERROR"), { status: response.status })
      }
      return value
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
  async function fail(error: unknown, ticket: number) {
    if (!active(ticket)) return snapshot()
    const code = error instanceof Error ? error.message : "UNAVAILABLE"
    state.error = ["ACCESS_REVOKED", "SIGN_IN_EXPIRED", "SECURE_STORE_UNAVAILABLE", "INVALID_RESPONSE"].includes(code)
      ? code
      : "UNAVAILABLE"
    state.pending = null
    attempt = undefined
    const revoked = ["ACCESS_REVOKED", "SIGN_IN_EXPIRED", "INVALID_RESPONSE"].includes(code)
    if (revoked) await clear().catch(() => {})
    if (!active(ticket)) return snapshot()
    if (revoked) begin() // Invalidate other responses from the credential just removed.
    state.status = session ? "unavailable" : "signed_out"
    return publish()
  }
  async function refresh() {
    const ticket = begin()
    try {
      if (!input.store.available()) throw new Error("SECURE_STORE_UNAVAILABLE")
      if (!restored) {
        const stored = await input.store.get()
        if (!active(ticket)) return snapshot()
        restored = true
        if (stored) session = readSession(stored)
      }
      if (!session) {
        state.status = "signed_out"
        state.error = null
        return publish()
      }
      if (Date.parse(session.expiresAt) <= now()) throw new Error("ACCESS_REVOKED")
      const identity = await http("/api/workcells/desktop/account", { token: session.token })
      const remote = record(identity.session)
      if (
        remote.scope !== WORKCELL_SCOPE ||
        remote.id !== session.sessionId ||
        record(identity.account).id !== session.account.id ||
        !Number.isFinite(Date.parse(String(remote.expiresAt))) ||
        Date.parse(String(remote.expiresAt)) <= now()
      )
        throw new Error("ACCESS_REVOKED")
      if (!active(ticket)) return snapshot()
      state.account = session.account
      state.sessionId = session.sessionId
      state.status = "signed_in"
      state.error = null
      state.pending = null
      return publish()
    } catch (error) {
      return fail(error, ticket)
    }
  }
  async function poll(ticket: number) {
    if (!active(ticket) || !attempt) return
    try {
      if (Date.parse(attempt.expiresAt) <= now()) throw new Error("SIGN_IN_EXPIRED")
      const value = await http("/api/workcells/desktop-auth/poll", {
        body: { deviceCode: attempt.deviceCode, verifier: attempt.verifier },
      })
      if (!active(ticket)) return
      if (value.pending === true) {
        timer = setTimeout(() => void poll(ticket), attempt.interval)
        timer.unref?.()
        return
      }
      if (value.scope !== WORKCELL_SCOPE) throw new Error("INVALID_RESPONSE")
      const next = readSession(value)
      if (Date.parse(next.expiresAt) <= now()) throw new Error("SIGN_IN_EXPIRED")
      await persist(async () => {
        if (active(ticket)) await input.store.set(next)
      })
      if (!active(ticket)) return
      session = next
      restored = true
      attempt = undefined
      state.pending = null
      await refresh()
    } catch (error) {
      await fail(error, ticket)
    }
  }
  async function signIn() {
    const ticket = begin()
    state.error = null
    state.pending = null
    state.account = null
    state.sessionId = null
    attempt = undefined
    if (!input.store.available()) return fail(new Error("SECURE_STORE_UNAVAILABLE"), ticket)
    state.status = "signing_in"
    publish()
    try {
      const verifier = randomBytes(32).toString("base64url")
      const value = await http("/api/workcells/desktop-auth/start", {
        body: {
          challenge: createHash("sha256").update(verifier).digest("base64url"),
          label: "Physical Systems workcell rooms",
        },
      })
      if (!active(ticket)) return snapshot()
      if (
        !/^[A-F0-9]{16}$/.test(String(value.userCode)) ||
        value.verificationPath !== `/workcells/connect?code=${value.userCode}` ||
        !Number.isFinite(Date.parse(String(value.expiresAt))) ||
        Date.parse(String(value.expiresAt)) <= now() ||
        typeof value.intervalSeconds !== "number" ||
        value.intervalSeconds < 1 ||
        value.intervalSeconds > 60 ||
        typeof value.deviceCode !== "string"
      )
        throw new Error("INVALID_RESPONSE")
      attempt = {
        deviceCode: value.deviceCode,
        verifier,
        expiresAt: String(value.expiresAt),
        interval: input.pollDelay ?? value.intervalSeconds * 1000,
      }
      const pending = {
        userCode: String(value.userCode),
        verificationUrl: base.origin + value.verificationPath,
        expiresAt: attempt.expiresAt,
        browserOpened: false,
      }
      state.pending = pending
      publish()
      const opened = await input.openBrowser(pending.verificationUrl).catch(() => false)
      if (!active(ticket)) return snapshot()
      state.pending = { ...pending, browserOpened: opened }
      timer = setTimeout(() => void poll(ticket), attempt.interval)
      timer.unref?.()
      return publish()
    } catch (error) {
      return fail(error, ticket)
    }
  }
  async function cancelSignIn() {
    const previous = attempt
    const ticket = begin()
    attempt = undefined
    state.pending = null
    if (previous)
      await http("/api/workcells/desktop-auth/cancel", {
        body: { deviceCode: previous.deviceCode, verifier: previous.verifier },
      }).catch(() => {})
    return active(ticket) ? refresh() : snapshot()
  }
  async function signOut() {
    const previous = session
    const ticket = begin()
    attempt = undefined
    restored = true
    state.pending = null
    const clearing = clear()
    state.status = "signed_out"
    state.error = null
    publish()
    if (previous)
      await http("/api/workcells/desktop/session", { method: "DELETE", token: previous.token }).catch(() => {})
    await clearing.catch(() => {
      if (active(ticket)) state.error = "SECURE_STORE_UNAVAILABLE"
    })
    return active(ticket) ? publish() : snapshot()
  }
  async function request(method: unknown, path: unknown, body?: unknown) {
    validateRoomRequest(method, path, body)
    if (!session || state.status !== "signed_in") throw new Error("WORKCELL_SIGN_IN_REQUIRED")
    if (Date.parse(session.expiresAt) <= now()) {
      await fail(new Error("ACCESS_REVOKED"), epoch)
      throw new Error("WORKCELL_SIGN_IN_REQUIRED")
    }
    const ticket = epoch
    const result = await http(path as string, { method: method as string, body, token: session.token }).catch(
      async (error) => {
        if (error instanceof Error && error.message === "ACCESS_REVOKED") await fail(error, ticket)
        throw error
      },
    )
    if (!active(ticket)) throw new Error("WORKCELL_SESSION_CHANGED")
    return result
  }
  return {
    snapshot,
    generation: () => epoch,
    refresh,
    signIn,
    cancelSignIn,
    signOut,
    request,
    dispose() {
      disposed = true
      begin()
      session = undefined
      attempt = undefined
    },
  }
}
/** Preserve known retry/access semantics across Electron without returning remote error text. */
export function workcellRequestFailure(error: unknown) {
  const message = error instanceof Error ? error.message : "UNAVAILABLE"
  const code = [
    "WORKCELL_HTTP_ERROR",
    "WORKCELL_ACCESS_REVOKED",
    "WORKCELL_SIGN_IN_REQUIRED",
    "WORKCELL_SESSION_CHANGED",
    "ACCESS_REVOKED",
    "SIGN_IN_EXPIRED",
    "INVALID_WORKCELL_REQUEST",
    "WORKCELL_READ_ONLY",
    "METADATA_CONFLICT",
    "IDEMPOTENCY_CONFLICT",
  ].includes(message)
    ? message
    : "UNAVAILABLE"
  const status =
    error instanceof Error &&
    "status" in error &&
    typeof error.status === "number" &&
    Number.isInteger(error.status) &&
    error.status >= 400 &&
    error.status <= 599
      ? error.status
      : undefined
  return { ok: false as const, error: code, ...(status !== undefined ? { status } : {}) }
}

export function validateRoomRequest(method: unknown, path: unknown, body?: unknown) {
  if (typeof path !== "string" || path.length > 1200) throw new Error("INVALID_WORKCELL_REQUEST")
  const conversation = /^\/api\/workcells\/[A-Za-z0-9_-]{1,160}\/conversations(?:\/[A-Za-z0-9_-]{1,160})?$/
  if (
    method === "GET" &&
    body === undefined &&
    (conversation.test(path) ||
      /^\/api\/workcells\/[A-Za-z0-9_-]{1,160}\/conversations\?(?:cursor=[A-Za-z0-9_-]{1,512}&)?limit=(?:[1-9]\d?|1\d\d|200)$/.test(
        path,
      ) ||
      /^\/api\/workcells\/[A-Za-z0-9_-]{1,160}\/conversations\/[A-Za-z0-9_-]{1,160}\/events\?after=\d{1,15}&limit=(?:[1-9]\d?|100)$/.test(
        path,
      ) ||
      /^\/api\/workcells\/[A-Za-z0-9_-]{1,160}\/conversations\/[A-Za-z0-9_-]{1,160}\/messages\?(?:before=[1-9]\d{0,14}&)?limit=(?:[1-9]\d?|100)$/.test(
        path,
      ))
  )
    return
  if (method === "POST" && /^\/api\/workcells\/[A-Za-z0-9_-]{1,160}\/conversations$/.test(path)) {
    const value = record(body)
    if (
      Object.keys(value).every((key) => ["requestId", "title", "visibility"].includes(key)) &&
      typeof value.requestId === "string" &&
      /^[A-Za-z0-9_-]{8,100}$/.test(value.requestId) &&
      typeof value.title === "string" &&
      value.title.trim().length > 0 &&
      value.title.length <= 120 &&
      ["private", "team"].includes(String(value.visibility))
    )
      return
    throw new Error("INVALID_WORKCELL_REQUEST")
  }
  if (
    method === "GET" &&
    body === undefined &&
    /^\/api\/workcells(?:\/[A-Za-z0-9_-]{1,160}(?:\/events\?after=\d{1,15}&limit=(?:[1-9]\d?|100))?)?$/.test(path)
  )
    return
  if (
    (method === "POST" && path === "/api/workcells") ||
    (method === "PATCH" &&
      /^\/api\/workcells\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(path))
  ) {
    const value = record(body)
    if (
      typeof value.requestId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.requestId)
    )
      throw new Error("INVALID_WORKCELL_REQUEST")
    const { requestId, expectedRevision, ...metadata } = value
    if (
      method === "PATCH"
        ? !Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0
        : expectedRevision !== undefined
    )
      throw new Error("INVALID_WORKCELL_REQUEST")
    readProjectMetadata(metadata)
    return
  }
  if (
    method === "POST" &&
    /^\/api\/workcells\/[A-Za-z0-9_-]{1,160}(?:\/conversations\/[A-Za-z0-9_-]{1,160})?\/messages$/.test(path)
  ) {
    const value = record(body)
    if (
      Object.keys(value).every((key) => ["requestId", "content"].includes(key)) &&
      typeof value.requestId === "string" &&
      /^[A-Za-z0-9_-]{8,100}$/.test(value.requestId) &&
      typeof value.content === "string" &&
      value.content.trim().length > 0 &&
      value.content.length <= 8000
    )
      return
  }
  throw new Error("INVALID_WORKCELL_REQUEST")
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_RESPONSE")
  return value as Record<string, unknown>
}
function readSession(value: unknown): Session {
  const data = record(value)
  const account = record(data.account)
  if (
    typeof data.token !== "string" ||
    !/^ps_workcell_account_[A-Za-z0-9_-]{43}$/.test(data.token) ||
    typeof data.sessionId !== "string" ||
    !data.sessionId ||
    typeof data.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(data.expiresAt)) ||
    typeof account.id !== "string" ||
    typeof account.name !== "string" ||
    typeof account.email !== "string"
  )
    throw new Error("INVALID_RESPONSE")
  return {
    token: data.token,
    sessionId: data.sessionId,
    expiresAt: data.expiresAt,
    account: { id: account.id, name: account.name, email: account.email },
  }
}
