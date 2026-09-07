// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { createConversationStarter } from "./conversation"
import type { PhysicalProject } from "./types"

const project: PhysicalProject = {
  id: "project-a",
  name: "Workcell",
  cwd: "/workcell",
  connection: {
    kind: "local",
    label: "Node",
    status: "offline",
    observedAt: null,
    deviceCount: null,
    inUseCount: null,
  },
  conversations: [],
}

test("local session exists before its exact project/server binding", async () => {
  const events: unknown[] = []
  const start = createConversationStarter({
    async create(owner, server) {
      events.push(["create", owner.cwd, server])
      return { id: "session-a", title: "Empty conversation" }
    },
    async bind(owner, server, session) {
      events.push(["bind", owner.id, server, session.id])
      return true
    },
  })
  expect(await start(project, "sidecar")).toEqual({ id: "session-a", title: "Empty conversation" })
  expect(events).toEqual([
    ["create", "/workcell", "sidecar"],
    ["bind", "project-a", "sidecar", "session-a"],
  ])
})

test("overlapping clicks coalesce and a failed binding reuses the existing session", async () => {
  const calls = { create: 0, bind: 0, accepted: false }
  const start = createConversationStarter({
    async create() {
      calls.create++
      return { id: "retained-session", title: "Empty conversation" }
    },
    async bind(_owner, _server, session) {
      expect(session.id).toBe("retained-session")
      calls.bind++
      return calls.accepted
    },
  })
  const first = start(project, "sidecar")
  const duplicate = start(project, "sidecar")
  expect(first).toBe(duplicate)
  expect(await first).toBeUndefined()
  expect(calls).toEqual({ create: 1, bind: 1, accepted: false })
  calls.accepted = true
  expect((await start(project, "sidecar"))?.id).toBe("retained-session")
  expect(calls).toEqual({ create: 1, bind: 2, accepted: true })
  await start(project, "sidecar")
  expect(calls.create).toBe(2)
})

test("a rejected create cannot bind a missing session and can be retried", async () => {
  const calls = { create: 0, bind: 0 }
  const start = createConversationStarter({
    async create() {
      calls.create++
      if (calls.create === 1) throw new Error("local server unavailable")
      return { id: "retry", title: "Empty conversation" }
    },
    async bind() {
      calls.bind++
      return true
    },
  })
  await expect(start(project, "sidecar")).rejects.toThrow("local server unavailable")
  expect(calls.bind).toBe(0)
  expect((await start(project, "sidecar"))?.id).toBe("retry")
  expect(calls.bind).toBe(1)
})
