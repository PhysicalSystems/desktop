// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { join, win32 } from "node:path"
import {
  windowsReviewIdentityReadScript,
  windowsReviewNativeArguments,
  windowsReviewNativeEnvironment,
  windowsReviewNativeScript,
} from "./windows-review-native"
import { requireDisposablePublicRunner } from "./public-qualification"

test("the actual encoded native script contains the tested reconciliation helper and fits CreateProcess", () => {
  const executable = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
  const args = windowsReviewNativeArguments(executable)
  const decoded = Buffer.from(args.at(-1)!, "base64").toString("utf16le")
  expect(decoded).toBe(windowsReviewNativeScript)
  expect(decoded.split(windowsReviewIdentityReadScript)).toHaveLength(2)
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
  "hosted PowerShell reconciles only a fresh Boolean absence after failed inert identity reads",
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
[Console]::Out.Write((@{fixtureOnly=$true;cases=$cases;reads=$script:reads;proofs=$script:proofs} | ConvertTo-Json -Compress))
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
        execFile(
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
            closed = true
            if (error) reject(Error("INERT_IDENTITY_FIXTURE_FAILED"))
            else resolve(stdout)
          },
        )
      })
      let value: unknown
      try {
        value = JSON.parse(result.replace(/^\uFEFF/, ""))
      } catch {
        throw Error("INERT_IDENTITY_FIXTURE_INVALID")
      }
      expect(value).toEqual({ fixtureOnly: true, cases: 13, reads: 13, proofs: 11 })
    } finally {
      if (closed) await rm(root, { recursive: true, force: true })
    }
  },
  20000,
)
