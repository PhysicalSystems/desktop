// SPDX-License-Identifier: Apache-2.0
import type { BigIntStats } from "node:fs"
import { lstat, readdir, realpath, rm } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { browserObservationError, readBrowserObservation, type BrowserObservation } from "./browser-observation"

export type DirectoryProbeObservation = Pick<
  BrowserObservation,
  Extract<keyof BrowserObservation, `directoryProbe${string}`>
>
export type OwnedBrowserDirectoryAnchors = Readonly<{
  root: Readonly<{ path: string; dev: bigint; ino: bigint }>
  parent: Readonly<{ path: string; dev: bigint; ino: bigint }>
}>

type IdentityStat = Pick<BigIntStats, "dev" | "ino" | "mode" | "isFile" | "isDirectory" | "isSymbolicLink">
type DirectoryIO = {
  stat?(path: string): Promise<IdentityStat>
  canonical?(path: string): Promise<string>
  remove?(path: string, options: { recursive: true }): Promise<void>
  wait?(milliseconds: number): Promise<void>
  entries?(path: string): Promise<string[]>
  inventoryTimeoutMs?: number
  observeFailure?(anchors: OwnedBrowserDirectoryAnchors): Promise<DirectoryProbeObservation>
}
export type OwnedBrowserDirectory = Readonly<{ root: string; dev: bigint; ino: bigint }>

const captured = new WeakMap<
  OwnedBrowserDirectory,
  { parent: string; parentDev: bigint; parentIno: bigint; removal?: Promise<void> }
>()
const delays = [0, 100, 200, 400] as const
const retryable = ["EACCES", "EPERM", "EBUSY", "ENOTEMPTY"]
const code = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code
const failure = (error?: unknown, observation?: BrowserObservation) => {
  const value = code(error)
  return Object.assign(
    browserObservationError(
      "PROVIDER_REVIEW_BROWSER_CLEANUP_UNCONFIRMED",
      undefined,
      observation ?? { browserPhase: "cleanup-profile" },
    ),
    {
      ...(value && [...retryable, "ENOENT", "ENOTDIR", "EIO"].includes(value) ? { code: value } : {}),
    },
  )
}
const stat = (path: string) => lstat(path, { bigint: true })
const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

function errorMetadata(error: unknown, root: string, parent: string): BrowserObservation {
  try {
    const value = error as NodeJS.ErrnoException | undefined
    const syscall = value?.syscall
    const path = value?.path
    let relation: BrowserObservation["directoryErrorPath"] = "absent"
    if (typeof path === "string") {
      relation = "other"
      if (isAbsolute(path) && !path.includes("\0")) {
        const normalized = resolve(path)
        const child = relative(root, normalized)
        relation =
          normalized === root
            ? "root"
            : normalized === parent
              ? "parent"
              : child &&
                  !isAbsolute(child) &&
                  child !== ".." &&
                  !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
                ? "descendant"
                : "other"
      }
    }
    return {
      directorySyscall:
        syscall === undefined
          ? "absent"
          : ["rm", "lstat", "realpath", "readdir"].includes(syscall)
            ? (syscall as "rm" | "lstat" | "realpath" | "readdir")
            : "other",
      directoryErrorPath: relation,
    }
  } catch {
    return { directorySyscall: "other", directoryErrorPath: "other" }
  }
}

/** Failure-only metadata, never profile bytes or deletion authority. Counts of
 * links and mode bits mean exactly what lstat reported; they do not establish
 * Windows readonly attributes, ACLs, retained handles or the denial's cause. */
