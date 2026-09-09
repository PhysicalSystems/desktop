// SPDX-License-Identifier: Apache-2.0
// Hosted language fixture only: no real process queries, browser, policy or provider operations.
import { spawn } from "node:child_process"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { join, win32 } from "node:path"
import { waitForShutdownStep } from "../lifecycle"
import { requireDisposablePublicRunner } from "./public-qualification"
import {
  windowsReviewNativeEnvironment,
  windowsReviewProcessSelectionScript,
  windowsReviewScriptBootstrap,
} from "./windows-review-native"

function requireFixture(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(`WINDOWS_REVIEW_SELECTION_FIXTURE_${code}`)
}

const phases = ["bootstrap", "selection", "orphan", "self-absent", "other-absent", "other-live", "query-failure"]
const script = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$script:fixturePhase='bootstrap'
trap {[Console]::Out.WriteLine('WINDOWS_REVIEW_SELECTION_FIXTURE_PHASE_'+$script:fixturePhase);exit 1}
$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules')
function Require($condition){if($condition -ne $true){throw 'fixture-assertion'}}
${windowsReviewProcessSelectionScript}

# These IDs are inert rows only. No OS lookup uses them, and the current real
# helper ID is deliberately reused as a historical browser ancestor.
$ids=@(1001,1002,1003,1004,1005)
if($PID -in $ids){$ids=@(2001,2002,2003,2004,2005)}
$tree=@(
  [pscustomobject]@{ProcessId=$ids[1];ParentProcessId=$ids[0];Name='unknown-child.exe'},
  [pscustomobject]@{ProcessId=$PID;ParentProcessId=0;Name='powershell.exe'},
  [pscustomobject]@{ProcessId=$ids[0];ParentProcessId=$PID;Name='powershell.exe'},
  [pscustomobject]@{ProcessId=$ids[2];ParentProcessId=0;Name='msedge.exe'},
  [pscustomobject]@{ProcessId=$ids[3];ParentProcessId=0;Name='msedge_crashpad_handler.exe'},
  [pscustomobject]@{ProcessId=$ids[4];ParentProcessId=0;Name='unrelated.exe'}
)
$script:fixturePhase='selection'
foreach($inputValue in @(@{root=$PID;observed=@()},@{root=0;observed=@($PID)})){
  $actual=@(Select-ReviewProcesses -tree $tree -rootPid $inputValue.root -observedPids $inputValue.observed)
  Require ($actual.Count -eq 4)
  Require ((@($actual.ProcessId | Sort-Object) -join ',') -ceq (($ids[0..3] | Sort-Object) -join ','))
  Require ($actual.ProcessId -notcontains $PID)
}
$script:fixturePhase='orphan'
$orphanTree=@($tree | Where-Object {$_.ProcessId -ne $PID -and $_.ProcessId -ne $ids[0]})
$actual=@(Select-ReviewProcesses -tree $orphanTree -rootPid 0 -observedPids @($ids[0]))
Require ($actual.Count -eq 3)
Require ((@($actual.ProcessId | Sort-Object) -join ',') -ceq (($ids[1..3] | Sort-Object) -join ','))

