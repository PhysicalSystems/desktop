// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { execFile, type ChildProcess } from "node:child_process"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { join, win32 } from "node:path"
import { gunzipSync } from "node:zlib"
import {
  windowsReviewIdentityReadScript,
  windowsReviewListenerReadScript,
  windowsReviewLauncherCommandScript,
  windowsReviewScriptBootstrap,
  windowsReviewNativeResult,
  windowsReviewNativeArguments,
  windowsReviewNativeEnvironment,
  windowsReviewNativeScript,
} from "./windows-review-native"
import { requireDisposablePublicRunner } from "./public-qualification"
import { readBrowserObservation } from "./browser-observation"

test("the actual encoded native script contains the tested reconciliation helper and fits CreateProcess", () => {
  const executable = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
  const args = windowsReviewNativeArguments(executable)
  const decoded = Buffer.from(args.at(-1)!, "base64").toString("utf16le")
  expect(decoded).toBe(windowsReviewScriptBootstrap(windowsReviewNativeScript))
  const compressed = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(decoded)?.[1]
  expect(compressed).toBeDefined()
  const source = gunzipSync(Buffer.from(compressed!, "base64")).toString("utf8")
  expect(source).toBe(windowsReviewNativeScript)
  expect(source.split(windowsReviewIdentityReadScript)).toHaveLength(2)
  expect(source.split(windowsReviewListenerReadScript)).toHaveLength(2)
  expect(source.split(windowsReviewLauncherCommandScript)).toHaveLength(2)
  expect(args).not.toContain("-ExecutionPolicy")
  expect(args).not.toContain("-File")
  const units = executable.length * 2 + 3 + args.reduce((total, arg) => total + arg.length + 3, 0)
  expect(units).toBeLessThanOrEqual(32767)
})

const fixturePhases = [
  "bootstrap",
  "identity",
  "launcher",
  "listener-empty",
  "listener-loopback",
  "listener-throw",
  "listener-error",
  "error-record-construct",
  "error-record-ready",
  "listener-continue",
  "error-write",
  "error-return",
  "error-catch",
  "listener-partial",
  "listener-foreign",
  "json",
] as const
function fixtureFailure(error: unknown, stderr: string) {
  const lines = Buffer.byteLength(stderr) <= 4096 ? stderr.split(/\r?\n/) : []
  const phase =
    lines
      .flatMap((line) => {
        const value = /^INERT_WINDOWS_FIXTURE_([a-z-]+)$/.exec(line)?.[1]
        return fixturePhases.includes(value as (typeof fixturePhases)[number]) ? [value!] : []
      })
      .at(-1) ?? "unknown"
  const native = error as { killed?: unknown; signal?: unknown; code?: unknown }
  const outcome =
    native?.killed === true
      ? "timeout"
      : typeof native?.signal === "string"
        ? "signal"
        : typeof native?.code === "number"
          ? "exit"
          : "unknown"
  return Error(`INERT_IDENTITY_FIXTURE_FAILED:${phase}:${outcome}`)
}

test("inert fixture deadline diagnostics expose only fixed phases and outcomes", () => {
  expect(
    fixtureFailure(
      { killed: true, code: "PRIVATE" },
      "PRIVATE\nINERT_WINDOWS_FIXTURE_identity\nINERT_WINDOWS_FIXTURE_listener-error\n",
    ).message,
  ).toBe("INERT_IDENTITY_FIXTURE_FAILED:listener-error:timeout")
  for (const phase of [
    "error-record-construct",
    "error-record-ready",
    "listener-continue",
    "error-write",
    "error-return",
    "error-catch",
  ]) {
    expect(fixtureFailure({ killed: true }, `PRIVATE\nINERT_WINDOWS_FIXTURE_${phase}\n`).message).toBe(
      `INERT_IDENTITY_FIXTURE_FAILED:${phase}:timeout`,
    )
  }
  expect(fixtureFailure({ code: 1 }, "INERT_WINDOWS_FIXTURE_PRIVATE").message).toBe(
    "INERT_IDENTITY_FIXTURE_FAILED:unknown:exit",
  )
  expect(fixtureFailure({ signal: "PRIVATE" }, "x".repeat(4097)).message).toBe(
    "INERT_IDENTITY_FIXTURE_FAILED:unknown:signal",
  )
})

