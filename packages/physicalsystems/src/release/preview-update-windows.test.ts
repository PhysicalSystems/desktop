// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { ChildProcess, execFile } from "node:child_process"
import { PassThrough } from "node:stream"
import { gunzipSync } from "node:zlib"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { join, win32 } from "node:path"
import {
  createPreviewUpdateWindowsNative,
  createPreviewUpdateWindowsTransport,
  capturePreviewUpdateWindowsShutdown,
  previewUpdateWindowsExecutableReady,
  previewUpdateWindowsArguments,
  readPreviewUpdateWindowsObservation,
  previewUpdateWindowsScript,
  previewUpdateWindowsTime,
  type PreviewUpdateWindowsApplication,
} from "./preview-update-windows"
import { requireDisposablePublicRunner } from "./public-qualification"
import { createWindowsReviewRequestTransport, windowsReviewNativeEnvironment } from "./windows-review-native"

const baseline: PreviewUpdateWindowsApplication = {
  pid: 50,
  creationTime: "639249130000000000",
  executable: "C:\\runner\\test\\install\\Physical Systems.exe",
  version: "0.1.0-beta.1",
  ownerSid: "S-1-5-21-123-456-789-1001",
  sessionId: 1,
  windowHandle: "12345",
}
const observation = {
  executable: baseline.executable,
  version: baseline.version,
  after: "639249129999999999",
}
const observed = () => ({
  status: "observed",
  application: { ...baseline },
  versionInfo: { ProductName: "Physical Systems", FileVersion: baseline.version, ProductVersion: "0.1.0.0" },
})

function fixture() {
  const calls: {
    child: ChildProcess
    input: string
    timeout: number
    complete(error: unknown, stdout: string, stderr: string): void
    unreferenced: boolean
  }[] = []
  const native = createPreviewUpdateWindowsTransport((options, complete) => {
    const child = new ChildProcess()
    Object.defineProperties(child, {
      stdin: { value: new PassThrough() },
      stdout: { value: new PassThrough() },
      stderr: { value: new PassThrough() },
    })
    const call = { child, complete, timeout: options.timeout, input: "", unreferenced: false }
    child.stdin!.on("data", (data) => {
      call.input += data.toString()
    })
    child.unref = () => {
      call.unreferenced = true
    }
    calls.push(call)
    return child
  }, 20)
  return {
    calls,
    native,
    reply(value: unknown) {
      calls.at(-1)!.complete(null, JSON.stringify(value), "")
      calls.at(-1)!.child.emit("close", 0)
    },
  }
}

test("an observed process binds fresh creation, path, preview version and native PE version metadata", async () => {
  const f = fixture()
  const result = f.native.observe(observation)
  expect(JSON.parse(f.calls[0]!.input)).toEqual({ ...observation, operation: "observe" })
  expect(f.calls[0]!.timeout).toBe(12000)
  let settled = false
  void result.then(() => {
    settled = true
  })
  f.calls[0]!.complete(null, JSON.stringify(observed()), "")
  await Promise.resolve()
  expect(settled).toBe(false)
  f.calls[0]!.child.emit("close", 0)
  expect(await result).toEqual(baseline)

  const next = f.native.observe({ ...observation, version: "0.1.0-beta.7", previousPid: baseline.pid })
  f.reply({
    ...observed(),
    application: { ...baseline, pid: 60, version: "0.1.0-beta.7" },
    versionInfo: { ...observed().versionInfo, FileVersion: "0.1.0-beta.7" },
  })
  expect((await next)?.pid).toBe(60)
})

test("no visible matching process is waiting, while malformed/foreign/stale observations fail closed", async () => {
  const f = fixture()
  const waiting = f.native.observe(observation)
  f.reply({ status: "waiting" })
  expect(await waiting).toBeUndefined()
  const invalid: unknown[] = [
    { status: "waiting", raw: "PRIVATE" },
    { status: "observed", application: baseline },
    { ...observed(), application: { ...baseline, pid: 0 } },
    { ...observed(), application: { ...baseline, executable: "C:\\foreign\\Physical Systems.exe" } },
    { ...observed(), application: { ...baseline, creationTime: observation.after } },
    { ...observed(), application: { ...baseline, version: "0.1.0-beta.7" } },
    { ...observed(), application: { ...baseline, ownerSid: "S-1-5-18" } },
    { ...observed(), application: { ...baseline, sessionId: 0 } },
    { ...observed(), application: { ...baseline, windowHandle: "0" } },
    { ...observed(), application: { ...baseline, commandLine: "PRIVATE" } },
    { ...observed(), versionInfo: { ...observed().versionInfo, FileVersion: "0.1.0-beta.2" } },
    { ...observed(), versionInfo: { ...observed().versionInfo, ProductName: "Physical Systems Candidate" } },
    { ...observed(), versionInfo: { ...observed().versionInfo, ProductVersion: "0.1.0-beta.1" } },
  ]
  for (const output of invalid) {
    const result = f.native.observe(observation)
    f.reply(output)
    await expect(result).rejects.toThrow()
  }
  const reused = f.native.observe({ ...observation, previousPid: baseline.pid })
  f.reply(observed())
  await expect(reused).rejects.toThrow("UNCONFIRMED")
})

