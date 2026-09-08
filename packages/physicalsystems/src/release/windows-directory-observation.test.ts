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
  readonly string mode;int next=10,operations=0,rootOpens=0,parentOpens=0,entryOpens=0;public int opened=0,closed=0,enumerated=0;
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
    if(initial)return mode=="root-denied"||mode=="changed-after-denial"||mode=="parent-replaced"?0xc0000022u:0xc00000bau;
    if(traversal&&node==2&&mode=="traversal-denied")return 0xc0000022;
    if(deletion&&node==4){
      if(mode=="nested-denied"||mode=="entry-replaced")return 0xc0000022;
      if(mode=="sharing")return 0xc0000043;
      if(mode=="vanished")return 0xc0000034;
    }
    if(metadata&&node==1&&++parentOpens>1&&mode=="parent-replaced")node=999;
    if(metadata&&node==2&&++rootOpens>1&&mode=="changed-after-denial")node=999;
    if(metadata&&node==4&&++entryOpens>1&&mode=="entry-replaced")node=9999;
    handle=new System.IntPtr(++next);handles.Add(handle,node);opened++;return 0;
  }
  int rootReads=0;
  public override DirectoryDenialProbe.Info Metadata(System.IntPtr handle){
    operations++;int node=handles[handle];
    if(node==4&&mode=="metadata-error")throw new System.Exception();
    if(node==2)rootReads++;
    bool dir=node==1||node==2||node==3||(node>=100&&node<1000);
    uint attributes=dir?0x10u:0u;
    if(mode=="readonly"&&node!=1)attributes|=1;
    if(mode=="root-reparse"&&node==2)attributes|=0x400;
    ulong id=(ulong)node;
    if(node==2&&mode=="identity")id=999;
    return new DirectoryDenialProbe.Info{dev=5,ino=id,attributes=attributes};
  }
  public override System.Collections.Generic.IEnumerable<DirectoryDenialProbe.Entry> Entries(System.IntPtr handle){
    enumerated++;int node=handles[handle];
    if(mode=="entry-bound"&&node==2){
      for(int i=0;i<129;i++)yield return new DirectoryDenialProbe.Entry{name="f"+i,attributes=0};
    }else if(mode=="depth-bound"){
      yield return new DirectoryDenialProbe.Entry{name="nest",attributes=0x10};
    }else if(node==2){
      yield return new DirectoryDenialProbe.Entry{name="directory",attributes=mode=="entry-reparse"?0x410u:0x10u};
      yield return new DirectoryDenialProbe.Entry{name="file",attributes=0};
    }else if(node==3){
      yield return new DirectoryDenialProbe.Entry{name="payload",attributes=0};
    }
  }
  public override bool Close(System.IntPtr handle){
    if(!handles.Remove(handle))throw new System.Exception();
    closed++;return mode!="close-error";
  }
  public static bool Check(string mode){
    var io=new InertDirectoryOps(mode);
    var value=DirectoryDenialProbe.Run(io,@"C:\owned","browser",5,1,5,2);
    if(io.opened!=io.closed||io.handles.Count!=0)throw new System.Exception();
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
      case "identity":case "root-reparse":case "entry-reparse":case "changed-after-denial":case "parent-replaced":case "entry-replaced":return value.status=="IDENTITY_UNCONFIRMED"&&value.entriesProbed==0;
      case "metadata-error":case "close-error":return value.status=="UNREADABLE";
      default:return value.status=="NOT_LOCALIZED"&&value.entriesProbed==3;
    }
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
  [Console]::Out.Write((@{fixtureOnly=$true;cases=18;allHandlesClosed=$true;legacyAliasRejected=$legacyRejected;requestPrecisionPreserved=$true;wire=@{boundary='complete';observation=$wire}} | ConvertTo-Json -Depth 5 -Compress))
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
        cases: 18,
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
