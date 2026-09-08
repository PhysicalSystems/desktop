// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { ChildProcess } from "node:child_process"
import { PassThrough } from "node:stream"
import { readBrowserObservation } from "./browser-observation"
import {
  createWindowsJunctionPruneTransport,
  finishWindowsJunctionPrune,
  pruneOwnedWindowsJunctions,
  windowsJunctionPruneScript,
} from "./windows-junction-prune"
import { windowsReviewScriptBootstrap } from "./windows-review-native"

const anchors = {
  parent: { path: "C:\\owned", dev: 0xffffffffn, ino: 9007199254740993n },
  root: { path: "C:\\owned\\browser", dev: 0xffffffffn, ino: 0xffffffffffffffffn },
}
const complete = { status: "COMPLETE", entries: 7, linksRemoved: 2 } as const

function fixture() {
  const calls: {
    child: ChildProcess
    input: string
    timeout: number
    complete(error: unknown, stdout: string, stderr: string): void
  }[] = []
  const prune = createWindowsJunctionPruneTransport((options, callback) => {
    const child = new ChildProcess()
    Object.defineProperties(child, {
      stdin: { value: new PassThrough() },
      stdout: { value: new PassThrough() },
      stderr: { value: new PassThrough() },
    })
    const call = { child, input: "", timeout: options.timeout, complete: callback }
    child.stdin!.on("data", (data) => {
      call.input += data.toString()
    })
    calls.push(call)
    return child
  }, 20)
  return { prune, calls }
}

test("junction pruning serializes exact bigint anchors and cleanup waits for helper close", async () => {
  const f = fixture()
  let removed = 0
  let finished = false
  const operation = finishWindowsJunctionPrune(
    () => f.prune(anchors),
    async () => {
      removed++
    },
  ).then(() => {
    finished = true
  })
  const call = f.calls[0]!
  expect(JSON.parse(call.input)).toEqual({
    parent: { path: "C:\\owned", dev: "4294967295", ino: "9007199254740993" },
    root: { path: "C:\\owned\\browser", dev: "4294967295", ino: "18446744073709551615" },
  })
  expect(call.timeout).toBe(12000)
  call.complete(undefined, JSON.stringify(complete), "PRIVATE-IGNORED")
  await Promise.resolve()
  expect(removed).toBe(0)
  expect(finished).toBe(false)
  call.child.emit("close", 0)
  await operation
  expect(removed).toBe(1)
  expect(finished).toBe(true)
})

test("only the exact bounded COMPLETE result permits root removal after controller cleanup", async () => {
  for (const value of [
    { ...complete, status: "BOUNDED" },
    { ...complete, status: "IDENTITY_UNCONFIRMED" },
    { ...complete, status: "DELETE_UNCONFIRMED" },
    { ...complete, status: "UNREADABLE" },
    { ...complete, path: "PRIVATE-NATIVE-PATH" },
    { ...complete, status: "PASS" },
    { ...complete, entries: 8193 },
    { ...complete, entries: -1 },
    { ...complete, entries: 1.5 },
    { ...complete, linksRemoved: 8 },
    { ...complete, linksRemoved: -1 },
    { ...complete, linksRemoved: "2" },
    { status: "COMPLETE", entries: 0 },
    null,
  ]) {
    const f = fixture()
    let removed = 0
    const operation = finishWindowsJunctionPrune(
      () => f.prune(anchors),
      async () => {
        removed++
      },
    )
    f.calls[0]!.complete(undefined, JSON.stringify(value), "PRIVATE-STDERR")
    f.calls[0]!.child.emit("close", 0)
    const error = await operation.catch((error: unknown) => error)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe("PROVIDER_REVIEW_BROWSER_CLEANUP_UNCONFIRMED")
    expect((error as Error).stack).not.toContain("PRIVATE")
    expect(error).not.toHaveProperty("code")
    expect(error).not.toHaveProperty("path")
    expect(String(readBrowserObservation(error)?.directoryPrepareStatus)).toBe(
      ["BOUNDED", "IDENTITY_UNCONFIRMED", "DELETE_UNCONFIRMED", "UNREADABLE"].includes(value?.status ?? "")
        ? value!.status
        : "INVALID_RESPONSE",
    )
    expect(readBrowserObservation(error)?.directoryPrepareQuiescence).toBe("confirmed")
    expect(removed).toBe(1)
  }
})

