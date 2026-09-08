// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { join, win32 } from "node:path"
import {
  windowsReviewIdentityReadScript,
  windowsReviewListenerReadScript,
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
  expect(decoded).toBe(windowsReviewNativeScript)
  expect(decoded.split(windowsReviewIdentityReadScript)).toHaveLength(2)
  expect(decoded.split(windowsReviewListenerReadScript)).toHaveLength(2)
  const units = executable.length * 2 + 3 + args.reduce((total, arg) => total + arg.length + 3, 0)
  expect(units).toBeLessThanOrEqual(32767)
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
$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules')
trap {[Console]::Error.Write('INERT_IDENTITY_FIXTURE_FAILED');exit 1}
${windowsReviewIdentityReadScript}
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
$script:queryCalls=0;$listenerCases=0;$request=@{port=23456}
function Get-CimInstance {
  [CmdletBinding()]param([string]$ClassName,[string]$Namespace,[string]$Filter)
  $script:queryCalls++
  Require ($ClassName -ceq 'MSFT_NetTCPConnection' -and $Namespace -ceq 'root/StandardCimv2')
  Require ($Filter -ceq 'LocalPort=23456 AND State=2' -and $PSBoundParameters.ErrorAction -eq 'Stop')
  if($script:mode -eq 'empty'){return}
  if($script:mode -eq 'throw'){throw 'PRIVATE-QUERY-FAILURE'}
  if($script:mode -eq 'error'){Write-Error 'PRIVATE-PROVIDER-FAILURE';return}
  $address=if($script:mode -eq 'foreign'){'0.0.0.0'}else{'127.0.0.1'}
  [pscustomobject]@{LocalAddress=$address;OwningProcess=4100}
  if($script:mode -eq 'partial'){Write-Error 'PRIVATE-PARTIAL-FAILURE';return}
  [pscustomobject]@{LocalAddress='::1';OwningProcess=4100}
}
function Read-InertListeners {
${windowsReviewListenerReadScript}
  return ,$listening
}
foreach($mode in @('empty','loopback')) {
  $script:mode=$mode;$before=$script:queryCalls;$value=Read-InertListeners
  Require ($script:queryCalls -eq $before+1)
  if($mode -eq 'empty'){Require ($value.Count -eq 0)}
  else{Require ($value.Count -eq 2 -and $value[0] -eq 4100 -and $value[1] -eq 4100)}
  $listenerCases++
}
foreach($mode in @('throw','error','partial','foreign')) {
  $script:mode=$mode;$before=$script:queryCalls;$failed=$false
  try {$null=Read-InertListeners} catch {$failed=$true}
  Require ($failed -and $script:queryCalls -eq $before+1)
  $listenerCases++
}
[Console]::Out.Write((@{fixtureOnly=$true;cases=$cases;reads=$script:reads;proofs=$script:proofs;listenerCases=$listenerCases;queryCalls=$script:queryCalls} | ConvertTo-Json -Compress))
`
    const args = [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ]
    let closed = false
    try {
      const result = await new Promise<string>((resolve, reject) => {
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
          (error, stdout) => {
            if (error) {
              child.unref()
              reject(Error("INERT_IDENTITY_FIXTURE_FAILED"))
            } else resolve(stdout)
          },
        )
        child.once("close", () => {
          closed = true
        })
      })
      let value: unknown
      try {
        value = JSON.parse(result.replace(/^\uFEFF/, ""))
      } catch {
        throw Error("INERT_IDENTITY_FIXTURE_INVALID")
      }
      expect(value).toEqual({ fixtureOnly: true, cases: 13, reads: 13, proofs: 11, listenerCases: 6, queryCalls: 6 })
    } finally {
      if (closed) await rm(root, { recursive: true, force: true })
    }
  },
  20000,
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
