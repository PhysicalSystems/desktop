import { spawn } from "node:child_process"
import type { ChildProcess, SpawnOptions } from "node:child_process"
import { open } from "node:fs/promises"
import { compareVersion } from "../../../physicalsystems/src/release/inputs"
import { inspectPreviewUpdateInstallation } from "./preview-update-install"

type RecoveryInput = {
  platform: string
  arch: string
  executablePath: string
  currentVersion: string
  attempt: { from: string; to: string; sha256: string }
}
type Dependencies = {
  inspectInstallation?: typeof inspectPreviewUpdateInstallation
  spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess
  readMountInfo?: () => Promise<string>
  timeoutMs?: number
}
export type PreviewUpdateRecovery = { status: "installed" | "not-installed" | "uncertain" }

/** Read-only evidence for an explicit recovery request. This function neither
 * clears the attempt journal nor authorizes installation. Any unavailable or
 * ambiguous native observation keeps the previous attempt blocked.
 */
export async function inspectPreviewUpdateRecovery(
  input: RecoveryInput,
  dependencies: Dependencies = {},
): Promise<PreviewUpdateRecovery> {
  const uncertain = { status: "uncertain" } as const
  try {
    const attempt = { ...input.attempt }
    const installation = {
      platform: input.platform,
      arch: input.arch,
      executablePath: input.executablePath,
      currentVersion: input.currentVersion,
    }
    if (
      !["win32", "linux"].includes(installation.platform) ||
      installation.arch !== "x64" ||
      !previewVersion(attempt.from) ||
      !previewVersion(attempt.to) ||
      !/^[a-f0-9]{64}$/.test(attempt.sha256) ||
      compareVersion(attempt.to, attempt.from) <= 0 ||
      installation.currentVersion.length > 80
    )
      return uncertain
    const reachedTarget = compareVersion(installation.currentVersion, attempt.to) >= 0
    if (!reachedTarget && installation.currentVersion !== attempt.from) return uncertain
    const inspect = dependencies.inspectInstallation ?? inspectPreviewUpdateInstallation
    if (installation.platform === "win32") {
      // An NSIS parent can leave its differently named old-uninstaller worker
      // behind. Absence of the original installer name cannot prove cancellation.
      // Only an actually running, supported target-or-newer app acknowledges it.
      return reachedTarget && (await inspect(installation)) ? { status: "installed" } : uncertain
    }
    // dpkg may have finished replacing the package while this process still
    // executes the old code. Inspect the installed target separately, without
    // treating its existence as permission to install it again.
    const expected = { ...installation, currentVersion: reachedTarget ? installation.currentVersion : attempt.to }
    const installed = Boolean(await inspect(expected))
    const observed = installed ? expected : installation
    if (!installed && (reachedTarget || !(await inspect(installation)))) return uncertain
    if (!(await linuxInstallerInactive(dependencies))) return uncertain
    // Recheck identity after the process observation. A package changing or
    // becoming partially installed cannot be acknowledged or cleared.
    if (!(await inspect(observed))) return uncertain
    return { status: installed ? "installed" : "not-installed" }
  } catch {
    return uncertain
  }
}

function previewVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 80 &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.[1-9]\d*$/.test(value) &&
    compareVersion(value, "0.1.0-beta.1") >= 0
  )
}

async function linuxInstallerInactive(dependencies: Dependencies) {
  // A normal user's pgrep cannot observe root-owned installers on hidepid
  // procfs mounts. An absent result is useful only with an unrestricted view.
  if (!unrestrictedProcfs(await (dependencies.readMountInfo ?? readMountInfo)())) return false
  // Ubuntu's unattended-upgr shutdown-wait daemon can remain idle indefinitely.
  // Observe actual package-manager processes, not that unrelated daemon. Any
  // eventual new dpkg installation still acquires dpkg's own installation lock.
  const observation = await query(
    "/usr/bin/pgrep",
    ["--exact", "dpkg|apt|apt-get|pkexec"],
    { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" },
    dependencies,
  )
  return observation?.code === 1 && observation.stdout === ""
}

function unrestrictedProcfs(source: string) {
  if (Buffer.byteLength(source) > 131072) return false
  let found = false
  for (const line of source.trimEnd().split("\n")) {
    const fields = line.split(" ")
    const separator = fields.indexOf("-", 6)
    if (separator < 6 || fields.length !== separator + 4) return false
    // A bind mounted PID directory could hide an individual native installer.
    if (/^\/proc\/[0-9]+(?:\/|$)/.test(fields[4]!)) return false
    if (fields[4] !== "/proc") continue
    if (found || fields[3] !== "/" || fields[separator + 1] !== "proc") return false
    const options = [fields[5], fields[separator + 3]].join(",").split(",")
    if (options.some((option) => option.startsWith("hidepid") && option !== "hidepid=0")) return false
    found = true
  }
  return found
}

async function readMountInfo() {
  const file = await open("/proc/self/mountinfo", "r")
  try {
    const buffer = Buffer.alloc(131073)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null)
      if (!bytesRead) return buffer.subarray(0, offset).toString("utf8")
      offset += bytesRead
    }
    throw new Error("PREVIEW_UPDATE_PROCESS_VISIBILITY_UNCONFIRMED")
  } finally {
    await file.close()
  }
}

function query(command: string, args: readonly string[], env: NodeJS.ProcessEnv, dependencies: Dependencies) {
  const timeout = dependencies.timeoutMs ?? 10_000
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 10_000) return Promise.resolve(undefined)
  return new Promise<{ code: number; stdout: string } | undefined>((resolve) => {
    let child: ChildProcess | undefined
    let started = false
    let finished = false
    let stdout = ""
    const finish = (code?: number | null) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolve(started && typeof code === "number" ? { code, stdout } : undefined)
    }
    const timer = setTimeout(() => {
      // Only the owned read-only probe is terminated, never an installer.
      finish()
      try {
        child?.kill()
      } catch {
        /* The observation already failed closed. */
      }
    }, timeout)
    try {
      child = (dependencies.spawn ?? spawn)(command, args, {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
        env,
      })
      child.once("spawn", () => {
        started = true
      })
      child.stdout?.on("data", (chunk: Buffer) => {
        if (finished) return
        if (Buffer.byteLength(stdout) + chunk.length > 4096) {
          finish()
          try {
            child?.kill()
          } catch {
            /* The observation already failed closed. */
          }
          return
        }
        stdout += chunk.toString("utf8")
      })
      child.once("error", () => finish())
      child.once("close", finish)
    } catch {
      finish()
    }
  })
}
