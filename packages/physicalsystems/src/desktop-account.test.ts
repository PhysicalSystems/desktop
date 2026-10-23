// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, setSystemTime, test } from "bun:test"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { createDesktopAccount, DESKTOP_ACCOUNT_SCOPE } from "./desktop-account"
import { createWorkcellAccount } from "./workcell-account"
import { createWorkcellAccountView } from "./workcell-account-view"
import { createModelAccount } from "./model-account"
import type { WorkcellAccountState } from "./workcell-account-types"

afterEach(() => setSystemTime())
const token = () => randomBytes(32).toString("base64url")
function setup() {
  const account = { id: "account-one", name: "Operator", email: "operator@example.invalid" }
  const sessionId = randomUUID()
  const calls: { path: string; body?: Record<string, unknown> }[] = []
  let journal: unknown = null
  let managed = false
  let start: { challenge: string; state: string; redirectUri: string } | undefined
  let refreshed = ""
  let exchangeCode = token()
  let failRotation = false
  let available = true
  let releaseAccount: (() => void) | undefined
  let accountStarted: (() => void) | undefined
  let blockAccount = false
  const changes: WorkcellAccountState[] = []
  const waits = new Set<(value: WorkcellAccountState) => void>()
  const response = () => ({
    token: `ps_desktop_account_${token()}`,
    sessionId,
    scope: DESKTOP_ACCOUNT_SCOPE,
    account,
    expiresAt: new Date(Date.now() + 12 * 3600000).toISOString(),
    refreshExpiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
    sessionExpiresAt: new Date(Date.now() + 90 * 86400000).toISOString(),
  })
  let current = response()
  const input = {
    store: {
      available: () => available,
      managed: async () => managed,
      markManaged: async () => {
        managed = true
      },
      get: async () => structuredClone(journal),
      set: async (value: unknown) => {
        journal = structuredClone(value)
      },
      clear: async () => {
        journal = null
      },
    },
    openBrowser: async (url: string) => {
      expect(url).toMatch(/^https:\/\/physicalsystems.ai\/desktop\/sign-in\?request=/)
      expect(start).toBeDefined()
      const callback = await fetch(`${start!.redirectUri}?code=${exchangeCode}&state=${start!.state}`, {
        redirect: "manual",
      })
      expect(callback.status).toBe(303)
      return true
    },
    changed: (value: WorkcellAccountState) => {
      changes.push(value)
      for (const wait of waits) wait(value)
    },
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
      calls.push({ path, ...(body ? { body } : {}) })
      if (path === "/api/desktop-auth/browser/start") {
        start = body as typeof start
        const authorizationId = randomUUID()
        return Response.json({
          authorizationId,
          authorizationUrl: `https://physicalsystems.ai/desktop/sign-in?request=${authorizationId}`,
          expiresAt: new Date(Date.now() + 600000).toISOString(),
        })
      }
      if (path === "/api/desktop-auth/browser/exchange") {
        expect(body!.code).toBe(exchangeCode)
        expect(createHash("sha256").update(String(body!.verifier)).digest("base64url")).toBe(start!.challenge)
        expect((journal as { pending: unknown }).pending).toEqual({ kind: "exchange", ...body })
        refreshed = String(body!.refreshToken)
        return Response.json(current)
      }
      if (path === "/api/desktop-auth/refresh") {
        expect((journal as { pending: unknown }).pending).toEqual({ kind: "refresh", ...body })
        if (refreshed === body!.refreshToken) {
          refreshed = String(body!.nextRefreshToken)
          current = response()
        } else expect(refreshed).toBe(String(body!.nextRefreshToken))
        if (failRotation) {
          failRotation = false
          throw new Error("Response lost after committed rotation")
        }
        return Response.json(current)
      }
      if (path === "/api/desktop-auth/account" || path === "/api/model-delivery/desktop/account") {
        if (blockAccount) {
          accountStarted?.()
          await new Promise<void>((resolve) => {
            releaseAccount = resolve
          })
        }
        return Response.json({
          account,
          session: {
            id: sessionId,
            scope: DESKTOP_ACCOUNT_SCOPE,
            expiresAt: current.expiresAt,
            refreshExpiresAt: current.refreshExpiresAt,
            sessionExpiresAt: current.sessionExpiresAt,
          },
        })
      }
      if (path === "/api/desktop-auth/session") return new Response(null, { status: 204 })
      if (path === "/api/model-delivery/desktop/companies") return Response.json({ companies: [] })
      if (path === "/api/model-delivery/catalog") return Response.json({ models: [] })
      if (path === "/api/workcells") return Response.json({ workcells: [] })
      throw new Error(`Unexpected route ${path}`)
    }) as typeof fetch,
  }
  const signedIn = () =>
    new Promise<void>((resolve) => {
      const next = (value: WorkcellAccountState) => {
        if (value.status === "signed_in") {
          waits.delete(next)
          resolve()
        }
      }
      waits.add(next)
    })
  return {
    input,
    calls,
    changes,
    signedIn,
    get journal() {
      return journal
    },
    get start() {
      return start
    },
    setAvailable(value: boolean) {
      available = value
    },
    loseRotation() {
      failRotation = true
    },
    blockIdentity() {
      blockAccount = true
      return new Promise<void>((resolve) => {
        accountStarted = resolve
      })
    },
    releaseIdentity() {
      blockAccount = false
      releaseAccount?.()
    },
  }
}

