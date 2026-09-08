// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { ChildProcess, execFile } from "node:child_process"
import { PassThrough } from "node:stream"
import { win32 } from "node:path"
import {
  createWindowsAppShutdownTransport,
  windowsAppShutdownNative,
  windowsAppShutdownQuery,
  windowsAppShutdownRole,
  windowsAppShutdownSnapshot,
} from "./windows-app-shutdown-native"

const rows = [
  { pid: 50, parent: 20, birth: "639086980000000000", executable: "C:\\owned\\app.exe" },
  { pid: 51, parent: 50, birth: "639086980000000010", executable: "C:\\owned\\app.exe" },
]
function fixture() {
  const calls: {
    child: ChildProcess
    input: string
    timeout: number
    complete(error: unknown, stdout: string, stderr: string): void
    unreferenced: boolean
  }[] = []
  const query = createWindowsAppShutdownTransport((options, complete) => {
    const child = new ChildProcess()
    Object.defineProperties(child, {
      stdin: { value: new PassThrough() },
      stdout: { value: new PassThrough() },
      stderr: { value: new PassThrough() },
    })
    const call = { child, complete, timeout: options.timeout, input: "", unreferenced: false }
    child.stdin!.on("data", (data) => {
      call.input += data.toString()
    })
    child.unref = () => {
      call.unreferenced = true
    }
    calls.push(call)
    return child
  }, 20)
  return { calls, query }
}

test("the fixed snapshot transport waits for helper close, passes only bounded numeric requests, and copies metadata", async () => {
  const f = fixture()
  const result = f.query({ rootPid: 50 })
  const call = f.calls[0]!
  expect(JSON.parse(call.input)).toEqual({ rootPid: 50 })
  expect(call.timeout).toBe(12000)
  let settled = false
  void result.then(() => {
    settled = true
  })
  call.complete(null, JSON.stringify({ status: "COMPLETE", processes: rows }), "")
  await Promise.resolve()
  expect(settled).toBe(false)
  call.child.emit("close", 0)
  expect(await result).toEqual({ snapshot: { status: "COMPLETE", processes: rows }, quiescence: "confirmed" })
  const final = f.query({ rootPid: 50, pids: [50, 51] })
  expect(JSON.parse(f.calls[1]!.input)).toEqual({ rootPid: 50, pids: [50, 51] })
  f.calls[1]!.complete(null, '{"status":"COMPLETE","processes":[]}', "")
  f.calls[1]!.child.emit("close", 0)
  expect((await final).snapshot.status).toBe("COMPLETE")
})

test("query failures and malformed output never reveal raw errors or claim that the snapshot proves absence", async () => {
  for (const mode of ["query", "json", "bounds", "unknown-field"] as const) {
    const f = fixture()
    const result = f.query({ rootPid: 50 })
    const output =
      mode === "json"
        ? "PRIVATE OUTPUT TRAP"
        : mode === "bounds"
          ? JSON.stringify({
              status: "COMPLETE",
              processes: Array.from({ length: 257 }, (_, i) => ({ ...rows[0], pid: i + 1 })),
            })
          : JSON.stringify({
              status: "COMPLETE",
              processes: [{ ...rows[0], ...(mode === "unknown-field" ? { argv: "PRIVATE TOKEN TRAP" } : {}) }],
            })
    f.calls[0]!.complete(
      mode === "query" ? { code: 1, message: "PRIVATE ERROR TRAP" } : null,
      output,
      "PRIVATE STDERR TRAP",
    )
    f.calls[0]!.child.emit("close", mode === "query" ? 1 : 0)
    expect(await result).toEqual({ snapshot: { status: "UNREADABLE", processes: [] }, quiescence: "confirmed" })
    expect(JSON.stringify(await result)).not.toContain("PRIVATE")
  }
  expect(windowsAppShutdownSnapshot({ status: "COMPLETE", processes: [rows[0], rows[0]] }).status).toBe("UNREADABLE")
  expect(
    windowsAppShutdownSnapshot({ status: "COMPLETE", processes: [{ ...rows[0], birth: null, executable: null }] }),
  ).toEqual({
    status: "COMPLETE",
    processes: [{ pid: 50, parent: 20 }],
  })
  let coerced = false
  expect(
    windowsAppShutdownSnapshot({
      status: "COMPLETE",
      processes: [
        {
          ...rows[0],
          role: {
            toString() {
              coerced = true
              return "renderer"
            },
          },
        },
      ],
    }),
  ).toEqual({ status: "COMPLETE", processes: [rows[0]] })
  expect(coerced).toBe(false)
  expect(
    windowsAppShutdownSnapshot({
      status: "COMPLETE",
      processes: [{ ...rows[0], executable: "C:\\private\\..\\other.exe", birth: "PRIVATE" }],
    }),
  ).toEqual({
    status: "COMPLETE",
    processes: [{ pid: 50, parent: 20 }],
  })
  expect(
    windowsAppShutdownSnapshot({
      get status() {
        throw Error("PRIVATE")
      },
    }).status,
  ).toBe("UNREADABLE")
})

test("unconfirmed helper close quarantines future reads and releases controller handles without signalling", async () => {
  const f = fixture()
  const result = f.query({ rootPid: 50 })
  f.calls[0]!.child.kill = () => {
    throw Error("must not signal")
  }
  f.calls[0]!.complete(null, JSON.stringify({ status: "COMPLETE", processes: rows }), "")
  expect(await result).toEqual({ snapshot: { status: "UNREADABLE", processes: [] }, quiescence: "unconfirmed" })
  expect(f.calls[0]!.unreferenced).toBe(true)
  expect(f.calls[0]!.child.stdin!.destroyed).toBe(true)
  f.calls[0]!.child.emit("close", 0)
  expect((await f.query({ rootPid: 50 })).quiescence).toBe("unconfirmed")
  expect(f.calls).toHaveLength(1)
})

