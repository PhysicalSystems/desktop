// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCredentialVault } from "../credentials"
import { createNativeCredentialProbe, waitForCredentialAttachment } from "./native-credentials"
import type { CredentialProbeRequest } from "./native-credentials"
import { saveAttachment } from "../attachment"

test("attachment wait admits a delayed atomic write for the exact owned process/session only", async () => {
  const root = await mkdtemp(join(tmpdir(), "credential-attachment-fixture-"))
  const file = join(root, "runtime-attach.json")
  const base = {
    schemaVersion: 1 as const,
    url: "http://127.0.0.1:43125",
    username: "opencode" as const,
    password: "private-attachment-fixture-".repeat(3),
    pid: process.pid,
  }
  const expected = { pid: process.pid, sessionId: "ses_fixture", directory: root }
  try {
    await saveAttachment(file, base)
    const waiting = waitForCredentialAttachment(file, expected, { timeoutMs: 500, pollMs: 2 })
    await new Promise((resolve) => setTimeout(resolve, 10))
    await saveAttachment(file, { ...base, ...expected })
    expect((await waiting).sessionId).toBe(expected.sessionId)
    await expect(
      waitForCredentialAttachment(file, { ...expected, sessionId: "ses_stale" }, { timeoutMs: 10, pollMs: 2 }),
    ).rejects.toThrow("PACKAGED_ATTACHMENT_UNCONFIRMED")
    await expect(
      waitForCredentialAttachment(file, { ...expected, pid: process.pid + 1 }, { timeoutMs: 10, pollMs: 2 }),
    ).rejects.toThrow("PACKAGED_ATTACHMENT_OWNER_INVALID")
    await writeFile(file, "private-malformed-attachment-trap", { mode: 0o600 })
    await expect(waitForCredentialAttachment(file, expected, { timeoutMs: 10, pollMs: 2 })).rejects.toThrow(
      "PACKAGED_ATTACHMENT_OWNER_INVALID",
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "credential-probe-synthetic-"))
  await mkdir(join(root, "operator"))
  const file = join(root, "operator/provider-credentials.enc")
  // Deliberate test cipher; these tests never call Electron, DPAPI or a keyring.
  const vault = createCredentialVault(file, {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "fixture",
    encryptString: (text) => Buffer.from(Buffer.from(text).map((byte) => byte ^ 91)),
    decryptString: (bytes) => Buffer.from(bytes.map((byte) => byte ^ 91)).toString(),
  })
  const probe = createNativeCredentialProbe()
  let canary = ""
  const request: CredentialProbeRequest = async (route, init) => {
    expect(route).toBe(`/auth/${probe.providerID}`)
    if (init.method === "PUT") {
      canary = init.body!.key
      await vault.request("set", { key: probe.providerID, info: init.body! })
    } else await vault.request("remove", { key: probe.providerID })
    return true
  }
  return { root, file, probe, request, vault, canary: () => canary }
}

test("probe uses existing PUT/DELETE auth only and never exposes a credential-reading interface", async () => {
  const probe = createNativeCredentialProbe()
  const calls: { route: string; init: Parameters<CredentialProbeRequest>[1] }[] = []
  const request: CredentialProbeRequest = async (route, init) => {
    calls.push({ route, init })
    return true
  }
  await probe.save(request)
  await probe.remove(request)
  expect(calls.map((call) => [call.route, call.init.method])).toEqual([
    ["/auth/physicalsystems-vault-fixture", "PUT"],
    ["/auth/physicalsystems-vault-fixture", "DELETE"],
  ])
  const secret = calls[0]!.init.body!.key
  expect(secret).toMatch(/^ps-native-probe-[a-f0-9]{64}$/)
  expect(calls[0]!.init.body!.type).toBe("api")
  expect(calls[1]!.init.body).toBeUndefined()
  expect(JSON.stringify(probe)).toBe('{"providerID":"physicalsystems-vault-fixture"}')
  expect(JSON.stringify(probe)).not.toContain(secret)
})

test("only fresh nonce requests prove observed credential retrieval or absence", async () => {
  const probe = createNativeCredentialProbe()
  let secret = ""
  await probe.save(async (_, init) => {
    secret = init.body!.key
    return true
  })
  expect(() => probe.finishObservation()).toThrow("UNCONFIRMED")
  const first = probe.beginObservation("present")
  expect(() => probe.beginObservation("absent")).toThrow("PENDING")
  expect(
    probe.observeProviderRequest({
      authorization: `Bearer ${secret}`,
      messages: [{ role: "assistant", content: first }],
    }),
  ).toBe(false)
  expect(
    probe.observeProviderRequest({
      authorization: `Bearer ${secret}`,
      messages: [{ role: "user", content: `${first} extra` }],
    }),
  ).toBe(false)
  expect(() => probe.finishObservation()).toThrow("UNCONFIRMED")

  const current = probe.beginObservation("present")
  expect(current).not.toBe(first)
  expect(
    probe.observeProviderRequest({ authorization: `Bearer ${secret}`, messages: [{ role: "user", content: first }] }),
  ).toBe(false)
  expect(
    probe.observeProviderRequest({
      authorization: `Bearer ${secret}`,
      messages: [{ role: "user", content: [{ type: "text", text: current }] }],
    }),
  ).toBe(true)
  const result = probe.finishObservation()
  expect(result).toEqual({ requestObserved: true, authorizationMatched: true, authorizationAbsent: false })
  expect(JSON.stringify(result)).not.toContain(secret)
  expect(JSON.stringify(result)).not.toContain(current)
  expect(JSON.stringify(result)).not.toContain("PASS")

  for (const authorization of [undefined, "Bearer wrong", `Bearer ${secret}x`, "x".repeat(513)]) {
    const prompt = probe.beginObservation("present")
    probe.observeProviderRequest({ authorization, messages: [{ role: "user", content: prompt }] })
    expect(() => probe.finishObservation()).toThrow("UNCONFIRMED")
  }
  const removed = probe.beginObservation("absent")
  probe.observeProviderRequest({ authorization: `Bearer ${secret}`, messages: [{ role: "user", content: removed }] })
  expect(() => probe.finishObservation()).toThrow("UNCONFIRMED")
  const absent = probe.beginObservation("absent")
  probe.observeProviderRequest({ authorization: undefined, messages: [{ role: "user", content: absent }] })
  expect(probe.finishObservation()).toEqual({
    requestObserved: true,
    authorizationMatched: false,
    authorizationAbsent: true,
  })
  const mixed = probe.beginObservation("present")
  for (const authorization of [`Bearer ${secret}`, "wrong"])
    probe.observeProviderRequest({ authorization, messages: [{ role: "user", content: mixed }] })
  expect(() => probe.finishObservation()).toThrow("UNCONFIRMED")
})

test("private app log filtering removes canaries split across arbitrary UTF-8 or UTF-16 chunks", async () => {
  const probe = createNativeCredentialProbe()
  let canary = ""
  await probe.save(async (_, init) => {
    canary = init.body!.key
    return true
  })
  for (const encoding of ["utf8", "utf16le"] as const) {
    const filter = probe.logFilter()
    const output: Buffer[] = []
    filter.on("data", (chunk) => output.push(chunk))
    const ended = new Promise<void>((resolve) => filter.once("end", resolve))
    const data = Buffer.concat([
      Buffer.from("safe-prefix\n"),
      Buffer.from(canary, encoding),
      Buffer.from("\nsafe-suffix"),
    ])
    for (let offset = 0; offset < data.length; offset += 7) filter.write(data.subarray(offset, offset + 7))
    filter.end()
    await ended
    const bytes = Buffer.concat(output)
    expect(bytes.includes(Buffer.from(canary, encoding))).toBe(false)
    expect(bytes.toString()).toContain("[credential omitted]")
    expect(bytes.toString()).toContain("safe-prefix\n")
    expect(bytes.toString()).toContain("\nsafe-suffix")
  }
})

test("dedicated inert HTTP provider records auth observations without returning credentials or synthetic tools", async () => {
  const { startFixtureProvider } = await import(new URL("../../test/fixture-provider.mjs", import.meta.url).href)
  const probe = createNativeCredentialProbe()
  let canary = ""
  await probe.save(async (_, init) => {
    canary = init.body!.key
    return true
  })
  const provider = await startFixtureProvider({ credentialProbe: probe })
  try {
    for (const present of [true, false]) {
      const prompt = probe.beginObservation(present ? "present" : "absent")
      const response = await fetch(`${provider.credentialURL}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(present ? { Authorization: `Bearer ${canary}` } : {}) },
        body: JSON.stringify({
          messages: [{ role: "user", content: prompt }],
          tools: [{ type: "function", function: { name: "propose_local_experiment" } }],
        }),
      })
      expect(response.ok).toBe(true)
      const text = await response.text()
      expect(text).not.toContain(canary)
      expect(text).not.toContain(prompt)
      expect(text).not.toContain("tool_calls")
      expect(probe.finishObservation().authorizationMatched).toBe(present)
    }
    expect(JSON.stringify(provider.calls)).not.toContain(canary)
    expect(provider.calls.every((call: { tool: unknown }) => call.tool === null)).toBe(true)
  } finally {
    await provider.close()
  }
})

test("fixed file inspection records bounded observations and no plaintext credential or native PASS", async () => {
  const f = await fixture()
  try {
    await f.probe.save(f.request)
    const saved = await f.probe.inspectFiles(f.root)
    expect(saved.vaultPresent).toBe(true)
    expect(saved.vaultBytes).toBeGreaterThan(0)
    expect(saved.vaultSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(saved.canaryAbsentFromVaultBytes).toBe(true)
    expect(saved.legacyAuthFileAbsent).toBe(true)
    expect(JSON.stringify(saved)).not.toContain(f.canary())
    expect(JSON.stringify(saved)).not.toContain(f.root)
    expect(JSON.stringify(saved)).not.toContain("PASS")
    await f.probe.remove(f.request)
    expect(await f.vault.request("all", {})).toEqual({})
    expect((await f.probe.inspectFiles(f.root)).vaultSha256).not.toBe(saved.vaultSha256)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test("plaintext, legacy auth, changed write state and oversized vaults fail without exposing contents", async () => {
  const f = await fixture()
  try {
    await f.probe.save(f.request)
    const original = await readFile(f.file)
    for (const bytes of [Buffer.from(f.canary()), Buffer.from(f.canary(), "utf16le"), Buffer.alloc(1024 ** 2 + 1)]) {
      await writeFile(f.file, bytes)
      await expect(f.probe.inspectFiles(f.root)).rejects.toThrow("CREDENTIAL_PROBE_STORAGE_UNCONFIRMED")
      expect(await readFile(f.file)).toEqual(bytes)
    }
    await writeFile(f.file, original)
    const temporary = `${f.file}.unconfirmed.tmp`
    await writeFile(temporary, "fixture")
    await expect(f.probe.inspectFiles(f.root)).rejects.toThrow("UNCONFIRMED")
    await rm(temporary)
    await mkdir(join(f.root, "data/opencode"), { recursive: true })
    const legacy = join(f.root, "data/opencode/auth.json")
    await writeFile(legacy, JSON.stringify({ fixture: { key: f.canary() } }))
    await expect(f.probe.inspectFiles(f.root)).rejects.toThrow("UNCONFIRMED")
    expect(await readFile(legacy, "utf8")).toContain(f.canary())
    expect(await readFile(f.file)).toEqual(original)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test.skipIf(process.platform === "win32")(
  "file inspection rejects symlink roots, vaults and legacy parents without following them",
  async () => {
    const f = await fixture()
    const elsewhere = await mkdtemp(join(tmpdir(), "credential-probe-excluded-"))
    try {
      await f.probe.save(f.request)
      await symlink(f.root, join(elsewhere, "profile"))
      await expect(f.probe.inspectFiles(join(elsewhere, "profile"))).rejects.toThrow("UNCONFIRMED")
      await symlink(elsewhere, join(f.root, "data"))
      await expect(f.probe.inspectFiles(f.root)).rejects.toThrow("UNCONFIRMED")
      await rm(join(f.root, "data"))
      const privateFile = join(elsewhere, "private-file")
      await writeFile(privateFile, "excluded fixture")
      await rm(f.file)
      await symlink(privateFile, f.file)
      await expect(f.probe.inspectFiles(f.root)).rejects.toThrow("UNCONFIRMED")
      expect(await readFile(privateFile, "utf8")).toBe("excluded fixture")
    } finally {
      await rm(f.root, { recursive: true, force: true })
      await rm(elsewhere, { recursive: true, force: true })
    }
  },
)

test("auth failures and timeouts are bounded, sanitized and never retried", async () => {
  const probe = createNativeCredentialProbe({ timeoutMs: 5 })
  let calls = 0
  await expect(
    probe.save(async (_, init) => {
      calls++
      throw new Error(`private=${init.body!.key}`)
    }),
  ).rejects.toThrow("CREDENTIAL_PROBE_AUTH_UNCONFIRMED")
  expect(calls).toBe(1)
  for (const value of [false, undefined, { saved: true }])
    await expect(probe.remove(async () => value)).rejects.toThrow("UNCONFIRMED")
  let signal: AbortSignal | undefined
  await expect(
    probe.save(async (_, init) => {
      calls++
      signal = init.signal
      return new Promise(() => {})
    }),
  ).rejects.toThrow("UNCONFIRMED")
  expect(signal?.aborted).toBe(true)
  expect(calls).toBe(2)
  for (const timeoutMs of [0, -1, 6501, NaN])
    expect(() => createNativeCredentialProbe({ timeoutMs })).toThrow("INVALID")
})
