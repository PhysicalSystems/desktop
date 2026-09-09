// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process"
import type { ChildProcess, SpawnOptions } from "node:child_process"
import { randomBytes } from "node:crypto"
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { join, win32 } from "node:path"
import { nsisInstallArguments, nsisSpawnOptions } from "./installed-reinstall"
import { requireDisposablePublicRunner } from "./public-qualification"
import { windowsReviewNativeEnvironment } from "./windows-review-native"

const failure = () => new Error("PUBLIC_UPGRADE_INSTALLER_UNCONFIRMED")
const retained = () => new Error("PUBLIC_UPGRADE_INSTALLER_DESCENDANT_RETAINED")
const ownerPhases = [
  "bootstrap",
  "layout",
  "job-create",
  "job-limits",
  "job-attribute",
  "process-create",
  "job-observe",
  "handle-close",
  "control-closed",
  "control-invalid",
  "root-not-live",
  "stop",
  "deadline",
  "cleanup",
  "transport",
  "stop-timeout",
] as const
type OwnerPhase = (typeof ownerPhases)[number]
const observations = new WeakMap<Error, Readonly<{ ownerPhase: OwnerPhase }>>()
export function readWindowsInstallerOwnerObservation(error: unknown) {
  return error instanceof Error ? observations.get(error) : undefined
}
function observedFailure(phase: OwnerPhase, error = failure()) {
  observations.set(error, Object.freeze({ ownerPhase: phase }))
  return error
}
type Completion = { exitCode: number; stopped: boolean; jobEmpty: true }
export type WindowsInstallerOwner = {
  pid: number
  completion: Promise<Completion>
  stop(): Promise<void>
  abort(): Promise<void>
}

/** Node selects the first case-insensitive key after its JavaScript key sort;
 * Windows then requires the surviving native block sorted without case. */
export function windowsInstallerEnvironment(env: NodeJS.ProcessEnv) {
  const seen = new Set<string>()
  return (
    Object.keys(env)
      .sort()
      .flatMap((key) => {
        const value = env[key]
        if (value === undefined || seen.has(key.toUpperCase())) return []
        if (!key || /[=\0]/.test(key) || value.includes("\0")) throw failure()
        seen.add(key.toUpperCase())
        return [{ key, value }]
      })
      .sort((a, b) =>
        a.key.toUpperCase() < b.key.toUpperCase() ? -1 : a.key.toUpperCase() > b.key.toUpperCase() ? 1 : 0,
      )
      .map(({ key, value }) => `${key}=${value}`)
      .join("\0") + "\0\0"
  )
}

/** The job is assigned atomically at CreateProcessW, before any installer code
 * can run. The installer receives neither the job handle nor our control pipes.
 * STOP is handled by an already-running native thread holding both handles. */
