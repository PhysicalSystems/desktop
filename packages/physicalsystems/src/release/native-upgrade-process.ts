// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process"
import type { ChildProcess, SpawnOptions } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, open, readFile } from "node:fs/promises"
import { basename, join, win32 } from "node:path"
import { candidateNames } from "./artifacts"
import { desktopIdentity } from "./identity"
import { nsisInstallArguments, nsisSpawnOptions } from "./installed-reinstall"
import { requireDebianUpgradeStatus } from "./installed-upgrade"
import type { UpgradeInterruption } from "./installed-upgrade"
import { requireDisposablePublicRunner } from "./public-qualification"
import { payloadFingerprint, sha256File } from "./qualification"

const failure = (name: string) => new Error(`PUBLIC_UPGRADE_${name}`)
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Observe actual in-place bytes, not a download/preflight failure. A same-size
 * preallocated CopyFile destination counts only after its leading target bytes
 * arrived while its trailing target bytes are still incomplete. */
export async function observePartialWindowsPayload(file: string, targetReference: string, targetBytes: number) {
  const stat = await lstat(file).catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? undefined : Promise.reject(error),
  )
  if (!stat) return "ABSENT" as const
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > targetBytes)
    return "UNCONFIRMED" as const
  const count = Math.min(64 * 1024, stat.size, targetBytes)
  const actual = await open(file, "r").catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? undefined : Promise.reject(error),
  )
  if (!actual) return "ABSENT" as const
  let target: Awaited<ReturnType<typeof open>> | undefined
  try {
    target = await open(targetReference, "r")
    const sample = async (handle: typeof actual, position: number, bytes: number) => {
      const buffer = Buffer.alloc(bytes)
      const read = await handle.read(buffer, 0, bytes, position)
      return read.bytesRead === bytes ? createHash("sha256").update(buffer).digest("hex") : undefined
    }
    const [prefix, expectedPrefix] = await Promise.all([sample(actual, 0, count), sample(target, 0, count)])
    if (!prefix || prefix !== expectedPrefix) return "UNCONFIRMED" as const
    if (stat.size < targetBytes) return "PARTIAL" as const
    const [suffix, expectedSuffix] = await Promise.all([
      sample(actual, targetBytes - count, count),
      sample(target, targetBytes - count, count),
    ])
    return suffix && expectedSuffix && suffix !== expectedSuffix ? ("PARTIAL" as const) : ("UNCONFIRMED" as const)
  } finally {
    await actual.close()
    await target?.close()
  }
}

/** Terminate only this still-live owned installer's tree. /T selects its
 * descendants; no image-name/global process selection is accepted. The native
 * helper's close is necessary but never substitutes for installer/child proof. */
