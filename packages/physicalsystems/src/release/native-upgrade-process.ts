// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process"
import type { ChildProcess, SpawnOptions } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, open, readFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { candidateNames } from "./artifacts"
import { desktopIdentity } from "./identity"
import { nsisInstallArguments, nsisSpawnOptions } from "./installed-reinstall"
import { requireDebianUpgradeStatus } from "./installed-upgrade"
import type { UpgradeInterruption } from "./installed-upgrade"
import { requireDisposablePublicRunner } from "./public-qualification"
import { payloadFingerprint, sha256File } from "./qualification"
import { startWindowsInstallerOwner, readWindowsInstallerOwnerObservation } from "./windows-installer-owner"
import type { WindowsInstallerOwner } from "./windows-installer-owner"

const failure = (name: string) => new Error(`PUBLIC_UPGRADE_${name}`)
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
type NativeUpgradePhase =
  | "payload-stat"
  | "payload-open"
  | "reference-open"
  | "payload-read"
  | "reference-read"
  | "payload-close"
  | "reference-close"
  | "payload-observation"
  | "installer-spawn"
  | "installer-pid"
  | "installer-inspection"
  | "installer-owner"
const nativeCodes = ["ENOENT", "EACCES", "EPERM", "EBUSY", "EIO", "ENOTDIR", "EBADF", "ESRCH"] as const
const payloadCheckpoints = ["absent", "busyOpen", "readableOpen", "sampledEndsMatch", "partial"] as const
type PayloadProgress = Record<(typeof payloadCheckpoints)[number], number>
type PayloadCheckpoint = (typeof payloadCheckpoints)[number] | "not-observed"
const observations = new WeakMap<
  Error,
  Readonly<{
    phase: NativeUpgradePhase
    nativeCode: string
    ownerPhase?: NonNullable<ReturnType<typeof readWindowsInstallerOwnerObservation>>["ownerPhase"]
    payloadProgress?: Readonly<
      PayloadProgress & { lastCheckpoint: PayloadCheckpoint; installerExitedAtFailure: boolean }
    >
  }>
>()

/** Only authored phases and allowlisted native codes leave the runner. Keeping
 * observations private to this module prevents arbitrary error fields becoming
 * public diagnostics; neither messages, paths nor stacks are copied. */
export function readNativeUpgradeObservation(error: unknown) {
  return error instanceof Error ? observations.get(error) : undefined
}

function observedFailure(
  phase: NativeUpgradePhase,
  error: unknown,
  result = error instanceof Error ? error : failure("INSTALLER_UNCONFIRMED"),
) {
  const existing = readNativeUpgradeObservation(error)
  if (existing) {
    observations.set(result, existing)
    return result
  }
  const code = (() => {
    try {
      return (error as NodeJS.ErrnoException)?.code
    } catch {
      return undefined
    }
  })()
  observations.set(
    result,
    Object.freeze({
      phase,
      nativeCode: nativeCodes.some((value) => value === code) ? code! : "OTHER",
      ...readWindowsInstallerOwnerObservation(error),
    }),
  )
  return result
}

/** Observe actual in-place bytes, not a download/preflight failure. A same-size
 * preallocated CopyFile destination counts only after its leading target bytes
 * arrived while its trailing target bytes are still incomplete. */
