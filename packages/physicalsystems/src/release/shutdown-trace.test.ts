// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { observeShutdownTrace } from "./shutdown-trace"

test("shutdown observation waits for complete markers and measures time since the last phase", () => {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let now = 100
  const trace = observeShutdownTrace({ stdout, stderr }, () => now)
  expect(trace.snapshot()).toEqual({
    phase: "NOT_OBSERVED",
    elapsedMs: null,
    sincePhaseMs: null,
    blockedReason: "NONE",
    blockedAtPhase: null,
  })
  stderr.write("PHYSICALSYSTEMS_SHUTDOWN_OPERATOR_")
  expect(trace.snapshot().phase).toBe("NOT_OBSERVED")
  stderr.write("BEFORE elapsed=0 reason=NONE\n")
  now = 250
  expect(trace.snapshot()).toEqual({
    phase: "OPERATOR_BEFORE",
    elapsedMs: 0,
    sincePhaseMs: 150,
    blockedReason: "NONE",
    blockedAtPhase: null,
  })
  stdout.write("PHYSICALSYSTEMS_SHUTDOWN_WORKER_CLOSE_BEFORE elapsed=149 reason=NONE\r\n")
  const frozen = trace.snapshot()
  now = 650
  expect(trace.snapshot()).toEqual({
    phase: "WORKER_CLOSE_BEFORE",
    elapsedMs: 149,
    sincePhaseMs: 400,
    blockedReason: "NONE",
    blockedAtPhase: null,
  })
  expect(frozen.sincePhaseMs).toBe(0)
  expect(Object.isFrozen(frozen)).toBe(true)
  trace.close()
  stdout.destroy()
  stderr.destroy()
})

test("shutdown observation rejects malformed, private, regressing, and oversized lines", () => {
  const stderr = new PassThrough()
  const trace = observeShutdownTrace({ stdout: null, stderr }, () => 0)
  stderr.write("PHYSICALSYSTEMS_SHUTDOWN_OPERATOR_BEFORE elapsed=0 reason=NONE\n")
  for (const line of [
    "PHYSICALSYSTEMS_SHUTDOWN_PRIVATE_PATH elapsed=1 reason=NONE",
    "PHYSICALSYSTEMS_SHUTDOWN_BLOCKED elapsed=1 reason=PRIVATE_CREDENTIAL",
    "PHYSICALSYSTEMS_SHUTDOWN_BLOCKED elapsed=1 reason=NONE",
    "PHYSICALSYSTEMS_SHUTDOWN_SERVERS_BEFORE elapsed=1 reason=UNKNOWN",
    "PHYSICALSYSTEMS_SHUTDOWN_SERVERS_BEFORE elapsed=-1 reason=NONE",
    "PHYSICALSYSTEMS_SHUTDOWN_SERVERS_BEFORE elapsed=01 reason=NONE",
    "PHYSICALSYSTEMS_SHUTDOWN_SERVERS_BEFORE elapsed=1.1 reason=NONE",
    "PHYSICALSYSTEMS_SHUTDOWN_SERVERS_BEFORE elapsed=3600001 reason=NONE",
    "PHYSICALSYSTEMS_SHUTDOWN_SERVERS_BEFORE elapsed=Infinity reason=NONE",
    "PHYSICALSYSTEMS_SHUTDOWN_SERVERS_BEFORE elapsed=1 reason=NONE /private/token",
    `PRIVATE${"x".repeat(10_000)}PHYSICALSYSTEMS_SHUTDOWN_QUIT_FINISH elapsed=1 reason=NONE`,
  ])
    stderr.write(line + "\n")
  expect(trace.snapshot().phase).toBe("OPERATOR_BEFORE")
  stderr.write("PHYSICALSYSTEMS_SHUTDOWN_BLOCKED elapsed=6500 reason=OPERATOR_REQUEST_UNCONFIRMED\n")
  stderr.write("PHYSICALSYSTEMS_SHUTDOWN_QUIT_FINISH elapsed=6400 reason=NONE\n")
  expect(trace.snapshot()).toEqual({
    phase: "BLOCKED",
    elapsedMs: 6500,
    sincePhaseMs: 0,
    blockedReason: "OPERATOR_REQUEST_UNCONFIRMED",
    blockedAtPhase: "OPERATOR_BEFORE",
  })
  stderr.write("PHYSICALSYSTEMS_SHUTDOWN_OPERATOR_BEFORE elapsed=7000 reason=NONE\n")
  expect(trace.snapshot().blockedReason).toBe("NONE")
  expect(JSON.stringify(trace.snapshot())).not.toContain("PRIVATE")
  expect(JSON.stringify(trace.snapshot())).not.toContain("/private")
  trace.close()
  stderr.destroy()
})