async function remainingMetadata(identity: OwnedBrowserDirectory, io: DirectoryIO): Promise<BrowserObservation> {
  const owner = captured.get(identity)!
  const timeout = io.inventoryTimeoutMs ?? 1000
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 1000) return { directoryInventory: "bounded" }
  let active = true
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = Date.now() + timeout
  const bounded = Symbol("bounded")
  const unconfirmed = Symbol("identity")
  const call = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (!active || Date.now() >= deadline) throw bounded
    const value = await operation()
    if (!active || Date.now() >= deadline) throw bounded
    return value
  }
  const read = (path: string) => call(() => (io.stat ?? stat)(path))
  const canonical = (path: string) => call(() => (io.canonical ?? realpath)(path))
  type Anchor = { path: string; dev: bigint; ino: bigint }
  const anchors: Anchor[] = [
    { path: owner.parent, dev: owner.parentDev, ino: owner.parentIno },
    { path: identity.root, dev: identity.dev, ino: identity.ino },
  ]
  const guard = async (chain: Anchor[]) => {
    for (const expected of chain) {
      const current = await read(expected.path)
      if (
        !directory(current) ||
        current.dev !== expected.dev ||
        current.ino !== expected.ino ||
        (await canonical(expected.path)) !== expected.path
      )
        throw unconfirmed
    }
  }
  const scan = async (): Promise<BrowserObservation> => {
    const counts = {
      directoryEntries: 0,
      directoryDirectories: 0,
      directoryFiles: 0,
      directoryLinks: 0,
      directoryNonWritableMode: 0,
      directoryReadFailures: 0,
      directoryInventoryDepth: 0,
    }
    let limited = false
    const pending = [{ chain: anchors, depth: 0 }]
    try {
      await guard(anchors)
      while (pending.length) {
        const { chain, depth } = pending.shift()!
        await guard(chain)
        let names: string[]
        try {
          names = await call(() => (io.entries ?? readdir)(chain.at(-1)!.path))
        } catch (error) {
          if (error === bounded) throw error
          counts.directoryReadFailures = Math.min(128, counts.directoryReadFailures + 1)
          await guard(chain)
          continue
        }
        await guard(chain)
        for (const name of names) {
          if (counts.directoryEntries >= 128) {
            limited = true
            break
          }
          if (!name || name === "." || name === ".." || /[\\/\0]/.test(name)) throw unconfirmed
          const path = join(chain.at(-1)!.path, name)
          counts.directoryEntries++
          counts.directoryInventoryDepth = Math.max(counts.directoryInventoryDepth, depth + 1)
          let entry: IdentityStat
          try {
            entry = await read(path)
          } catch (error) {
            if (error === bounded) throw error
            counts.directoryReadFailures = Math.min(128, counts.directoryReadFailures + 1)
            continue
          }
          if (entry.isSymbolicLink()) {
            counts.directoryLinks++
            continue
          }
          if (entry.isFile()) {
            counts.directoryFiles++
            if (typeof entry.mode === "bigint" && (entry.mode & 0o222n) === 0n) counts.directoryNonWritableMode++
          } else if (entry.isDirectory()) {
            counts.directoryDirectories++
            if (!directory(entry)) throw unconfirmed
            if (depth + 1 >= 4) limited = true
            else pending.push({ chain: [...chain, { path, dev: entry.dev, ino: entry.ino }], depth: depth + 1 })
          }
        }
        await guard(chain)
        if (counts.directoryEntries >= 128) {
          limited ||= pending.length > 0
          break
        }
      }
      await guard(anchors)
      return {
        ...counts,
        directoryInventory: limited ? "bounded" : counts.directoryReadFailures ? "read-failed" : "complete",
      }
    } catch (error) {
      // Discard counts if final identity cannot be verified. A timeout can end
      // the diagnostic; a late read cannot schedule more filesystem work.
      return { directoryInventory: error === bounded ? "bounded" : "identity-unconfirmed" }
    }
  }
  try {
    return await Promise.race([
      scan(),
      new Promise<BrowserObservation>((resolve) => {
        timer = setTimeout(() => {
          active = false
          resolve({ directoryInventory: "bounded" })
        }, timeout)
      }),
    ])
  } finally {
    active = false
    clearTimeout(timer)
  }
}

function directory(value: IdentityStat) {
  // Bun 1.3.14's Windows lstat uses libuv, preserving its 64-bit device/file ID
  // through PosixStat. Use BigInts; a zero device is valid, but an unavailable
  // file ID cannot authorize deletion. Unix uid/nlink rules do not apply here.
  // https://github.com/oven-sh/bun/blob/bun-v1.3.14/src/sys/sys_uv.zig#L247
  // https://github.com/oven-sh/bun/blob/bun-v1.3.14/src/sys/PosixStat.zig#L39
  return (
    value.isDirectory() &&
    !value.isSymbolicLink() &&
    typeof value.dev === "bigint" &&
    value.dev >= 0n &&
    typeof value.ino === "bigint" &&
    value.ino > 0n
  )
}

/** Capture at the caller's already-validated empty disposable-root boundary,
 * before a browser/application can write there. This grants no process authority. */
export async function captureOwnedBrowserDirectory(root: string, io: DirectoryIO = {}): Promise<OwnedBrowserDirectory> {
  try {
    if (!isAbsolute(root) || resolve(root) !== root || dirname(root) === root || root.includes("\0")) throw failure()
    const parent = dirname(root)
    if ((await (io.canonical ?? realpath)(parent)) !== parent) throw failure()
    const parentBefore = await (io.stat ?? stat)(parent)
    if (!directory(parentBefore)) throw failure()
    const before = await (io.stat ?? stat)(root)
    if (!directory(before) || (await (io.canonical ?? realpath)(root)) !== root) throw failure()
    const after = await (io.stat ?? stat)(root)
    if (!directory(after) || after.dev !== before.dev || after.ino !== before.ino) throw failure()
    const parentAfter = await (io.stat ?? stat)(parent)
    if (!directory(parentAfter) || parentAfter.dev !== parentBefore.dev || parentAfter.ino !== parentBefore.ino)
      throw failure()
    const identity = Object.freeze({ root, dev: before.dev, ino: before.ino })
    captured.set(identity, { parent, parentDev: parentBefore.dev, parentIno: parentBefore.ino })
    return identity
  } catch (error) {
    throw failure(error)
  }
}

