// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { ChildProcess } from "node:child_process"
import { PassThrough } from "node:stream"
import { createWindowsReviewNativeTransport, type WindowsReviewNative } from "./windows-review-native"
import { createBrowserHandoffTask } from "./browser-handoff-task"
import { readBrowserObservation } from "./browser-observation"

function fixture(closeTimeoutMs = 100) {
  const calls: {
    child: ChildProcess
    deadline: number
    complete: (error: unknown, stdout: string, stderr: string) => void
    released: number
  }[] = []
  const native = createWindowsReviewNativeTransport((options, complete) => {
    // Construct an inert event emitter and pipes only. No child is spawned.
    const child = new ChildProcess()
    Object.defineProperties(child, {
      stdin: { value: new PassThrough() },
      stdout: { value: new PassThrough() },
      stderr: { value: new PassThrough() },
    })
    const call = { child, deadline: options.timeout, complete, released: 0 }
    child.unref = () => {
      call.released++
    }
    calls.push(call)
    return child
  }, closeTimeoutMs)
  return { native, calls }
}
const observe: Parameters<WindowsReviewNative>[0] = {
  operation: "observe",
  executable: "C:\\owned\\browser.exe",
  profile: "C:\\owned\\profile",
  scheme: "http",
  observedPids: [],
}
const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const outcome = (promise: Promise<unknown>) =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  )

test("native callback success or failure stays pending until actual helper close", async () => {
  for (const error of [null, { code: "EPERM", message: "PRIVATE-CREDENTIAL-TRAP" }]) {
    const f = fixture()
    let settled = false
    const result = outcome(f.native(observe)).finally(() => {
      settled = true
    })
    const call = f.calls[0]!
    call.complete(error, '{"fixtureOnly":true}', "PHYSICALSYSTEMS_WINDOWS_BROWSER_PHASE_process-identity\n")
    await turn()
    expect(settled).toBe(false)
    expect(call.deadline).toBe(12000)
    call.child.emit("close", error ? 1 : 0, null)
    const observed = await result
    if (error) {
      expect("error" in observed).toBe(true)
      expect(readBrowserObservation("error" in observed ? observed.error : undefined)).toMatchObject({
        windowsNativeOutcome: "start",
        windowsNativePhase: "process-identity",
      })
      expect(JSON.stringify(observed)).not.toContain("PRIVATE")
    } else expect(observed).toEqual({ value: { fixtureOnly: true } })
    expect(call.released).toBe(0)
  }
})

test("close without its callback cannot invent success; both are required and operation deadlines remain fixed", async () => {
  const f = fixture()
  let settled = false
  const result = outcome(f.native({ operation: "preflight", scheme: "http" })).finally(() => {
    settled = true
  })
  const call = f.calls[0]!
  expect(call.deadline).toBe(30000)
  call.child.emit("close", 0, null)
  await turn()
  expect(settled).toBe(false)
  call.complete(null, '{"fixtureOnly":true}', "")
  expect(await result).toEqual({ value: { fixtureOnly: true } })
})

test("an in-flight helper prevents overlapping operations, but confirmed completion permits a later operation", async () => {
  const f = fixture()
  const first = outcome(f.native(observe))
  const blocked = await outcome(f.native({ operation: "stop", processes: [] }))
  expect("error" in blocked).toBe(true)
  expect(f.calls).toHaveLength(1)
  f.calls[0]!.complete(null, "{}", "")
  f.calls[0]!.child.emit("close", 0, null)
  expect(await first).toEqual({ value: {} })
  const next = outcome(f.native({ operation: "stop", processes: [] }))
  expect(f.calls).toHaveLength(2)
  f.calls[1]!.complete(null, "{}", "")
  f.calls[1]!.child.emit("close", 0, null)
  expect(await next).toEqual({ value: {} })
})