test("invalid or oversized requests never dispatch a helper; production cannot launch on local Linux", async () => {
  const f = fixture()
  for (const request of [
    { rootPid: 0 },
    { rootPid: 50, pids: [51, 51] },
    { rootPid: 50, pids: Array.from({ length: 257 }, (_, i) => i + 1) },
    { rootPid: 50, pids: [NaN] },
  ])
    expect((await f.query(request)).snapshot.status).toBe("UNREADABLE")
  expect(f.calls).toHaveLength(0)
  if (process.platform !== "win32")
    await expect(windowsAppShutdownNative({}, "C:\\owned")).rejects.toThrow("PACKAGED_SHUTDOWN_DIAGNOSTIC_UNAVAILABLE")
})

test.skipIf(process.platform !== "win32" || process.env.RUNNER_ENVIRONMENT !== "github-hosted")(
  "hosted inert PowerShell executes the exact fixed snapshot closure and keeps native query failures unreadable",
  async () => {
    // Get-CimInstance is shadowed with fixed objects: no native process table,
    // application, browser, keyring or system mutation is accessed by this test.
    const script = String.raw`
$ErrorActionPreference='Stop'
${windowsAppShutdownRole}
${windowsAppShutdownQuery}
function Require($value){if(!$value){throw 'fixture'}}
$script:mode='complete'
function Get-CimInstance {
  [CmdletBinding()]param([string]$ClassName,[string[]]$Property)
  Require ($ClassName -ceq 'Win32_Process' -and $PSBoundParameters.ErrorAction -eq 'Stop')
  Require (($Property -join ',') -ceq 'ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine')
  if($script:mode -eq 'failed'){throw 'inert-query-failed'}
  $birth=[DateTime]::SpecifyKind([DateTime]::new(2026,9,8,12,0,0),[DateTimeKind]::Utc)
  @(
    [pscustomobject]@{ProcessId=52;ParentProcessId=51;CreationDate=$birth.AddTicks(2);ExecutablePath='C:\owned\child.exe'},
    [pscustomobject]@{ProcessId=50;ParentProcessId=20;CreationDate=$birth;ExecutablePath='C:\owned\app.exe'},
    [pscustomobject]@{ProcessId=51;ParentProcessId=50;CreationDate=$birth.AddTicks(1);ExecutablePath=$null},
    [pscustomobject]@{ProcessId=53;ParentProcessId=20;CreationDate=$birth;ExecutablePath='C:\unrelated\other.exe'}
  )
}
$initial=Read-AppShutdownSnapshot ([pscustomobject]@{rootPid=50})
Require ($initial.status -ceq 'COMPLETE' -and $initial.processes.Count -eq 3)
Require ((@($initial.processes | Sort-Object pid | ForEach-Object {$_.pid}) -join ',') -ceq '50,51,52')
Require (($initial.processes | Where-Object {$_.pid -eq 50}).birth -ceq ([DateTime]::new(2026,9,8,12,0,0)).Ticks.ToString())
Require ($null -eq ($initial.processes | Where-Object {$_.pid -eq 51}).executable)
$final=Read-AppShutdownSnapshot ([pscustomobject]@{rootPid=50;pids=@(52)})
Require ((@($final.processes | Sort-Object pid | ForEach-Object {$_.pid}) -join ',') -ceq '50,52')
$script:mode='failed';$failed=$false
try {$null=Read-AppShutdownSnapshot ([pscustomobject]@{rootPid=50})}catch{$failed=$true}
Require $failed
Require ((Read-AppShutdownRole '"C:\Program Files\app.exe" --type=renderer') -ceq 'renderer')
Require ((Read-AppShutdownRole '"C:\Program Files\app.exe" "text --type=renderer"') -ceq 'unknown')
Require ((Read-AppShutdownRole 'app.exe --type=renderer --type=utility') -ceq 'unknown')
Require ((Read-AppShutdownRole 'app.exe --type=gpu-process') -ceq 'gpu')
Require ((Read-AppShutdownRole 'app.exe --type=utility') -ceq 'utility')
Require ((Read-AppShutdownRole 'app.exe --type=crashpad-handler') -ceq 'crashpad')
[Console]::Out.Write('{"fixtureOnly":true,"closure":true,"exactFinalPids":true,"ticks":true,"missingMetadata":true,"queryFailure":true}')
`
    const system = process.env.SystemRoot || process.env.SYSTEMROOT
    expect(system).toBeTruthy()
    const executable = win32.join(system!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    const args = [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ]
    expect(executable.length * 2 + args.reduce((sum, arg) => sum + arg.length + 3, 0) + 3).toBeLessThan(32767)
    let result: unknown
    const transport = createWindowsAppShutdownTransport((deadline, complete) =>
      execFile(
        executable,
        args,
        {
          shell: false,
          windowsHide: true,
          encoding: "utf8",
          timeout: deadline.timeout,
          maxBuffer: 8192,
        },
        (error, stdout, stderr) => {
          if (!error) {
            try {
              result = JSON.parse(stdout)
            } catch {}
          }
          complete(error, stdout, stderr)
        },
      ),
    )
    expect((await transport({ rootPid: 50 })).quiescence).toBe("confirmed")
    expect(result).toEqual({
      fixtureOnly: true,
      closure: true,
      exactFinalPids: true,
      ticks: true,
      missingMetadata: true,
      queryFailure: true,
    })
  },
  20000,
)