# Override the query boundary, never the production selection/absence functions.
# A query for the helper itself or an unrelated ID fails the fixture immediately.
$script:queries=[Collections.Generic.List[string]]::new()
$script:observedPhases=[Collections.Generic.List[string]]::new()
$script:queryMode='absent'
function Set-ReviewPhase([string]$phase){$script:observedPhases.Add($phase)}
function Get-CimInstance([string]$Query,[string]$ErrorAction){
  Require ($Query -ceq ('SELECT ProcessId FROM Win32_Process WHERE ProcessId='+$ids[4]))
  Require ($ErrorAction -ceq 'Stop')
  $script:queries.Add($Query)
  if($script:queryMode -ceq 'fail'){throw 'fixture-query-failed'}
  if($script:queryMode -ceq 'live'){[pscustomobject]@{ProcessId=$ids[4]}}
}
$script:fixturePhase='self-absent'
Require-ObservedProcessesAbsent -observedPids @($PID)
Require ($script:queries.Count -eq 0 -and $script:observedPhases.Count -eq 0)
$script:fixturePhase='other-absent'
Require-ObservedProcessesAbsent -observedPids @($PID,$ids[4])
Require ($script:queries.Count -eq 1 -and ($script:observedPhases -join ',') -ceq 'retained-query')
$script:queries.Clear();$script:observedPhases.Clear()
$script:fixturePhase='other-live'
$script:queryMode='live'
$rejected=$false
try {Require-ObservedProcessesAbsent -observedPids @($PID,$ids[4])}
catch {Require ($_.Exception.Message -ceq 'observed-process-alive');$rejected=$true}
Require ($rejected -and $script:queries.Count -eq 1)
Require (($script:observedPhases -join ',') -ceq 'retained-query,retained-other')
$script:queries.Clear();$script:observedPhases.Clear()
$script:fixturePhase='query-failure'
$script:queryMode='fail'
$rejected=$false
try {Require-ObservedProcessesAbsent -observedPids @($PID,$ids[4])}
catch {Require ($_.Exception.Message -ceq 'fixture-query-failed');$rejected=$true}
Require ($rejected -and $script:queries.Count -eq 1)
Require (($script:observedPhases -join ',') -ceq 'retained-query')
[Console]::Out.WriteLine('WINDOWS_REVIEW_SELECTION_FIXTURE_PASS')
`

async function main() {
  requireFixture(
    process.platform === "win32" &&
      process.env.PHYSICALSYSTEMS_WINDOWS_REVIEW_SELECTION_FIXTURE === "1" &&
      process.env.CI === "true" &&
      process.env.GITHUB_ACTIONS === "true" &&
      process.env.RUNNER_ENVIRONMENT === "github-hosted" &&
      process.env.RUNNER_OS === "Windows" &&
      process.env.GITHUB_REPOSITORY === "PhysicalSystems/desktop" &&
      process.env.PHYSICALSYSTEMS_ALLOW_DEVICES === "0",
    "HOSTED_WINDOWS_ONLY",
  )
  const root = await mkdtemp(join(await realpath(process.env.RUNNER_TEMP!), "review-selection-fixture-"))
  await requireDisposablePublicRunner(process.env, root)
  const environment = windowsReviewNativeEnvironment(process.env, root)
  const child = spawn(
    win32.join(environment.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(windowsReviewScriptBootstrap(script), "utf16le").toString("base64"),
    ],
    { cwd: root, env: environment, shell: false, stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
  )
  let closed = false
  let failed = false
  let code: number | null = null
  let output = ""
  child.stdout!.setEncoding("utf8")
  child.stdout!.on("data", (value: string) => {
    if (Buffer.byteLength(output) + Buffer.byteLength(value) <= 4096) output += value
    else {
      failed = true
      child.kill()
    }
  })
  child.once("error", () => {
    failed = true
  })
  const completion = new Promise<void>((resolve) => {
    child.once("close", (value) => {
      code = value
      closed = true
      resolve()
    })
  })
  try {
    await waitForShutdownStep(completion, 30000, "WINDOWS_REVIEW_SELECTION_FIXTURE_TIMEOUT")
    const phase = /^WINDOWS_REVIEW_SELECTION_FIXTURE_PHASE_([a-z-]+)\r?\n?$/.exec(output)?.[1]
    if (phase && phases.includes(phase))
      throw new Error(`WINDOWS_REVIEW_SELECTION_FIXTURE_${phase.toUpperCase().replaceAll("-", "_")}`)
    requireFixture(!failed && code === 0 && output.trim() === "WINDOWS_REVIEW_SELECTION_FIXTURE_PASS", "FAILED")
  } finally {
    if (!closed) child.kill()
    await waitForShutdownStep(completion, 5000, "WINDOWS_REVIEW_SELECTION_FIXTURE_CLOSE_UNCONFIRMED")
    await rm(root, { recursive: true, force: true })
  }
  console.log(JSON.stringify({ windowsReviewProcessSelectionFixture: { status: "PASS", scope: "inert-records-only" } }))
}

await main().catch((error: unknown) => {
  console.error(
    error instanceof Error && /^WINDOWS_REVIEW_SELECTION_FIXTURE_[A-Z_]+$/.test(error.message)
      ? error.message
      : "WINDOWS_REVIEW_SELECTION_FIXTURE_FAILED",
  )
  process.exitCode = 1
})