/** Call only after handoff/native helpers are quiescent, owned processes have
 * exited, and exact registration restoration is confirmed. Skip entirely when
 * retention is required. An EACCES retry does not establish its original cause. */
export function removeOwnedBrowserDirectory(identity: OwnedBrowserDirectory, io: DirectoryIO = {}): Promise<void> {
  const owner = captured.get(identity)
  if (!owner) return Promise.reject(failure())
  // A second call cannot silently renew the bounded retry budget after failure.
  return (owner.removal ??= remove())

  async function remove() {
    let phase: BrowserObservation["directoryFailurePhase"] = "parent-canonical"
    let removalAttempt = 0
    const read = async () => {
      phase = "parent-canonical"
      if ((await (io.canonical ?? realpath)(owner!.parent)) !== owner!.parent) throw failure()
      phase = "parent-identity"
      const parent = await (io.stat ?? stat)(owner!.parent)
      if (!directory(parent) || parent.dev !== owner!.parentDev || parent.ino !== owner!.parentIno) throw failure()
      phase = "root-identity"
      const current = await (io.stat ?? stat)(identity.root).catch((error: unknown) => {
        if (code(error) === "ENOENT") return undefined
        throw error
      })
      if (current && (!directory(current) || current.dev !== identity.dev || current.ino !== identity.ino))
        throw failure()
      return current
    }
    try {
      for (const [attempt, delay] of delays.entries()) {
        removalAttempt = attempt + 1
        if (delay) await (io.wait ?? wait)(delay)
        if (!(await read())) return
        try {
          // No force, chmod, ACL alteration, symlink following or implicit
          // runtime retries. Each further attempt rechecks the captured root.
          phase = "remove"
          await (io.remove ?? rm)(identity.root, { recursive: true })
        } catch (error) {
          if (![...retryable, "ENOENT"].includes(code(error) || "")) throw error
          if (!(await read())) return
          if (!retryable.includes(code(error) || "") || attempt === delays.length - 1) {
            phase = "remove"
            throw error
          }
          continue
        }
        if (await read()) {
          phase = "absence-check"
          throw failure()
        }
        return
      }
      throw failure()
    } catch (error) {
      const observation: BrowserObservation = {
        browserPhase: "cleanup-profile",
        directoryFailurePhase: phase,
        directoryRemovalAttempt: removalAttempt,
        ...errorMetadata(error, identity.root, owner!.parent),
      }
      const metadata = await remainingMetadata(identity, io).catch(() => ({
        directoryInventory: "read-failed" as const,
      }))
      let probe: DirectoryProbeObservation = {}
      if (
        io.observeFailure &&
        observation.directoryFailurePhase === "remove" &&
        removalAttempt === delays.length &&
        retryable.includes(code(error) || "")
      ) {
        probe = { directoryProbeStatus: "IDENTITY_UNCONFIRMED", directoryProbeQuiescence: "not-started" }
        const present = await read().catch(() => undefined)
        if (present) {
          probe = { directoryProbeStatus: "UNREADABLE", directoryProbeQuiescence: "unconfirmed" }
          try {
            const value = await io.observeFailure(
              Object.freeze({
                root: Object.freeze({ path: identity.root, dev: identity.dev, ino: identity.ino }),
                parent: Object.freeze({ path: owner!.parent, dev: owner!.parentDev, ino: owner!.parentIno }),
              }),
            )
            // Diagnostics cannot overwrite the original removal phase or add
            // private fields. Invalid observations leave that failure intact.
            const fields = Object.fromEntries(Object.entries(value).filter(([key]) => key.startsWith("directoryProbe")))
            const safe = readBrowserObservation({ browserObservation: { browserPhase: "cleanup-profile", ...fields } })
            if (safe)
              probe = Object.fromEntries(Object.entries(safe).filter(([key]) => key.startsWith("directoryProbe")))
          } catch {}
        }
      }
      // Even later absence or successful access probes cannot reverse the
      // exhausted removal failure or renew its deletion budget.
      throw failure(error, { ...observation, ...metadata, ...probe })
    }
  }
}
