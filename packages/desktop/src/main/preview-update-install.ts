import { spawn } from "node:child_process"
import type { ChildProcess, SpawnOptions } from "node:child_process"
import { lstat, realpath } from "node:fs/promises"
import { posix, win32 } from "node:path"
import { compareVersion } from "../../../physicalsystems/src/release/inputs"

type InstallationInput = { platform: string; arch: string; executablePath: string; currentVersion: string }
type FileObservation = { file: boolean; symbolicLink: boolean; bytes: number }
type Dependencies = {
  spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess
  realpath?: (file: string) => Promise<string>
  inspectFile?: (file: string) => Promise<FileObservation>
  commandTimeoutMs?: number
  installTimeoutMs?: number
}
type Installation =
  | { platform: "win32"; format: "nsis" }
  | { platform: "linux"; format: "deb"; installedVersion: string }
type CommandObservation = {
  started: boolean
  code: number | null
  stdout: string
  timedOut: boolean
  overflow: boolean
}

const packageName = "physical-systems-desktop"
const packageQuery = ["--show", "--showformat=${Package}\n${Version}\n${Status}\n${Architecture}\n", "--", packageName]

export class PreviewUpdateInstallError extends Error {
  constructor(
    readonly code:
      | "UNSUPPORTED_INSTALLATION"
      | "INVALID_INSTALLER"
      | "INSTALLER_LAUNCH_FAILED"
      | "INSTALLER_LAUNCH_UNCONFIRMED"
      | "INSTALLATION_CANCELLED"
      | "INSTALLATION_FAILED"
      | "INSTALLATION_UNCONFIRMED",
    readonly installationUncertain = false,
  ) {
    super(`PREVIEW_UPDATE_${code}`)
    this.name = "PreviewUpdateInstallError"
  }
}

/** Compiled public identity/channel eligibility is checked by the caller. These
 * native observations additionally exclude unpacked Windows and Linux AppImage
 * launches. Neither an environment marker nor a filename alone grants support.
 */
export async function inspectPreviewUpdateInstallation(
  input: InstallationInput,
  dependencies: Dependencies = {},
): Promise<Installation | undefined> {
  if (input.arch !== "x64" || !["win32", "linux"].includes(input.platform)) return
  const paths = input.platform === "win32" ? win32 : posix
  if (!validPath(input.executablePath, paths.isAbsolute)) return
  try {
    if (input.currentVersion.length > 80 || compareVersion(input.currentVersion, input.currentVersion) !== 0) return
    const executable = await (dependencies.realpath ?? realpath)(input.executablePath)
    if (!validPath(executable, paths.isAbsolute)) return
    if (!(await regularFile(executable, dependencies))) return
    if (input.platform === "win32") {
      if (paths.basename(executable).toLowerCase() !== "physical systems.exe") return
      const uninstaller = paths.join(paths.dirname(executable), "Uninstall Physical Systems.exe")
      if (!(await regularFile(uninstaller, dependencies))) return
      if ((await (dependencies.realpath ?? realpath)(uninstaller)).toLowerCase() !== uninstaller.toLowerCase()) return
      return { platform: "win32", format: "nsis" }
    }
    const owner = await runCommand("/usr/bin/dpkg-query", ["--search", "--", executable], dependencies)
    if (!completed(owner) || owner.stdout.trim() !== `${packageName}: ${executable}`) return
    const installed = await runCommand("/usr/bin/dpkg-query", packageQuery, dependencies)
    const version = installedPackage(installed.stdout)
    if (!completed(installed) || !version || version !== input.currentVersion.replace("-beta.", "~beta.") + "-0") return
    return {
      platform: "linux",
      format: "deb",
      installedVersion: version.replace("~beta.", "-beta.").replace(/-0$/, ""),
    }
  } catch {
    return
  }
}

/** The caller must own and hash-verify this installer immediately before calling,
 * obtain explicit confirmation, and finish operator/credential/process cleanup.
 * Windows acknowledges launch only; it never reports installer completion.
 */
export async function installPreviewUpdate(
  input: InstallationInput & { installerPath: string; expectedVersion: string; verifyInstaller(): Promise<void> },
  dependencies: Dependencies = {},
): Promise<{ status: "handed-off" | "installed"; version: string }> {
  if (
    input.expectedVersion.length > 80 ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.[1-9]\d*$/.test(input.expectedVersion) ||
    !newerVersion(input.expectedVersion, input.currentVersion)
  )
    throw new PreviewUpdateInstallError("INVALID_INSTALLER")
  const installation = await inspectPreviewUpdateInstallation(input, dependencies)
  if (!installation) throw new PreviewUpdateInstallError("UNSUPPORTED_INSTALLATION")
  const paths = installation.platform === "win32" ? win32 : posix
  const name = `physical-systems-desktop-${input.expectedVersion}-${installation.platform === "win32" ? "windows-x64.exe" : "linux-x64.deb"}`
  if (!validPath(input.installerPath, paths.isAbsolute) || paths.basename(input.installerPath) !== name)
    throw new PreviewUpdateInstallError("INVALID_INSTALLER")
  const valid = await regularFile(input.installerPath, dependencies).catch(() => false)
  const canonical = await (dependencies.realpath ?? realpath)(input.installerPath).catch(() => "")
  const equivalent =
    installation.platform === "win32"
      ? canonical.toLowerCase() === paths.resolve(input.installerPath).toLowerCase()
      : canonical === paths.resolve(input.installerPath)
  if (!valid || !equivalent) throw new PreviewUpdateInstallError("INVALID_INSTALLER")
  // Rehash the exact selected release bytes after the asynchronous native
  // installation probes, immediately before handing this owned file to the OS.
  await input.verifyInstaller()
  if (installation.platform === "win32") {
    await launchWindowsInstaller(input.installerPath, dependencies)
    return { status: "handed-off", version: input.expectedVersion }
  }
  const result = await runCommand(
    "/usr/bin/pkexec",
    ["/usr/bin/dpkg", "--refuse-downgrade", "--install", input.installerPath],
    dependencies,
    true,
  )
  if (!result.started) throw new PreviewUpdateInstallError("INSTALLER_LAUNCH_FAILED")
  if (result.timedOut || result.overflow) throw new PreviewUpdateInstallError("INSTALLATION_UNCONFIRMED", true)
  // pkexec documents 126 as dismissal of its authentication dialog. No package
  // manager was launched. Other nonzero exits may follow partial replacement.
  if (result.code === 126) throw new PreviewUpdateInstallError("INSTALLATION_CANCELLED")
  if (result.code !== 0) throw new PreviewUpdateInstallError("INSTALLATION_FAILED", true)
  const installed = await runCommand("/usr/bin/dpkg-query", packageQuery, dependencies)
  if (
    !completed(installed) ||
    installedPackage(installed.stdout) !== input.expectedVersion.replace("-beta.", "~beta.") + "-0"
  )
    throw new PreviewUpdateInstallError("INSTALLATION_UNCONFIRMED", true)
  return { status: "installed", version: input.expectedVersion }
}

