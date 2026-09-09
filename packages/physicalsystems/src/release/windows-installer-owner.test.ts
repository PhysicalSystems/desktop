// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import type { ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import {
  createWindowsInstallerOwnerTransport,
  readWindowsInstallerOwnerObservation,
  startWindowsInstallerOwner,
  windowsInstallerEnvironment,
  windowsInstallerOwnerScript,
} from "./windows-installer-owner"

const nonce = "a".repeat(64)
function fixture(timeout = 1000) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const child = Object.assign(new EventEmitter(), { pid: 987654, stdin, stdout, stderr, kill() {}, unref() {} })
  const commands: string[] = []
  stdin.on("data", (data) => commands.push(data.toString()))
  const transport = createWindowsInstallerOwnerTransport(child as unknown as ChildProcess, nonce, timeout)
  const message = (value: Record<string, unknown>) => stdout.write(JSON.stringify({ nonce, ...value }) + "\n")
  const close = (code: number | null = 0, signal: string | null = null) => child.emit("close", code, signal)
  return { child, commands, transport, message, close }
}
async function running(timeout?: number) {
  const state = fixture(timeout)
  expect(state.commands).toEqual([])
  state.message({ event: "ready" })
  expect(state.commands).toEqual([`GO ${nonce}\n`])
  state.message({ event: "started", pid: 987655 })
  return { ...state, owner: await state.transport.started }
}
const exit = { event: "exited", exitCode: 0, stopped: false, activeProcesses: 0, rootSignaled: true }

test("owner requires job-empty/root-exit proof followed by helper close; STOP acknowledgement is insufficient", async () => {
  const state = await running()
  expect(state.owner.pid).toBe(987655)
  let completed = false
  void state.owner.completion.then(() => {
    completed = true
  })
  const stopping = state.owner.stop()
  expect(state.commands).toEqual([`GO ${nonce}\n`, `STOP ${nonce}\n`])
  state.message({ event: "stopped" })
  await stopping
  await Promise.resolve()
  expect(completed).toBe(false)
  state.message({ ...exit, exitCode: 197, stopped: true })
  await Promise.resolve()
  expect(completed).toBe(false)
  state.close()
  expect(await state.owner.completion).toEqual({ exitCode: 197, stopped: true, jobEmpty: true })
  await expect(state.owner.stop()).rejects.toThrow("PUBLIC_UPGRADE_INSTALLER_UNCONFIRMED")
  await state.owner.abort()
})

test("abort after exit record but before close cannot revive successful completion", async () => {
  const state = await running()
  state.message(exit)
  const abort = state.owner.abort()
  expect(state.child.stdin.writableEnded).toBe(true)
  state.close()
  await abort
  await expect(state.owner.completion).rejects.toThrow("PUBLIC_UPGRADE_INSTALLER_UNCONFIRMED")
})

test("root-exited native failure rejects STOP and does not grant descendant closure", async () => {
  const state = await running()
  let settled = false
  void state.owner.completion
    .finally(() => {
      settled = true
    })
    .catch(() => {})
  await Promise.resolve()
  expect(settled).toBe(false)
  const stopping = state.owner.stop()
  state.message({ event: "error", phase: "root-not-live" })
  state.close(1)
  const error = await stopping.catch((error) => error)
  expect(readWindowsInstallerOwnerObservation(error)).toEqual({ ownerPhase: "root-not-live" })
  await expect(state.owner.completion).rejects.toThrow("PUBLIC_UPGRADE_INSTALLER_UNCONFIRMED")
  await state.owner.abort()
})

for (const record of [
  { ...exit, activeProcesses: 1 },
  { ...exit, rootSignaled: false },
  { ...exit, stopped: true },
  { ...exit, privatePath: "PRIVATE" },
  { ...exit, nonce: "b".repeat(64) },
  { event: "stopped" },
  { event: "ready" },
  { event: "started", pid: 987655 },
  { event: "error", phase: "PRIVATE" },
]) {
  test(`owner rejects invalid or out-of-order native record ${JSON.stringify(record)}`, async () => {
    const state = await running()
    state.message(record)
    state.message(exit)
    state.close()
    const error = await state.owner.completion.catch((error) => error)
    expect(error.message).toBe("PUBLIC_UPGRADE_INSTALLER_UNCONFIRMED")
    expect(readWindowsInstallerOwnerObservation(error)).toEqual({ ownerPhase: "transport" })
    expect(JSON.stringify(readWindowsInstallerOwnerObservation(error))).not.toContain("PRIVATE")
    await state.owner.abort()
  })
}

test("fixed native failure phases survive normalization without accepting forged error metadata", async () => {
  for (const phase of ["bootstrap", "layout", "job-attribute", "process-create", "cleanup"] as const) {
    const state = fixture()
    if (phase === "bootstrap") state.child.stdout.write('{"event":"bootstrap-error"}\n')
    else state.message({ event: "error", phase })
    state.child.stderr.write("PRIVATE PATH AND ENVIRONMENT")
    state.close(1)
    const error = await state.transport.started.catch((error) => error)
    expect(readWindowsInstallerOwnerObservation(error)).toEqual({ ownerPhase: phase })
    expect(Object.isFrozen(readWindowsInstallerOwnerObservation(error))).toBe(true)
    expect(
      readWindowsInstallerOwnerObservation(Object.assign(new Error("PRIVATE"), { ownerPhase: phase })),
    ).toBeUndefined()
    await state.transport.abort()
  }
})