test("failed close retains ownership permanently, releases only controller handles and prevents subsequent helpers", async () => {
  for (const error of [null, { code: "EPERM", message: "PRIVATE-KILL-FAILURE" }]) {
    const f = fixture(5)
    const result = outcome(f.native(observe))
    const call = f.calls[0]!
    let signals = 0
    call.child.kill = () => {
      signals++
      return false
    }
    call.complete(error, '{"PRIVATE":"must-not-escape"}', "PRIVATE-NATIVE-OUTPUT")
    const observed = await result
    expect("error" in observed).toBe(true)
    expect(readBrowserObservation("error" in observed ? observed.error : undefined)).toMatchObject({
      windowsNativeOutcome: "unknown",
      handoffQuiescence: "unconfirmed",
    })
    expect(JSON.stringify(observed)).not.toContain("PRIVATE")
    expect(call.released).toBe(1)
    expect(call.child.stdin!.destroyed).toBe(true)
    expect(call.child.stdout!.destroyed).toBe(true)
    expect(call.child.stderr!.destroyed).toBe(true)
    expect(signals).toBe(0)
    await expect(f.native({ operation: "stop", processes: [] })).rejects.toThrow("PROVIDER_REVIEW_WINDOWS_UNCONFIRMED")
    call.child.emit("close", 0, null)
    call.complete(null, "{}", "")
    await expect(f.native(observe)).rejects.toThrow("PROVIDER_REVIEW_WINDOWS_UNCONFIRMED")
    expect(f.calls).toHaveLength(1)
  }
})

test("lost executor outcome cannot expose raw errors or authorize another operation", async () => {
  let calls = 0
  const native = createWindowsReviewNativeTransport(() => {
    calls++
    throw Error("PRIVATE-EXECUTOR-TRAP")
  }, 5)
  const observed = await outcome(native(observe))
  expect("error" in observed).toBe(true)
  expect(readBrowserObservation("error" in observed ? observed.error : undefined)?.handoffQuiescence).toBe(
    "unconfirmed",
  )
  expect(JSON.stringify(observed)).not.toContain("PRIVATE")
  await expect(native(observe)).rejects.toThrow("PROVIDER_REVIEW_WINDOWS_UNCONFIRMED")
  expect(calls).toBe(1)
})

test("synchronous stdin failure still requires close and cannot expose the private transport exception", async () => {
  const child = new ChildProcess()
  const input = new PassThrough()
  input.end = (() => {
    throw Error("PRIVATE-STDIN-CREDENTIAL-TRAP")
  }) as typeof input.end
  Object.defineProperty(child, "stdin", { value: input })
  let settled = false
  const native = createWindowsReviewNativeTransport(() => child, 100)
  const result = outcome(native(observe)).finally(() => {
    settled = true
  })
  await turn()
  expect(settled).toBe(false)
  child.emit("close", 1, null)
  const observed = await result
  expect("error" in observed).toBe(true)
  const error = "error" in observed ? observed.error : undefined
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toBe("PROVIDER_REVIEW_WINDOWS_UNCONFIRMED")
  expect((error as Error).stack).not.toContain("PRIVATE")
  expect(JSON.stringify(readBrowserObservation(error))).not.toContain("PRIVATE")
  input.destroy()
})

test("native helper-close uncertainty survives rejected confirmation and any late close", async () => {
  const f = fixture(5)
  const task = createBrowserHandoffTask({
    async confirmHandoff() {
      await f.native(observe)
      return true
    },
    observation: () => ({ browserPhase: "handoff-targets", handoffQuiescence: "settled" }),
  })
  const confirming = outcome(task.confirm("http://127.0.0.1/exact-inert"))
  await turn()
  f.calls[0]!.complete(null, "{}", "")
  expect("error" in (await confirming)).toBe(true)
  const drained = await task.drain()
  expect(drained.settled).toBe(false)
  expect(drained.observation.handoffQuiescence).toBe("unconfirmed")
  f.calls[0]!.child.emit("close", 0, null)
  expect(await task.drain()).toBe(drained)
  expect(await task.confirm("http://127.0.0.1/exact-inert")).toBe(false)
  await expect(f.native({ operation: "stop", processes: [] })).rejects.toThrow("PROVIDER_REVIEW_WINDOWS_UNCONFIRMED")
  expect(f.calls).toHaveLength(1)
})
