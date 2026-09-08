// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { ChildProcess, execFile } from "node:child_process"
import { PassThrough } from "node:stream"
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { join, win32 } from "node:path"
import { requireDisposablePublicRunner } from "./public-qualification"
import {
  createWindowsReviewRequestTransport,
  windowsReviewNativeEnvironment,
  windowsReviewScriptBootstrap,
} from "./windows-review-native"
import {
  createWindowsDirectoryObservationTransport,
  observeWindowsDirectoryDenial,
  windowsDirectoryObservation,
  windowsDirectoryObservationScript,
  windowsDirectoryProbeDefinition,
  type WindowsDirectoryRequest,
} from "./windows-directory-observation"

const input: WindowsDirectoryRequest = {
  parent: { path: "C:\\owned", dev: 5n, ino: 9007199254740993n },
  root: { path: "C:\\owned\\browser", dev: 5n, ino: 9007199254740994n },
}
const observed = {
  status: "DENIAL_OBSERVED",
  phase: "root-file-open",
  kind: "root",
  nativeStatus: "access-denied",
  ordinal: 0,
  depth: 0,
  entriesProbed: 0,
  rootReadonlyAttribute: true,
  readonlyAttribute: true,
  readonlyDirectories: 0,
  readonlyFiles: 0,
} as const

test("directory observation exposes only exact fixed metadata and rejects coercion or private fields", () => {
  const result = windowsDirectoryObservation(observed)
  expect(result).toEqual(observed)
  expect(Object.isFrozen(result)).toBe(true)
  for (const value of [
    null,
    [],
    {},
    { ...observed, path: "PRIVATE-PATH" },
    { ...observed, status: "PASS" },
    { ...observed, nativeStatus: { toString: () => "access-denied" } },
    { ...observed, ordinal: 1 },
    { ...observed, depth: 9 },
    { ...observed, entriesProbed: 129 },
    { ...observed, readonlyDirectories: 1 },
    { ...observed, readonlyAttribute: "PRIVATE" },
  ]) {
    const decoded = windowsDirectoryObservation(value)
    expect(decoded.status).toBe("UNREADABLE")
    expect(JSON.stringify(decoded)).not.toContain("PRIVATE")
    expect(JSON.stringify(decoded)).not.toContain("PASS")
  }
  expect(windowsDirectoryObservation({ ...observed, status: "NOT_LOCALIZED" }).status).toBe("NOT_LOCALIZED")
})

test("identity diagnostics preserve only fixed failing context and clear stale access and readonly claims", () => {
  const identity = {
    ...observed,
    status: "IDENTITY_UNCONFIRMED",
    phase: "metadata",
    kind: "file",
    nativeStatus: "other",
    ordinal: 2,
    depth: 2,
    entriesProbed: 2,
    rootReadonlyAttribute: false,
    readonlyAttribute: false,
    identityReason: "file-id-mismatch",
    identityScope: "entry",
  } as const
  expect(windowsDirectoryObservation(identity)).toEqual(identity)
  for (const patch of [
    { identityReason: "PRIVATE" },
    { identityScope: "PRIVATE" },
    { identityReason: { toString: () => "reparse" } },
    { identityReason: null },
    { identityScope: null },
    { nativeStatus: "access-denied" },
    { readonlyAttribute: true },
    { rootReadonlyAttribute: true },
    { readonlyDirectories: 1 },
    { readonlyFiles: 1 },
    { status: "NOT_LOCALIZED" },
  ]) {
    const value = windowsDirectoryObservation({ ...identity, ...patch })
    expect(value.status).toBe("UNREADABLE")
    expect(JSON.stringify(value)).not.toContain("PRIVATE")
  }
  expect(windowsDirectoryObservation({ ...observed, identityReason: null, identityScope: null })).toEqual(observed)
  for (const key of ["toString", "constructor", "__proto__"]) {
    const extra = JSON.parse(JSON.stringify(identity).replace(/}$/, `,"${key}":"PRIVATE"}`))
    expect(windowsDirectoryObservation(extra).status).toBe("UNREADABLE")
    expect(JSON.stringify(windowsDirectoryObservation(extra))).not.toContain("PRIVATE")
  }
})