export const windowsInstallerOwnerScript = String.raw`
param([Parameter(Mandatory=$true)][string]$RequestPath)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules')
try {
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class InstallerJobOwner {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime; public uint Flags;
    public UIntPtr MinWorking, MaxWorking; public uint ActiveLimit;
    public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong A,B,C,D,E,F; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic; public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long User, Kernel, PeriodUser, PeriodKernel;
    public uint PageFaults, Total, Active, Terminated;
  }
  [StructLayout(LayoutKind.Sequential)] struct Startup {
    public uint Size; public IntPtr Reserved, Desktop, Title;
    public uint X,Y,XSize,YSize,XChars,YChars,Fill,Flags;
    public ushort Show, ReservedBytes; public IntPtr ReservedData, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup Startup; public IntPtr Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint Pid, Tid; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr security, string name);
  [DllImport("kernel32.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits value, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting value, uint size, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref UIntPtr bytes);
  [DllImport("kernel32.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, UIntPtr bytes, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] static extern bool CreateProcessW(string file, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string directory, ref StartupEx startup, out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] static extern bool CloseHandle(IntPtr handle);
  static readonly object Gate=new object();
  static IntPtr Job, Process;
  static bool Go, Started, Stopped, Finished;
  static string ErrorPhase;
  static string Nonce;
  static void Emit(string fields) { Console.Out.WriteLine("{\"nonce\":\""+Nonce+"\","+fields+"}"); Console.Out.Flush(); }
  static string Command() {
    var line=new StringBuilder();
    for(;;) { int c=Console.In.Read(); if(c<0) return null; if(c==10) return line.ToString(); if(c==13) continue; if(line.Length>=80) throw new Exception(); line.Append((char)c); }
  }
  static void ReadControl() {
    try {
      for(;;) {
        string command=Command();
        lock(Gate) {
          if(Finished) return;
          if(command==null) { ErrorPhase="control-closed"; return; }
          if(command=="GO "+Nonce && !Go && !Started) { Go=true; continue; }
          if(command=="STOP "+Nonce && Started && !Stopped) {
            if(WaitForSingleObject(Process,0)!=258) { ErrorPhase="root-not-live"; return; }
            if(!TerminateJobObject(Job,197)) { ErrorPhase="stop"; return; }
            Stopped=true; Emit("\"event\":\"stopped\""); continue;
          }
          ErrorPhase="control-invalid"; return;
        }
      }
    } catch { lock(Gate) { if(!Finished) ErrorPhase="control-invalid"; } }
  }
  static uint Active() {
    Accounting value;
    if(!QueryInformationJobObject(Job,1,out value,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero)) throw new Exception();
    return value.Active;
  }
  static bool RootExited() {
    if(Process==IntPtr.Zero) return true;
    uint value=WaitForSingleObject(Process,0);
    if(value==0) return true;
    if(value==258) return false;
    throw new Exception();
  }
  static bool CloseOwned() {
    bool good=true;
    if(Process!=IntPtr.Zero) { good=CloseHandle(Process)&&good; Process=IntPtr.Zero; }
    if(Job!=IntPtr.Zero) { good=CloseHandle(Job)&&good; Job=IntPtr.Zero; }
    return good;
  }
  public static int Run(string artifact,string command,string directory,string environment,string nonce,int timeout) {
    Nonce=nonce; string phase="layout"; var clock=Stopwatch.StartNew();
    try {
      if(IntPtr.Size!=8 || Marshal.SizeOf(typeof(ExtendedLimits))!=144 || Marshal.SizeOf(typeof(Accounting))!=48 || Marshal.SizeOf(typeof(StartupEx))!=112) throw new Exception();
      phase="job-create"; Job=CreateJobObjectW(IntPtr.Zero,null); if(Job==IntPtr.Zero) throw new Exception();
      var limits=new ExtendedLimits(); limits.Basic.Flags=0x2000;
      phase="job-limits";
      if(!SetInformationJobObject(Job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimits)))) throw new Exception();
      Emit("\"event\":\"ready\"");
      var reader=new Thread(ReadControl); reader.IsBackground=true; reader.Start();
      for(;;) {
        lock(Gate) {
          if(ErrorPhase!=null) { phase=ErrorPhase; throw new Exception(); }
          if(clock.ElapsedMilliseconds>=timeout) { phase="deadline"; throw new Exception(); }
          if(Go) break;
        }
        Thread.Sleep(5);
      }
      lock(Gate) {
        if(ErrorPhase!=null) { phase=ErrorPhase; throw new Exception(); }
        phase="job-attribute";
        UIntPtr bytes=UIntPtr.Zero;
        if(InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref bytes) || Marshal.GetLastWin32Error()!=122 || bytes.ToUInt64()==0 || bytes.ToUInt64()>65536) throw new Exception();
        IntPtr attributes=Marshal.AllocHGlobal((int)bytes.ToUInt64()), jobs=Marshal.AllocHGlobal(IntPtr.Size);
        bool initialized=false; IntPtr environmentBlock=IntPtr.Zero;
        try {
          if(!InitializeProcThreadAttributeList(attributes,1,0,ref bytes)) throw new Exception(); initialized=true;
          Marshal.WriteIntPtr(jobs,Job);
          if(!UpdateProcThreadAttribute(attributes,0,new IntPtr(0x2000d),jobs,new UIntPtr((uint)IntPtr.Size),IntPtr.Zero,IntPtr.Zero)) throw new Exception();
          var startup=new StartupEx(); startup.Startup.Size=(uint)Marshal.SizeOf(typeof(StartupEx)); startup.Attributes=attributes;
          ProcessInfo created; phase="process-create";
          // Explicit application name and no inherited handles: no shell,
          // breakaway, control-pipe inheritance or job-handle inheritance.
          environmentBlock=Marshal.StringToHGlobalUni(environment);
          if(!CreateProcessW(artifact,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,false,0x80000|0x08000000|0x400,environmentBlock,directory,ref startup,out created)) throw new Exception();
          Process=created.Process; Started=true;
          if(!CloseHandle(created.Thread)) throw new Exception();
          Emit("\"event\":\"started\",\"pid\":"+created.Pid);
        } finally {
          if(initialized) DeleteProcThreadAttributeList(attributes);
          if(environmentBlock!=IntPtr.Zero) Marshal.FreeHGlobal(environmentBlock);
          Marshal.FreeHGlobal(jobs); Marshal.FreeHGlobal(attributes);
        }
      }
      for(;;) {
        lock(Gate) {
          if(ErrorPhase!=null) { phase=ErrorPhase; throw new Exception(); }
          if(clock.ElapsedMilliseconds>=timeout) { phase="deadline"; throw new Exception(); }
          phase="job-observe";
          if(RootExited() && Active()==0) {
            uint code; if(!GetExitCodeProcess(Process,out code)) throw new Exception();
            Finished=true; phase="handle-close"; if(!CloseOwned()) throw new Exception();
            Emit("\"event\":\"exited\",\"exitCode\":"+code+",\"stopped\":"+(Stopped?"true":"false")+",\"activeProcesses\":0,\"rootSignaled\":true");
            return 0;
          }
        }
        Thread.Sleep(5);
      }
    } catch {
      lock(Gate) {
        Finished=true;
        try {
          if(Job!=IntPtr.Zero) {
            if(!TerminateJobObject(Job,198)) phase="cleanup";
            var close=Stopwatch.StartNew();
            while((!RootExited() || Active()!=0) && close.ElapsedMilliseconds<10000) Thread.Sleep(5);
            if(!RootExited() || Active()!=0) phase="cleanup";
          }
        } catch { phase="cleanup"; }
        if(!CloseOwned()) phase="cleanup";
        Emit("\"event\":\"error\",\"phase\":\""+phase+"\"");
      }
      return 1;
    }
  }
}
'@
  $file=Get-Item -LiteralPath $RequestPath -Force
  if($file.PSIsContainer -or $file.Length -gt 1048576 -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'input'}
  $request=[IO.File]::ReadAllText($RequestPath) | ConvertFrom-Json
  if((($request.PSObject.Properties.Name | Sort-Object) -join ',') -cne 'artifact,command,directory,environment,nonce,timeoutMs'){throw 'input'}
  if($request.nonce -cnotmatch '^[a-f0-9]{64}$' -or $request.timeoutMs -lt 1 -or $request.timeoutMs -gt 120000){throw 'input'}
  foreach($value in @($request.artifact,$request.directory)) { if($value -isnot [string] -or $value -cnotmatch '^[A-Za-z]:\\[^"\r\n\0]+$'){throw 'input'} }
  if($request.command -isnot [string] -or $request.command.Length -gt 16384 -or $request.command -match '[\r\n\0]'){throw 'input'}
  if($request.environment -isnot [string] -or !$request.environment.EndsWith([string][char]0+[char]0)){throw 'input'}
  exit ([InstallerJobOwner]::Run($request.artifact,$request.command,$request.directory,$request.environment,$request.nonce,[int]$request.timeoutMs))
} catch { [Console]::Out.WriteLine('{"event":"bootstrap-error"}'); exit 1 }
`

