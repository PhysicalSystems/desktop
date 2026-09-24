// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { createModelAccount } from "./model-account"
import type { ModelAccountState } from "./model-account-types"

const dispose: (() => void)[] = []
afterEach(() => {
  for (const close of dispose.splice(0)) close()
})
const token = `ps_model_account_${"A".repeat(43)}`
const account = { id: "account-a", name: "Fixture Operator", email: "fixture@example.invalid" }
const compatibility = {
  runtime: "lerobot-act-v1",
  platform: "linux-aarch64",
  robotType: "so101_follower",
  configurationSha256: "a".repeat(64),
}
const release = {
  releaseId: "release-a",
  modelId: "collars",
  version: "v1",
  manifestSha256: "b".repeat(64),
  createdAt: "2026-09-24T00:00:00Z",
  compatibility,
  evaluation: { kind: "offline", reportPath: "evaluation/report.json" },
  keyId: "fixture",
  signatureVerified: true,
}
const generic = {
  id: "lerobot/smolvla_base",
  name: "SmolVLA base",
  source: { repoId: "lerobot/smolvla_base", revision: "d9f33c94a60fb382c90dea2164c96845bd955e28" },
  kind: "training_base",
  status: "runtime_setup_required",
  architecture: "smolvla",
  robotCompatibility: "unverified",
  canRun: false,
  description: "Fixture training base",
}
const company = { id: "company-a", name: "Fixture company", role: "viewer" }

function fixture() {
  const control = {
    now: Date.parse("2026-09-24T12:00:00Z"),
    available: true,
    stored: undefined as unknown,
    challenge: "",
    denied: false,
    revoked: false,
    membership: true,
    companies: true,
    open: true,
    readError: false,
    holdLogout: undefined as (() => void) | undefined,
    holdSave: undefined as (() => void) | undefined,
    delayLogout: false,
    delaySave: false,
    saves: 0,
    delaySaveAt: 0,
    failSave: false,
    grant: true,
    calls: [] as string[],
    opened: [] as string[],
    emitted: [] as ModelAccountState[],
  }
  const expiresAt = () => new Date(control.now + 3600_000).toISOString()
  const stored = () => ({
    token,
    sessionId: "session-a",
    expiresAt: expiresAt(),
    account,
    companyId: company.id,
    selection: null,
  })
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname.replace("/api/model-delivery", "")
      control.calls.push(`${request.method} ${path}`)
      if (path.startsWith("/desktop/") && request.headers.get("Authorization") !== `Bearer ${token}`)
        return Response.json({}, { status: 401 })
      if (path.startsWith("/desktop/") && control.revoked) return Response.json({}, { status: 401 })
      if (path === "/catalog") return Response.json({ models: [generic] })
      if (path === "/desktop-auth/start") {
        const body = await request.json()
        control.challenge = body.challenge
        return Response.json({
          deviceCode: "private-device-proof",
          userCode: "1234567890ABCDEF",
          verificationPath: "/model-delivery/connect?code=1234567890ABCDEF",
          expiresAt: expiresAt(),
          intervalSeconds: 5,
        })
      }
      if (path === "/desktop-auth/poll") {
        const body = await request.json()
        expect(createHash("sha256").update(body.verifier).digest("base64url")).toBe(control.challenge)
        if (control.denied) return Response.json({ code: "sign_in_denied" }, { status: 403 })
        if (!control.grant) return Response.json({ pending: true }, { status: 202 })
        return Response.json({ ...stored(), scope: "models:read" })
      }
      if (path === "/desktop/account")
        return Response.json({ account, session: { id: "session-a", expiresAt: expiresAt(), scope: "models:read" } })
      if (path === "/desktop/companies") return Response.json({ companies: control.companies ? [company] : [] })
      if (path === `/desktop/companies/${company.id}/releases`)
        return control.membership
          ? Response.json({ company, releases: [release], devices: [] })
          : Response.json({}, { status: 404 })
      if (path === "/desktop/session") {
        if (control.delayLogout)
          await new Promise<void>((resolve) => {
            control.holdLogout = resolve
          })
        return new Response(null, { status: 204 })
      }
      if (path === "/desktop-auth/cancel") return Response.json({ cancelled: true })
      return Response.json({}, { status: 404 })
    },
  })
  const client = createModelAccount({
    origin: `http://127.0.0.1:${server.port}`,
    now: () => control.now,
    pollDelay: 10,
    store: {
      available: () => control.available,
      get: async () => {
        if (control.readError) throw new Error("locked")
        return control.stored
      },
      set: async (value) => {
        control.saves++
        if (control.delaySave || control.saves === control.delaySaveAt)
          await new Promise<void>((resolve) => {
            control.holdSave = resolve
          })
        if (control.failSave) throw new Error("Fixture locked store")
        control.stored = structuredClone(value)
      },
      clear: async () => {
        control.stored = undefined
      },
    },
    openBrowser: async (url) => {
      control.opened.push(url)
      return control.open
    },
    changed: (value) => control.emitted.push(value),
  })
  dispose.push(() => {
    client.dispose()
    server.stop(true)
  })
  return { client, control, stored }
}
async function until(condition: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (condition()) return
    await Bun.sleep(10)
  }
  throw new Error("Fixture condition timed out")
}