test("confirmation uses only the exact requested native action and normal close makes no exit claim", async () => {
  const f = fixture()
  for (const action of ["Later", "Install update"] as const) {
    const input = { application: baseline, version: "0.1.0-beta.7", action }
    const waiting = f.native.confirm(input)
    f.reply({ status: "waiting" })
    expect(await waiting).toBe("waiting")
    const confirmation = f.native.confirm(input)
    expect(JSON.parse(f.calls.at(-1)!.input)).toEqual({ ...input, operation: "confirm" })
    f.reply({ status: "invoked", action })
    expect(await confirmation).toBe("invoked")
  }
  const other = fixture()
  const wrongAction = other.native.confirm({ application: baseline, version: "0.1.0-beta.7", action: "Later" })
  other.reply({ status: "invoked", action: "Install update" })
  await expect(wrongAction).rejects.toThrow("UNCONFIRMED")
  await expect(other.native.close({ application: baseline })).rejects.toThrow("UNCONFIRMED")
  expect(other.calls).toHaveLength(1)
  const close = f.native.close({ application: baseline })
  expect(JSON.parse(f.calls.at(-1)!.input)).toEqual({ operation: "close", application: baseline })
  f.reply({ status: "close-requested" })
  expect(await close).toBeUndefined()
  const running = f.native.exited({ application: baseline })
  f.reply({ status: "running" })
  expect(await running).toBe(false)
  const exited = f.native.exited({ application: baseline })
  f.reply({ status: "exited" })
  expect(await exited).toBe(true)
  const uncertain = f.native.exited({ application: baseline })
  f.reply({ status: "waiting" })
  await expect(uncertain).rejects.toThrow("UNCONFIRMED")
})

test("invalid requests do not dispatch native code or allow shell/script/path arguments", async () => {
  const f = fixture()
  for (const changed of [
    { executable: "C:\\runner\\test\\..\\Physical Systems.exe" },
    { executable: "C:\\runner\\test\\Physical Systems.exe:stream" },
    { executable: "\\\\server\\test\\Physical Systems.exe" },
    { executable: "C:\\runner\\test \\Physical Systems.exe" },
    { executable: "C:\\runner\\test\\Other.exe" },
    { after: "1e20" },
    { after: "3155378976000000000" },
    { previousPid: NaN },
    { version: "0.1.0-beta.01" },
    { version: "0.1.0-beta.9007199254740992" },
    { version: "0.1.0" },
    { script: "PRIVATE" },
  ])
    await expect(f.native.observe({ ...observation, ...changed })).rejects.toThrow("UNCONFIRMED")
  await expect(
    f.native.confirm({ application: { ...baseline, pid: -1 }, version: "0.1.0-beta.7", action: "Later" }),
  ).rejects.toThrow("UNCONFIRMED")
  await expect(
    f.native.confirm({ application: baseline, version: "0.1.0-beta.7", action: "arbitrary" as "Later" }),
  ).rejects.toThrow("UNCONFIRMED")
  expect(f.calls).toHaveLength(0)
})

