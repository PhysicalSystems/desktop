// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process"
import type { ChildProcess, SpawnOptions } from "node:child_process"
import { lstat, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises"
import { join, win32 } from "node:path"
import { requireDisposablePublicRunner } from "./public-qualification"
import { reviewBrowserTargets, validateBrowserProbeURL } from "./owned-review-browser"
import {
  windowsReviewNative,
  type WindowsReviewBaseline,
  type WindowsReviewNative,
  type WindowsReviewPolicy,
  type WindowsReviewProcess,
} from "./windows-review-native"

const failure = () => Error("PROVIDER_REVIEW_WINDOWS_UNCONFIRMED")
const cleanupFailure = () => Error("PROVIDER_REVIEW_BROWSER_CLEANUP_UNCONFIRMED")
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const pathEqual = (a: string, b: string) => win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase()
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure()
  return value as Record<string, unknown>
}

export function windowsReviewPolicy(value: unknown): WindowsReviewPolicy {
  const input = record(value)
  if (
    !Array.isArray(input.keys) ||
    input.keys.length !== 3 ||
    input.keys.some((key) => typeof key !== "boolean") ||
    input.keys.some((key, index, keys) => key && index > 0 && !keys[index - 1])
  )
    throw failure()
  if (input.value === null) return { keys: [...input.keys], value: null }
  const entry = record(input.value)
  if (
    !input.keys[2] ||
    !["String", "ExpandString"].includes(String(entry.kind)) ||
    typeof entry.data !== "string" ||
    entry.data.length > 32768
  )
    throw failure()
  return { keys: [...input.keys], value: { kind: entry.kind as "String" | "ExpandString", data: entry.data } }
}

export function windowsReviewProcesses(value: unknown): WindowsReviewProcess[] {
  if (!Array.isArray(value) || value.length > 256) throw failure()
  const result = value.map((item) => {
    const input = record(item)
    if (
      ![input.pid, input.parent, input.session].every((value) => Number.isSafeInteger(value) && Number(value) >= 0) ||
      Number(input.pid) < 1 ||
      typeof input.birth !== "string" ||
      !/^[1-9][0-9]{0,19}$/.test(input.birth) ||
      typeof input.sid !== "string" ||
      !/^S-1-[0-9-]{1,180}$/.test(input.sid) ||
      typeof input.executable !== "string" ||
      !/^[A-Za-z]:\\[^\r\n\0]{1,32760}$/.test(input.executable) ||
      !Array.isArray(input.args) ||
      input.args.length < 1 ||
      input.args.length > 256 ||
      input.args.some((arg) => typeof arg !== "string" || arg.length > 32768 || arg.includes("\0"))
    )
      throw failure()
    return structuredClone(input) as WindowsReviewProcess
  })
  if (new Set(result.map((item) => item.pid)).size !== result.length) throw failure()
  return result
}

export function windowsReviewSameProcess(before: WindowsReviewProcess, after: WindowsReviewProcess) {
  return (
    before.pid === after.pid &&
    before.birth === after.birth &&
    before.sid === after.sid &&
    before.session === after.session &&
    pathEqual(before.executable, after.executable)
  )
}

/** Record only the root we spawned, live descendants and exact profile-bound
 * processes. A shell's transient unowned launcher must exit on its own. */
export function windowsReviewOwnership(input: {
  processes: WindowsReviewProcess[]
  known: ReadonlyMap<number, WindowsReviewProcess>
  root: WindowsReviewProcess
  executable: string
  profile: string
  sid: string
}) {
  const owned = new Map<number, WindowsReviewProcess>()
  for (const item of input.processes) {
    const prior = input.known.get(item.pid)
    if (prior && !windowsReviewSameProcess(prior, item)) throw failure()
    if (
      item.sid !== input.sid ||
      !pathEqual(item.executable, input.executable) ||
      item.session !== input.root.session ||
      BigInt(item.birth) < BigInt(input.root.birth)
    )
      continue
    if (
      (item.pid === input.root.pid && windowsReviewSameProcess(input.root, item)) ||
      prior ||
      item.args.some((arg) => arg.startsWith("--user-data-dir=") && pathEqual(arg.slice(16), input.profile))
    )
      owned.set(item.pid, item)
  }
  let changed = true
  while (changed) {
    changed = false
    for (const item of input.processes) {
      if (owned.has(item.pid)) continue
      const parent = owned.get(item.parent)
      if (
        !parent ||
        item.sid !== input.sid ||
        item.session !== input.root.session ||
        !pathEqual(item.executable, input.executable) ||
        BigInt(item.birth) < BigInt(parent.birth)
      )
        continue
      owned.set(item.pid, item)
      changed = true
    }
  }
  return { owned, unknown: input.processes.filter((item) => !owned.has(item.pid)) }
}

