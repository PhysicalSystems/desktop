// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { join, win32 } from "node:path"
import { previewUpdateWindowsCommandLinks } from "./preview-update-windows"
import { requireDisposablePublicRunner } from "./public-qualification"
import { createWindowsReviewRequestTransport, windowsReviewNativeEnvironment } from "./windows-review-native"

// This fixture never loads Electron or an installer. A separate PowerShell
// process owns exactly one inert TaskDialog, and only its own HWND is passed to
// the production selector. No global input or desktop window search is used.
const hostedWindows =
  process.platform === "win32" &&
  process.arch === "x64" &&
  process.env.CI === "true" &&
  process.env.GITHUB_ACTIONS === "true" &&
  process.env.RUNNER_ENVIRONMENT === "github-hosted" &&
  process.env.RUNNER_OS === "Windows" &&
  process.env.GITHUB_REPOSITORY === "PhysicalSystems/desktop"

const manifest = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity version="1.0.0.0" processorArchitecture="amd64" name="PhysicalSystems.InertTaskDialogTest" type="win32"/>
  <dependency><dependentAssembly><assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="amd64" publicKeyToken="6595b64144ccf1df" language="*"/></dependentAssembly></dependency>
</assembly>`

// TASKDIALOGCONFIG and TASKDIALOG_BUTTON use one-byte packing in the SDK:
// https://github.com/microsoft/win32metadata/blob/main/generation/WinSDK/RecompiledIdlHeaders/um/CommCtrl.h
// Explicit activation avoids depending on PowerShell's own visual-style manifest.
const fixture = String.raw`
namespace PreviewUpdateFixture {
  using System;
  using System.Diagnostics;
  using System.Runtime.InteropServices;
  using System.Threading;
  public static class TaskDialog {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    struct Activation {
      public uint Size, Flags;
      public string Source;
      public ushort Architecture, Language;
      public string Directory, Resource, Application;
      public IntPtr Module;
    }
    [StructLayout(LayoutKind.Sequential, Pack=1)]
    struct Button { public int Id; public IntPtr Text; }
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int Callback(IntPtr window, uint notification, UIntPtr w, IntPtr l, IntPtr data);
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode, Pack=1)]
    struct Config {
      public uint Size;
      public IntPtr Parent, Instance;
      public uint Flags, CommonButtons;
      public string Title;
      public IntPtr MainIcon;
      public string Instruction, Content;
      public uint ButtonCount;
      public IntPtr Buttons;
      public int DefaultButton;
      public uint RadioCount;
      public IntPtr Radios;
      public int DefaultRadio;
      public string Verification, Expanded, ExpandedControl, CollapsedControl;
      public IntPtr FooterIcon;
      public string Footer;
      public Callback Notify;
      public IntPtr Data;
      public uint Width;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateActCtx(ref Activation context);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool ActivateActCtx(IntPtr context, out UIntPtr cookie);
    [DllImport("kernel32.dll")] static extern bool DeactivateActCtx(uint flags, UIntPtr cookie);
    [DllImport("kernel32.dll")] static extern void ReleaseActCtx(IntPtr context);
    [DllImport("comctl32.dll", CharSet=CharSet.Unicode)] static extern int TaskDialogIndirect(ref Config config, out int button, out int radio, out bool verification);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    static IntPtr dialog;
    static volatile bool timedOut, nativeFailed;
    static int selected;
    static readonly Callback notify = OnNotification;
    public static string Phase = "start";
    public static PreviewUpdateCommandLink.Facts InstallFacts, LaterFacts;
    static int OnNotification(IntPtr window, uint message, UIntPtr w, IntPtr l, IntPtr data) {
      if(message==0) Interlocked.Exchange(ref dialog,window); // TDN_CREATED
      if(message==5) Interlocked.Exchange(ref dialog,IntPtr.Zero); // TDN_DESTROYED
      if(message==4 && w.ToUInt64()>=10000) { // TDN_TIMER
        timedOut=true;
        PostMessage(window,0x0010,IntPtr.Zero,IntPtr.Zero);
      }
      return 0;
    }
    static IntPtr Window() { return Interlocked.CompareExchange(ref dialog,IntPtr.Zero,IntPtr.Zero); }
    static void Show(string manifest) {
      IntPtr context=IntPtr.Zero, buttons=IntPtr.Zero, install=IntPtr.Zero, later=IntPtr.Zero;
      UIntPtr cookie=UIntPtr.Zero;
      bool activated=false;
      try {
        var activation=new Activation { Size=(uint)Marshal.SizeOf(typeof(Activation)), Source=manifest };
        context=CreateActCtx(ref activation);
        if(context==new IntPtr(-1)) throw new InvalidOperationException();
        if(!ActivateActCtx(context,out cookie)) throw new InvalidOperationException();
        activated=true;
        int size=Marshal.SizeOf(typeof(Button));
        install=Marshal.StringToHGlobalUni("Install update"); later=Marshal.StringToHGlobalUni("Later");
        buttons=Marshal.AllocHGlobal(size*2);
        Marshal.StructureToPtr(new Button { Id=100, Text=install },buttons,false);
        Marshal.StructureToPtr(new Button { Id=101, Text=later },IntPtr.Add(buttons,size),false);
        var config=new Config {
          Size=(uint)Marshal.SizeOf(typeof(Config)),
          Flags=0x0010|0x0008|0x0800, // Command links, cancellation, bounded callback timer.
          Title="Physical Systems inert updater command-link test",
          Instruction="Install Physical Systems 0.1.0-beta.7 now?",
          Content="This dialog belongs only to the disposable native-control fixture.",
          ButtonCount=2, Buttons=buttons, DefaultButton=101, Notify=notify
        };
        int radio; bool verification;
        if(TaskDialogIndirect(ref config,out selected,out radio,out verification)!=0) nativeFailed=true;
      } catch { nativeFailed=true; }
      finally {
        Interlocked.Exchange(ref dialog,IntPtr.Zero);
        if(buttons!=IntPtr.Zero) Marshal.FreeHGlobal(buttons);
        if(install!=IntPtr.Zero) Marshal.FreeHGlobal(install);
        if(later!=IntPtr.Zero) Marshal.FreeHGlobal(later);
        if(activated) DeactivateActCtx(0,cookie);
        if(context!=IntPtr.Zero && context!=new IntPtr(-1)) ReleaseActCtx(context);
      }
    }
    public static int Run(string manifest, int choice) {
      if(choice!=100 && choice!=101) throw new InvalidOperationException();
      timedOut=false; nativeFailed=false; selected=0;
      InstallFacts=null; LaterFacts=null;
      uint pid=(uint)Process.GetCurrentProcess().Id;
      var thread=new Thread(delegate() { Show(manifest); });
      thread.IsBackground=true;
      thread.SetApartmentState(ApartmentState.STA);
      thread.Start();
      try {
        Phase="ready";
        var clock=Stopwatch.StartNew();
        PreviewUpdateCommandLink.Facts install=null, later=null;
        IntPtr window=IntPtr.Zero;
        while(clock.ElapsedMilliseconds<8000 && thread.IsAlive && !nativeFailed) {
          window=Window();
          if(window!=IntPtr.Zero) {
            install=InstallFacts=PreviewUpdateCommandLink.Read(window,pid,100);
            later=LaterFacts=PreviewUpdateCommandLink.Read(window,pid,101);
            if(install.Ready && later.Ready) break;
          }
          Thread.Sleep(25);
        }
        if(nativeFailed || install==null || later==null || !install.Ready || !later.Ready || install.Handle==later.Handle)
          throw new InvalidOperationException();
        Phase="ownership";
        if(PreviewUpdateCommandLink.Read(window,UInt32.MaxValue,101).Ready) throw new InvalidOperationException();
        bool rejected=false;
        try { PreviewUpdateCommandLink.Click(window,pid,101,install.Handle); }
        catch(InvalidOperationException) { rejected=true; }
        if(!rejected) throw new InvalidOperationException();
        Phase="click";
        PreviewUpdateCommandLink.Click(window,pid,choice,choice==101?later.Handle:install.Handle);
        Phase="result";
        if(!thread.Join(3000) || nativeFailed || timedOut || selected!=choice) throw new InvalidOperationException();
        Phase="complete";
        return selected;
      } finally {
        if(thread.IsAlive) {
          IntPtr window=Window(); uint actual;
          if(window!=IntPtr.Zero && GetWindowThreadProcessId(window,out actual)!=0 && actual==pid)
            PostMessage(window,0x0010,IntPtr.Zero,IntPtr.Zero);
          thread.Join(2000);
        }
      }
    }
  }
}
`

test.skipIf(!hostedWindows)(
  "hosted Windows selects owned native command links and observes actual Later and Install results",
  async () => {
    const root = await mkdtemp(join(await realpath(process.env.RUNNER_TEMP!), "preview-update-command-links-"))
    await requireDisposablePublicRunner(process.env, root)
    const manifestPath = join(root, "task-dialog.manifest")
    await writeFile(manifestPath, manifest, { flag: "wx", mode: 0o600 })
    const environment = windowsReviewNativeEnvironment(process.env, root)
    const command = win32.join(environment.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    const script = String.raw`
