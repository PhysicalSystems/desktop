// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { closeOwnedProcess, createProcessStopper, createShutdownCoordinator, waitForProcessExit, waitForShutdownStep } from "./lifecycle"

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

test("update preparation coalesces cleanup without quitting, then installer quit finishes once", async () => {
  const operator = deferred(), model = deferred(), started = deferred(), calls: string[] = []
  const shutdown = createShutdownCoordinator({
    async closeOperator() { calls.push("operator"); await operator.promise },
    async stopServers() { calls.push("model"); started.resolve(); await model.promise },
    finish(intent) { calls.push(intent) },
    blocked() { throw new Error("Unexpected failure") },
  })
  const preparing = shutdown.prepare()
  expect(shutdown.prepare()).toBe(preparing)
  expect(calls).toEqual(["operator"])
  operator.resolve(); await started.promise
  expect(calls).toEqual(["operator", "model"])
  model.resolve()
  expect(await preparing).toBe(true)
  expect(await shutdown.prepare()).toBe(true)
  expect(calls).toEqual(["operator", "model"])
  expect(await shutdown.request("quit")).toBe(true)
  expect(await shutdown.request("quit")).toBe(true)
  expect(await shutdown.prepare()).toBe(true)
  expect(calls).toEqual(["operator", "model", "quit"])
})

test("quit and relaunch during update preparation share cleanup and finish once", async () => {
  const model = deferred(), started = deferred(), calls: string[] = []
  const shutdown = createShutdownCoordinator({
    async closeOperator() { calls.push("operator") },
    async stopServers() { calls.push("model"); started.resolve(); await model.promise },
    finish(intent) { calls.push(intent) },
    blocked() { throw new Error("Unexpected failure") },
  })
  const preparing = shutdown.prepare()
  await started.promise
  const quitting = shutdown.request("quit")
  expect(shutdown.request("relaunch")).toBe(quitting)
  expect(shutdown.prepare()).toBe(preparing)
  expect(calls).toEqual(["operator", "model"])
  model.resolve()
  expect(await preparing).toBe(true)
  expect(await quitting).toBe(true)
  expect(await shutdown.request("relaunch")).toBe(true)
  expect(calls).toEqual(["operator", "model", "relaunch"])
})

test("update preparation during ordinary shutdown does not duplicate cleanup or finish", async () => {
  const operator = deferred(), calls: string[] = []
  const shutdown = createShutdownCoordinator({
    async closeOperator() { calls.push("operator"); await operator.promise },
    async stopServers() { calls.push("model") },
    finish(intent) { calls.push(intent) },
    blocked() { throw new Error("Unexpected failure") },
  })
  const quitting = shutdown.request("quit"), preparing = shutdown.prepare()
  expect(shutdown.prepare()).toBe(preparing)
  expect(calls).toEqual(["operator"])
  operator.resolve()
  expect(await quitting).toBe(true)
  expect(await preparing).toBe(true)
  expect(calls).toEqual(["operator", "model", "quit"])
})

test("a failed preparation blocks concurrent relaunch and a quit retry does not retain its intent", async () => {
  const operator = deferred(), calls: string[] = []
  let attempts = 0
  const shutdown = createShutdownCoordinator({
    async closeOperator() {
      calls.push("operator")
      await operator.promise
      if (++attempts === 1) throw new Error("OPERATOR_REQUEST_UNCONFIRMED")
    },
    async stopServers() { calls.push("model") },
    finish(intent) { calls.push(intent) },
    blocked(error) { expect(String(error)).toContain("OPERATOR_REQUEST_UNCONFIRMED"); calls.push("blocked") },
  })
  const preparing = shutdown.prepare(), relaunching = shutdown.request("relaunch")
  operator.resolve()
  expect(await preparing).toBe(false)
  expect(await relaunching).toBe(false)
  expect(calls).toEqual(["operator", "blocked"])
  expect(await shutdown.request("quit")).toBe(true)
  expect(calls).toEqual(["operator", "blocked", "operator", "model", "quit"])
})

