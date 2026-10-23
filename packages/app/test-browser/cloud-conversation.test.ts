// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { build } from "vite"
import solid from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, relative } from "node:path"
import { pathToFileURL } from "node:url"
import type { CloudConversationOptions, CloudConversationSnapshot } from "../src/physicalsystems/cloud/types"

test("canonical OpenCode composer mounts once, keeps uncertain retries and clears switched or revoked accounts", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "physicalsystems-cloud-render-"))
  const container = document.createElement("div")
  document.body.append(container)
  let dispose: (() => void) | undefined
  const settle = async () => {
    for (let i = 0; i < 4; i++) await new Promise((done) => setTimeout(done, 0))
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
          entry: resolve(import.meta.dir, "../src/physicalsystems/cloud/mount.tsx"),
          formats: ["es"],
          fileName: () => "fixture.mjs",
        },
      },
    })
    const module = (await import(pathToFileURL(join(temporary, "fixture.mjs")).href)) as {
      mountCloudConversation(
        element: HTMLElement,
        options: CloudConversationOptions,
      ): { dispose(): void; update(options: Partial<CloudConversationOptions>): void }
    }
    let gets = 0
    let denied = false
    const snapshot: CloudConversationSnapshot = {
      conversation: {
        id: "chat-1",
        workcellId: "room-1",
        title: "Private workcell planning",
        visibility: "private",
        canWrite: true,
      },
      session: null,
      messages: [],
      status: { type: "idle" },
      permissions: [],
      runtime: { status: "ready" },
    }
    const writes: {
      body: { requestId: string; text: string }
      resolve(value: unknown): void
      reject(error: unknown): void
    }[] = []
    const transport: CloudConversationOptions["transport"] = {
      request: async (method, path, body) => {
        expect(path).toMatch(/^\/api\/workcells\/room-1\/conversations\/chat-1\/(runtime|prompts)$/)
        if (method === "POST")
          return new Promise((resolve, reject) =>
            writes.push({ body: body as { requestId: string; text: string }, resolve, reject }),
          )
        gets++
        if (denied) throw Object.assign(new Error("CONVERSATION_ACCESS_REVOKED"), { status: 403 })
        return structuredClone(snapshot)
      },
    }
    const mounted = module.mountCloudConversation(container, {
      accountKey: "cloud-test-a",
      workcellId: "room-1",
      conversationId: "chat-1",
      transport,
      theme: "light",
      workcell: {
        id: "room-1",
        name: "Local sorting fixture",
        task: "Sort the supplied metal plates",
        objects: "Small metal plates",
        location: "Local QA bench",
        volume: "",
        companyId: null,
        companyName: null,
        status: "task_received",
        setupStage: "review",
        createdAt: "2026-10-23",
        updatedAt: "2026-10-23",
        version: 1,
        lastEventSequence: 0,
        setupStages: [],
        robot: { status: "not_connected", deviceId: null },
        telemetry: { status: "unavailable", observedAt: null, metrics: null, reason: "No device" },
        permissions: { canRead: true, canPost: true },
        messages: [],
        messagesHasMore: false,
        resources: {
          scope: "personal",
          services: [],
          models: [],
          links: { pilots: "", services: "", credits: "", computeBilling: "", models: "" },
        },
      },
    })
    dispose = mounted.dispose
    await settle()
    expect(gets).toBe(1)
    expect(container.textContent).toContain("Private workcell planning")
    const editor = container.querySelector<HTMLElement>('[contenteditable="true"]')!
    expect(editor).not.toBeNull()
    const taskDetails = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Use task details",
    )!
    expect(taskDetails.disabled).toBe(false)
    expect(writes).toHaveLength(0)
    taskDetails.click()
    await settle()
    expect(writes).toHaveLength(0)
    expect(editor.textContent).toContain("Saved workcell details supplied by the user (not live observations):")
    expect(editor.textContent).toContain('"name": "Local sorting fixture"')
    expect(editor.textContent).toContain('"task": "Sort the supplied metal plates"')
    expect(editor.textContent).toContain('"objects": "Small metal plates"')
    expect(editor.textContent).toContain('"location": "Local QA bench"')
    expect(taskDetails.disabled).toBe(true)
    editor.textContent = "My edited question"
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, data: "My edited question" }))
    taskDetails.click()
    await settle()
    expect(editor.textContent).toBe("My edited question")
    expect(writes).toHaveLength(0)
    editor.textContent = "!"
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, data: "!" }))
    await settle()
    expect(editor.textContent).toBe("!")
    expect(container.textContent).not.toContain("Run a shell command")
    editor.textContent = "Plan component sorting"
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, data: "Plan component sorting" }))
    const submit = () =>
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    submit()
    submit()
    await settle()
    expect(writes).toHaveLength(1)
    writes[0].reject(new Error("Network interrupted"))
    await settle()
    expect(container.textContent).toContain("Your message has not been confirmed")
    expect(container.querySelector('[contenteditable="false"]')).not.toBeNull()
    expect(taskDetails.disabled).toBe(true)
    taskDetails.click()
    expect(writes).toHaveLength(1)
    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "Retry")!
    retry.click()
    await settle()
    expect(writes).toHaveLength(2)
    expect(writes[1].body).toEqual(writes[0].body)
    writes[1].resolve({ requestId: writes[1].body.requestId, admitted: true })
    await settle()
    expect(container.textContent).not.toContain("Plan component sorting")
    snapshot.session = {
      id: "session-1",
      projectID: "project-1",
      title: "Planning",
      location: { directory: "/managed/workcell" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 2 },
    }
    snapshot.messages = [
      { id: "msg-1", type: "user", text: "What should we measure?", time: { created: 1 } },
      {
        id: "msg-2",
        type: "assistant",
        agent: "planning",
        model: { id: "test-model", providerID: "fixture" },
        content: [{ type: "text", text: "Measure cycle time during validation." }],
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 2, completed: 3 },
      },
    ]
    window.dispatchEvent(new Event("focus"))
    await settle()
    expect(container.textContent).toContain("What should we measure?")
    expect(container.textContent).toContain("Measure cycle time during validation.")
    snapshot.runtime.status = "unavailable"
    window.dispatchEvent(new Event("focus"))
    await settle()
    expect(container.textContent).toContain("The cloud assistant is not available yet")
    expect(container.querySelector("form")).toBeNull()
    mounted.update({
      accountKey: "cloud-test-b",
      transport: {
        request: async () => ({ ...snapshot, conversation: { ...snapshot.conversation, title: "Second account" } }),
      },
    })
    await settle()
    expect(container.textContent).toContain("Second account")
    expect(container.textContent).not.toContain("Private workcell planning")
    mounted.update({ accountKey: "cloud-test-a", transport })
    denied = true
    window.dispatchEvent(new Event("focus"))
    await settle()
    expect(container.textContent).toContain("Access to this conversation has changed")
    expect(container.textContent).not.toContain("Private workcell planning")
    expect(container.querySelector("form")).toBeNull()
    expect(container.textContent).not.toContain("Sort the supplied metal plates")
  } finally {
    dispose?.()
    container.remove()
    const target = relative(resolve(tmpdir()), resolve(temporary))
    if (!target.startsWith("physicalsystems-cloud-render-") || target.includes(".."))
      throw new Error("Unsafe fixture cleanup")
    await rm(temporary, { recursive: true, force: true })
  }
}, 60000)
