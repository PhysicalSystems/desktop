// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { captureOwnedBrowserDirectory, removeOwnedBrowserDirectory } from "./owned-browser-directory"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "browser-directory-fixture-")))
  roots.push(parent)
  const root = join(parent, "owned")
  await mkdir(root)
  const identity = await captureOwnedBrowserDirectory(root)
  await writeFile(join(root, "private-state"), "INERT PRIVATE FIXTURE")
  return { parent, root, identity }
}
const denied = (code = "EACCES") => Object.assign(Error("PRIVATE PATH AND ERROR TRAP"), { code })

test("actual directory IDs survive content changes and distinguish replacement on the executing host", async () => {
  // Runs unchanged on hosted Windows: verifies real Bun dev/ino support with
  // inert directories, without any browser, keyring or native subprocess.
  const f = await fixture()
  const current = await lstat(f.root, { bigint: true })
  expect(typeof f.identity.dev).toBe("bigint")
  expect(f.identity.ino).toBeGreaterThan(0n)
  expect(current.dev).toBe(f.identity.dev)
  expect(current.ino).toBe(f.identity.ino)
  await rename(f.root, join(f.parent, "retained-original"))
  await mkdir(f.root)
  expect((await lstat(f.root, { bigint: true })).ino).not.toBe(f.identity.ino)
  let deletes = 0
  await expect(
    removeOwnedBrowserDirectory(f.identity, {
      remove: async () => {
        deletes++
      },
    }),
  ).rejects.toThrow("CLEANUP_UNCONFIRMED")
  expect(deletes).toBe(0)
})

test("a transient denial retries the same captured root and confirms real absence", async () => {
  const f = await fixture()
  let attempts = 0
  const waits: number[] = []
  const removal = removeOwnedBrowserDirectory(f.identity, {
    remove: async (root, options) => {
      expect(root).toBe(f.root)
      expect(options).toEqual({ recursive: true })
      if (++attempts === 1) throw denied()
      await rm(root, options)
    },
    wait: async (ms) => {
      waits.push(ms)
    },
  })
  expect(removeOwnedBrowserDirectory(f.identity)).toBe(removal)
  await removal
  expect(attempts).toBe(2)
  expect(waits).toEqual([100])
  await expect(lstat(f.root)).rejects.toMatchObject({ code: "ENOENT" })
})

test("persistent denials exhaust one finite budget without exposing native errors or deleting retained files", async () => {
  for (const errno of ["EACCES", "EPERM", "EBUSY", "ENOTEMPTY"]) {
    const f = await fixture()
    let attempts = 0
    const waits: number[] = []
    const removal = removeOwnedBrowserDirectory(f.identity, {
      remove: async () => {
        attempts++
        throw denied(errno)
      },
      wait: async (ms) => {
        waits.push(ms)
      },
    })
    const error = await removal.catch((error: unknown) => error)
    expect(error).toMatchObject({ message: "PROVIDER_REVIEW_BROWSER_CLEANUP_UNCONFIRMED", code: errno })
    expect(String(error)).not.toContain("PRIVATE")
    expect(attempts).toBe(4)
    expect(waits).toEqual([100, 200, 400])
    expect(removeOwnedBrowserDirectory(f.identity)).toBe(removal)
    expect(await readFile(join(f.root, "private-state"), "utf8")).toBe("INERT PRIVATE FIXTURE")
  }
})

test("unknown failures and a successful rm without ENOENT readback never authorize completion or retry", async () => {
  for (const mode of ["unknown", "still-present", "readback-denied", "rm-child-absent"] as const) {
    const f = await fixture()
    let attempts = 0
    await expect(
      removeOwnedBrowserDirectory(f.identity, {
        remove: async () => {
          attempts++
          if (mode === "unknown") throw denied("PRIVATE_UNKNOWN")
          if (mode === "rm-child-absent") throw denied("ENOENT")
        },
        stat: async (path) => {
          if (attempts && mode === "readback-denied") throw denied()
          return lstat(path, { bigint: true })
        },
        wait: async () => {
          throw Error("MUST NOT RETRY")
        },
      }),
    ).rejects.toThrow("CLEANUP_UNCONFIRMED")
    expect(attempts).toBe(1)
    await lstat(f.root)
  }
})