test("uncertain helper closure retains its controller and poisons later transport calls even after late close", async () => {
  const f = fixture()
  let removed = 0
  const operation = finishWindowsJunctionPrune(
    () => f.prune(anchors),
    async () => {
      removed++
    },
  )
  f.calls[0]!.complete(Error("PRIVATE-HELPER-ERROR"), "", "PRIVATE-STDERR")
  const error = await operation.catch((error: unknown) => error)
  expect(readBrowserObservation(error)?.handoffQuiescence).toBe("unconfirmed")
  expect(readBrowserObservation(error)?.directoryPrepareStatus).toBe("TRANSPORT_UNCONFIRMED")
  expect(readBrowserObservation(error)?.directoryPrepareQuiescence).toBe("unconfirmed")
  expect((error as Error).stack).not.toContain("PRIVATE")
  expect(error).not.toHaveProperty("code")
  expect(removed).toBe(0)
  f.calls[0]!.child.emit("close", 0)
  expect((await f.prune(anchors)).quiescence).toBe("unconfirmed")
  expect(f.calls).toHaveLength(1)
})

test("native handle-close uncertainty also prevents controller deletion despite process close", async () => {
  const f = fixture()
  let removed = 0
  const operation = finishWindowsJunctionPrune(
    () => f.prune(anchors),
    async () => {
      removed++
    },
  )
  f.calls[0]!.complete(undefined, JSON.stringify({ ...complete, status: "CLOSE_UNCONFIRMED" }), "")
  f.calls[0]!.child.emit("close", 0)
  const error = await operation.catch((error: unknown) => error)
  expect(readBrowserObservation(error)?.directoryPrepareStatus).toBe("CLOSE_UNCONFIRMED")
  expect(readBrowserObservation(error)?.directoryPrepareQuiescence).toBe("confirmed")
  expect(removed).toBe(0)
})

test("failed controller cleanup and unclassified executor failures never authorize root deletion", async () => {
  let removed = 0
  const f = fixture()
  const operation = finishWindowsJunctionPrune(
    () => f.prune(anchors),
    async () => {
      removed++
      throw Object.assign(Error("PRIVATE-CONTROLLER"), { code: "EACCES", path: "PRIVATE-PATH" })
    },
  )
  f.calls[0]!.complete(undefined, JSON.stringify(complete), "")
  f.calls[0]!.child.emit("close", 0)
  const error = await operation.catch((error: unknown) => error)
  expect(removed).toBe(1)
  expect((error as Error).message).toBe("PROVIDER_REVIEW_BROWSER_CLEANUP_UNCONFIRMED")
  expect((error as Error).stack).not.toContain("PRIVATE")
  expect(error).not.toHaveProperty("code")
  expect(readBrowserObservation(error)?.directoryPrepareStatus).toBe("CONTROLLER_UNCONFIRMED")
  expect(readBrowserObservation(error)?.directoryPrepareQuiescence).toBe("confirmed")
  await expect(
    finishWindowsJunctionPrune(
      async () => {
        throw Error("PRIVATE")
      },
      async () => {
        removed++
      },
    ),
  ).rejects.toThrow("PROVIDER_REVIEW_BROWSER_CLEANUP_UNCONFIRMED")
  expect(removed).toBe(1)
})

test("malformed and foreign anchors fail before any executor call without private errors", async () => {
  for (const value of [
    { ...anchors, root: { ...anchors.root, ino: 0n } },
    { ...anchors, root: { ...anchors.root, ino: -1n } },
    { ...anchors, root: { ...anchors.root, ino: 1n << 64n } },
    { ...anchors, root: { ...anchors.root, dev: 1n << 32n } },
    { ...anchors, root: { ...anchors.root, path: "C:\\elsewhere\\browser" } },
    { ...anchors, root: { ...anchors.root, path: "C:\\owned\\x\\..\\browser" } },
    { ...anchors, root: { ...anchors.root, path: "C:\\owned\\browser\nPRIVATE" } },
    { ...anchors, root: { ...anchors.root, path: "C:\\owned\\*.junction" } },
    { ...anchors, root: { ...anchors.root, ino: 42 as never } },
  ]) {
    const f = fixture()
    await expect(f.prune(value)).rejects.toThrow("PROVIDER_REVIEW_BROWSER_CLEANUP_UNCONFIRMED")
    expect(f.calls).toHaveLength(0)
  }
})

test("production entry refuses a non-hosted context and fixed compressed script fits CreateProcess", async () => {
  await expect(pruneOwnedWindowsJunctions({ env: {}, anchors })).rejects.toThrow(
    "PROVIDER_REVIEW_BROWSER_CLEANUP_UNCONFIRMED",
  )
  const executable = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
  const args = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(windowsReviewScriptBootstrap(windowsJunctionPruneScript), "utf16le").toString("base64"),
  ]
  expect(executable.length * 2 + 3 + args.reduce((sum, arg) => sum + arg.length + 3, 0)).toBeLessThan(32767)
})
