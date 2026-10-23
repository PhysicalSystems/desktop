// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { build } from "vite"
import solid from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { WorkcellAccountBridge, WorkcellAccountState } from "../../physicalsystems/src/workcell-account-types"

// Owns native navigation/account lifecycle. The canonical renderer suite owns message delivery.
test("shared desktop navigation reads all pages, creates private/team chats, and clears switched accounts", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "physicalsystems-shared-native-"))
  const container = document.createElement("div")
  document.body.append(container)
  let dispose: (() => void) | undefined
  const settle = async () => {
    for (let i = 0; i < 6; i++) await new Promise((done) => setTimeout(done, 0))
  }
  try {
    await build({
      configFile: false,
      root: resolve(import.meta.dir, ".."),
      logLevel: "error",
      publicDir: false,
      plugins: [tailwindcss(), solid()],
      worker: { format: "es" },
      resolve: { alias: { "@": resolve(import.meta.dir, "../src") } },
      build: {
        target: "esnext",
        outDir: temporary,
        emptyOutDir: true,
        lib: {
          entry: resolve(import.meta.dir, "fixtures/shared-workcells/entry.tsx"),
          formats: ["es"],
          fileName: () => "fixture.mjs",
        },
      },
    })
    const { mount } = await import(pathToFileURL(join(temporary, "fixture.mjs")).href)
    let state: WorkcellAccountState = {
      revision: 0,
      sessionId: null,
      status: "signed_out",
      account: null,
      pending: null,
      error: null,
    }
    let listener: (value: WorkcellAccountState) => void = () => {}
    let release: ((value: unknown) => void) | undefined
    const paths: string[] = []
    const writes: { path: string; body: unknown }[] = []
    const room = { id: "room-a", name: "Assembly workcell", robot: { status: "offline" } }
    const conversations = [
      {
        id: "room-a",
        workcellId: "room-a",
        title: "Operations",
        visibility: "team",
        isDefault: true,
        permissions: { canRead: true, canPost: true },
      },
      {
        id: "private-a",
        workcellId: "room-a",
        title: "Private planning",
        visibility: "private",
        isDefault: false,
        permissions: { canRead: true, canPost: true },
      },
    ]
    const signedIn = (id: string) => {
      state = {
        revision: state.revision + 1,
        sessionId: `grant-${id}`,
        status: "signed_in",
        account: { id, name: `Operator ${id}`, email: `${id}@example.invalid` },
        pending: null,
        error: null,
      }
      listener(state)
      return state
    }
    const bridge: WorkcellAccountBridge = {
      snapshot: async () => state,
      refresh: async () => state,
      signIn: async () => signedIn("a"),
      cancelSignIn: async () => state,
      signOut: async () => {
        state = {
          revision: state.revision + 1,
          sessionId: null,
          status: "signed_out",
          account: null,
          pending: null,
          error: null,
        }
        listener(state)
        return state
      },
      subscribe: (next) => {
        listener = next
        return () => {
          listener = () => {}
        }
      },
      request: async (method, path, body) => {
        paths.push(path)
        expect(path).not.toMatch(/\/(runtime|prompts)$/)
        if (method === "POST") {
          writes.push({ path, body })
          if (path === "/api/workcells") return { workcell: room }
          const created = {
            ...conversations[1],
            ...(body as object),
            id: `created-${writes.length}`,
            workcellId: "room-a",
          }
          conversations.push(created)
          return { conversation: created }
        }
        if (path === "/api/workcells") {
          if (state.account?.id === "b") return { workcells: [] }
          return { workcells: [room] }
        }
        if (path === "/api/workcells/room-a") return { workcell: room }
        if (path === "/api/workcells/room-a/conversations?limit=100")
          return {
            conversations: [conversations[0]],
            hasMore: true,
            nextCursor: "page2",
            permissions: { canCreate: true, canCreateTeam: true },
          }
        if (path.includes("?cursor=page2&limit=100"))
          return {
            conversations: conversations.slice(1),
            hasMore: false,
            nextCursor: null,
            permissions: { canCreate: true, canCreateTeam: true },
          }
        if (path.endsWith("/private-a"))
          return new Promise((resolve) => {
            release = resolve
          })
        if (path.includes("/events?")) return { events: [], hasMore: false, nextCursor: 0, lastEventSequence: 0 }
        const conversation = conversations.find((item) => path.endsWith(`/${item.id}`))
        return {
          conversation: {
            ...conversation,
            lastEventSequence: 0,
            messagesHasMore: false,
            messagesBefore: null,
            messages: [],
          },
        }
      },
    }
    const instance = mount(container, bridge)
    dispose = instance.dispose
    await settle()
    expect(container.textContent).toContain("Your workcells, together")
    const choose = async (text: string) => {
      const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (item) => item.textContent?.trim() === text,
      )
      expect(button).toBeDefined()
      button!.click()
      await settle()
    }
    await choose("Sign in")
    expect(container.textContent).toContain("Assembly workcell")
    expect(container.textContent).toContain("Private planning")
    expect(paths).toContain("/api/workcells/room-a/conversations?cursor=page2&limit=100")
    expect(container.querySelector('[title="Robot offline"]')).not.toBeNull()
    for (const visibility of ["private", "team"]) {
      await choose("New conversation")
      const title = container.querySelector<HTMLInputElement>("form input")!
      title.value = `A ${visibility} conversation`
      title.dispatchEvent(new Event("input", { bubbles: true }))
      const select = container.querySelector<HTMLSelectElement>("form select")!
      select.value = visibility
      select.dispatchEvent(new Event("change", { bubbles: true }))
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
      await settle()
      expect(writes.at(-1)).toMatchObject({
        path: "/api/workcells/room-a/conversations",
        body: { title: `A ${visibility} conversation`, visibility },
      })
    }
    await choose("New workcell")
    const name = container.querySelector<HTMLInputElement>("form input")!
    name.value = "Assembly workcell"
    name.dispatchEvent(new Event("input", { bubbles: true }))
    const task = container.querySelector<HTMLTextAreaElement>("form textarea")!
    task.value = "Sort plates"
    task.dispatchEvent(new Event("input", { bubbles: true }))
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    await settle()
    expect(writes.at(-1)).toMatchObject({
      path: "/api/workcells",
      body: { name: "Assembly workcell", task: "Sort plates", objects: "", volume: "", location: "" },
    })
    expect(container.querySelector(".ps-native-conversation-create")).toBeNull()
    await choose("Local workspace")
    expect(instance.control.local).toBe(true)
    await choose("Cloud AI conversations")
    expect(instance.control.ai).toBe(true)
    await choose("Private planning")
    expect(release).toBeDefined()
    signedIn("b")
    await settle()
    release!({
      conversation: {
        ...conversations[1],
        lastEventSequence: 0,
        messagesHasMore: false,
        messagesBefore: null,
        messages: [],
      },
    })
    await settle()
    expect(container.textContent).not.toContain("Private planning")
    expect(container.textContent).not.toContain("Assembly workcell")
    expect(container.textContent).toContain("Operator b")
    expect(container.textContent).not.toContain("Operator a")
    expect(paths.some((path) => /\/(runtime|prompts)$/.test(path))).toBe(false)
  } finally {
    dispose?.()
    container.remove()
    await rm(temporary, { recursive: true, force: true })
  }
}, 90000)
