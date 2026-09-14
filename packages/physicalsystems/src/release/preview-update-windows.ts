// SPDX-License-Identifier: Apache-2.0
import { execFile } from "node:child_process"
import { lstat, readFile, realpath } from "node:fs/promises"
import { win32 } from "node:path"
import { requireDisposablePublicRunner } from "./public-qualification"
import { verifyWindowsVersionInfo } from "./qualification"
import {
  createWindowsReviewRequestTransport,
  windowsReviewNativeEnvironment,
  windowsReviewScriptBootstrap,
} from "./windows-review-native"
import { windowsAppShutdownNative, windowsAppShutdownSnapshot } from "./windows-app-shutdown-native"
import { readBrowserObservation } from "./browser-observation"

export type PreviewUpdateWindowsApplication = {
  pid: number
  /** UTC .NET ticks, matching Win32_Process.CreationDate, not a JS timestamp. */
  creationTime: string
  executable: string
  version: string
  ownerSid: string
  sessionId: number
  windowHandle: string
}
type Observe = { executable: string; version: string; after: string; previousPid?: number }
type Confirm = {
  application: PreviewUpdateWindowsApplication
  version: string
  action: "Later" | "Install update"
}
type Request =
  | (Observe & { operation: "observe" })
  | (Confirm & { operation: "confirm" })
  | { operation: "close" | "exited"; application: PreviewUpdateWindowsApplication }
type Reply =
  | { status: "waiting" }
  | { status: "observed"; application: PreviewUpdateWindowsApplication }
  | { status: "invoked"; action: Confirm["action"] }
  | { status: "close-requested" }
  | { status: "exited" | "running" }

const failure = () => Error("PREVIEW_UPDATE_WINDOWS_UNCONFIRMED")
const nativePhases = [
  "input",
  "context",
  "type",
  "process",
  "version",
  "window",
  "dialog",
  "dialog-assemblies",
  "dialog-window-query",
  "dialog-window-match",
  "dialog-identity",
  "dialog-controls",
  "dialog-message",
  "dialog-buttons",
  "dialog-button-state",
  "dialog-pattern",
  "dialog-native-buttons",
  "dialog-owner-recheck",
  "invoke",
  "close",
  "exit",
  "output",
  "transport",
]
const transportOutcomes = ["timeout", "signal", "exit", "start", "output-limit", "invalid-json", "unknown"] as const
const countFields = [
  "ownedWindows",
  "matchingDialogs",
  "controls",
  "messageMatches",
  "messageTexts",
  "installButtons",
  "laterButtons",
] as const
const booleanFields = [
  "dialogOwned",
  "dialogEnabled",
  "dialogOffscreen",
  "buttonOwned",
  "buttonEnabled",
  "buttonOffscreen",
  "invokePattern",
  "dialogHandleOwned",
  "nativeCommandLinks",
  "nativeInstallFound",
  "nativeInstallOwned",
  "nativeInstallChild",
  "nativeInstallClass",
  "nativeInstallStyle",
  "nativeInstallText",
  "nativeInstallEnabled",
  "nativeInstallVisible",
  "nativeLaterFound",
  "nativeLaterOwned",
  "nativeLaterChild",
  "nativeLaterClass",
  "nativeLaterStyle",
  "nativeLaterText",
  "nativeLaterEnabled",
  "nativeLaterVisible",
] as const
type NativeObservation = {
  phase: string
  transportOutcome?: (typeof transportOutcomes)[number]
  helperQuiescence?: "settled" | "unconfirmed"
} & Partial<Record<(typeof countFields)[number], number>> &
  Partial<Record<(typeof booleanFields)[number], boolean>>
function nativeObservation(phase: unknown, counts: unknown): Readonly<NativeObservation> {
  const result: NativeObservation = {
    phase: typeof phase === "string" && nativePhases.includes(phase) ? phase : "unknown",
  }
  if (object(counts)) {
    for (const field of countFields) {
      const value = counts[field]
      if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 257) result[field] = value
    }
    for (const field of booleanFields) if (typeof counts[field] === "boolean") result[field] = counts[field]
    if (transportOutcomes.includes(counts.transportOutcome as (typeof transportOutcomes)[number]))
      result.transportOutcome = counts.transportOutcome as (typeof transportOutcomes)[number]
    if (counts.helperQuiescence === "settled" || counts.helperQuiescence === "unconfirmed")
      result.helperQuiescence = counts.helperQuiescence
  }
  return Object.freeze(result)
}

