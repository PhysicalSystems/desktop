// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process"
import type { ChildProcess, SpawnOptions } from "node:child_process"
import { lstat, mkdir, mkdtemp, readdir, realpath } from "node:fs/promises"
import { createServer, type Server } from "node:net"
import { join, win32 } from "node:path"
import { requireDisposablePublicRunner } from "./public-qualification"
import { reviewBrowserTargets, validateBrowserProbeURL } from "./owned-review-browser"
import {
  captureOwnedBrowserDirectory,
  removeOwnedBrowserDirectory,
  type DirectoryProbeObservation,
  type OwnedBrowserDirectoryAnchors,
} from "./owned-browser-directory"
import { observeWindowsDirectoryDenial } from "./windows-directory-observation"
import { pruneOwnedWindowsJunctions } from "./windows-junction-prune"
import {
  browserObservationError,
  browserSyscallFailure,
  readBrowserObservation,
  createWindowsBrowserStderrObservation,
  type BrowserObservation,
} from "./browser-observation"
import {
  windowsReviewNative,
  type WindowsReviewBaseline,
  type WindowsReviewIdentityHelper,
  type WindowsReviewNative,
  type WindowsReviewPolicy,
  type WindowsReviewProcess,
} from "./windows-review-native"

const failure = () => Error("PROVIDER_REVIEW_WINDOWS_UNCONFIRMED")
const cleanupFailure = () => Error("PROVIDER_REVIEW_BROWSER_CLEANUP_UNCONFIRMED")
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const pathEqual = (a: string, b: string) => win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase()

/** Failure-only access observation. Its compiler/cache files never enter the
 * failed browser tree; confirmed helper closure only permits controller cleanup. */
export async function observeWindowsReviewDirectoryDenial(
  env: NodeJS.ProcessEnv,
  anchors: OwnedBrowserDirectoryAnchors,
  observe: typeof observeWindowsDirectoryDenial = observeWindowsDirectoryDenial,
): Promise<DirectoryProbeObservation> {
  const observation: DirectoryProbeObservation = {
    directoryProbeStatus: "UNREADABLE",
    directoryProbeQuiescence: "not-started",
    directoryProbeControllerCleanup: "not-created",
  }
  try {
    const root = await realpath(await mkdtemp(join(anchors.parent.path, "directory-denial-")))
    observation.directoryProbeControllerCleanup = "retained"
    const directory = await captureOwnedBrowserDirectory(root)
    observation.directoryProbeQuiescence = "unconfirmed"
    const result = await observe({ env, controllerRoot: root, ...anchors })
    observation.directoryProbeQuiescence = result.quiescence
    Object.assign(observation, {
      directoryProbeBoundary: result.boundary,
      directoryProbeTransportOutcome: result.transportOutcome,
      directoryProbeIdentityReason: result.observation.identityReason,
      directoryProbeIdentityScope: result.observation.identityScope,
      directoryProbeReparseTraversalStatus: result.observation.reparseTraversalStatus,
      directoryProbeReparseDeleteStatus: result.observation.reparseDeleteStatus,
      directoryProbeStatus: result.observation.status,
      directoryProbePhase: result.observation.phase,
      directoryProbeKind: result.observation.kind,
      directoryProbeNativeStatus: result.observation.nativeStatus,
      directoryProbeOrdinal: result.observation.ordinal,
      directoryProbeDepth: result.observation.depth,
      directoryProbeEntries: result.observation.entriesProbed,
      directoryProbeReadonlyAttribute: result.observation.readonlyAttribute,
      directoryProbeRootReadonlyAttribute: result.observation.rootReadonlyAttribute,
      directoryProbeReadonlyDirectories: result.observation.readonlyDirectories,
      directoryProbeReadonlyFiles: result.observation.readonlyFiles,
    })
    if (result.quiescence === "confirmed") {
      await removeOwnedBrowserDirectory(directory)
      observation.directoryProbeControllerCleanup = "removed"
    }
  } catch {
    // The original EACCES/retention decision belongs to the caller. Raw native
    // errors, paths or another cleanup failure cannot replace that decision.
  }
  return Object.fromEntries(Object.entries(observation).filter(([, value]) => value !== undefined))
}

/** Private diagnostic input only. The caller must configure encrypted storage
 * before supplying the sink; none of these records enter public observations. */
export type WindowsUnknownExecutableSnapshot = readonly Readonly<{
  executable: string
  pid: number
  parent: number
  parentOwned: boolean
  sameSid: boolean
  sameSession: boolean
  validBirth: boolean
  exactProfile: boolean
}>[]
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure()
  return value as Record<string, unknown>
}

