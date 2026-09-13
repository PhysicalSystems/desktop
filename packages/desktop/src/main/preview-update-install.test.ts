import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import type { ChildProcess, SpawnOptions } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import {
  inspectPreviewUpdateInstallation,
  installPreviewUpdate,
  PreviewUpdateInstallError,
} from "./preview-update-install"

const version = "0.1.0-beta.8"
const linux = {
  platform: "linux",
  arch: "x64",
  executablePath: "/opt/Physical Systems/physical-systems-desktop",
  installerPath: `/home/owner/Update cache/physical-systems-desktop-${version}-linux-x64.deb`,
  expectedVersion: version,
  currentVersion: "0.1.0-beta.7",
  verifyInstaller: async () => {},
}
const windows = {
  platform: "win32",
  arch: "x64",
  executablePath: "C:\\Users\\owner\\Programs\\Physical Systems\\Physical Systems.exe",
  installerPath: `C:\\Users\\owner\\Update cache\\physical-systems-desktop-${version}-windows-x64.exe`,
  expectedVersion: version,
  currentVersion: "0.1.0-beta.7",
  verifyInstaller: async () => {},
}
const packageState = (value = "0.1.0~beta.7-0", status = "install ok installed") =>
  `physical-systems-desktop\n${value}\n${status}\namd64\n`
const owner = `physical-systems-desktop: ${linux.executablePath}\n`
type Step = { stdout?: string; code?: number | null; error?: boolean; hanging?: boolean; notStarted?: boolean }

function fixture(steps: Step[]) {
  const calls: { command: string; args: readonly string[]; options: SpawnOptions }[] = []
  const children: { process: ChildProcess; unrefs: number; kills: number }[] = []
  return {
    calls,
    children,
    dependencies: {
      realpath: async (file: string) => file,
      inspectFile: async () => ({ file: true, symbolicLink: false, bytes: 100 }),
      spawn(command: string, args: readonly string[], options: SpawnOptions) {
        calls.push({ command, args, options })
        const step = steps.shift()
        if (!step) throw new Error("Unexpected native command")
        const output = new PassThrough()
        const child = { process: undefined as unknown as ChildProcess, unrefs: 0, kills: 0 }
        child.process = Object.assign(new EventEmitter(), {
          stdout: output,
          unref() {
            child.unrefs++
          },
          kill() {
            child.kills++
            return true
          },
        }) as unknown as ChildProcess
        children.push(child)
        queueMicrotask(() => {
          if (step.error) {
            child.process.emit("error", new Error("OS refused"))
            return
          }
          if (!step.notStarted) child.process.emit("spawn")
          if (step.stdout) output.write(step.stdout)
          if (step.hanging) return
          output.end()
          child.process.emit("close", step.code === undefined ? 0 : step.code)
        })
        return child.process
      },
    },
  }
}

async function failure(action: Promise<unknown>, code: PreviewUpdateInstallError["code"], uncertain = false) {
  const result = await action.then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(result).toBeInstanceOf(PreviewUpdateInstallError)
  expect(result).toMatchObject({ code, installationUncertain: uncertain })
}

test("only owned installed amd64 Debian executables qualify; package markers do not suffice", async () => {
  const valid = fixture([{ stdout: owner }, { stdout: packageState() }])
  expect(await inspectPreviewUpdateInstallation(linux, valid.dependencies)).toEqual({
    platform: "linux",
    format: "deb",
    installedVersion: "0.1.0-beta.7",
  })
  expect(valid.calls).toMatchObject([
    { command: "/usr/bin/dpkg-query", args: ["--search", "--", linux.executablePath], options: { shell: false } },
    {
      command: "/usr/bin/dpkg-query",
      args: [
        "--show",
        "--showformat=${Package}\n${Version}\n${Status}\n${Architecture}\n",
        "--",
        "physical-systems-desktop",
      ],
    },
  ])
  expect(valid.calls[0]!.options.env).toMatchObject({
    DPKG_ROOT: "/",
    DPKG_ADMINDIR: "/var/lib/dpkg",
    LC_ALL: "C",
    PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
  })
  expect(valid.calls[0]!.options.env).not.toHaveProperty("NODE_OPTIONS")
  for (const stdout of [
    "",
    owner.replace("physical-systems-desktop:", "unrelated-package:"),
    `${owner}${owner}`,
    owner.replace(linux.executablePath, "/tmp/squashfs-root/app"),
  ]) {
    const invalid = fixture([{ stdout }])
    expect(await inspectPreviewUpdateInstallation(linux, invalid.dependencies)).toBeUndefined()
    expect(invalid.calls).toHaveLength(1)
  }
})