/** Only authored phase/outcome IDs and bounded counts/booleans may enter CI receipts. */
export function readPreviewUpdateWindowsObservation(error: unknown) {
  try {
    if (object(error) && object(error.previewUpdateWindowsObservation))
      return nativeObservation(error.previewUpdateWindowsObservation.phase, error.previewUpdateWindowsObservation)
    const transport = readBrowserObservation(error)
    if (!transport?.windowsNativeOutcome && !transport?.handoffQuiescence) return
    return nativeObservation("transport", {
      transportOutcome: transport.windowsNativeOutcome,
      helperQuiescence: transport.handoffQuiescence,
    })
  } catch {
    return
  }
}
const pid = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 0xffffffff
const ticks = (value: unknown): value is string =>
  typeof value === "string" && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 3155378975999999999n
const version = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 80 &&
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.[1-9]\d*$/.test(value) &&
  value
    .split(/[.\-]/)
    .filter((part) => part !== "beta")
    .every((part) => Number.isSafeInteger(Number(part)))
const executable = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 2048 &&
  /^[A-Za-z]:\\[^\r\n\0"<>|?*:]+$/.test(value) &&
  win32.normalize(value) === value &&
  win32.basename(value) === "Physical Systems.exe" &&
  value.split("\\").every((part) => !/[. ]$/.test(part))
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)
const keys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key))

function application(value: unknown): PreviewUpdateWindowsApplication {
  if (
    !object(value) ||
    !keys(value, ["pid", "creationTime", "executable", "version", "ownerSid", "sessionId", "windowHandle"]) ||
    !pid(value.pid) ||
    !ticks(value.creationTime) ||
    !executable(value.executable) ||
    !version(value.version) ||
    typeof value.ownerSid !== "string" ||
    !/^S-1-5-21-\d{1,10}-\d{1,10}-\d{1,10}-\d{1,10}$/.test(value.ownerSid) ||
    typeof value.sessionId !== "number" ||
    !Number.isInteger(value.sessionId) ||
    value.sessionId < 1 ||
    value.sessionId > 0xffffffff ||
    typeof value.windowHandle !== "string" ||
    !/^[1-9]\d{0,18}$/.test(value.windowHandle) ||
    BigInt(value.windowHandle) > 9223372036854775807n
  )
    throw failure()
  return {
    pid: value.pid,
    creationTime: value.creationTime,
    executable: value.executable,
    version: value.version,
    ownerSid: value.ownerSid,
    sessionId: value.sessionId,
    windowHandle: value.windowHandle,
  }
}

function validated(input: Request): Request {
  if (!object(input)) throw failure()
  if (input.operation === "observe") {
    if (
      !keys(input, ["operation", "executable", "version", "after", "previousPid"]) ||
      !executable(input.executable) ||
      !version(input.version) ||
      !ticks(input.after) ||
      (input.previousPid !== undefined && !pid(input.previousPid))
    )
      throw failure()
    return { ...input }
  }
  if (input.operation === "confirm") {
    if (
      !keys(input, ["operation", "application", "version", "action"]) ||
      !version(input.version) ||
      !["Later", "Install update"].includes(input.action)
    )
      throw failure()
    return { ...input, application: application(input.application) }
  }
  if (!["close", "exited"].includes(input.operation) || !keys(input, ["operation", "application"])) throw failure()
  return { ...input, application: application(input.application) }
}

/** Used before launch/handoff; observed creation times come from native CIM. */
export function previewUpdateWindowsTime() {
  return (BigInt(Date.now()) * 10000n + 621355968000000000n).toString()
}

/** Electron 42's command links can be nested below DirectUI/notification sinks,
 * with native HWND IDs unrelated to TaskDialog's logical IDs 100/101. Select only
 * the two fixed labels in this owned window's bounded descendant tree; the
 * managed legacy Button proxy does not consistently expose these controls.
 * BM_CLICK targets the actual verified control, never a guessed dialog result.
 */
