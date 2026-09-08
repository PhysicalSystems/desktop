// SPDX-License-Identifier: Apache-2.0
import { constants } from "node:fs"
import { open, readlink, realpath } from "node:fs/promises"
import { posix } from "node:path"
import { requireDisposableLinuxRunner } from "./linux-qualification"

type Target = Readonly<{ pid: number; executable: string }>
type Targets = Readonly<{ runtime: Target; electron: Target; uid: number }>
type Field = "stat" | "status" | "executable"
type Reader = (pid: number, field: Field, signal: AbortSignal) => Promise<string>
type Identity = Readonly<{ birth: string; executable: string; uid: number }>
type State = "same-live" | "same-zombie" | "absent" | "reused" | "identity-unconfirmed" | "unreadable"
type ProcessObservation = Readonly<{ captured: boolean; state: State }>
export type LinuxAppShutdownObservation = Readonly<{
  diagnosticOnly: true
  runtime: ProcessObservation
  electron: ProcessObservation
}>

const failure = () => new Error("LINUX_APP_SHUTDOWN_OBSERVATION_UNAVAILABLE")
const live = new Set(["R", "S", "D", "T", "t", "I", "P"])
const integer = (value: unknown, maximum: number, minimum = 0): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
const missing = (error: unknown) =>
  !!error && typeof error === "object" && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH")

function target(value: Target): Target {
  const pid = value?.pid
  const executable = value?.executable
  if (
    !integer(pid, 2147483647, 1) ||
    typeof executable !== "string" ||
    executable.length > 4096 ||
    /[\r\n\0]/.test(executable) ||
    !posix.isAbsolute(executable) ||
    posix.resolve(executable) !== executable
  )
    throw failure()
  return Object.freeze({ pid, executable })
}

function stat(value: string, pid: number) {
  if (typeof value !== "string" || value.length > 16384) throw failure()
  // comm can contain spaces and ')'; fields after its final ')' are fixed.
  const end = value.lastIndexOf(")")
  if (!value.startsWith(`${pid} (`) || end < 3) throw failure()
  const fields = value
    .slice(end + 1)
    .trim()
    .split(/\s+/)
  const state = fields[0]
  const birth = fields[19]
  if (
    !state ||
    (!live.has(state) && !["Z", "X", "x"].includes(state)) ||
    !birth ||
    !/^[1-9][0-9]{0,19}$/.test(birth) ||
    BigInt(birth) > 0xffffffffffffffffn ||
    fields.length < 20
  )
    throw failure()
  return { state, birth }
}

function status(value: string, pid: number, uid: number) {
  if (typeof value !== "string" || value.length > 16384) throw failure()
  const pids = [...value.matchAll(/^Pid:\s*([0-9]+)\s*$/gm)]
  const uids = [...value.matchAll(/^Uid:[ \t]*([0-9]+)[ \t]+([0-9]+)[ \t]+([0-9]+)[ \t]+([0-9]+)[ \t]*$/gm)]
  if (pids.length !== 1 || uids.length !== 1 || Number(pids[0]![1]) !== pid) throw failure()
  return uids[0]!.slice(1).every((value) => Number(value) === uid)
}

