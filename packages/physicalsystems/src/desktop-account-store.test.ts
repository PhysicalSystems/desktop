// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rename, rm, rmdir, stat } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import { tmpdir } from "node:os"
import { createDesktopAccountStore } from "./desktop-account-store"

const roots: string[] = []
afterEach(async () => {
  for (const directory of roots.splice(0)) {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep + "desktop-logout-"))
      throw new Error("Unexpected fixture directory")
    await rm(directory, { recursive: true, force: true })
  }
})

test("failed vault deletion leaves a durable logout tombstone that blocks restored credentials until a new safe journal replaces them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "desktop-logout-"))
  roots.push(directory)
  let available = true
  let decryptions = 0
  const encryption = {
    isEncryptionAvailable: () => available,
    encryptString: (value: string) => Buffer.from(Buffer.from(value).map((byte) => byte ^ 91)),
    decryptString: (value: Buffer) => {
      decryptions++
      return Buffer.from(value.map((byte) => byte ^ 91)).toString()
    },
  }
  const store = createDesktopAccountStore(directory, encryption)
  const old = {
    version: 1,
    managed: true,
    session: { accountId: "fixture-old-account", refreshToken: "fixture-secret" },
  }
  await store.markManaged()
  await store.set(old)
  const file = join(directory, "desktop-account.enc"),
    retained = join(directory, "retained.enc")
  expect((await readFile(file)).includes(Buffer.from("fixture-secret"))).toBe(false)
  // A directory at the exact vault path gives a deterministic real filesystem
  // unlink failure on Windows and Linux. Preserve the old encrypted bytes, then
  // restore them to model a locked vault remaining after the failure.
  await rename(file, retained)
  await mkdir(file)
  available = false
  await expect(store.clear()).rejects.toThrow()
  expect(await readFile(join(directory, "desktop-account.signed-out"), "utf8")).toBe("1\n")
  await rmdir(file)
  await rename(retained, file)
  const restarted = createDesktopAccountStore(directory, encryption)
  const before = decryptions
  expect(await restarted.managed()).toBe(true)
  expect(await restarted.get()).toBeNull()
  expect(decryptions).toBe(before)
  const next = { version: 1, managed: true }
  await expect(restarted.set(next)).rejects.toThrow("UNAVAILABLE")
  expect(await restarted.get()).toBeNull()
  available = true
  await restarted.set(next)
  expect(await restarted.get()).toEqual(next)
  await expect(stat(join(directory, "desktop-account.signed-out"))).rejects.toThrow()
  expect(await restarted.managed()).toBe(true)
  await restarted.clear()
  expect(await createDesktopAccountStore(directory, encryption).get()).toBeNull()
})
