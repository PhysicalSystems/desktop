// SPDX-License-Identifier: Apache-2.0
import { execFile } from "node:child_process"
import { win32 } from "node:path"
import { readBrowserObservation } from "./browser-observation"
import { requireDisposablePublicRunner } from "./public-qualification"
import { createWindowsReviewRequestTransport, windowsReviewNativeEnvironment } from "./windows-review-native"
import type { WindowsAppShutdownSnapshot } from "./windows-app-shutdown-observation"

type Request = { rootPid: number; pids?: readonly number[] }
type Result = { snapshot: WindowsAppShutdownSnapshot; quiescence: "confirmed" | "unconfirmed" }
const unreadable = (): WindowsAppShutdownSnapshot => ({ status: "UNREADABLE", processes: [] })
const pid = (value: unknown, zero = false): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= (zero ? 0 : 1) && value <= 0xffffffff

/** OS argument parsing produces one enum only; argv never leaves PowerShell. */
export const windowsAppShutdownRole = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AppShutdownArguments {
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CommandLineToArgvW(string command, out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
  public static string[] Read(string command) {
    int count; var memory=CommandLineToArgvW(command,out count);
    if(memory==IntPtr.Zero) throw new Exception();
    try {
      if(count<1 || count>256) throw new Exception();
      var result=new string[count];
      for(int i=0;i<count;i++) result[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory,i*IntPtr.Size));
      return result;
    } finally { LocalFree(memory); }
  }
}
'@
function Read-AppShutdownRole($line) {
  if($line -isnot [string] -or $line.Length -eq 0 -or $line.Length -gt 32768){return 'unknown'}
  try {
    $types=@([AppShutdownArguments]::Read($line) | Where-Object {$_ -ceq '--type' -or $_.StartsWith('--type=')})
    if($types.Count -ne 1){return 'unknown'}
    switch -CaseSensitive ($types[0]) {
      '--type=renderer' {return 'renderer'}
      '--type=gpu-process' {return 'gpu'}
      '--type=utility' {return 'utility'}
      '--type=crashpad-handler' {return 'crashpad'}
      default {return 'unknown'}
    }
  } catch {return 'unknown'}
}
`

/** Fixed metadata-only query, also executed with inert CIM rows by the hosted
 * fixture. It selects the existing numeric descendant closure without changing
 * cleanup authority; creation times and paths are diagnostic observations only. */
export const windowsAppShutdownQuery = String.raw`
function Read-AppShutdownSnapshot($request) {
  if($request.rootPid -isnot [long] -and $request.rootPid -isnot [int]){throw 'request'}
  if($request.rootPid -lt 1 -or $request.rootPid -gt 4294967295){throw 'request'}
  $rows=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine -ErrorAction Stop)
  if($rows.Count -gt 4096){throw 'bounds'}
  $ids=[Collections.Generic.HashSet[long]]::new()
  $null=$ids.Add([long]$request.rootPid)
  if($null -ne $request.pids) {
    if($request.pids.Count -gt 256){throw 'bounds'}
    foreach($id in $request.pids){
      if(($id -isnot [long] -and $id -isnot [int]) -or $id -lt 1 -or $id -gt 4294967295){throw 'request'}
      $null=$ids.Add([long]$id)
    }
  } else {
    do {
      $count=$ids.Count
      foreach($row in $rows){if($ids.Contains([long]$row.ParentProcessId)){$null=$ids.Add([long]$row.ProcessId)}}
      if($ids.Count -gt 256){throw 'bounds'}
    } while($count -ne $ids.Count)
  }
  $selected=@($rows | Where-Object {$ids.Contains([long]$_.ProcessId)})
  if($selected.Count -gt 256){throw 'bounds'}
  $result=@(foreach($row in $selected) {
    $birth=$null;$executable=$null
    try {if($row.CreationDate -is [DateTime]){$birth=$row.CreationDate.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)}}catch{}
    if($row.ExecutablePath -is [string] -and $row.ExecutablePath.Length -le 2048){$executable=$row.ExecutablePath}
    @{pid=[long]$row.ProcessId;parent=[long]$row.ParentProcessId;birth=$birth;executable=$executable;role=(Read-AppShutdownRole $row.CommandLine)}
  })
  return @{status='COMPLETE';processes=$result}
}
`

export const windowsAppShutdownScript = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules')
${windowsAppShutdownQuery}
try {
${windowsAppShutdownRole}
  $line=[Console]::In.ReadLine()
  if($null -eq $line -or $line.Length -gt 8192){throw 'request'}
  $request=$line | ConvertFrom-Json
  $value=Read-AppShutdownSnapshot $request
  [Console]::Out.Write(($value | ConvertTo-Json -Depth 5 -Compress))
} catch { [Console]::Out.Write('{"status":"UNREADABLE","processes":[]}') }
`

