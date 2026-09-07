// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCredentialVault } from "./credentials"

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
async function fixture(available = true, backend = "test") {
  const dir = await mkdtemp(join(tmpdir(), "physical-vault-test-")); dirs.push(dir)
  const file = join(dir, "provider.enc")
  // Test cipher only. Native safeStorage is used in the application.
  const encryption = { isEncryptionAvailable: () => available, getSelectedStorageBackend: () => backend,
    encryptString: (text: string) => Buffer.from(Buffer.from(text).map((byte) => byte ^ 91)),
    decryptString: (value: Buffer) => Buffer.from(value.map((byte) => byte ^ 91)).toString() }
  return { dir, file, vault: createCredentialVault(file, encryption) }
}

test("keys persist only encrypted and concurrent changes are serialized", async () => {
  const { file, vault } = await fixture()
  await Promise.all([vault.request("set", { key: "provider-a", info: { type: "api", key: "fixture-secret-a" } }), vault.request("set", { key: "provider-b", info: { type: "api", key: "fixture-secret-b" } })])
  expect((await readFile(file)).toString()).not.toContain("fixture-secret")
  expect((await stat(file)).mode & 0o777).toBe(0o600)
  expect(Object.keys(await vault.request("all", {}))).toEqual(["provider-a", "provider-b"])
  await vault.request("remove", { key: "provider-a" })
  expect(Object.keys(await vault.request("all", {}))).toEqual(["provider-b"])
})

test("missing native encryption never falls back to plaintext", async () => {
  for (const [available, backend] of [[false, "test"], [true, "basic_text"]] as const) {
    const { vault, file } = await fixture(available, backend)
    expect(await vault.request("all", {})).toEqual({})
    await expect(vault.request("set", { key: "provider", info: { key: "secret" } })).rejects.toThrow("UNAVAILABLE")
    await expect(stat(file)).rejects.toThrow()
  }
})

test("redirected credential file and prototype keys are rejected", async () => {
  const { dir, file, vault } = await fixture()
  await expect(vault.request("set", { key: "__proto__", info: {} })).rejects.toThrow("INVALID")
  const original = join(dir, "original")
  await writeFile(original, "untouched")
  await symlink(original, file)
  await expect(vault.request("all", {})).rejects.toThrow("INVALID")
  expect(await readFile(original, "utf8")).toBe("untouched")
})