test("reparse access observations remain a rejected identity and cannot appear on unrelated failures", () => {
  const link = {
    ...observed,
    status: "IDENTITY_UNCONFIRMED",
    phase: "metadata",
    kind: "directory",
    nativeStatus: "other",
    ordinal: 6,
    depth: 6,
    entriesProbed: 6,
    rootReadonlyAttribute: false,
    readonlyAttribute: false,
    identityReason: "reparse",
    identityScope: "entry",
    reparseTraversalStatus: "access-denied",
    reparseDeleteStatus: "success",
  } as const
  expect(windowsDirectoryObservation(link)).toEqual(link)
  for (const patch of [
    { reparseTraversalStatus: "PRIVATE" },
    { reparseDeleteStatus: "PRIVATE" },
    { reparseTraversalStatus: null },
    { reparseDeleteStatus: undefined },
    { identityReason: "file-id-mismatch" },
    { identityScope: "root" },
    { kind: "file" },
    { phase: "delete-open" },
    { status: "NOT_LOCALIZED" },
  ]) {
    const decoded = windowsDirectoryObservation({ ...link, ...patch })
    expect(decoded.status).toBe("UNREADABLE")
    expect(JSON.stringify(decoded)).not.toContain("PRIVATE")
  }
  expect(windowsDirectoryObservation({ ...observed, reparseTraversalStatus: null, reparseDeleteStatus: null })).toEqual(
    observed,
  )
})

function fixture() {
  const calls: {
    child: ChildProcess
    input: string
    timeout: number
    unreferenced: boolean
    complete(error: unknown, stdout: string, stderr: string): void
  }[] = []
  const probe = createWindowsDirectoryObservationTransport((options, complete) => {
    const child = new ChildProcess()
    Object.defineProperties(child, {
      stdin: { value: new PassThrough() },
      stdout: { value: new PassThrough() },
      stderr: { value: new PassThrough() },
    })
    const call = { child, input: "", timeout: options.timeout, unreferenced: false, complete }
    child.stdin!.on("data", (bytes) => {
      call.input += bytes.toString()
    })
    child.unref = () => {
      call.unreferenced = true
    }
    calls.push(call)
    return child
  }, 20)
  return { probe, calls }
}

test("directory query binds bigint identities and waits for actual helper close before returning observations", async () => {
  const f = fixture()
  let settled = false
  const result = f.probe(input).then((value) => {
    settled = true
    return value
  })
  const call = f.calls[0]!
  expect(JSON.parse(call.input)).toEqual({
    parent: { path: "C:\\owned", dev: "5", ino: "9007199254740993" },
    root: { path: "C:\\owned\\browser", dev: "5", ino: "9007199254740994" },
  })
  expect(call.timeout).toBe(12000)
  call.complete(undefined, JSON.stringify({ boundary: "complete", observation: observed }), "PRIVATE-IGNORED")
  await Promise.resolve()
  expect(settled).toBe(false)
  call.child.emit("close", 0)
  expect(await result).toEqual({ observation: observed, boundary: "complete", quiescence: "confirmed" })
})

test("invalid directory scope fails before spawning, and confirmed query errors never expose native text", async () => {
  const f = fixture()
  for (const bad of [
    { ...input, root: { ...input.root, path: "C:\\outside\\browser" } },
    { ...input, root: { ...input.root, path: "C:\\owned\\a\\..\\browser" } },
    { ...input, root: { ...input.root, ino: 0n } },
    { ...input, parent: { ...input.parent, dev: 0x100000000n } },
  ]) {
    expect((await f.probe(bad)).observation.status).toBe("UNREADABLE")
    expect(f.calls).toHaveLength(0)
  }
  const result = f.probe(input)
  f.calls[0]!.complete(Error("PRIVATE-PATH"), "", "PRIVATE-ERROR")
  f.calls[0]!.child.emit("close", 1)
  const value = await result
  expect(value.quiescence).toBe("confirmed")
  expect(value.observation.status).toBe("UNREADABLE")
  expect(JSON.stringify(value)).not.toContain("PRIVATE")
})

