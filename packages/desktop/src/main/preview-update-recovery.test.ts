import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import type { ChildProcess, SpawnOptions } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { inspectPreviewUpdateRecovery } from "./preview-update-recovery"

const from = "0.1.0-beta.7"
const to = "0.1.0-beta.8"
const procMount = "30 29 0:5 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw\n"
const input = {
  platform: "linux",
  arch: "x64",
  executablePath: "/opt/Physical Systems/physical-systems-desktop",
  currentVersion: from,
  attempt: { from, to, sha256: "a".repeat(64) },
}
type Observation = { code?: number | null; stdout?: string; error?: boolean; hanging?: boolean; noSpawn?: boolean }
function fixture(installedVersions: Array<string | undefined>, observation: Observation = { code: 1 }) {
  const calls: { command: string; args: readonly string[]; options: SpawnOptions }[] = []
  const inspected: string[] = []
  let kills = 0
  return {
    calls,
    inspected,
    get kills() {
      return kills
    },
    dependencies: {
      readMountInfo: async () => procMount,
      async inspectInstallation(value: Omit<typeof input, "attempt">) {
        inspected.push(value.currentVersion)
        const version = installedVersions.shift()
        if (version !== value.currentVersion) return
        return value.platform === "win32"
          ? { platform: "win32" as const, format: "nsis" as const }
          : { platform: "linux" as const, format: "deb" as const, installedVersion: version }
      },
      spawn(command: string, args: readonly string[], options: SpawnOptions) {
        calls.push({ command, args, options })
        const stdout = new PassThrough()
        const child = Object.assign(new EventEmitter(), {
          stdout,
          kill() {
            kills++
            return true
          },
        }) as unknown as ChildProcess
        queueMicrotask(() => {
          if (observation.error) {
            child.emit("error", new Error("private native error"))
            return
          }
          if (!observation.noSpawn) child.emit("spawn")
          if (observation.stdout) stdout.write(observation.stdout)
          if (observation.hanging) return
          stdout.end()
          child.emit("close", observation.code === undefined ? 1 : observation.code)
        })
        return child
      },
    },
  }
}

test("Linux recognizes a completed target package while the old app still runs, then independently rechecks it", async () => {
  const f = fixture([to, to])
  expect(await inspectPreviewUpdateRecovery(input, f.dependencies)).toEqual({ status: "installed" })
  expect(f.inspected).toEqual([to, to])
  expect(f.calls).toEqual([
    {
      command: "/usr/bin/pgrep",
      args: ["--exact", "dpkg|apt|apt-get|pkexec"],
      options: {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
        env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" },
      },
    },
  ])
  expect(f.kills).toBe(0)
})

test("Linux cancellation is recoverable only with the original package intact and no package manager", async () => {
  const f = fixture([undefined, from, from])
  expect(await inspectPreviewUpdateRecovery(input, f.dependencies)).toEqual({ status: "not-installed" })
  expect(f.inspected).toEqual([to, from, from])
  expect(f.calls).toHaveLength(1)
})

test("a supported running target or newer version acknowledges the attempt without requiring exact target equality", async () => {
  for (const version of [to, "0.1.0-beta.9", "0.1.0"]) {
    const f = fixture([version, version])
    expect(await inspectPreviewUpdateRecovery({ ...input, currentVersion: version }, f.dependencies)).toEqual({
      status: "installed",
    })
    expect(f.inspected).toEqual([version, version])
  }
})

test("Windows old-version startup cannot infer cancellation from absence of the original NSIS process", async () => {
  const f = fixture([from])
  expect(await inspectPreviewUpdateRecovery({ ...input, platform: "win32" }, f.dependencies)).toEqual({
    status: "uncertain",
  })
  expect(f.calls).toEqual([])
  // A terminated parent may leave old-uninstaller.exe alive. No original-name
  // process probe, broad process scan or guessed absence grants recovery.
})

test("Windows acknowledges only an actually running, supported target-or-newer application", async () => {
  for (const currentVersion of [to, "0.1.0-beta.9", "0.1.0"]) {
    const f = fixture([currentVersion])
    expect(await inspectPreviewUpdateRecovery({ ...input, platform: "win32", currentVersion }, f.dependencies)).toEqual(
      { status: "installed" },
    )
    expect(f.inspected).toEqual([currentVersion])
    expect(f.calls).toEqual([])
  }
  const f = fixture([undefined])
  expect(
    await inspectPreviewUpdateRecovery({ ...input, platform: "win32", currentVersion: to }, f.dependencies),
  ).toEqual({ status: "uncertain" })
})

test("active package processes, unexpected exit status and malformed output keep recovery blocked", async () => {
  for (const observation of [
    { code: 0, stdout: "1234\n" },
    { code: 0 },
    { code: 2 },
    { code: 127 },
    { code: null },
    { code: 1, stdout: "unexpected" },
    { code: 1, noSpawn: true },
    { error: true },
  ]) {
    const f = fixture([to, to], observation)
    expect(await inspectPreviewUpdateRecovery(input, f.dependencies)).toEqual({ status: "uncertain" })
    expect(f.inspected).toEqual([to])
    expect(f.calls).toHaveLength(1)
  }
})