/** Mandatory injected-process seam. This parser never selects an executable or
 * acquires native ownership; the guarded factory below does that. */
export function createWindowsInstallerOwnerTransport(child: ChildProcess, nonce: string, timeoutMs: number) {
  const started = Promise.withResolvers<WindowsInstallerOwner>()
  const completion = Promise.withResolvers<Completion>()
  const stopped = Promise.withResolvers<void>()
  const closed = Promise.withResolvers<void>()
  void started.promise.catch(() => {})
  void completion.promise.catch(() => {})
  void stopped.promise.catch(() => {})
  let phase: "bootstrap" | "ready" | "running" | "exited" = "bootstrap"
  let pid = 0
  let stopRequested = false
  let stopAcknowledged = false
  let closeObserved = false
  let success = false
  let error: Error | undefined
  let result: Completion | undefined
  let buffer = ""
  let outputBytes = 0
  let aborting: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const reject = (reason = observedFailure("transport")) => {
    error ??= reason
    started.reject(error)
    stopped.reject(error)
    completion.reject(error)
    clearTimeout(timer)
  }
  const abort = () => {
    if (success) return Promise.resolve()
    // EOF is cancellation even if an exit record is already buffered. Only
    // native proof followed by successful helper close may settle completion.
    reject(observedFailure("control-closed"))
    return (aborting ??= (async () => {
      child.stdin?.end()
      if (closeObserved) return
      let closeTimer: ReturnType<typeof setTimeout> | undefined
      const confirmed = await Promise.race([
        closed.promise.then(() => true),
        new Promise<false>((resolve) => {
          closeTimer = setTimeout(() => resolve(false), 10000)
        }),
      ])
      clearTimeout(closeTimer)
      if (confirmed) return
      // Killing only our helper closes its noninheritable job handle. A kill
      // request still grants no closure proof and the private directory stays.
      try {
        child.kill()
      } catch {
        /* No exit proof follows from a signal request. */
      }
      child.unref()
      throw observedFailure("cleanup", retained())
    })())
  }
  const fail = (reason = observedFailure("transport")) => {
    reject(reason)
    void abort().catch(() => {})
  }
  const owner: WindowsInstallerOwner = {
    get pid() {
      return pid
    },
    completion: completion.promise,
    async stop() {
      if (phase !== "running" || stopRequested || error) throw failure()
      stopRequested = true
      child.stdin!.write(`STOP ${nonce}\n`, (error) => {
        if (error) fail()
      })
      let stopTimer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          stopped.promise,
          new Promise<never>((_, reject) => {
            stopTimer = setTimeout(() => reject(observedFailure("stop-timeout", retained())), 10000)
          }),
        ])
      } catch (error) {
        fail(error instanceof Error ? error : failure())
        throw error
      } finally {
        clearTimeout(stopTimer)
      }
    },
    abort,
  }
  const message = (line: string) => {
    const value = JSON.parse(line) as Record<string, unknown>
    if (!value || typeof value !== "object" || Array.isArray(value)) throw failure()
    const keys = Object.keys(value).sort().join(",")
    if (value.event === "bootstrap-error" && keys === "event" && phase === "bootstrap")
      return fail(observedFailure("bootstrap"))
    if (value.nonce !== nonce) throw failure()
    if (value.event === "error" && keys === "event,nonce,phase" && ownerPhases.some((phase) => phase === value.phase))
      return fail(observedFailure(value.phase as OwnerPhase))
    if (value.event === "ready" && keys === "event,nonce" && phase === "bootstrap") {
      phase = "ready"
      child.stdin!.write(`GO ${nonce}\n`, (error) => {
        if (error) fail()
      })
      return
    }
    if (
      value.event === "started" &&
      keys === "event,nonce,pid" &&
      phase === "ready" &&
      typeof value.pid === "number" &&
      Number.isInteger(value.pid) &&
      value.pid > 0 &&
      value.pid <= 0xffffffff &&
      value.pid !== process.pid &&
      value.pid !== child.pid
    ) {
      pid = value.pid
      phase = "running"
      started.resolve(owner)
      return
    }
    if (
      value.event === "stopped" &&
      keys === "event,nonce" &&
      phase === "running" &&
      stopRequested &&
      !stopAcknowledged
    ) {
      stopAcknowledged = true
      stopped.resolve()
      return
    }
    if (
      value.event === "exited" &&
      keys === "activeProcesses,event,exitCode,nonce,rootSignaled,stopped" &&
      phase === "running" &&
      value.rootSignaled === true &&
      value.activeProcesses === 0 &&
      typeof value.exitCode === "number" &&
      Number.isInteger(value.exitCode) &&
      value.exitCode >= 0 &&
      value.exitCode <= 0xffffffff &&
      typeof value.stopped === "boolean" &&
      value.stopped === stopAcknowledged &&
      (!stopRequested || stopAcknowledged)
    ) {
      phase = "exited"
      result = Object.freeze({ exitCode: value.exitCode, stopped: value.stopped, jobEmpty: true })
      return
    }
    throw failure()
  }
  child.stdout?.setEncoding("utf8")
  child.stdout?.on("data", (chunk: string) => {
    if (error) return
    outputBytes += Buffer.byteLength(chunk)
    if (outputBytes > 8192) return fail()
    buffer += chunk
    try {
      for (;;) {
        const end = buffer.indexOf("\n")
        if (end < 0 || error) break
        const line = buffer.slice(0, end).replace(/\r$/, "")
        buffer = buffer.slice(end + 1)
        message(line)
      }
    } catch {
      fail()
    }
  })
  child.stderr?.on("data", () => {
    /* Native diagnostics never enter public output. */
  })
  child.stdin?.once("error", () => fail())
  child.once("error", () => fail())
  child.once("close", (code, signal) => {
    closeObserved = true
    clearTimeout(timer)
    closed.resolve()
    if (!error && code === 0 && signal === null && result && !buffer.length) {
      success = true
      completion.resolve(result)
      return
    }
    reject()
  })
  if (
    !child.stdin ||
    !child.stdout ||
    !child.stderr ||
    !/^[a-f0-9]{64}$/.test(nonce) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120000
  )
    fail()
  else
    timer = setTimeout(
      () => fail(observedFailure("deadline", new Error("PUBLIC_UPGRADE_INSTALLER_TIMEOUT"))),
      timeoutMs,
    )
  return { started: started.promise, closed: closed.promise, abort }
}

