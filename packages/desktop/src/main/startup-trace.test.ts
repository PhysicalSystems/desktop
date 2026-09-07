// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { startupPhases, startupTrace } from "./startup-trace"

test("startup trace is disabled unless the exact qualification opt-in is set", () => {
  const writes: string[] = []
  for (const flag of [undefined, "", "0", "true", "yes", " 1", "1 "])
    startupTrace("MAIN_ENTER", {
      env: { PHYSICALSYSTEMS_QUALIFICATION_TRACE: flag },
      write: (_fd, message) => writes.push(message),
    })
  expect(writes).toEqual([])
})

test("startup trace writes only allowlisted complete literal markers to stderr", () => {
  const writes: { fd: number; message: string }[] = []
  const io = {
    env: { PHYSICALSYSTEMS_QUALIFICATION_TRACE: "1", PRIVATE_TOKEN: "credential-canary", HOME: "/private/profile" },
    write: (fd: number, message: string) => writes.push({ fd, message }),
  }
  for (const phase of startupPhases) startupTrace(phase, io)
  expect(writes).toHaveLength(15)
  expect(writes.every((item) => item.fd === 2 && /^PHYSICALSYSTEMS_STARTUP_[A-Z_]+\n$/.test(item.message))).toBe(true)
  expect(writes[0]?.message).toBe("PHYSICALSYSTEMS_STARTUP_MAIN_ENTER\n")
  expect(writes.at(-1)?.message).toBe("PHYSICALSYSTEMS_STARTUP_OPERATOR_AFTER\n")
  expect(JSON.stringify(writes)).not.toContain("credential-canary")
  expect(JSON.stringify(writes)).not.toContain("/private/profile")
  for (const phase of ["credential-canary", "MAIN_ENTER\n/private/profile", "UNKNOWN"])
    startupTrace(phase as (typeof startupPhases)[number], io)
  expect(writes).toHaveLength(15)
})

test("startup trace is synchronous and a failed write cannot change startup control flow", () => {
  const events: string[] = []
  startupTrace("CRASH_REPORTER_BEFORE", {
    env: { PHYSICALSYSTEMS_QUALIFICATION_TRACE: "1" },
    write: (_fd, message) => events.push(message),
  })
  events.push("following native call")
  expect(events).toEqual(["PHYSICALSYSTEMS_STARTUP_CRASH_REPORTER_BEFORE\n", "following native call"])
  expect(() =>
    startupTrace("SYSTEM_CERTIFICATES_BEFORE", {
      env: { PHYSICALSYSTEMS_QUALIFICATION_TRACE: "1" },
      write: () => {
        throw new Error("private-path-and-credential-canary")
      },
    }),
  ).not.toThrow()
})
