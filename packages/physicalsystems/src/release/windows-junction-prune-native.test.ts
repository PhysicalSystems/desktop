// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { join, win32 } from "node:path"
import { gunzipSync } from "node:zlib"
import { requireDisposablePublicRunner } from "./public-qualification"
import { windowsDirectoryProbeDefinition } from "./windows-directory-observation"
import { junctionPruneDefinition } from "./windows-junction-prune-native"
import { createWindowsJunctionPruneTransport, windowsJunctionPruneScript } from "./windows-junction-prune"
import {
  createWindowsReviewRequestTransport,
  windowsReviewNativeEnvironment,
  windowsReviewScriptBootstrap,
} from "./windows-review-native"

// These callbacks model namespace changes and handle disposition; they never
// invoke NativeOps or native mutation APIs, including on the hosted runner.
const inertDefinition = String.raw`
public sealed class InertJunctionOps : DirectoryDenialProbe.Ops {
  public sealed class Node {
    public string name;public ulong ino;public uint attributes=0x10,tag=0xa0000003;
    public bool pending;public Node parent;public List<Node> children=new List<Node>();
  }
  sealed class Handle {public Node node;public uint access;}
  readonly string mode;readonly Dictionary<IntPtr,Handle> handles=new Dictionary<IntPtr,Handle>();
  int next=100;bool altered,metadataClosed;long elapsed;
  Node parent,root,link;public int deletes,tagReads,closeCalls,opens,violations;public bool closedAfterDelete;
  public InertJunctionOps(string value){
    mode=value;parent=new Node{name=@"C:\fixture",ino=1};root=Add(parent,"browser",2,0x10);
    if(mode=="entry-bound") {for(int i=0;i<8193;i++)Add(root,"file"+i,(ulong)(i+3),0);return;}
    if(mode=="depth-bound") {var current=root;for(int i=0;i<33;i++)current=Add(current,"dir",(ulong)(i+3),0x10);return;}
    Add(root,"ordinary",3,0);var sub=Add(root,"nested",4,0x10);Add(sub,"ordinary",5,0);
    if(mode=="ordinary")return;
    link=Add(sub,"junction",6,mode=="file-link"?0x400u:0x410u);
    if(mode=="symlink")link.tag=0xa000000c;
    if(mode=="unknown-tag")link.tag=0xa000001d;
    if(mode=="zero-id")link.ino=0;
    if(mode!="file-link")Add(sub,"second",7,0x410);
  }
  static Node Add(Node parent,string name,ulong ino,uint attributes){var n=new Node{name=name,ino=ino,attributes=attributes,parent=parent};parent.children.Add(n);return n;}
  Node Replace(Node value){var n=new Node{name=value.name,ino=value.ino+100,attributes=value.attributes,parent=value.parent};if(value.parent!=null){var i=value.parent.children.IndexOf(value);value.parent.children[i]=n;}return n;}
  public override long Elapsed {get{return mode=="time-bound"?3000:elapsed;}}
  public override uint Open(IntPtr owner,string name,uint access,uint options,uint attributes,out IntPtr handle){
    opens++;handle=IntPtr.Zero;
    if((options&0x00200000)==0){violations++;throw new Exception();}
    Node node=null;
    if(owner==IntPtr.Zero){if(name==@"C:\fixture")node=parent;}
    else {
      if(!handles.ContainsKey(owner)){violations++;throw new Exception();}
      var from=handles[owner].node;if((from.attributes&0x400)!=0){violations++;throw new Exception();}
      foreach(var child in from.children)if(child.name==name){node=child;break;}
    }
    if(node==null)return 0xc0000034;
    if(mode=="delete-pending"&&node.pending)return 0xc0000056;
    if(access==0x001200a9){
      if((node.attributes&0x400)!=0){violations++;return 0xc0000022;}
      if(options!=0x00204021||attributes!=0x80){violations++;throw new Exception();}
    }else if(access==0x00110080){
      if(node!=link&&node.name!="second"){violations++;throw new Exception();}
      if(options!=0x00200001||attributes!=0){violations++;throw new Exception();}
      if(mode=="leaf-replaced"&&!altered){altered=true;node=Replace(node);}
      if(mode=="invalid-handle"){handle=new IntPtr(-1);return 0;}
      if(mode=="zero-handle")return 0;
    }else if(access!=0x00100080){violations++;throw new Exception();}
    handle=new IntPtr(next++);handles.Add(handle,new Handle{node=node,access=access});
    if(mode=="error-handle"&&access==0x00110080)return 0xc0000022;
    return 0;
  }
  public override DirectoryDenialProbe.Info Metadata(IntPtr handle){
    var n=handles[handle].node;
    var attributes=n.attributes;if(mode=="kind-mismatch"&&n==link)attributes=0x400;
    return new DirectoryDenialProbe.Info{dev=5,ino=n.ino,attributes=attributes};
  }
  public override IEnumerable<DirectoryDenialProbe.Entry> Entries(IntPtr handle){
    var n=handles[handle].node;
    if((n.attributes&0x400)!=0){violations++;throw new Exception();}
    if(mode=="invalid-name"){yield return new DirectoryDenialProbe.Entry{name="..",attributes=0x10};yield break;}
    foreach(var item in new List<Node>(n.children))yield return new DirectoryDenialProbe.Entry{name=item.name,attributes=item.attributes};
  }
  public override bool Close(IntPtr handle){
    closeCalls++;if(!handles.ContainsKey(handle)){violations++;throw new Exception();}
    var h=handles[handle];handles.Remove(handle);
    if(h.node==link&&h.access==0x00100080&&!metadataClosed){metadataClosed=true;if(mode=="early-close-failure")return false;}
    if(h.access==0x00110080&&h.node.pending){
      closedAfterDelete=true;
      if(mode!="delete-still-present"&&mode!="delete-pending")h.node.parent.children.Remove(h.node);
      if(mode=="delete-replaced")Add(h.node.parent,h.node.name,106,0x410);
      if(mode=="delete-close-failure")return false;
    }
    return true;
  }
  public JunctionPruner.TagInfo Tag(IntPtr handle){
    tagReads++;var h=handles[handle];if(h.access!=0x00110080){violations++;throw new Exception();}
    if(mode=="tag-throws")throw new Exception();
    if(!altered){
      altered=true;
      if(mode=="namespace-replaced")Replace(h.node);
      if(mode=="ancestor-replaced")Replace(root);
      if(mode=="parent-replaced")parent=Replace(parent);
      if(mode=="time-before-delete")elapsed=3000;
    }
    return new JunctionPruner.TagInfo{attributes=mode=="tag-kind"?0x10u:h.node.attributes,tag=mode=="tag-changed"&&tagReads>1?0xa000000cu:h.node.tag};
  }
  public bool Delete(IntPtr handle){
    deletes++;var h=handles[handle];
    if(h.access!=0x00110080||(h.node.attributes&0x410)!=0x410||(h.node.tag!=0xa0000003&&h.node.tag!=0xa000000c)){violations++;throw new Exception();}
    foreach(var other in handles.Values)if(other!=h&&other.node==h.node){violations++;throw new Exception();}
    if(mode=="delete-throws")throw new Exception();
    if(mode=="delete-denied")return false;
    h.node.pending=true;return true;
  }
  public sealed class Mutations : JunctionPruner.MutationOps {
    readonly InertJunctionOps io;public Mutations(InertJunctionOps value){io=value;}
    public override JunctionPruner.TagInfo Tag(IntPtr handle){return io.Tag(handle);}
    public override bool Delete(IntPtr handle){return io.Delete(handle);}
  }
  public static bool Check(string mode){
    var io=new InertJunctionOps(mode);
    var result=JunctionPruner.Run(io,new Mutations(io),@"C:\fixture","browser",5,1,5,2);
    if(io.handles.Count!=0||io.violations!=0||result.linksRemoved>result.entries)return false;
    string expected;
    switch(mode){
      case "ordinary":case "file-link":case "mountpoint":case "symlink":expected="COMPLETE";break;
      case "entry-bound":case "depth-bound":case "time-bound":case "time-before-delete":expected="BOUNDED";break;
      case "early-close-failure":case "delete-close-failure":expected="CLOSE_UNCONFIRMED";break;
      case "delete-denied":case "delete-throws":case "delete-still-present":case "delete-pending":case "delete-replaced":case "invalid-handle":case "zero-handle":case "error-handle":expected="DELETE_UNCONFIRMED";break;
      case "tag-throws":expected="UNREADABLE";break;
      default:expected="IDENTITY_UNCONFIRMED";break;
    }
    if(result.status!=expected)return false;
    if(mode=="entry-bound"&&(result.entries!=8192||io.deletes!=0))return false;
    if(mode=="depth-bound"&&(result.entries!=32||io.deletes!=0))return false;
    if(mode=="time-bound"&&(result.entries!=0||io.opens!=0))return false;
    if(mode=="mountpoint"||mode=="symlink"){
      if(result.entries!=5||result.linksRemoved!=2||io.deletes!=2||!io.closedAfterDelete)return false;
      if(io.root.children.Count!=2||io.root.children[1].children.Count!=1)return false;
    }else if(mode=="delete-denied"||mode=="delete-throws"||mode=="delete-still-present"||mode=="delete-pending"||mode=="delete-replaced"||mode=="delete-close-failure"){
      if(io.deletes!=1||result.linksRemoved!=0)return false;
    }else if(io.deletes!=0||result.linksRemoved!=0)return false;
    return true;
  }
}
`

