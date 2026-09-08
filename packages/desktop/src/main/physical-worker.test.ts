// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { resolve, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createContext, SourceTextModule, SyntheticModule } from "node:vm"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function settled(check: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return
    await Promise.resolve()
  }
  throw new Error("INERT_WORKER_DID_NOT_SETTLE")
}

/** Execute the actual worker with transpilation only. No real parent port,
 * model server, gateway, operator service, native vault or timer is available. */
async function fixture() {
  const owner = {
    projectId: "project-inert",
    conversationId: "conversation-inert",
    serverId: "sidecar",
    sessionId: "session-inert",
    directory: "/inert/status-audit",
  }
  const reads: ReturnType<typeof deferred<unknown>>[] = []
  const replies = new Map<string, ReturnType<typeof deferred<{ error?: string }>>>()
  const events: { operation: string; busy: boolean }[] = []
  let listener!: (message: { data: Record<string, unknown> }) => void
  let timer: (() => void) | undefined
  let busy = false
  let applied: ((value: boolean) => Promise<void> | void) | undefined
  const snapshot = () => ({
    projects: [{ id: owner.projectId, cwd: owner.directory }],
    conversation: { ...owner, busy },
  })
  const operator = {
    snapshot,
    subscribe() {
      return () => {}
    },
    async close() {},
    async agentCall() {
      throw new Error("FORBIDDEN_INERT_AGENT_CALL")
    },
    async command(name: string, payload: Record<string, unknown>) {
      if (name === "session.bind") return { agentToken: "inert-token", binding: owner }
      if (name === "session.agentState") {
        busy = payload.busy === true
        events.push({ operation: "apply", busy })
        const result = applied?.(busy)
        if (result) await result
        return snapshot()
      }
      if (name === "experiment.approveAndContinue") {
        events.push({ operation: "approve", busy })
        if (busy) throw new Error("Wait for the current assistant request to finish or cancel it before continuing.")
        return snapshot()
      }
      throw new Error("UNEXPECTED_INERT_COMMAND")
    },
  }
  const context = createContext({
    URL,
    Buffer,
    AbortSignal,
    Map,
    JSON,
    Promise,
    Error,
    clearTimeout() {
      timer = undefined
    },
    setTimeout(callback: () => void) {
      timer = callback
      return 1
    },
    process: {
      env: {},
      parentPort: {
        on(name: string, callback: typeof listener) {
          if (name === "message") listener = callback
        },
        postMessage(message: { id?: string; error?: string }) {
          if (message.id) replies.get(message.id)?.resolve(message)
        },
      },
    },
    fetch: async (url: URL) => {
      if (url.pathname === "/session/session-inert")
        return { ok: true, json: async () => ({ id: owner.sessionId, directory: owner.directory }) }
      if (url.pathname !== "/session/status") throw new Error("FORBIDDEN_INERT_ROUTE")
      const read = deferred<unknown>()
      reads.push(read)
      return { ok: true, json: () => read.promise }
    },
  })
  const fixed = (exports: Record<string, unknown>) =>
    new SyntheticModule(
      Object.keys(exports),
      function () {
        for (const [key, value] of Object.entries(exports)) this.setExport(key, value)
      },
      { context },
    )
  const transpiler = new Bun.Transpiler({ loader: "ts" })
  const status = new SourceTextModule(
    transpiler.transformSync(
      await readFile(new URL("../../../physicalsystems/src/agent-status.ts", import.meta.url), "utf8"),
    ),
    { context },
  )
  const core = fixed({ createOperatorService: async () => operator, agentToolDefinitions: [] })
  const worker = new SourceTextModule(
    transpiler.transformSync(await readFile(new URL("./physical-worker.ts", import.meta.url), "utf8")),
    {
      context,
      initializeImportMeta(meta) {
        meta.url = "file:///inert/physical-worker.js"
      },
      async importModuleDynamically() {
        if (core.status === "unlinked")
          await core.link(() => {
            throw new Error("UNEXPECTED_INERT_IMPORT")
          })
        if (core.status !== "evaluated") await core.evaluate()
        return core
      },
    },
  )
  await worker.link(async (specifier) => {
    if (specifier === "node:crypto") return fixed({ randomUUID })
    if (specifier === "node:path") return fixed({ resolve, dirname, join })
    if (specifier === "node:url") return fixed({ fileURLToPath })
    if (specifier.endsWith("/agent-status")) return status
    if (specifier.endsWith("/continuation"))
      return fixed({
        admitContinuation() {
          throw new Error("FORBIDDEN_INERT_CONTINUATION")
        },
      })
    if (specifier.endsWith("/gateway"))
      return fixed({ createAgentGateway: async () => ({ url: "http://127.0.0.1:1", close: async () => {} }) })
    throw new Error("UNEXPECTED_INERT_IMPORT")
  })
  await worker.evaluate()
  const send = (method: string, data: Record<string, unknown> = {}) => {
    const id = randomUUID(),
      reply = deferred<{ error?: string }>()
    replies.set(id, reply)
    listener({ data: { id, method, ...data } })
    return reply.promise
  }
  expect((await send("start", { dataDir: "/inert/unused", agentToken: "inert-token" })).error).toBeUndefined()
  expect((await send("server", { url: "http://127.0.0.1:1", password: "inert-password" })).error).toBeUndefined()
  expect((await send("command", { request: { type: "session.bind", ...owner } })).error).toBeUndefined()
  await settled(() => reads.length === 1)
  return {
    reads,
    events,
    busy: () => busy,
    apply(callback: typeof applied) {
      applied = callback
    },
    status(read: number, value: boolean) {
      reads[read]!.resolve({ [owner.sessionId]: { type: value ? "busy" : "idle" } })
    },
    approve: () => send("command", { request: { type: "experiment.approveAndContinue", ...owner } }),
    async poll() {
      await settled(() => Boolean(timer))
      const next = timer!
      timer = undefined
      next()
    },
    async close() {
      applied = undefined
      for (const read of reads) read.resolve(undefined)
      await send("close")
    },
  }
}

