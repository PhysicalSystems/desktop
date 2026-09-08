// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { captureOwnedBrowserDirectory, removeOwnedBrowserDirectory } from "./owned-browser-directory"
import { readBrowserObservation } from "./browser-observation"

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

test("failure observer receives captured anchors once after removal exhaustion and cannot satisfy cleanup", async () => {
  const f = await fixture()
  let attempts = 0
  let observations = 0
  const error = await removeOwnedBrowserDirectory(f.identity, {
    remove: async () => {
      attempts++
      throw denied()
    },
    wait: async () => {},
    observeFailure: async (anchors) => {
      observations++
      expect(attempts).toBe(4)
      expect(anchors.root).toEqual({ path: f.root, dev: f.identity.dev, ino: f.identity.ino })
      const parent = await lstat(f.parent, { bigint: true })
      expect(anchors.parent).toEqual({ path: f.parent, dev: parent.dev, ino: parent.ino })
      expect(Object.isFrozen(anchors.root)).toBe(true)
      expect(Object.isFrozen(anchors.parent)).toBe(true)
      return { directoryProbeStatus: "NOT_LOCALIZED", directoryProbeQuiescence: "confirmed" }
    },
  }).catch((error: unknown) => error)
  expect(error).toMatchObject({ code: "EACCES", message: "PROVIDER_REVIEW_BROWSER_CLEANUP_UNCONFIRMED" })
  expect(readBrowserObservation(error)).toMatchObject({
    directoryFailurePhase: "remove",
    directoryRemovalAttempt: 4,
    directoryProbeStatus: "NOT_LOCALIZED",
    directoryProbeQuiescence: "confirmed",
  })
  expect(observations).toBe(1)
  expect(attempts).toBe(4)
  expect(await readFile(join(f.root, "private-state"), "utf8")).toBe("INERT PRIVATE FIXTURE")
})

test("failure observer is not invoked after success or replacement of the captured root", async () => {
  for (const replaced of [false, true]) {
    const f = await fixture()
    if (replaced) {
      await rename(f.root, join(f.parent, "retained-original"))
      await mkdir(f.root)
    }
    let observations = 0
    const result = await removeOwnedBrowserDirectory(f.identity, {
      observeFailure: async () => {
        observations++
        return { directoryProbeStatus: "NOT_LOCALIZED" }
      },
    }).then(
      () => "removed",
      () => "retained",
    )
    expect(result).toBe(replaced ? "retained" : "removed")
    expect(observations).toBe(0)
  }
})

test("later absence during a failure diagnostic cannot turn exhausted removal into success", async () => {
  const f = await fixture()
  let attempts = 0
  const error = await removeOwnedBrowserDirectory(f.identity, {
    remove: async () => {
      attempts++
      throw denied()
    },
    wait: async () => {},
    observeFailure: async () => {
      await rm(f.root, { recursive: true })
      return { directoryProbeStatus: "NOT_LOCALIZED", directoryProbeQuiescence: "confirmed" }
    },
  }).catch((error: unknown) => error)
  expect(error).toMatchObject({ code: "EACCES", message: "PROVIDER_REVIEW_BROWSER_CLEANUP_UNCONFIRMED" })
  expect(attempts).toBe(4)
  await expect(lstat(f.root)).rejects.toMatchObject({ code: "ENOENT" })
})

test("observer exceptions and metadata cannot replace the original removal failure or expose private data", async () => {
  for (const mode of ["throw", "private", "override"] as const) {
    const f = await fixture()
    const error = await removeOwnedBrowserDirectory(f.identity, {
      remove: async () => {
        throw denied()
      },
      wait: async () => {},
      observeFailure: async () => {
        if (mode === "throw") throw Error("PRIVATE DIAGNOSTIC ERROR")
        if (mode === "private") return { directoryProbeStatus: "PRIVATE PATH" } as never
        return {
          directoryProbeStatus: "NOT_LOCALIZED",
          directoryProbeQuiescence: "confirmed",
          directoryFailurePhase: "absence-check",
          directoryRemovalAttempt: 1,
          privatePath: "PRIVATE PATH",
        }
      },
    }).catch((error: unknown) => error)
    expect(error).toMatchObject({ code: "EACCES" })
    expect(readBrowserObservation(error)).toMatchObject({ directoryFailurePhase: "remove", directoryRemovalAttempt: 4 })
    expect(JSON.stringify(readBrowserObservation(error))).not.toContain("PRIVATE")
    expect(await readFile(join(f.root, "private-state"), "utf8")).toBe("INERT PRIVATE FIXTURE")
  }
})

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

test("failed removal exposes bounded metadata and exact phase without following links or exposing names", async () => {
  const f = await fixture()
  const nested = join(f.root, "PRIVATE-DIRECTORY")
  const file = join(nested, "PRIVATE-FILENAME")
  await mkdir(nested)
  await writeFile(file, "PRIVATE-CONTENTS")
  await symlink(f.parent, join(f.root, "PRIVATE-LINK"), "junction")
  const enumerated: string[] = []
  let attempts = 0
  const error = await removeOwnedBrowserDirectory(f.identity, {
    remove: async () => {
      attempts++
      throw Object.assign(denied(), { syscall: "rm", path: file })
    },
    wait: async () => {},
    entries: async (path) => {
      enumerated.push(path)
      return readdir(path)
    },
    stat: async (path) => {
      const value = await lstat(path, { bigint: true })
      // Inert metadata seam: no native attribute or permission mutation.
      return path === file ? Object.assign(value, { mode: value.mode & ~0o222n }) : value
    },
  }).catch((error: unknown) => error)
  const observation = readBrowserObservation(error)
  expect(error).toMatchObject({ code: "EACCES" })
  expect(attempts).toBe(4)
  expect(observation).toMatchObject({
    directoryFailurePhase: "remove",
    directoryRemovalAttempt: 4,
    directorySyscall: "rm",
    directoryErrorPath: "descendant",
    directoryInventory: "complete",
    directoryEntries: 4,
    directoryDirectories: 1,
    directoryFiles: 2,
    directoryLinks: 1,
    directoryNonWritableMode: 1,
    directoryReadFailures: 0,
    directoryInventoryDepth: 2,
  })
  expect(enumerated).toEqual([f.root, nested])
  expect(JSON.stringify(observation)).not.toContain("PRIVATE")
  expect(String(error)).not.toContain(f.parent)
  expect(await readFile(file, "utf8")).toBe("PRIVATE-CONTENTS")
})