test("an unconfirmed server exit leaves update preparation retryable without quitting", async () => {
  const calls: string[] = []
  let attempts = 0
  const shutdown = createShutdownCoordinator({
    async closeOperator() { calls.push("operator") },
    async stopServers() { calls.push("model"); if (++attempts === 1) throw new Error("PROCESS_EXIT_UNCONFIRMED") },
    finish(intent) { calls.push(intent) },
    blocked(error) { expect(String(error)).toContain("PROCESS_EXIT_UNCONFIRMED"); calls.push("blocked") },
  })
  expect(await shutdown.prepare()).toBe(false)
  expect(calls).toEqual(["operator", "model", "blocked"])
  expect(await shutdown.prepare()).toBe(true)
  expect(calls).toEqual(["operator", "model", "blocked", "operator", "model"])
  expect(await shutdown.request("quit")).toBe(true)
  expect(calls).toEqual(["operator", "model", "blocked", "operator", "model", "quit"])
})

test("a synchronous operator failure does not leave preparation stuck on a failed promise", async () => {
  let attempts = 0
  const calls: string[] = []
  const shutdown = createShutdownCoordinator({
    closeOperator() {
      calls.push("operator")
      if (++attempts === 1) throw new Error("OPERATOR_UNAVAILABLE")
      return Promise.resolve()
    },
    async stopServers() { calls.push("model") },
    finish(intent) { calls.push(intent) },
    blocked(error) { expect(String(error)).toContain("OPERATOR_UNAVAILABLE"); calls.push("blocked") },
  })
  expect(await shutdown.prepare()).toBe(false)
  expect(await shutdown.prepare()).toBe(true)
  expect(calls).toEqual(["operator", "blocked", "operator", "model"])
})

test("atomic update owns cleanup and launch before the installer's deferred ordinary quit", async () => {
  const operator = deferred(), model = deferred(), started = deferred(), exited = deferred(), calls: string[] = []
  const shutdown = createShutdownCoordinator({
    async closeOperator() { calls.push("operator"); await operator.promise },
    async stopServers() { calls.push("model"); started.resolve(); await model.promise },
    finish(intent) { calls.push(intent); exited.resolve() },
    blocked() { throw new Error("Unexpected failure") },
  })
  const installing = shutdown.update(() => {
    calls.push("installer launch")
    setImmediate(() => { void shutdown.request("quit") })
  })
  expect(await shutdown.request("quit")).toBe(false)
  expect(await shutdown.request("relaunch")).toBe(false)
  expect(await shutdown.update(() => { calls.push("second installer") })).toBe(false)
  expect(calls).toEqual(["operator"])
  operator.resolve(); await started.promise
  expect(await shutdown.request("relaunch")).toBe(false)
  expect(calls).toEqual(["operator", "model"])
  model.resolve()
  expect(await installing).toBe(true)
  expect(calls).toEqual(["operator", "model", "installer launch"])
  expect(await shutdown.request("relaunch")).toBe(false)
  expect(await shutdown.update(() => { calls.push("second installer") })).toBe(false)
  await exited.promise
  expect(await shutdown.request("quit")).toBe(true)
  expect(calls).toEqual(["operator", "model", "installer launch", "quit"])
})

test.each(["quit", "relaunch"] as const)("an existing ordinary %s refuses update instead of installing after exit", async (intent) => {
  const operator = deferred(), calls: string[] = []
  const shutdown = createShutdownCoordinator({
    async closeOperator() { calls.push("operator"); await operator.promise },
    async stopServers() { calls.push("model") },
    finish(value) { calls.push(value) },
    blocked() { throw new Error("Unexpected failure") },
  })
  const closing = shutdown.request(intent)
  expect(await shutdown.update(() => { calls.push("installer") })).toBe(false)
  expect(calls).toEqual(["operator"])
  operator.resolve()
  expect(await closing).toBe(true)
  expect(await shutdown.update(() => { calls.push("installer") })).toBe(false)
  expect(calls).toEqual(["operator", "model", intent])
})