const hostedWindows =
  process.platform === "win32" &&
  process.env.CI === "true" &&
  process.env.GITHUB_ACTIONS === "true" &&
  process.env.RUNNER_ENVIRONMENT === "github-hosted" &&
  process.env.RUNNER_OS === "Windows" &&
  process.env.GITHUB_REPOSITORY === "PhysicalSystems/desktop"

test.skipIf(!hostedWindows)(
  "hosted PowerShell separates exact listener query failures from zero matches and reconciles only fresh identity absence",
  async () => {
    // Execute the exact production helper with inert scriptblocks. No CIM, real
    // process lookup, browser, policy, provider or device operation is performed.
    const root = await mkdtemp(join(await realpath(process.env.RUNNER_TEMP!), "identity-read-fixture-"))
    await requireDisposablePublicRunner(process.env, root)
    const environment = windowsReviewNativeEnvironment(process.env, root)
    const executable = win32.join(environment.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    const script = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
function Mark([string]$phase){[Console]::Error.WriteLine('INERT_WINDOWS_FIXTURE_'+$phase);[Console]::Error.Flush()}
Mark 'bootstrap'
$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules')
trap {[Console]::Error.Write('INERT_IDENTITY_FIXTURE_FAILED');exit 1}
if([Console]::In.ReadToEnd() -cne '{"fixture":"stdin-preserved"}'){throw 'fixture-stdin'}
${windowsReviewIdentityReadScript}
Mark 'identity'
$script:reads=0;$script:proofs=0;$cases=0
function Require($value) {if($value -ne $true){throw 'fixture-assertion'}}
function Read-Inert($value) {
  Read-IdentityOrAbsent {
    $script:reads++
    if($value.fail){throw 'simulated-identity-read'}
    @{birth=$value.birth}
  } {
    $script:proofs++
    if($value.proofError){throw 'simulated-unreadable-requery'}
    $value.absent
  }
}
$value=Read-Inert @{birth='original';absent=$true}
Require ($value.birth -ceq 'original' -and $script:reads -eq 1 -and $script:proofs -eq 0)
$cases++
foreach($readFailure in @('owner-status','missing-field','GetProcessById','Handle','StartTime')) {
  $beforeReads=$script:reads;$beforeProofs=$script:proofs
  $value=Read-Inert @{fail=$readFailure;absent=$true}
  Require ($null -eq $value -and $script:reads -eq $beforeReads+1 -and $script:proofs -eq $beforeProofs+1)
  $cases++
}
foreach($inputValue in @(
  @{fail=$true;absent=$false},
  @{fail=$true;absent=$true;proofError=$true},
  @{fail=$true;absent=$null},
  @{fail=$true;absent=1},
  @{fail=$true;absent='true'},
  @{fail=$true;absent=@($true,$true)}
)) {
  $failed=$false;$beforeReads=$script:reads;$beforeProofs=$script:proofs
  try {$null=Read-Inert $inputValue} catch {$failed=$true}
  Require ($failed -and $script:reads -eq $beforeReads+1 -and $script:proofs -eq $beforeProofs+1)
  $cases++
}
# Identity mismatch is validated after the helper returns, never inside its
# recoverable read. Even a subsequent absence cannot absolve a mismatched birth.
$failed=$false;$beforeProofs=$script:proofs
try {
  $value=Read-Inert @{birth='reused';absent=$true}
  if($value.birth -cne 'original'){throw 'identity-changed'}
} catch {$failed=$true}
Require ($failed -and $script:proofs -eq $beforeProofs)
$cases++
# Shadow the actual cmdlet before executing the exact production snippet. No
# real CIM, sockets or listeners are read. Common-parameter binding remains real.
# Preconstruct fully-qualified error records outside the expected-error catch.
# A type/construction failure must fail setup, never masquerade as query rejection.
# https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_error_handling
Mark 'error-record-construct'
$script:queryErrors=@{
  error=[System.Management.Automation.ErrorRecord]::new([System.InvalidOperationException]::new('PRIVATE-PROVIDER-FAILURE'),'inert-query',[System.Management.Automation.ErrorCategory]::InvalidOperation,$null)
  partial=[System.Management.Automation.ErrorRecord]::new([System.InvalidOperationException]::new('PRIVATE-PARTIAL-FAILURE'),'inert-partial',[System.Management.Automation.ErrorCategory]::InvalidOperation,$null)
}
Mark 'error-record-ready'
$script:queryCalls=0;$script:errorReturns=0;$script:expectedAction='Stop';$listenerCases=0;$request=@{port=23456}
function Get-CimInstance {
  [CmdletBinding()]param([string]$ClassName,[string]$Namespace,[string]$Filter)
  $script:queryCalls++
  Require ($ClassName -ceq 'MSFT_NetTCPConnection' -and $Namespace -ceq 'root/StandardCimv2')
  Require ($Filter -ceq 'LocalPort=23456 AND State=2' -and $PSBoundParameters.ErrorAction -eq $script:expectedAction)
  if($script:mode -eq 'empty'){return}
  if($script:mode -eq 'throw'){throw 'PRIVATE-QUERY-FAILURE'}
  if($script:mode -eq 'error'){
    Mark 'error-write'
    $PSCmdlet.WriteError($script:queryErrors.error)
    $script:errorReturns++;Mark 'error-return';return
  }
  $address=if($script:mode -eq 'foreign'){'0.0.0.0'}else{'127.0.0.1'}
  [pscustomobject]@{LocalAddress=$address;OwningProcess=4100}
  if($script:mode -eq 'partial'){
    Mark 'error-write'
    $PSCmdlet.WriteError($script:queryErrors.partial)
    $script:errorReturns++;Mark 'error-return';return
  }
  [pscustomobject]@{LocalAddress='::1';OwningProcess=4100}
}
function Read-InertListeners {
${windowsReviewListenerReadScript}
  return ,$listening
}
# Negative control proves this is a real non-terminating error: Continue must
# return normally, whereas the exact production Stop query below must not.
Mark 'listener-continue'
$script:mode='error';$script:expectedAction='Continue';$before=$script:queryCalls
$null=Get-CimInstance MSFT_NetTCPConnection -Namespace root/StandardCimv2 -Filter 'LocalPort=23456 AND State=2' -ErrorAction Continue 2>$null
Require ($script:queryCalls -eq $before+1 -and $script:errorReturns -eq 1)
$script:expectedAction='Stop'
foreach($mode in @('empty','loopback')) {
  Mark ('listener-'+$mode)
  $script:mode=$mode;$before=$script:queryCalls;$value=Read-InertListeners
  Require ($script:queryCalls -eq $before+1)
  if($mode -eq 'empty'){Require ($value.Count -eq 0)}
  else{Require ($value.Count -eq 2 -and $value[0] -eq 4100 -and $value[1] -eq 4100)}
  $listenerCases++
}
foreach($mode in @('throw','error','partial','foreign')) {
  Mark ('listener-'+$mode)
  $script:mode=$mode;$before=$script:queryCalls;$failed=$false
  try {$null=Read-InertListeners} catch {
    if($mode -in @('error','partial')){
      Mark 'error-catch'
      $expectedID=$script:queryErrors[$mode].FullyQualifiedErrorId
      Require ($_.FullyQualifiedErrorId -ceq $expectedID -or $_.FullyQualifiedErrorId.StartsWith($expectedID+','))
    }
    $failed=$true
  }
  Require ($failed -and $script:queryCalls -eq $before+1 -and $script:errorReturns -eq 1)
  $listenerCases++
}
Mark 'launcher'
${windowsReviewLauncherCommandScript}
$exe='C:\Program Files\Microsoft\Edge\Application\msedge.exe'
$command=Launcher $exe 'D:\runner\owned profile'
Require ($command -ceq '"C:\Program Files\Microsoft\Edge\Application\msedge.exe" "--user-data-dir=D:\runner\owned profile" -- "%1"')
$launcherCases=1
foreach($path in @('relative','C:\owned\..\profile','C:\owned\%1','C:\owned\"profile','C:\profile\',("C:\owned\"+[char]10+"profile"))) {
  foreach($asExecutable in @($true,$false)) {
    $failed=$false
    try {if($asExecutable){$null=Launcher $path 'D:\runner\owned profile'}else{$null=Launcher $exe $path}} catch {$failed=$true}
    Require $failed
    $launcherCases++
  }
}
Mark 'json'
[Console]::Out.Write((@{fixtureOnly=$true;cases=$cases;reads=$script:reads;proofs=$script:proofs;listenerCases=$listenerCases;queryCalls=$script:queryCalls;nonterminatingControl=$script:errorReturns;launcherCases=$launcherCases;stdinPreserved=$true} | ConvertTo-Json -Compress))
`
    const executeScript = (source: string) => {
      const args = [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(windowsReviewScriptBootstrap(source), "utf16le").toString("base64"),
      ]
      return new Promise<string>((resolve, reject) => {
        const child = execFile(
          executable,
          args,
          {
            cwd: root,
            env: environment,
            shell: false,
            windowsHide: true,
            encoding: "utf8",
            maxBuffer: 4096,
            timeout: 12000,
          },
          (error, stdout, stderr) => {
            if (error) {
              child.unref()
              reject(fixtureFailure(error, stderr))
            } else resolve(stdout)
          },
        )
        children.add(child)
        child.once("close", () => {
          children.delete(child)
        })
        child.stdin?.on("error", () => {})
        child.stdin?.end('{"fixture":"stdin-preserved"}')
      })
    }
    const children = new Set<ChildProcess>()
    try {
      const result = await executeScript(script)
      let value: unknown
      try {
        value = JSON.parse(result.replace(/^\uFEFF/, ""))
      } catch {
        throw Error("INERT_IDENTITY_FIXTURE_INVALID")
      }
      expect(value).toEqual({
        fixtureOnly: true,
        cases: 13,
        reads: 13,
        proofs: 11,
        listenerCases: 6,
        queryCalls: 7,
        nonterminatingControl: 1,
        launcherCases: 13,
        stdinPreserved: true,
      })
      await expect(
        executeScript("[Console]::Error.WriteLine('INERT_WINDOWS_FIXTURE_listener-error');exit 7"),
      ).rejects.toThrow("INERT_IDENTITY_FIXTURE_FAILED:listener-error:exit")
    } finally {
      if (!children.size) await rm(root, { recursive: true, force: true })
    }
  },
  30000,
)

test("native listener transport preserves successful zero matches but never accepts failed or partial query output", () => {
  const empty = { processes: [], listening: [], policyOwned: true }
  expect(windowsReviewNativeResult({ stdout: JSON.stringify(empty), stderr: "" })).toEqual(empty)
  for (const stdout of ["", JSON.stringify(empty), JSON.stringify({ ...empty, listening: [4100] })]) {
    const error = (() => {
      try {
        windowsReviewNativeResult({
          stdout,
          stderr: "PRIVATE-CREDENTIAL\nPHYSICALSYSTEMS_WINDOWS_BROWSER_PHASE_listener\n",
          error: { code: 1 },
        })
      } catch (error) {
        return error
      }
    })()
    expect(error).toBeInstanceOf(Error)
    expect(readBrowserObservation(error)).toEqual({
      browserPhase: "context",
      windowsNativePhase: "listener",
      windowsNativeOutcome: "exit",
    })
    expect(JSON.stringify(readBrowserObservation(error))).not.toContain("PRIVATE")
  }
})

test("retained-process cleanup failures expose only the fixed boundary, never PID details", () => {
  for (const phase of ["retained-input", "retained-query", "retained-self", "retained-other"] as const) {
    try {
      windowsReviewNativeResult({
        error: { code: 1 },
        stdout: "PRIVATE-PROCESS-DATA",
        stderr: `PHYSICALSYSTEMS_WINDOWS_BROWSER_PHASE_${phase}\n`,
      })
      throw Error("expected native failure")
    } catch (error) {
      expect(readBrowserObservation(error)?.windowsNativePhase).toBe(phase)
      expect(JSON.stringify(readBrowserObservation(error))).not.toContain("PRIVATE")
    }
  }
})