/** Native output never escapes in errors, and unknown fields cannot become
 * private evidence. Missing individual metadata remains explicitly unreadable. */
export function windowsAppShutdownSnapshot(value: unknown): WindowsAppShutdownSnapshot {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return unreadable()
    const record = value as Record<string, unknown>
    if (Object.keys(record).some((key) => !["status", "processes"].includes(key))) return unreadable()
    if (record.status !== "COMPLETE" || !Array.isArray(record.processes) || record.processes.length > 256)
      return unreadable()
    const seen = new Set<number>()
    const processes = record.processes.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw Error()
      const row = value as Record<string, unknown>
      if (
        Object.keys(row).some((key) => !["pid", "parent", "birth", "executable", "role"].includes(key)) ||
        !pid(row.pid) ||
        !pid(row.parent, true) ||
        seen.has(row.pid)
      )
        throw Error()
      seen.add(row.pid)
      const birth =
        typeof row.birth === "string" &&
        /^[1-9][0-9]{0,18}$/.test(row.birth) &&
        BigInt(row.birth) <= 3155378975999999999n
          ? row.birth
          : undefined
      const executable =
        typeof row.executable === "string" &&
        row.executable.length <= 2048 &&
        /^[A-Za-z]:\\[^\r\n\0]+$/.test(row.executable) &&
        win32.normalize(row.executable) === row.executable
          ? row.executable
          : undefined
      const role =
        typeof row.role === "string" && ["renderer", "gpu", "utility", "crashpad", "unknown"].includes(row.role)
          ? (row.role as "renderer" | "gpu" | "utility" | "crashpad" | "unknown")
          : undefined
      return Object.freeze({
        pid: row.pid,
        parent: row.parent,
        ...(birth ? { birth } : {}),
        ...(executable ? { executable } : {}),
        ...(role ? { role } : {}),
      })
    })
    return { status: "COMPLETE", processes }
  } catch {
    return unreadable()
  }
}

/** The mandatory fake executor seam has no native/platform/environment default.
 * The production factory below alone chooses its guarded OS executable. */
export function createWindowsAppShutdownTransport(
  execute: Parameters<typeof createWindowsReviewRequestTransport>[0],
  closeTimeoutMs = 500,
) {
  const request = createWindowsReviewRequestTransport<Request>(execute, () => 12000, closeTimeoutMs)
  return async (input: Request): Promise<Result> => {
    if (
      !pid(input.rootPid) ||
      (input.pids !== undefined &&
        (!Array.isArray(input.pids) ||
          input.pids.length > 256 ||
          input.pids.some((value) => !pid(value)) ||
          new Set(input.pids).size !== input.pids.length))
    )
      return { snapshot: unreadable(), quiescence: "confirmed" }
    try {
      const value = await request({ rootPid: input.rootPid, ...(input.pids ? { pids: [...input.pids] } : {}) })
      return { snapshot: windowsAppShutdownSnapshot(value), quiescence: "confirmed" }
    } catch (error) {
      return {
        snapshot: unreadable(),
        quiescence: readBrowserObservation(error)?.handoffQuiescence === "unconfirmed" ? "unconfirmed" : "confirmed",
      }
    }
  }
}

export async function windowsAppShutdownNative(env: NodeJS.ProcessEnv, root: string) {
  if (process.platform !== "win32") throw Error("PACKAGED_SHUTDOWN_DIAGNOSTIC_UNAVAILABLE")
  await requireDisposablePublicRunner(env, root)
  const environment = windowsReviewNativeEnvironment(env, root)
  const executable = win32.join(environment.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  const args = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(windowsAppShutdownScript, "utf16le").toString("base64"),
  ]
  if (executable.length * 2 + 3 + args.reduce((sum, arg) => sum + arg.length + 3, 0) > 32767)
    throw Error("PACKAGED_SHUTDOWN_DIAGNOSTIC_UNAVAILABLE")
  return createWindowsAppShutdownTransport((deadline, complete) =>
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