async function bounded<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(() => work(controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(failure())
        }, timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Inert callback seam. The closure retains copied identities privately; it
 * exposes no PID, pathname, UID, command line, signal or cleanup authority. */
export async function captureLinuxAppShutdownWithReader(input: Targets, reader: Reader, timeoutMs = 1000) {
  const targets = { runtime: target(input.runtime), electron: target(input.electron), uid: input.uid }
  if (!integer(targets.uid, 0xffffffff) || !integer(timeoutMs, 1000, 1)) throw failure()
  const read = (owner: Target, field: Field, signal: AbortSignal) => {
    signal.throwIfAborted()
    return reader(owner.pid, field, signal)
  }
  const capture = async (owner: Target, signal: AbortSignal): Promise<Identity | undefined> => {
    try {
      const before = stat(await read(owner, "stat", signal), owner.pid)
      const uidMatches = status(await read(owner, "status", signal), owner.pid, targets.uid)
      const executable = await read(owner, "executable", signal)
      const after = stat(await read(owner, "stat", signal), owner.pid)
      if (
        before.birth !== after.birth ||
        !live.has(before.state) ||
        !live.has(after.state) ||
        !uidMatches ||
        executable !== owner.executable
      )
        return
      signal.throwIfAborted()
      return Object.freeze({ birth: before.birth, executable, uid: targets.uid })
    } catch {
      return undefined
    }
  }
  const identities = await bounded(
    (signal) => Promise.all([capture(targets.runtime, signal), capture(targets.electron, signal)]),
    timeoutMs,
  )
  const observe = async (owner: Target, identity: Identity | undefined, signal: AbortSignal): Promise<State> => {
    if (!identity) return "identity-unconfirmed"
    let before: ReturnType<typeof stat>
    try {
      before = stat(await read(owner, "stat", signal), owner.pid)
    } catch (error) {
      return missing(error) ? "absent" : "unreadable"
    }
    let uidMatches: boolean | undefined
    let executable: string | undefined
    let auxiliaryMissing = false
    let auxiliaryUnreadable = false
    try {
      uidMatches = status(await read(owner, "status", signal), owner.pid, identity.uid)
      executable = await read(owner, "executable", signal)
    } catch (error) {
      auxiliaryMissing = missing(error)
      auxiliaryUnreadable = !auxiliaryMissing
    }
    let after: ReturnType<typeof stat>
    try {
      after = stat(await read(owner, "stat", signal), owner.pid)
    } catch (error) {
      // An auxiliary ENOENT alone is never disappearance. This fresh exact-PID
      // stat read is required; permissions/malformed data remain unconfirmed.
      return missing(error) ? "absent" : "unreadable"
    }
    signal.throwIfAborted()
    if (before.birth !== after.birth || after.birth !== identity.birth) return "reused"
    if (["X", "x"].includes(before.state) || (before.state === "Z" && after.state !== "Z"))
      return "identity-unconfirmed"
    if (auxiliaryUnreadable) return "unreadable"
    if (uidMatches !== true) return uidMatches === false ? "identity-unconfirmed" : "unreadable"
    // Linux zombies normally have no exe link. Same birth and exact UID,
    // rechecked in /proc/stat, distinguish that from an unreadable live process.
    if (after.state === "Z" && (auxiliaryMissing || executable === identity.executable)) return "same-zombie"
    if (auxiliaryMissing || executable !== identity.executable || !live.has(after.state)) return "identity-unconfirmed"
    return "same-live"
  }
  const output = (states: readonly State[]): LinuxAppShutdownObservation =>
    Object.freeze({
      diagnosticOnly: true,
      runtime: Object.freeze({ captured: Boolean(identities[0]), state: states[0]! }),
      electron: Object.freeze({ captured: Boolean(identities[1]), state: states[1]! }),
    })
  return Object.freeze({
    async observe(): Promise<LinuxAppShutdownObservation> {
      try {
        return output(
          await bounded(
            (signal) =>
              Promise.all([
                observe(targets.runtime, identities[0], signal),
                observe(targets.electron, identities[1], signal),
              ]),
            timeoutMs,
          ),
        )
      } catch {
        // No partial live/absent claim survives an unresolved timed-out read.
        return output(["unreadable", "unreadable"])
      }
    },
  })
}

/** Production entry is available only on the actual disposable Linux runner.
 * File reads are capped, no-follow and closed before their result is accepted;
 * the only symlink read is the kernel's /proc/PID/exe identity itself. */
export async function captureLinuxAppShutdown(input: {
  env: NodeJS.ProcessEnv
  root: string
  runtime: Target
  electron: Target
}) {
  try {
    if (process.platform !== "linux" || typeof process.getuid !== "function") throw failure()
    const targets = { runtime: target(input.runtime), electron: target(input.electron), uid: process.getuid() }
    await requireDisposableLinuxRunner({ ...input.env }, input.root)
    if ((await realpath("/proc")) !== "/proc") throw failure()
    for (const owner of [targets.runtime, targets.electron])
      if ((await realpath(owner.executable)) !== owner.executable) throw failure()
    return await captureLinuxAppShutdownWithReader(targets, async (pid, field, signal) => {
      const directory = `/proc/${pid}`
      if ((await realpath(directory)) !== directory) throw failure()
      signal.throwIfAborted()
      if (field === "executable") {
        const executable = await readlink(`${directory}/exe`)
        if (executable.length > 4096 || /[\r\n\0]/.test(executable)) throw failure()
        return executable
      }
      const handle = await open(
        `${directory}/${field}`,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      )
      try {
        if (!(await handle.stat()).isFile()) throw failure()
        const buffer = Buffer.alloc(16385)
        let bytes = 0
        while (bytes < buffer.length) {
          signal.throwIfAborted()
          const next = await handle.read(buffer, bytes, buffer.length - bytes, null)
          if (!next.bytesRead) break
          bytes += next.bytesRead
        }
        if (bytes > 16384) throw failure()
        signal.throwIfAborted()
        return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes))
      } finally {
        await handle.close()
      }
    })
  } catch {
    throw failure()
  }
}
