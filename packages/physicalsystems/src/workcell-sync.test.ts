// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, jest, test } from "bun:test"
import { createWorkcellSync } from "./workcell-sync"
import type { ProjectWorkcellState } from "./workcell-project-types"
import type { WorkcellAccountState } from "./workcell-account-types"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const close of cleanups.splice(0)) close()
  jest.useRealTimers()
})

function fixture() {
  const account: WorkcellAccountState = {
    revision: 0,
    sessionId: "session-a",
    status: "signed_in",
    account: { id: "account-a", name: "A", email: "a@example.invalid" },
    pending: null,
    error: null,
  }
  const control = {
    account,
    generation: 0,
    automatic: false,
    projects: [
      {
        id: "project-one",
        name: "Simulation test",
        cwd: "/private/project",
        conversations: [{ content: "private history" }],
      },
    ],
    calls: [] as { operation: string; projectId: string; metadata: { name: string; task: string } }[],
    dispatch: async (_raw: unknown): Promise<ProjectWorkcellState> => ({
      projectId: "project-one",
      accountId: "account-a",
      status: "linked",
      workcell: null,
    }),
  }
  const accounts = new Set<() => void>()
  const projects = new Set<() => void>()
  const sync = createWorkcellSync({
    account: {
      snapshot: () => account,
      generation: () => control.generation,
      automaticSyncEnabled: () => control.automatic,
      subscribe(listener) {
        accounts.add(listener)
        return () => {
          accounts.delete(listener)
        }
      },
    },
    projects: {
      snapshot: async () => ({ projects: structuredClone(control.projects) }),
      subscribe(listener) {
        projects.add(listener)
        return () => {
          projects.delete(listener)
        }
      },
    },
    links: {
      dispatch: async (raw) => {
        control.calls.push(structuredClone(raw) as (typeof control.calls)[number])
        return control.dispatch(raw)
      },
    },
  })
  cleanups.push(sync.dispose)
  return {
    control,
    sync,
    accounts,
    projects,
    changed: () => {
      for (const listener of accounts) listener()
    },
    updated: () => {
      for (const listener of projects) listener()
    },
  }
}

test("main startup, unified sign-in and new-project events register only allowlisted metadata without a mounted UI", async () => {
  const { control, sync, changed, updated, accounts, projects } = fixture()
  await sync.sync()
  expect(control.calls).toHaveLength(0)
  control.automatic = true
  changed()
  await sync.sync()
  expect(control.calls).toEqual([
    { operation: "ensure", projectId: "project-one", metadata: { name: "Simulation test", task: "" } },
  ])
  control.projects.push({ id: "project-two", name: "Next workcell", cwd: "/private/other", conversations: [] })
  updated()
  await sync.sync()
  expect(control.calls.map((call) => call.projectId)).toEqual(["project-one", "project-two"])
  for (let index = 0; index < 10; index++) updated()
  await sync.sync()
  expect(control.calls).toHaveLength(2)
  sync.dispose()
  expect(accounts.size).toBe(0)
  expect(projects.size).toBe(0)
  control.projects.push({ id: "project-three", name: "After quit", cwd: "/private/third", conversations: [] })
  await sync.sync()
  expect(control.calls).toHaveLength(2)
})

test("offline retry waits for its bounded interval despite frequent operator snapshots and resumes without changing identity", async () => {
  jest.useFakeTimers()
  const { control, sync, changed, updated } = fixture()
  control.automatic = true
  control.dispatch = async (raw) => ({
    projectId: (raw as { projectId: string }).projectId,
    accountId: "account-a",
    status: "pending",
    workcell: null,
  })
  changed()
  await sync.sync()
  for (let index = 0; index < 20; index++) updated()
  await sync.sync()
  expect(control.calls).toHaveLength(1)
  jest.advanceTimersToNextTimer()
  await sync.sync()
  expect(control.calls).toHaveLength(2)
  expect(control.calls[1]).toEqual(control.calls[0])
  control.account.status = "signed_out"
  control.account.account = null
  control.generation++
  changed()
  jest.advanceTimersToNextTimer()
  await sync.sync()
  expect(control.calls).toHaveLength(2)
})

test("a restored large profile is bounded per interval and account switch cannot continue the previous pass", async () => {
  jest.useFakeTimers()
  const { control, sync, changed, updated } = fixture()
  control.projects = Array.from({ length: 45 }, (_, index) => ({
    id: `project-${index}`,
    name: `Workcell ${index}`,
    cwd: "private",
    conversations: [],
  }))
  control.automatic = true
  changed()
  await sync.sync()
  expect(control.calls).toHaveLength(20)
  updated()
  await sync.sync()
  expect(control.calls).toHaveLength(20)
  jest.advanceTimersToNextTimer()
  await sync.sync()
  expect(control.calls).toHaveLength(40)
  control.dispatch = async (raw) => {
    control.account.status = "signed_out"
    control.account.account = null
    control.generation++
    changed()
    return {
      projectId: (raw as { projectId: string }).projectId,
      accountId: null,
      status: "signed_out",
      workcell: null,
    }
  }
  jest.advanceTimersToNextTimer()
  await sync.sync()
  expect(control.calls).toHaveLength(41)
})
