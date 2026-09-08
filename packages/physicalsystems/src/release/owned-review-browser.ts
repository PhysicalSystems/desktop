// SPDX-License-Identifier: Apache-2.0
import { spawn, type ChildProcess } from "node:child_process"
import { lstat, mkdir, readFile, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { requireDisposablePublicRunner } from "./public-qualification"
import {
  browserObservationError,
  browserSyscallFailure,
  createBrowserStderrObservation,
  type BrowserObservation,
} from "./browser-observation"
import { linuxProcessArguments } from "./linux-qualification"

const failure = () => new Error("PROVIDER_REVIEW_BROWSER_UNCONFIRMED")
const cleanupFailure = () => new Error("PROVIDER_REVIEW_BROWSER_CLEANUP_UNCONFIRMED")
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export type OwnedReviewBrowser = {
  environment: NodeJS.ProcessEnv
  confirmHandoff(url: string): Promise<boolean>
  stop(options?: { retainProfile?: boolean }): Promise<void>
}

/** A retained browser must not retain the qualification controller itself.
 * This closes our bounded stderr observer and releases the child handle, without signaling a
 * process, deleting a profile, or converting failed cleanup into success. */
export async function settleReviewBrowserCleanup<T>(
  child: Pick<ChildProcess, "unref"> & Partial<Pick<ChildProcess, "stderr">>,
  cleanup: () => Promise<T>,
): Promise<T> {
  try {
    return await cleanup()
  } finally {
    child.stderr?.destroy()
    child.unref()
  }
}

export function validateBrowserProbeURL(value: string) {
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/physicalsystems-browser-review\/[a-f0-9]{64}$/.exec(value)
  if (!match || Number(match[1]) > 65535) throw failure()
  return value
}

/** Read only fixed ownership fields; process command lines never enter evidence. */
export function reviewBrowserProcess(stat: string) {
  const match = /^(\d+) \(.*\) ([A-Za-z]) (.*)$/.exec(stat.trim())
  if (!match) throw failure()
  const fields = match[3]!.split(" ")
  const result = {
    pid: Number(match[1]),
    state: match[2],
    group: Number(fields[1]),
    session: Number(fields[2]),
    birth: fields[18],
  }
  if (
    !Number.isSafeInteger(result.pid) ||
    result.pid < 1 ||
    ![result.group, result.session].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    !/^\d+$/.test(result.birth ?? "")
  )
    throw failure()
  return result
}

/** Stable Google Chrome on Linux ignores --user-data-dir for Crashpad.
 * Keep this path distinct from Electron's profile/Crashpad convention. */
export function reviewBrowserCrashDatabase(root: string) {
  return join(root, "config", "google-chrome", "Crash Reports")
}

/** ContentMain rewrites even the main Chrome argv as one space-separated title.
 * Real argv retains spaces inside its values; a rewritten profile containing
 * whitespace is ambiguous and cannot establish our exact ownership token.
 * Chromium: content/app/content_main.cc -> base/process/set_process_title.cc. */
export function reviewBrowserProfileArgument(commandLine: string, profile: string) {
  if (!profile.startsWith("/") || /[\0\r\n]/.test(profile)) return false
  const fields = commandLine.split("\0").filter((value) => value.length > 0)
  if (fields.length === 1 && /\s/.test(profile)) return false
  const matching = linuxProcessArguments(commandLine).filter((value) => /^--user-data-dir(?:=|$)/.test(value))
  return matching.length === 1 && matching[0] === `--user-data-dir=${profile}`
}

/** Empty cmdline alone grants no ownership. A later exact token must belong to
 * the same live PID/birth/session/group observed before and after every read. */
export function createReviewBrowserProfileProof(profile: string) {
  let anchor: ReturnType<typeof reviewBrowserProcess> | undefined
  const live = (value: ReturnType<typeof reviewBrowserProcess>) => {
    if (!value.birth || !["R", "S", "D", "T", "t", "I", "P"].includes(value.state ?? "")) throw failure()
    if (value.group !== value.pid || value.session !== value.pid) throw failure()
  }
  const same = (left: ReturnType<typeof reviewBrowserProcess>, right: ReturnType<typeof reviewBrowserProcess>) => {
    if (
      ["pid", "birth", "group", "session"].some(
        (key) => left[key as keyof typeof left] !== right[key as keyof typeof right],
      )
    )
      throw failure()
  }
  return (
    before: ReturnType<typeof reviewBrowserProcess>,
    after: ReturnType<typeof reviewBrowserProcess>,
    command: string,
  ) => {
    live(before)
    live(after)
    same(before, after)
    if (anchor) same(anchor, before)
    else anchor = { ...before }
    if (!command.split("\0").some(Boolean)) return false
    if (!reviewBrowserProfileArgument(command, profile)) throw failure()
    return true
  }
}

export function reviewBrowserUid(status: string, expected: number) {
  const matches = [...status.matchAll(/^Uid:\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s*$/gm)]
  if (
    !Number.isSafeInteger(expected) ||
    expected < 1 ||
    matches.length !== 1 ||
    matches[0]!.slice(1).some((value) => Number(value) !== expected)
  )
    throw failure()
}

export function reviewBrowserSignalIdentity(
  before: ReturnType<typeof reviewBrowserProcess>,
  after: ReturnType<typeof reviewBrowserProcess>,
  status: string,
  uid: number,
) {
  reviewBrowserSameSignalProcess(before, after)
  reviewBrowserUid(status, uid)
}

function reviewBrowserSameSignalProcess(
  before: ReturnType<typeof reviewBrowserProcess>,
  after: ReturnType<typeof reviewBrowserProcess>,
) {
  if (
    before.pid !== after.pid ||
    before.birth !== after.birth ||
    before.session !== after.session ||
    before.group !== after.group
  )
    throw failure()
}

/** Read adapters are mandatory so regressions exercise this exact signal proof
 * with inert process snapshots, without native reads or signals. Missing stat,
 * status, cmdline or exe entries require one fresh exact-PID stat lookup to
 * confirm disappearance. A live, reused or unreadable PID remains a failure. */
export async function reviewBrowserSignalProof(
  member: ReturnType<typeof reviewBrowserProcess>,
  input: { session: number; uid: number; database: string },
  io: {
    stat(): Promise<string>
    status(): Promise<string>
    command(): Promise<string>
    executable(): Promise<string>
  },
) {
  const anchor = { ...member }
  const missing = (error: unknown) => ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException)?.code ?? "")
  const read = async (operation: () => Promise<string>) => {
    try {
      return await operation()
    } catch (error) {
      if (!missing(error)) throw error
      let fresh: string
      try {
        fresh = await io.stat()
      } catch (recheck) {
        if (missing(recheck)) return undefined
        throw recheck
      }
      reviewBrowserSameSignalProcess(anchor, reviewBrowserProcess(fresh))
      // Even the original PID still present as a zombie is not proof that the
      // failed auxiliary read was harmless. Do not signal or hide that failure.
      throw error
    }
  }
  const now = await read(io.stat)
  if (now === undefined) return false
  const current = reviewBrowserProcess(now)
  reviewBrowserSameSignalProcess(anchor, current)
  const status = await read(io.status)
  if (status === undefined) return false
  reviewBrowserSignalIdentity(anchor, current, status, input.uid)
  if (current.session !== input.session) {
    const command = await read(io.command)
    if (command === undefined) return false
    if (reviewBrowserOwnershipScope({ sameSession: false, command, database: input.database }) !== "database")
      throw failure()
    const executable = await read(io.executable)
    if (executable === undefined) return false
    if (!reviewBrowserCrashpad({ command, executable, database: input.database })) throw failure()
  }
  const final = await read(io.stat)
  if (final === undefined) return false
  reviewBrowserSameSignalProcess(anchor, reviewBrowserProcess(final))
  return true
}

