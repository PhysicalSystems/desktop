// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { createProcessStopper, createShutdownCoordinator, waitForProcessExit, waitForShutdownStep } from "./lifecycle"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => { resolve = yes })
  return { promise, resolve }
}

test("last-window shutdown waits for operator and model cleanup despite repeated requests", async () => {
  const operator = deferred(), model = deferred(), started = deferred(), calls: string[] = []
  const shutdown = createShutdownCoordinator({
    async closeOperator() { calls.push("operator"); await operator.promise },
    async stopServers() { calls.push("model"); started.resolve(); await model.promise },
    finish(intent) { calls.push(intent) },
    blocked() { throw new Error("Unexpected failure") },
  })
  const first = shutdown.request("quit"), repeated = shutdown.request("quit")
  expect(repeated).toBe(first)
  expect(calls).toEqual(["operator"])
  operator.resolve(); await started.promise
  expect(calls).toEqual(["operator", "model"])
  model.resolve()
  expect(await first).toBe(true)
  expect(await shutdown.request("quit")).toBe(true)
  expect(calls).toEqual(["operator", "model", "quit"])
})

test("an unconfirmed operator outcome keeps the app open and allows an explicit retry", async () => {
  let attempts = 0
  const calls: string[] = []
  const shutdown = createShutdownCoordinator({
    async closeOperator() { calls.push("operator"); if (++attempts === 1) throw new Error("Owned request pending") },
    async stopServers() { calls.push("model") },
    finish(intent) { calls.push(intent) },
    blocked(error) { expect(String(error)).toContain("Owned request pending"); calls.push("visible recovery") },
  })
  expect(await shutdown.request("quit")).toBe(false)
  expect(calls).toEqual(["operator", "visible recovery"])
  expect(await shutdown.request("quit")).toBe(true)
  expect(calls).toEqual(["operator", "visible recovery", "operator", "model", "quit"])
})

test("relaunch during pending shutdown happens once and only after model exit", async () => {
  const model = deferred(), started = deferred(), calls: string[] = []
  const shutdown = createShutdownCoordinator({
    async closeOperator() {},
    async stopServers() { started.resolve(); await model.promise },
    finish(intent) { calls.push(intent) },
    blocked() { throw new Error("Unexpected failure") },
  })
  const pending = shutdown.request("quit")
  await started.promise
  expect(shutdown.request("relaunch")).toBe(pending)
  expect(calls).toEqual([])
  model.resolve(); await pending
  expect(calls).toEqual(["relaunch"])
})

test("process shutdown is bounded and an unconfirmed exit is not reported as complete", async () => {
  const exit = deferred()
  await expect(waitForProcessExit(exit.promise, 5)).rejects.toThrow("PROCESS_EXIT_UNCONFIRMED")
  exit.resolve()
  await expect(waitForProcessExit(exit.promise, 50)).resolves.toBeUndefined()
})

test("a stalled credential cleanup preserves the window and later retry observes the same cleanup", async () => {
  const cleanup = deferred(), calls: string[] = []
  const work = cleanup.promise.then(() => { calls.push("attachment removed") })
  const shutdown = createShutdownCoordinator({
    async closeOperator() { await waitForShutdownStep(work, 5, "ATTACHMENT_CLEANUP_UNCONFIRMED") },
    async stopServers() { calls.push("model exited") },
    finish(intent) { calls.push(intent) },
    blocked(error) { expect(String(error)).toContain("ATTACHMENT_CLEANUP_UNCONFIRMED") },
  })
  expect(await shutdown.request("quit")).toBe(false)
  expect(calls).toEqual([])
  cleanup.resolve()
  expect(await shutdown.request("quit")).toBe(true)
  expect(calls).toEqual(["attachment removed", "model exited", "quit"])
})

test("quit owns a starting model process before readiness and still confirms its exit", async () => {
  const exit = deferred(), stopRequested = deferred(), calls: string[] = []
  let exited = false
  const model = createProcessStopper({
    exit: exit.promise,
    exited: () => exited,
    requestStop() { calls.push("stop starting model"); stopRequested.resolve() },
    forceStop() { calls.push("kill requested") },
    graceMs: 100,
    forcedMs: 100,
  })
  const shutdown = createShutdownCoordinator({
    async closeOperator() { calls.push("operator closed") },
    stopServers: () => model.stop(),
    finish(intent) { calls.push(intent) },
    blocked() { throw new Error("Unexpected failure") },
  })
  const closing = shutdown.request("quit")
  await stopRequested.promise
  expect(calls).toEqual(["operator closed", "stop starting model"])
  exited = true
  exit.resolve()
  expect(await closing).toBe(true)
  expect(calls).toEqual(["operator closed", "stop starting model", "quit"])
})

test("a kill request with no observed model exit blocks quit and retains retry ownership", async () => {
  const exit = deferred(), calls: string[] = []
  let exited = false
  const model = createProcessStopper({
    exit: exit.promise,
    exited: () => exited,
    requestStop() { calls.push("stop requested") },
    forceStop() { calls.push("kill requested") },
    graceMs: 5,
    forcedMs: 5,
  })
  const first = model.stop()
  expect(model.stop()).toBe(first)
  await expect(first).rejects.toThrow("PROCESS_EXIT_UNCONFIRMED")
  expect(calls).toEqual(["stop requested", "kill requested"])
  exited = true
  exit.resolve()
  await expect(model.stop()).resolves.toBeUndefined()
  expect(calls).toEqual(["stop requested", "kill requested"])
})