test("a synchronous operator callback cannot transfer ordinary shutdown to an update", async () => {
  const calls: string[] = []
  const shutdown = createShutdownCoordinator({
    async closeOperator() {
      calls.push("operator")
      expect(await shutdown.update(() => { calls.push("installer") })).toBe(false)
    },
    async stopServers() { calls.push("model") },
    finish(intent) { calls.push(intent) },
    blocked() { throw new Error("Unexpected failure") },
  })
  expect(await shutdown.request("quit")).toBe(true)
  expect(calls).toEqual(["operator", "model", "quit"])
})

test("quit and relaunch raised synchronously by installer launch cannot finish before handoff", async () => {
  const calls: string[] = [], requests: Promise<boolean>[] = []
  const shutdown = createShutdownCoordinator({
    async closeOperator() { calls.push("operator") },
    async stopServers() { calls.push("model") },
    finish(intent) { calls.push(intent) },
    blocked() { throw new Error("Unexpected failure") },
  })
  expect(await shutdown.update(() => {
    calls.push("installer start")
    requests.push(shutdown.request("quit"), shutdown.request("relaunch"))
    calls.push("installer end")
  })).toBe(true)
  expect(await Promise.all(requests)).toEqual([false, false])
  expect(calls).toEqual(["operator", "model", "installer start", "installer end"])
  expect(await shutdown.request("quit")).toBe(true)
  expect(calls).toEqual(["operator", "model", "installer start", "installer end", "quit"])
})

test("atomic update cleanup failure releases ownership and never queues a competing relaunch", async () => {
  const operator = deferred(), calls: string[] = []
  let attempts = 0
  const shutdown = createShutdownCoordinator({
    async closeOperator() {
      calls.push("operator")
      await operator.promise
      if (++attempts === 1) throw new Error("OPERATOR_REQUEST_UNCONFIRMED")
    },
    async stopServers() { calls.push("model") },
    finish(intent) { calls.push(intent) },
    blocked(error) { expect(String(error)).toContain("OPERATOR_REQUEST_UNCONFIRMED"); calls.push("blocked") },
  })
  const installing = shutdown.update(() => { calls.push("installer") })
  expect(await shutdown.request("relaunch")).toBe(false)
  operator.resolve()
  expect(await installing).toBe(false)
  expect(calls).toEqual(["operator", "blocked"])
  expect(await shutdown.update(() => { calls.push("installer") })).toBe(true)
  expect(await shutdown.request("quit")).toBe(true)
  expect(calls).toEqual(["operator", "blocked", "operator", "model", "installer", "quit"])
})

test("a failed synchronous installer handoff remains retryable without duplicating prepared cleanup", async () => {
  const calls: string[] = []
  const shutdown = createShutdownCoordinator({
    async closeOperator() { calls.push("operator") },
    async stopServers() { calls.push("model") },
    finish(intent) { calls.push(intent) },
    blocked(error) { expect(String(error)).toContain("INSTALLER_FAILED"); calls.push("blocked") },
  })
  expect(await shutdown.update(() => { calls.push("failed installer"); throw new Error("INSTALLER_FAILED") })).toBe(false)
  expect(calls).toEqual(["operator", "model", "failed installer", "blocked"])
  expect(await shutdown.update(() => { calls.push("installer retry") })).toBe(true)
  expect(await shutdown.request("quit")).toBe(true)
  expect(calls).toEqual(["operator", "model", "failed installer", "blocked", "installer retry", "quit"])
})

test("process shutdown is bounded and an unconfirmed exit is not reported as complete", async () => {
  const exit = deferred()
  await expect(waitForProcessExit(exit.promise, 5)).rejects.toThrow("PROCESS_EXIT_UNCONFIRMED")
  exit.resolve()
  await expect(waitForProcessExit(exit.promise, 50)).resolves.toBeUndefined()
})