test("unsupported platforms, architectures and relative paths never invoke a native command", async () => {
  const native = fixture([])
  for (const input of [
    { ...linux, platform: "darwin" },
    { ...linux, arch: "arm64" },
    { ...linux, executablePath: "relative/app" },
  ])
    expect(await inspectPreviewUpdateInstallation(input, native.dependencies)).toBeUndefined()
  expect(native.calls).toHaveLength(0)
})

test("Debian absence, partial installation and wrong architecture remain unsupported", async () => {
  for (const state of [
    packageState(undefined, "install ok unpacked"),
    packageState().replace("amd64", "arm64"),
    packageState().replace("physical-systems-desktop", "candidate"),
    packageState() + packageState(),
  ]) {
    const native = fixture([{ stdout: owner }, { stdout: state }])
    expect(await inspectPreviewUpdateInstallation(linux, native.dependencies)).toBeUndefined()
  }
  const native = fixture([{ error: true }])
  expect(await inspectPreviewUpdateInstallation(linux, native.dependencies)).toBeUndefined()
})

test("Windows requires both the public executable and nonsymlinked NSIS uninstaller", async () => {
  const native = fixture([])
  expect(await inspectPreviewUpdateInstallation(windows, native.dependencies)).toEqual({
    platform: "win32",
    format: "nsis",
  })
  expect(
    await inspectPreviewUpdateInstallation(
      { ...windows, executablePath: windows.executablePath.replace("Physical Systems.exe", "candidate.exe") },
      native.dependencies,
    ),
  ).toBeUndefined()
  expect(
    await inspectPreviewUpdateInstallation(windows, {
      ...native.dependencies,
      inspectFile: async (file) => ({ file: true, symbolicLink: file.includes("Uninstall"), bytes: 100 }),
    }),
  ).toBeUndefined()
  expect(
    await inspectPreviewUpdateInstallation(windows, {
      ...native.dependencies,
      realpath: async (file) => (file.includes("Uninstall") ? "C:\\other.exe" : file),
    }),
  ).toBeUndefined()
})

test("Windows runs the original interactive installer without shell, silent flags or hidden UI", async () => {
  const native = fixture([{ hanging: true }])
  expect(await installPreviewUpdate(windows, native.dependencies)).toEqual({ status: "handed-off", version })
  expect(native.calls).toEqual([
    {
      command: windows.installerPath,
      args: [],
      options: { shell: false, detached: true, windowsHide: false, stdio: "ignore" },
    },
  ])
  expect(native.children[0]!.unrefs).toBe(1)
  expect(native.children[0]!.kills).toBe(0)
  // Cancellation after spawn does not retroactively become installation success.
  native.children[0]!.process.emit("close", 1)
})

test("Windows launch errors and throws remain retryable; missing acknowledgement preserves uncertainty", async () => {
  const failed = fixture([{ error: true }])
  await failure(installPreviewUpdate(windows, failed.dependencies), "INSTALLER_LAUNCH_FAILED")
  await failure(
    installPreviewUpdate(windows, {
      ...failed.dependencies,
      spawn() {
        throw new Error("Launch rejected")
      },
    }),
    "INSTALLER_LAUNCH_FAILED",
  )
  const missing = fixture([{ notStarted: true }])
  await failure(installPreviewUpdate(windows, missing.dependencies), "INSTALLER_LAUNCH_UNCONFIRMED", true)
  const timed = fixture([{ notStarted: true, hanging: true }])
  await failure(
    installPreviewUpdate(windows, { ...timed.dependencies, commandTimeoutMs: 5 }),
    "INSTALLER_LAUNCH_UNCONFIRMED",
    true,
  )
  expect(timed.children[0]!.kills).toBe(0)
})

