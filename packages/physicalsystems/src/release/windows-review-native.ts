// SPDX-License-Identifier: Apache-2.0
import { execFile, type ChildProcess } from "node:child_process"
import { win32 } from "node:path"
import { gzipSync } from "node:zlib"
import { browserObservationError, readBrowserObservation, type BrowserObservation } from "./browser-observation"

/** Parse only the adapter's fixed failure marker; never retain native output. */
export function windowsReviewNativeFailure(
  stdout: string,
  stderr = "",
  outcome?: BrowserObservation["windowsNativeOutcome"],
) {
  const parse = (text: string) =>
    Buffer.byteLength(text, "utf8") <= 1024 * 1024
      ? text.split(/\r?\n/).flatMap((line) => {
          const match = /^PHYSICALSYSTEMS_WINDOWS_BROWSER_PHASE_([a-z-]+)$/.exec(line)
          if (!match) return []
          const value = readBrowserObservation({
            browserObservation: { browserPhase: "context", windowsNativePhase: match[1] },
          })
          return value?.windowsNativePhase ? [value.windowsNativePhase] : []
        })
      : []
  // Live stderr checkpoints survive a timeout which never reaches the trap.
  // Stdout remains the successful JSON channel; its single trap marker is a
  // fallback for already-authored failures. No native text is retained.
  const live = parse(stderr)
  const trapped = parse(stdout)
  const phase = live.at(-1) ?? (trapped.length === 1 ? trapped[0] : undefined)
  return browserObservationError("PROVIDER_REVIEW_WINDOWS_UNCONFIRMED", undefined, {
    browserPhase: "context",
    ...(phase ? { windowsNativePhase: phase } : {}),
    ...(outcome ? { windowsNativeOutcome: outcome } : {}),
  })
}

/** The callback's native output is private; only fixed outcome facts survive. */
export function windowsReviewNativeResult(input: { stdout: string; stderr: string; error?: unknown }) {
  if (input.error) {
    const error = input.error as { code?: unknown; killed?: unknown; signal?: unknown }
    // This adapter never exposes or manually kills its execFile child. After
    // excluding the output limit, killed can only be its own operation deadline.
    const outcome: NonNullable<BrowserObservation["windowsNativeOutcome"]> =
      error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
        ? "output-limit"
        : error.code === "ETIMEDOUT" || error.killed === true
          ? "timeout"
          : typeof error.signal === "string"
            ? "signal"
            : typeof error.code === "number"
              ? "exit"
              : ["ENOENT", "EACCES", "EPERM", "EINVAL"].includes(String(error.code))
                ? "start"
                : "unknown"
    throw windowsReviewNativeFailure(input.stdout, input.stderr, outcome)
  }
  try {
    return JSON.parse(input.stdout.replace(/^\uFEFF/, "")) as unknown
  } catch {
    throw windowsReviewNativeFailure(input.stdout, input.stderr, "invalid-json")
  }
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
export type WindowsReviewIdentityHelper = { executable: string; version: string }
export type WindowsReviewBaseline = {
  executable: string
  identityHelper?: WindowsReviewIdentityHelper
  sid: string
  policy: WindowsReviewPolicy
  processes: WindowsReviewProcess[]
  resolvedCommand: string
}
export type WindowsReviewObservation = { processes: WindowsReviewProcess[]; listening: number[]; policyOwned: boolean }
export type WindowsReviewNative = (
  request:
    | { operation: "preflight"; scheme: "http" | "https" }
    | {
        operation: "set"
        profile: string
        before: WindowsReviewPolicy
        scheme: "http" | "https"
        executable: string
        beforeCommand: string
      }
    | {
        operation: "restore"
        profile: string
        before: WindowsReviewPolicy
        observedPids: number[]
        scheme: "http" | "https"
        executable: string
        beforeCommand: string
      }
    | {
        operation: "observe"
        executable: string
        profile: string
        scheme: "http" | "https"
        port?: number
        rootPid?: number
        observedPids: number[]
      }
    | { operation: "stop"; processes: WindowsReviewProcess[] },
) => Promise<unknown>

/** Pure encoding only. The executor below always binds the committed native
 * source; callers cannot provide executable script text. No files, inherited
 * code hooks, cmdlet discovery or execution-policy override are introduced. */
export function windowsReviewScriptBootstrap(source: string) {
  const compressed = gzipSync(Buffer.from(source, "utf8")).toString("base64")
  return `$ErrorActionPreference='Stop'
$reviewCompressed=[IO.MemoryStream]::new([Convert]::FromBase64String('${compressed}'))
$reviewInflater=[IO.Compression.GZipStream]::new($reviewCompressed,[IO.Compression.CompressionMode]::Decompress)
$reviewReader=[IO.StreamReader]::new($reviewInflater,[Text.UTF8Encoding]::new($false,$true))
try { & ([ScriptBlock]::Create($reviewReader.ReadToEnd())) }
finally { $reviewReader.Dispose();$reviewInflater.Dispose();$reviewCompressed.Dispose() }`
}

export function windowsReviewNativeArguments(executable: string) {
  const args = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(windowsReviewScriptBootstrap(windowsReviewNativeScript), "utf16le").toString("base64"),
  ]
  // CreateProcess accepts at most 32767 UTF-16 code units including NUL.
  // Conservatively reserve doubled executable escaping, quotes, separators,
  // and termination; diagnostic growth must fail before native acquisition.
  const length = executable.length * 2 + 3 + args.reduce((total, arg) => total + arg.length + 3, 0)
  if (length > 32767) throw Error("PROVIDER_REVIEW_WINDOWS_UNCONFIRMED")
  return args
}