export const previewUpdateWindowsCommandLinks = String.raw`
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;
public static class PreviewUpdateCommandLink {
  delegate bool EnumChild(IntPtr window, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumChild callback, IntPtr data);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern bool IsChild(IntPtr parent, IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint id);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder name, int count);
  [DllImport("user32.dll", EntryPoint="GetWindowLongW")] static extern int GetStyle(IntPtr h, int index);
  [DllImport("user32.dll", EntryPoint="SendMessageTimeoutW", CharSet=CharSet.Unicode)] static extern IntPtr ReadText(IntPtr h, uint message, IntPtr count, StringBuilder text, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll", SetLastError=true)] static extern bool PostMessage(IntPtr h, uint message, IntPtr w, IntPtr l);
  public sealed class Facts {
    public IntPtr Handle;
    public bool Found, Owned, Child, ClassMatches, StyleMatches, TextMatches, Enabled, Visible;
    public bool Ready { get {return Found && Owned && Child && ClassMatches && StyleMatches && TextMatches && Enabled && Visible;} }
  }
  static Facts ReadControl(IntPtr dialog, IntPtr control, uint pid, int id) {
    var result=new Facts(); uint dialogPid=0, buttonPid=0;
    GetWindowThreadProcessId(dialog,out dialogPid);
    if(dialogPid!=pid) return result;
    result.Handle=control; result.Found=control!=IntPtr.Zero;
    if(!result.Found) return result;
    GetWindowThreadProcessId(result.Handle,out buttonPid);
    result.Owned=buttonPid==pid;
    result.Child=IsChild(dialog,result.Handle) && GetAncestor(result.Handle,2)==dialog;
    if(!result.Owned || !result.Child) return result;
    var name=new StringBuilder(128); int length=GetClassName(result.Handle,name,name.Capacity);
    result.ClassMatches=length>0 && length<127 && String.Equals(name.ToString(),"Button",StringComparison.OrdinalIgnoreCase);
    int style=GetStyle(result.Handle,-16) & 15;
    result.StyleMatches=style==14 || style==15;
    if(!result.ClassMatches || !result.StyleMatches) return result;
    var text=new StringBuilder(128); UIntPtr read;
    if(ReadText(result.Handle,0x000D,new IntPtr(text.Capacity),text,2,500,out read)!=IntPtr.Zero && read.ToUInt64()<127)
      result.TextMatches=String.Equals(text.ToString(),id==100?"Install update":"Later",StringComparison.Ordinal);
    result.Enabled=IsWindowEnabled(dialog) && IsWindowEnabled(result.Handle);
    result.Visible=IsWindowVisible(dialog) && IsWindowVisible(result.Handle);
    return result;
  }
  public static Facts Read(IntPtr dialog, uint pid, int id) {
    if(dialog==IntPtr.Zero || pid==0 || (id!=100 && id!=101)) throw new InvalidOperationException();
    uint dialogPid; GetWindowThreadProcessId(dialog,out dialogPid);
    if(dialogPid!=pid) return new Facts();
    var children=new List<IntPtr>(); bool bounded=true;
    EnumChildWindows(dialog,delegate(IntPtr child, IntPtr data) {
      if(children.Count>=64) {bounded=false;return false;}
      children.Add(child); return true;
    },IntPtr.Zero);
    if(!bounded) throw new InvalidOperationException();
    var result=new Facts(); int matches=0;
    foreach(var child in children) {
      var candidate=ReadControl(dialog,child,pid,id);
      if(!candidate.TextMatches) continue;
      if(++matches>1) throw new InvalidOperationException();
      result=candidate;
    }
    return result;
  }
  public static void Click(IntPtr dialog, uint pid, int id, IntPtr expected) {
    var current=Read(dialog,pid,id);
    if(!current.Ready || current.Handle!=expected || !ReadControl(dialog,expected,pid,id).Ready ||
       !PostMessage(expected,0x00F5,IntPtr.Zero,IntPtr.Zero))
      throw new InvalidOperationException();
  }
}
`

/** Fixed native code is also exposed for an inert hosted Windows syntax fixture.
 * It does not enumerate command lines or accept script text from the caller. */
