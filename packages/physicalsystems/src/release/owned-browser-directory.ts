// SPDX-License-Identifier: Apache-2.0
import type { BigIntStats } from "node:fs"
import { lstat, realpath, rm } from "node:fs/promises"
import { dirname, isAbsolute, resolve } from "node:path"

type IdentityStat = Pick<BigIntStats, "dev" | "ino" | "isDirectory" | "isSymbolicLink">
type DirectoryIO = {
  stat?(path: string): Promise<IdentityStat>
  canonical?(path: string): Promise<string>
  remove?(path: string, options: { recursive: true }): Promise<void>
  wait?(milliseconds: number): Promise<void>
}
export type OwnedBrowserDirectory = Readonly<{ root: string; dev: bigint; ino: bigint }>

const captured = new WeakMap<
  OwnedBrowserDirectory,
  { parent: string; parentDev: bigint; parentIno: bigint; removal?: Promise<void> }
>()
const delays = [0, 100, 200, 400] as const
const retryable = ["EACCES", "EPERM", "EBUSY", "ENOTEMPTY"]
const code = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code
const failure = (error?: unknown) => {
  const value = code(error)
  return Object.assign(Error("PROVIDER_REVIEW_BROWSER_CLEANUP_UNCONFIRMED"), {
    ...(value && [...retryable, "ENOENT", "ENOTDIR", "EIO"].includes(value) ? { code: value } : {}),
  })
}
const stat = (path: string) => lstat(path, { bigint: true })
const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

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
    const read = async () => {
      if ((await (io.canonical ?? realpath)(owner!.parent)) !== owner!.parent) throw failure()
      const parent = await (io.stat ?? stat)(owner!.parent)
      if (!directory(parent) || parent.dev !== owner!.parentDev || parent.ino !== owner!.parentIno) throw failure()
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
        if (delay) await (io.wait ?? wait)(delay)
        if (!(await read())) return
        try {
          // No force, chmod, ACL alteration, symlink following or implicit
          // runtime retries. Each further attempt rechecks the captured root.
          await (io.remove ?? rm)(identity.root, { recursive: true })
        } catch (error) {
          if (![...retryable, "ENOENT"].includes(code(error) || "")) throw error
          if (!(await read())) return
          if (!retryable.includes(code(error) || "") || attempt === delays.length - 1) throw error
          continue
        }
        if (await read()) throw failure()
        return
      }
      throw failure()
    } catch (error) {
      throw failure(error)
    }
  }
}