/** Reserve one loopback port, never scan a port range. Releasing this socket
 * does not prove browser ownership: native listener identity remains required. */
export async function reserveWindowsReviewPort(io: { server?: () => Server; timeoutMs?: number } = {}) {
  const timeoutMs = io.timeoutMs ?? 2000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2000) throw failure()
  const server = io.server?.() ?? createServer((socket) => socket.destroy())
  const abort = new AbortController()
  server.unref()
  let bound = false,
    expired = false
  let closing: Promise<void> | undefined
  const release = () =>
    (closing ??= new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        server.unref()
        reject(cleanupFailure())
      }, timeoutMs)
      server.close((error?: Error) => {
        clearTimeout(timer)
        server.unref()
        if (expired || (error && ((error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING" || !bound)))
          reject(cleanupFailure())
        else resolve()
      })
    }))
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        expired = true
        abort.abort()
        reject(cleanupFailure())
      }, timeoutMs)
      server.once("error", () => {
        clearTimeout(timer)
        reject(failure())
      })
      server.listen({ host: "127.0.0.1", port: 0, exclusive: true, signal: abort.signal }, () => {
        clearTimeout(timer)
        bound = true
        server.unref()
        resolve()
      })
    })
    const address = server.address()
    if (
      !address ||
      typeof address === "string" ||
      address.address !== "127.0.0.1" ||
      !Number.isInteger(address.port) ||
      address.port < 1 ||
      address.port > 65535
    )
      throw failure()
    return { port: address.port, release }
  } catch (error) {
    await release()
    throw error
  }
}

/** Legacy wire name; this is the five-key launcher registration snapshot.
 * The fixture never writes Edge's UserDataDir or debugging policies. */