test("PKCE sign-in persists native credentials but exposes only sanitized account and catalog references", async () => {
  const { client, control } = fixture()
  await client.refresh()
  expect(control.opened).toHaveLength(0)
  expect(client.snapshot().generic).toHaveLength(1)
  await client.signIn()
  expect(client.snapshot().pending?.userCode).toBe("1234567890ABCDEF")
  await until(() => client.snapshot().status === "signed_in")
  expect(client.snapshot().companies[0].role).toBe("viewer")
  expect(client.snapshot().releases[0].releaseId).toBe("release-a")
  expect(JSON.stringify(control.emitted)).not.toContain(token)
  expect(JSON.stringify(control.emitted)).not.toContain("private-device-proof")
  expect(control.stored).toMatchObject({ token, account })
  await client.select({
    kind: "company",
    companyId: company.id,
    releaseId: release.releaseId,
    manifestSha256: release.manifestSha256,
  })
  expect(control.stored).toMatchObject({ sessionId: "session-a", selection: { releaseId: "release-a" } })
  expect(control.calls.filter((call) => call.startsWith("POST") && !call.startsWith("POST /desktop-auth/"))).toEqual([])
  expect(control.calls.some((call) => /assign|activate|run|download/.test(call))).toBe(false)
})

test("keyring failures leave public catalog usable and retry restoration after unlock", async () => {
  const { client, control, stored } = fixture()
  control.available = false
  control.stored = stored()
  await client.refresh()
  expect(client.snapshot().generic).toHaveLength(1)
  expect(client.snapshot().error).toBe("SECURE_STORE_UNAVAILABLE")
  await client.signIn()
  expect(control.opened).toHaveLength(0)
  control.available = true
  control.readError = true
  await client.refresh()
  expect(client.snapshot().error).toBe("SECURE_STORE_UNAVAILABLE")
  control.readError = false
  await client.refresh()
  expect(client.snapshot().status).toBe("signed_in")
})

test("expired sessions and revoked tokens clear private state and stored selection", async () => {
  const { client, control, stored } = fixture()
  control.stored = {
    ...stored(),
    expiresAt: new Date(control.now - 1).toISOString(),
    selection: {
      kind: "company",
      companyId: company.id,
      releaseId: release.releaseId,
      manifestSha256: release.manifestSha256,
    },
  }
  await client.refresh()
  expect(client.snapshot().status).toBe("signed_out")
  expect(client.snapshot().selection).toBeNull()
  expect(control.stored).toBeUndefined()
  await client.signIn()
  await until(() => client.snapshot().status === "signed_in")
  control.revoked = true
  await client.refresh()
  expect(client.snapshot().error).toBe("SESSION_EXPIRED")
  expect(client.snapshot().releases).toEqual([])
  expect(control.stored).toBeUndefined()
})

test("membership removal clears company references without revoking the whole account", async () => {
  const { client, control, stored } = fixture()
  control.stored = stored()
  await client.refresh()
  await client.select({
    kind: "company",
    companyId: company.id,
    releaseId: release.releaseId,
    manifestSha256: release.manifestSha256,
  })
  control.membership = false
  await client.refresh()
  expect(client.snapshot().selection).toBeNull()
  expect(client.snapshot().releases).toEqual([])
  expect(control.stored).toMatchObject({ token })
  control.companies = false
  await client.refresh()
  expect(client.snapshot().status).toBe("signed_in")
  expect(client.snapshot().companies).toEqual([])
  expect(client.snapshot().selection).toBeNull()
})

test("browser failure remains recoverable, denied requests clear pending state, and cancel uses proof", async () => {
  const { client, control } = fixture()
  control.open = false
  control.grant = false
  await client.signIn()
  expect(client.snapshot().error).toBe("BROWSER_UNAVAILABLE")
  expect(client.snapshot().pending?.verificationUrl).toContain("/model-delivery/connect?code=")
  await client.cancelSignIn()
  expect(control.calls).toContain("POST /desktop-auth/cancel")
  expect(client.snapshot().pending).toBeNull()
  control.denied = true
  await client.signIn()
  await until(() => client.snapshot().error === "SIGN_IN_DENIED")
  expect(client.snapshot().pending).toBeNull()
})

test("delayed logout cannot erase a newer signed-in session", async () => {
  const { client, control, stored } = fixture()
  control.stored = stored()
  await client.refresh()
  control.delayLogout = true
  const logout = client.signOut()
  await until(() => Boolean(control.holdLogout))
  await client.signIn()
  await until(() => client.snapshot().status === "signed_in")
  control.holdLogout!()
  await logout
  expect(client.snapshot().status).toBe("signed_in")
  expect(control.stored).toMatchObject({ token })
})

test("a credential save already in progress is cleared by logout before another session can persist", async () => {
  const { client, control } = fixture()
  control.delaySave = true
  await client.signIn()
  await until(() => Boolean(control.holdSave))
  const logout = client.signOut()
  control.delaySave = false
  control.holdSave!()
  await logout
  expect(control.stored).toBeUndefined()
  expect(client.snapshot().status).toBe("signed_out")
  expect(client.snapshot().account).toBeNull()
})

test("a superseded selection save cannot clear a newer access error", async () => {
  const { client, control, stored } = fixture()
  control.stored = stored()
  await client.refresh()
  control.delaySaveAt = control.saves + 2
  const selecting = client.select({
    kind: "company",
    companyId: company.id,
    releaseId: release.releaseId,
    manifestSha256: release.manifestSha256,
  })
  await until(() => Boolean(control.holdSave))
  await client.company("company-without-membership")
  expect(client.snapshot().error).toBe("ACCESS_REVOKED")
  control.failSave = true
  control.holdSave!()
  await selecting
  expect(client.snapshot().error).toBe("ACCESS_REVOKED")
  expect(client.snapshot().selection).toBeNull()
})