/** The native adapter searches only OS-shipped modules and owns its analysis
 * cache. Inherited user/module discovery hooks never enter this environment. */
export function windowsReviewNativeEnvironment(env: NodeJS.ProcessEnv, root: string): NodeJS.ProcessEnv {
  const system = env.SystemRoot ?? env.SYSTEMROOT
  if (!system || !/^[A-Za-z]:\\[^\r\n\0"]+$/.test(system) || win32.normalize(system) !== system)
    throw Error("PROVIDER_REVIEW_WINDOWS_UNCONFIRMED")
  const privateEnv = Object.fromEntries(
    ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"].flatMap(
      (key) => (env[key] ? [[key, env[key]!]] : []),
    ),
  )
  return {
    ...privateEnv,
    SystemRoot: system,
    WINDIR: system,
    TEMP: root,
    TMP: root,
    PATH: win32.join(system, "System32"),
    PSModulePath: win32.join(system, "System32", "WindowsPowerShell", "v1.0", "Modules"),
    PSModuleAnalysisCachePath: win32.join(root, "ModuleAnalysisCache"),
  }
}

/** Transport only: the mandatory executor has no native default or executable,
 * environment or platform override. The guarded factory below owns those.
 * Preflight includes OS signature-chain verification, whose network retrieval
 * can exceed 12s. Mutations and observations keep their existing deadline. */
export function dispatchWindowsReviewNative(
  request: Parameters<WindowsReviewNative>[0],
  execute: (
    options: Readonly<{ timeout: 12000 | 30000 }>,
    complete: (error: unknown, stdout: string, stderr: string) => void,
  ) => Pick<ChildProcess, "stdin">,
): Promise<unknown> {
  return dispatchWindowsReviewRequest(request, request.operation === "preflight" ? 30000 : 12000, execute)
}

function dispatchWindowsReviewRequest<Request>(
  request: Request,
  timeout: 12000 | 30000,
  execute: (
    options: Readonly<{ timeout: 12000 | 30000 }>,
    complete: (error: unknown, stdout: string, stderr: string) => void,
  ) => Pick<ChildProcess, "stdin">,
): Promise<unknown> {
  if (timeout !== 12000 && timeout !== 30000) throw Error("PROVIDER_REVIEW_WINDOWS_UNCONFIRMED")
  const payload = JSON.stringify(request)
  if (payload.length > 128 * 1024) throw Error("PROVIDER_REVIEW_WINDOWS_UNCONFIRMED")
  return new Promise((resolve, reject) => {
    const child = execute(Object.freeze({ timeout }), (error, stdout, stderr) => {
      try {
        resolve(windowsReviewNativeResult({ error, stdout, stderr }))
      } catch (error) {
        reject(error)
      }
    })
    child.stdin?.on("error", () => {})
    child.stdin?.end(payload)
  })
}

/** The executable path must observe close, not just execFile's callback: Bun
 * can invoke the callback from error/failed-kill handling before close. Keep
 * the existing operation deadline and add at most 500ms for close confirmation,
 * fitting inside the handoff controller's 13s drain for a 12s native operation.
 * An unconfirmed close permanently quarantines this owner, including after a
 * late close; it cannot start another helper to stop, restore or delete state. */
export function createWindowsReviewNativeTransport(
  execute: Parameters<typeof createWindowsReviewRequestTransport>[0],
  closeTimeoutMs = 500,
): WindowsReviewNative {
  return createWindowsReviewRequestTransport<Parameters<WindowsReviewNative>[0]>(
    execute,
    (request) => (request.operation === "preflight" ? 30000 : 12000),
    closeTimeoutMs,
  )
}

/** Internal fixed-script adapters may share process-close ownership without
 * widening the production native request union or accepting arbitrary code. */
export function createWindowsReviewRequestTransport<Request>(
  execute: (
    options: Readonly<{ timeout: 12000 | 30000 }>,
    complete: (error: unknown, stdout: string, stderr: string) => void,
  ) => Pick<ChildProcess, "stdin" | "stdout" | "stderr" | "once" | "unref">,
  timeoutForRequest: (request: Request) => 12000 | 30000,
  closeTimeoutMs = 500,
): (request: Request) => Promise<unknown> {
  if (!Number.isInteger(closeTimeoutMs) || closeTimeoutMs < 1 || closeTimeoutMs > 500)
    throw Error("PROVIDER_REVIEW_WINDOWS_UNCONFIRMED")
  let active = false
  let retained = false
  const unconfirmed = () =>
    browserObservationError("PROVIDER_REVIEW_WINDOWS_UNCONFIRMED", undefined, {
      browserPhase: "cleanup-quiescence",
      windowsNativeOutcome: "unknown",
      handoffQuiescence: "unconfirmed",
    })
  return async (request) => {
    if (active || retained) throw unconfirmed()
    active = true
    try {
      return await new Promise<unknown>((resolve, reject) => {
        let child: ReturnType<typeof execute> | undefined
        let closed = false
        let started = false
        let finished = false
        let result: { value: unknown } | { error: unknown } | undefined
        let timer: ReturnType<typeof setTimeout> | undefined
        let deadline = 0
        const finish = () => {
          if (finished || !closed || !result) return
          finished = true
          clearTimeout(timer)
          if ("error" in result)
            reject(
              browserObservationError("PROVIDER_REVIEW_WINDOWS_UNCONFIRMED", result.error, {
                browserPhase: "context",
              }),
            )
          else resolve(result.value)
        }
        const expire = () => {
          if (finished) return
          finished = true
          retained = !closed
          if (retained) {
            // Release controller handles only. No new signals, process lookup,
            // registry mutation or profile deletion is authorized here.
            for (const pipe of [child?.stdin, child?.stdout, child?.stderr]) {
              try {
                pipe?.destroy()
              } catch {}
            }
            try {
              child?.unref()
            } catch {}
          }
          reject(unconfirmed())
        }
        const settled = (value: NonNullable<typeof result>) => {
          if (finished) return
          result = value
          if (!started) {
            finished = true
            reject(windowsReviewNativeFailure("", "", "unknown"))
            return
          }
          if (closed) return finish()
          clearTimeout(timer)
          timer = setTimeout(expire, Math.max(1, Math.min(closeTimeoutMs, deadline - Date.now())))
        }
        let dispatched: Promise<unknown>
        try {
          dispatched = dispatchWindowsReviewRequest(request, timeoutForRequest(request), (options, complete) => {
            started = true
            deadline = Date.now() + options.timeout + closeTimeoutMs
            timer = setTimeout(expire, options.timeout + closeTimeoutMs)
            child = execute(options, complete)
            child.once("close", () => {
              if (finished) return
              closed = true
              finish()
            })
            return child
          })
        } catch (error) {
          settled({ error })
          return
        }
        dispatched.then(
          (value) => settled({ value }),
          (error) => settled({ error }),
        )
      })
    } finally {
      active = false
    }
  }
}

export function windowsReviewNative(env: NodeJS.ProcessEnv, root: string): WindowsReviewNative {
  if (process.platform !== "win32") throw Error("PROVIDER_REVIEW_WINDOWS_UNCONFIRMED")
  const environment = windowsReviewNativeEnvironment(env, root)
  const executable = win32.join(environment.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  const args = windowsReviewNativeArguments(executable)
  return createWindowsReviewNativeTransport((deadline, complete) =>
    execFile(
      executable,
      args,
      {
        cwd: root,
        env: environment,
        shell: false,
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: deadline.timeout,
      },
      complete,
    ),
  )
}

/** Isolated for inert hosted-Windows tests; no native read or absence default. */
export const windowsReviewIdentityReadScript = String.raw`
function Read-IdentityOrAbsent([scriptblock]$read,[scriptblock]$absent) {
  try { & $read } catch {
    $gone=& $absent
    if($gone -isnot [bool] -or !$gone){throw}
    return $null
  }
}
`

/** Microsoft documents MSFT_NetTCPConnection in root/StandardCimv2, with
 * State=2 for Listen and OwningProcess for its PID. A direct exact-port CIM
 * query returns zero instances normally; provider/query errors must terminate.
 * https://learn.microsoft.com/en-us/windows/win32/fwp/wmi/nettcpipprov/msft-nettcpconnection
 * Kept verbatim for the hosted inert cmdlet fixture; it never runs locally. */
export const windowsReviewListenerReadScript = String.raw`
$listening=@(Get-CimInstance MSFT_NetTCPConnection -Namespace root/StandardCimv2 -Filter "LocalPort=$([int]$request.port) AND State=2" -ErrorAction Stop | ForEach-Object {
if($_.LocalAddress -notin @('127.0.0.1','::1')){throw 'non-loopback'}
[int]$_.OwningProcess
})
`

/** The Shell substitutes only the quoted %1 token. Authored paths reject
 * percent/quote/control characters and trailing backslash before interpolation. */
export const windowsReviewLauncherCommandScript = String.raw`
function Launcher([string]$exe,[string]$profile){
foreach($p in @($exe,$profile)){if($p -notmatch '^[A-Za-z]:\\[^"%\r\n\x00]+[^\\"%\r\n\x00]$' -or [IO.Path]::GetFullPath($p) -cne $p){throw 'launcher-path'}}
'"'+$exe+'" "--user-data-dir='+$profile+'" -- "%1"'
}
`

/** A helper is trusted only at the signed browser's exact installed version.
 * Numeric FileVersionInfo parts avoid localized or suffixed display strings.
 * This runs once during preflight, never in a process-observation poll. */
export const windowsReviewIdentityHelperScript = String.raw`
function Read-EdgeVersion($item) {
  $v=$item.VersionInfo
  $parts=@($v.FileMajorPart,$v.FileMinorPart,$v.FileBuildPart,$v.FilePrivatePart)
  foreach($part in $parts){if($null -eq $part -or $part -isnot [int] -or $part -lt 0 -or $part -gt 65535){throw 'version'}}
  if($parts[0] -lt 1){throw 'version'}
  return ($parts -join '.')
}
function Require-PlainEdgeItem([string]$path,[bool]$directory) {
  $item=Get-Item -LiteralPath $path -Force -ErrorAction Stop
  if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.PSIsContainer -ne $directory -or $item.FullName -ine $path){throw 'reparse'}
  return $item
}
function Read-EdgeIdentityHelper([string]$exe) {
  Set-ReviewPhase 'helper-version'
  $main=Require-PlainEdgeItem $exe $false
  $version=Read-EdgeVersion $main
  $application=[IO.Path]::GetDirectoryName($exe)
  $ancestor=$application
  while($ancestor){$null=Require-PlainEdgeItem $ancestor $true;$ancestor=[IO.Path]::GetDirectoryName($ancestor)}
  $versionDirectory=[IO.Path]::Combine($application,$version)
  $path=[IO.Path]::Combine($versionDirectory,'identity_helper.exe')
  try {$helper=Get-Item -LiteralPath $path -Force -ErrorAction Stop} catch {
    if($_.CategoryInfo.Category -ne [System.Management.Automation.ErrorCategory]::ObjectNotFound){throw}
    return @{edgeVersion=$version;identityHelper=$null}
  }
  $null=Require-PlainEdgeItem $versionDirectory $true
  $helper=Require-PlainEdgeItem $path $false
  if((Read-EdgeVersion $helper) -cne $version){throw 'version'}
  Set-ReviewPhase 'helper-signature'
  $signature=Get-AuthenticodeSignature -LiteralPath $path
  if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(^|,\s*)CN=Microsoft Corporation(,|$)'){throw 'signature'}
  return @{edgeVersion=$version;identityHelper=@{executable=$path;version=$version}}
}
`

// ASSOCF_IS_PROTOCOL=0x1000 maps the current user default; never FIXED_PROGID.
// The five-key HKCU Classes snapshot is restored only after exact comparison;
// only newly created empty keys are removed. UserChoice and its Hash are read-only.
// https://learn.microsoft.com/en-us/windows/win32/sysinfo/hkey-classes-root-key
// https://learn.microsoft.com/en-us/windows/win32/api/shlwapi/ne-shlwapi-assocstr
// https://learn.microsoft.com/en-us/windows/win32/api/shlobj_core/nf-shlobj_core-shchangenotify
// Process discovery enumerates ambient PID/parent/name only, retaining previously
// observed descendants as roots even after their parents exit. Full identity is
// read only for selected processes. A failed read reconciles one fresh exact-PID
// absence; identity comparisons remain outside that catch. Restoration requires
// every observed PID to be absent, including unknown descendants and reused PIDs.
// Reassert the OS-only module path before first-use discovery: Windows
// PowerShell can insert AllUsers paths at startup.
export const windowsReviewNativeScript = String.raw`
$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
function Set-ReviewPhase([string]$phase) {
  $script:reviewPhase = $phase
  [Console]::Error.WriteLine('PHYSICALSYSTEMS_WINDOWS_BROWSER_PHASE_'+$phase)
  [Console]::Error.Flush()
}
Set-ReviewPhase 'bootstrap'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
trap { [Console]::Out.WriteLine('PHYSICALSYSTEMS_WINDOWS_BROWSER_PHASE_'+$script:reviewPhase); [Console]::Error.Write('PROVIDER_REVIEW_WINDOWS_UNCONFIRMED'); exit 1 }
$env:PSModulePath = [IO.Path]::Combine($PSHOME,'Modules')
Set-ReviewPhase 'input-read'
$inputText = [Console]::In.ReadToEnd()
Set-ReviewPhase 'input-parse'
$request = $inputText | ConvertFrom-Json
$paths=@('Software\Classes','Software\Classes\MSEdgeHTM','Software\Classes\MSEdgeHTM\shell','Software\Classes\MSEdgeHTM\shell\open','Software\Classes\MSEdgeHTM\shell\open\command')
$edgePolicy='Software\Policies\Microsoft\Edge'
Set-ReviewPhase 'registry-open'
$base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry64)
$machine = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
$classes=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::ClassesRoot,[Microsoft.Win32.RegistryView]::Registry64)
Set-ReviewPhase 'caller-identity'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
Set-ReviewPhase 'add-type'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ReviewNative {
[DllImport("shlwapi.dll", CharSet=CharSet.Unicode)] static extern uint AssocQueryString(uint flags, uint str, string assoc, string extra, StringBuilder output, ref uint size);
[DllImport("shell32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CommandLineToArgvW(string command, out int count);
[DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
[DllImport("shell32.dll")] public static extern void SHChangeNotify(int eventId,uint flags,IntPtr a,IntPtr b);
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
Set-ReviewPhase 'policy-read'
$keys = @($paths | ForEach-Object { $key=$base.OpenSubKey($_); $present=$null -ne $key; if($key){$key.Dispose()}; $present })
$key=$base.OpenSubKey($paths[-1]); $value=$null
try {
  if($key -and $key.GetValueNames() -contains '') {
    $kind=$key.GetValueKind('').ToString()
    if($kind -notin @('String','ExpandString')) { throw 'invalid' }
    $data=$key.GetValue('',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if($data -isnot [string] -or $data.Length -gt 32768) { throw 'invalid' }
    $value=@{kind=$kind;data=$data}
  }
} finally { if($key){$key.Dispose()} }
@{keys=$keys;value=$value}
}
function Debug-Policy($h,$n,$a){
$k=$h.OpenSubKey($edgePolicy);try{
if(!$k -or $k.GetValueNames() -notcontains $n){return 'absent'}
if($k.GetValueKind($n) -ne 'DWord'){return 'invalid'}
$x=$k.GetValue($n);if($x -lt 0 -or $x -ge $a.Count){return 'invalid'}
return $a[$x]
}finally{if($k){$k.Dispose()}}}
function Same-Value($a,$b) {
  if($null -eq $a -or $null -eq $b) { return $null -eq $a -and $null -eq $b }
  return $a.kind -ceq $b.kind -and $a.data -ceq $b.data
}
function Require-NoMachineOverride {
  Set-ReviewPhase 'machine-policy'
  foreach($hive in @($machine,$base)) {
    $key=$hive.OpenSubKey($edgePolicy)
    try {
      if($key -and $key.GetValueNames() -contains 'UserDataDir') {throw 'profile-policy'}
    } finally {if($key){$key.Dispose()}}
  }
}
function Require-DirectVerb {
  foreach($path in @('MSEdgeHTM\shell\open','MSEdgeHTM\shell\open\command')) {
    $key=$classes.OpenSubKey($path)
    try {
      if(!$key -or $key.GetValueNames() -contains 'DelegateExecute' -or
        $key.GetSubKeyNames() -contains 'ddeexec' -or $key.GetSubKeyNames() -contains 'DropTarget') {throw 'activation'}
    } finally {if($key){$key.Dispose()}}
  }
}
${windowsReviewLauncherCommandScript}
${windowsReviewIdentityHelperScript}
function Association {
  Set-ReviewPhase 'association-progid'
  Require-DirectVerb
  if($request.scheme -notin @('http','https')) {throw 'scheme'}
  if([ReviewNative]::Association(20,[string]$request.scheme) -cne 'MSEdgeHTM') { throw 'association' }
  Set-ReviewPhase 'association-executable'
  $exe=[IO.Path]::GetFullPath([ReviewNative]::Association(2,[string]$request.scheme))
  $allowed=@($env:ProgramFiles,[Environment]::GetEnvironmentVariable('ProgramFiles(x86)'),$env:ProgramW6432) | Where-Object {$_} | ForEach-Object {[IO.Path]::Combine($_,'Microsoft\Edge\Application\msedge.exe')}
  if($allowed -inotcontains $exe -or ($request.operation -ne 'preflight' -and (!$request.executable -or $exe -ine $request.executable))) {throw 'executable'}
  return $exe
}
function Processes {
  Set-ReviewPhase 'process-tree'
  $tree=@(Get-CimInstance -Query 'SELECT ProcessId,ParentProcessId,Name FROM Win32_Process')
  if($tree.Count -gt 32768){throw 'excessive'}
  $selected=[Collections.Generic.HashSet[int]]::new()
  if($request.rootPid) {$null=$selected.Add([int]$request.rootPid)}
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
    Set-ReviewPhase 'process-identity'
    $identity=Read-ProcessIdentity $_
    if($identity) {try {
      if([Math]::Abs(($identity.nativeBirth-$identity.birth)) -ge 10) {throw 'identity'}
      @{pid=[int]$_.ProcessId;parent=[int]$_.ParentProcessId;birth=$identity.birth.ToString();session=[int]$_.SessionId;sid=$identity.owner.Sid;executable=$_.ExecutablePath;args=@([ReviewNative]::Arguments($_.CommandLine))}
    } finally {$identity.process.Dispose()}}
  })
}
${windowsReviewIdentityReadScript}
function Read-ProcessIdentity($native) {
  $pidValue=[int]$native.ProcessId
  if($pidValue -lt 1){throw 'identity'}
  Read-IdentityOrAbsent {
    $process=$null
    try {
      $owner=Invoke-CimMethod -InputObject $native -MethodName GetOwnerSid
      if($owner.ReturnValue -ne 0 -or !$owner.Sid -or !$native.ExecutablePath -or !$native.CommandLine -or !$native.CreationDate -or $null -eq $native.SessionId){throw 'identity'}
      $process=[Diagnostics.Process]::GetProcessById($pidValue)
      $null=$process.Handle
      $birth=$process.StartTime.ToUniversalTime().ToFileTimeUtc()
      $nativeBirth=$native.CreationDate.ToUniversalTime().ToFileTimeUtc()
      @{process=$process;owner=$owner;birth=$birth;nativeBirth=$nativeBirth}
    } catch {if($process){$process.Dispose()};throw}
  } {
    @(Get-CimInstance -Query "SELECT ProcessId FROM Win32_Process WHERE ProcessId=$pidValue" -ErrorAction Stop).Count -eq 0
  }
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
  Set-ReviewPhase 'ambient-browser'
  if(@(Get-CimInstance -Query "SELECT ProcessId FROM Win32_Process WHERE Name='msedge.exe' OR Name='msedge_crashpad_handler.exe'").Count -ne 0) {throw 'ambient-browser'}
}
switch($request.operation) {
'preflight' {
Require-NoMachineOverride
Require-NoEdge
$exe=Association
Set-ReviewPhase 'signature'
$signature=Get-AuthenticodeSignature -LiteralPath $exe
if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(^|,\s*)CN=Microsoft Corporation(,|$)') { throw 'signature' }
$helper=Read-EdgeIdentityHelper $exe
Set-ReviewPhase 'debug-policy'
$rules=@{RemoteDebuggingAllowed=@('deny','allow');DeveloperToolsAvailability=@('restricted','allow','deny')}
$debug=@{};foreach($h in @('machine','base')){foreach($n in $rules.Keys){$debug[$h+$n]=Debug-Policy (Get-Variable $h -ValueOnly) $n $rules[$n]}}
$result=@{executable=$exe;edgeVersion=$helper.edgeVersion;identityHelper=$helper.identityHelper;sid=$sid;policy=(Read-Policy);processes=@();debugPolicy=$debug;resolvedCommand=[ReviewNative]::Association(1,[string]$request.scheme)}
}
  'set' {
    Require-NoMachineOverride
    Require-NoEdge
    $null=Association
    $command=Launcher $request.executable $request.profile
    if([ReviewNative]::Association(1,[string]$request.scheme) -cne $request.beforeCommand){throw 'changed'}
    $current=Read-Policy
    Set-ReviewPhase 'policy-compare'
    if(!(Same-Value $current.value $request.before.value) -or (($current.keys | ConvertTo-Json -Compress) -cne ($request.before.keys | ConvertTo-Json -Compress))) { throw 'changed' }
    Set-ReviewPhase 'policy-write'
    $key=$base.CreateSubKey($paths[-1]); try {$key.SetValue('',$command,[Microsoft.Win32.RegistryValueKind]::String)} finally {$key.Dispose()}
    [ReviewNative]::SHChangeNotify(0x08000000,0,[IntPtr]::Zero,[IntPtr]::Zero)
    $null=Association
    if(!(Same-Value (Read-Policy).value @{kind='String';data=$command}) -or [ReviewNative]::Association(1,[string]$request.scheme) -cne $command){throw 'unconfirmed'}
    $result=@{written=$true}
  }
  'restore' {
    Require-NoEdge
    Require-NoMachineOverride
    $null=Association
    $command=Launcher $request.executable $request.profile
    $effective=[ReviewNative]::Association(1,[string]$request.scheme)
    if($effective -cne $command -and $effective -cne $request.beforeCommand){throw 'changed'}
    Set-ReviewPhase 'retained-input'
    $retainedPids=@(Observed-Pids)
    foreach($pidValue in $retainedPids) {
      Set-ReviewPhase 'retained-query'
      if(Get-CimInstance -Query "SELECT ProcessId FROM Win32_Process WHERE ProcessId=$pidValue" -ErrorAction Stop){
        if($pidValue -eq $PID){Set-ReviewPhase 'retained-self'}else{Set-ReviewPhase 'retained-other'}
        throw 'observed-process-alive'
      }
    }
    $current=Read-Policy
    Set-ReviewPhase 'policy-compare'
    if(!(Same-Value $current.value @{kind='String';data=$command}) -and !(Same-Value $current.value $request.before.value)) { throw 'changed' }
    Set-ReviewPhase 'policy-restore'
    $key=$base.OpenSubKey($paths[-1],$true)
    if($key) { try {
      if($null -eq $request.before.value) {$key.DeleteValue('',$false)}
      else {$key.SetValue('',[string]$request.before.value.data,[Enum]::Parse([Microsoft.Win32.RegistryValueKind],[string]$request.before.value.kind))}
    } finally {$key.Dispose()} }
    Set-ReviewPhase 'policy-keys'
    for($index=$paths.Count-1;$index -ge 0;$index--) {
      if($request.before.keys[$index]) {continue}
      $key=$base.OpenSubKey($paths[$index]); if(!$key){continue}
      $empty=$key.SubKeyCount -eq 0 -and $key.ValueCount -eq 0; $key.Dispose()
      if(!$empty){throw 'concurrent-policy'}
      $base.DeleteSubKey($paths[$index],$false)
    }
    [ReviewNative]::SHChangeNotify(0x08000000,0,[IntPtr]::Zero,[IntPtr]::Zero)
    $null=Association
    if([ReviewNative]::Association(1,[string]$request.scheme) -cne $request.beforeCommand){throw 'restore-unconfirmed'}
    $after=Read-Policy
    Set-ReviewPhase 'policy-readback'
    if(!(Same-Value $after.value $request.before.value) -or (($after.keys | ConvertTo-Json -Compress) -cne ($request.before.keys | ConvertTo-Json -Compress))) {throw 'restore-unconfirmed'}
    $result=@{restored=$true}
  }
'observe' {
  Require-NoMachineOverride
  $null=Association
  $command=Launcher $request.executable $request.profile
  $listening=@()
  if($request.port) {
    Set-ReviewPhase 'listener'
${windowsReviewListenerReadScript}
  }
  $result=@{processes=@(Processes);listening=$listening;policyOwned=((Same-Value (Read-Policy).value @{kind='String';data=$command}) -and [ReviewNative]::Association(1,[string]$request.scheme) -ceq $command)}
}
  'stop' {
    if(@($request.processes).Count -gt 256){throw 'excessive'}
    foreach($expected in $request.processes) {
      Set-ReviewPhase 'process-identity'
      $native=Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$expected.pid)"
      if(!$native){continue}
      $identity=Read-ProcessIdentity $native
      if(!$identity){continue}
      $process=$identity.process
      try {
        if($identity.birth.ToString() -cne $expected.birth -or
          [Math]::Abs(($identity.nativeBirth-[long]$expected.birth)) -ge 10 -or
          $native.ExecutablePath -ine $expected.executable -or $native.SessionId -ne $expected.session -or
          $identity.owner.Sid -cne $expected.sid -or $identity.owner.Sid -cne $sid) {throw 'identity-changed'}
        Set-ReviewPhase 'process-signal'
        $process.Kill()
        Set-ReviewPhase 'process-wait'
        if(!$process.WaitForExit(5000)){throw 'retained'}
      } finally {$process.Dispose()}
    }
    $result=@{stopped=$true}
  }
  default {throw 'operation'}
}
Set-ReviewPhase 'output'
[Console]::Out.Write(($result | ConvertTo-Json -Depth 12 -Compress))
`