export function reviewBrowserCrashpad(input: { command: string; executable: string; database: string }) {
  return (
    input.executable === "/opt/google/chrome/chrome_crashpad_handler" &&
    input.command.split("\0").includes(`--database=${input.database}`)
  )
}

/** Select ownership before checking all four UIDs. An unrelated same-real-UID
 * setuid process is not one of our browser processes merely because it exists. */
export function reviewBrowserOwnershipScope(input: { sameSession: boolean; command: string; database: string }) {
  if (input.sameSession) return "session" as const
  return input.command.split("\0").includes(`--database=${input.database}`)
    ? ("database" as const)
    : ("unrelated" as const)
}

/** Read-only discovery can briefly be empty/refused while Chrome initializes.
 * Bound both bytes and total time; callers retry only this probe, never a launch
 * or openExternal mutation. No response contents/errors are logged. */
export async function reviewBrowserTargets(
  origin: string,
  input: {
    fetcher?: (url: string, init?: RequestInit) => Promise<Response>
    timeoutMs?: number
  } = {},
): Promise<{ type: string; url: string }[] | undefined> {
  const timeoutMs = input.timeoutMs ?? 2000
  if (
    !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(origin) ||
    Number(origin.slice(origin.lastIndexOf(":") + 1)) > 65535 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 2000
  )
    throw failure()
  const abort = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    return await Promise.race([
      (async () => {
        const response = await (input.fetcher ?? fetch)(`${origin}/json/list`, {
          redirect: "error",
          signal: abort.signal,
        })
        if (!response.ok || !response.body) return
        reader = response.body.getReader()
        if (Number(response.headers.get("content-length") ?? 0) > 256 * 1024) return
        const chunks: Uint8Array[] = []
        let bytes = 0
        while (!abort.signal.aborted) {
          const part = await reader.read()
          if (part.done) break
          bytes += part.value.byteLength
          if (bytes > 256 * 1024) return
          chunks.push(part.value)
        }
        if (abort.signal.aborted) return
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)))
        if (!Array.isArray(value) || value.length > 128) return
        const targets = [] as { type: string; url: string }[]
        for (const item of value) {
          if (
            !item ||
            typeof item !== "object" ||
            typeof item.type !== "string" ||
            typeof item.url !== "string" ||
            item.type.length > 64 ||
            item.url.length > 8192
          )
            return
          targets.push({ type: item.type, url: item.url })
        }
        return targets
      })(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          abort.abort()
          resolve(undefined)
        }, timeoutMs)
      }),
    ])
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
    abort.abort()
    // Some failed transports do not settle cancellation; never let them extend
    // the discovery deadline or block ownership cleanup.
    void reader?.cancel().catch(() => {})
  }
}