test("owned termination waits for service and attachment cleanup, then the actual exit", async () => {
  const service = deferred(),
    attachment = deferred(),
    cleaningAttachment = deferred(),
    requested = deferred(),
    exit = deferred()
  const calls: string[] = []
  const closing = closeOwnedProcess({
    async cleanup() {
      calls.push("service cleanup")
      await service.promise
      calls.push("attachment cleanup")
      cleaningAttachment.resolve()
      await attachment.promise
    },
    exited: () => false,
    requestStop() {
      calls.push("owned termination")
      requested.resolve()
      return true
    },
    exit: exit.promise,
    timeoutMs: 100,
  }).then(() => {
    calls.push("closed")
  })
  expect(calls).toEqual(["service cleanup"])
  service.resolve()
  await cleaningAttachment.promise
  expect(calls).toEqual(["service cleanup", "attachment cleanup"])
  attachment.resolve()
  await requested.promise
  expect(calls).toEqual(["service cleanup", "attachment cleanup", "owned termination"])
  exit.resolve()
  await closing
  expect(calls).toEqual(["service cleanup", "attachment cleanup", "owned termination", "closed"])
})

test("rejected service or attachment cleanup never requests owned termination", async () => {
  for (const boundary of ["service", "attachment"]) {
    const calls: string[] = []
    await expect(
      closeOwnedProcess({
        async cleanup() {
          calls.push("service")
          if (boundary === "service") throw new Error("OPERATOR_REQUEST_UNCONFIRMED")
          calls.push("attachment")
          throw new Error("ATTACHMENT_CLEANUP_UNCONFIRMED")
        },
        exited: () => false,
        requestStop() {
          calls.push("termination")
          return true
        },
        exit: Promise.resolve(),
        timeoutMs: 5,
      }),
    ).rejects.toThrow(boundary === "service" ? "OPERATOR_REQUEST_UNCONFIRMED" : "ATTACHMENT_CLEANUP_UNCONFIRMED")
    expect(calls).toEqual(boundary === "service" ? ["service"] : ["service", "attachment"])
  }
})

test("true and false stop results cannot substitute for observed process exit", async () => {
  for (const result of [true, false]) {
    const exit = deferred()
    let calls = 0
    await expect(
      closeOwnedProcess({
        async cleanup() {},
        exited: () => false,
        requestStop() {
          calls++
          return result
        },
        exit: exit.promise,
        timeoutMs: 5,
      }),
    ).rejects.toThrow("PROCESS_EXIT_UNCONFIRMED")
    expect(calls).toBe(1)
    exit.resolve()
  }
})

test("a false stop result can finish only when the original exit is observed", async () => {
  const requested = deferred(),
    exit = deferred()
  let completed = false
  const closing = closeOwnedProcess({
    async cleanup() {},
    exited: () => false,
    requestStop() {
      requested.resolve()
      return false
    },
    exit: exit.promise,
    timeoutMs: 100,
  }).then(() => {
    completed = true
  })
  await requested.promise
  expect(completed).toBe(false)
  exit.resolve()
  await closing
  expect(completed).toBe(true)
})

test("an already-exited worker still requires cleanup and original exit proof without another signal", async () => {
  const exit = deferred()
  let cleaned = false
  await expect(
    closeOwnedProcess({
      async cleanup() {
        cleaned = true
      },
      exited: () => true,
      requestStop() {
        throw new Error("must not signal an exited worker")
      },
      exit: exit.promise,
      timeoutMs: 5,
    }),
  ).rejects.toThrow("PROCESS_EXIT_UNCONFIRMED")
  expect(cleaned).toBe(true)
  exit.resolve()
  await expect(
    closeOwnedProcess({
      async cleanup() {},
      exited: () => true,
      requestStop() {
        throw new Error("must not signal an exited worker")
      },
      exit: exit.promise,
      timeoutMs: 5,
    }),
  ).resolves.toBeUndefined()
})

test("a throwing termination callback does not complete shutdown", async () => {
  await expect(
    closeOwnedProcess({
      async cleanup() {},
      exited: () => false,
      requestStop() {
        throw new Error("OWNED_STOP_UNCONFIRMED")
      },
      exit: Promise.resolve(),
      timeoutMs: 5,
    }),
  ).rejects.toThrow("OWNED_STOP_UNCONFIRMED")
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