test("installer target is exact preview version and rejects relative, renamed, empty or symlinked payloads", async () => {
  for (const patch of [
    { expectedVersion: "0.1.0" },
    { expectedVersion: "0.1.0-beta.0" },
    { expectedVersion: "0.1.0-beta.7" },
    { expectedVersion: "0.1.0-beta.6" },
    { expectedVersion: "0.1.0-beta.9007199254740993" },
    { expectedVersion: "0.1.0-beta.8/other" },
    { installerPath: "relative.exe" },
    { installerPath: windows.installerPath.replace("beta.8", "beta.9") },
  ]) {
    const native = fixture([])
    await failure(installPreviewUpdate({ ...windows, ...patch }, native.dependencies), "INVALID_INSTALLER")
    expect(native.calls).toHaveLength(0)
  }
  for (const patch of [{ file: false }, { symbolicLink: true }, { bytes: 0 }]) {
    const native = fixture([])
    await failure(
      installPreviewUpdate(windows, {
        ...native.dependencies,
        inspectFile: async (file) => ({
          file: true,
          symbolicLink: false,
          bytes: 100,
          ...(file === windows.installerPath ? patch : {}),
        }),
      }),
      "INVALID_INSTALLER",
    )
  }
  const native = fixture([])
  await failure(
    installPreviewUpdate(windows, {
      ...native.dependencies,
      realpath: async (file) => (file === windows.installerPath ? "C:\\elsewhere\\installer.exe" : file),
    }),
    "INVALID_INSTALLER",
  )
})