test("replacement or a symlink between attempts stops before deleting the new path", async () => {
  for (const replace of ["directory", "symlink"] as const) {
    const f = await fixture()
    const outside = join(f.parent, "outside")
    await mkdir(outside)
    await writeFile(join(outside, "sentinel"), "DO NOT REMOVE")
    let attempts = 0
    await expect(
      removeOwnedBrowserDirectory(f.identity, {
        remove: async () => {
          attempts++
          throw denied()
        },
        wait: async () => {
          await rename(f.root, join(f.parent, "retained-original"))
          if (replace === "directory") await mkdir(f.root)
          else await symlink(outside, f.root, "junction")
        },
      }),
    ).rejects.toThrow("CLEANUP_UNCONFIRMED")
    expect(attempts).toBe(1)
    expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("DO NOT REMOVE")
    expect(await readFile(join(f.parent, "retained-original", "private-state"), "utf8")).toBe("INERT PRIVATE FIXTURE")
  }
})

test("uncaptured or unusable identity and root symlinks cannot grant deletion authority", async () => {
  const f = await fixture()
  let deletes = 0
  await expect(
    removeOwnedBrowserDirectory(
      { ...f.identity },
      {
        remove: async () => {
          deletes++
        },
      },
    ),
  ).rejects.toThrow("CLEANUP_UNCONFIRMED")
  expect(deletes).toBe(0)
  const linked = join(f.parent, "link")
  await symlink(f.root, linked, "junction")
  await expect(captureOwnedBrowserDirectory(linked)).rejects.toThrow("CLEANUP_UNCONFIRMED")
  await expect(
    captureOwnedBrowserDirectory(f.root, {
      stat: async (path) => Object.assign(await lstat(path, { bigint: true }), { ino: 0n }),
    }),
  ).rejects.toThrow("CLEANUP_UNCONFIRMED")
})

test("replaced parent directories and parent junctions cannot authorize another deletion or false absence", async () => {
  for (const replace of ["directory", "junction"] as const) {
    const f = await fixture()
    const retained = `${f.parent}-retained`
    roots.push(retained)
    const foreign = await realpath(await mkdtemp(join(tmpdir(), "browser-directory-foreign-")))
    roots.push(foreign)
    await writeFile(join(foreign, "sentinel"), "DO NOT REMOVE")
    let attempts = 0
    await expect(
      removeOwnedBrowserDirectory(f.identity, {
        remove: async () => {
          attempts++
          throw denied()
        },
        wait: async () => {
          await rename(f.parent, retained)
          if (replace === "directory") await mkdir(f.parent)
          else await symlink(foreign, f.parent, "junction")
        },
      }),
    ).rejects.toThrow("CLEANUP_UNCONFIRMED")
    expect(attempts).toBe(1)
    expect(await readFile(join(retained, "owned", "private-state"), "utf8")).toBe("INERT PRIVATE FIXTURE")
    expect(await readFile(join(foreign, "sentinel"), "utf8")).toBe("DO NOT REMOVE")
  }
})

test("a nested directory link is removed without following it into foreign state", async () => {
  const f = await fixture()
  const outside = join(f.parent, "outside")
  await mkdir(outside)
  await writeFile(join(outside, "sentinel"), "DO NOT REMOVE")
  await symlink(outside, join(f.root, "foreign-link"), "junction")
  await removeOwnedBrowserDirectory(f.identity)
  expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("DO NOT REMOVE")
  await expect(lstat(f.root)).rejects.toMatchObject({ code: "ENOENT" })
})

test("zero device IDs are supported and 64-bit file identities are never rounded", async () => {
  const f = await fixture()
  const zeroDevice = async (path: string) => Object.assign(await lstat(path, { bigint: true }), { dev: 0n })
  const identity = await captureOwnedBrowserDirectory(f.root, { stat: zeroDevice })
  expect(identity.dev).toBe(0n)
  await removeOwnedBrowserDirectory(identity, { stat: zeroDevice })
  await expect(lstat(f.root)).rejects.toMatchObject({ code: "ENOENT" })

  const other = await fixture()
  const large = 2n ** 60n
  const captureStat = async (path: string) =>
    Object.assign(await lstat(path, { bigint: true }), path === other.root ? { ino: large + 1n } : {})
  const largeIdentity = await captureOwnedBrowserDirectory(other.root, { stat: captureStat })
  let deletes = 0
  await expect(
    removeOwnedBrowserDirectory(largeIdentity, {
      stat: async (path) =>
        Object.assign(await lstat(path, { bigint: true }), path === other.root ? { ino: large + 2n } : {}),
      remove: async () => {
        deletes++
      },
    }),
  ).rejects.toThrow("CLEANUP_UNCONFIRMED")
  expect(deletes).toBe(0)
})
