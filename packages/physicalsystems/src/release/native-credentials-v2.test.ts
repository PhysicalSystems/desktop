// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { mkdtemp, mkdir, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCredentialVault } from "../credentials"
import { createNativeV2CredentialProbe, type V2CredentialProbeRequest } from "./native-credentials-v2"

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "v2-native-observation-")))
  await mkdir(join(root, "operator"))
  await mkdir(join(root, "data/opencode"), { recursive: true })
  const database = join(root, "data/opencode/opencode.db")
  await writeFile(database, "inert database byte-scan fixture")
  // Deliberate test cipher, no Electron, native service or credential extraction.
  const vault = createCredentialVault(join(root, "operator/provider-credentials.enc"), {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(Buffer.from(value).map((byte) => byte ^ 91)),
    decryptString: (bytes) => Buffer.from(bytes.map((byte) => byte ^ 91)).toString(),
  })
  const probe = createNativeV2CredentialProbe()
  const state = { canary: "", ids: [] as string[], calls: [] as { route: string; method: string }[] }
  const request: V2CredentialProbeRequest = async (route, init) => {
    state.calls.push({ route, method: init.method })
    if (route === "/api/model" && init.method === "GET")
      return {
        location: { directory: root },
        data: state.ids.length
          ? [{ id: "fixture", providerID: probe.providerID }]
          : [{ id: "fixture", providerID: "fixture" }],
      }
    if (route === `/api/integration/${probe.providerID}` && init.method === "GET")
      return {
        location: { directory: root },
        data: {
          id: probe.providerID,
          methods: [{ type: "key" }],
          connections: state.ids.map((id) => ({ type: "credential", id, label: "Fixture" })),
        },
      }
    if (route === `/api/integration/${probe.providerID}/connect/key` && init.method === "POST") {
      state.canary = init.body!.key
      state.ids = ["cred_fixture123"]
      await vault.request("set", { key: probe.providerID, info: { key: state.canary } })
      return
    }
    if (route === "/api/credential/cred_fixture123" && init.method === "DELETE") {
      state.ids = []
      await vault.request("remove", { key: probe.providerID })
      return
    }
    throw new Error("unexpected fixture request")
  }
  return { root, database, probe, state, request, close: () => rm(root, { recursive: true, force: true }) }
}

test("V2 probe saves through integration/key and removes only the same sanitized connection ID", async () => {
  const f = await fixture()
  try {
    await f.probe.save(f.request)
    expect(await f.probe.savedConnectionReady(f.request)).toBe(true)
    f.state.ids = []
    expect(await f.probe.savedConnectionReady(f.request)).toBe(false)
    f.state.ids = ["cred_foreign"]
    await expect(f.probe.savedConnectionReady(f.request)).rejects.toThrow("V2_CREDENTIAL_PROBE_AUTH_UNCONFIRMED")
    f.state.ids = ["cred_fixture123"]
    const text = f.probe.beginObservation("present")
    expect(f.probe.observationReady()).toBe(false)
    expect(
      f.probe.observeProviderRequest({
        authorization: `Bearer ${f.state.canary}`,
        messages: [{ role: "user", content: text }],
      }),
    ).toBe(true)
    expect(f.probe.observationReady()).toBe(true)
    expect(f.probe.finishObservation().authorizationMatched).toBe(true)
    const saved = await f.probe.inspectFiles(f.root, { databaseName: "opencode.db" })
    expect(saved.api).toBe("v2-integration")
    expect(saved.inspected).toEqual([{ kind: "database", bytes: 32 }])
    expect(saved.canaryAbsentFromDatabaseBytes).toBe(true)
    expect(JSON.stringify(saved)).not.toContain(f.root)
    expect(JSON.stringify(f.probe)).not.toContain(f.state.canary)
    f.state.ids = ["cred_different123"]
    await expect(f.probe.remove(f.request)).rejects.toThrow("V2_CREDENTIAL_PROBE_AUTH_UNCONFIRMED")
    expect(f.state.calls.filter((call) => call.method === "DELETE")).toEqual([])
    f.state.ids = ["cred_fixture123"]
    await f.probe.remove(f.request)
    expect(await f.probe.assertRemoved(f.request)).toEqual({
      api: "v2-integration",
      credentialAbsent: true,
      catalogUnavailable: true,
    })
    const absent = f.probe.beginObservation("absent")
    f.probe.observeProviderRequest({ authorization: undefined, messages: [{ role: "user", content: absent }] })
    expect(f.probe.finishObservation().authorizationAbsent).toBe(true)
    expect(f.state.calls.some((call) => call.route.startsWith("/auth/"))).toBe(false)
    expect(f.state.calls.filter((call) => call.method === "POST" || call.method === "DELETE")).toEqual([
      { route: `/api/integration/${f.probe.providerID}/connect/key`, method: "POST" },
      { route: "/api/credential/cred_fixture123", method: "DELETE" },
    ])
    expect((await f.probe.inspectFiles(f.root, { databaseName: "opencode.db" })).vaultSha256).not.toBe(
      saved.vaultSha256,
    )
  } finally {
    await f.close()
  }
})

