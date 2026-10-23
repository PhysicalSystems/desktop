// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes, randomUUID } from "node:crypto"
import type { WorkcellAccountState } from "./workcell-account-types"
import type { RobotModelSelection } from "./model-account-types"
import { createDesktopAuthCallback } from "./desktop-auth-callback"
import { validateRoomRequest } from "./workcell-account"

export const DESKTOP_ACCOUNT_SCOPE = "models:read workcells:read workcells:write"
type Identity = NonNullable<WorkcellAccountState["account"]>
type Session = {
  token: string
  sessionId: string
  account: Identity
  expiresAt: string
  refreshToken: string
  refreshExpiresAt: string
  sessionExpiresAt: string
}
type Exchange = {
  kind: "exchange"
  code: string
  verifier: string
  redirectUri: string
  requestId: string
  refreshToken: string
}
type Rotation = { kind: "refresh"; refreshToken: string; requestId: string; nextRefreshToken: string }
type Preferences = { accountId: string; companyId: string | null; selection: RobotModelSelection | null }
type Journal = { version: 1; managed: true; session?: Session; pending?: Exchange | Rotation; models?: Preferences }
type Input = {
  store: {
    available(): boolean
    managed(): Promise<boolean>
    markManaged(): Promise<void>
    get(): Promise<unknown>
    set(value: Journal): Promise<void>
    clear(): Promise<void>
  }
  openBrowser(url: string): Promise<boolean>
  changed?(state: WorkcellAccountState): void
  fetch?: typeof fetch
}