test("native errors are authored and unconfirmed helper exit permanently prevents another native action", async () => {
  const f = fixture()
  const failed = f.native.confirm({ application: baseline, version: "0.1.0-beta.7", action: "Install update" })
  f.calls[0]!.complete({ code: 1, message: "PRIVATE ERROR" }, "PRIVATE STDOUT", "PRIVATE STDERR")
  f.calls[0]!.child.emit("close", 1)
  const error = await failed.catch((value: unknown) => value)
  expect(error).toBeInstanceOf(Error)
  expect(String(error)).not.toContain("PRIVATE")

  for (const phase of ["dialog", "PRIVATE TRAP"]) {
    const f = fixture()
    const unreadable = f.native.observe(observation)
    f.reply({ status: "unreadable", phase })
    await expect(unreadable).rejects.toThrow(`UNCONFIRMED:${phase === "dialog" ? "dialog" : "unknown"}`)
  }

  const owner = fixture()
  const uncertain = owner.native.confirm({ application: baseline, version: "0.1.0-beta.7", action: "Install update" })
  owner.calls[0]!.complete(null, '{"status":"invoked","action":"Install update"}', "")
  await expect(uncertain).rejects.toThrow("UNCONFIRMED")
  expect(owner.calls[0]!.unreferenced).toBe(true)
  expect(owner.calls[0]!.child.stdin!.destroyed).toBe(true)
  owner.calls[0]!.child.emit("close", 0)
  await expect(owner.native.close({ application: baseline })).rejects.toThrow("UNCONFIRMED")
  await expect(owner.native.observe(observation)).rejects.toThrow("UNCONFIRMED")
  expect(owner.calls).toHaveLength(1)
})

test("native confirmation failure diagnostics contain only authored phases, bounded counts and boolean observations", async () => {
  const f = fixture()
  const result = f.native.confirm({ application: baseline, version: "0.1.0-beta.7", action: "Later" })
  f.reply({
    status: "unreadable",
    phase: "dialog-buttons",
    diagnostics: {
      ownedWindows: 2,
      matchingDialogs: 1,
      controls: 12,
      messageMatches: 2,
      messageTexts: 1,
      installButtons: 0,
      laterButtons: 1,
      dialogOwned: true,
      dialogEnabled: true,
      dialogOffscreen: false,
      buttonEnabled: "PRIVATE",
      invokePattern: "PRIVATE",
      rawLabels: ["PRIVATE"],
      executable: "PRIVATE",
    },
  })
  const error = await result.catch((value: unknown) => value)
  expect(readPreviewUpdateWindowsObservation(error)).toEqual({
    phase: "dialog-buttons",
    ownedWindows: 2,
    matchingDialogs: 1,
    controls: 12,
    messageMatches: 2,
    messageTexts: 1,
    installButtons: 0,
    laterButtons: 1,
    dialogOwned: true,
    dialogEnabled: true,
    dialogOffscreen: false,
  })
  expect(JSON.stringify(error)).not.toContain("PRIVATE")
  expect(
    readPreviewUpdateWindowsObservation({
      previewUpdateWindowsObservation: {
        phase: "PRIVATE",
        ownedWindows: -1,
        matchingDialogs: 258,
        controls: Infinity,
        messageTexts: 1.5,
        installButtons: "1",
        invokePattern: true,
        rawLabels: "PRIVATE",
      },
    }),
  ).toEqual({ phase: "unknown", invokePattern: true })
  expect(
    readPreviewUpdateWindowsObservation({
      get previewUpdateWindowsObservation() {
        throw Error("PRIVATE")
      },
    }),
  ).toBeUndefined()
})

test("production native ownership rejects unmarked or local contexts, and timestamps share native UTC tick units", async () => {
  await expect(createPreviewUpdateWindowsNative({ env: {}, root: "C:\\owned" })).rejects.toThrow(
    "REQUIRES_DISPOSABLE_TEST",
  )
  await expect(
    createPreviewUpdateWindowsNative({ env: { ...process.env, PHYSICALSYSTEMS_UPDATER_TEST: "0" }, root: "C:\\owned" }),
  ).rejects.toThrow("REQUIRES_DISPOSABLE_TEST")
  const before = Date.now()
  const time = (BigInt(previewUpdateWindowsTime()) - 621355968000000000n) / 10000n
  expect(time >= BigInt(before) && time <= BigInt(Date.now())).toBe(true)
  const command = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
  const args = previewUpdateWindowsArguments(command)
  expect(command.length * 2 + args.reduce((sum, arg) => sum + arg.length + 3, 0) + 3).toBeLessThan(32767)
  const bootstrap = Buffer.from(args.at(-1)!, "base64").toString("utf16le")
  const compressed = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(bootstrap)?.[1]
  expect(compressed).toBeDefined()
  expect(gunzipSync(Buffer.from(compressed!, "base64")).toString("utf8")).toBe(previewUpdateWindowsScript)
  expect(() => previewUpdateWindowsArguments("X".repeat(32768))).toThrow("UNCONFIRMED")
})

