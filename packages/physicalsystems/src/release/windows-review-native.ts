// SPDX-License-Identifier: Apache-2.0
import { execFile } from "node:child_process"
import { win32 } from "node:path"
import { browserObservationError, readBrowserObservation } from "./browser-observation"

/** Parse only the adapter's fixed failure marker; never retain native output. */
export function windowsReviewNativeFailure(stdout: string) {
  const phases =
    stdout.length <= 1024 * 1024
      ? stdout.split(/\r?\n/).flatMap((line) => {
          const match = /^PHYSICALSYSTEMS_WINDOWS_BROWSER_PHASE_([a-z-]+)$/.exec(line)
          if (!match) return []
          const value = readBrowserObservation({
            browserObservation: { browserPhase: "context", windowsNativePhase: match[1] },
          })
          return value?.windowsNativePhase ? [value.windowsNativePhase] : []
        })
      : []
  return browserObservationError("PROVIDER_REVIEW_WINDOWS_UNCONFIRMED", undefined, {
    browserPhase: "context",
    ...(phases.length === 1 ? { windowsNativePhase: phases[0] } : {}),
  })
}

/** Internal controller transport. Native values remain private and are never
 * returned as qualification evidence or interpolated into a shell command. */
export type WindowsReviewProcess = {
  pid: number
  parent: number
  birth: string
  session: number
  sid: string
  executable: string
  args: string[]
}
export type WindowsReviewPolicy = {
  keys: boolean[]
  value: null | { kind: "String" | "ExpandString"; data: string }
}
export type WindowsReviewBaseline = {
  executable: string
  sid: string
  policy: WindowsReviewPolicy
  processes: WindowsReviewProcess[]
}
export type WindowsReviewObservation = { processes: WindowsReviewProcess[]; listening: number[]; policyOwned: boolean }
export type WindowsReviewNative = (
  request:
    | { operation: "preflight"; scheme: "http" | "https" }
    | { operation: "set"; profile: string; before: WindowsReviewPolicy }
    | { operation: "restore"; profile: string; before: WindowsReviewPolicy; observedPids: number[] }
    | {
        operation: "observe"
        profile: string
        scheme: "http" | "https"
        port?: number
        rootPid?: number
        observedPids: number[]
      }
    | { operation: "stop"; processes: WindowsReviewProcess[] },
) => Promise<unknown>

export function windowsReviewNative(env: NodeJS.ProcessEnv, root: string): WindowsReviewNative {
  const system = env.SystemRoot ?? env.SYSTEMROOT
  if (
    process.platform !== "win32" ||
    !system ||
    !/^[A-Za-z]:\\[^\r\n\0"]+$/.test(system) ||
    win32.normalize(system) !== system
  )
    throw Error("PROVIDER_REVIEW_WINDOWS_UNCONFIRMED")
  const executable = win32.join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  const privateEnv = Object.fromEntries(
    ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"].flatMap(
      (key) => (env[key] ? [[key, env[key]!]] : []),
    ),
  )
  return async (request) => {
    const payload = JSON.stringify(request)
    if (payload.length > 128 * 1024) throw Error("PROVIDER_REVIEW_WINDOWS_UNCONFIRMED")
    return await new Promise((resolve, reject) => {
      const child = execFile(
        executable,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(windowsReviewNativeScript, "utf16le").toString("base64"),
        ],
        {
          cwd: root,
          env: {
            ...privateEnv,
            SystemRoot: system,
            WINDIR: system,
            TEMP: root,
            TMP: root,
            PATH: win32.join(system, "System32"),
          },
          shell: false,
          windowsHide: true,
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
          timeout: 12000,
        },
        (error, stdout) => {
          if (error) return reject(windowsReviewNativeFailure(stdout))
          try {
            resolve(JSON.parse(stdout.replace(/^\uFEFF/, "")))
          } catch {
            reject(Error("PROVIDER_REVIEW_WINDOWS_UNCONFIRMED"))
          }
        },
      )
      child.stdin?.on("error", () => {})
      child.stdin?.end(payload)
    })
  }
}