test("one browser sign-in persists its proof before exchange and projects no tokens", async () => {
  const fixture = setup()
  const account = createDesktopAccount(fixture.input)
  try {
    const signed = fixture.signedIn()
    await account.signIn()
    await signed
    expect(account.snapshot().account?.id).toBe("account-one")
    expect(account.snapshot().pending).toBeNull()
    expect(account.managed()).toBe(true)
    expect(JSON.stringify(fixture.changes)).not.toMatch(/ps_desktop_account_|refreshToken|verifier/)
    expect(fixture.changes.some((state) => state.pending && state.pending.userCode === undefined)).toBe(true)
    await account.request("GET", "/api/workcells")
    for (const [method, path, body] of [
      ["GET", "/api/auth/session", undefined],
      ["POST", "/api/workcells/w/conversations/c/prompts", { text: "run" }],
      ["GET", "https://attacker.invalid", undefined],
      ["POST", "/api/model-delivery/desktop/companies", {}],
    ])
      await expect(account.request(method, path, body)).rejects.toThrow("INVALID_WORKCELL_REQUEST")
    expect(fixture.calls.filter((item) => item.path.endsWith("/browser/exchange"))).toHaveLength(1)
  } finally {
    account.dispose()
  }
})

test("durable exact refresh retry survives a lost response and restart; concurrent callers renew once", async () => {
  const fixture = setup()
  const first = createDesktopAccount(fixture.input)
  const signed = fixture.signedIn()
  await first.signIn()
  await signed
  setSystemTime(Date.now() + 13 * 3600000)
  fixture.loseRotation()
  await Promise.all([first.refresh(), first.refresh(), first.refresh()])
  const pending = (fixture.journal as { pending: unknown }).pending
  expect(fixture.calls.filter((item) => item.path === "/api/desktop-auth/refresh")).toHaveLength(1)
  expect(first.snapshot().status).toBe("unavailable")
  first.dispose()
  const restored = createDesktopAccount(fixture.input)
  try {
    await restored.refresh()
    expect(restored.snapshot().status).toBe("signed_in")
    const rotations = fixture.calls.filter((item) => item.path === "/api/desktop-auth/refresh")
    expect(rotations).toHaveLength(2)
    expect(rotations[1]).toEqual(rotations[0])
    expect((fixture.journal as { pending?: unknown }).pending).toBeUndefined()
    expect(pending).toBeDefined()
  } finally {
    restored.dispose()
  }
})