export const previewUpdateWindowsScript = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules')
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$script:phase='input'
$script:diagnostics=@{}
trap {[Console]::Out.Write((ConvertTo-Json -InputObject @{status='unreadable';phase=$script:phase;diagnostics=$script:diagnostics} -Compress -Depth 4));exit 0}
$raw=[Console]::In.ReadLine()
if(!$raw -or $raw.Length -gt 8192){throw 'input'}
$request=ConvertFrom-Json -InputObject $raw
$script:phase='context'
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$session=[Diagnostics.Process]::GetCurrentProcess().SessionId
if($sid -notmatch '^S-1-5-21-\d+-\d+-\d+-\d+$' -or $session -lt 1){throw 'context'}
$script:phase='type'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PreviewUpdateWindow {
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint id);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
}
'@
function Same-Path([string]$left,[string]$right){[string]::Equals($left,$right,[StringComparison]::OrdinalIgnoreCase)}
function Read-Row([uint32]$id){
  $script:phase='process'
  $rows=@(Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = '+$id.ToString([Globalization.CultureInfo]::InvariantCulture)) -Property ProcessId,CreationDate,ExecutablePath,SessionId -ErrorAction Stop)
  if($rows.Count -gt 1){throw 'ambiguous'}
  if($rows.Count -eq 0){return $null}
  return $rows[0]
}
function Birth($row){
  if($null -eq $row.CreationDate){throw 'identity'}
  return $row.CreationDate.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
}
function Read-App($row,[string]$path,[string]$version){
  $script:phase='process'
  if(!$row -or !(Same-Path $row.ExecutablePath $path) -or $row.SessionId -ne $session){throw 'identity'}
  # Renderer/utility processes share this executable but have no main window.
  # Discard them before the repeated CIM owner and package-version queries.
  $script:phase='window'
  $process=[Diagnostics.Process]::GetProcessById([int]$row.ProcessId)
  try {$process.Refresh();$handle=$process.MainWindowHandle}finally{$process.Dispose()}
  if($handle -eq [IntPtr]::Zero -or ![PreviewUpdateWindow]::IsWindowVisible($handle)){return $null}
  [uint32]$windowPid=0
  $null=[PreviewUpdateWindow]::GetWindowThreadProcessId($handle,[ref]$windowPid)
  if($windowPid -ne $row.ProcessId){throw 'window'}
  $script:phase='process'
  $owner=Invoke-CimMethod -InputObject $row -MethodName GetOwnerSid -ErrorAction Stop
  if($owner.ReturnValue -ne 0 -or $owner.Sid -cne $sid){throw 'owner'}
  $birth=Birth $row
  $script:phase='version'
  $file=Get-Item -LiteralPath $path -Force -ErrorAction Stop
  if($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'file'}
  $info=[Diagnostics.FileVersionInfo]::GetVersionInfo($path)
  if($info.ProductName -cne 'Physical Systems' -or $info.FileVersion -cne $version -or $info.ProductVersion -cne (($version -split '-')[0]+'.0')){throw 'version'}
  $again=Read-Row $row.ProcessId
  if(!$again -or (Birth $again) -cne $birth -or !(Same-Path $again.ExecutablePath $path) -or $again.SessionId -ne $session){throw 'changed'}
  $script:phase='window'
  $null=[PreviewUpdateWindow]::GetWindowThreadProcessId($handle,[ref]$windowPid)
  if($windowPid -ne $row.ProcessId -or ![PreviewUpdateWindow]::IsWindowVisible($handle)){throw 'changed'}
  return @{pid=[long]$row.ProcessId;creationTime=$birth;executable=$path;version=$version;ownerSid=$sid;sessionId=$session;windowHandle=$handle.ToInt64().ToString([Globalization.CultureInfo]::InvariantCulture);versionInfo=@{ProductName=$info.ProductName;FileVersion=$info.FileVersion;ProductVersion=$info.ProductVersion}}
}
function Require-App($expected){
  $row=Read-Row $expected.pid
  if(!$row -or (Birth $row) -cne $expected.creationTime){throw 'changed'}
  $actual=Read-App $row $expected.executable $expected.version
  if(!$actual -or $actual.ownerSid -cne $expected.ownerSid -or $actual.sessionId -ne $expected.sessionId){throw 'changed'}
  # An unparented native modal can become Process.MainWindowHandle. Retain the
  # originally observed app window and verify its owner instead of substituting
  # whichever window currently has foreground ordering.
  $handle=[IntPtr]([long]$expected.windowHandle)
  [uint32]$windowPid=0
  $null=[PreviewUpdateWindow]::GetWindowThreadProcessId($handle,[ref]$windowPid)
  if($windowPid -ne $expected.pid -or ![PreviewUpdateWindow]::IsWindowVisible($handle)){throw 'window'}
  $actual.windowHandle=$expected.windowHandle
  return $actual
}
function Observe-App($requestValue){
  $script:phase='process'
  $rows=@(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'Physical Systems.exe'" -Property ProcessId,CreationDate,ExecutablePath,SessionId -ErrorAction Stop)
  if($rows.Count -gt 128){throw 'bounds'}
  $found=@()
  foreach($row in $rows){
    if($row.ProcessId -eq $requestValue.previousPid -or $row.SessionId -ne $session -or !(Same-Path $row.ExecutablePath $requestValue.executable)){continue}
    if([long](Birth $row) -le [long]$requestValue.after){continue}
    $app=Read-App $row $requestValue.executable $requestValue.version
    if($app){$found+=,$app}
  }
  if($found.Count -gt 1){throw 'ambiguous'}
  if($found.Count -eq 0){return @{status='waiting'}}
  $info=$found[0].versionInfo
  $found[0].Remove('versionInfo')
  return @{status='observed';application=$found[0];versionInfo=$info}
}
function Confirm-App($requestValue){
  $null=Require-App $requestValue.application
  $script:phase='dialog-assemblies'
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $script:phase='dialog-window-query'
  $condition=[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty,[int]$requestValue.application.pid)
  $windows=[Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children,$condition)
  $script:diagnostics.ownedWindows=[Math]::Min(257,$windows.Count)
  if($windows.Count -gt 16){throw 'bounds'}
  $script:phase='dialog-window-match'
  $dialogs=@($windows | Where-Object {$_.Current.Name -ceq 'Update Ready'})
  $script:diagnostics.matchingDialogs=[Math]::Min(257,$dialogs.Count)
  if($dialogs.Count -eq 0){return @{status='waiting'}}
  if($dialogs.Count -ne 1){throw 'ambiguous'}
  $dialog=$dialogs[0]
  $script:phase='dialog-identity'
  $script:diagnostics.dialogOwned=$dialog.Current.ProcessId -eq $requestValue.application.pid
  $script:diagnostics.dialogEnabled=$dialog.Current.IsEnabled
  $script:diagnostics.dialogOffscreen=$dialog.Current.IsOffscreen
  if(!$script:diagnostics.dialogOwned -or !$script:diagnostics.dialogEnabled -or $script:diagnostics.dialogOffscreen){throw 'dialog'}
  $script:phase='dialog-controls'
  $controls=$dialog.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)
  $script:diagnostics.controls=[Math]::Min(257,$controls.Count)
  if($controls.Count -gt 128){throw 'bounds'}
  $script:phase='dialog-message'
  $messageMatches=@($controls | Where-Object {$_.Current.Name -ceq ('Install Physical Systems '+$requestValue.version+'?')})
  $script:diagnostics.messageMatches=[Math]::Min(257,$messageMatches.Count)
  $message=@($messageMatches | Where-Object {$_.Current.ControlType -eq [Windows.Automation.ControlType]::Text})
  $script:diagnostics.messageTexts=[Math]::Min(257,$message.Count)
  $script:phase='dialog-buttons'
  $install=@($controls | Where-Object {$_.Current.ControlType -eq [Windows.Automation.ControlType]::Button -and $_.Current.Name -ceq 'Install update'})
  $later=@($controls | Where-Object {$_.Current.ControlType -eq [Windows.Automation.ControlType]::Button -and $_.Current.Name -ceq 'Later'})
  $script:diagnostics.installButtons=[Math]::Min(257,$install.Count)
  $script:diagnostics.laterButtons=[Math]::Min(257,$later.Count)
  if($message.Count -ne 1){throw 'dialog'}
  $native=$install.Count -eq 0 -and $later.Count -eq 0
  $script:diagnostics.nativeCommandLinks=$native
  if($native){
    $script:phase='dialog-native-buttons'
    Add-Type -TypeDefinition @'
${previewUpdateWindowsCommandLinks}
'@
    $dialogHandle=[IntPtr]$dialog.Current.NativeWindowHandle
    $nativeInstall=[PreviewUpdateCommandLink]::Read($dialogHandle,[uint32]$requestValue.application.pid,100)
    $nativeLater=[PreviewUpdateCommandLink]::Read($dialogHandle,[uint32]$requestValue.application.pid,101)
    foreach($entry in @(@{name='nativeInstall';value=$nativeInstall},@{name='nativeLater';value=$nativeLater})){
      foreach($field in @('Found','Owned','Child','Enabled','Visible')){$script:diagnostics[$entry.name+$field]=$entry.value.$field}
      $script:diagnostics[$entry.name+'Class']=$entry.value.ClassMatches
      $script:diagnostics[$entry.name+'Style']=$entry.value.StyleMatches
      $script:diagnostics[$entry.name+'Text']=$entry.value.TextMatches
    }
    if(!$nativeInstall.Ready -or !$nativeLater.Ready){throw 'command-link'}
    if($requestValue.action -ceq 'Later'){$nativeButton=$nativeLater;$nativeId=101}elseif($requestValue.action -ceq 'Install update'){$nativeButton=$nativeInstall;$nativeId=100}else{throw 'action'}
  } else {
    if($install.Count -ne 1 -or $later.Count -ne 1){throw 'dialog'}
    if($requestValue.action -ceq 'Later'){$button=$later[0]}elseif($requestValue.action -ceq 'Install update'){$button=$install[0]}else{throw 'action'}
    $script:phase='dialog-button-state'
    $script:diagnostics.buttonOwned=$button.Current.ProcessId -eq $requestValue.application.pid
    $script:diagnostics.buttonEnabled=$button.Current.IsEnabled
    $script:diagnostics.buttonOffscreen=$button.Current.IsOffscreen
    if(!$script:diagnostics.buttonOwned -or !$script:diagnostics.buttonEnabled -or $script:diagnostics.buttonOffscreen){throw 'button'}
    $script:phase='dialog-pattern'
    $pattern=$null
    $script:diagnostics.invokePattern=$button.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)
    if(!$script:diagnostics.invokePattern){throw 'pattern'}
  }
  $null=Require-App $requestValue.application
  $script:phase='dialog-owner-recheck'
  [uint32]$dialogPid=0
  $null=[PreviewUpdateWindow]::GetWindowThreadProcessId([IntPtr]$dialog.Current.NativeWindowHandle,[ref]$dialogPid)
  $script:diagnostics.dialogHandleOwned=$dialogPid -eq $requestValue.application.pid
  if(!$script:diagnostics.dialogHandleOwned){throw 'changed'}
  $script:phase='invoke'
  if($native){[PreviewUpdateCommandLink]::Click([IntPtr]$dialog.Current.NativeWindowHandle,[uint32]$requestValue.application.pid,$nativeId,$nativeButton.Handle)}else{([Windows.Automation.InvokePattern]$pattern).Invoke()}
  return @{status='invoked';action=$requestValue.action}
}
switch -CaseSensitive ($request.operation) {
  'observe' {$result=Observe-App $request}
  'confirm' {$result=Confirm-App $request}
  'close' {
    $app=Require-App $request.application
    $script:phase='close'
    if(![PreviewUpdateWindow]::PostMessage([IntPtr]([long]$app.windowHandle),0x0010,[IntPtr]::Zero,[IntPtr]::Zero)){throw 'close'}
    $result=@{status='close-requested'}
  }
  'exited' {
    $script:phase='exit'
    $row=Read-Row $request.application.pid
    if(!$row -or (Birth $row) -cne $request.application.creationTime){$result=@{status='exited'}}
    else {
      if(!(Same-Path $row.ExecutablePath $request.application.executable) -or $row.SessionId -ne $session -or $row.SessionId -ne $request.application.sessionId){throw 'identity'}
      $owner=Invoke-CimMethod -InputObject $row -MethodName GetOwnerSid -ErrorAction Stop
      if($owner.ReturnValue -ne 0 -or $owner.Sid -cne $sid -or $owner.Sid -cne $request.application.ownerSid){throw 'owner'}
      $result=@{status='running'}
    }
  }
  default {throw 'operation'}
}
$script:phase='output'
[Console]::Out.Write((ConvertTo-Json -InputObject $result -Compress -Depth 6))
`

export function previewUpdateWindowsArguments(executable: string) {
  const args = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Mta",
    "-EncodedCommand",
    Buffer.from(windowsReviewScriptBootstrap(previewUpdateWindowsScript), "utf16le").toString("base64"),
  ]
  if (executable.length * 2 + args.reduce((sum, arg) => sum + arg.length + 3, 0) + 3 >= 32767) throw failure()
  return args
}

/** Pure transport seam: only a supplied executor can perform an operation.
 * Production callers use the guarded factory below and retain one owner. */
export function createPreviewUpdateWindowsTransport(
  execute: Parameters<typeof createWindowsReviewRequestTransport>[0],
  closeTimeoutMs = 500,
) {
  const request = createWindowsReviewRequestTransport<Request>(execute, () => 12000, closeTimeoutMs)
  let mutationUncertain = false
  const perform = async (input: Request): Promise<Reply> => {
    if (mutationUncertain) throw failure()
    const checked = validated(input)
    const value = await request(checked)
    if (!object(value)) throw failure()
    if (value.status === "unreadable") {
      const observation = nativeObservation(value.phase, value.diagnostics)
      throw Object.assign(Error(`PREVIEW_UPDATE_WINDOWS_UNCONFIRMED:${observation.phase}`), {
        previewUpdateWindowsObservation: observation,
      })
    }
    if (checked.operation === "observe") {
      if (value.status === "waiting" && keys(value, ["status"])) return { status: "waiting" }
      if (value.status !== "observed" || !keys(value, ["status", "application", "versionInfo"])) throw failure()
      const result = application(value.application)
      if (
        result.executable.toLowerCase() !== checked.executable.toLowerCase() ||
        result.version !== checked.version ||
        BigInt(result.creationTime) <= BigInt(checked.after) ||
        result.pid === checked.previousPid
      )
        throw failure()
      // Reuse the producer's exact prerelease PE metadata convention.
      verifyWindowsVersionInfo(value.versionInfo, checked.version, "public")
      return { status: "observed", application: result }
    }
    if (checked.operation === "confirm") {
      if (value.status === "waiting" && keys(value, ["status"])) return { status: "waiting" }
      if (value.status === "invoked" && value.action === checked.action && keys(value, ["status", "action"]))
        return { status: "invoked", action: checked.action }
      throw failure()
    }
    if (!keys(value, ["status"])) throw failure()
    if (checked.operation === "close" && value.status === "close-requested") return { status: "close-requested" }
    if (checked.operation === "exited" && (value.status === "exited" || value.status === "running"))
      return { status: value.status }
    throw failure()
  }
  return {
    async observe(input: Observe) {
      const result = await perform({ ...input, operation: "observe" })
      if (result.status === "observed") return result.application
      if (result.status === "waiting") return undefined
      throw failure()
    },
    async confirm(input: Confirm) {
      try {
        const result = await perform({ ...input, operation: "confirm" })
        if (result.status === "waiting" || result.status === "invoked") return result.status
        throw failure()
      } catch (error) {
        // A native button might already have been invoked before a failed
        // response. Never retry an uncertain action on this controller owner.
        mutationUncertain = true
        throw error
      }
    },
    async close(input: { application: PreviewUpdateWindowsApplication }) {
      try {
        await perform({ ...input, operation: "close" })
      } catch (error) {
        mutationUncertain = true
        throw error
      }
    },
    async exited(input: { application: PreviewUpdateWindowsApplication }) {
      const result = await perform({ ...input, operation: "exited" })
      return result.status === "exited"
    },
  }
}

/** Installer replacement may temporarily remove the owned file/directory.
 * Missing bytes mean waiting only; every existing ancestor remains confined.
 * This read-only boundary never treats a missing file as process-exit evidence. */
export async function previewUpdateWindowsExecutableReady(
  path: string,
  temporary: string,
  files: {
    inspect(path: string): Promise<{ file: boolean; directory: boolean; symbolicLink: boolean }>
    canonical(path: string): Promise<string>
  } = {
    inspect: async (path) => {
      const stat = await lstat(path)
      return { file: stat.isFile(), directory: stat.isDirectory(), symbolicLink: stat.isSymbolicLink() }
    },
    canonical: realpath,
  },
) {
  if (
    !executable(path) ||
    !win32.isAbsolute(temporary) ||
    !path.toLowerCase().startsWith(temporary.toLowerCase() + "\\")
  )
    throw failure()
  let missing = false
  for (let current = path; current.toLowerCase() !== temporary.toLowerCase(); current = win32.dirname(current)) {
    const stat = await files.inspect(current).catch((error: unknown) => {
      if (object(error) && error.code === "ENOENT") return undefined
      throw failure()
    })
    if (!stat) {
      missing = true
      continue
    }
    if (stat.symbolicLink || (current === path ? !stat.file : !stat.directory)) throw failure()
    const canonical = await files.canonical(current).catch((error: unknown) => {
      if (object(error) && error.code === "ENOENT") return undefined
      throw failure()
    })
    if (!canonical) {
      missing = true
      continue
    }
    if (canonical.toLowerCase() !== current.toLowerCase()) throw failure()
  }
  return !missing
}

/** Retain only the process generations present before confirmation/close. The
 * final query cannot adopt the later installer into this departure assertion.
 * This grants observation authority only, never permission to signal a PID. */
export async function capturePreviewUpdateWindowsShutdown(
  input: { application: PreviewUpdateWindowsApplication },
  query: Awaited<ReturnType<typeof windowsAppShutdownNative>>,
) {
  const expected = application(input.application)
  const unreadable = () => Error("PREVIEW_UPDATE_WINDOWS_SHUTDOWN_UNCONFIRMED")
  const read = async (pids?: number[]) => {
    const result = await query({ rootPid: expected.pid, ...(pids ? { pids } : {}) }).catch(() => {
      throw unreadable()
    })
    if (result.quiescence !== "confirmed") throw unreadable()
    const snapshot = windowsAppShutdownSnapshot(result.snapshot)
    if (snapshot.status !== "COMPLETE" || snapshot.processes.some((row) => !row.birth || !row.executable))
      throw unreadable()
    return snapshot.processes
  }
  const initial = await read()
  const retained = new Map(initial.map((row) => [row.pid, row]))
  const root = retained.get(expected.pid)
  if (
    !root ||
    root.birth !== expected.creationTime ||
    root.executable!.toLowerCase() !== expected.executable.toLowerCase()
  )
    throw unreadable()
  const selected = new Set([expected.pid])
  for (let count = -1; count !== selected.size; ) {
    count = selected.size
    for (const row of initial) if (selected.has(row.parent)) selected.add(row.pid)
  }
  if (
    initial.some((row) => {
      if (row.pid === expected.pid) return false
      const parent = retained.get(row.parent)
      return (
        !selected.has(row.pid) ||
        !parent ||
        BigInt(row.birth!) < BigInt(parent.birth!) ||
        BigInt(row.birth!) < BigInt(root.birth!)
      )
    })
  )
    throw unreadable()
  const pids = [...retained.keys()].sort((a, b) => a - b)
  return async () => {
    const final = await read(pids)
    if (final.some((row) => !retained.has(row.pid))) throw unreadable()
    return !final.some((row) => row.birth === retained.get(row.pid)!.birth)
  }
}

/** Test-only native ownership; never available on a workstation or release job. */
export async function createPreviewUpdateWindowsNative(input: { env: NodeJS.ProcessEnv; root: string }) {
  if (
    process.platform !== "win32" ||
    process.arch !== "x64" ||
    input.env.RUNNER_ARCH !== "X64" ||
    input.env.GITHUB_REPOSITORY !== "PhysicalSystems/desktop" ||
    input.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    input.env.PHYSICALSYSTEMS_UPDATER_TEST !== "1"
  )
    throw Error("PREVIEW_UPDATE_WINDOWS_REQUIRES_DISPOSABLE_TEST")
  await requireDisposablePublicRunner(input.env, input.root)
  const marker = win32.join(input.root, "preview-update-runner.json")
  const markerStat = await lstat(marker)
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.nlink !== 1 || markerStat.size > 1024)
    throw failure()
  const context: unknown = JSON.parse(await readFile(marker, "utf8"))
  if (
    !object(context) ||
    !keys(context, ["kind", "runId"]) ||
    context.kind !== "disposable-preview-update" ||
    context.runId !== input.env.GITHUB_RUN_ID
  )
    throw failure()
  const environment = windowsReviewNativeEnvironment(input.env, input.root)
  const command = win32.join(environment.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  const args = previewUpdateWindowsArguments(command)
  const native = createPreviewUpdateWindowsTransport((deadline, complete) =>
    execFile(
      command,
      args,
      {
        cwd: input.root,
        env: environment,
        shell: false,
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: 8192,
        timeout: deadline.timeout,
      },
      complete,
    ),
  )
  const shutdown = await windowsAppShutdownNative(input.env, input.root)
  const temporary = (await realpath(input.env.RUNNER_TEMP!)).toLowerCase()
  const owned = async (path: string) => {
    if (!(await previewUpdateWindowsExecutableReady(path, temporary))) throw failure()
  }
  return {
    async captureShutdown(request: { application: PreviewUpdateWindowsApplication }) {
      await owned(request.application.executable)
      return capturePreviewUpdateWindowsShutdown(request, shutdown)
    },
    async observe(request: Observe) {
      if (!(await previewUpdateWindowsExecutableReady(request.executable, temporary))) return undefined
      return native.observe(request)
    },
    async confirm(request: Confirm) {
      await owned(request.application.executable)
      return native.confirm(request)
    },
    async close(request: { application: PreviewUpdateWindowsApplication }) {
      await owned(request.application.executable)
      return native.close(request)
    },
    // The old executable can be replaced by NSIS. Exit uses PID+creation and
    // never uses absence of the old on-disk version as proof of process exit.
    exited: native.exited,
  }
}
