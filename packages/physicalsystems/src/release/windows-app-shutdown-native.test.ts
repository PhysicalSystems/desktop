// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { ChildProcess, execFile } from "node:child_process"
import { PassThrough } from "node:stream"
import { join, win32 } from "node:path"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { requireDisposablePublicRunner } from "./public-qualification"
import { windowsReviewNativeEnvironment } from "./windows-review-native"
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
const fixturePhases = [
  "bootstrap",
  "role-definition",
  "query-definition",
  "initial-query",
  "query-class",
  "query-properties",
  "initial-status",
  "initial-closure",
  "initial-ticks",
  "initial-missing-metadata",
  "final-query",
  "final-closure",
  "expected-query-failure",
  "query-failure-assertion",
  "role-renderer",
  "role-lookalike",
  "role-duplicate",
  "role-gpu",
  "role-utility",
  "role-crashpad",
  "json",
] as const
const fixtureTypes = [
  "RuntimeException",
  "MethodInvocationException",
  "ParameterBindingException",
  "ParameterBindingValidationException",
  "ArgumentException",
  "InvalidOperationException",
  "PSInvalidCastException",
  "ParseException",
  "ActionPreferenceStopException",
  "Other",
] as const
const fixtureCategories = [
  "InvalidArgument",
  "InvalidData",
  "InvalidOperation",
  "NotSpecified",
  "ObjectNotFound",
  "OperationStopped",
  "ParserError",
  "PermissionDenied",
  "Other",
] as const

function fixtureFailure(error: unknown, stderr: string, invalidJson = false) {
  const lines = Buffer.byteLength(stderr) <= 8192 ? stderr.split(/\r?\n/) : []
  const read = (prefix: string, allowed: readonly string[]) =>
    lines
      .flatMap((line) => {
        if (!line.startsWith(prefix)) return []
        const value = line.slice(prefix.length)
        return allowed.includes(value) ? [value] : []
      })
      .at(-1) ?? "unknown"
  const phase = read("INERT_APP_SHUTDOWN_FIXTURE_PHASE_", fixturePhases)
  const type = read("INERT_APP_SHUTDOWN_FIXTURE_TYPE_", fixtureTypes)
  const category = read("INERT_APP_SHUTDOWN_FIXTURE_CATEGORY_", fixtureCategories)
  const native = error as { killed?: unknown; signal?: unknown; code?: unknown } | undefined
  const outcome =
    native?.killed === true
      ? "timeout"
      : typeof native?.signal === "string"
        ? "signal"
        : typeof native?.code === "number"
          ? "exit"
          : invalidJson
            ? "invalid-json"
            : "unknown"
  return Error(`INERT_APP_SHUTDOWN_FIXTURE_FAILED:${phase}:${type}:${category}:${outcome}`)
}

test("hosted fixture diagnostics expose only bounded authored phases, exception types and categories", () => {
  expect(
    fixtureFailure(
      { code: 1, message: "PRIVATE" },
      "PRIVATE\nINERT_APP_SHUTDOWN_FIXTURE_PHASE_initial-ticks\nINERT_APP_SHUTDOWN_FIXTURE_TYPE_RuntimeException\nINERT_APP_SHUTDOWN_FIXTURE_CATEGORY_OperationStopped\n",
    ).message,
  ).toBe("INERT_APP_SHUTDOWN_FIXTURE_FAILED:initial-ticks:RuntimeException:OperationStopped:exit")
  expect(
    fixtureFailure(
      { killed: true },
      "INERT_APP_SHUTDOWN_FIXTURE_PHASE_PRIVATE\nINERT_APP_SHUTDOWN_FIXTURE_TYPE_PRIVATE\nINERT_APP_SHUTDOWN_FIXTURE_CATEGORY_PRIVATE",
    ).message,
  ).toBe("INERT_APP_SHUTDOWN_FIXTURE_FAILED:unknown:unknown:unknown:timeout")
  expect(fixtureFailure(undefined, "x".repeat(8193), true).message).toBe(
    "INERT_APP_SHUTDOWN_FIXTURE_FAILED:unknown:unknown:unknown:invalid-json",
  )
})
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

const hostedWindows =
  process.platform === "win32" &&
  process.env.CI === "true" &&
  process.env.GITHUB_ACTIONS === "true" &&
  process.env.RUNNER_ENVIRONMENT === "github-hosted" &&
  process.env.RUNNER_OS === "Windows" &&
  process.env.GITHUB_REPOSITORY === "PhysicalSystems/desktop"