// ASSOCF_IS_PROTOCOL=0x1000 maps the current user default; never FIXED_PROGID.
// Policy restoration compares its current value before writing and removes only
// our newly created, still-empty keys. UserChoice and its Hash are read-only.
export const windowsReviewNativeScript = String.raw`
$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$script:reviewPhase = 'bootstrap'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
trap { [Console]::Out.WriteLine('PHYSICALSYSTEMS_WINDOWS_BROWSER_PHASE_'+$script:reviewPhase); [Console]::Error.Write('PROVIDER_REVIEW_WINDOWS_UNCONFIRMED'); exit 1 }
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$paths = @('Software\Policies', 'Software\Policies\Microsoft', 'Software\Policies\Microsoft\Edge')
$base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry64)
$machine = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ReviewNative {
  [DllImport("shlwapi.dll", CharSet=CharSet.Unicode)] static extern uint AssocQueryString(uint flags, uint str, string assoc, string extra, StringBuilder output, ref uint size);
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CommandLineToArgvW(string command, out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
  public static string Association(uint kind, string scheme) {
    uint size=32768; var output=new StringBuilder((int)size);
    if(AssocQueryString(0x1000,kind,scheme,"open",output,ref size)!=0) throw new Exception();
    return output.ToString();
  }
  public static string[] Arguments(string command) {
    int count; var memory=CommandLineToArgvW(command,out count);
    if(memory==IntPtr.Zero || count<1 || count>256) throw new Exception();
    try { var values=new string[count]; for(int i=0;i<count;i++) values[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory,i*IntPtr.Size)); return values; }
    finally { LocalFree(memory); }
  }
}
'@
function Read-Policy {
  $script:reviewPhase = 'policy-read'
  $keys = @($paths | ForEach-Object { $key=$base.OpenSubKey($_); $present=$null -ne $key; if($key){$key.Dispose()}; $present })
  $key=$base.OpenSubKey($paths[-1]); $value=$null
  try {
    if($key -and $key.GetValueNames() -contains 'UserDataDir') {
      $kind=$key.GetValueKind('UserDataDir').ToString()
      if($kind -notin @('String','ExpandString')) { throw 'invalid' }
      $data=$key.GetValue('UserDataDir',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      if($data -isnot [string] -or $data.Length -gt 32768) { throw 'invalid' }
      $value=@{kind=$kind;data=$data}
    }
  } finally { if($key){$key.Dispose()} }
  @{keys=$keys;value=$value}
}
function Same-Value($a,$b) {
  if($null -eq $a -or $null -eq $b) { return $null -eq $a -and $null -eq $b }
  return $a.kind -ceq $b.kind -and $a.data -ceq $b.data
}
function Require-NoMachineOverride {
  $script:reviewPhase = 'machine-policy'
  $key=$machine.OpenSubKey($paths[-1]); try {
    if($key -and $key.GetValueNames() -contains 'UserDataDir') { throw 'machine-policy' }
  } finally { if($key){$key.Dispose()} }
}
function Association {
  $script:reviewPhase = 'association-progid'
  if($request.scheme -notin @('http','https')) {throw 'scheme'}
  if([ReviewNative]::Association(20,[string]$request.scheme) -cne 'MSEdgeHTM') { throw 'association' }
  $script:reviewPhase = 'association-executable'
  $exe=[IO.Path]::GetFullPath([ReviewNative]::Association(2,[string]$request.scheme))
  $allowed=@($env:ProgramFiles,[Environment]::GetEnvironmentVariable('ProgramFiles(x86)'),$env:ProgramW6432) | Where-Object {$_} | ForEach-Object {[IO.Path]::Combine($_,'Microsoft\Edge\Application\msedge.exe')}
  if($allowed -inotcontains $exe) { throw 'executable' }
  return $exe
}
function Processes {
  $script:reviewPhase = 'process-tree'
  # Enumerate only PID/parent/name for ambient processes. Full private identity
  # is requested solely for Edge or descendants of our explicit spawned root.
  $tree=@(Get-CimInstance -Query 'SELECT ProcessId,ParentProcessId,Name FROM Win32_Process')
  if($tree.Count -gt 32768){throw 'excessive'}
  $selected=[Collections.Generic.HashSet[int]]::new()
  if($request.rootPid) {$null=$selected.Add([int]$request.rootPid)}
  # Keep every previously observed descendant as an independent root even when
  # its former parent has exited. The controller checks retained birth identity.
  foreach($pidValue in (Observed-Pids)) {$null=$selected.Add($pidValue)}
  $changed=$true
  while($changed) {
    $changed=$false
    foreach($item in $tree) {
      if($item.Name -in @('msedge.exe','msedge_crashpad_handler.exe') -or $selected.Contains([int]$item.ParentProcessId)) {
        if($selected.Add([int]$item.ProcessId)) {$changed=$true}
      }
    }
  }
  $items=@($tree | Where-Object {$selected.Contains([int]$_.ProcessId)} | ForEach-Object {Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$_.ProcessId)"})
  if($items.Count -gt 256) { throw 'excessive' }
  @($items | ForEach-Object {
    $script:reviewPhase = 'process-identity'
    $owner=Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid
    if($owner.ReturnValue -ne 0 -or !$_.ExecutablePath -or !$_.CommandLine) { throw 'identity' }
    $process=[Diagnostics.Process]::GetProcessById([int]$_.ProcessId)
    try {
      $null=$process.Handle
      $birth=$process.StartTime.ToUniversalTime().ToFileTimeUtc()
      if([Math]::Abs(($_.CreationDate.ToUniversalTime().ToFileTimeUtc()-$birth)) -ge 10) {throw 'identity'}
      @{pid=[int]$_.ProcessId;parent=[int]$_.ParentProcessId;birth=$birth.ToString();session=[int]$_.SessionId;sid=$owner.Sid;executable=$_.ExecutablePath;args=@([ReviewNative]::Arguments($_.CommandLine))}
    } finally {$process.Dispose()}
  })
}
function Observed-Pids {
  if($null -eq $request.observedPids -or @($request.observedPids).Count -gt 256){throw 'observed-roots'}
  @($request.observedPids | ForEach-Object {
    if($_ -isnot [int] -and $_ -isnot [long]){throw 'observed-roots'}
    if($_ -lt 1 -or $_ -gt [int]::MaxValue){throw 'observed-roots'}
    [int]$_
  })
}
function Require-NoEdge {
  $script:reviewPhase = 'ambient-browser'
  if(@(Get-CimInstance -Query "SELECT ProcessId FROM Win32_Process WHERE Name='msedge.exe' OR Name='msedge_crashpad_handler.exe'").Count -ne 0) {throw 'ambient-browser'}
}
switch($request.operation) {
  'preflight' {
    Require-NoMachineOverride
    Require-NoEdge
    $exe=Association
    $script:reviewPhase = 'signature'
    $signature=Get-AuthenticodeSignature -LiteralPath $exe
    if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(^|,\s*)CN=Microsoft Corporation(,|$)') { throw 'signature' }
    $result=@{executable=$exe;sid=$sid;policy=(Read-Policy);processes=@()}
  }
  'set' {
    Require-NoMachineOverride
    Require-NoEdge
    $current=Read-Policy
    $script:reviewPhase = 'policy-compare'
    if(!(Same-Value $current.value $request.before.value) -or (($current.keys | ConvertTo-Json -Compress) -cne ($request.before.keys | ConvertTo-Json -Compress))) { throw 'changed' }
    $script:reviewPhase = 'policy-write'
    $key=$base.CreateSubKey($paths[-1]); try {$key.SetValue('UserDataDir',[string]$request.profile,[Microsoft.Win32.RegistryValueKind]::String)} finally {$key.Dispose()}
    if(!(Same-Value (Read-Policy).value @{kind='String';data=[string]$request.profile})) { throw 'unconfirmed' }
    $result=@{written=$true}
  }
  'restore' {
    Require-NoEdge
    $script:reviewPhase = 'process-tree'
    # Any surviving or reused observed PID prevents restoring policy/removing
    # the private profile. Unknown descendants are never termination targets.
    foreach($pidValue in (Observed-Pids)) {
      if(Get-CimInstance -Query "SELECT ProcessId FROM Win32_Process WHERE ProcessId=$pidValue"){throw 'observed-process-alive'}
    }
    $current=Read-Policy
    $script:reviewPhase = 'policy-compare'
    if(!(Same-Value $current.value @{kind='String';data=[string]$request.profile}) -and !(Same-Value $current.value $request.before.value)) { throw 'changed' }
    $script:reviewPhase = 'policy-restore'
    $key=$base.OpenSubKey($paths[-1],$true)
    if($key) { try {
      if($null -eq $request.before.value) {$key.DeleteValue('UserDataDir',$false)}
      else {$key.SetValue('UserDataDir',[string]$request.before.value.data,[Enum]::Parse([Microsoft.Win32.RegistryValueKind],[string]$request.before.value.kind))}
    } finally {$key.Dispose()} }
    $script:reviewPhase = 'policy-keys'
    for($index=$paths.Count-1;$index -ge 0;$index--) {
      if($request.before.keys[$index]) {continue}
      $key=$base.OpenSubKey($paths[$index]); if(!$key){continue}
      $empty=$key.SubKeyCount -eq 0 -and $key.ValueCount -eq 0; $key.Dispose()
      if(!$empty){throw 'concurrent-policy'}
      $base.DeleteSubKey($paths[$index],$false)
    }
    $after=Read-Policy
    $script:reviewPhase = 'policy-readback'
    if(!(Same-Value $after.value $request.before.value) -or (($after.keys | ConvertTo-Json -Compress) -cne ($request.before.keys | ConvertTo-Json -Compress))) {throw 'restore-unconfirmed'}
    $result=@{restored=$true}
  }
  'observe' {
    Require-NoMachineOverride
    $null=Association
    $listening=@()
    if($request.port) {
      $script:reviewPhase = 'listener'
      $listening=@(Get-NetTCPConnection -LocalPort ([int]$request.port) -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
        if($_.LocalAddress -notin @('127.0.0.1','::1')){throw 'non-loopback'}
        [int]$_.OwningProcess
      })
    }
    $result=@{processes=@(Processes);listening=$listening;policyOwned=(Same-Value (Read-Policy).value @{kind='String';data=[string]$request.profile})}
  }
  'stop' {
    if(@($request.processes).Count -gt 256){throw 'excessive'}
    foreach($expected in $request.processes) {
      $script:reviewPhase = 'process-identity'
      $native=Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$expected.pid)"
      if(!$native){continue}
      $owner=Invoke-CimMethod -InputObject $native -MethodName GetOwnerSid
      $process=[Diagnostics.Process]::GetProcessById([int]$expected.pid)
      try {
        $null=$process.Handle # retain a handle to this process instance before identity checks
        if($process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -cne $expected.birth -or
          [Math]::Abs(($native.CreationDate.ToUniversalTime().ToFileTimeUtc()-[long]$expected.birth)) -ge 10 -or
          $native.ExecutablePath -ine $expected.executable -or $native.SessionId -ne $expected.session -or
          $owner.ReturnValue -ne 0 -or $owner.Sid -cne $expected.sid -or $owner.Sid -cne $sid) {throw 'identity-changed'}
        $script:reviewPhase = 'process-signal'
        $process.Kill()
        $script:reviewPhase = 'process-wait'
        if(!$process.WaitForExit(5000)){throw 'retained'}
      } finally {$process.Dispose()}
    }
    $result=@{stopped=$true}
  }
  default {throw 'operation'}
}
$script:reviewPhase = 'output'
[Console]::Out.Write(($result | ConvertTo-Json -Depth 12 -Compress))
`