test("V2 removal requires successful disconnected integration and unavailable catalog, never a swallowed API error", async () => {
  const f = await fixture()
  try {
    await expect(f.probe.assertRemoved(f.request)).rejects.toThrow("REMOVAL_UNCONFIRMED")
    await f.probe.save(f.request)
    await f.probe.remove(f.request)
    for (const data of [
      undefined,
      {},
      { data: null },
      { data: [{ id: "fixture", providerID: f.probe.providerID }] },
      { data: [{}] },
    ]) {
      await expect(
        f.probe.assertRemoved((route, init) =>
          route === "/api/model" ? Promise.resolve(data) : f.request(route, init),
        ),
      ).rejects.toThrow("REMOVAL_UNCONFIRMED")
    }
    await expect(
      f.probe.assertRemoved((route, init) =>
        route === "/api/model" ? Promise.reject(new Error("private API failure")) : f.request(route, init),
      ),
    ).rejects.toThrow("REMOVAL_UNCONFIRMED")
    expect((await f.probe.assertRemoved(f.request)).catalogUnavailable).toBe(true)
    const registered = createNativeV2CredentialProbe({ providerID: "openai" })
    expect(registered.providerID).toBe("openai")
  } finally {
    await f.close()
  }
})

test("V2 probe rejects preexisting/environment/wrong integration connections, unsuccessful mutation and hung requests", async () => {
  for (const data of [
    { id: "wrong", connections: [] },
    { id: "physicalsystems-v2-vault-fixture", connections: [{ type: "env", name: "PRIVATE_ENV" }] },
    { id: "physicalsystems-v2-vault-fixture", connections: [{ type: "credential", id: "cred_existing" }] },
    { id: "physicalsystems-v2-vault-fixture", connections: [{ type: "credential", id: "../../wrong" }] },
  ]) {
    let writes = 0
    await expect(
      createNativeV2CredentialProbe().save(async (_, init) => {
        if (init.method !== "GET") writes++
        return { data }
      }),
    ).rejects.toThrow("V2_CREDENTIAL_PROBE_SAVE_PREFLIGHT_UNCONFIRMED")
    expect(writes).toBe(0)
  }
  const probe = createNativeV2CredentialProbe({ timeoutMs: 5 })
  let aborted: AbortSignal | undefined
  await expect(
    probe.save(async (_, init) => {
      aborted = init.signal
      return new Promise(() => {})
    }),
  ).rejects.toThrow("V2_CREDENTIAL_PROBE_SAVE_PREFLIGHT_UNCONFIRMED")
  expect(aborted?.aborted).toBe(true)
  await expect(
    createNativeV2CredentialProbe().save(async (_, init) =>
      init.method === "GET"
        ? { data: { id: "physicalsystems-v2-vault-fixture", methods: [{ type: "key" }], connections: [] } }
        : false,
    ),
  ).rejects.toThrow("V2_CREDENTIAL_PROBE_SAVE_WRITE_UNCONFIRMED")
})

test("V2 inspection detects complete and chunk-split plaintext canaries in SQLite, WAL and rollback journal", async () => {
  const f = await fixture()
  try {
    await f.probe.save(f.request)
    for (const suffix of ["", "-wal", "-journal"]) {
      for (const encoding of ["utf8", "utf16le"] as const) {
        await writeFile(
          f.database + suffix,
          Buffer.concat([Buffer.alloc(65530), Buffer.from(f.state.canary, encoding), Buffer.alloc(20)]),
        )
        await expect(f.probe.inspectFiles(f.root, { databaseName: "opencode.db" })).rejects.toThrow(
          "V2_CREDENTIAL_PROBE_STORAGE_UNCONFIRMED",
        )
        await writeFile(f.database + suffix, "inert cleared byte-scan fixture")
      }
    }
    const result = await f.probe.inspectFiles(f.root, { databaseName: "opencode.db" })
    expect(result.inspected.map((file) => file.kind)).toEqual(["database", "wal", "journal"])
    expect(JSON.stringify(result)).not.toContain(f.state.canary)
  } finally {
    await f.close()
  }
})

