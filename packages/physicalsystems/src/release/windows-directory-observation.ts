// SPDX-License-Identifier: Apache-2.0
import { execFile } from "node:child_process"
import { lstat, readdir, realpath } from "node:fs/promises"
import { win32 } from "node:path"
import { readBrowserObservation } from "./browser-observation"
import { requireDisposablePublicRunner } from "./public-qualification"
import {
  createWindowsReviewRequestTransport,
  windowsReviewNativeEnvironment,
  windowsReviewScriptBootstrap,
} from "./windows-review-native"

export type WindowsDirectoryAnchor = Readonly<{ path: string; dev: bigint; ino: bigint }>
export type WindowsDirectoryRequest = { root: WindowsDirectoryAnchor; parent: WindowsDirectoryAnchor }
const statuses = ["DENIAL_OBSERVED", "NOT_LOCALIZED", "BOUNDED", "UNREADABLE", "IDENTITY_UNCONFIRMED"] as const
const phases = ["root-file-open", "directory-traversal", "delete-open", "metadata", "none"] as const
const kinds = ["root", "directory", "file"] as const
const nativeStatuses = [
  "success",
  "is-directory",
  "access-denied",
  "cannot-delete",
  "sharing-violation",
  "delete-pending",
  "vanished",
  "other",
] as const
export type WindowsDirectoryObservation = Readonly<{
  status: (typeof statuses)[number]
  phase: (typeof phases)[number]
  kind: (typeof kinds)[number]
  nativeStatus: (typeof nativeStatuses)[number]
  ordinal: number
  depth: number
  entriesProbed: number
  rootReadonlyAttribute: boolean
  readonlyAttribute: boolean
  readonlyDirectories: number
  readonlyFiles: number
}>
const unavailable = (): WindowsDirectoryObservation =>
  Object.freeze({
    status: "UNREADABLE",
    phase: "none",
    kind: "root",
    nativeStatus: "other",
    ordinal: 0,
    depth: 0,
    entriesProbed: 0,
    rootReadonlyAttribute: false,
    readonlyAttribute: false,
    readonlyDirectories: 0,
    readonlyFiles: 0,
  })

/** Unknown native output never becomes a public path or an authority decision. */
export function windowsDirectoryObservation(value: unknown): WindowsDirectoryObservation {
  return decodedObservation(value) ?? unavailable()
}

function decodedObservation(value: unknown): WindowsDirectoryObservation | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return
    const row = value as Record<string, unknown>
    const shape = unavailable()
    if (Object.keys(row).length !== Object.keys(shape).length || Object.keys(row).some((key) => !(key in shape))) return
    for (const [key, allowed] of Object.entries({
      status: statuses,
      phase: phases,
      kind: kinds,
      nativeStatus: nativeStatuses,
    }))
      if (typeof row[key] !== "string" || !(allowed as readonly string[]).includes(row[key] as string)) return
    for (const key of ["ordinal", "depth", "entriesProbed", "readonlyDirectories", "readonlyFiles"])
      if (
        typeof row[key] !== "number" ||
        !Number.isInteger(row[key]) ||
        row[key] < 0 ||
        row[key] > (key === "depth" ? 8 : 128)
      )
        return
    if (
      typeof row.rootReadonlyAttribute !== "boolean" ||
      typeof row.readonlyAttribute !== "boolean" ||
      (row.ordinal as number) > (row.entriesProbed as number) ||
      (row.readonlyDirectories as number) + (row.readonlyFiles as number) > (row.entriesProbed as number)
    )
      return
    return Object.freeze({ ...row }) as WindowsDirectoryObservation
  } catch {
    return
  }
}

const boundaries = ["complete", "compile", "request", "invoke", "serialize", "schema", "transport"] as const
export type WindowsDirectoryBoundary = (typeof boundaries)[number]
type DirectoryTransportOutcome = "output-limit" | "timeout" | "signal" | "exit" | "start" | "unknown" | "invalid-json"
export type WindowsDirectoryDiagnosticResult = {
  observation: WindowsDirectoryObservation
  boundary: WindowsDirectoryBoundary
  quiescence: "confirmed" | "unconfirmed"
  transportOutcome?: DirectoryTransportOutcome
}
function envelope(value: unknown): { observation: WindowsDirectoryObservation; boundary: WindowsDirectoryBoundary } {
  const invalid = () => ({ observation: unavailable(), boundary: "schema" as const })
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid()
  const row = value as Record<string, unknown>
  if (
    Object.keys(row).length !== 2 ||
    !Object.hasOwn(row, "observation") ||
    typeof row.boundary !== "string" ||
    !(boundaries as readonly string[]).includes(row.boundary)
  )
    return invalid()
  if (row.boundary === "complete") {
    const observation = decodedObservation(row.observation)
    return observation ? { observation, boundary: "complete" } : invalid()
  }
  if (!["compile", "request", "invoke", "serialize"].includes(row.boundary) || row.observation !== null)
    return invalid()
  return { observation: unavailable(), boundary: row.boundary as WindowsDirectoryBoundary }
}

