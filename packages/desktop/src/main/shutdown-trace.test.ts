// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { observeShutdownTrace, shutdownPhases } from "../../../physicalsystems/src/release/shutdown-trace"
import type { ShutdownPhase } from "../../../physicalsystems/src/release/shutdown-trace"
import { createShutdownTrace } from "./shutdown-trace"

test("shutdown trace requires the exact qualification opt-in and a known phase", () => {
  const writes: string[] = []
  for (const flag of [undefined, "", "0", "true", "yes", " 1", "1 "])
    createShutdownTrace({
      env: { PHYSICALSYSTEMS_QUALIFICATION_TRACE: flag },
      write: (_fd, line) => writes.push(line),
    })("OPERATOR_BEFORE")
  const trace = createShutdownTrace({
    env: { PHYSICALSYSTEMS_QUALIFICATION_TRACE: "1" },
    write: (_fd, line) => writes.push(line),
  })
  for (const phase of ["PRIVATE_TOKEN", "OPERATOR_BEFORE\n/private/profile", "UNKNOWN"]) trace(phase as ShutdownPhase)
  expect(writes).toEqual([])
})

test("actual shutdown producer and observer preserve ordered fixed phases without private error fields", () => {
  const stderr = new PassThrough()
  let now = 500_000
  const observed = observeShutdownTrace({ stdout: null, stderr }, () => now)
  const writes: { fd: number; line: string }[] = []
  const trace = createShutdownTrace({
    env: { PHYSICALSYSTEMS_QUALIFICATION_TRACE: "1", PRIVATE_CREDENTIAL: "private-token", HOME: "/private/profile" },
    now: () => now,
    write: (fd, line) => {
      writes.push({ fd, line })
      stderr.write(line)
    },
  })
  for (const phase of shutdownPhases) {
    trace(phase, new Error("ATTACHMENT_CLEANUP_UNCONFIRMED"))
    expect(observed.snapshot().phase).toBe(phase)
    now += 11.75
  }
  expect(writes[0]).toEqual({ fd: 2, line: "PHYSICALSYSTEMS_SHUTDOWN_OPERATOR_BEFORE elapsed=0 reason=NONE\n" })
  expect(
    writes.every(
      (item) => item.fd === 2 && /^PHYSICALSYSTEMS_SHUTDOWN_[A-Z_]+ elapsed=[0-9]+ reason=[A-Z_]+\n$/.test(item.line),
    ),
  ).toBe(true)
  expect(observed.snapshot().blockedReason).toBe("ATTACHMENT_CLEANUP_UNCONFIRMED")
  trace("BLOCKED", new Error("private-token /private/profile"))
  expect(observed.snapshot().blockedReason).toBe("UNKNOWN")
  trace("OPERATOR_BEFORE")
  expect(observed.snapshot().blockedReason).toBe("NONE")
  expect(observed.snapshot().elapsedMs).toBe(141)
  expect(JSON.stringify(writes)).not.toContain("private-token")
  expect(JSON.stringify(writes)).not.toContain("/private/profile")
  observed.close()
  stderr.destroy()
})

test("shutdown trace writes synchronously, clamps timing, and cannot throw or stringify raw errors", () => {
  const events: string[] = []
  let now = 100
  const trace = createShutdownTrace({
    env: { PHYSICALSYSTEMS_QUALIFICATION_TRACE: "1" },
    now: () => now,
    write: (_fd, line) => events.push(line),
  })
  trace("OPERATOR_BEFORE")
  events.push("following shutdown operation")
  expect(events[0]).toBe("PHYSICALSYSTEMS_SHUTDOWN_OPERATOR_BEFORE elapsed=0 reason=NONE\n")
  expect(events[1]).toBe("following shutdown operation")
  now = 90
  trace("WORKER_CLOSE_BEFORE")
  expect(events.at(-1)).toContain("elapsed=0")
  now = 10_000_000
  trace("BLOCKED", {
    toString() {
      throw new Error("PRIVATE_CANARY")
    },
  })
  expect(events.at(-1)).toContain("elapsed=3600000 reason=UNKNOWN")
  const failed = createShutdownTrace({
    env: { PHYSICALSYSTEMS_QUALIFICATION_TRACE: "1" },
    write() {
      throw new Error("PRIVATE_CANARY")
    },
  })
  expect(() => failed("OPERATOR_BEFORE")).not.toThrow()
  const hostile = new Error()
  Object.defineProperty(hostile, "message", {
    get() {
      throw new Error("PRIVATE_CANARY")
    },
  })
  expect(() => trace("BLOCKED", hostile)).not.toThrow()
  expect(events.at(-1)).toContain("reason=UNKNOWN")
  let reads = 0
  const changing = new Error()
  Object.defineProperty(changing, "message", {
    get() {
      return ++reads === 1 ? "PROCESS_EXIT_UNCONFIRMED" : "PRIVATE_CANARY"
    },
  })
  trace("BLOCKED", changing)
  expect(reads).toBe(1)
  expect(events.at(-1)).toContain("reason=PROCESS_EXIT_UNCONFIRMED")
  expect(JSON.stringify(events)).not.toContain("PRIVATE_CANARY")
})