test("an older poll cannot overwrite fresh approval preflight in either direction", async () => {
  for (const latest of [false, true]) {
    const f = await fixture()
    try {
      const approval = f.approve()
      await settled(() => f.reads.length === 2)
      f.status(1, latest)
      const result = await approval
      expect(Boolean(result.error)).toBe(latest)
      f.status(0, !latest)
      await f.poll()
      expect(f.busy()).toBe(latest)
      expect(f.events).toEqual([
        { operation: "apply", busy: latest },
        { operation: "approve", busy: latest },
      ])
    } finally {
      await f.close()
    }
  }
})

test("older poll resolving during fresh preflight cannot change the approval guard", async () => {
  const f = await fixture()
  try {
    f.apply((busy) => {
      if (!busy) f.status(0, true)
    })
    const approval = f.approve()
    await settled(() => f.reads.length === 2)
    f.status(1, false)
    expect((await approval).error).toBeUndefined()
    expect(f.events).toEqual([
      { operation: "apply", busy: false },
      { operation: "approve", busy: false },
    ])
  } finally {
    await f.close()
  }
})

test("superseded preflight fails before approval even when the newer poll says idle", async () => {
  const f = await fixture()
  try {
    f.status(0, false)
    await settled(() => f.events.length === 1)
    const approval = f.approve()
    await settled(() => f.reads.length === 2)
    await f.poll()
    await settled(() => f.reads.length === 3)
    f.status(2, false)
    f.status(1, false)
    const result = await approval
    expect(result.error).toBe("The assistant status changed while checking. Wait a moment, then try again.")
    expect(f.events.some((event) => event.operation === "approve")).toBe(false)
    const retry = f.approve()
    await settled(() => f.reads.length === 4)
    f.status(3, false)
    expect((await retry).error).toBeUndefined()
    expect(f.events.filter((event) => event.operation === "approve")).toEqual([{ operation: "approve", busy: false }])
  } finally {
    await f.close()
  }
})

test("an async older apply cannot overwrite the latest status cache", async () => {
  const f = await fixture(),
    gate = deferred<void>()
  try {
    let first = true
    f.apply(() => {
      if (first) {
        first = false
        return gate.promise
      }
    })
    f.status(0, false)
    await settled(() => f.events.length === 1)
    const approval = f.approve()
    await settled(() => f.reads.length === 2)
    f.status(1, true)
    expect((await approval).error).toContain("current assistant request")
    gate.resolve()
    await f.poll()
    await settled(() => f.reads.length === 3)
    f.status(2, false)
    await settled(() => f.events.filter((event) => event.operation === "apply").length === 3)
    expect(f.busy()).toBe(false)
  } finally {
    gate.resolve()
    await f.close()
  }
})

test("preflight superseded during apply cannot proceed using the newer poll state", async () => {
  const f = await fixture(),
    gate = deferred<void>()
  try {
    f.status(0, false)
    await settled(() => f.events.length === 1)
    f.apply((busy) => {
      if (!busy) return gate.promise
    })
    const approval = f.approve()
    await settled(() => f.reads.length === 2)
    f.status(1, false)
    await settled(() => f.events.length === 2)
    await f.poll()
    await settled(() => f.reads.length === 3)
    f.status(2, true)
    await settled(() => f.busy())
    gate.resolve()
    expect((await approval).error).toBe("The assistant status changed while checking. Wait a moment, then try again.")
    expect(f.events.some((event) => event.operation === "approve")).toBe(false)
  } finally {
    gate.resolve()
    await f.close()
  }
})

test("an unavailable fresh preflight cannot be replaced by an older idle response", async () => {
  const f = await fixture()
  try {
    const approval = f.approve()
    await settled(() => f.reads.length === 2)
    f.reads[1]!.resolve(undefined)
    expect((await approval).error).toContain("current assistant request")
    f.status(0, false)
    await f.poll()
    expect(f.busy()).toBe(true)
    expect(f.events.filter((event) => event.operation === "apply")).toEqual([{ operation: "apply", busy: true }])
  } finally {
    await f.close()
  }
})
