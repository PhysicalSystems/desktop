// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { build } from "vite"
import solid from "vite-plugin-solid"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, relative } from "node:path"
import { pathToFileURL } from "node:url"
import type { WorkcellRoomData, WorkcellRoomOptions } from "../src/physicalsystems/rooms/types"

const message = (id: string, sequence: number, content: string) => ({
  id,
  workcellId: "cell-a",
  sequence,
  role: "user" as const,
  authorId: "operator",
  authorName: "Operator",
  content,
  createdAt: "2026-10-20T00:00:00Z",
})
const room = (id = "cell-a", sequence = 103): WorkcellRoomData => ({
  id,
  name: id,
  task: "Pack components",
  objects: "parts",
  volume: "100/day",
  location: "Ghent",
  companyId: "company",
  companyName: "Example",
  status: "planning",
  setupStage: "task_received",
  createdAt: "2026-10-20T00:00:00Z",
  updatedAt: "2026-10-20T00:00:00Z",
  version: 1,
  lastEventSequence: sequence,
  setupStages: [],
  robot: { status: "not_connected", deviceId: null },
  telemetry: { status: "unavailable", observedAt: null, metrics: null, reason: "No production telemetry" },
  permissions: { canRead: true, canPost: true },
  messages: [message("latest", 103, "Latest room update")],
  messagesHasMore: true,
  resources: {
    scope: "company",
    services: [],
    models: [],
    links: {
      pilots: "/pilots",
      services: "/dashboard/services",
      credits: "/credits",
      computeBilling: "/billing",
      models: "/models",
    },
  },
})

test("the actual shared room preserves drafts, replays history and clears revoked or switched context", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "workcell-room-render-"))
  const container = document.createElement("div")
  document.body.append(container)
  const settle = async () => {
    for (let i = 0; i < 3; i++) await new Promise((done) => setTimeout(done, 0))
  }
  let dispose: (() => void) | undefined
  try {
    await build({
      configFile: false,
      root: resolve(import.meta.dir, ".."),
      logLevel: "error",
      plugins: [solid()],
      build: {
        target: "esnext",
        outDir: temporary,
        emptyOutDir: true,
        lib: {
          entry: resolve(import.meta.dir, "../src/physicalsystems/rooms/mount.tsx"),
          formats: ["es"],
          fileName: () => "fixture.mjs",
        },
      },
    })
    const { mountWorkcellRoom } = (await import(pathToFileURL(join(temporary, "fixture.mjs")).href)) as {
      mountWorkcellRoom(
        element: HTMLElement,
        options: WorkcellRoomOptions,
      ): { dispose(): void; update(options: Partial<WorkcellRoomOptions>): void }
    }
    let gets = 0
    let activeRoom = room()
    const writes: { body: unknown; resolve(value: unknown): void; reject(error: unknown): void }[] = []
    const briefs: string[] = []
    const transport: WorkcellRoomOptions["transport"] = {
      request: async (method, path, body) => {
        if (method === "POST") return new Promise((resolve, reject) => writes.push({ body, resolve, reject }))
        if (path.includes("/events?after=0"))
          return {
            events: [{ message: message("early", 2, "Earlier retained update") }],
            nextCursor: 100,
            hasMore: true,
            lastEventSequence: 103,
          }
        if (path.includes("/events?after=100"))
          return {
            events: [
              { message: message("middle", 101, "Middle retained update") },
              { message: message("latest", 103, "Latest room update") },
            ],
            nextCursor: 103,
            hasMore: false,
            lastEventSequence: 103,
          }
        if (path.includes("/events?"))
          return {
            events: [],
            nextCursor: activeRoom.lastEventSequence,
            hasMore: false,
            lastEventSequence: activeRoom.lastEventSequence,
          }
        gets++
        return { workcell: activeRoom }
      },
    }
    const instance = mountWorkcellRoom(container, {
      workcellId: "cell-a",
      transport,
      theme: "light",
      onPrepareTask: (value) => {
        briefs.push(value.id)
      },
    })
    dispose = instance.dispose
    await settle()
    expect(gets).toBe(1) // A reactive initialization loop used to restart on each loaded response.
    expect(container.querySelector("h1")?.textContent).toBe("cell-a")
    expect(container.querySelector("textarea")?.maxLength).toBe(8000)
    const click = async (label: string) => {
      const button = [...container.querySelectorAll("button")].find((item) => item.textContent === label)
      expect(button).toBeDefined()
      button!.click()
      await settle()
    }
    await click("Prepare in Assistant")
    expect(briefs).toEqual(["cell-a"])
    expect(writes).toHaveLength(0)
    await click("Load earlier updates")
    expect(container.textContent).toContain("Earlier retained update")
    await click("Load more history")
    expect(container.textContent).toContain("Middle retained update")
    expect(
      [...container.querySelectorAll(".pwr-message")].filter((item) =>
        item.textContent?.includes("Latest room update"),
      ),
    ).toHaveLength(1)
    const input = container.querySelector("textarea")!
    input.value = "Keep this draft"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    const submit = () =>
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    submit()
    submit()
    await settle()
    expect(writes).toHaveLength(1)
    writes[0].resolve({ workcell: room("wrong-room") })
    await settle()
    expect(input.value).toBe("Keep this draft")
    expect(container.textContent).toContain("The update was not confirmed")
    submit()
    await settle()
    expect(writes[1].body).toEqual(writes[0].body)
    activeRoom = {
      ...activeRoom,
      lastEventSequence: 104,
      messages: [...activeRoom.messages, message("posted", 104, "Keep this draft")],
    }
    writes[1].resolve({ workcell: activeRoom })
    await settle()
    expect(input.value).toBe("")
    expect(gets).toBe(2)
    input.value = "Old room pending"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    submit()
    await settle()
    activeRoom = room("cell-b")
    instance.update({ workcellId: "cell-b" })
    await settle()
    writes[2].resolve({ workcell: room("cell-a", 106) })
    await settle()
    expect(container.querySelector("h1")?.textContent).toBe("cell-b")
    expect(container.querySelector("textarea")?.value).toBe("")
    const next = container.querySelector("textarea")!
    next.value = "Revoked account draft"
    next.dispatchEvent(new Event("input", { bubbles: true }))
    submit()
    await settle()
    writes[3].reject({ status: 403 })
    await settle()
    expect(container.querySelector("textarea")).toBeNull()
    expect(container.textContent).not.toContain("Latest room update")
    expect(container.textContent).not.toContain("Example")
    expect(container.textContent).toContain("Access to this workcell has changed")
  } finally {
    dispose?.()
    container.remove()
    // This path is solely the random directory returned above, validated within the system temp root.
    const child = relative(resolve(tmpdir()), resolve(temporary))
    if (!child.startsWith("workcell-room-render-") || child.includes(".."))
      throw new Error("Unsafe test cleanup target")
    await rm(temporary, { recursive: true, force: true })
  }
}, 30000)