test("shutdown streams cannot complete each other's markers and close leaves other logging listeners intact", () => {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const logged: string[] = []
  stderr.on("data", (chunk: Buffer) => logged.push(chunk.toString()))
  const trace = observeShutdownTrace({ stdout, stderr })
  stdout.write("PHYSICALSYSTEMS_SHUTDOWN_OPERATOR_")
  stderr.write("BEFORE elapsed=0 reason=NONE\n")
  expect(trace.snapshot().phase).toBe("NOT_OBSERVED")
  trace.close()
  trace.close()
  stdout.write("BEFORE elapsed=0 reason=NONE\n")
  stderr.write("PHYSICALSYSTEMS_SHUTDOWN_QUIT_FINISH elapsed=1 reason=NONE\n")
  expect(trace.snapshot().phase).toBe("NOT_OBSERVED")
  expect(stdout.listenerCount("data")).toBe(0)
  expect(stderr.listenerCount("data")).toBe(1)
  expect(logged).toHaveLength(2)
  stdout.destroy()
  stderr.destroy()
})

test("shutdown elapsed observations stay bounded and never provide exit authority", () => {
  const stderr = new PassThrough()
  let now = 10
  const trace = observeShutdownTrace({ stdout: null, stderr }, () => now)
  stderr.write("PHYSICALSYSTEMS_SHUTDOWN_QUIT_FINISH elapsed=3600000 reason=NONE\n")
  now = 9
  expect(trace.snapshot().sincePhaseMs).toBe(0)
  now = 10_000_000
  expect(trace.snapshot().sincePhaseMs).toBe(3_600_000)
  now = 20
  expect(trace.snapshot().sincePhaseMs).toBe(3_600_000)
  expect(Object.keys(trace.snapshot()).sort()).toEqual([
    "blockedAtPhase",
    "blockedReason",
    "elapsedMs",
    "phase",
    "sincePhaseMs",
  ])
  trace.close()
  stderr.destroy()
})

test("a returned worker stop request is distinguishable from confirmed worker exit", () => {
  const stderr = new PassThrough()
  let now = 0
  const trace = observeShutdownTrace({ stdout: null, stderr }, () => now)
  stderr.write("PHYSICALSYSTEMS_SHUTDOWN_WORKER_EXIT_BEFORE elapsed=5 reason=NONE\n")
  stderr.write("PHYSICALSYSTEMS_SHUTDOWN_WORKER_EXIT_REQUESTED elapsed=6 reason=NONE\n")
  now = 6500
  expect(trace.snapshot()).toEqual({
    phase: "WORKER_EXIT_REQUESTED",
    elapsedMs: 6,
    sincePhaseMs: 6500,
    blockedReason: "NONE",
    blockedAtPhase: null,
  })
  stderr.write("PHYSICALSYSTEMS_SHUTDOWN_BLOCKED elapsed=6506 reason=PROCESS_EXIT_UNCONFIRMED\n")
  expect(trace.snapshot().blockedAtPhase).toBe("WORKER_EXIT_REQUESTED")
  expect(trace.snapshot().blockedReason).toBe("PROCESS_EXIT_UNCONFIRMED")
  expect(trace.snapshot().phase).not.toBe("WORKER_EXIT_AFTER")
  trace.close()
  stderr.destroy()
})

test("blocked traces preserve the pending phase, while unavailable clocks cannot break stream delivery", () => {
  const stderr = new PassThrough()
  let mode = "normal"
  const trace = observeShutdownTrace({ stdout: null, stderr }, () => {
    if (mode === "throw") throw new Error("PRIVATE_CLOCK")
    return mode === "invalid" ? NaN : 100
  })
  stderr.write("PHYSICALSYSTEMS_SHUTDOWN_WORKER_CLOSE_BEFORE elapsed=0 reason=NONE\n")
  stderr.write("PHYSICALSYSTEMS_SHUTDOWN_BLOCKED elapsed=6500 reason=UNKNOWN\n")
  expect(trace.snapshot().blockedAtPhase).toBe("WORKER_CLOSE_BEFORE")
  stderr.write("PHYSICALSYSTEMS_SHUTDOWN_OPERATOR_BEFORE elapsed=6600 reason=NONE\n")
  expect(trace.snapshot().blockedAtPhase).toBeNull()
  stderr.write("PHYSICALSYSTEMS_SHUTDOWN_SERVERS_BEFORE elapsed=6700 reason=NONE\n")
  stderr.write("PHYSICALSYSTEMS_SHUTDOWN_BLOCKED elapsed=9000 reason=UNKNOWN\n")
  expect(trace.snapshot().blockedAtPhase).toBe("SERVERS_BEFORE")
  for (const state of ["throw", "invalid"]) {
    mode = state
    expect(() => stderr.write("PHYSICALSYSTEMS_SHUTDOWN_BLOCKED elapsed=10000 reason=UNKNOWN\n")).not.toThrow()
    expect(trace.snapshot().sincePhaseMs).toBeNull()
    expect(trace.snapshot().blockedAtPhase).toBe("SERVERS_BEFORE")
    expect(JSON.stringify(trace.snapshot())).not.toContain("PRIVATE")
  }
  trace.close()
  stderr.destroy()
})