const cases = [
  "ordinary",
  "mountpoint",
  "symlink",
  "unknown-tag",
  "file-link",
  "zero-id",
  "kind-mismatch",
  "leaf-replaced",
  "namespace-replaced",
  "ancestor-replaced",
  "parent-replaced",
  "invalid-handle",
  "zero-handle",
  "error-handle",
  "delete-denied",
  "delete-throws",
  "delete-still-present",
  "delete-pending",
  "delete-replaced",
  "early-close-failure",
  "delete-close-failure",
  "tag-throws",
  "tag-kind",
  "tag-changed",
  "invalid-name",
  "entry-bound",
  "depth-bound",
  "time-bound",
  "time-before-delete",
] as const

const script = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules')
$phase='compile'
try {
Add-Type -TypeDefinition @'
${windowsDirectoryProbeDefinition}
${junctionPruneDefinition}
${inertDefinition}
'@
  foreach($phase in @(${cases.map((value) => "'" + value + "'").join(",")})){
    if(-not [InertJunctionOps]::Check($phase)){throw 'fixture'}
  }
  [Console]::Out.Write('{"fixtureOnly":true,"cases":${cases.length},"allHandlesClosed":true,"foreignUntouched":true}')
} catch { [Console]::Out.Write(('{"failure":"'+$phase+'"}')) }
`

function args(source: string) {
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(windowsReviewScriptBootstrap(source), "utf16le").toString("base64"),
  ]
}

test("both fixed native and inert junction scripts preserve their exact definitions through the bounded bootstrap", () => {
  for (const source of [windowsJunctionPruneScript, script]) {
    const bootstrap = windowsReviewScriptBootstrap(source)
    const compressed = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(bootstrap)?.[1]
    expect(compressed).toBeDefined()
    expect(gunzipSync(Buffer.from(compressed!, "base64")).toString("utf8")).toBe(source)
    expect(args(source).reduce((sum, value) => sum + value.length + 3, 512)).toBeLessThan(32767)
  }
})

test.skipIf(process.platform !== "win32" || process.env.RUNNER_ENVIRONMENT !== "github-hosted")(
  "hosted inert junction pruner binds same-handle deletion, rejects namespace races and closes every lease",
  async () => {
    const root = await realpath(await mkdtemp(join(await realpath(process.env.RUNNER_TEMP!), "junction-inert-")))
    await requireDisposablePublicRunner(process.env, root)
    const environment = windowsReviewNativeEnvironment(process.env, root)
    const executable = win32.join(environment.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    expect(args(script).reduce((sum, value) => sum + value.length + 3, executable.length * 2 + 3)).toBeLessThan(32767)
    const transport = createWindowsReviewRequestTransport<Record<string, never>>(
      (deadline, complete) =>
        execFile(
          executable,
          args(script),
          {
            cwd: root,
            env: environment,
            windowsHide: true,
            shell: false,
            encoding: "utf8",
            timeout: deadline.timeout,
            maxBuffer: 8192,
          },
          complete,
        ),
      () => 12000,
    )
    let retained = true
    try {
      const value = await transport({})
      retained = false
      if (value && typeof value === "object" && "failure" in value) {
        const phase = (value as { failure: unknown }).failure
        throw Error(
          "INERT_JUNCTION_FIXTURE_FAILED:" +
            (typeof phase === "string" && ["compile", ...cases].includes(phase) ? phase : "unknown"),
        )
      }
      expect(value).toEqual({ fixtureOnly: true, cases: cases.length, allHandlesClosed: true, foreignUntouched: true })
    } finally {
      if (!retained) await rm(root, { recursive: true })
    }
  },
  20000,
)

test.skipIf(process.platform !== "win32" || process.env.RUNNER_ENVIRONMENT !== "github-hosted")(
  "hosted native pruner removes only the captured depth-six junction and preserves ordinary entries and foreign contents",
  async () => {
    const parent = await realpath(await mkdtemp(join(await realpath(process.env.RUNNER_TEMP!), "junction-native-")))
    await requireDisposablePublicRunner(process.env, parent)
    const root = join(parent, "browser")
    const controller = join(parent, "controller")
    const foreign = join(parent, "foreign")
    const directory = join(root, "one", "two", "three", "four", "five")
    const link = join(directory, "junction")
    let retained = true
    let linkIdentity: import("node:fs").BigIntStats | undefined
    try {
      await Promise.all([mkdir(directory, { recursive: true }), mkdir(controller), mkdir(foreign)])
      await writeFile(join(foreign, "sentinel.txt"), "inert foreign sentinel must remain")
      await writeFile(join(directory, "ordinary.txt"), "inert owned file must remain")
      await symlink(foreign, link, "junction")
      linkIdentity = await lstat(link, { bigint: true })
      expect(linkIdentity.isSymbolicLink()).toBe(true)
      const [parentStat, rootStat] = await Promise.all([lstat(parent, { bigint: true }), lstat(root, { bigint: true })])
      const environment = windowsReviewNativeEnvironment(process.env, controller)
      const executable = win32.join(environment.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      const transport = createWindowsJunctionPruneTransport((deadline, complete) =>
        execFile(
          executable,
          args(windowsJunctionPruneScript),
          {
            cwd: controller,
            env: environment,
            windowsHide: true,
            shell: false,
            encoding: "utf8",
            timeout: deadline.timeout,
            maxBuffer: 8192,
          },
          complete,
        ),
      )
      const value = await transport({
        parent: { path: parent, dev: parentStat.dev, ino: parentStat.ino },
        root: { path: root, dev: rootStat.dev, ino: rootStat.ino },
      })
      retained = value.quiescence !== "confirmed" || value.result?.status === "CLOSE_UNCONFIRMED"
      expect(value).toEqual({
        quiescence: "confirmed",
        status: "COMPLETE",
        result: { status: "COMPLETE", entries: 7, linksRemoved: 1 },
      })
      expect(
        await lstat(link).then(
          () => "present",
          (error: NodeJS.ErrnoException) => error.code,
        ),
      ).toBe("ENOENT")
      expect(await readFile(join(foreign, "sentinel.txt"), "utf8")).toBe("inert foreign sentinel must remain")
      expect(await readFile(join(directory, "ordinary.txt"), "utf8")).toBe("inert owned file must remain")
      for (const [path, before] of [
        [parent, parentStat],
        [root, rootStat],
      ] as const) {
        const after = await lstat(path, { bigint: true })
        expect(after.dev).toBe(before.dev)
        expect(after.ino).toBe(before.ino)
      }
    } finally {
      if (!retained) {
        const remaining = await lstat(link, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw Error("INERT_JUNCTION_CLEANUP_UNCONFIRMED")
        })
        if (remaining) {
          if (
            !remaining.isSymbolicLink() ||
            !linkIdentity ||
            remaining.dev !== linkIdentity.dev ||
            remaining.ino !== linkIdentity.ino
          )
            throw Error("INERT_JUNCTION_CLEANUP_UNCONFIRMED")
          await unlink(link)
        }
        expect(await readFile(join(foreign, "sentinel.txt"), "utf8")).toBe("inert foreign sentinel must remain")
        await rm(parent, { recursive: true })
      }
    }
  },
  20000,
)
