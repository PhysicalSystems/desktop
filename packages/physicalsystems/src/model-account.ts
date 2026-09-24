// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes } from "node:crypto"
import type {
  CompanyModelRelease,
  GenericRobotModel,
  ModelAccountError,
  ModelAccountState,
  ModelCompany,
  ModelCompatibility,
  ModelDevice,
  ModelIdentity,
  RobotModelSelection,
} from "./model-account-types"

export const MODEL_ACCOUNT_ORIGIN = "https://physicalsystems.ai"
type Account = NonNullable<ModelAccountState["account"]>
type Session = {
  token: string
  sessionId: string
  expiresAt: string
  account: Account
  companyId: string | null
  selection: RobotModelSelection | null
}
type Store = {
  available(): boolean
  get(): Promise<unknown>
  set(value: Session): Promise<void>
  clear(): Promise<void>
}
type Input = {
  store: Store
  openBrowser(url: string): Promise<boolean>
  changed(state: ModelAccountState): void
  fetch?: typeof fetch
  origin?: string
  now?: () => number
  pollDelay?: number
}
class AccountFailure extends Error {
  constructor(readonly code: ModelAccountError) {
    super(code)
  }
}

/** Main-process only. The renderer receives references and account metadata, never credentials. */
export function createModelAccount(input: Input) {
  const base = new URL(input.origin ?? MODEL_ACCOUNT_ORIGIN)
  if (
    base.origin !== MODEL_ACCOUNT_ORIGIN &&
    !(base.protocol === "http:" && ["127.0.0.1", "localhost"].includes(base.hostname))
  )
    throw new Error("INVALID_MODEL_ACCOUNT_ORIGIN")
  const now = input.now ?? Date.now
  const state: ModelAccountState = {
    revision: 0,
    status: "signed_out",
    account: null,
    companies: [],
    companyId: null,
    releases: [],
    devices: [],
    generic: [],
    selection: null,
    pending: null,
    checkedAt: null,
    error: null,
  }
  let session: Session | undefined
  let attempt: { deviceCode: string; verifier: string; expiresAt: string; interval: number } | undefined
  let epoch = 0
  let disposed = false
  let restored = false
  let polling: ReturnType<typeof setTimeout> | undefined
  let controller = new AbortController()
  let persistence = Promise.resolve()
  const snapshot = () => structuredClone(state)
  function publish() {
    state.revision++
    if (!disposed) input.changed(snapshot())
    return snapshot()
  }
  function begin() {
    epoch++
    controller.abort()
    controller = new AbortController()
    clearTimeout(polling)
    return epoch
  }
  function current(ticket: number) {
    return !disposed && ticket === epoch
  }
  function clearPrivate() {
    Object.assign(state, {
      account: null,
      companies: [],
      companyId: null,
      releases: [],
      devices: [],
      selection: null,
      checkedAt: null,
    })
  }
  function persist(operation: () => Promise<void>) {
    const result = persistence.catch(() => {}).then(operation)
    persistence = result
    return result
  }
  async function forget() {
    session = undefined
    clearPrivate()
    await persist(() => input.store.clear())
  }
  async function request(path: string, options: { body?: unknown; token?: string; method?: string } = {}) {
    const response = await (input.fetch ?? fetch)(`${base.origin}/api/model-delivery${path}`, {
      method: options.method ?? (options.body ? "POST" : "GET"),
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      headers: {
        "Content-Type": "application/json",
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    })
    if (response.status === 401) throw new AccountFailure("SESSION_EXPIRED")
    if (response.status === 403) {
      const failure = await readResponse(response)
      throw new AccountFailure(failure.code === "sign_in_denied" ? "SIGN_IN_DENIED" : "ACCESS_REVOKED")
    }
    if (response.status === 404) throw new AccountFailure("ACCESS_REVOKED")
    if (response.status === 410) throw new AccountFailure("SIGN_IN_EXPIRED")
    if (!response.ok) throw new AccountFailure("UNAVAILABLE")
    if (response.status === 204) return {}
    return readResponse(response)
  }
  async function save() {
    if (!session) return
    if (!input.store.available()) throw new AccountFailure("SECURE_STORE_UNAVAILABLE")
    const ticket = epoch
    const value = structuredClone({ ...session, companyId: state.companyId, selection: state.selection })
    await persist(async () => {
      if (current(ticket)) await input.store.set(value)
    }).catch(() => {
      throw new AccountFailure("SECURE_STORE_UNAVAILABLE")
    })
  }
  async function failed(error: unknown, ticket: number) {
    if (!current(ticket)) return snapshot()
    const code = error instanceof AccountFailure ? error.code : "UNAVAILABLE"
    if (code === "SESSION_EXPIRED") await forget().catch(() => {})
    if (!current(ticket)) return snapshot()
    if (code === "SECURE_STORE_UNAVAILABLE" && !session) restored = false
    attempt = undefined
    clearTimeout(polling)
    clearPrivate()
    state.pending = null
    state.status = session ? "unavailable" : "signed_out"
    state.error = code
    return publish()
  }
  async function loadCompany(id: string, ticket: number) {
    if (!session || !state.companies.some((item) => item.id === id)) throw new AccountFailure("ACCESS_REVOKED")
    const result = await request(`/desktop/companies/${encodeURIComponent(id)}/releases`, { token: session.token })
    const company = readCompany(result.company)
    if (company.id !== id) throw new AccountFailure("INVALID_RESPONSE")
    const releases = list(result.releases).map(readRelease)
    const devices = list(result.devices).map(readDevice)
    if (!current(ticket)) return
    state.companyId = id
    state.releases = releases
    state.devices = devices
    if (
      state.selection?.kind === "company" &&
      !releases.some(
        (release) =>
          state.selection?.kind === "company" &&
          state.selection.companyId === id &&
          release.releaseId === state.selection.releaseId &&
          release.manifestSha256 === state.selection.manifestSha256,
      )
    )
      state.selection = null
  }
  async function refresh() {
    if (attempt || disposed) return snapshot()
    const ticket = begin()
    try {
      const catalog = await request("/catalog")
      const generic = list(catalog.models).map(readGeneric)
      if (!current(ticket)) return snapshot()
      state.generic = generic
      if (!restored) {
        if (!input.store.available()) throw new AccountFailure("SECURE_STORE_UNAVAILABLE")
        const stored = await input.store.get().catch(() => {
          throw new AccountFailure("SECURE_STORE_UNAVAILABLE")
        })
        if (!current(ticket)) return snapshot()
        restored = true
        if (stored) {
          session = readSession(stored)
          state.companyId = session.companyId
          state.selection = session.selection
        }
      }
      if (!session) {
        state.status = "signed_out"
        state.error = null
        return publish()
      }
      if (Date.parse(session.expiresAt) <= now()) throw new AccountFailure("SESSION_EXPIRED")
      const identity = await request("/desktop/account", { token: session.token })
      const account = readAccount(identity.account)
      const remoteSession = object(identity.session)
      if (
        account.id !== session.account.id ||
        string(remoteSession.id) !== session.sessionId ||
        remoteSession.scope !== "models:read" ||
        Date.parse(date(remoteSession.expiresAt)) <= now()
      )
        throw new AccountFailure("SESSION_EXPIRED")
      const response = await request("/desktop/companies", { token: session.token })
      const companies = list(response.companies).map(readCompany)
      if (!current(ticket)) return snapshot()
      state.account = account
      state.companies = companies
      if (!companies.some((company) => company.id === state.companyId)) {
        state.companyId = companies[0]?.id ?? null
        state.selection = null
      }
      state.releases = []
      state.devices = []
      if (state.companyId) await loadCompany(state.companyId, ticket)
      if (!current(ticket)) return snapshot()
      if (
        state.selection?.kind === "generic" &&
        !generic.some(
          (model) =>
            state.selection?.kind === "generic" &&
            model.id === state.selection.id &&
            model.source.revision === state.selection.revision,
        )
      )
        state.selection = null
      state.status = "signed_in"
      state.error = null
      state.checkedAt = new Date(now()).toISOString()
      await save()
      if (!current(ticket)) return snapshot()
      return publish()
    } catch (error) {
      return failed(error, ticket)
    }
  }
  async function poll(ticket: number) {
    if (!current(ticket) || !attempt) return
    if (Date.parse(attempt.expiresAt) <= now()) {
      attempt = undefined
      await failed(new AccountFailure("SIGN_IN_EXPIRED"), ticket)
      return
    }
    try {
      const result = await request("/desktop-auth/poll", {
        body: { deviceCode: attempt.deviceCode, verifier: attempt.verifier },
      })
      if (!current(ticket)) return
      if (result.pending === true) {
        polling = setTimeout(() => void poll(ticket), attempt.interval)
        polling.unref?.()
        return
      }
      if (result.scope !== "models:read") throw new AccountFailure("INVALID_RESPONSE")
      session = readSession({ ...result, companyId: null, selection: null })
      if (Date.parse(session.expiresAt) <= now()) throw new AccountFailure("SESSION_EXPIRED")
      state.selection = null
      state.companyId = null
      await save()
      if (!current(ticket)) return
      attempt = undefined
      state.pending = null
      restored = true
      await refresh()
    } catch (error) {
      if (current(ticket)) attempt = undefined
      await failed(error, ticket)
    }
  }
  async function signIn() {
    const ticket = begin()
    attempt = undefined
    clearPrivate()
    state.pending = null
    state.error = null
    if (!input.store.available()) return failed(new AccountFailure("SECURE_STORE_UNAVAILABLE"), ticket)
    state.status = "signing_in"
    publish()
    try {
      const verifier = randomBytes(32).toString("base64url")
      const result = await request("/desktop-auth/start", {
        body: {
          challenge: createHash("sha256").update(verifier).digest("base64url"),
          label: "Physical Systems desktop",
        },
      })
      const userCode = string(result.userCode)
      const expiresAt = date(result.expiresAt)
      if (
        !/^[A-F0-9]{16}$/.test(userCode) ||
        result.verificationPath !== `/model-delivery/connect?code=${userCode}` ||
        typeof result.intervalSeconds !== "number" ||
        result.intervalSeconds < 1 ||
        result.intervalSeconds > 60 ||
        Date.parse(expiresAt) <= now()
      )
        throw new AccountFailure("INVALID_RESPONSE")
      if (!current(ticket)) return snapshot()
      attempt = {
        deviceCode: string(result.deviceCode),
        verifier,
        expiresAt,
        interval: input.pollDelay ?? result.intervalSeconds * 1000,
      }
      const verificationUrl = base.origin + result.verificationPath
      state.pending = { userCode, verificationUrl, expiresAt, browserOpened: false }
      publish()
      const opened = await input.openBrowser(verificationUrl).catch(() => false)
      if (!current(ticket)) return snapshot()
      state.pending = { userCode, verificationUrl, expiresAt, browserOpened: opened }
      state.error = opened ? null : "BROWSER_UNAVAILABLE"
      polling = setTimeout(() => void poll(ticket), attempt.interval)
      polling.unref?.()
      return publish()
    } catch (error) {
      return failed(error, ticket)
    }
  }
  async function cancelSignIn() {
    const previous = attempt
    const ticket = begin()
    attempt = undefined
    state.pending = null
    if (previous)
      await request("/desktop-auth/cancel", {
        body: { deviceCode: previous.deviceCode, verifier: previous.verifier },
      }).catch(() => {})
    if (!current(ticket)) return snapshot()
    return refresh()
  }
  async function signOut() {
    const previous = session
    begin()
    attempt = undefined
    state.pending = null
    restored = true
    session = undefined
    clearPrivate()
    state.status = "signed_out"
    state.error = null
    publish()
    const ticket = epoch
    const clearing = persist(() => input.store.clear()).catch(() => {
      if (current(ticket)) state.error = "SECURE_STORE_UNAVAILABLE"
    })
    if (previous) await request("/desktop/session", { token: previous.token, method: "DELETE" }).catch(() => {})
    await clearing
    if (!current(ticket)) return snapshot()
    return publish()
  }
  async function company(id: string) {
    const ticket = begin()
    state.selection = null
    state.companyId = null
    state.releases = []
    state.devices = []
    publish()
    try {
      if (state.status !== "signed_in" || typeof id !== "string") throw new AccountFailure("ACCESS_REVOKED")
      await loadCompany(id, ticket)
      if (!current(ticket)) return snapshot()
      state.error = null
      await save()
      return current(ticket) ? publish() : snapshot()
    } catch (error) {
      return failed(error, ticket)
    }
  }
  async function select(value: unknown) {
    const selection = value === null ? null : readSelection(value)
    // Recheck membership and release metadata before accepting any private reference.
    const refreshing = refresh()
    const ticket = epoch
    await refreshing
    if (!current(ticket)) return snapshot()
    if (
      selection?.kind === "company" &&
      (state.status !== "signed_in" ||
        state.companyId !== selection.companyId ||
        !state.releases.some(
          (release) => release.releaseId === selection.releaseId && release.manifestSha256 === selection.manifestSha256,
        ))
    ) {
      state.error = "INVALID_SELECTION"
      return publish()
    }
    if (
      selection?.kind === "generic" &&
      !state.generic.some((model) => model.id === selection.id && model.source.revision === selection.revision)
    ) {
      state.error = "INVALID_SELECTION"
      return publish()
    }
    state.selection = selection
    try {
      await save()
      if (!current(ticket)) return snapshot()
      state.error = null
    } catch {
      if (!current(ticket)) return snapshot()
      state.selection = null
      state.error = "SECURE_STORE_UNAVAILABLE"
    }
    return current(ticket) ? publish() : snapshot()
  }
  const maintenance = setInterval(() => {
    if (session && !attempt) void refresh()
  }, 30_000)
  maintenance.unref?.()
  return {
    snapshot,
    refresh,
    signIn,
    cancelSignIn,
    signOut,
    company,
    select,
    dispose() {
      disposed = true
      begin()
      clearInterval(maintenance)
      session = undefined
      attempt = undefined
    },
  }
}

async function readResponse(response: Response) {
  const reader = response.body?.getReader()
  if (!reader) throw new AccountFailure("INVALID_RESPONSE")
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ""
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > 2_000_000) throw new AccountFailure("INVALID_RESPONSE")
      text += decoder.decode(part.value, { stream: true })
    }
    text += decoder.decode()
    return object(JSON.parse(text))
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error instanceof AccountFailure ? error : new AccountFailure("INVALID_RESPONSE")
  } finally {
    reader.releaseLock()
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AccountFailure("INVALID_RESPONSE")
  return value as Record<string, unknown>
}
function string(value: unknown) {
  if (typeof value !== "string" || !value || value.length > 1024) throw new AccountFailure("INVALID_RESPONSE")
  return value
}
function list(value: unknown) {
  if (!Array.isArray(value) || value.length > 2000) throw new AccountFailure("INVALID_RESPONSE")
  return value as unknown[]
}
function date(value: unknown) {
  const text = string(value)
  if (!Number.isFinite(Date.parse(text))) throw new AccountFailure("INVALID_RESPONSE")
  return text
}
function hash(value: unknown) {
  const text = string(value)
  if (!/^[a-f0-9]{64}$/.test(text)) throw new AccountFailure("INVALID_RESPONSE")
  return text
}
function readAccount(value: unknown): Account {
  const item = object(value)
  return { id: string(item.id), name: string(item.name), email: string(item.email) }
}
function readCompany(value: unknown): ModelCompany {
  const item = object(value)
  if (!["owner", "operator", "viewer"].includes(String(item.role))) throw new AccountFailure("INVALID_RESPONSE")
  return { id: string(item.id), name: string(item.name), role: item.role as ModelCompany["role"] }
}
function readCompatibility(value: unknown): ModelCompatibility {
  const item = object(value)
  return {
    runtime: string(item.runtime),
    platform: string(item.platform),
    robotType: string(item.robotType),
    configurationSha256: hash(item.configurationSha256),
  }
}
function readRelease(value: unknown): CompanyModelRelease {
  const item = object(value),
    evaluation = object(item.evaluation)
  if (item.signatureVerified !== true || !["offline", "supervised"].includes(String(evaluation.kind)))
    throw new AccountFailure("INVALID_RESPONSE")
  return {
    releaseId: string(item.releaseId),
    modelId: string(item.modelId),
    version: string(item.version),
    manifestSha256: hash(item.manifestSha256),
    createdAt: date(item.createdAt),
    compatibility: readCompatibility(item.compatibility),
    evaluation: { kind: evaluation.kind as "offline" | "supervised", reportPath: string(evaluation.reportPath) },
    keyId: string(item.keyId),
    signatureVerified: true,
  }
}
function readIdentity(value: unknown): ModelIdentity | null {
  if (value === null) return null
  const item = object(value)
  return { releaseId: string(item.releaseId), manifestSha256: hash(item.manifestSha256) }
}
function readDevice(value: unknown): ModelDevice {
  const item = object(value)
  const report = item.lastReport === null ? null : object(item.lastReport)
  if (
    typeof item.revoked !== "boolean" ||
    (report && !["staged", "selected", "failed"].includes(String(report.status)))
  )
    throw new AccountFailure("INVALID_RESPONSE")
  return {
    id: string(item.id),
    name: string(item.name),
    compatibility: readCompatibility(item.compatibility),
    revoked: item.revoked,
    expiresAt: date(item.expiresAt),
    desired: readIdentity(item.desired),
    staged: readIdentity(item.staged),
    selected: readIdentity(item.selected),
    lastReport: report
      ? {
          status: report.status as "staged" | "selected" | "failed",
          createdAt: date(report.createdAt),
          ...(report.errorCode ? { errorCode: string(report.errorCode) } : {}),
        }
      : null,
  }
}
function readGeneric(value: unknown): GenericRobotModel {
  const item = object(value),
    source = object(item.source)
  if (
    item.kind !== "training_base" ||
    item.status !== "runtime_setup_required" ||
    item.robotCompatibility !== "unverified" ||
    item.canRun !== false ||
    !/^[a-f0-9]{40}$/.test(string(source.revision))
  )
    throw new AccountFailure("INVALID_RESPONSE")
  return {
    id: string(item.id),
    name: string(item.name),
    source: { repoId: string(source.repoId), revision: string(source.revision) },
    kind: "training_base",
    status: "runtime_setup_required",
    architecture: string(item.architecture),
    robotCompatibility: "unverified",
    canRun: false,
    description: string(item.description),
  }
}
function readSelection(value: unknown): RobotModelSelection {
  const item = object(value)
  if (item.kind === "company")
    return {
      kind: "company",
      companyId: string(item.companyId),
      releaseId: string(item.releaseId),
      manifestSha256: hash(item.manifestSha256),
    }
  if (item.kind === "generic" && /^[a-f0-9]{40}$/.test(string(item.revision)))
    return { kind: "generic", id: string(item.id), revision: string(item.revision) }
  throw new AccountFailure("INVALID_SELECTION")
}
function readSession(value: unknown): Session {
  const item = object(value)
  if (!/^ps_model_account_[A-Za-z0-9_-]{43}$/.test(string(item.token))) throw new AccountFailure("INVALID_RESPONSE")
  return {
    token: string(item.token),
    sessionId: string(item.sessionId),
    expiresAt: date(item.expiresAt),
    account: readAccount(item.account),
    companyId: item.companyId === null ? null : string(item.companyId),
    selection: item.selection === null ? null : readSelection(item.selection),
  }
}