function request(value: WindowsDirectoryRequest) {
  const anchor = (item: WindowsDirectoryAnchor) => {
    if (
      !item ||
      typeof item.path !== "string" ||
      item.path.length > 2048 ||
      !/^[A-Za-z]:\\[^:\r\n\0"]+$/.test(item.path) ||
      win32.normalize(item.path) !== item.path ||
      typeof item.dev !== "bigint" ||
      item.dev < 0n ||
      item.dev > 0xffffffffn ||
      typeof item.ino !== "bigint" ||
      item.ino < 1n ||
      item.ino > 0xffffffffffffffffn
    )
      throw Error()
    return { path: item.path, dev: item.dev.toString(), ino: item.ino.toString() }
  }
  const root = anchor(value.root),
    parent = anchor(value.parent)
  if (win32.dirname(root.path) !== parent.path || root.path === parent.path) throw Error()
  return { root, parent }
}

/** Fixed access probes, matching Bun 1.3.14's pinned Zig DeleteFile/openDirW.
 * FILE_OPEN only. No disposition, delete-on-close, permission or content APIs.
 * Ops is an inert hosted-test seam; production always constructs NativeOps. */
export const windowsDirectoryProbeDefinition = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class DirectoryDenialProbe {
  public sealed class Result {
    public string status="NOT_LOCALIZED", phase="none", kind="root", nativeStatus="success";
    public int ordinal=0, depth=0, entriesProbed=0, readonlyDirectories=0, readonlyFiles=0;
    public bool rootReadonlyAttribute=false, readonlyAttribute=false;
  }
  public sealed class Info { public ulong dev, ino; public uint attributes; }
  public sealed class Entry { public string name; public uint attributes; }
  public abstract class Ops {
    public abstract uint Open(IntPtr parent,string name,uint access,uint options,uint attributes,out IntPtr handle);
    public abstract Info Metadata(IntPtr handle);
    public abstract IEnumerable<Entry> Entries(IntPtr handle);
    public abstract bool Close(IntPtr handle);
    public abstract long Elapsed { get; }
  }
  sealed class Stop : Exception { public string status; public Stop(string value){status=value;} }
  sealed class Lease : IDisposable {
    readonly State state; public IntPtr handle;
    public Lease(State s,IntPtr h){state=s;handle=h;}
    public void Dispose(){if(handle==IntPtr.Zero)return;var h=handle;handle=IntPtr.Zero;try{if(!state.io.Close(h))state.closeFailed=true;}catch{state.closeFailed=true;}}
  }
  sealed class State {
    public Ops io; public Result result=new Result(); public bool closeFailed;
    public State(Ops value){io=value;}
    public void Bound(){if(io.Elapsed>=3000)throw new Stop("BOUNDED");}
    public void At(string phase,string kind,int ordinal,int depth){result.phase=phase;result.kind=kind;result.ordinal=ordinal;result.depth=depth;result.readonlyAttribute=false;}
    public Lease Open(IntPtr parent,string name,uint access,uint options,uint attributes,bool expectedDirectory=false){
      Bound();IntPtr handle;uint code=io.Open(parent,name,access,options,attributes,out handle);
      result.nativeStatus=Status(code);
      if(code==0){if(handle==IntPtr.Zero||handle==new IntPtr(-1))throw new Stop("UNREADABLE");return new Lease(this,handle);}
      if(expectedDirectory&&code==0xc00000ba)return null;
      if(code==0xc0000022||code==0xc0000121||code==0xc0000043)throw new Stop("DENIAL_OBSERVED");
      throw new Stop("UNREADABLE");
    }
    public Info Check(Lease lease,ulong? dev=null,ulong? ino=null,bool? directory=null){
      Bound();var info=io.Metadata(lease.handle);
      if(info==null||info.ino==0||(info.attributes&0x400)!=0||
        (dev.HasValue&&info.dev!=dev.Value)||(ino.HasValue&&info.ino!=ino.Value)||
        (directory.HasValue&&((info.attributes&0x10)!=0)!=directory.Value))throw new Stop("IDENTITY_UNCONFIRMED");
      return info;
    }
    public void Rebind(IntPtr parent,string name,Info expected,bool directory){
      var status=result.nativeStatus;
      try{
        using(var current=Open(parent,name,0x00100080,directory?0x00200001u:0x00200040u,0)){
          Check(current,expected.dev,expected.ino,directory);
        }
      }catch(Stop stop){if(stop.status=="BOUNDED")throw;throw new Stop("IDENTITY_UNCONFIRMED");}
      catch{throw new Stop("IDENTITY_UNCONFIRMED");}
      result.nativeStatus=status;
    }
    public void Walk(Lease directory,Info anchor,int depth){
      foreach(var entry in io.Entries(directory.handle)){
        Bound();
        if(entry==null||String.IsNullOrEmpty(entry.name)||entry.name=="."||entry.name==".."||
          entry.name.Length>255||entry.name.IndexOfAny(new char[]{'\\','/','\0',':'})>=0)throw new Stop("IDENTITY_UNCONFIRMED");
        if(result.entriesProbed>=128||depth>=8)throw new Stop("BOUNDED");
        var ordinal=++result.entriesProbed;var isDir=(entry.attributes&0x10)!=0;var kind=isDir?"directory":"file";
        At("metadata",kind,ordinal,depth+1);
        if((entry.attributes&0x400)!=0)throw new Stop("IDENTITY_UNCONFIRMED");
        using(var item=Open(directory.handle,entry.name,0x00100080,isDir?0x00200001u:0x00200040u,0)){
          var identity=Check(item,null,null,isDir);
          if((identity.attributes&1)!=0){if(isDir)result.readonlyDirectories++;else result.readonlyFiles++;}
          try{
            if(isDir){
              At("directory-traversal",kind,ordinal,depth+1);
              result.readonlyAttribute=(identity.attributes&1)!=0;
              using(var child=Open(directory.handle,entry.name,0x001200a9,0x00204021,0x80)){
                Check(child,identity.dev,identity.ino,true);
                Walk(child,identity,depth+1);
                Check(child,identity.dev,identity.ino,true);
              }
            }
            At("delete-open",kind,ordinal,depth+1);
            result.readonlyAttribute=(identity.attributes&1)!=0;
            using(var deleting=Open(directory.handle,entry.name,0x00110000,isDir?0x00200001u:0x00200040u,0)){}
          }finally{
            Rebind(directory.handle,entry.name,identity,isDir);
          }
        }
        Check(directory,anchor.dev,anchor.ino,true);
      }
    }
  }
  static string Status(uint status){
    switch(status){
      case 0:return "success";case 0xc00000ba:return "is-directory";
      case 0xc0000022:return "access-denied";case 0xc0000121:return "cannot-delete";
      case 0xc0000043:return "sharing-violation";case 0xc0000056:return "delete-pending";
      case 0xc0000034:case 0xc000003a:case 0xc0000123:return "vanished";default:return "other";
    }
  }
  public static Result Run(Ops ops,string parentPath,string rootName,ulong parentDev,ulong parentIno,ulong rootDev,ulong rootIno){
    var s=new State(ops);
    try{
      s.At("metadata","root",0,0);
      using(var parent=s.Open(IntPtr.Zero,parentPath,0x00100080,0x00200001,0)){
        var parentIdentity=s.Check(parent,parentDev,parentIno,true);
        using(var root=s.Open(parent.handle,rootName,0x00100080,0x00200001,0)){
          var identity=s.Check(root,rootDev,rootIno,true);
          s.result.rootReadonlyAttribute=(identity.attributes&1)!=0;
          try{
            s.At("root-file-open","root",0,0);
            s.result.readonlyAttribute=s.result.rootReadonlyAttribute;
            using(var unexpected=s.Open(parent.handle,rootName,0x00110000,0x00200040,0,true)){
              if(unexpected!=null)throw new Stop("IDENTITY_UNCONFIRMED");
            }
            s.At("directory-traversal","root",0,0);
            s.result.readonlyAttribute=s.result.rootReadonlyAttribute;
            using(var directory=s.Open(parent.handle,rootName,0x001200a9,0x00204021,0x80)){
              s.Check(directory,rootDev,rootIno,true);
              s.Walk(directory,identity,0);
            }
            s.At("delete-open","root",0,0);
            s.result.readonlyAttribute=s.result.rootReadonlyAttribute;
            using(var deleting=s.Open(parent.handle,rootName,0x00110000,0x00200001,0)){}
            s.At("none","root",0,0);s.result.nativeStatus="success";
          } finally {
            s.Rebind(parent.handle,rootName,identity,true);
            s.Rebind(IntPtr.Zero,parentPath,parentIdentity,true);
          }
        }
      }
    }catch(Stop stop){s.result.status=stop.status;}catch{s.result.status="UNREADABLE";s.result.nativeStatus="other";}
    if(s.closeFailed){s.result.status="UNREADABLE";s.result.nativeStatus="other";}
    if(s.result.status=="IDENTITY_UNCONFIRMED")return new Result{status="IDENTITY_UNCONFIRMED",phase="metadata",nativeStatus="other"};
    return s.result;
  }
  public sealed class NativeOps : Ops {
    readonly Stopwatch clock=Stopwatch.StartNew();
    public override long Elapsed {get{return clock.ElapsedMilliseconds;}}
    [StructLayout(LayoutKind.Sequential)] struct UnicodeString {public ushort Length,MaximumLength;public IntPtr Buffer;}
    [StructLayout(LayoutKind.Sequential)] struct ObjectAttributes {public int Length;public IntPtr RootDirectory,ObjectName;public uint Attributes;public IntPtr SecurityDescriptor,SecurityQualityOfService;}
    [StructLayout(LayoutKind.Sequential)] struct IoStatus {public IntPtr Status,Information;}
    [StructLayout(LayoutKind.Sequential)] struct FileInfo {public uint Attributes;public System.Runtime.InteropServices.ComTypes.FILETIME Creation,Access,Write;public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;}
    [DllImport("ntdll.dll")] static extern uint NtCreateFile(out IntPtr handle,uint access,ref ObjectAttributes attributes,out IoStatus io,IntPtr allocation,uint fileAttributes,uint share,uint disposition,uint options,IntPtr ea,uint eaLength);
    [DllImport("ntdll.dll")] static extern uint NtQueryDirectoryFile(IntPtr handle,IntPtr e,IntPtr apc,IntPtr context,out IoStatus io,IntPtr buffer,uint length,int information,byte single,IntPtr name,byte restart);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr handle,out FileInfo info);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    public override uint Open(IntPtr parent,string name,uint access,uint options,uint attributes,out IntPtr handle){
      var text=parent==IntPtr.Zero?@"\??\"+name:name;
      var buffer=Marshal.StringToHGlobalUni(text);var pointer=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString)));
      try{
        var str=new UnicodeString{Length=checked((ushort)(text.Length*2)),MaximumLength=checked((ushort)(text.Length*2)),Buffer=buffer};
        Marshal.StructureToPtr(str,pointer,false);
        var attr=new ObjectAttributes{Length=Marshal.SizeOf(typeof(ObjectAttributes)),RootDirectory=parent,ObjectName=pointer};
        IoStatus io;return NtCreateFile(out handle,access,ref attr,out io,IntPtr.Zero,attributes,7,1,options,IntPtr.Zero,0);
      }finally{Marshal.FreeHGlobal(pointer);Marshal.FreeHGlobal(buffer);}
    }
    public override Info Metadata(IntPtr handle){
      FileInfo info;if(!GetFileInformationByHandle(handle,out info))throw new Exception();
      return new Info{dev=info.Volume,ino=((ulong)info.IndexHigh<<32)|info.IndexLow,attributes=info.Attributes};
    }
    public override bool Close(IntPtr handle){return CloseHandle(handle);}
    public override IEnumerable<Entry> Entries(IntPtr handle){
      var buffer=Marshal.AllocHGlobal(65536);byte restart=1;
      try{
        while(true){
          IoStatus io;var status=NtQueryDirectoryFile(handle,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,out io,buffer,65536,1,1,IntPtr.Zero,restart);restart=0;
          if(status==0x80000006)yield break;
          if(status!=0||io.Information.ToInt64()<64||io.Information.ToInt64()>65536)throw new Exception();
          var length=Marshal.ReadInt32(buffer,60);
          if(length<2||length>510||length%2!=0||64+length>io.Information.ToInt64())throw new Exception();
          var name=Marshal.PtrToStringUni(IntPtr.Add(buffer,64),length/2);
          if(name=="."||name=="..")continue;
          yield return new Entry{name=name,attributes=unchecked((uint)Marshal.ReadInt32(buffer,56))};
        }
      }finally{Marshal.FreeHGlobal(buffer);}
    }
  }
}
`

export const windowsDirectoryObservationScript = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules')
$boundary='compile'
try {
Add-Type -TypeDefinition @'
${windowsDirectoryProbeDefinition}
'@
  $boundary='request'
  $line=[Console]::In.ReadLine()
  if($null -eq $line -or $line.Length -gt 16384){throw 'request'}
  $r=$line | ConvertFrom-Json
  $boundary='invoke'
  $result=[DirectoryDenialProbe]::Run([DirectoryDenialProbe+NativeOps]::new(),$r.parent.path,[IO.Path]::GetFileName($r.root.path),[ulong]$r.parent.dev,[ulong]$r.parent.ino,[ulong]$r.root.dev,[ulong]$r.root.ino)
  $boundary='serialize'
  [Console]::Out.Write((@{boundary='complete';observation=$result} | ConvertTo-Json -Depth 4 -Compress))
} catch { [Console]::Out.Write(('{"boundary":"'+$boundary+'","observation":null}')) }
`