test("native output bounds, malformed lines and unfinished records fail closed", async () => {
  for (const text of ["PRIVATE\n", "a".repeat(8193), '{"event":']) {
    const state = await running()
    state.child.stdout.write(text)
    state.close()
    await expect(state.owner.completion).rejects.toThrow("PUBLIC_UPGRADE_INSTALLER_UNCONFIRMED")
    await state.owner.abort()
  }
})

test("helper EOF, signal and nonzero exit cannot confirm completion", async () => {
  for (const [code, signal] of [
    [0, null],
    [1, null],
    [null, "SIGTERM"],
  ] as const) {
    const state = await running()
    state.close(code, signal)
    await expect(state.owner.completion).rejects.toThrow("PUBLIC_UPGRADE_INSTALLER_UNCONFIRMED")
    await state.owner.abort()
  }
})

test("overall deadline cancels a live owner and late records cannot restore authority", async () => {
  const state = await running(20)
  await expect(state.owner.completion).rejects.toThrow("PUBLIC_UPGRADE_INSTALLER_TIMEOUT")
  expect(state.child.stdin.writableEnded).toBe(true)
  state.message(exit)
  state.close()
  await state.owner.abort()
  await expect(state.owner.completion).rejects.toThrow("PUBLIC_UPGRADE_INSTALLER_TIMEOUT")
})

test("production factory cannot acquire native ownership off a Windows disposable runner", async () => {
  let spawned = false
  await expect(
    startWindowsInstallerOwner(
      {
        env: {},
        root: "/not-owned",
        installation: "/not-owned/payload",
        artifact: "/not-owned/setup.exe",
        timeoutMs: 1000,
      },
      {
        spawn() {
          spawned = true
          throw new Error("UNREACHABLE")
        },
      },
    ),
  ).rejects.toThrow()
  expect(spawned).toBe(false)
})

test("private installer environment retains exact values and Node duplicate selection in Windows name order", () => {
  expect(
    windowsInstallerEnvironment({
      PSModulePath: "modules",
      Path: "actual path",
      PATH: "first PATH",
      USERPROFILE: "C:\\Users\\Runner Name",
      APPDATA: "application data",
      private: 'line\nquote"and=equals',
      absent: undefined,
    }),
  ).toBe(
    'APPDATA=application data\0PATH=first PATH\0private=line\nquote"and=equals\0PSModulePath=modules\0USERPROFILE=C:\\Users\\Runner Name\0\0',
  )
  expect(windowsInstallerEnvironment({})).toBe("\0\0")
  for (const env of [{ bad: "null\0value" }, { "bad=key": "value" }, { "bad\0key": "value" }])
    expect(() => windowsInstallerEnvironment(env)).toThrow("PUBLIC_UPGRADE_INSTALLER_UNCONFIRMED")
})

// Exercise the unchanged native stop/closure boundaries with inert pipes. This
// new test needs 15s to observe the existing 10s failure boundary, not extend it.
test("unacknowledged stop and unclosed helper retain failure after ten seconds", async () => {
  const stop = await running(120000)
  const abort = await running(120000)
  let killed = false
  let unref = false
  abort.child.kill = () => {
    killed = true
  }
  abort.child.unref = () => {
    unref = true
  }
  const stopResult = stop.owner.stop().catch((error) => error)
  const abortResult = abort.owner.abort().catch((error) => error)
  const error = await stopResult
  stop.message({ event: "stopped" })
  stop.message({ ...exit, stopped: true })
  stop.close()
  expect(readWindowsInstallerOwnerObservation(error)).toEqual({ ownerPhase: "stop-timeout" })
  await expect(stop.owner.completion).rejects.toThrow("PUBLIC_UPGRADE_INSTALLER_DESCENDANT_RETAINED")
  expect(readWindowsInstallerOwnerObservation(await abortResult)).toEqual({ ownerPhase: "cleanup" })
  expect(killed).toBe(true)
  expect(unref).toBe(true)
  abort.close()
  await expect(abort.owner.completion).rejects.toThrow("PUBLIC_UPGRADE_INSTALLER_UNCONFIRMED")
}, 15000)

test("native helper source uses atomic job assignment and an explicit private environment without control-handle inheritance", () => {
  expect(windowsInstallerOwnerScript).toContain("new IntPtr(0x2000d)")
  expect(windowsInstallerOwnerScript).toContain("limits.Basic.Flags=0x2000")
  expect(windowsInstallerOwnerScript).toContain("false,0x80000|0x08000000|0x400,environmentBlock")
  expect(windowsInstallerOwnerScript).toContain("if(RootExited() && Active()==0)")
  expect(windowsInstallerOwnerScript).toContain("if(WaitForSingleObject(Process,0)!=258)")
  expect(windowsInstallerOwnerScript).not.toContain("AssignProcessToJobObject")
  expect(windowsInstallerOwnerScript).not.toContain("STARTF_USESTDHANDLES")
  expect(windowsInstallerOwnerScript).not.toContain("taskkill")
})