export function ownedReviewBrowserEnvironment(root: string, base: NodeJS.ProcessEnv) {
  // Browser/launcher receive no Actions token, provider credential or generic
  // loader hook. HOME and XDG paths belong only to this disposable phase.
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    ["DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"].flatMap((key) =>
      base[key] ? [[key, base[key]!]] : [],
    ),
  )
  return {
    ...env,
    HOME: root,
    PATH: "/usr/bin:/bin",
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_CURRENT_DESKTOP: "X-Generic",
    BROWSER: join(root, "browser"),
  }
}

export function reviewBrowserDesktopEntry(launcher: string) {
  // Ubuntu 24.04 xdg-utils 1.1.3-4.1ubuntu3's generic Exec parser retains quote
  // marks in its executable lookup. Use an unquoted path only when it has no
  // whitespace or shell/Desktop Entry metacharacters; never misparse a path.
  if (
    !/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(launcher) ||
    launcher.split("/").some((part) => part === "." || part === "..")
  )
    throw failure()
  return `[Desktop Entry]\nType=Application\nName=Owned provider review\nExec=${launcher} %u\nTerminal=false\nMimeType=x-scheme-handler/http;x-scheme-handler/https;\n`
}

/** Actual headed Chrome, its own Linux session and exclusive profile. The XDG
 * handler reuses this exact profile when the app invokes its OS browser launcher.
 * No registry/default-browser mutations or unowned Windows launch is attempted. */