test("guard and post-removal failures retain distinct stages and diagnostics never mask original errors", async () => {
  for (const phase of ["parent-canonical", "parent-identity", "root-identity", "absence-check"] as const) {
    const f = await fixture()
    let removals = 0
    const error = await removeOwnedBrowserDirectory(f.identity, {
      canonical: async (path) => {
        if (phase === "parent-canonical") throw Object.assign(denied(), { syscall: "realpath", path })
        return realpath(path)
      },
      stat: async (path) => {
        if ((phase === "parent-identity" && path === f.parent) || (phase === "root-identity" && path === f.root))
          throw Object.assign(denied(), { syscall: "lstat", path })
        return lstat(path, { bigint: true })
      },
      remove: async () => {
        removals++
      },
    }).catch((error: unknown) => error)
    expect(readBrowserObservation(error)?.directoryFailurePhase).toBe(phase)
    expect(removals).toBe(phase === "absence-check" ? 1 : 0)
    if (phase !== "absence-check") {
      expect(error).toMatchObject({ code: "EACCES" })
      expect(readBrowserObservation(error)?.directoryInventory).toBe("identity-unconfirmed")
    }
  }
  const f = await fixture()
  const error = await removeOwnedBrowserDirectory(f.identity, {
    remove: async () => {
      throw Object.defineProperty(denied(), "path", {
        get() {
          throw Error("PRIVATE-GETTER")
        },
      })
    },
    wait: async () => {},
    entries: async () => {
      throw Error("PRIVATE-READ-ERROR")
    },
  }).catch((error: unknown) => error)
  expect(error).toMatchObject({ code: "EACCES" })
  expect(readBrowserObservation(error)).toMatchObject({
    directoryFailurePhase: "remove",
    directoryInventory: "read-failed",
    directoryReadFailures: 1,
  })
  expect(JSON.stringify(readBrowserObservation(error))).not.toContain("PRIVATE")
})

test("metadata inspection discards counts on replacement and bounds entries, depth and stalled reads", async () => {
  const f = await fixture()
  let childReads = 0
  const error = await removeOwnedBrowserDirectory(f.identity, {
    remove: async () => {
      throw denied()
    },
    wait: async () => {},
    entries: async () => {
      await rename(f.root, join(f.parent, "retained-original"))
      await mkdir(f.root)
      return ["PRIVATE-FOREIGN"]
    },
    stat: async (path) => {
      if (path.endsWith("PRIVATE-FOREIGN")) childReads++
      return lstat(path, { bigint: true })
    },
  }).catch((error: unknown) => error)
  expect(error).toMatchObject({ code: "EACCES" })
  expect(readBrowserObservation(error)).toMatchObject({ directoryInventory: "identity-unconfirmed" })
  expect(readBrowserObservation(error)?.directoryEntries).toBeUndefined()
  expect(childReads).toBe(0)

  const many = await fixture()
  const leaf = await lstat(join(many.root, "private-state"), { bigint: true })
  const full = await removeOwnedBrowserDirectory(many.identity, {
    remove: async () => {
      throw denied()
    },
    wait: async () => {},
    entries: async () => Array.from({ length: 129 }, (_, i) => `PRIVATE-${i}`),
    stat: async (path) => (path === many.root || path === many.parent ? lstat(path, { bigint: true }) : leaf),
  }).catch((error: unknown) => error)
  expect(readBrowserObservation(full)).toMatchObject({
    directoryInventory: "bounded",
    directoryEntries: 128,
    directoryFiles: 128,
  })

  const deep = await fixture()
  await mkdir(join(deep.root, "a/b/c/d/e"), { recursive: true })
  const depth = await removeOwnedBrowserDirectory(deep.identity, {
    remove: async () => {
      throw denied()
    },
    wait: async () => {},
  }).catch((error: unknown) => error)
  expect(readBrowserObservation(depth)).toMatchObject({ directoryInventory: "bounded", directoryInventoryDepth: 4 })

  const stalled = await fixture()
  const stats = new Map(
    await Promise.all([stalled.root, stalled.parent].map(async (p) => [p, await lstat(p, { bigint: true })] as const)),
  )
  let release!: (names: string[]) => void
  let reads = 0
  const result = await removeOwnedBrowserDirectory(stalled.identity, {
    remove: async () => {
      throw denied()
    },
    wait: async () => {},
    inventoryTimeoutMs: 20,
    canonical: async (path) => path,
    stat: async (path) => {
      reads++
      return stats.get(path)!
    },
    entries: async () =>
      new Promise<string[]>((resolve) => {
        release = resolve
      }),
  }).catch((error: unknown) => error)
  expect(result).toMatchObject({ code: "EACCES" })
  expect(readBrowserObservation(result)).toMatchObject({ directoryInventory: "bounded" })
  const completedReads = reads
  release(["PRIVATE-LATE-ENTRY"])
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(reads).toBe(completedReads)
})