test("restricted, hidden, replaced or unavailable procfs cannot prove privileged installer absence", async () => {
  for (const source of [
    procMount.replace("proc proc rw", "proc proc rw,hidepid=1"),
    procMount.replace("proc proc rw", "proc proc rw,hidepid=2"),
    procMount.replace("proc proc rw", "proc proc rw,hidepid=4"),
    procMount.replace("proc proc rw", "proc proc rw,hidepid=invisible"),
    procMount.replace("rw,nosuid", "rw,hidepid=2,nosuid"),
    procMount.replace("- proc", "- tmpfs"),
    procMount + procMount,
    procMount + "31 30 0:6 / /proc/1234 rw - tmpfs tmpfs rw\n",
    "",
    "invalid mount information",
    "x".repeat(131073),
  ]) {
    const f = fixture([undefined, from, from])
    expect(await inspectPreviewUpdateRecovery(input, { ...f.dependencies, readMountInfo: async () => source })).toEqual(
      { status: "uncertain" },
    )
    expect(f.calls).toEqual([])
  }
  const f = fixture([to])
  expect(
    await inspectPreviewUpdateRecovery(input, {
      ...f.dependencies,
      async readMountInfo() {
        throw new Error("denied")
      },
    }),
  ).toEqual({ status: "uncertain" })
  expect(f.calls).toEqual([])
})

test("explicit hidepid=0 and unrelated standard submounts preserve useful absence evidence", async () => {
  const f = fixture([to, to])
  const source =
    procMount.replace("proc proc rw", "proc proc rw,hidepid=0") +
    "31 30 0:6 / /proc/sys/fs/binfmt_misc rw - binfmt_misc binfmt_misc rw\n"
  expect(await inspectPreviewUpdateRecovery(input, { ...f.dependencies, readMountInfo: async () => source })).toEqual({
    status: "installed",
  })
  expect(f.calls).toHaveLength(1)
})

test("missing or partially installed package remains uncertain without probing or repairing it", async () => {
  const f = fixture([undefined, undefined])
  expect(await inspectPreviewUpdateRecovery(input, f.dependencies)).toEqual({ status: "uncertain" })
  expect(f.inspected).toEqual([to, from])
  expect(f.calls).toEqual([])
})

test("package identity changing during process observation never authorizes recovery", async () => {
  for (const versions of [
    [to, undefined],
    [undefined, from, undefined],
  ]) {
    const f = fixture(versions)
    expect(await inspectPreviewUpdateRecovery(input, f.dependencies)).toEqual({ status: "uncertain" })
    expect(f.calls).toHaveLength(1)
  }
})

test("invalid journal, platform or intermediate version is rejected before native IO", async () => {
  for (const patch of [
    { platform: "darwin" },
    { arch: "arm64" },
    { currentVersion: "development" },
    { currentVersion: "0.1.0-beta.6" },
    { currentVersion: "9".repeat(81) },
    { attempt: { ...input.attempt, to: from } },
    { attempt: { ...input.attempt, from: "0.1.0" } },
    { attempt: { ...input.attempt, to: "0.1.0-beta.9007199254740993" } },
    { attempt: { ...input.attempt, to: "0.1.0-beta.8'" } },
    { attempt: { ...input.attempt, sha256: "A".repeat(64) } },
    { attempt: { ...input.attempt, sha256: "a".repeat(63) } },
    { currentVersion: "0.1.0-beta.8", attempt: { ...input.attempt, to: "0.1.0-beta.9" } },
  ]) {
    const f = fixture([])
    expect(await inspectPreviewUpdateRecovery({ ...input, ...patch }, f.dependencies)).toEqual({ status: "uncertain" })
    expect(f.inspected).toEqual([])
    expect(f.calls).toEqual([])
  }
})

test("native timeout or oversized output terminates only the owned read-only probe and fails closed", async () => {
  for (const observation of [{ hanging: true }, { hanging: true, stdout: "x".repeat(4097) }]) {
    const f = fixture([to], observation)
    expect(await inspectPreviewUpdateRecovery(input, { ...f.dependencies, timeoutMs: 5 })).toEqual({
      status: "uncertain",
    })
    expect(f.kills).toBe(1)
    expect(f.calls.every((call) => call.command === "/usr/bin/pgrep")).toBe(true)
  }
})

test("spawn or installation-inspection errors stay sanitized and cannot enable recovery", async () => {
  const f = fixture([to])
  expect(
    await inspectPreviewUpdateRecovery(input, {
      ...f.dependencies,
      spawn() {
        throw new Error("private spawn error")
      },
    }),
  ).toEqual({ status: "uncertain" })
  expect(
    await inspectPreviewUpdateRecovery(input, {
      ...f.dependencies,
      async inspectInstallation() {
        throw new Error("private package error")
      },
    }),
  ).toEqual({ status: "uncertain" })
})

test("real inert child exit exercises recovery observation without querying processes or installing software", async () => {
  const f = fixture([to, to])
  const calls: string[] = []
  expect(
    await inspectPreviewUpdateRecovery(input, {
      ...f.dependencies,
      spawn(command, _args, options) {
        calls.push(command)
        return spawn(process.execPath, ["-e", "process.exit(1)"], {
          ...options,
          env: { ...options.env, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
        })
      },
    }),
  ).toEqual({ status: "installed" })
  expect(calls).toEqual(["/usr/bin/pgrep"])
})
