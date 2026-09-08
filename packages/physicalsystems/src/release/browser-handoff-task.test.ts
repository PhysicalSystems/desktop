// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { createBrowserHandoffTask } from "./browser-handoff-task"

test("duplicate callers share one exact confirmation and an expired result never becomes eligible", async () => {
  let calls = 0
  let settle = (_value: boolean) => {}
  const pending = new Promise<boolean>((resolve) => {
    settle = resolve
  })
  const handoff = createBrowserHandoffTask(
    {
      async confirmHandoff() {
        calls++
        return pending
      },
      observation: () => ({ browserPhase: "handoff-targets", handoffPhase: "native", handoffOutcome: "pending" }),
    },
    10,
  )
  const first = handoff.confirm("http://127.0.0.1/exact-inert")
  expect(handoff.confirm("http://127.0.0.1/exact-inert")).toBe(first)
  expect(() => handoff.confirm("http://127.0.0.1/other-inert")).toThrow()
  await Promise.resolve()
  const draining = handoff.drain()
  expect(handoff.drain()).toBe(draining)
  const observed = await draining
  expect(observed.settled).toBe(false)
  expect(observed.observation).toMatchObject({
    handoffQuiescence: "unconfirmed",
    handoffPhase: "native",
    handoffOutcome: "pending",
  })
  settle(true)
  expect(await first).toBe(false)
  expect(calls).toBe(1)
  expect(observed.observation.handoffQuiescence).toBe("unconfirmed")
  expect(Object.isFrozen(observed.observation)).toBe(true)
})

test("cancellation before scheduled confirmation starts no browser operation", async () => {
  let calls = 0
  const handoff = createBrowserHandoffTask({
    async confirmHandoff() {
      calls++
      return true
    },
  })
  const confirming = handoff.confirm("http://127.0.0.1/exact-inert")
  handoff.cancel()
  expect(await confirming).toBe(false)
  expect((await handoff.drain()).settled).toBe(true)
  expect(calls).toBe(0)
})