test("unconfirmed helper closure quarantines subsequent probes and late close cannot authorize cleanup", async () => {
  const f = fixture()
  const result = f.probe(input)
  f.calls[0]!.complete(undefined, JSON.stringify({ boundary: "complete", observation: observed }), "")
  const value = await result
  expect(value.quiescence).toBe("unconfirmed")
  expect(value.observation.status).toBe("UNREADABLE")
  expect(f.calls[0]!.unreferenced).toBe(true)
  expect(f.calls[0]!.child.stdin!.destroyed).toBe(true)
  f.calls[0]!.child.emit("close", 0)
  expect((await f.probe(input)).quiescence).toBe("unconfirmed")
  expect(f.calls).toHaveLength(1)
})

test("native directory adapter cannot execute locally on non-Windows, and fixed command fits CreateProcess", async () => {
  if (process.platform !== "win32")
    await expect(
      observeWindowsDirectoryDenial({ ...input, env: {}, controllerRoot: "C:\\controller" }),
    ).rejects.toThrow("WINDOWS_DIRECTORY_DIAGNOSTIC_UNAVAILABLE")
  expect(
    Buffer.from(windowsReviewScriptBootstrap(windowsDirectoryObservationScript), "utf16le").toString("base64").length +
      1024,
  ).toBeLessThan(32767)
})

test("native script and schema boundaries remain distinct without retaining private output", async () => {
  for (const boundary of ["compile", "request", "invoke", "serialize", "PRIVATE"] as const) {
    const f = fixture()
    const result = f.probe(input)
    f.calls[0]!.complete(undefined, JSON.stringify({ boundary, observation: null }), "PRIVATE")
    f.calls[0]!.child.emit("close", 0)
    const value = await result
    expect(value.boundary).toBe(boundary === "PRIVATE" ? "schema" : boundary)
    expect(value.observation.status).toBe("UNREADABLE")
    expect(value.quiescence).toBe("confirmed")
    expect(JSON.stringify(value)).not.toContain("PRIVATE")
  }
  for (const payload of [observed, { boundary: "complete", observation: { ...observed, private: "PRIVATE" } }, null]) {
    const f = fixture()
    const result = f.probe(input)
    f.calls[0]!.complete(undefined, JSON.stringify(payload), "")
    f.calls[0]!.child.emit("close", 0)
    expect((await result).boundary).toBe("schema")
  }
  const f = fixture()
  const result = f.probe(input)
  f.calls[0]!.complete(undefined, "PRIVATE-INVALID-JSON", "")
  f.calls[0]!.child.emit("close", 0)
  const value = await result
  expect(value.boundary).toBe("transport")
  expect("transportOutcome" in value && value.transportOutcome).toBe("invalid-json")
  expect(JSON.stringify(value)).not.toContain("PRIVATE")
})