/** Windows-only real browser owner. It never changes the default association,
 * imports credentials, returns PASS, or stops a pre-existing/unowned browser. */
export async function startOwnedWindowsReviewBrowser(
  input: { env: NodeJS.ProcessEnv; root: string; probeURL?: string },
  io: {
    native?: WindowsReviewNative
    spawn?: (executable: string, args: readonly string[], options: SpawnOptions) => ChildProcess
    targets?: typeof reviewBrowserTargets
    platform?: NodeJS.Platform
    timeoutMs?: number
    pollMs?: number
  } = {},
) {
  const expectedURL =
    input.probeURL === undefined ? "https://auth.openai.com/codex/device" : validateBrowserProbeURL(input.probeURL)
  const scheme = input.probeURL === undefined ? "https" : "http"
  const platform = io.platform ?? process.platform
  await requireDisposablePublicRunner(input.env, input.root, platform)
  if (platform !== "win32") throw failure()
  const timeoutMs = io.timeoutMs ?? 30000
  const pollMs = io.pollMs ?? 200
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30000 ||
    !Number.isInteger(pollMs) ||
    pollMs < 1 ||
    pollMs > 200
  )
    throw failure()
  const root = await realpath(input.root)
  if ((await readdir(root)).length) throw failure()
  const native = io.native ?? windowsReviewNative(input.env, root)
  const raw = record(await native({ operation: "preflight", scheme }))
  if (
    typeof raw.executable !== "string" ||
    !/^[A-Za-z]:\\[^\r\n\0]+\\Microsoft\\Edge\\Application\\msedge\.exe$/i.test(raw.executable) ||
    typeof raw.sid !== "string" ||
    !/^S-1-[0-9-]{1,180}$/.test(raw.sid)
  )
    throw failure()
  const baseline: WindowsReviewBaseline = {
    executable: raw.executable,
    sid: raw.sid,
    policy: windowsReviewPolicy(raw.policy),
    processes: windowsReviewProcesses(raw.processes),
  }
  if (baseline.processes.length) throw failure()
  const profile = join(root, "profile")
  await mkdir(profile, { mode: 0o700 })
  const environment: NodeJS.ProcessEnv = Object.fromEntries(
    ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"].flatMap(
      (key) => (input.env[key] ? [[key, input.env[key]!]] : []),
    ),
  )
  Object.assign(environment, {
    HOME: root,
    USERPROFILE: root,
    APPDATA: join(root, "roaming"),
    LOCALAPPDATA: join(root, "local"),
    TEMP: root,
    TMP: root,
  })
  let child: ChildProcess | undefined
  let main: WindowsReviewProcess | undefined
  const known = new Map<number, WindowsReviewProcess>()
  // Keep unknown descendants too: parent exit must not erase an orphan from
  // subsequent native snapshots or authorize deleting its private profile.
  const observed = new Map<number, WindowsReviewProcess>()
  let port: number | undefined
  let policyAttempted = false
  let closed = false
  let spawnFailed = false
  let stopped = false
  const observe = async () => {
    const value = record(
      await native({
        operation: "observe",
        scheme,
        profile,
        observedPids: [...observed.keys()],
        ...(port ? { port } : {}),
        ...(child?.pid ? { rootPid: child.pid } : {}),
      }),
    )
    const processes = windowsReviewProcesses(value.processes)
    for (const item of processes) {
      const prior = observed.get(item.pid)
      if (prior && !windowsReviewSameProcess(prior, item)) throw failure()
      observed.set(item.pid, item)
      if (observed.size > 256) throw failure()
    }
    if (
      !Array.isArray(value.listening) ||
      value.listening.some((pid) => !Number.isSafeInteger(pid) || Number(pid) < 1) ||
      typeof value.policyOwned !== "boolean"
    )
      throw failure()
    if (!main)
      return {
        processes,
        listening: [...new Set(value.listening as number[])],
        policyOwned: value.policyOwned,
        unknown: processes,
        owned: new Map<number, WindowsReviewProcess>(),
      }
    const ownership = windowsReviewOwnership({
      processes,
      known,
      root: main,
      executable: baseline.executable,
      profile,
      sid: baseline.sid,
    })
    for (const [pid, process] of ownership.owned) known.set(pid, process)
    return {
      processes,
      listening: [...new Set(value.listening as number[])],
      policyOwned: value.policyOwned,
      ...ownership,
    }
  }
  const stop = async (options: { retainProfile?: boolean } = {}) => {
    if (stopped) return
    try {
      const until = Date.now() + timeoutMs
      while (true) {
        const current = await observe()
        if (!current.processes.length) break
        if (!main) throw cleanupFailure()
        if (current.owned.size) {
          // Native adapter retains each process handle and rechecks its creation
          // time, executable, Windows session and SID before terminating it.
          await native({
            operation: "stop",
            processes: [...current.owned.values()].sort((a, b) => (BigInt(a.birth) > BigInt(b.birth) ? -1 : 1)),
          }).catch(() => {})
        }
        if (Date.now() >= until) throw cleanupFailure()
        await pause(pollMs)
      }
      if (
        policyAttempted &&
        record(
          await native({ operation: "restore", profile, before: baseline.policy, observedPids: [...observed.keys()] }),
        ).restored !== true
      )
        throw cleanupFailure()
      if (!options.retainProfile) {
        await rm(root, { recursive: true })
        if (
          await lstat(root).then(
            () => true,
            (error: NodeJS.ErrnoException) => error.code !== "ENOENT",
          )
        )
          throw cleanupFailure()
      }
      stopped = true
    } catch {
      throw cleanupFailure()
    }
  }
  try {
    policyAttempted = true
    if (record(await native({ operation: "set", profile, before: baseline.policy })).written !== true) throw failure()
    child = (io.spawn ?? spawn)(
      baseline.executable,
      [
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-mode",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        "about:blank",
      ],
      { cwd: root, env: environment, shell: false, stdio: "ignore", windowsHide: false },
    )
    child.once("error", () => {
      spawnFailed = true
    })
    child.once("close", () => {
      closed = true
    })
    const until = Date.now() + timeoutMs
    let ready = false
    while (Date.now() < until) {
      if (!child.pid || spawnFailed || closed || child.exitCode !== null) throw failure()
      const current = await observe()
      if (!current.policyOwned) throw failure()
      if (!main) {
        const observed = current.processes.find((item) => item.pid === child!.pid)
        if (!observed) {
          await pause(pollMs)
          continue
        }
        if (
          observed.sid !== baseline.sid ||
          !pathEqual(observed.executable, baseline.executable) ||
          !observed.args.some((arg) => arg.startsWith("--user-data-dir=") && pathEqual(arg.slice(16), profile))
        )
          throw failure()
        main = observed
        known.set(main.pid, main)
        continue
      }
      const file = join(profile, "DevToolsActivePort")
      const value = await lstat(file).then(
        async (stat) => {
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256) throw failure()
          return (await readFile(file, "utf8")).split("\n")[0]
        },
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw failure()
        },
      )
      if (value && /^[1-9]\d{0,4}$/.test(value) && Number(value) <= 65535) port = Number(value)
      if (
        port &&
        current.listening.length === 1 &&
        current.listening[0] === main.pid &&
        !current.unknown.length &&
        (await (io.targets ?? reviewBrowserTargets)(`http://127.0.0.1:${port}`))?.some(
          (target) => target.type === "page" && target.url === "about:blank",
        )
      ) {
        ready = true
        break
      }
      await pause(pollMs)
    }
    if (!ready) throw failure()
    return {
      environment,
      async confirmHandoff(url: string) {
        if (url !== expectedURL || !port || !main || stopped || closed) throw failure()
        const until = Date.now() + Math.min(timeoutMs, 4000)
        while (Date.now() < until) {
          const current = await observe()
          if (!current.policyOwned || current.listening.length !== 1 || current.listening[0] !== main.pid)
            throw failure()
          if (
            !current.unknown.length &&
            (await (io.targets ?? reviewBrowserTargets)(`http://127.0.0.1:${port}`))?.some(
              (target) =>
                target.type === "page" &&
                (input.probeURL === undefined
                  ? /^https:\/\/auth\.openai\.com(?:\/|$)/.test(target.url)
                  : target.url === expectedURL),
            )
          )
            return true
          await pause(pollMs)
        }
        return false
      },
      stop,
    }
  } catch {
    await stop()
    throw failure()
  }
}