export function createWindowsDirectoryObservationTransport(
  execute: Parameters<typeof createWindowsReviewRequestTransport>[0],
  closeTimeoutMs = 500,
) {
  const native = createWindowsReviewRequestTransport<ReturnType<typeof request>>(execute, () => 12000, closeTimeoutMs)
  return async (input: WindowsDirectoryRequest): Promise<WindowsDirectoryDiagnosticResult> => {
    let validated: ReturnType<typeof request>
    try {
      validated = request(input)
    } catch {
      return { observation: unavailable(), boundary: "request" as const, quiescence: "confirmed" as const }
    }
    try {
      return { ...envelope(await native(validated)), quiescence: "confirmed" as const }
    } catch (error) {
      return {
        observation: unavailable(),
        boundary: "transport" as const,
        transportOutcome: (readBrowserObservation(error)?.windowsNativeOutcome ??
          "unknown") as DirectoryTransportOutcome,
        quiescence:
          readBrowserObservation(error)?.handoffQuiescence === "unconfirmed"
            ? ("unconfirmed" as const)
            : ("confirmed" as const),
      }
    }
  }
}

/** Caller owns controllerRoot and may remove it only after confirmed close.
 * A successful diagnostic never clears the original removal failure. */
export async function observeWindowsDirectoryDenial(
  input: WindowsDirectoryRequest & {
    env: NodeJS.ProcessEnv
    controllerRoot: string
  },
) {
  try {
    if (process.platform !== "win32") throw Error("WINDOWS_DIRECTORY_DIAGNOSTIC_UNAVAILABLE")
    request(input)
    await requireDisposablePublicRunner(input.env, input.controllerRoot)
    await requireDisposablePublicRunner(input.env, input.root.path)
    const controller = await realpath(input.controllerRoot)
    const inspected = await realpath(input.root.path)
    const relation = win32.relative(inspected, controller)
    if (
      !relation ||
      (!win32.isAbsolute(relation) && relation !== ".." && !relation.startsWith("..\\")) ||
      (await readdir(controller)).length ||
      (await lstat(controller)).isSymbolicLink()
    )
      throw Error("WINDOWS_DIRECTORY_DIAGNOSTIC_UNAVAILABLE")
    const environment = windowsReviewNativeEnvironment(input.env, controller)
    const executable = win32.join(environment.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    const args = [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(windowsReviewScriptBootstrap(windowsDirectoryObservationScript), "utf16le").toString("base64"),
    ]
    if (executable.length * 2 + 3 + args.reduce((sum, arg) => sum + arg.length + 3, 0) > 32767)
      throw Error("WINDOWS_DIRECTORY_DIAGNOSTIC_UNAVAILABLE")
    return await createWindowsDirectoryObservationTransport((deadline, complete) =>
      execFile(
        executable,
        args,
        {
          cwd: controller,
          env: environment,
          shell: false,
          windowsHide: true,
          encoding: "utf8",
          maxBuffer: 16384,
          timeout: deadline.timeout,
        },
        complete,
      ),
    )(input)
  } catch {
    throw Error("WINDOWS_DIRECTORY_DIAGNOSTIC_UNAVAILABLE")
  }
}
