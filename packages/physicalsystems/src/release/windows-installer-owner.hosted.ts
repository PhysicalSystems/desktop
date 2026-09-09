// SPDX-License-Identifier: Apache-2.0
// Hosted process/IO fixture only: this never installs an app or authors a public receipt.
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { requireDisposablePublicRunner } from "./public-qualification"
import { readWindowsInstallerOwnerObservation, startWindowsInstallerOwner } from "./windows-installer-owner"

function requireFixture(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(`WINDOWS_OWNER_FIXTURE_${code}`)
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function until(ready: () => boolean | Promise<boolean>, code: string) {
  const deadline = Date.now() + 10000
  while (!(await ready())) {
    requireFixture(Date.now() < deadline, code)
    await pause(20)
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    requireFixture((error as NodeJS.ErrnoException).code === "ESRCH", "PROCESS_INSPECTION")
    return false
  }
}

const fixtureSource = String.raw`
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading;

public static class InertInstallerOwnerFixture {
  public static int Main(string[] args) {
    string executable = Assembly.GetExecutingAssembly().Location;
    string root = Path.GetDirectoryName(executable);
    string role;
    if (args.Length >= 2 && args[0] == "/S" && String.Join(" ", args, 1, args.Length - 1) == "/D=" + Path.Combine(root, "payload")) role = "root";
    else if (args.Length == 1 && args[0] == "/fixture-child") role = "child";
    else if (args.Length == 1 && args[0] == "/fixture-grandchild") role = "grandchild";
    else return 11;

    // Every process is inert and has its own finite fail-safe lifetime.
    DateTime deadline = DateTime.UtcNow.AddSeconds(60);
    if (role == "grandchild") {
      using (FileStream partial = new FileStream(Path.Combine(root, "partial.bin"), FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
        byte[] bytes = new byte[65536];
        for (int i = 0; i < bytes.Length; i++) bytes[i] = 91;
        partial.Write(bytes, 0, bytes.Length);
        partial.Flush(true);
        File.WriteAllText(Path.Combine(root, role + ".pid"), Process.GetCurrentProcess().Id.ToString());
        while (DateTime.UtcNow < deadline) Thread.Sleep(20);
      }
      return 12;
    }

    ProcessStartInfo child = new ProcessStartInfo(executable, role == "root" ? "/fixture-child" : "/fixture-grandchild");
    child.UseShellExecute = false;
    child.CreateNoWindow = true;
    using (Process process = Process.Start(child)) {
      File.WriteAllText(Path.Combine(root, role + ".pid"), Process.GetCurrentProcess().Id.ToString());
      while (DateTime.UtcNow < deadline) {
        if (role == "root" && File.Exists(Path.Combine(root, "release-root"))) return 0;
        Thread.Sleep(20);
      }
    }
    return 13;
  }
}
`

async function compile(root: string, onClosed: () => void) {
  const source = join(root, "fixture.cs")
  const artifact = join(root, "inert-installer.exe")
  const script = join(root, "compile.ps1")
  await writeFile(source, fixtureSource)
  await writeFile(
    script,
    [
      "$ErrorActionPreference = 'Stop'",
      "Add-Type -TypeDefinition ([IO.File]::ReadAllText($env:WINDOWS_OWNER_FIXTURE_SOURCE)) -OutputAssembly $env:WINDOWS_OWNER_FIXTURE_EXE -OutputType ConsoleApplication",
    ].join("\n"),
  )
  const system = process.env.SystemRoot || process.env.SYSTEMROOT
  requireFixture(system && /^[A-Za-z]:\\/.test(system), "SYSTEM_ROOT")
  const compiler = spawn(
    join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
    {
      cwd: root,
      env: { ...process.env, WINDOWS_OWNER_FIXTURE_SOURCE: source, WINDOWS_OWNER_FIXTURE_EXE: artifact },
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    },
  )
  let closed = false
  let failed = false
  let code: number | null = null
  compiler.once("error", () => {
    failed = true
  })
  compiler.once("close", (value) => {
    code = value
    closed = true
    onClosed()
  })
  try {
    await until(() => closed, "COMPILE_TIMEOUT")
    requireFixture(!failed && code === 0, "COMPILE_FAILED")
  } finally {
    if (!closed) compiler.kill()
    await until(() => closed, "COMPILE_CLEANUP")
  }
  return artifact
}

async function exercise(mode: "stop" | "root-exit-abort" | "abort" | "eof" | "helper-death") {
  const root = await mkdtemp(join(process.env.RUNNER_TEMP!, `windows owner ${mode} `))
  await requireDisposablePublicRunner(process.env, root, process.platform)
  const helpers: ChildProcess[] = []
  const closedHelpers = new Set<ChildProcess>()
  const pids: number[] = []
  const observedPids = new Set<number>()
  let owner: Awaited<ReturnType<typeof startWindowsInstallerOwner>> | undefined
  let compilerClosed = false
  let treeKnown = false
  try {
    const artifact = await compile(root, () => {
      compilerClosed = true
    })
    await mkdir(join(root, "payload"))
    owner = await startWindowsInstallerOwner(
      {
        env: process.env,
        root,
        artifact,
        installation: join(root, "payload"),
        timeoutMs: 30000,
      },
      {
        spawn(executable, args, options) {
          const child = spawn(executable, args, options)
          helpers.push(child)
          child.once("close", () => {
            closedHelpers.add(child)
          })
          return child
        },
      },
    )
    let settled = false
    const completion = owner.completion.then(
      (value) => {
        settled = true
        return { status: "resolved" as const, value }
      },
      () => {
        settled = true
        return { status: "rejected" as const }
      },
    )
    requireFixture(helpers.length === 1, "SINGLE_HELPER")
    await until(async () => {
      const observed = await Promise.all(
        ["root", "child", "grandchild"].map(async (role) => {
          const value = await readFile(join(root, `${role}.pid`), "utf8").catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return ""
            throw error
          })
          return /^[1-9]\d*$/.test(value) ? Number(value) : undefined
        }),
      )
      for (const pid of observed) {
        if (pid !== undefined) observedPids.add(pid)
      }
      if (observed.some((pid) => pid === undefined)) return false
      pids.splice(0, pids.length, ...(observed as number[]))
      return true
    }, "TREE_READY")
    requireFixture(pids[0] === owner.pid && new Set(pids).size === 3, "OWNED_ROOT")
    requireFixture(
      pids.every((pid) => Number.isSafeInteger(pid) && pid !== process.pid && pid !== helpers[0].pid && alive(pid)),
      "LIVE_TREE",
    )
    treeKnown = true
    requireFixture(!settled, "EARLY_COMPLETION")
    if (mode === "root-exit-abort") {
      await writeFile(join(root, "release-root"), "release owned inert root\n")
      await until(() => !alive(pids[0]), "ROOT_EXIT")
      requireFixture(pids.slice(1).every(alive) && !settled, "DESCENDANTS_RETAINED_UNTIL_ABORT")
      await owner.abort()
    }
    if (mode === "stop") await owner.stop()
    if (mode === "abort") await owner.abort()
    if (mode === "eof") helpers[0].stdin!.end()
    if (mode === "helper-death") requireFixture(helpers[0].kill(), "HELPER_TERMINATION")
    await until(() => settled, "COMPLETION_TIMEOUT")
    const result = await completion
    if (mode === "stop") {
      requireFixture(result.status === "resolved", "STOP_COMPLETION")
      requireFixture(
        result.value.stopped && result.value.jobEmpty && Number.isInteger(result.value.exitCode),
        "STOP_PROOF",
      )
    } else requireFixture(result.status === "rejected", "ABNORMAL_COMPLETION_AUTHORITY")
    await until(() => closedHelpers.has(helpers[0]) && pids.every((pid) => !alive(pid)), "TREE_CLEANUP")
    requireFixture(
      (await readFile(join(root, "partial.bin"))).equals(Buffer.alloc(65536, 91)),
      "PRESERVED_PARTIAL_BYTES",
    )
  } finally {
    await owner?.abort().catch(() => {})
    for (const helper of helpers) {
      if (helper.exitCode === null && helper.signalCode === null) helper.kill()
    }
    await until(
      () => helpers.every((helper) => closedHelpers.has(helper)) && [...observedPids].every((pid) => !alive(pid)),
      "FINAL_CLEANUP",
    )
    // Incomplete PID discovery cannot prove descendant cleanup, even when the
    // helper has closed. Retain the owned fixture directory on that failure.
    if ((helpers.length === 0 && compilerClosed) || (helpers.length === 1 && treeKnown))
      await rm(root, { recursive: true, force: true })
  }
}