test("sign-out wins against an in-flight response and restart never revives the legacy grant", async () => {
  const fixture = setup()
  const account = createDesktopAccount(fixture.input)
  const signed = fixture.signedIn()
  await account.signIn()
  await signed
  const started = fixture.blockIdentity()
  const refreshing = account.refresh()
  await started
  await account.signOut()
  fixture.releaseIdentity()
  await refreshing
  expect(account.snapshot().status).toBe("signed_out")
  expect(fixture.journal).toBeNull()
  account.dispose()
  const restored = createDesktopAccount(fixture.input)
  let legacyReads = 0
  const legacy = createWorkcellAccount({
    store: {
      available: () => true,
      get: async () => {
        legacyReads++
        return null
      },
      set: async () => {},
      clear: async () => {},
    },
    openBrowser: async () => true,
    changed: () => {},
  })
  const view = createWorkcellAccountView(restored, legacy, () => {})
  try {
    await view.refresh()
    expect(view.snapshot().status).toBe("signed_out")
    expect(view.automaticSyncEnabled()).toBe(false)
    expect(legacyReads).toBe(0)
  } finally {
    view.dispose()
    restored.dispose()
  }
})

test("a locked native store prevents browser authorization and network calls", async () => {
  const fixture = setup()
  fixture.setAvailable(false)
  const account = createDesktopAccount(fixture.input)
  try {
    await account.signIn()
    expect(account.snapshot().error).toBe("SECURE_STORE_UNAVAILABLE")
    expect(fixture.calls).toHaveLength(0)
  } finally {
    account.dispose()
  }
})

test("refresh cannot interrupt a starting browser sign-in and cancellation closes its listener", async () => {
  const fixture = setup()
  let browserStarted!: () => void
  let releaseBrowser!: (value: boolean) => void
  const started = new Promise<void>((resolve) => {
    browserStarted = resolve
  })
  fixture.input.openBrowser = async () => {
    browserStarted()
    return new Promise<boolean>((resolve) => {
      releaseBrowser = resolve
    })
  }
  const account = createDesktopAccount(fixture.input)
  try {
    const signin = account.signIn()
    await started
    await Promise.all([account.refresh(), account.refresh()])
    expect(account.snapshot().status).toBe("signing_in")
    expect(fixture.calls.map((item) => item.path)).toEqual(["/api/desktop-auth/browser/start"])
    await account.cancelSignIn()
    releaseBrowser(true)
    await signin
    expect(account.snapshot().status).toBe("signed_out")
    await expect(fetch(fixture.start!.redirectUri)).rejects.toThrow()
  } finally {
    account.dispose()
  }
})

test("offline logout with a locked keyring removes the credential and remembers unified ownership on restart", async () => {
  const fixture = setup()
  const account = createDesktopAccount(fixture.input)
  const signed = fixture.signedIn()
  await account.signIn()
  await signed
  fixture.setAvailable(false)
  const original = fixture.input.fetch
  fixture.input.fetch = (async (url, init) => {
    if (String(url).endsWith("/session")) throw new Error("Offline")
    return original(url, init)
  }) as typeof fetch
  await account.signOut()
  expect(fixture.journal).toBeNull()
  account.dispose()
  const restored = createDesktopAccount(fixture.input)
  try {
    await restored.refresh()
    expect(restored.managed()).toBe(true)
    expect(restored.snapshot().account).toBeNull()
    expect(restored.snapshot().error).toBe("SECURE_STORE_UNAVAILABLE")
  } finally {
    restored.dispose()
  }
})

test("model and workcell views use the same new account without adopting its token into legacy storage", async () => {
  const fixture = setup()
  const account = createDesktopAccount(fixture.input)
  const signed = fixture.signedIn()
  await account.signIn()
  await signed
  let legacyWrites = 0
  const models = createModelAccount({
    shared: account,
    store: {
      available: () => true,
      get: async () => null,
      set: async () => {
        legacyWrites++
      },
      clear: async () => {},
    },
    fetch: fixture.input.fetch,
    openBrowser: async () => true,
    changed: () => {},
  })
  try {
    await models.refresh()
    expect(models.snapshot().status).toBe("signed_in")
    expect(models.snapshot().account).toEqual(account.snapshot().account)
    expect(legacyWrites).toBe(0)
    await models.signOut()
    expect(models.snapshot().status).toBe("signed_out")
    expect(account.snapshot().status).toBe("signed_out")
  } finally {
    models.dispose()
    account.dispose()
  }
})