export async function startWindowsInstallerOwner(
  input: { env: NodeJS.ProcessEnv; root: string; artifact: string; installation: string; timeoutMs: number },
  options: { spawn?: (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess } = {},
): Promise<WindowsInstallerOwner> {
  const deadline = Date.now() + input.timeoutMs
  await requireDisposablePublicRunner(input.env, input.root, process.platform)
  if (
    process.platform !== "win32" ||
    !Number.isInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    input.timeoutMs > 120000 ||
    input.installation !== join(input.root, "payload")
  )
    throw failure()
  const command = `${nsisSpawnOptions(input.artifact).argv0} ${nsisInstallArguments(input.installation).args.join(" ")}`
  const artifact = await lstat(input.artifact)
  if (!artifact.isFile() || artifact.isSymbolicLink()) throw failure()
  const environment = windowsInstallerEnvironment(input.env)
  const root = await realpath(await mkdtemp(join(input.root, "installer-owner-")))
  const file = join(root, "owner.ps1")
  const request = join(root, "request.json")
  const nonce = randomBytes(32).toString("hex")
  let transport: ReturnType<typeof createWindowsInstallerOwnerTransport> | undefined
  try {
    const body = JSON.stringify({
      artifact: input.artifact,
      command,
      directory: input.root,
      environment,
      nonce,
      timeoutMs: input.timeoutMs,
    })
    if (Buffer.byteLength(body) > 1048576) throw failure()
    await writeFile(file, windowsInstallerOwnerScript, { mode: 0o600, flag: "wx" })
    await writeFile(request, body, { mode: 0o600, flag: "wx" })
    if ((await lstat(file)).isSymbolicLink() || (await readFile(file, "utf8")) !== windowsInstallerOwnerScript)
      throw failure()
    const env = windowsReviewNativeEnvironment(input.env, root)
    const executable = win32.join(env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    const remaining = deadline - Date.now()
    if (remaining < 1) throw observedFailure("deadline", new Error("PUBLIC_UPGRADE_INSTALLER_TIMEOUT"))
    const child = (options.spawn ?? spawn)(
      executable,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        file,
        "-RequestPath",
        request,
      ],
      { cwd: input.root, env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    )
    transport = createWindowsInstallerOwnerTransport(child, nonce, remaining)
    const owner = await transport.started
    const completion = owner.completion.then(async (value) => {
      await rm(root, { recursive: true })
      return value
    })
    void completion.catch(() => {})
    return { ...owner, completion }
  } catch (error) {
    if (transport) await transport.abort()
    else await rm(root, { recursive: true })
    throw readWindowsInstallerOwnerObservation(error) ? error : observedFailure("bootstrap")
  }
}