// Exact production control flow with inert handle/metadata callbacks. None of
// NativeOps' P/Invokes run in this fixture, including on hosted Windows.
const inertDefinition = String.raw`
public sealed class InertDirectoryOps : DirectoryDenialProbe.Ops {
  readonly string mode;int next=10,operations=0,rootOpens=0,parentOpens=0,entryOpens=0,linkOpens=0,linkTraversals=0,linkDeletes=0;public int opened=0,closed=0,enumerated=0;
  readonly System.Collections.Generic.Dictionary<System.IntPtr,int> handles=new System.Collections.Generic.Dictionary<System.IntPtr,int>();
  public InertDirectoryOps(string value){mode=value;}
  public override long Elapsed {get{return mode=="timeout"&&operations>4?3001:0;}}
  public override uint Open(System.IntPtr parent,string name,uint access,uint options,uint attributes,out System.IntPtr handle){
    operations++;handle=System.IntPtr.Zero;
    int owner=parent==System.IntPtr.Zero?0:handles[parent];
    int node=owner==0?1:name=="browser"?2:name=="directory"?3:name=="payload"?4:name=="file"?5:
      name=="nest"?(owner<100?100:owner+1):name.StartsWith("f")?1000+int.Parse(name.Substring(1)):0;
    if(node==0)throw new System.Exception();
    bool dir=node==1||node==2||node==3||(node>=100&&node<1000);
    bool metadata=access==0x00100080&&attributes==0&&options==(dir?0x00200001u:0x00200040u);
    bool traversal=access==0x001200a9&&attributes==0x80&&options==0x00204021&&dir;
    bool deletion=access==0x00110000&&attributes==0&&options==(dir?0x00200001u:0x00200040u);
    bool initial=node==2&&access==0x00110000&&attributes==0&&options==0x00200040;
    if(!metadata&&!traversal&&!deletion&&!initial)throw new System.Exception();
    if(node==3&&mode.StartsWith("link-")){
      if(metadata&&++linkOpens>1&&mode=="link-replaced")node=333;
      if(traversal){linkTraversals++;if(mode=="link-traversal-denied")return 0xc0000022;if(mode=="link-invalid-handle")return 0;if(mode=="link-substituted-handle")node=333;}
      if(deletion){linkDeletes++;if(mode=="link-delete-denied")return 0xc0000022;}
    }
    if(initial)return mode=="root-denied"||mode=="changed-after-denial"||mode=="parent-replaced"?0xc0000022u:0xc00000bau;
    if(traversal&&node==2&&mode=="traversal-denied")return 0xc0000022;
    if(deletion&&node==4){
      if(mode=="nested-denied"||mode=="entry-replaced")return 0xc0000022;
      if(mode=="sharing")return 0xc0000043;
      if(mode=="vanished")return 0xc0000034;
    }
    if(metadata&&node==1&&++parentOpens>1&&(mode=="parent-replaced"||mode=="link-parent-replaced"))node=999;
    if(metadata&&node==2&&++rootOpens>1){
      if(mode=="namespace-open")return 0xc0000022;
      if(mode=="changed-after-denial"||mode=="ancestor-supersedes")node=999;
    }
    if(metadata&&node==4&&++entryOpens>1&&mode=="entry-replaced")node=9999;
    handle=new System.IntPtr(++next);handles.Add(handle,node);opened++;return 0;
  }
  int rootReads=0;
  public override DirectoryDenialProbe.Info Metadata(System.IntPtr handle){
    operations++;int node=handles[handle];
    if((node==4&&mode=="metadata-error")||(node==2&&mode=="namespace-read"&&rootOpens>1))throw new System.Exception();
    if(node==2)rootReads++;
    bool dir=node==1||node==2||node==3||(node>=100&&node<1000);
    uint attributes=dir?0x10u:0u;
    if(mode=="readonly"&&node!=1)attributes|=1;
    if(mode=="root-reparse"&&node==2)attributes|=0x400;
    if(mode.StartsWith("link-")&&(node==3||node==333))attributes|=0x400;
    if(mode=="link-metadata-unavailable"&&node==3)return null;
    if(mode=="kind-mismatch"&&node==3)attributes=0;
    ulong id=(ulong)node;
    if(node==2&&mode=="identity")id=999;
    if(node==2&&mode=="zero-file-id")id=0;
    return new DirectoryDenialProbe.Info{dev=mode=="volume-mismatch"?6u:5u,ino=id,attributes=attributes};
  }
  public override System.Collections.Generic.IEnumerable<DirectoryDenialProbe.Entry> Entries(System.IntPtr handle){
    enumerated++;int node=handles[handle];
    if(mode.StartsWith("link-")&&node==3)throw new System.Exception();
    if(mode=="invalid-entry"&&node==2){yield return null;}
    else if(mode=="entry-bound"&&node==2){
      for(int i=0;i<129;i++)yield return new DirectoryDenialProbe.Entry{name="f"+i,attributes=0};
    }else if(mode=="depth-bound"){
      yield return new DirectoryDenialProbe.Entry{name="nest",attributes=0x10};
    }else if(node==2){
      yield return new DirectoryDenialProbe.Entry{name="directory",attributes=mode=="entry-reparse"||mode=="ancestor-supersedes"||mode.StartsWith("link-")?0x410u:0x10u};
      yield return new DirectoryDenialProbe.Entry{name="file",attributes=0};
    }else if(node==3){
      yield return new DirectoryDenialProbe.Entry{name="payload",attributes=0};
    }
  }
  public override bool Close(System.IntPtr handle){
    if(!handles.Remove(handle))throw new System.Exception();
    closed++;return mode!="close-error"&&mode!="link-close-error";
  }
  public static bool Check(string mode){
    var io=new InertDirectoryOps(mode);
    var value=DirectoryDenialProbe.Run(io,@"C:\owned","browser",5,1,5,2);
    if(io.opened!=io.closed||io.handles.Count!=0)throw new System.Exception();
    if(value.status=="IDENTITY_UNCONFIRMED"&&(value.nativeStatus!="other"||value.rootReadonlyAttribute||value.readonlyAttribute||value.readonlyDirectories!=0||value.readonlyFiles!=0))throw new System.Exception();
    if(mode.StartsWith("link-")){
      if(io.enumerated!=1)throw new System.Exception();
      if(mode!="link-metadata-unavailable"&&(io.linkTraversals!=1||io.linkDeletes!=1))throw new System.Exception();
      bool fields=value.reparseTraversalStatus!=null||value.reparseDeleteStatus!=null;
      if(mode=="link-close-error")return value.status=="UNREADABLE"&&!fields;
      if(mode=="link-parent-replaced")return Identity(value,"file-id-mismatch","parent","root",0,0,1)&&!fields;
      if(!Identity(value,"reparse","entry","directory",1,1,1))return false;
      if(mode=="link-replaced"||mode=="link-invalid-handle"||mode=="link-metadata-unavailable"||mode=="link-substituted-handle")return !fields;
      return value.reparseTraversalStatus==(mode=="link-traversal-denied"?"access-denied":"success")&&value.reparseDeleteStatus==(mode=="link-delete-denied"?"access-denied":"success");
    }
    switch(mode){
      case "root-denied":return value.status=="DENIAL_OBSERVED"&&value.phase=="root-file-open"&&value.ordinal==0&&io.enumerated==0;
      case "traversal-denied":return value.status=="DENIAL_OBSERVED"&&value.phase=="directory-traversal"&&io.enumerated==0;
      case "nested-denied":return value.status=="DENIAL_OBSERVED"&&value.phase=="delete-open"&&value.kind=="file"&&value.ordinal==2&&value.depth==2;
      case "sharing":return value.status=="DENIAL_OBSERVED"&&value.nativeStatus=="sharing-violation";
      case "vanished":return value.status=="UNREADABLE"&&value.nativeStatus=="vanished";
      case "readonly":return value.status=="NOT_LOCALIZED"&&value.rootReadonlyAttribute&&value.readonlyDirectories==1&&value.readonlyFiles==2;
      case "entry-bound":return value.status=="BOUNDED"&&value.entriesProbed==128;
      case "depth-bound":return value.status=="BOUNDED"&&value.depth<=8;
      case "timeout":return value.status=="BOUNDED";
      case "identity":case "changed-after-denial":return Identity(value,"file-id-mismatch","root","root",0,0,0);
      case "root-reparse":return Identity(value,"reparse","root","root",0,0,0);
      case "entry-reparse":return Identity(value,"reparse","entry","directory",1,1,1);
      case "parent-replaced":return Identity(value,"file-id-mismatch","parent","root",0,0,0);
      case "entry-replaced":return Identity(value,"file-id-mismatch","entry","file",2,2,2);
      case "volume-mismatch":return Identity(value,"volume-mismatch","parent","root",0,0,0);
      case "zero-file-id":return Identity(value,"zero-file-id","root","root",0,0,0);
      case "kind-mismatch":return Identity(value,"kind-mismatch","entry","directory",1,1,1);
      case "namespace-open":case "namespace-read":return Identity(value,mode,"root","root",0,0,3);
      case "ancestor-supersedes":return Identity(value,"file-id-mismatch","root","root",0,0,1);
      case "invalid-entry":return Identity(value,"invalid-entry","root","root",0,0,0);
      case "metadata-error":case "close-error":return value.status=="UNREADABLE";
      default:return value.status=="NOT_LOCALIZED"&&value.entriesProbed==3;
    }
  }
  static bool Identity(DirectoryDenialProbe.Result value,string reason,string scope,string kind,int ordinal,int depth,int entries){
    return value.status=="IDENTITY_UNCONFIRMED"&&value.phase=="metadata"&&value.kind==kind&&value.ordinal==ordinal&&value.depth==depth&&value.entriesProbed==entries&&value.identityReason==reason&&value.identityScope==scope;
  }
}
`
const cases = [
  "clear",
  "root-denied",
  "traversal-denied",
  "nested-denied",
  "sharing",
  "vanished",
  "readonly",
  "entry-bound",
  "depth-bound",
  "timeout",
  "identity",
  "root-reparse",
  "entry-reparse",
  "changed-after-denial",
  "parent-replaced",
  "entry-replaced",
  "metadata-error",
  "close-error",
  "volume-mismatch",
  "zero-file-id",
  "kind-mismatch",
  "namespace-open",
  "namespace-read",
  "ancestor-supersedes",
  "invalid-entry",
  "link-success",
  "link-traversal-denied",
  "link-delete-denied",
  "link-replaced",
  "link-close-error",
  "link-parent-replaced",
  "link-invalid-handle",
  "link-metadata-unavailable",
  "link-substituted-handle",
] as const