export async function observePartialWindowsPayload(
  file: string,
  targetReference: string,
  targetBytes: number,
  io: { openPayload?: typeof open; onCheckpoint?: (checkpoint: (typeof payloadCheckpoints)[number]) => void } = {},
) {
  const stat = await lstat(file).catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? undefined : Promise.reject(observedFailure("payload-stat", error)),
  )
  if (!stat) {
    io.onCheckpoint?.("absent")
    return "ABSENT" as const
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > targetBytes)
    return "UNCONFIRMED" as const
  const count = Math.min(64 * 1024, stat.size, targetBytes)
  const actual = await (io.openPayload ?? open)(file, "r").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    // Hosted NSIS extraction can hold this live destination busy. That is no
    // evidence of removal or partial bytes; observe again within the same gate.
    if (error.code === "EBUSY") return null
    throw observedFailure("payload-open", error)
  })
  if (actual === null) {
    io.onCheckpoint?.("busyOpen")
    return "UNCONFIRMED" as const
  }
  if (!actual) {
    io.onCheckpoint?.("absent")
    return "ABSENT" as const
  }
  io.onCheckpoint?.("readableOpen")
  let target: Awaited<ReturnType<typeof open>> | undefined
  try {
    target = await open(targetReference, "r").catch((error) => {
      throw observedFailure("reference-open", error)
    })
    const sample = async (handle: typeof actual, position: number, bytes: number) => {
      const buffer = Buffer.alloc(bytes)
      const read = await handle.read(buffer, 0, bytes, position).catch((error) => {
        throw observedFailure(handle === actual ? "payload-read" : "reference-read", error)
      })
      return read.bytesRead === bytes ? createHash("sha256").update(buffer).digest("hex") : undefined
    }
    const [prefix, expectedPrefix] = await Promise.all([sample(actual, 0, count), sample(target, 0, count)])
    if (!prefix || prefix !== expectedPrefix) return "UNCONFIRMED" as const
    if (stat.size < targetBytes) {
      io.onCheckpoint?.("partial")
      return "PARTIAL" as const
    }
    const [suffix, expectedSuffix] = await Promise.all([
      sample(actual, targetBytes - count, count),
      sample(target, targetBytes - count, count),
    ])
    if (suffix && expectedSuffix && suffix !== expectedSuffix) {
      io.onCheckpoint?.("partial")
      return "PARTIAL" as const
    }
    if (suffix && expectedSuffix && suffix === expectedSuffix) io.onCheckpoint?.("sampledEndsMatch")
    return "UNCONFIRMED" as const
  } finally {
    await actual.close().catch((error) => {
      throw observedFailure("payload-close", error)
    })
    await target?.close().catch((error) => {
      throw observedFailure("reference-close", error)
    })
  }
}

/** Exact public installer mutation only, on an owned disposable runner. The
 * existing controller supplies process-tree inspection; it never supplies PASS.
 * A Windows recovery attempt is deliberately not retried if extraction finishes
 * before an actual partial destination can be observed. */