test("a committed exchange whose response was lost replays its exact proof after restart", async () => {
  const fixture = setup()
  const original = fixture.input.fetch
  let lose = true
  fixture.input.fetch = (async (url, init) => {
    const response = await original(url, init)
    if (String(url).endsWith("/browser/exchange") && lose) {
      lose = false
      throw new Error("Response lost")
    }
    return response
  }) as typeof fetch
  const first = createDesktopAccount(fixture.input)
  const failed = new Promise<void>((resolve) => {
    first.subscribe((value) => {
      if (value.error) resolve()
    })
  })
  await first.signIn()
  await failed
  const pending = (fixture.journal as { pending: unknown }).pending
  first.dispose()
  const restored = createDesktopAccount(fixture.input)
  try {
    await restored.refresh()
    expect(restored.snapshot().status).toBe("signed_in")
    const exchanges = fixture.calls.filter((item) => item.path.endsWith("/browser/exchange"))
    expect(exchanges).toHaveLength(2)
    expect(exchanges[0]).toEqual(exchanges[1])
    expect(pending).toBeDefined()
  } finally {
    restored.dispose()
  }
})

test("a rejected refresh replay clears its credential and pending secret instead of retrying forever", async () => {
  const fixture = setup()
  const account = createDesktopAccount(fixture.input)
  const signed = fixture.signedIn()
  await account.signIn()
  await signed
  const original = fixture.input.fetch
  fixture.input.fetch = (async (url, init) =>
    String(url).endsWith("/refresh")
      ? Response.json({ code: "idempotency_conflict" }, { status: 409 })
      : original(url, init)) as typeof fetch
  try {
    setSystemTime(Date.now() + 13 * 3600000)
    await account.refresh()
    expect(account.snapshot().status).toBe("signed_out")
    expect(account.snapshot().error).toBe("ACCESS_REVOKED")
    expect(fixture.journal).toBeNull()
    expect(account.managed()).toBe(true)
  } finally {
    account.dispose()
  }
})

test("logout reconciles a committed rotation without restoring it or revoking a newer sign-in", async () => {
  const fixture = setup()
  const original = fixture.input.fetch
  let committed: Record<string, unknown> | undefined
  let cleaning = false
  let cleanupStarted!: () => void
  let releaseCleanup!: () => void
  let cleanupSignal: AbortSignal | null | undefined
  const started = new Promise<void>((resolve) => {
    cleanupStarted = resolve
  })
  const released = new Promise<void>((resolve) => {
    releaseCleanup = resolve
  })
  const deleted: string[] = []
  let rotation: string | undefined
  const newer = {
    token: `ps_desktop_account_${token()}`,
    sessionId: randomUUID(),
    scope: DESKTOP_ACCOUNT_SCOPE,
    account: { id: "account-two", name: "Second", email: "second@example.invalid" },
    expiresAt: new Date(Date.now() + 48 * 3600000).toISOString(),
    refreshExpiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
    sessionExpiresAt: new Date(Date.now() + 90 * 86400000).toISOString(),
  }
  fixture.input.fetch = (async (url, init) => {
    if (String(url).endsWith("/refresh")) {
      if (!cleaning) {
        rotation = String(init?.body)
        committed = (await (await original(url, init)).json()) as Record<string, unknown>
        throw new Error("Response lost after server rotation")
      }
      expect(fixture.journal).toBeNull()
      expect(String(init?.body)).toBe(rotation!)
      cleanupSignal = init?.signal
      cleanupStarted()
      await released
      return Response.json(committed)
    }
    if (String(url).endsWith("/session")) {
      deleted.push(new Headers(init?.headers).get("Authorization")!)
      return new Response(null, { status: 204 })
    }
    const response = await original(url, init)
    if (cleaning && String(url).endsWith("/browser/exchange")) return Response.json(newer)
    return response
  }) as typeof fetch
  const account = createDesktopAccount(fixture.input)
  try {
    let signed = fixture.signedIn()
    await account.signIn()
    await signed
    setSystemTime(Date.now() + 13 * 3600000)
    await account.refresh()
    expect(account.snapshot().status).toBe("unavailable")
    cleaning = true
    const logout = account.signOut()
    await started
    expect(account.snapshot().status).toBe("signed_out")
    signed = fixture.signedIn()
    await account.signIn()
    await signed
    expect(cleanupSignal?.aborted).toBe(false)
    releaseCleanup()
    await logout
    expect(deleted).toEqual([`Bearer ${committed!.token}`])
    expect(account.snapshot().account?.id).toBe("account-two")
    expect(account.credential()?.token).toBe(newer.token)
  } finally {
    releaseCleanup()
    account.dispose()
  }
})