test.skipIf(process.platform !== "win32" || process.env.RUNNER_ENVIRONMENT !== "github-hosted")(
  "hosted inert directory algorithm distinguishes denial phases and closes every handle without native filesystem probes",
  async () => {
    const temporary = await realpath(process.env.RUNNER_TEMP!)
    const root = await mkdtemp(join(temporary, "directory-inert-"))
    await requireDisposablePublicRunner(process.env, root)
    const environment = windowsReviewNativeEnvironment(process.env, root)
    const executable = win32.join(environment.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    const script = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules')
$phase='compile'
try {
Add-Type -TypeDefinition @'
${windowsDirectoryProbeDefinition}
${inertDefinition}
'@
  foreach($phase in @(${cases.map((value) => "'" + value + "'").join(",")})){
    if(-not [InertDirectoryOps]::Check($phase)){throw 'fixture'}
  }
  $phase='legacy-alias'
  if($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1){throw 'fixture'}
  $legacyRejected=$false
  try{$null=[ulong]'1'}catch{$legacyRejected=$true}
  if(-not $legacyRejected){throw 'fixture'}
  $phase='request-conversion'
  $r=[Console]::In.ReadLine()|ConvertFrom-Json
  foreach($anchor in @($r.parent,$r.root)){
    if(([uint64]$anchor.dev).ToString() -cne $anchor.dev -or ([uint64]$anchor.ino).ToString() -cne $anchor.ino){throw 'fixture'}
  }
  $precision='{"aboveSafe":"9007199254740993","maximum":"18446744073709551615"}'|ConvertFrom-Json
  foreach($number in @($precision.aboveSafe,$precision.maximum)){
    if(([uint64]$number).ToString() -cne $number){throw 'fixture'}
  }
  $wire=[DirectoryDenialProbe]::Run([InertDirectoryOps]::new('clear'),$r.parent.path,[IO.Path]::GetFileName($r.root.path),[uint64]$r.parent.dev,[uint64]$r.parent.ino,[uint64]$r.root.dev,[uint64]$r.root.ino)
  $phase='serialize'
  [Console]::Out.Write((@{fixtureOnly=$true;cases=${cases.length};allHandlesClosed=$true;legacyAliasRejected=$legacyRejected;requestPrecisionPreserved=$true;wire=@{boundary='complete';observation=$wire}} | ConvertTo-Json -Depth 5 -Compress))
}catch{
  [Console]::Out.Write(('{"failure":"'+$phase+'"}'))
}
`
    const args = [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(windowsReviewScriptBootstrap(script), "utf16le").toString("base64"),
    ]
    expect(executable.length * 2 + args.reduce((sum, arg) => sum + arg.length + 3, 0) + 3).toBeLessThan(32767)
    let retainRoot = true
    const transport = createWindowsReviewRequestTransport<{
      parent: { path: string; dev: string; ino: string }
      root: { path: string; dev: string; ino: string }
    }>(
      (deadline, complete) =>
        execFile(
          executable,
          args,
          {
            cwd: root,
            env: environment,
            shell: false,
            windowsHide: true,
            encoding: "utf8",
            timeout: deadline.timeout,
            maxBuffer: 8192,
          },
          complete,
        ),
      () => 12000,
    )
    try {
      // Microsoft documents [ulong] as introduced in PowerShell 6.2. This
      // exercises the production Windows PowerShell 5.1 request conversions.
      // https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_numeric_literals#numeric-type-accelerators
      const value = await transport({
        parent: { path: "C:\\owned", dev: "5", ino: "1" },
        root: { path: "C:\\owned\\browser", dev: "5", ino: "2" },
      })
      retainRoot = false
      if (value && typeof value === "object" && "failure" in value) {
        const phase = String((value as { failure: unknown }).failure)
        throw Error(
          "INERT_DIRECTORY_FIXTURE_FAILED:" +
            (["compile", "legacy-alias", "request-conversion", "serialize", ...cases].includes(
              phase as (typeof cases)[number],
            )
              ? phase
              : "unknown"),
        )
      }
      expect(value).toMatchObject({
        fixtureOnly: true,
        cases: cases.length,
        allHandlesClosed: true,
        legacyAliasRejected: true,
        requestPrecisionPreserved: true,
      })
      const f = fixture()
      const decoded = f.probe(input)
      f.calls[0]!.complete(undefined, JSON.stringify((value as { wire: unknown }).wire), "")
      f.calls[0]!.child.emit("close", 0)
      const serialized = await decoded
      expect(serialized.boundary).toBe("complete")
      expect(serialized.observation.status).toBe("NOT_LOCALIZED")
      expect(serialized.observation.entriesProbed).toBe(3)
    } finally {
      if (!retainRoot) await rm(root, { recursive: true, force: true })
    }
  },
  20000,
)

test.skipIf(process.platform !== "win32" || process.env.RUNNER_ENVIRONMENT !== "github-hosted")(
  "hosted native access probe binds real Bun file IDs and leaves inert filesystem contents unchanged",
  async () => {
    const parent = await realpath(await mkdtemp(join(await realpath(process.env.RUNNER_TEMP!), "directory-native-")))
    const root = join(parent, "browser")
    const controllerRoot = join(parent, "controller")
    let retained = true
    try {
      await Promise.all([mkdir(root), mkdir(controllerRoot)])
      await mkdir(join(root, "nested"))
      await writeFile(join(root, "nested", "inert.txt"), "immutable inert diagnostic fixture")
      const [parentStat, rootStat] = await Promise.all([lstat(parent, { bigint: true }), lstat(root, { bigint: true })])
      const request = {
        env: process.env,
        controllerRoot,
        parent: { path: parent, dev: parentStat.dev, ino: parentStat.ino },
        root: { path: root, dev: rootStat.dev, ino: rootStat.ino },
      }
      const value = await observeWindowsDirectoryDenial(request)
      retained = value.quiescence !== "confirmed"
      expect(value.quiescence).toBe("confirmed")
      console.log(
        JSON.stringify({
          inertDirectoryNativeResult: {
            boundary: value.boundary,
            status: value.observation.status,
            ...(value.transportOutcome ? { transportOutcome: value.transportOutcome } : {}),
          },
        }),
      )
      expect(value.boundary).toBe("complete")
      expect(value.observation).toEqual({
        status: "NOT_LOCALIZED",
        phase: "none",
        kind: "root",
        nativeStatus: "success",
        ordinal: 0,
        depth: 0,
        entriesProbed: 2,
        rootReadonlyAttribute: false,
        readonlyAttribute: false,
        readonlyDirectories: 0,
        readonlyFiles: 0,
      })
      expect(await readFile(join(root, "nested", "inert.txt"), "utf8")).toBe("immutable inert diagnostic fixture")
      const after = await lstat(root, { bigint: true })
      expect(after.dev).toBe(rootStat.dev)
      expect(after.ino).toBe(rootStat.ino)
    } finally {
      if (!retained) await rm(parent, { recursive: true })
    }
  },
  20000,
)

test.skipIf(process.platform !== "win32" || process.env.RUNNER_ENVIRONMENT !== "github-hosted")(
  "hosted native reparse access probe opens only the depth-six junction and preserves its foreign sentinel",
  async () => {
    const { symlink, unlink } = await import("node:fs/promises")
    const parent = await realpath(await mkdtemp(join(await realpath(process.env.RUNNER_TEMP!), "directory-link-")))
    await requireDisposablePublicRunner(process.env, parent)
    const root = join(parent, "browser")
    const controllerRoot = join(parent, "controller")
    const foreign = join(parent, "foreign")
    const directory = join(root, "one", "two", "three", "four", "five")
    const junction = join(directory, "junction")
    let retained = true
    let linkIdentity: import("node:fs").BigIntStats | undefined
    try {
      await Promise.all([mkdir(directory, { recursive: true }), mkdir(controllerRoot), mkdir(foreign)])
      await writeFile(join(foreign, "sentinel.txt"), "owned inert foreign sentinel")
      await symlink(foreign, junction, "junction")
      linkIdentity = await lstat(junction, { bigint: true })
      expect(linkIdentity.isSymbolicLink()).toBe(true)
      const [parentStat, rootStat] = await Promise.all([lstat(parent, { bigint: true }), lstat(root, { bigint: true })])
      const value = await observeWindowsDirectoryDenial({
        env: process.env,
        controllerRoot,
        parent: { path: parent, dev: parentStat.dev, ino: parentStat.ino },
        root: { path: root, dev: rootStat.dev, ino: rootStat.ino },
      })
      retained = value.quiescence !== "confirmed"
      expect(value.quiescence).toBe("confirmed")
      expect(value.boundary).toBe("complete")
      expect(value.observation).toMatchObject({
        status: "IDENTITY_UNCONFIRMED",
        identityReason: "reparse",
        identityScope: "entry",
        phase: "metadata",
        kind: "directory",
        ordinal: 6,
        depth: 6,
        entriesProbed: 6,
        reparseTraversalStatus: "success",
        reparseDeleteStatus: "success",
      })
      expect(await readFile(join(foreign, "sentinel.txt"), "utf8")).toBe("owned inert foreign sentinel")
      expect((await lstat(junction, { bigint: true })).isSymbolicLink()).toBe(true)
    } finally {
      if (!retained) {
        const current = await lstat(junction, { bigint: true })
        if (
          !linkIdentity ||
          !current.isSymbolicLink() ||
          current.dev !== linkIdentity.dev ||
          current.ino !== linkIdentity.ino
        )
          throw Error("INERT_DIRECTORY_LINK_IDENTITY_UNCONFIRMED")
        await unlink(junction)
        expect(await readFile(join(foreign, "sentinel.txt"), "utf8")).toBe("owned inert foreign sentinel")
        await rm(parent, { recursive: true })
      }
    }
  },
  20000,
)