export async function startOwnedReviewBrowser(input: {
  env: NodeJS.ProcessEnv
  root: string
  probeURL?: string
}): Promise<OwnedReviewBrowser> {
  await requireDisposablePublicRunner(input.env, input.root)
  const observation: BrowserObservation = {
    browserPhase: "context",
    pidObserved: false,
    birthVerified: false,
    cdpReady: false,
  }
  try {
    return await startLinuxReviewBrowser(input, observation)
  } catch (error) {
    observation.failedBrowserPhase ??= observation.browserPhase
    observation.syscallFailure ??= browserSyscallFailure(error)
    throw browserObservationError(
      (error as Error)?.message === "PROVIDER_REVIEW_BROWSER_CLEANUP_UNCONFIRMED"
        ? "PROVIDER_REVIEW_BROWSER_CLEANUP_UNCONFIRMED"
        : "PROVIDER_REVIEW_BROWSER_UNCONFIRMED",
      error,
      observation,
    )
  }
}

async function startLinuxReviewBrowser(
  input: { env: NodeJS.ProcessEnv; root: string; probeURL?: string },
  observation: BrowserObservation,
): Promise<OwnedReviewBrowser> {
  const expectedURL =
    input.probeURL === undefined ? "https://auth.openai.com/codex/device" : validateBrowserProbeURL(input.probeURL)
  if (process.platform !== "linux" || !input.env.DISPLAY) throw failure()
  const root = await realpath(input.root)
  if ((await readdir(root)).length) throw failure()
  const desktopEntry = reviewBrowserDesktopEntry(join(root, "browser"))
  // GitHub's Linux image provides Google Chrome here. Fail closed if absent;
  // never discover an executable through a user-controlled PATH.
  const executable = "/opt/google/chrome/chrome"
  if (!(await lstat(executable)).isFile() || (await realpath(executable)) !== executable) throw failure()
  const uid = process.getuid?.()
  if (!Number.isInteger(uid) || !uid) throw failure()
  const database = reviewBrowserCrashDatabase(root)
  const profile = join(root, "profile")
  const env = ownedReviewBrowserEnvironment(root, input.env)
  observation.browserPhase = "directories"
  await Promise.all([
    mkdir(profile, { mode: 0o700 }),
    mkdir(join(root, "config"), { mode: 0o700 }),
    mkdir(join(root, "data", "applications"), { recursive: true, mode: 0o700 }),
    mkdir(join(root, "cache"), { mode: 0o700 }),
  ])
  const args = [
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-mode",
  ]
  const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'"
  await writeFile(join(root, "browser"), `#!/bin/sh\nexec ${[executable, ...args].map(quote).join(" ")} "$@"\n`, {
    mode: 0o700,
    flag: "wx",
  })
  await writeFile(join(root, "data", "applications", "physical-review.desktop"), desktopEntry, {
    mode: 0o600,
    flag: "wx",
  })
  await writeFile(
    join(root, "config", "mimeapps.list"),
    "[Default Applications]\nx-scheme-handler/http=physical-review.desktop\nx-scheme-handler/https=physical-review.desktop\n",
    { mode: 0o600, flag: "wx" },
  )
  observation.browserPhase = "spawn"
  const child = spawn(
    executable,
    [...args, "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", "about:blank"],
    {
      cwd: root,
      env,
      detached: true,
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
    },
  )
  observation.pidObserved = Boolean(child.pid)
  const stderr = createBrowserStderrObservation()
  child.stderr!.on("data", (chunk) => {
    stderr.observe(chunk)
    Object.assign(observation, stderr.snapshot())
  })
  child.on("exit", (code, signal) => {
    observation.processExited = true
    if (code !== null && Number.isInteger(code) && code >= 0 && code <= 255) observation.exitCode = code
    if (signal)
      observation.termination = ["SIGABRT", "SIGSEGV", "SIGTRAP", "SIGTERM", "SIGKILL"].includes(signal)
        ? (signal as "SIGABRT" | "SIGSEGV" | "SIGTRAP" | "SIGTERM" | "SIGKILL")
        : "OTHER"
  })
  const profileProof = createReviewBrowserProfileProof(profile)
  let childError = false
  child.on("error", () => {
    childError = true
  })
  let origin: string | undefined
  let birth: string | undefined
  let stopped = false
  const inspect = async () => {
    if (!child.pid) throw failure()
    const entries = await readdir("/proc")
    if (entries.length > 65536) throw failure()
    const members = [] as ReturnType<typeof reviewBrowserProcess>[]
    for (const entry of entries) {
      if (!/^[1-9]\d*$/.test(entry)) continue
      try {
        delete observation.sameSession
        delete observation.databaseMatched
        observation.inspectPhase = "proc-stat"
        const value = reviewBrowserProcess(await readFile(`/proc/${entry}/stat`, "utf8"))
        if (value.state === "Z") continue
        observation.inspectPhase = "proc-status"
        const status = await readFile(`/proc/${entry}/status`, "utf8")
        observation.sameSession = value.session === child.pid
        if (value.session !== child.pid && Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]) !== uid) continue
        let command = ""
        if (value.session !== child.pid) {
          // Crashpad deliberately creates another session. Its executable and
          // exact owned database flag bind it independently to this browser.
          // An unreadable same-user process cannot silently count as absent.
          observation.inspectPhase = "cmdline"
          command = await readFile(`/proc/${entry}/cmdline`, "utf8")
          observation.databaseMatched =
            reviewBrowserOwnershipScope({ sameSession: false, command, database }) === "database"
          if (!observation.databaseMatched) continue
        }
        observation.inspectPhase = "uid"
        reviewBrowserUid(status, uid)
        if (value.session !== child.pid) {
          observation.inspectPhase = "crashpad-executable"
          if (!reviewBrowserCrashpad({ command, executable: await readlink(`/proc/${entry}/exe`), database }))
            throw failure()
        }
        observation.inspectPhase = "birth"
        if (!birth || BigInt(value.birth!) < BigInt(birth)) throw failure()
        members.push(value)
        observation.ownedProcesses = members.length
      } catch (error) {
        if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) continue
        observation.syscallFailure ??= browserSyscallFailure(error)
        throw failure()
      }
    }
    observation.ownedProcesses = members.length
    return members
  }
  const stop = async (options: { retainProfile?: boolean } = {}) =>
    settleReviewBrowserCleanup(child, async () => {
      if (stopped) return
      // Recheck birth immediately before signaling each member; never kill an
      // ambient browser or a reused PID. The session was created by our spawn.
      // An acquisition failure before identity verification cannot authorize a
      // signal or deletion. The caller retains the entire isolated review root.
      try {
        observation.browserPhase = "cleanup-identity"
        if (!birth) throw cleanupFailure()
        for (const signal of ["SIGTERM", "SIGKILL"] as const) {
          observation.browserPhase = "cleanup-observe"
          for (const member of await inspect()) {
            observation.browserPhase = "cleanup-signal"
            if (
              !(await reviewBrowserSignalProof(
                member,
                { session: child.pid!, uid, database },
                {
                  stat: () => {
                    observation.inspectPhase = "proc-stat"
                    return readFile(`/proc/${member.pid}/stat`, "utf8")
                  },
                  status: () => {
                    observation.inspectPhase = "proc-status"
                    return readFile(`/proc/${member.pid}/status`, "utf8")
                  },
                  command: () => {
                    observation.inspectPhase = "cmdline"
                    return readFile(`/proc/${member.pid}/cmdline`, "utf8")
                  },
                  executable: () => {
                    observation.inspectPhase = "crashpad-executable"
                    return readlink(`/proc/${member.pid}/exe`)
                  },
                },
              ))
            )
              continue
            try {
              process.kill(member.pid, signal)
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw failure()
            }
          }
          const until = Date.now() + 5000
          observation.browserPhase = "cleanup-wait"
          while ((await inspect()).length && Date.now() < until) await pause(50)
          if (!(await inspect()).length) break
        }
        if ((await inspect()).length) throw failure()
        if (!options.retainProfile) {
          observation.browserPhase = "cleanup-profile"
          await rm(root, { recursive: true })
          if (
            await lstat(root).then(
              () => true,
              (error: NodeJS.ErrnoException) => error.code !== "ENOENT",
            )
          )
            throw failure()
        }
        stopped = true
        observation.browserPhase = "stopped"
      } catch (error) {
        observation.cleanupFailurePhase = observation.browserPhase
        observation.syscallFailure ??= browserSyscallFailure(error)
        throw browserObservationError("PROVIDER_REVIEW_BROWSER_CLEANUP_UNCONFIRMED", error, observation)
      }
    })
  const targets = async () => {
    if (!origin || stopped || childError || child.exitCode !== null) throw failure()
    return await reviewBrowserTargets(origin)
  }
  try {
    const until = Date.now() + 15000
    let ready = false
    while (Date.now() < until) {
      if (!child.pid || childError || child.exitCode !== null) throw failure()
      if (!birth) {
        observation.browserPhase = "identity-stat"
        const stat = reviewBrowserProcess(await readFile(`/proc/${child.pid}/stat`, "utf8"))
        if (["R", "S", "D", "T", "t", "I", "P", "Z", "X", "x"].includes(stat.state ?? ""))
          observation.processState = stat.state as BrowserObservation["processState"]
        observation.browserPhase = "identity-session"
        if (stat.group !== child.pid || stat.session !== child.pid) throw failure()
        observation.browserPhase = "identity-executable"
        if ((await readlink(`/proc/${child.pid}/exe`)) !== executable) throw failure()
        observation.browserPhase = "identity-uid"
        reviewBrowserUid(await readFile(`/proc/${child.pid}/status`, "utf8"), uid)
        observation.browserPhase = "identity-argv"
        const command = await readFile(`/proc/${child.pid}/cmdline`, "utf8")
        observation.argvReads = (observation.argvReads ?? 0) + 1
        observation.argvFields = command.split("\0").filter((value) => value.length > 0).length
        observation.profileTokenMatched = reviewBrowserProfileArgument(command, profile)
        if (observation.argvFields === 0) observation.emptyArgvReads = (observation.emptyArgvReads ?? 0) + 1
        const after = reviewBrowserProcess(await readFile(`/proc/${child.pid}/stat`, "utf8"))
        if (["R", "S", "D", "T", "t", "I", "P", "Z", "X", "x"].includes(after.state ?? ""))
          observation.processState = after.state as BrowserObservation["processState"]
        if (!profileProof(stat, after, command)) {
          await pause(50)
          continue
        }
        birth = stat.birth
        observation.birthVerified = true
      }
      observation.browserPhase = "port-file"
      const portFile = join(profile, "DevToolsActivePort")
      const port = await lstat(portFile).then(
        async (stat) => {
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256) throw failure()
          return (await readFile(portFile, "utf8")).split("\n")[0]
        },
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw failure()
        },
      )
      if (port && /^[1-9]\d{0,4}$/.test(port) && Number(port) <= 65535) {
        origin = `http://127.0.0.1:${port}`
        observation.browserPhase = "cdp-targets"
        const observed = await targets()
        observation.targetCount = observed?.length ?? 0
        if (observed?.some((target) => target.type === "page" && target.url === "about:blank")) {
          ready = true
          observation.cdpReady = true
          break
        }
      }
      await pause(100)
    }
    if (!ready) throw failure()
    observation.browserPhase = "ready"
    return {
      environment: env,
      async confirmHandoff(url: string) {
        observation.browserPhase = "handoff-targets"
        if (url !== expectedURL) throw failure()
        const until = Date.now() + 4000
        while (Date.now() < until) {
          if (
            (await targets())?.some(
              (target) =>
                target.type === "page" &&
                (input.probeURL === undefined
                  ? /^https:\/\/auth\.openai\.com(?:\/|$)/.test(target.url)
                  : target.url === expectedURL),
            )
          )
            return true
          await pause(50)
        }
        return false
      },
      stop,
    }
  } catch (error) {
    observation.failedBrowserPhase ??= observation.browserPhase
    observation.syscallFailure ??= browserSyscallFailure(error)
    await stop()
    throw browserObservationError("PROVIDER_REVIEW_BROWSER_UNCONFIRMED", error, observation)
  }
}