$ErrorActionPreference='Stop'
$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules')
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$phase='compile'
function Read-FixtureFacts($facts) {
  if($null -eq $facts){return @{observed=$false}}
  return @{observed=$true;found=$facts.Found;owned=$facts.Owned;child=$facts.Child;class=$facts.ClassMatches;style=$facts.StyleMatches;text=$facts.TextMatches;enabled=$facts.Enabled;visible=$facts.Visible}
}
trap {
  $diagnostics=@{}
  if('PreviewUpdateFixture.TaskDialog' -as [type]){
    $phase=[PreviewUpdateFixture.TaskDialog]::Phase
    $diagnostics.install=Read-FixtureFacts ([PreviewUpdateFixture.TaskDialog]::InstallFacts)
    $diagnostics.later=Read-FixtureFacts ([PreviewUpdateFixture.TaskDialog]::LaterFacts)
  }
  [Console]::Out.Write((ConvertTo-Json -InputObject @{status='failed';phase=$phase;diagnostics=$diagnostics} -Compress -Depth 4));exit 0
}
$request=ConvertFrom-Json -InputObject ([Console]::In.ReadLine())
Add-Type -TypeDefinition $request.source
$later=[PreviewUpdateFixture.TaskDialog]::Run($request.manifest,101)
$install=[PreviewUpdateFixture.TaskDialog]::Run($request.manifest,100)
[int[]]$selected=@($later,$install)
[Console]::Out.Write((ConvertTo-Json -InputObject @{status='complete';selected=$selected;ownershipRejected=$true;changedHandleRejected=$true} -Compress))
`
    let closed = false
    const native = createWindowsReviewRequestTransport<{ source: string; manifest: string }>(
      (deadline, complete) =>
        execFile(
          command,
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Mta",
            "-EncodedCommand",
            Buffer.from(script, "utf16le").toString("base64"),
          ],
          {
            cwd: root,
            env: environment,
            shell: false,
            windowsHide: true,
            encoding: "utf8",
            maxBuffer: 8192,
            timeout: deadline.timeout,
          },
          complete,
        ),
      () => 30000,
    )
    try {
      const result = await native({ source: previewUpdateWindowsCommandLinks + fixture, manifest: manifestPath })
      closed = true
      expect(result).toEqual({
        status: "complete",
        selected: [101, 100],
        ownershipRejected: true,
        changedHandleRejected: true,
      })
    } finally {
      if (closed) await rm(root, { recursive: true, force: true })
    }
  },
  35000,
)