test("logout revokes a lost exchange without publishing or persisting the recovered session", async () => {
  const fixture = setup()
  const original = fixture.input.fetch
  let committed: unknown
  let proof: string | undefined
  let cleanup = false
  const deleted: string[] = []
  fixture.input.fetch = (async (url, init) => {
    if (String(url).endsWith("/browser/exchange")) {
      if (cleanup) {
        expect(fixture.journal).toBeNull()
        expect(String(init?.body)).toBe(proof!)
        return Response.json(committed)
      }
      proof = String(init?.body)
      committed = await (await original(url, init)).json()
      throw new Error("Response lost after exchange")
    }
    if (String(url).endsWith("/session")) {
      deleted.push(new Headers(init?.headers).get("Authorization")!)
      return new Response(null, { status: 204 })
    }
    return original(url, init)
  }) as typeof fetch
  const account = createDesktopAccount(fixture.input)
  try {
    const failed = new Promise<void>((resolve) =>
      account.subscribe((value) => {
        if (value.error) resolve()
      }),
    )
    await account.signIn()
    await failed
    cleanup = true
    await account.signOut()
    expect(deleted).toEqual([`Bearer ${(committed as { token: string }).token}`])
    expect(fixture.journal).toBeNull()
    expect(account.credential()).toBeUndefined()
    expect(fixture.changes.some((value) => value.status === "signed_in")).toBe(false)
  } finally {
    account.dispose()
  }
})

test("logout never revokes an unrelated identity returned by a malformed refresh replay", async () => {
  const fixture = setup()
  const account = createDesktopAccount(fixture.input)
  try {
    const signed = fixture.signedIn()
    await account.signIn()
    await signed
    const previous = account.credential()!
    setSystemTime(Date.now() + 13 * 3600000)
    fixture.loseRotation()
    await account.refresh()
    const deleted: string[] = []
    fixture.input.fetch = (async (url, init) => {
      if (String(url).endsWith("/refresh"))
        return Response.json({
          ...previous,
          scope: DESKTOP_ACCOUNT_SCOPE,
          expiresAt: new Date(Date.now() + 12 * 3600000).toISOString(),
          sessionId: randomUUID(),
          token: `ps_desktop_account_${token()}`,
        })
      if (String(url).endsWith("/session")) {
        deleted.push(new Headers(init?.headers).get("Authorization")!)
        return new Response(null, { status: 204 })
      }
      throw new Error("Unexpected route")
    }) as typeof fetch
    await account.signOut()
    expect(deleted).toEqual([`Bearer ${previous.token}`])
    expect(account.snapshot().status).toBe("signed_out")
  } finally {
    account.dispose()
  }
})

test("a stale managed-store read failure cannot erase a newer successful sign-in", async () => {
  const fixture = setup()
  let readStarted!: () => void
  let rejectRead!: (error: Error) => void
  const started = new Promise<void>((resolve) => {
    readStarted = resolve
  })
  fixture.input.store.managed = () => {
    readStarted()
    return new Promise<boolean>((_, reject) => {
      rejectRead = reject
    })
  }
  const account = createDesktopAccount(fixture.input)
  const restoring = account.refresh()
  try {
    await started
    const signed = fixture.signedIn()
    await account.signIn()
    await signed
    const credential = account.credential()
    expect(credential).toBeDefined()
    rejectRead(new Error("Delayed native storage failure"))
    await restoring
    expect(account.snapshot().status).toBe("signed_in")
    expect(account.snapshot().error).toBeNull()
    expect(account.credential()).toEqual(credential)
    await expect(account.request("GET", "/api/workcells")).resolves.toEqual({ workcells: [] })
  } finally {
    rejectRead(new Error("Fixture cleanup"))
    await restoring
    account.dispose()
  }
})