export async function stopOwnedWindowsInstaller(
  child: ChildProcess,
  input: {
    env: NodeJS.ProcessEnv
    spawn?: (executable: string, args: readonly string[], options: SpawnOptions) => ChildProcess
  },
) {
  if (
    !Number.isSafeInteger(child.pid) ||
    !child.pid ||
    child.pid <= 0 ||
    child.pid === process.pid ||
    child.exitCode !== null ||
    child.signalCode !== null
  )
    throw failure("INTERRUPTION_UNCONFIRMED")
  const system = input.env.SystemRoot || input.env.SYSTEMROOT
  if (!system || !/^[A-Za-z]:\\/.test(system) || win32.normalize(system) !== system || /["\r\n\0]/.test(system))
    throw failure("INSTALLER_UNCONFIRMED")
  const command = win32.join(system, "System32", "taskkill.exe")
  const killer = (input.spawn ?? spawn)(command, ["/PID", String(child.pid), "/T", "/F"], {
    env: input.env,
    shell: false,
    stdio: "ignore",
  })
  await new Promise<void>((resolve, reject) => {
    let finished = false
    const finish = (success: boolean) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      success ? resolve() : reject(failure("INSTALLER_DESCENDANT_RETAINED"))
    }
    const timer = setTimeout(() => {
      try {
        killer.kill()
      } catch {
        /* Only this owned helper may be stopped. */
      }
      killer.unref()
      finish(false)
    }, 10000)
    killer.once("error", () => finish(false))
    killer.once("close", (code) => finish(code === 0))
  })
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
  const child = (options.spawn ?? spawn)(command, args, {
    cwd: input.root,
    env: input.env,
    shell: false,
    stdio: "ignore",
    ...(windows ? nsisSpawnOptions(command) : {}),
  })
  let exited = false
  let exitCode: number | null = null
  let processError = false
  const closed = new Promise<void>((resolve) => {
    child.once("error", () => {
      processError = true
      resolve()
    })
    child.once("close", (code) => {
      exited = true
      exitCode = code
      resolve()
    })
  })
  const deadline = Date.now() + timeout
  const owned = new Set<number>()
  let lastInspection = 0
  let inspection: Promise<void> | undefined
  let inspectionError = false
  const inspect = () => {
    if (inspection || !child.pid) return
    lastInspection = Date.now()
    inspection = input
      .descendants(child.pid)
      .then((values) => {
        for (const pid of values) {
          if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) throw failure("INSTALLER_UNCONFIRMED")
          owned.add(pid)
        }
      })
      .catch(() => {
        inspectionError = true
      })
      .finally(() => {
        inspection = undefined
      })
  }
  let removed = false
  let stoppedPartial = false
  try {
    while (!exited && !processError) {
      if (!child.pid || !Number.isSafeInteger(child.pid) || child.pid <= 0) throw failure("INSTALLER_UNCONFIRMED")
      if (Date.now() >= deadline) throw failure("INSTALLER_TIMEOUT")
      if (inspectionError) throw failure("INSTALLER_UNCONFIRMED")
      // CIM/PowerShell can take seconds. Never await that query on the actual
      // partial-copy watcher; allow only one owned bounded snapshot in flight.
      if (Date.now() - lastInspection >= 150) inspect()
      if (windows && interrupted && !stoppedPartial) {
        const reference = input.targetAsarReference!
        const observation = await observePartialWindowsPayload(
          join(input.installation, "resources", "app.asar"),
          reference.file,
          reference.bytes,
        )
        if (observation === "ABSENT") removed = true
        if (removed && observation === "PARTIAL") {
          if (exited) throw failure("INTERRUPTION_UNCONFIRMED")
          await stopOwnedWindowsInstaller(child, { env: input.env, spawn: options.spawn })
          stoppedPartial = true
        }
      }
      await Promise.race([closed, pause(windows && interrupted ? 5 : 50)])
    }
    if (processError || !exited) throw failure("INSTALLER_UNCONFIRMED")
    if (inspection) await Promise.race([inspection, pause(10000)])
    if (inspection || inspectionError) throw failure("INSTALLER_DESCENDANT_RETAINED")
    // Windows retains ParentProcessId after parent exit. One final bounded
    // snapshot catches children born after the last background observation.
    if (windows) {
      inspect()
      await Promise.race([inspection, pause(10000)])
      if (inspection || inspectionError) throw failure("INSTALLER_DESCENDANT_RETAINED")
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
    if (!stoppedPartial) throw failure("INTERRUPTION_UNOBSERVED")
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
    // A timeout/error grants no recovery authority. Stop only this owned child,
    // bound the wait, and let the caller retain uncertain package/system state.
    if (!exited && child.pid) {
      try {
        child.kill()
      } catch {
        /* No exit proof follows from a failed kill request. */
      }
    }
    await Promise.race([closed, pause(10000)])
    if (!exited) child.unref()
    throw error instanceof Error && /^PUBLIC_UPGRADE_[A-Z_]+$/.test(error.message)
      ? error
      : failure("INSTALLER_UNCONFIRMED")
  }
}