async function main() {
  requireFixture(
    process.platform === "win32" && process.env.PHYSICALSYSTEMS_WINDOWS_OWNER_FIXTURE === "1",
    "HOSTED_WINDOWS_ONLY",
  )
  requireFixture(
    process.env.CI === "true" &&
      process.env.GITHUB_ACTIONS === "true" &&
      process.env.RUNNER_ENVIRONMENT === "github-hosted" &&
      process.env.RUNNER_OS === "Windows" &&
      process.env.GITHUB_REPOSITORY === "PhysicalSystems/desktop" &&
      process.env.PHYSICALSYSTEMS_ALLOW_DEVICES === "0",
    "DISPOSABLE_RUNNER_ONLY",
  )
  const modes = ["stop", "root-exit-abort", "abort", "eof", "helper-death"] as const
  for (const mode of modes) {
    await exercise(mode)
    console.log(
      JSON.stringify({ windowsInstallerOwnerFixture: { mode, status: "PASS", scope: "inert-process-tree-only" } }),
    )
  }
}

await main().catch((error: unknown) => {
  const observation = readWindowsInstallerOwnerObservation(error)
  if (observation) console.error(JSON.stringify({ windowsInstallerOwnerFixture: observation }))
  console.error(
    error instanceof Error && /^WINDOWS_OWNER_FIXTURE_[A-Z_]+$/.test(error.message)
      ? error.message
      : "WINDOWS_OWNER_FIXTURE_FAILED",
  )
  process.exitCode = 1
})