function validPath(file: string, absolute: (file: string) => boolean) {
  return file.length > 0 && file.length <= 32768 && !/[\x00-\x1f\x7f]/.test(file) && absolute(file)
}

function newerVersion(target: string, current: string) {
  try {
    return current.length <= 80 && compareVersion(target, current) > 0
  } catch {
    return false
  }
}

async function regularFile(file: string, dependencies: Dependencies) {
  const stat = dependencies.inspectFile
    ? await dependencies.inspectFile(file)
    : await lstat(file).then((value) => ({
        file: value.isFile(),
        symbolicLink: value.isSymbolicLink(),
        bytes: value.size,
      }))
  return stat.file && !stat.symbolicLink && Number.isSafeInteger(stat.bytes) && stat.bytes > 0
}

function installedPackage(output: string) {
  const fields = output.trimEnd().split("\n")
  if (
    fields.length !== 4 ||
    fields[0] !== packageName ||
    fields[2] !== "install ok installed" ||
    fields[3] !== "amd64" ||
    !/^\d+\.\d+\.\d+(?:~beta\.[1-9]\d*)?-0$/.test(fields[1]!)
  )
    return
  return fields[1]
}

function timeout(dependencies: Dependencies, installing = false) {
  const value = installing ? (dependencies.installTimeoutMs ?? 600000) : (dependencies.commandTimeoutMs ?? 15000)
  if (!Number.isInteger(value) || value < 1 || value > (installing ? 600000 : 15000))
    throw new PreviewUpdateInstallError("INVALID_INSTALLER")
  return value
}

function completed(value: CommandObservation) {
  return value.started && value.code === 0 && !value.timedOut && !value.overflow
}

function nativeEnvironment() {
  // Package ownership must come from the real system database, even when the
  // app inherited a developer's DPKG_ROOT/DPKG_ADMINDIR or executable search path.
  // Preserve only session addresses needed to reach the existing Polkit agent.
  const session = ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"]
  return {
    ...Object.fromEntries(session.flatMap((key) => (process.env[key] ? [[key, process.env[key]!]] : []))),
    PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
    LC_ALL: "C",
    DPKG_ROOT: "/",
    DPKG_ADMINDIR: "/var/lib/dpkg",
  }
}

function runCommand(command: string, args: readonly string[], dependencies: Dependencies, installing = false) {
  const limit = timeout(dependencies, installing)
  return new Promise<CommandObservation>((resolve) => {
    const result: CommandObservation = { started: false, code: null, stdout: "", timedOut: false, overflow: false }
    let child: ChildProcess
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...result })
    }
    const timer = setTimeout(() => {
      result.timedOut = true
      // Killing dpkg can leave a partial installation. Preserve uncertainty and
      // allow the already-launched native installer to finish independently.
      child?.unref()
      finish()
    }, limit)
    try {
      child = (dependencies.spawn ?? spawn)(command, args, {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
        env: nativeEnvironment(),
      })
      child.once("spawn", () => {
        result.started = true
      })
      child.stdout?.on("data", (chunk: Buffer) => {
        if (settled || result.overflow) return
        if (Buffer.byteLength(result.stdout) + chunk.length > 8192) {
          result.overflow = true
          result.stdout = ""
          return
        }
        result.stdout += chunk.toString("utf8")
      })
      child.once("error", finish)
      child.once("close", (code) => {
        result.code = code
        finish()
      })
    } catch {
      finish()
    }
  })
}

function launchWindowsInstaller(installer: string, dependencies: Dependencies) {
  const limit = timeout(dependencies)
  return new Promise<void>((resolve, reject) => {
    let child: ChildProcess
    let settled = false
    const finish = (error?: PreviewUpdateInstallError) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => {
      child?.unref()
      finish(new PreviewUpdateInstallError("INSTALLER_LAUNCH_UNCONFIRMED", true))
    }, limit)
    try {
      child = (dependencies.spawn ?? spawn)(installer, [], {
        shell: false,
        detached: true,
        windowsHide: false,
        stdio: "ignore",
      })
      child.once("spawn", () => {
        child.unref()
        finish()
      })
      child.once("error", () => finish(new PreviewUpdateInstallError("INSTALLER_LAUNCH_FAILED")))
      child.once("close", () => finish(new PreviewUpdateInstallError("INSTALLER_LAUNCH_UNCONFIRMED", true)))
    } catch {
      finish(new PreviewUpdateInstallError("INSTALLER_LAUNCH_FAILED"))
    }
  })
}