test.skipIf(!hostedWindows)(
  "hosted inert PowerShell executes the exact fixed snapshot closure and keeps native query failures unreadable",
  async () => {
    // Get-CimInstance is shadowed with fixed objects: no native process table,
    // application, browser, keyring or system mutation is accessed by this test.
    const script = String.raw`
$ErrorActionPreference='Stop'
$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules')
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
function Mark([string]$phase){[Console]::Error.WriteLine('INERT_APP_SHUTDOWN_FIXTURE_PHASE_'+$phase)}
trap {
  $type=$_.Exception.GetType().Name
  if($type -cnotin @(${fixtureTypes.map((value) => `'${value}'`).join(",")})){$type='Other'}
  $category=$_.CategoryInfo.Category.ToString()
  if($category -cnotin @(${fixtureCategories.map((value) => `'${value}'`).join(",")})){$category='Other'}
  [Console]::Error.WriteLine('INERT_APP_SHUTDOWN_FIXTURE_TYPE_'+$type)
  [Console]::Error.WriteLine('INERT_APP_SHUTDOWN_FIXTURE_CATEGORY_'+$category)
  exit 1
}
Mark 'bootstrap'
Mark 'role-definition'
${windowsAppShutdownRole}
Mark 'query-definition'
${windowsAppShutdownQuery}
function Require($value){if(!$value){throw 'fixture'}}
$script:mode='complete'
function Get-CimInstance {
  [CmdletBinding()]param([string]$ClassName,[string[]]$Property)
  Mark 'query-class'
  Require ($ClassName -ceq 'Win32_Process' -and $PSBoundParameters.ErrorAction -eq 'Stop')
  Mark 'query-properties'
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
Mark 'initial-query'
$initial=Read-AppShutdownSnapshot ([pscustomobject]@{rootPid=50})
Mark 'initial-status'
Require ($initial.status -ceq 'COMPLETE' -and $initial.processes.Count -eq 3)
Mark 'initial-closure'
Require ((@($initial.processes | Sort-Object pid | ForEach-Object {$_.pid}) -join ',') -ceq '50,51,52')
Mark 'initial-ticks'
Require (($initial.processes | Where-Object {$_.pid -eq 50}).birth -ceq ([DateTime]::new(2026,9,8,12,0,0)).Ticks.ToString())
Mark 'initial-missing-metadata'
Require ($null -eq ($initial.processes | Where-Object {$_.pid -eq 51}).executable)
Mark 'final-query'
$final=Read-AppShutdownSnapshot ([pscustomobject]@{rootPid=50;pids=@(52)})
Mark 'final-closure'
Require ((@($final.processes | Sort-Object pid | ForEach-Object {$_.pid}) -join ',') -ceq '50,52')
$script:mode='failed';$failed=$false
Mark 'expected-query-failure'
try {$null=Read-AppShutdownSnapshot ([pscustomobject]@{rootPid=50})}catch{$failed=$true}
Mark 'query-failure-assertion'
Require $failed
Mark 'role-renderer'
Require ((Read-AppShutdownRole '"C:\Program Files\app.exe" --type=renderer') -ceq 'renderer')
Mark 'role-lookalike'
Require ((Read-AppShutdownRole '"C:\Program Files\app.exe" "text --type=renderer"') -ceq 'unknown')
Mark 'role-duplicate'
Require ((Read-AppShutdownRole 'app.exe --type=renderer --type=utility') -ceq 'unknown')
Mark 'role-gpu'
Require ((Read-AppShutdownRole 'app.exe --type=gpu-process') -ceq 'gpu')
Mark 'role-utility'
Require ((Read-AppShutdownRole 'app.exe --type=utility') -ceq 'utility')
Mark 'role-crashpad'
Require ((Read-AppShutdownRole 'app.exe --type=crashpad-handler') -ceq 'crashpad')
Mark 'json'
[Console]::Out.Write('{"fixtureOnly":true,"closure":true,"exactFinalPids":true,"ticks":true,"missingMetadata":true,"queryFailure":true}')
`
    const root = await mkdtemp(join(await realpath(process.env.RUNNER_TEMP!), "app-shutdown-fixture-"))
    await requireDisposablePublicRunner(process.env, root)
    const environment = windowsReviewNativeEnvironment(process.env, root)
    const executable = win32.join(environment.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    const args = [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ]
    expect(executable.length * 2 + args.reduce((sum, arg) => sum + arg.length + 3, 0) + 3).toBeLessThan(32767)
    let result: unknown
    let diagnostic: Error | undefined
    let retainRoot = false
    const transport = createWindowsAppShutdownTransport((deadline, complete) => {
      retainRoot = true
      return execFile(
        executable,
        args,
        {
          shell: false,
          windowsHide: true,
          encoding: "utf8",
          timeout: deadline.timeout,
          maxBuffer: 8192,
          cwd: root,
          env: environment,
        },
        (error, stdout, stderr) => {
          if (error) diagnostic = fixtureFailure(error, stderr)
          else {
            try {
              result = JSON.parse(stdout.replace(/^\uFEFF/, ""))
            } catch {
              diagnostic = fixtureFailure(undefined, stderr, true)
            }
          }
          complete(error, stdout, stderr)
        },
      )
    })
    try {
      const observed = await transport({ rootPid: 50 })
      retainRoot = observed.quiescence !== "confirmed"
      expect(observed.quiescence).toBe("confirmed")
      if (diagnostic) throw diagnostic
      expect(result).toEqual({
        fixtureOnly: true,
        closure: true,
        exactFinalPids: true,
        ticks: true,
        missingMetadata: true,
        queryFailure: true,
      })
    } finally {
      if (!retainRoot) await rm(root, { recursive: true, force: true })
    }
  },
  20000,
)