test("NSIS replacement waits on missing owned paths while still rejecting links, escapes and unreadable ancestors", async () => {
  const files = {
    inspect: async (path: string) => ({
      file: path === baseline.executable,
      directory: path !== baseline.executable,
      symbolicLink: false,
    }),
    canonical: async (path: string) => path,
  }
  const missing = () => {
    throw Object.assign(Error("PRIVATE"), { code: "ENOENT" })
  }
  expect(await previewUpdateWindowsExecutableReady(baseline.executable, "C:\\runner", files)).toBe(true)
  expect(
    await previewUpdateWindowsExecutableReady(baseline.executable, "C:\\runner", {
      ...files,
      inspect: async (path) => (path.includes("\\install") ? missing() : files.inspect(path)),
    }),
  ).toBe(false)
  expect(
    await previewUpdateWindowsExecutableReady(baseline.executable, "C:\\runner", {
      ...files,
      canonical: async (path) => (path === baseline.executable ? missing() : path),
    }),
  ).toBe(false)
  for (const mode of ["link", "escape", "permission", "directory"] as const) {
    const boundary = previewUpdateWindowsExecutableReady(baseline.executable, "C:\\runner", {
      inspect: async (path) => {
        if (path === baseline.executable) return missing()
        if (mode === "permission") throw Object.assign(Error("PRIVATE"), { code: "EACCES" })
        return { file: false, directory: mode !== "directory", symbolicLink: mode === "link" }
      },
      canonical: async (path) => (mode === "escape" ? "C:\\foreign" : path),
    })
    await expect(boundary).rejects.toThrow("UNCONFIRMED")
  }
  await expect(
    previewUpdateWindowsExecutableReady("C:\\foreign\\Physical Systems.exe", "C:\\runner", files),
  ).rejects.toThrow("UNCONFIRMED")
})

type ShutdownQuery = Parameters<typeof capturePreviewUpdateWindowsShutdown>[1]
type ShutdownReply = Awaited<ReturnType<ShutdownQuery>>
const shutdownRows = [
  { pid: baseline.pid, parent: 20, birth: baseline.creationTime, executable: baseline.executable },
  { pid: 51, parent: baseline.pid, birth: "639249130000000010", executable: baseline.executable },
  { pid: 52, parent: 51, birth: "639249130000000020", executable: "C:\\runner\\test\\install\\resources\\runtime.exe" },
]
const shutdownReply = (processes = shutdownRows): ShutdownReply => ({
  snapshot: { status: "COMPLETE", processes },
  quiescence: "confirmed",
})
function shutdownFixture(replies: ShutdownReply[]) {
  const calls: Parameters<ShutdownQuery>[0][] = []
  const query: ShutdownQuery = async (input) => {
    calls.push(input)
    const result = replies.shift()
    if (!result) throw Error("PRIVATE NATIVE ERROR")
    return result
  }
  return { query, calls }
}

test("shutdown capture retains exact generations and polls only that PID set, excluding a later installer", async () => {
  const f = shutdownFixture([
    shutdownReply(),
    shutdownReply([shutdownRows[1]!]),
    shutdownReply([{ ...shutdownRows[1]!, birth: "639249130000000099" }]),
  ])
  const departed = await capturePreviewUpdateWindowsShutdown({ application: baseline }, f.query)
  expect(f.calls).toEqual([{ rootPid: baseline.pid }])
  expect(await departed()).toBe(false)
  expect(await departed()).toBe(true)
  expect(f.calls.slice(1)).toEqual([
    { rootPid: baseline.pid, pids: [50, 51, 52] },
    { rootPid: baseline.pid, pids: [50, 51, 52] },
  ])
  const empty = shutdownFixture([shutdownReply(), shutdownReply([])])
  expect(await (await capturePreviewUpdateWindowsShutdown({ application: baseline }, empty.query))()).toBe(true)
})