test("Debian installer awaits successful native completion and independent exact installed-version readback", async () => {
  const native = fixture([
    { stdout: owner },
    { stdout: packageState() },
    {},
    { stdout: packageState("0.1.0~beta.8-0") },
  ])
  expect(await installPreviewUpdate(linux, native.dependencies)).toEqual({ status: "installed", version })
  expect(native.calls[2]).toMatchObject({
    command: "/usr/bin/pkexec",
    args: ["/usr/bin/dpkg", "--refuse-downgrade", "--install", linux.installerPath],
    options: { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
  })
  expect(native.calls[3]!.command).toBe("/usr/bin/dpkg-query")
})

test("last-moment selected-byte verification occurs after native probes and prevents installer launch on rejection", async () => {
  for (const input of [windows, linux]) {
    const native = fixture(input.platform === "linux" ? [{ stdout: owner }, { stdout: packageState() }] : [])
    let checked = false
    await expect(
      installPreviewUpdate(
        {
          ...input,
          async verifyInstaller() {
            expect(native.calls).toHaveLength(input.platform === "linux" ? 2 : 0)
            checked = true
            throw new Error("SELECTED_INSTALLER_BYTES_CHANGED")
          },
        },
        native.dependencies,
      ),
    ).rejects.toThrow("SELECTED_INSTALLER_BYTES_CHANGED")
    expect(checked).toBe(true)
    expect(native.calls.every((call) => call.command === "/usr/bin/dpkg-query")).toBe(true)
  }
  const native = fixture([
    { stdout: owner },
    { stdout: packageState() },
    {},
    { stdout: packageState("0.1.0~beta.8-0") },
  ])
  let verified = false
  await installPreviewUpdate(
    {
      ...linux,
      async verifyInstaller() {
        verified = true
      },
    },
    {
      ...native.dependencies,
      spawn(command, args, options) {
        if (command === "/usr/bin/pkexec") expect(verified).toBe(true)
        return native.dependencies.spawn(command, args, options)
      },
    },
  )
})

test("current or newer running versions never launch installation commands", async () => {
  for (const current of ["0.1.0~beta.8-0", "0.1.0~beta.9-0", "0.1.0-0", "1.0.0~beta.1-0"]) {
    const native = fixture([{ stdout: owner }, { stdout: packageState(current) }])
    await failure(
      installPreviewUpdate(
        { ...linux, currentVersion: current.replace("~beta.", "-beta.").replace(/-0$/, "") },
        native.dependencies,
      ),
      "INVALID_INSTALLER",
    )
    expect(native.calls).toHaveLength(0)
  }
})

test("a running app whose Debian installation changed cannot start a second installer", async () => {
  const native = fixture([{ stdout: owner }, { stdout: packageState("0.1.0~beta.8-0") }])
  await failure(installPreviewUpdate(linux, native.dependencies), "UNSUPPORTED_INSTALLATION")
  expect(native.calls).toHaveLength(2)
})

test("authentication dismissal is retryable and never invokes broad package repair", async () => {
  const native = fixture([{ stdout: owner }, { stdout: packageState() }, { code: 126 }])
  await failure(installPreviewUpdate(linux, native.dependencies), "INSTALLATION_CANCELLED")
  expect(native.calls).toHaveLength(3)
  const missing = fixture([{ stdout: owner }, { stdout: packageState() }, { error: true }])
  await failure(installPreviewUpdate(linux, missing.dependencies), "INSTALLER_LAUNCH_FAILED")
})

test("failed, interrupted or unconfirmed Debian installation does not permit false success or blind retry", async () => {
  for (const step of [{ code: 1 }, { code: null }, { code: 127 }]) {
    const native = fixture([{ stdout: owner }, { stdout: packageState() }, step])
    await failure(installPreviewUpdate(linux, native.dependencies), "INSTALLATION_FAILED", true)
    expect(native.calls).toHaveLength(3)
  }
  for (const step of [
    { stdout: packageState() },
    { stdout: packageState("0.1.0~beta.8-0", "install ok unpacked") },
    { error: true },
  ]) {
    const native = fixture([{ stdout: owner }, { stdout: packageState() }, {}, step])
    await failure(installPreviewUpdate(linux, native.dependencies), "INSTALLATION_UNCONFIRMED", true)
  }
})

test("native install timeout leaves the installer alive and records uncertain state", async () => {
  const native = fixture([{ stdout: owner }, { stdout: packageState() }, { hanging: true }])
  await failure(
    installPreviewUpdate(linux, { ...native.dependencies, installTimeoutMs: 5 }),
    "INSTALLATION_UNCONFIRMED",
    true,
  )
  expect(native.children[2]!.kills).toBe(0)
  expect(native.children[2]!.unrefs).toBe(1)
  expect(native.calls).toHaveLength(3)
  native.children[2]!.process.emit("close", 0)
})

test("bounded native output cannot establish ownership or post-install success", async () => {
  const native = fixture([{ stdout: owner + "x".repeat(8192) }])
  expect(await inspectPreviewUpdateInstallation(linux, native.dependencies)).toBeUndefined()
  const installed = fixture([
    { stdout: owner },
    { stdout: packageState() },
    {},
    { stdout: packageState("0.1.0~beta.8-0") + "x".repeat(8192) },
  ])
  await failure(installPreviewUpdate(linux, installed.dependencies), "INSTALLATION_UNCONFIRMED", true)
})

test("real inert child processes exercise spawn, stdout and close observations without executing system installers", async () => {
  const native = fixture([])
  const observations = [owner, packageState(), "", packageState("0.1.0~beta.8-0")]
  const calls: string[] = []
  expect(
    await installPreviewUpdate(linux, {
      ...native.dependencies,
      spawn(command, args, options) {
        calls.push(command)
        const output = observations.shift()
        expect(output).toBeDefined()
        // The executable is the test runtime, never command or its installer args.
        return spawn(process.execPath, ["-e", "process.stdout.write(process.argv[1])", output!], {
          ...options,
          // This inert runtime may run on Windows CI while representing Linux
          // commands. Windows needs its native system directory to start it.
          env: { ...options.env, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
        })
      },
    }),
  ).toEqual({ status: "installed", version })
  expect(calls).toEqual(["/usr/bin/dpkg-query", "/usr/bin/dpkg-query", "/usr/bin/pkexec", "/usr/bin/dpkg-query"])
})