export function windowsReviewPolicy(value: unknown): WindowsReviewPolicy {
  const input = record(value)
  if (
    !Array.isArray(input.keys) ||
    input.keys.length !== 5 ||
    input.keys.some((key) => typeof key !== "boolean") ||
    input.keys.some((key, index, keys) => key && index > 0 && !keys[index - 1])
  )
    throw failure()
  if (input.value === null) return { keys: [...input.keys], value: null }
  const entry = record(input.value)
  if (
    !input.keys[4] ||
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

/** Native preflight alone verifies Authenticode. This validates its exact
 * signed-main version/path binding before admitting any helper process. */
export function windowsReviewIdentityHelper(executable: string, edgeVersion: unknown, value: unknown) {
  if (value === undefined || value === null) return undefined
  const helper = record(value)
  if (
    typeof edgeVersion !== "string" ||
    !/^[1-9][0-9]{0,4}(?:\.(?:0|[1-9][0-9]{0,4})){3}$/.test(edgeVersion) ||
    edgeVersion.split(".").some((part) => Number(part) > 65535) ||
    helper.version !== edgeVersion ||
    typeof helper.executable !== "string" ||
    win32.normalize(helper.executable) !== helper.executable ||
    !pathEqual(helper.executable, win32.join(win32.dirname(executable), edgeVersion, "identity_helper.exe"))
  )
    throw failure()
  return Object.freeze({ executable: helper.executable, version: edgeVersion }) satisfies WindowsReviewIdentityHelper
}

/** Record only the root we spawned, live descendants and exact profile-bound
 * processes. A shell's transient unowned launcher must exit on its own. */
export function windowsReviewOwnership(input: {
  processes: WindowsReviewProcess[]
  known: ReadonlyMap<number, WindowsReviewProcess>
  root: WindowsReviewProcess
  executable: string
  identityHelper?: WindowsReviewIdentityHelper
  profile: string
  sid: string
}) {
  const helper = input.identityHelper
  const isMainExecutable = (item: WindowsReviewProcess) => pathEqual(item.executable, input.executable)
  const isHelperExecutable = (item: WindowsReviewProcess) => !!helper && pathEqual(item.executable, helper.executable)
  const hasExactProfile = (item: WindowsReviewProcess) => {
    const args = item.args.filter((arg) => arg === "--user-data-dir" || arg.startsWith("--user-data-dir="))
    return args.length === 1 && args[0]!.startsWith("--user-data-dir=") && pathEqual(args[0]!.slice(16), input.profile)
  }
  const owned = new Map<number, WindowsReviewProcess>()
  for (const item of input.processes) {
    const prior = input.known.get(item.pid)
    if (prior && !windowsReviewSameProcess(prior, item)) throw failure()
    if (
      item.sid !== input.sid ||
      (!isMainExecutable(item) && !isHelperExecutable(item)) ||
      item.session !== input.root.session ||
      BigInt(item.birth) < BigInt(input.root.birth)
    )
      continue
    if (
      (isMainExecutable(item) && item.pid === input.root.pid && windowsReviewSameProcess(input.root, item)) ||
      prior ||
      (isMainExecutable(item) &&
        item.args.some((arg) => arg.startsWith("--user-data-dir=") && pathEqual(arg.slice(16), input.profile)))
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
        (!isMainExecutable(item) && !(isHelperExecutable(item) && hasExactProfile(item))) ||
        BigInt(item.birth) < BigInt(input.root.birth) ||
        BigInt(item.birth) < BigInt(parent.birth)
      )
        continue
      owned.set(item.pid, item)
      changed = true
    }
  }
  const unknown = input.processes.filter((item) => !owned.has(item.pid))
  const rejected = { executable: 0, sid: 0, session: 0, birth: 0, profileOrAncestry: 0 }
  const crashpad = { type: 0, database: 0 }
  const executableShapes = { crashpad: 0, console: 0, werFault: 0, proxy: 0, other: 0 }
  // Diagnose the unchanged ownership result. Partition reasons in this fixed
  // order; one process can violate several rules but contributes only once.
  for (const item of unknown) {
    const parent = owned.get(item.parent)
    if (!isMainExecutable(item) && !isHelperExecutable(item)) {
      rejected.executable++
      // Native discovery explicitly includes Edge Crashpad and all selected
      // descendants. These basename buckets explain rejection only: names do
      // not establish binary identity, signature, ancestry or kill authority.
      const name = win32.basename(item.executable).toLowerCase()
      if (name === "msedge_crashpad_handler.exe") executableShapes.crashpad++
      else if (name === "conhost.exe" || name === "openconsole.exe") executableShapes.console++
      else if (name === "werfault.exe") executableShapes.werFault++
      else if (name === "msedge_proxy.exe") executableShapes.proxy++
      else executableShapes.other++
    } else if (item.sid !== input.sid) rejected.sid++
    else if (item.session !== input.root.session) rejected.session++
    else if (BigInt(item.birth) < BigInt(input.root.birth) || (parent && BigInt(item.birth) < BigInt(parent.birth)))
      rejected.birth++
    else rejected.profileOrAncestry++
    // Literal argument-shape diagnostics only. Chromium's Windows handler uses
    // --type=crashpad-handler and the resolved user-data directory's Crashpad
    // database. Edge may differ; absent matches do not identify a bare launcher.
    // https://github.com/chromium/chromium/blob/main/components/crash/core/app/crashpad_win.cc
    // https://github.com/chromium/chromium/blob/main/chrome/install_static/install_util.cc
    // https://github.com/chromium/crashpad/blob/main/client/crashpad_client_win.cc
    const type = item.args.filter((arg) => arg === "--type" || arg.startsWith("--type="))
    if (type.length !== 1 || type[0] !== "--type=crashpad-handler") continue
    crashpad.type++
    const database = item.args.filter((arg) => arg === "--database" || arg.startsWith("--database="))
    if (database.length === 1 && database[0] === `--database=${win32.join(input.profile, "Crashpad")}`)
      crashpad.database++
  }
  return { owned, unknown, rejected, crashpad, executableShapes }
}

/** These four Registry64 observations are not a claim about effective policy. */
export function windowsReviewDebugPolicyObservation(value: unknown): BrowserObservation {
  const input = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  const read = (key: string, developer: boolean) => {
    const item = input[key]
    return typeof item === "string" &&
      (developer ? ["absent", "restricted", "allow", "deny"] : ["absent", "allow", "deny"]).includes(item)
      ? item
      : "invalid"
  }
  return {
    machineRemoteDebugging: read(
      "machineRemoteDebuggingAllowed",
      false,
    ) as BrowserObservation["machineRemoteDebugging"],
    userRemoteDebugging: read("baseRemoteDebuggingAllowed", false) as BrowserObservation["userRemoteDebugging"],
    machineDeveloperTools: read(
      "machineDeveloperToolsAvailability",
      true,
    ) as BrowserObservation["machineDeveloperTools"],
    userDeveloperTools: read("baseDeveloperToolsAvailability", true) as BrowserObservation["userDeveloperTools"],
  }
}

/** Windows-only real browser owner. It never changes the default association,
 * imports credentials, returns PASS, or stops a pre-existing/unowned browser. */
export async function startOwnedWindowsReviewBrowser(
  input: Parameters<typeof acquireWindowsReviewBrowser>[0],
  io: Parameters<typeof acquireWindowsReviewBrowser>[1] = {},
) {
  const observation: BrowserObservation = {
    browserPhase: "context",
    pidObserved: false,
    birthVerified: false,
    cdpReady: false,
  }
  try {
    return await acquireWindowsReviewBrowser(input, io, observation)
  } catch (error) {
    observation.failedBrowserPhase ??= observation.browserPhase
    const native = readBrowserObservation(error)
    const phase = native?.failedWindowsNativePhase ?? native?.windowsNativePhase
    if (phase) observation.failedWindowsNativePhase ??= phase
    throw browserObservationError(
      error instanceof Error && error.message === "PROVIDER_REVIEW_BROWSER_CLEANUP_UNCONFIRMED"
        ? "PROVIDER_REVIEW_BROWSER_CLEANUP_UNCONFIRMED"
        : "PROVIDER_REVIEW_WINDOWS_UNCONFIRMED",
      error,
      observation,
    )
  }
}

async function acquireWindowsReviewBrowser(
  input: {
    env: NodeJS.ProcessEnv
    root: string
    probeURL?: string
    unknownExecutableSink?: (snapshot: WindowsUnknownExecutableSnapshot) => void
  },
  io: {
    native?: WindowsReviewNative
    spawn?: (executable: string, args: readonly string[], options: SpawnOptions) => ChildProcess
    targets?: typeof reviewBrowserTargets
    platform?: NodeJS.Platform
    timeoutMs?: number
    pollMs?: number
    reservePort?: typeof reserveWindowsReviewPort
    observeDirectory?: typeof observeWindowsDirectoryDenial
    pruneDirectory?: typeof pruneOwnedWindowsJunctions
  },
  observation: BrowserObservation,
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
  const directory = await captureOwnedBrowserDirectory(root)
  const native = io.native ?? windowsReviewNative(input.env, root)
  observation.browserPhase = "windows-preflight"
  const raw = record(await native({ operation: "preflight", scheme }))
  observation.browserPhase = "windows-preflight-shape"
  Object.assign(observation, windowsReviewDebugPolicyObservation(raw.debugPolicy))
  if (
    typeof raw.executable !== "string" ||
    !/^[A-Za-z]:\\[^\r\n\0]+\\Microsoft\\Edge\\Application\\msedge\.exe$/i.test(raw.executable) ||
    typeof raw.sid !== "string" ||
    !/^S-1-[0-9-]{1,180}$/.test(raw.sid) ||
    typeof raw.resolvedCommand !== "string" ||
    !raw.resolvedCommand.length ||
    raw.resolvedCommand.length > 32768 ||
    /[\r\n\0]/.test(raw.resolvedCommand)
  )
    throw failure()
  const baseline: WindowsReviewBaseline = {
    executable: raw.executable,
    identityHelper: windowsReviewIdentityHelper(raw.executable, raw.edgeVersion, raw.identityHelper),
    resolvedCommand: raw.resolvedCommand,
    sid: raw.sid,
    policy: windowsReviewPolicy(raw.policy),
    processes: windowsReviewProcesses(raw.processes),
  }
  observation.observedProcesses = baseline.processes.length
  observation.unknownProcesses = baseline.processes.length
  if (baseline.processes.length) throw failure()
  observation.browserPhase = "directories"
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
    APPDATA: join(root, "AppData", "Roaming"),
    LOCALAPPDATA: join(root, "AppData", "Local"),
    TEMP: root,
    TMP: root,
  })
  // Shell's default known-folder templates expand USERPROFILE, and Chromium's
  // SHGetFolderPath lookup requires the base directory to exist. Keep this
  // standard layout private and distinct from the explicit browser profile.
  await mkdir(environment.APPDATA!, { recursive: true, mode: 0o700 })
  await mkdir(environment.LOCALAPPDATA!, { recursive: true, mode: 0o700 })
  observation.browserPhase = "windows-port-reserve"
  const reservation = await (io.reservePort ?? reserveWindowsReviewPort)()
  const port = reservation.port
  observation.readinessPortAllocated = Number.isInteger(port) && port > 0 && port <= 65535
  let portRelease: Promise<void> | undefined
  const releasePort = () => (portRelease ??= Promise.resolve().then(() => reservation.release()))
  let child: ChildProcess | undefined
  let main: WindowsReviewProcess | undefined
  const known = new Map<number, WindowsReviewProcess>()
  // Keep unknown descendants too: parent exit must not erase an orphan from
  // subsequent native snapshots or authorize deleting its private profile.
  const observed = new Map<number, WindowsReviewProcess>()
  let registrationAttempted = false
  let closed = false
  let spawnFailed = false
  let stopped = false
  let directoryCleanupFailure: Error | undefined
  let cleanupStarted = false
  let handoffPending = false
  let unknownExecutableCaptured = false
  let handoffCancellation: AbortController | undefined
  const observe = async () => {
    observation.windowsObservePhase = "native"
    const response = await native({
      operation: "observe",
      scheme,
      executable: baseline.executable,
      profile,
      observedPids: [...observed.keys()],
      ...(port ? { port } : {}),
      ...(child?.pid ? { rootPid: child.pid } : {}),
    })
    observation.windowsObservePhase = "response"
    const value = record(response)
    observation.windowsObservePhase = "processes"
    const processes = windowsReviewProcesses(value.processes)
    observation.observedProcesses = processes.length
    observation.windowsObservePhase = "retained-identity"
    for (const item of processes) {
      const prior = observed.get(item.pid)
      if (prior && !windowsReviewSameProcess(prior, item)) {
        // Diagnose the unchanged rejection without exposing either identity.
        // A newer birth can explain PID reuse, but grants no replacement kill
        // authority or policy/profile cleanup permission.
        observation.windowsRetainedIdentityReason =
          BigInt(item.birth) > BigInt(prior.birth)
            ? "newer-birth"
            : BigInt(item.birth) < BigInt(prior.birth)
              ? "older-birth"
              : "same-birth-metadata"
        observation.windowsRetainedSidMatched = prior.sid === item.sid
        observation.windowsRetainedSessionMatched = prior.session === item.session
        observation.windowsRetainedExecutableMatched = pathEqual(prior.executable, item.executable)
        observation.windowsRetainedObserver =
          Number.isSafeInteger(value.observerPid) &&
          Number(value.observerPid) > 0 &&
          Number(value.observerPid) <= 0xffffffff
            ? item.pid === value.observerPid
              ? "self"
              : "other"
            : "unknown"
        throw failure()
      }
      observed.set(item.pid, item)
      if (observed.size > 256) {
        observation.windowsRetainedIdentityReason = "history-limit"
        throw failure()
      }
    }
    observation.windowsObservePhase = "listener-shape"
    if (
      !Array.isArray(value.listening) ||
      value.listening.some((pid) => !Number.isSafeInteger(pid) || Number(pid) < 1) ||
      typeof value.policyOwned !== "boolean"
    )
      throw failure()
    observation.policyOwned = value.policyOwned
    observation.listenerProcesses = Math.min(value.listening.length, 65536)
    observation.ownedProcesses = 0
    observation.unknownProcesses = processes.length
    if (!main)
      return {
        processes,
        listening: [...new Set(value.listening as number[])],
        policyOwned: value.policyOwned,
        unknown: processes,
        owned: new Map<number, WindowsReviewProcess>(),
        rejected: undefined,
        crashpad: undefined,
        executableShapes: undefined,
      }
    observation.windowsObservePhase = "ownership"
    const ownership = windowsReviewOwnership({
      processes,
      known,
      root: main,
      executable: baseline.executable,
      identityHelper: baseline.identityHelper,
      profile,
      sid: baseline.sid,
    })
    for (const [pid, process] of ownership.owned) known.set(pid, process)
    observation.ownedProcesses = ownership.owned.size
    observation.unknownProcesses = ownership.unknown.length
    observation.windowsObservePhase = "complete"
    return {
      processes,
      listening: [...new Set(value.listening as number[])],
      policyOwned: value.policyOwned,
      ...ownership,
    }
  }
  const stopOnce = async (options: { retainProfile?: boolean } = {}) => {
    if (directoryCleanupFailure) throw directoryCleanupFailure
    if (stopped) return
    try {
      cleanupStarted = true
      handoffCancellation?.abort()
      observation.browserPhase = "cleanup-quiescence"
      if (handoffPending) {
        observation.handoffQuiescence = "unconfirmed"
        throw cleanupFailure()
      }

      observation.browserPhase = "windows-port-release"
      await releasePort()
      observation.readinessPortReleased = true
      const until = Date.now() + timeoutMs
      while (true) {
        observation.browserPhase = "cleanup-observe"
        const current = await observe()
        if (!current.processes.length) break
        if (!main) throw cleanupFailure()
        if (current.owned.size) {
          observation.browserPhase = "cleanup-signal"
          // Native adapter retains each process handle and rechecks its creation
          // time, executable, Windows session and SID before terminating it.
          await native({
            operation: "stop",
            processes: [...current.owned.values()].sort((a, b) => (BigInt(a.birth) > BigInt(b.birth) ? -1 : 1)),
          }).catch(() => {})
        }
        if (Date.now() >= until) throw cleanupFailure()
        observation.browserPhase = "cleanup-wait"
        await pause(pollMs)
      }
      observation.browserPhase = "windows-policy-restore"
      if (
        registrationAttempted &&
        record(
          await native({
            operation: "restore",
            scheme,
            executable: baseline.executable,
            beforeCommand: baseline.resolvedCommand,
            profile,
            before: baseline.policy,
            observedPids: [...observed.keys()],
          }),
        ).restored !== true
      )
        throw cleanupFailure()
      if (!options.retainProfile) {
        observation.browserPhase = "cleanup-profile"
        await removeOwnedBrowserDirectory(directory, {
          beforeRemove: (anchors) => (io.pruneDirectory ?? pruneOwnedWindowsJunctions)({ env: input.env, anchors }),
          observeFailure: (anchors) => observeWindowsReviewDirectoryDenial(input.env, anchors, io.observeDirectory),
        })
      }
      stopped = true
      observation.browserPhase = "stopped"
    } catch (error) {
      observation.cleanupFailurePhase = observation.browserPhase
      if (observation.browserPhase === "cleanup-profile") observation.syscallFailure = browserSyscallFailure(error)
      const failed = browserObservationError("PROVIDER_REVIEW_BROWSER_CLEANUP_UNCONFIRMED", error, observation)
      // The directory owner has exhausted or refused cleanup. In particular,
      // a later retainProfile request cannot bypass an unconfirmed native helper.
      if (observation.browserPhase === "cleanup-profile") directoryCleanupFailure = failed
      throw failed
    } finally {
      // This only releases the controller's event-loop reference. Unknown
      // browser ownership remains a failure and its private paths stay intact.
      child?.stderr?.destroy()
      child?.unref()
    }
  }
  let stopPending: Promise<void> | undefined
  const stop = (options: { retainProfile?: boolean } = {}) => {
    if (stopPending) return stopPending
    const task = stopOnce(options)
    stopPending = task
    const clear = () => {
      if (stopPending === task) stopPending = undefined
    }
    void task.then(clear, clear)
    return task
  }
  try {
    if (!observation.readinessPortAllocated) throw failure()
    registrationAttempted = true
    observation.browserPhase = "windows-policy-write"
    if (
      record(
        await native({
          operation: "set",
          scheme,
          executable: baseline.executable,
          beforeCommand: baseline.resolvedCommand,
          profile,
          before: baseline.policy,
        }),
      ).written !== true
    )
      throw failure()
    observation.browserPhase = "windows-port-release"
    await releasePort()
    observation.readinessPortReleased = true
    observation.browserPhase = "spawn"
    child = (io.spawn ?? spawn)(
      baseline.executable,
      [
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-mode",
        "--enable-logging=stderr",
        "--remote-debugging-address=127.0.0.1",
        `--remote-debugging-port=${port}`,
        "about:blank",
      ],
      { cwd: root, env: environment, shell: false, stdio: ["ignore", "ignore", "pipe"], windowsHide: false },
    )
    const stderr = createWindowsBrowserStderrObservation()
    Object.assign(observation, stderr.snapshot())
    child.stderr?.on("data", (chunk: Uint8Array) => {
      stderr.observe(chunk)
      Object.assign(observation, stderr.snapshot())
    })
    child.stderr?.on("error", () => {})
    observation.pidObserved = Boolean(child.pid)
    child.once("error", () => {
      spawnFailed = true
    })
    child.once("close", (code: number | null) => {
      closed = true
      observation.processExited = true
      if (code !== null && Number.isInteger(code) && code >= 0 && code <= 255) observation.exitCode = code
    })
    const until = Date.now() + timeoutMs
    let ready = false
    while (Date.now() < until) {
      // Keep readiness facts separate from cleanup's later process snapshots.
      observation.readinessPolls = Math.min((observation.readinessPolls ?? 0) + 1, 65536)
      if (!child.pid || spawnFailed || closed || child.exitCode !== null) throw failure()
      observation.browserPhase = "identity-stat"
      const current = await observe()
      observation.windowsObservePhase = "policy"
      if (!current.policyOwned) throw failure()
      observation.windowsObservePhase = "complete"
      if (!main) {
        const observed = current.processes.find((item) => item.pid === child!.pid)
        if (!observed) {
          await pause(pollMs)
          continue
        }
        observation.browserPhase = "identity-argv"
        observation.sidMatched = observed.sid === baseline.sid
        observation.profileTokenMatched = observed.args.some(
          (arg) => arg.startsWith("--user-data-dir=") && pathEqual(arg.slice(16), profile),
        )
        const portArgs = observed.args.filter((arg) => /^--remote-debugging-port(?:=|$)/.test(arg))
        const addressArgs = observed.args.filter((arg) => /^--remote-debugging-address(?:=|$)/.test(arg))
        observation.readinessDebugPortMatched =
          portArgs.length === 1 && portArgs[0] === `--remote-debugging-port=${port}`
        observation.readinessDebugAddressMatched =
          addressArgs.length === 1 && addressArgs[0] === "--remote-debugging-address=127.0.0.1"
        if (
          !observation.sidMatched ||
          !pathEqual(observed.executable, baseline.executable) ||
          !observation.profileTokenMatched
        )
          throw failure()
        main = observed
        observation.birthVerified = true
        known.set(main.pid, main)
        if (!observation.readinessDebugPortMatched || !observation.readinessDebugAddressMatched) throw failure()
        continue
      }
      observation.browserPhase = "cdp-targets"
      observation.readinessListeners = Math.min(current.listening.length, 65536)
      observation.readinessListenerOwned = current.listening.length === 1 && current.listening[0] === main.pid
      observation.readinessUnknownProcesses = current.unknown.length
      const query = Boolean(
        port && current.listening.length === 1 && current.listening[0] === main.pid && !current.unknown.length,
      )
      observation.readinessTargetQueried = query
      observation.readinessTargetsAvailable = false
      observation.readinessTargetCount = 0
      observation.readinessBlankTarget = false
      const targets = query ? await (io.targets ?? reviewBrowserTargets)(`http://127.0.0.1:${port}`) : undefined
      const blank = Boolean(targets?.some((target) => target.type === "page" && target.url === "about:blank"))
      observation.readinessTargetsAvailable = targets !== undefined
      observation.readinessTargetCount = Math.min(targets?.length ?? 0, 65536)
      observation.readinessBlankTarget = blank
      if (blank) {
        ready = true
        observation.cdpReady = true
        break
      }
      await pause(pollMs)
    }
    if (!ready) throw failure()
    observation.browserPhase = "ready"
    return {
      environment,
      async confirmHandoff(url: string, options: { signal?: AbortSignal } = {}) {
        if (handoffPending || cleanupStarted) throw failure()
        handoffPending = true
        handoffCancellation = new AbortController()
        observation.browserPhase = "handoff-targets"
        observation.handoffPhase = "context"
        observation.handoffOutcome = "pending"
        const canceled = () => {
          if (!options.signal?.aborted && !handoffCancellation?.signal.aborted) return false
          observation.handoffOutcome = "canceled"
          return true
        }
        try {
          if (url !== expectedURL || !port || !main || stopped || closed) throw failure()
          const until = Date.now() + Math.min(timeoutMs, 4000)
          while (Date.now() < until && !canceled()) {
            observation.handoffPhase = "native"
            observation.handoffPolls = Math.min((observation.handoffPolls ?? 0) + 1, 65536)
            const current = await observe()
            observation.handoffPhase = "ownership"
            observation.handoffPolicyOwned = current.policyOwned
            observation.handoffListeners = Math.min(current.listening.length, 65536)
            observation.handoffListenerOwned = current.listening.length === 1 && current.listening[0] === main.pid
            observation.handoffUnknownProcesses = Math.min(current.unknown.length, 65536)
            if (current.rejected) {
              observation.handoffUnknownExecutableProcesses = Math.min(current.rejected.executable, 65536)
              observation.handoffUnknownSidProcesses = Math.min(current.rejected.sid, 65536)
              observation.handoffUnknownSessionProcesses = Math.min(current.rejected.session, 65536)
              observation.handoffUnknownBirthProcesses = Math.min(current.rejected.birth, 65536)
              observation.handoffUnknownProfileOrAncestryProcesses = Math.min(current.rejected.profileOrAncestry, 65536)
            }
            if (current.crashpad) {
              observation.handoffUnknownCrashpadTypeProcesses = Math.min(current.crashpad.type, 65536)
              observation.handoffUnknownCrashpadDatabaseProcesses = Math.min(current.crashpad.database, 65536)
            }
            if (current.executableShapes) {
              observation.handoffUnknownCrashpadExecutableProcesses = Math.min(current.executableShapes.crashpad, 65536)
              observation.handoffUnknownConsoleExecutableProcesses = Math.min(current.executableShapes.console, 65536)
              observation.handoffUnknownWerFaultExecutableProcesses = Math.min(current.executableShapes.werFault, 65536)
              observation.handoffUnknownProxyExecutableProcesses = Math.min(current.executableShapes.proxy, 65536)
              observation.handoffUnknownOtherExecutableProcesses = Math.min(current.executableShapes.other, 65536)
            }
            if (input.unknownExecutableSink && !unknownExecutableCaptured) {
              const rejected = current.unknown.filter(
                (item) =>
                  !pathEqual(item.executable, baseline.executable) &&
                  !(baseline.identityHelper && pathEqual(item.executable, baseline.identityHelper.executable)),
              )
              if (rejected.length) {
                unknownExecutableCaptured = true
                const anchor = main
                const snapshot = Object.freeze(
                  rejected.slice(0, 8).map((item) => {
                    const parent = current.owned.get(item.parent)
                    return Object.freeze({
                      executable: item.executable,
                      pid: item.pid,
                      parent: item.parent,
                      parentOwned: Boolean(parent),
                      sameSid: item.sid === baseline.sid,
                      sameSession: item.session === anchor.session,
                      validBirth:
                        BigInt(item.birth) >= BigInt(anchor.birth) &&
                        (!parent || BigInt(item.birth) >= BigInt(parent.birth)),
                      exactProfile: item.args.some(
                        (arg) => arg.startsWith("--user-data-dir=") && pathEqual(arg.slice(16), profile),
                      ),
                    })
                  }),
                )
                // Synchronous buffering only; never await diagnostics or let a
                // faulty sink change the ownership/CDP/cleanup decision. Also
                // absorb an accidentally returned rejected Promise.
                try {
                  void Promise.resolve(input.unknownExecutableSink(snapshot)).catch(() => {})
                } catch {}
              }
            }
            // A canceled native read may complete, but must not schedule CDP or
            // another native read while the caller is waiting for quiescence.
            if (canceled()) return false
            if (!observation.handoffPolicyOwned || !observation.handoffListenerOwned) throw failure()
            if (!current.unknown.length) {
              observation.handoffPhase = "targets"
              const targets = await (io.targets ?? reviewBrowserTargets)(`http://127.0.0.1:${port}`)
              observation.handoffTargetsAvailable = targets !== undefined
              observation.handoffTargetCount = Math.min(targets?.length ?? 0, 65536)
              observation.handoffTargetMatched = Boolean(
                targets?.some(
                  (target) =>
                    target.type === "page" &&
                    (input.probeURL === undefined
                      ? /^https:\/\/auth\.openai\.com(?:\/|$)/.test(target.url)
                      : target.url === expectedURL),
                ),
              )
              if (canceled()) return false
              if (observation.handoffTargetMatched) {
                observation.handoffPhase = "complete"
                observation.handoffOutcome = "matched"
                return true
              }
            }
            await pause(pollMs)
          }
          if (!canceled()) observation.handoffOutcome = "not-matched"
          return false
        } catch (error) {
          observation.handoffOutcome = "failed"
          const native = readBrowserObservation(error)
          if (native?.windowsNativePhase) observation.handoffWindowsNativePhase = native.windowsNativePhase
          if (native?.windowsNativeOutcome) observation.handoffWindowsNativeOutcome = native.windowsNativeOutcome
          throw browserObservationError("PROVIDER_REVIEW_WINDOWS_UNCONFIRMED", error, observation)
        } finally {
          handoffPending = false
        }
      },
      observation: () => ({ ...observation }),
      releaseController() {
        child?.stderr?.destroy()
        child?.unref()
      },
      stop,
    }
  } catch (error) {
    observation.failedBrowserPhase ??= observation.browserPhase
    if (observation.windowsObservePhase) observation.failedWindowsObservePhase ??= observation.windowsObservePhase
    // Capture before stop can cause an exit or remove these files. Inspect only
    // direct metadata, never profile contents or a symlinked Default directory.
    observation.childExitedAtFailure = Boolean(child && (closed || child.exitCode != null || child.signalCode != null))
    observation.profileMarkerReadComplete = true
    const metadata = async (path: string) =>
      lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") observation.profileMarkerReadComplete = false
        return undefined
      })
    const localState = await metadata(join(profile, "Local State"))
    const defaultDirectory = await metadata(join(profile, "Default"))
    if (localState?.isSymbolicLink() || (defaultDirectory && !defaultDirectory.isDirectory()))
      observation.profileMarkerReadComplete = false
    const preferences = defaultDirectory?.isDirectory()
      ? await metadata(join(profile, "Default", "Preferences"))
      : undefined
    if (preferences?.isSymbolicLink()) observation.profileMarkerReadComplete = false
    observation.profileLocalStatePresent = localState?.isFile() ?? false
    observation.profilePreferencesPresent = preferences?.isFile() ?? false
    const phase = readBrowserObservation(error)?.windowsNativePhase
    if (phase) observation.failedWindowsNativePhase ??= phase
    try {
      await stop()
    } catch (cleanup) {
      throw browserObservationError("PROVIDER_REVIEW_BROWSER_CLEANUP_UNCONFIRMED", cleanup, observation)
    }
    throw browserObservationError("PROVIDER_REVIEW_WINDOWS_UNCONFIRMED", error, observation)
  }
}