test("shutdown capture rejects incomplete, foreign-root and stale numeric ancestry without an absence claim", async () => {
  const invalid: ShutdownReply[] = [
    { snapshot: { status: "UNREADABLE", processes: [] }, quiescence: "confirmed" },
    { ...shutdownReply(), quiescence: "unconfirmed" },
    shutdownReply([]),
    shutdownReply([{ ...shutdownRows[0]!, birth: "639249130000000001" }]),
    shutdownReply([{ ...shutdownRows[0]!, executable: "C:\\foreign\\Physical Systems.exe" }]),
    {
      ...shutdownReply(),
      snapshot: { status: "COMPLETE", processes: [shutdownRows[0]!, { ...shutdownRows[1]!, birth: undefined }] },
    },
    {
      ...shutdownReply(),
      snapshot: { status: "COMPLETE", processes: [shutdownRows[0]!, { ...shutdownRows[1]!, executable: undefined }] },
    },
    shutdownReply([shutdownRows[0]!, { ...shutdownRows[1]!, parent: 999 }]),
    shutdownReply([shutdownRows[0]!, { ...shutdownRows[1]!, birth: "639249129999999999" }]),
    shutdownReply([shutdownRows[0]!, shutdownRows[0]!]),
  ]
  for (const value of invalid) {
    const f = shutdownFixture([value])
    await expect(capturePreviewUpdateWindowsShutdown({ application: baseline }, f.query)).rejects.toThrow(
      "SHUTDOWN_UNCONFIRMED",
    )
    expect(f.calls).toHaveLength(1)
  }
  const f = shutdownFixture([])
  await expect(capturePreviewUpdateWindowsShutdown({ application: baseline }, f.query)).rejects.toThrow(
    "SHUTDOWN_UNCONFIRMED",
  )
})

test("shutdown final reads require complete metadata and keep any retained generation present even if its path changes", async () => {
  const changed = shutdownFixture([
    shutdownReply(),
    shutdownReply([{ ...shutdownRows[1]!, executable: "C:\\changed\\runtime.exe" }]),
  ])
  expect(await (await capturePreviewUpdateWindowsShutdown({ application: baseline }, changed.query))()).toBe(false)
  for (const invalid of [
    { snapshot: { status: "UNREADABLE", processes: [] }, quiescence: "confirmed" },
    { ...shutdownReply([]), quiescence: "unconfirmed" },
    { ...shutdownReply(), snapshot: { status: "COMPLETE", processes: [{ ...shutdownRows[1]!, birth: undefined }] } },
    shutdownReply([{ ...shutdownRows[1]!, pid: 60 }]),
  ] satisfies ShutdownReply[]) {
    const f = shutdownFixture([shutdownReply(), invalid])
    const departed = await capturePreviewUpdateWindowsShutdown({ application: baseline }, f.query)
    await expect(departed()).rejects.toThrow("SHUTDOWN_UNCONFIRMED")
  }
})

const hostedWindows =
  process.platform === "win32" &&
  process.env.CI === "true" &&
  process.env.GITHUB_ACTIONS === "true" &&
  process.env.RUNNER_ENVIRONMENT === "github-hosted" &&
  process.env.RUNNER_OS === "Windows" &&
  process.env.GITHUB_REPOSITORY === "PhysicalSystems/desktop"
test.skipIf(!hostedWindows)(
  "hosted Windows parses the exact fixed script and loads native UI Automation without invoking a control",
  async () => {
    const root = await mkdtemp(join(await realpath(process.env.RUNNER_TEMP!), "preview-update-syntax-"))
    await requireDisposablePublicRunner(process.env, root)
    const environment = windowsReviewNativeEnvironment(process.env, root)
    const command = win32.join(environment.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    const script = String.raw`
$ErrorActionPreference='Stop'
$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules')
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
trap {[Console]::Out.Write('{"status":"unreadable"}');exit 1}
$request=ConvertFrom-Json -InputObject ([Console]::In.ReadLine())
$tokens=$null;$errors=$null
$null=[Management.Automation.Language.Parser]::ParseInput($request.script,[ref]$tokens,[ref]$errors)
if($errors.Count -ne 0){throw 'syntax'}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
if(![Windows.Automation.AutomationElement] -or ![Windows.Automation.InvokePattern]){throw 'types'}
[Console]::Out.Write('{"syntax":true,"uiAutomation":true,"noNativeActions":true}')
`
    let safe = false
    const native = createWindowsReviewRequestTransport<{ script: string }>(
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
      () => 12000,
    )
    try {
      const result = await native({ script: previewUpdateWindowsScript })
      safe = true
      expect(result).toEqual({ syntax: true, uiAutomation: true, noNativeActions: true })
    } finally {
      if (safe) await rm(root, { recursive: true, force: true })
    }
  },
  20000,
)