test("V2 inspection fails closed on missing/oversized databases and symlinked WAL or directories", async () => {
  const f = await fixture()
  try {
    await f.probe.save(f.request)
    await expect(f.probe.inspectFiles(f.root, { databaseName: "../opencode.db" })).rejects.toThrow("UNCONFIRMED")
    await rm(f.database)
    await expect(f.probe.inspectFiles(f.root, { databaseName: "opencode.db" })).rejects.toThrow("UNCONFIRMED")
    await writeFile(f.database, "fixture")
    await truncate(f.database, 64 * 1024 * 1024 + 1)
    await expect(f.probe.inspectFiles(f.root, { databaseName: "opencode.db" })).rejects.toThrow("UNCONFIRMED")
    await writeFile(f.database, "fixture")
    await symlink(f.database, f.database + "-wal", "file")
    await expect(f.probe.inspectFiles(f.root, { databaseName: "opencode.db" })).rejects.toThrow("UNCONFIRMED")
    await rm(f.database + "-wal")
    await rm(join(f.root, "data/opencode"), { recursive: true })
    await mkdir(join(f.root, "other"))
    await symlink(join(f.root, "other"), join(f.root, "data/opencode"), "junction")
    await expect(f.probe.inspectFiles(f.root, { databaseName: "opencode.db" })).rejects.toThrow("UNCONFIRMED")
  } finally {
    await f.close()
  }
})

test("first save waits for registered key method and delayed readback without duplicating its write", async () => {
  const probe = createNativeV2CredentialProbe({ timeoutMs: 500, providerID: "openai" })
  let beforeReads = 0,
    afterReads = 0,
    writes = 0
  await probe.save(async (_route, init) => {
    if (init.method === "POST") {
      writes++
      return undefined
    }
    if (!writes) beforeReads++
    else afterReads++
    return {
      data: {
        id: "openai",
        methods: beforeReads >= 3 ? [{ type: "key" }] : [],
        connections: writes && afterReads >= 2 ? [{ type: "credential", id: "cred_inert" }] : [],
      },
    }
  })
  expect(writes).toBe(1)
  expect(probe.saveCheckpoint()).toEqual({ phase: "complete", readinessReads: 3, readbackReads: 2, writes: 1 })
  await expect(
    probe.save(async () => {
      writes++
      return undefined
    }),
  ).rejects.toThrow("SAVE_WRITE_UNCONFIRMED")
  expect(writes).toBe(1)
})

test("missing key method, failed write and stored-but-unobserved readback retain distinct failed save phases", async () => {
  for (const kind of ["method", "write", "readback"]) {
    const probe = createNativeV2CredentialProbe({ timeoutMs: 20, providerID: "openai" })
    let writes = 0
    await expect(
      probe.save(async (_route, init) => {
        if (init.method === "POST") {
          writes++
          if (kind === "write") throw new Error("PRIVATE-HTTP-504")
          return undefined
        }
        return { data: { id: "openai", methods: kind === "method" ? [] : [{ type: "key" }], connections: [] } }
      }),
    ).rejects.toThrow(`V2_CREDENTIAL_PROBE_SAVE_${kind.toUpperCase()}_UNCONFIRMED`)
    expect(writes).toBe(kind === "method" ? 0 : 1)
    expect(probe.saveCheckpoint().phase).toBe(kind)
    await expect(
      probe.save(async () => {
        writes++
        return undefined
      }),
    ).rejects.toThrow("SAVE_WRITE_UNCONFIRMED")
    expect(writes).toBe(kind === "method" ? 0 : 1)
  }
})

test("only legitimate integration registration absence is retryable before the single save", async () => {
  const probe = createNativeV2CredentialProbe({ timeoutMs: 300, providerID: "openai" })
  let reads = 0,
    writes = 0
  const request: V2CredentialProbeRequest = async (_route, init) => {
    if (init.method === "POST") {
      writes++
      return
    }
    reads++
    return JSON.parse(
      JSON.stringify({
        location: { directory: "/owned/inert-fixture" },
        data:
          reads < 3
            ? undefined
            : {
                id: "openai",
                methods: [{ type: "key" }],
                connections: writes ? [{ type: "credential", id: "cred_inert" }] : [],
              },
      }),
    )
  }
  await probe.save(request)
  expect(writes).toBe(1)
  expect(probe.saveCheckpoint()).toEqual({ phase: "complete", readinessReads: 3, readbackReads: 1, writes: 1 })
  expect(await probe.savedConnectionReady(async () => ({ location: { directory: "/owned/inert-fixture" } }))).toBe(
    false,
  )
  await expect(probe.remove(async () => ({ location: { directory: "/owned/inert-fixture" } }))).rejects.toThrow(
    "AUTH_UNCONFIRMED",
  )
  for (const value of [{}, { location: { directory: "/owned" }, data: null }, { data: {} }]) {
    await expect(
      createNativeV2CredentialProbe({ timeoutMs: 20, providerID: "openai" }).save(async () => value),
    ).rejects.toThrow("SAVE_PREFLIGHT_UNCONFIRMED")
  }
  const never = createNativeV2CredentialProbe({ timeoutMs: 20, providerID: "openai" })
  await expect(never.save(async () => ({ location: { directory: "/owned/inert-fixture" } }))).rejects.toThrow(
    "SAVE_PREFLIGHT_UNCONFIRMED",
  )
  expect(never.saveCheckpoint().writes).toBe(0)
})