export async function runNativeUpgradeInstaller(
  input: {
    env: NodeJS.ProcessEnv
    root: string
    format: "nsis" | "deb"
    action: "install" | "interrupt"
    artifact: string
    artifactSha256: string
    version: string
    installation: string
    baselinePayloadSha256: string
    targetPayloadSha256: string
    targetAsarReference?: { file: string; bytes: number; sha256: string }
    descendants(pid: number): Promise<number[]>
  },
  options: {
    spawn?: (executable: string, args: readonly string[], options: SpawnOptions) => ChildProcess
    startOwner?: typeof startWindowsInstallerOwner
    observePayload?: typeof observePartialWindowsPayload
    platform?: NodeJS.Platform
    timeoutMs?: number
  } = {},
) {
  const platform = options.platform ?? process.platform
  await requireDisposablePublicRunner(input.env, input.root, platform)
  const windows = input.format === "nsis"
  if (
    (windows ? platform !== "win32" : platform !== "linux") ||
    !["nsis", "deb"].includes(input.format) ||
    !["install", "interrupt"].includes(input.action)
  )
    throw failure("FORMAT_INVALID")
  const identity = desktopIdentity("public")
  if (
    !candidateNames(input.version, windows ? "windows-x64" : "linux-x64").some(
      (item) => item.format === input.format && item.name === basename(input.artifact),
    ) ||
    input.installation !== (windows ? join(input.root, "payload") : `/opt/${identity.productName}`) ||
    (await sha256File(input.artifact)) !== input.artifactSha256
  )
    throw failure("ARTIFACT_CHANGED")
  const executable = windows
    ? join(input.installation, `${identity.productName}.exe`)
    : join(input.installation, identity.executableName)
  const interrupted = input.action === "interrupt"
  if (interrupted && (await payloadFingerprint(executable)).sha256 !== input.baselinePayloadSha256)
    throw failure("BASELINE_UNCONFIRMED")
  if (windows && interrupted) {
    const reference = input.targetAsarReference
    if (
      !reference ||
      !Number.isSafeInteger(reference.bytes) ||
      reference.bytes < 128 * 1024 ||
      (await lstat(reference.file)).size !== reference.bytes ||
      (await sha256File(reference.file)) !== reference.sha256
    )
      throw failure("TARGET_UNCONFIRMED")
  }
  const timeout = options.timeoutMs ?? 120000
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120000) throw failure("TIMEOUT_INVALID")
  const command = windows ? input.artifact : "/usr/bin/sudo"
  const args = windows
    ? nsisInstallArguments(input.installation).args
    : ["-n", "/usr/bin/dpkg", interrupted ? "--unpack" : "--install", input.artifact]
  const deadline = Date.now() + timeout
  let child: ChildProcess | undefined
  let owner: WindowsInstallerOwner | undefined
  let exited = false
  let exitCode: number | null = null
  let nativeStopConfirmed = false
  let processError = false
  let processFailure: Error | undefined
  let closed: Promise<void>
  if (windows && interrupted) {
    owner = await (options.startOwner ?? startWindowsInstallerOwner)({
      env: input.env,
      root: input.root,
      artifact: input.artifact,
      installation: input.installation,
      timeoutMs: timeout,
    }).catch((error) => {
      throw observedFailure("installer-owner", error)
    })
    closed = owner.completion.then(
      (value) => {
        if (value.jobEmpty !== true || !Number.isInteger(value.exitCode)) {
          processError = true
          processFailure = observedFailure("installer-owner", failure("INSTALLER_UNCONFIRMED"))
          return
        }
        nativeStopConfirmed = value.stopped === true
        exited = true
        exitCode = value.exitCode
      },
      (error) => {
        processError = true
        processFailure = observedFailure("installer-owner", error)
      },
    )
  } else {
    try {
      child = (options.spawn ?? spawn)(command, args, {
        cwd: input.root,
        env: input.env,
        shell: false,
        stdio: "ignore",
        ...(windows ? nsisSpawnOptions(command) : {}),
      })
    } catch (error) {
      throw observedFailure("installer-spawn", error)
    }
    closed = new Promise<void>((resolve) => {
      child!.once("error", (error) => {
        processError = true
        processFailure = observedFailure("installer-spawn", error, failure("INSTALLER_UNCONFIRMED"))
        resolve()
      })
      child!.once("close", (code) => {
        exited = true
        exitCode = code
        resolve()
      })
    })
  }
  const installerPid = owner?.pid ?? child?.pid
  const owned = new Set<number>()
  let lastInspection = 0
  let inspection: Promise<void> | undefined
  let inspectionError = false
  let inspectionFailure: Error | undefined
  const inspect = () => {
    if (inspection || !installerPid) return
    lastInspection = Date.now()
    inspection = input
      .descendants(installerPid)
      .then((values) => {
        for (const pid of values) {
          if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) throw failure("INSTALLER_UNCONFIRMED")
          owned.add(pid)
        }
      })
      .catch((error) => {
        inspectionError = true
        inspectionFailure = observedFailure("installer-inspection", error, failure("INSTALLER_UNCONFIRMED"))
      })
      .finally(() => {
        inspection = undefined
      })
  }
  let removed = false
  let stoppedInstaller = false
  const payloadProgress: PayloadProgress = { absent: 0, busyOpen: 0, readableOpen: 0, sampledEndsMatch: 0, partial: 0 }
  let lastPayloadCheckpoint: PayloadCheckpoint = "not-observed"
  const recordCheckpoint = (checkpoint: (typeof payloadCheckpoints)[number]) => {
    if (payloadCheckpoints.includes(checkpoint)) {
      payloadProgress[checkpoint] = Math.min(payloadProgress[checkpoint] + 1, 1000000)
      lastPayloadCheckpoint = checkpoint
    }
  }
  try {
    while (!exited && !processError) {
      if (!installerPid || !Number.isSafeInteger(installerPid) || installerPid <= 0)
        throw observedFailure("installer-pid", failure("INSTALLER_UNCONFIRMED"))
      if (Date.now() >= deadline) throw failure("INSTALLER_TIMEOUT")
      if (inspectionError) throw inspectionFailure!
      // CIM/PowerShell can take seconds. Never await that query on the actual
      // partial-copy watcher; allow only one owned bounded snapshot in flight.
      if (Date.now() - lastInspection >= 150) inspect()
      if (windows && interrupted && !stoppedInstaller) {
        const reference = input.targetAsarReference!
        let busyDestination = false
        const observation = await (options.observePayload ?? observePartialWindowsPayload)(
          join(input.installation, "resources", "app.asar"),
          reference.file,
          reference.bytes,
          {
            onCheckpoint(checkpoint) {
              recordCheckpoint(checkpoint)
              if (checkpoint === "busyOpen") busyDestination = true
            },
          },
        ).catch((error) => {
          throw observedFailure("payload-observation", error)
        })
        if (observation === "ABSENT") removed = true
        // A current busy nonempty destination can justify stopping this owned
        // installer, but never proves partial bytes or authorizes recovery.
        if (removed && (observation === "PARTIAL" || busyDestination)) {
          if (exited) throw failure("INTERRUPTION_UNCONFIRMED")
          await owner!.stop().catch((error) => {
            throw observedFailure("installer-owner", error)
          })
          stoppedInstaller = true
        }
      }
      await Promise.race([closed, pause(windows && interrupted ? 5 : 50)])
    }
    if (processError || !exited) throw processFailure ?? failure("INSTALLER_UNCONFIRMED")
    if (inspection) await Promise.race([inspection, pause(10000)])
    if (inspection || inspectionError)
      throw observedFailure("installer-inspection", inspectionFailure, failure("INSTALLER_DESCENDANT_RETAINED"))
    // Windows retains ParentProcessId after parent exit. One final bounded
    // snapshot catches children born after the last background observation.
    if (windows) {
      inspect()
      await Promise.race([inspection, pause(10000)])
      if (inspection || inspectionError)
        throw observedFailure("installer-inspection", inspectionFailure, failure("INSTALLER_DESCENDANT_RETAINED"))
    }
    const cleanupDeadline = Date.now() + 10000
    while (
      [...owned].some((pid) => {
        try {
          process.kill(pid, 0)
          return true
        } catch (error) {
          return (error as NodeJS.ErrnoException).code !== "ESRCH"
        }
      })
    ) {
      if (Date.now() >= cleanupDeadline) throw failure("INSTALLER_DESCENDANT_RETAINED")
      await pause(50)
    }
    if (!interrupted) {
      if (exitCode !== 0) throw failure("INSTALLER_FAILED")
      return { installerExited: true, descendantsExited: true } as const
    }
    if (!windows) {
      if (exitCode !== 0) throw failure("INSTALLER_FAILED")
      requireDebianUpgradeStatus(await readFile("/var/lib/dpkg/status", "utf8"), input.version, "unpacked")
      if ((await payloadFingerprint(executable)).sha256 !== input.targetPayloadSha256)
        throw failure("TARGET_UNCONFIRMED")
      return {
        kind: "debian-unpacked-before-configuration",
        installerExited: true,
        descendantsExited: true,
        baselinePayloadChanged: true,
        targetInstallationComplete: false,
      } satisfies UpgradeInterruption
    }
    if (!stoppedInstaller) throw failure("INTERRUPTION_UNOBSERVED")
    if (!nativeStopConfirmed) throw failure("INTERRUPTION_UNCONFIRMED")
    // All native mutation has stopped. Read the real destination again for
    // both trigger paths; neither a prior sample nor a busy event is proof.
    if (
      (await observePartialWindowsPayload(
        join(input.installation, "resources", "app.asar"),
        input.targetAsarReference!.file,
        input.targetAsarReference!.bytes,
        { onCheckpoint: recordCheckpoint },
      )) !== "PARTIAL"
    )
      throw failure("INTERRUPTION_UNCONFIRMED")
    const after = await payloadFingerprint(executable)
      .then((value) => value.sha256)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw failure("TARGET_UNCONFIRMED")
      })
    if (after === input.baselinePayloadSha256 || after === input.targetPayloadSha256)
      throw failure("INTERRUPTION_UNCONFIRMED")
    return {
      kind: "windows-partial-payload-copy",
      installerExited: true,
      descendantsExited: true,
      baselinePayloadChanged: true,
      targetInstallationComplete: false,
    } satisfies UpgradeInterruption
  } catch (error) {
    const installerExitedAtFailure = exited
    // A timeout/error grants no recovery authority. Stop only this owned child,
    // bound the wait, and let the caller retain uncertain package/system state.
    if (owner) {
      // The owner already bounds its own helper-close wait. A failed abort
      // retains uncertainty; it cannot grant recovery or extend that wait.
      await owner.abort().catch(() => {})
    } else {
      if (!exited && child?.pid) {
        try {
          child.kill()
        } catch {
          /* No exit proof follows from a failed kill request. */
        }
      }
      await Promise.race([closed, pause(10000)])
      if (!exited) child?.unref()
    }
    const result =
      error instanceof Error && /^PUBLIC_UPGRADE_[A-Z_]+$/.test(error.message)
        ? error
        : failure("INSTALLER_UNCONFIRMED")
    const observation = readNativeUpgradeObservation(error)
    if (observation) observations.set(result, observation)
    if (windows && interrupted)
      observations.set(
        result,
        Object.freeze({
          ...(observation ?? { phase: "payload-observation" as const, nativeCode: "OTHER" }),
          payloadProgress: Object.freeze({
            ...payloadProgress,
            lastCheckpoint: lastPayloadCheckpoint,
            installerExitedAtFailure,
          }),
        }),
      )
    throw result
  }
}