/** Native credential owner shared by bounded model and workcell views. */
export function createDesktopAccount(input: Input) {
  let journal: Journal | undefined
  let loaded = false
  let epoch = 0
  let disposed = false
  let controller = new AbortController()
  let persistence = Promise.resolve()
  let refreshing: Promise<WorkcellAccountState> | undefined
  let signing: Promise<void> | undefined
  const listeners = new Set<(state: WorkcellAccountState) => void>()
  const state: WorkcellAccountState = {
    revision: 0,
    sessionId: null,
    status: "signed_out",
    account: null,
    pending: null,
    error: null,
  }
  const snapshot = () => ({
    ...structuredClone(state),
    syncEnabled: journal?.managed === true && state.status === "signed_in",
  })
  const active = (ticket: number) => !disposed && epoch === ticket
  const publish = () => {
    state.revision++
    if (!disposed) {
      input.changed?.(snapshot())
      for (const listener of listeners) listener(snapshot())
    }
    return snapshot()
  }
  const begin = () => {
    epoch++
    controller.abort()
    controller = new AbortController()
    refreshing = undefined
    return epoch
  }
  async function save(value: Journal | ((previous: Journal) => Journal), ticket: number) {
    const task = persistence
      .catch(() => {})
      .then(async () => {
        if (!active(ticket)) throw new Error("WORKCELL_SESSION_CHANGED")
        if (!input.store.available()) throw new Error("SECURE_STORE_UNAVAILABLE")
        const next = typeof value === "function" ? value(journal!) : value
        await input.store.set(next)
        if (!active(ticket)) throw new Error("WORKCELL_SESSION_CHANGED")
        journal = next
        loaded = true
      })
    persistence = task
    return task
  }
  async function restore(ticket: number) {
    if (loaded) return
    const managed = await input.store.managed().catch(() => {
      // Unknown ownership must never revive an older scoped account.
      if (active(ticket)) journal = { version: 1, managed: true }
      throw new Error("SECURE_STORE_UNAVAILABLE")
    })
    if (!active(ticket)) throw new Error("WORKCELL_SESSION_CHANGED")
    if (managed) journal = { version: 1, managed: true }
    if (!input.store.available()) throw new Error("SECURE_STORE_UNAVAILABLE")
    const value = await input.store.get()
    if (!active(ticket)) throw new Error("WORKCELL_SESSION_CHANGED")
    journal =
      value === null || value === undefined ? (managed ? { version: 1, managed: true } : undefined) : readJournal(value)
    loaded = true
  }
  async function clear(ticket: number) {
    const work = persistence
      .catch(() => {})
      .then(async () => {
        if (!active(ticket)) throw new Error("WORKCELL_SESSION_CHANGED")
        await input.store.markManaged()
        await input.store.clear()
        if (!active(ticket)) throw new Error("WORKCELL_SESSION_CHANGED")
        journal = { version: 1, managed: true }
        loaded = true
      })
    persistence = work
    return work
  }
  async function http(
    path: string,
    options: { method?: string; body?: unknown; token?: string; signal?: AbortSignal } = {},
  ) {
    const response = await (input.fetch ?? fetch)(`https://physicalsystems.ai${path}`, {
      method: options.method ?? (options.body ? "POST" : "GET"),
      credentials: "omit",
      redirect: "error",
      signal: options.signal ?? AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      headers: {
        "Content-Type": "application/json",
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    })
    if (!response.ok) {
      if (response.status === 409 && path.startsWith("/api/desktop-auth/")) throw new Error("ACCESS_REVOKED")
      if (response.status === 404 && path.startsWith("/api/workcells/")) throw new Error("WORKCELL_ACCESS_REVOKED")
      if (response.status === 403 && options.method === "PATCH") throw new Error("WORKCELL_READ_ONLY")
      if (response.status === 409) {
        const failure = (await response.json().catch(() => ({}))) as { code?: string }
        if (failure.code === "metadata_conflict") throw new Error("METADATA_CONFLICT")
        if (failure.code === "idempotency_conflict")
          throw Object.assign(new Error("IDEMPOTENCY_CONFLICT"), { status: 409 })
      }
      const code =
        response.status === 401 || (path.startsWith("/api/desktop-auth/") && [403, 410].includes(response.status))
          ? "ACCESS_REVOKED"
          : "WORKCELL_HTTP_ERROR"
      throw Object.assign(new Error(code), { status: response.status })
    }
    if (response.status === 204) return {}
    const reader = response.body?.getReader()
    if (!reader) throw new Error("INVALID_RESPONSE")
    const decoder = new TextDecoder()
    let bytes = 0,
      text = ""
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        bytes += part.value.byteLength
        if (bytes > 2_000_000) throw new Error("INVALID_RESPONSE")
        text += decoder.decode(part.value, { stream: true })
      }
      return record(JSON.parse(text + decoder.decode()))
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
  async function revoke(previous: Journal | undefined) {
    if (!previous) return
    // Cleanup owns only the captured identity. A new sign-in must not cancel it
    // or let its response restore credentials after the local logout.
    const signal = AbortSignal.timeout(15000)
    let token = previous.session?.token
    if (previous.pending) {
      const { kind, ...body } = previous.pending
      await (async () => {
        const response = await http(`/api/desktop-auth/${kind === "exchange" ? "browser/exchange" : "refresh"}`, {
          body,
          signal,
        })
        const session = readSession(
          response,
          kind === "exchange" ? previous.pending!.refreshToken : (previous.pending as Rotation).nextRefreshToken,
        )
        if (
          kind === "refresh" &&
          (session.sessionId !== previous.session?.sessionId || session.account.id !== previous.session.account.id)
        )
          throw new Error("INVALID_RESPONSE")
        token = session.token
      })().catch(() => {})
    }
    if (token) await http("/api/desktop-auth/session", { method: "DELETE", token, signal }).catch(() => {})
  }
  async function fail(error: unknown, ticket: number) {
    if (!active(ticket)) return snapshot()
    const code = error instanceof Error ? error.message : "UNAVAILABLE"
    if (["ACCESS_REVOKED", "INVALID_RESPONSE"].includes(code) && journal) {
      await clear(ticket).catch(() => {})
      if (!active(ticket)) return snapshot()
      // A bad response can never leave its session available to requests.
      journal = { version: 1, managed: true }
      begin()
    }
    state.status = journal?.session ? "unavailable" : "signed_out"
    state.account = null
    state.sessionId = null
    state.pending = null
    state.error = ["SECURE_STORE_UNAVAILABLE", "ACCESS_REVOKED", "INVALID_RESPONSE", "BROWSER_UNAVAILABLE"].includes(
      code,
    )
      ? code
      : "UNAVAILABLE"
    return publish()
  }
  function showSession() {
    if (!journal?.session) return publish()
    state.account = journal.session.account
    state.sessionId = journal.session.sessionId
    state.status = "signed_in"
    state.pending = null
    state.error = null
    return publish()
  }
  async function complete(ticket: number) {
    const pending = journal?.pending
    if (!pending) return
    const { kind, ...body } = pending
    const result = await http(`/api/desktop-auth/${kind === "exchange" ? "browser/exchange" : "refresh"}`, { body })
    if (!active(ticket)) throw new Error("WORKCELL_SESSION_CHANGED")
    const session = readSession(result, kind === "exchange" ? pending.refreshToken : pending.nextRefreshToken)
    if (
      kind === "refresh" &&
      (session.sessionId !== journal?.session?.sessionId || session.account.id !== journal.session.account.id)
    )
      throw new Error("INVALID_RESPONSE")
    await save(
      {
        version: 1,
        managed: true,
        session,
        ...(journal?.models?.accountId === session.account.id ? { models: journal.models } : {}),
      },
      ticket,
    )
  }
  async function renew(ticket: number) {
    if (!journal?.session) throw new Error("ACCESS_REVOKED")
    if (
      Date.parse(journal.session.refreshExpiresAt) <= Date.now() ||
      Date.parse(journal.session.sessionExpiresAt) <= Date.now()
    )
      throw new Error("ACCESS_REVOKED")
    if (!journal.pending)
      await save(
        {
          ...journal,
          pending: {
            kind: "refresh",
            refreshToken: journal.session.refreshToken,
            requestId: randomUUID(),
            nextRefreshToken: randomBytes(32).toString("base64url"),
          },
        },
        ticket,
      )
    await complete(ticket)
  }
  async function refresh() {
    if (refreshing) return refreshing
    if (signing || state.status === "signing_in" || disposed) return snapshot()
    const ticket = epoch
    const operation = (async () => {
      try {
        await restore(ticket)
        if (!journal) return snapshot()
        if (journal.pending) await complete(ticket)
        if (!journal.session) return publish()
        if (Date.parse(journal.session.expiresAt) <= Date.now() + 60000) await renew(ticket)
        const result = await http("/api/desktop-auth/account", { token: journal.session!.token })
        const remote = record(result.session)
        if (
          remote.id !== journal.session!.sessionId ||
          remote.scope !== DESKTOP_ACCOUNT_SCOPE ||
          record(result.account).id !== journal.session!.account.id
        )
          throw new Error("INVALID_RESPONSE")
        if (!active(ticket)) return snapshot()
        return showSession()
      } catch (error) {
        return fail(error, ticket)
      }
    })()
    refreshing = operation
    void operation.finally(() => {
      if (refreshing === operation) refreshing = undefined
    })
    return operation
  }
  async function signIn() {
    const ticket = begin()
    signing = undefined
    journal = { version: 1, managed: true }
    state.status = "signing_in"
    state.account = null
    state.sessionId = null
    state.pending = null
    state.error = null
    publish()
    try {
      await input.store.markManaged()
      if (!active(ticket)) return snapshot()
      await save(journal, ticket)
      const verifier = randomBytes(32).toString("base64url"),
        authState = randomBytes(32).toString("base64url")
      const callback = await createDesktopAuthCallback(
        authState,
        AbortSignal.any([controller.signal, AbortSignal.timeout(600000)]),
      )
      try {
        const result = await http("/api/desktop-auth/browser/start", {
          body: {
            challenge: createHash("sha256").update(verifier).digest("base64url"),
            state: authState,
            redirectUri: callback.redirectUri,
            label: "Physical Systems desktop",
          },
        })
        if (!active(ticket)) {
          callback.close()
          return snapshot()
        }
        if (
          typeof result.authorizationId !== "string" ||
          !uuid.test(result.authorizationId) ||
          result.authorizationUrl !== `https://physicalsystems.ai/desktop/sign-in?request=${result.authorizationId}` ||
          !future(result.expiresAt)
        )
          throw new Error("INVALID_RESPONSE")
        state.pending = {
          verificationUrl: result.authorizationUrl,
          expiresAt: String(result.expiresAt),
          browserOpened: false,
        }
        publish()
        const opened = await input.openBrowser(result.authorizationUrl).catch(() => false)
        if (!active(ticket)) {
          callback.close()
          return snapshot()
        }
        state.pending = { ...state.pending!, browserOpened: opened }
        state.error = opened ? null : "BROWSER_UNAVAILABLE"
        signing = callback.code
          .then(async (code) => {
            if (!active(ticket)) return
            await save(
              {
                version: 1,
                managed: true,
                pending: {
                  kind: "exchange",
                  code,
                  verifier,
                  redirectUri: callback.redirectUri,
                  requestId: randomUUID(),
                  refreshToken: randomBytes(32).toString("base64url"),
                },
              },
              ticket,
            )
            await complete(ticket)
            if (active(ticket)) {
              signing = undefined
              showSession()
            }
          })
          .catch((error) => fail(error, ticket))
          .then(() => {})
          .finally(() => {
            callback.close()
            if (active(ticket)) signing = undefined
          })
        return publish()
      } catch (error) {
        callback.close()
        throw error
      }
    } catch (error) {
      return fail(error, ticket)
    }
  }
  async function signOut() {
    const previous = journal && structuredClone(journal)
    const ticket = begin()
    signing = undefined
    state.status = "signed_out"
    state.account = null
    state.sessionId = null
    state.pending = null
    state.error = null
    journal = { version: 1, managed: true }
    publish()
    await clear(ticket).catch(() => {
      if (active(ticket)) state.error = "SECURE_STORE_UNAVAILABLE"
    })
    await revoke(previous)
    return active(ticket) ? publish() : snapshot()
  }
  async function request(method: unknown, path: unknown, body?: unknown) {
    const model =
      method === "GET" &&
      body === undefined &&
      typeof path === "string" &&
      /^\/api\/model-delivery\/(?:desktop\/account|desktop\/companies(?:\/[A-Za-z0-9_-]{1,160}\/releases)?)$/.test(path)
    if (!model) validateRoomRequest(method, path, body)
    const ticket = epoch
    if (
      !loaded ||
      journal?.pending ||
      (journal?.session && Date.parse(journal.session.expiresAt) <= Date.now() + 60000)
    )
      await refresh()
    if (!active(ticket)) throw new Error("WORKCELL_SESSION_CHANGED")
    if (!journal?.session || state.status !== "signed_in") throw new Error("WORKCELL_SIGN_IN_REQUIRED")
    try {
      const value = await http(path as string, { method: method as string, body, token: journal.session.token })
      if (!active(ticket)) throw new Error("WORKCELL_SESSION_CHANGED")
      return value
    } catch (error) {
      if (error instanceof Error && error.message === "ACCESS_REVOKED") await fail(error, ticket)
      throw error
    }
  }
  const maintenance = setInterval(() => {
    if ((journal?.session || journal?.pending) && !signing) void refresh()
  }, 30000)
  maintenance.unref?.()
  return {
    snapshot,
    refresh,
    signIn,
    signOut,
    cancelSignIn: signOut,
    request,
    managed: () => journal?.managed === true,
    generation: () => epoch,
    credential: () => journal?.session && structuredClone(journal.session),
    preferences: () => journal?.models && structuredClone(journal.models),
    async savePreferences(value: Preferences) {
      if (!journal?.session || journal.session.account.id !== value.accountId)
        throw new Error("WORKCELL_SESSION_CHANGED")
      await save((previous) => {
        if (previous.session?.account.id !== value.accountId) throw new Error("WORKCELL_SESSION_CHANGED")
        return { ...previous, models: structuredClone(value) }
      }, epoch)
    },
    subscribe(listener: (state: WorkcellAccountState) => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      disposed = true
      begin()
      clearInterval(maintenance)
      journal = undefined
      listeners.clear()
    },
  }
}
export type DesktopAccount = ReturnType<typeof createDesktopAccount>
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_RESPONSE")
  return value as Record<string, unknown>
}
function future(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.now()
}
function readSession(value: unknown, refreshToken: string, expired = false): Session {
  const item = record(value),
    account = record(item.account)
  const date = (value: unknown): value is string =>
    typeof value === "string" && Number.isFinite(Date.parse(value)) && (expired || Date.parse(value) > Date.now())
  if (
    item.scope !== DESKTOP_ACCOUNT_SCOPE ||
    typeof item.token !== "string" ||
    !/^ps_desktop_account_[A-Za-z0-9_-]{43}$/.test(item.token) ||
    typeof item.sessionId !== "string" ||
    !uuid.test(item.sessionId) ||
    !date(item.expiresAt) ||
    !date(item.refreshExpiresAt) ||
    !date(item.sessionExpiresAt) ||
    typeof account.id !== "string" ||
    !account.id ||
    account.id.length > 200 ||
    typeof account.name !== "string" ||
    account.name.length > 500 ||
    typeof account.email !== "string" ||
    account.email.length > 320 ||
    !/^[A-Za-z0-9_-]{43}$/.test(refreshToken)
  )
    throw new Error("INVALID_RESPONSE")
  return {
    token: item.token,
    sessionId: item.sessionId,
    account: { id: account.id, name: account.name, email: account.email },
    expiresAt: item.expiresAt,
    refreshExpiresAt: item.refreshExpiresAt,
    sessionExpiresAt: item.sessionExpiresAt,
    refreshToken,
  }
}
function readJournal(value: unknown): Journal {
  const item = record(value)
  if (
    item.version !== 1 ||
    item.managed !== true ||
    Object.keys(item).some((key) => !["version", "managed", "session", "pending", "models"].includes(key))
  )
    throw new Error("INVALID_RESPONSE")
  if (item.session) {
    const session = record(item.session)
    // Expired access is expected after sleep; renewal owns the time check.
    readSession({ ...session, scope: DESKTOP_ACCOUNT_SCOPE }, String(session.refreshToken), true)
  }
  if (item.pending) {
    const pending = record(item.pending)
    if (!uuid.test(String(pending.requestId)) || !/^[A-Za-z0-9_-]{43}$/.test(String(pending.refreshToken)))
      throw new Error("INVALID_RESPONSE")
    if (pending.kind === "refresh") {
      if (
        Object.keys(pending).some((key) => !["kind", "refreshToken", "requestId", "nextRefreshToken"].includes(key)) ||
        !item.session ||
        !/^[A-Za-z0-9_-]{43}$/.test(String(pending.nextRefreshToken)) ||
        pending.refreshToken !== record(item.session).refreshToken
      )
        throw new Error("INVALID_RESPONSE")
    } else if (pending.kind === "exchange") {
      if (
        Object.keys(pending).some(
          (key) => !["kind", "code", "verifier", "redirectUri", "requestId", "refreshToken"].includes(key),
        ) ||
        item.session ||
        !/^[A-Za-z0-9_-]{43}$/.test(String(pending.code)) ||
        !/^[A-Za-z0-9_-]{43,128}$/.test(String(pending.verifier)) ||
        !/^http:\/\/127\.0\.0\.1:\d{1,5}\/physicalsystems\/auth\/[A-Za-z0-9_-]{43}$/.test(String(pending.redirectUri))
      )
        throw new Error("INVALID_RESPONSE")
    } else throw new Error("INVALID_RESPONSE")
  }
  if (item.models) {
    const models = record(item.models)
    if (
      typeof models.accountId !== "string" ||
      !item.session ||
      models.accountId !== record(record(item.session).account).id ||
      (models.companyId !== null &&
        (typeof models.companyId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(models.companyId))) ||
      Object.keys(models).some((key) => !["accountId", "companyId", "selection"].includes(key))
    )
      throw new Error("INVALID_RESPONSE")
    if (models.selection !== null) {
      const selection = record(models.selection)
      const company = selection.kind === "company"
      if (
        !["company", "generic"].includes(String(selection.kind)) ||
        Object.keys(selection).some(
          (key) =>
            !(company ? ["kind", "companyId", "releaseId", "manifestSha256"] : ["kind", "id", "revision"]).includes(
              key,
            ),
        ) ||
        !(company
          ? typeof selection.companyId === "string" &&
            typeof selection.releaseId === "string" &&
            /^[a-f0-9]{64}$/.test(String(selection.manifestSha256))
          : typeof selection.id === "string" && /^[a-f0-9]{40}$/.test(String(selection.revision)))
      )
        throw new Error("INVALID_RESPONSE")
    }
  }
  return item as Journal
}
