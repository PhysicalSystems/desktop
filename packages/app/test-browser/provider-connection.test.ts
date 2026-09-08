import { expect, test } from "bun:test"
import { build } from "vite"
import solid from "vite-plugin-solid"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

test("actual provider form contains vault errors, duplicate submits and late method responses", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "provider-connection-render-"))
  const container = document.createElement("div")
  document.body.append(container)
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  let dispose: (() => void) | undefined
  try {
    const environment = resolve(import.meta.dir, "fixtures/provider-connection/environment.ts")
    await build({
      configFile: false,
      root: resolve(import.meta.dir, ".."),
      logLevel: "error",
      plugins: [solid()],
      resolve: {
        alias: [
          ...[
            "context/server-sdk",
            "context/server-sync",
            "context/settings",
            "hooks/use-providers",
            "utils/toast",
          ].map((name) => ({ find: `@/${name}`, replacement: environment })),
          { find: "@", replacement: resolve(import.meta.dir, "../src") },
        ],
      },
      build: {
        target: "esnext",
        outDir: temporary,
        emptyOutDir: true,
        lib: {
          entry: resolve(import.meta.dir, "fixtures/provider-connection/entry.tsx"),
          formats: ["es"],
          fileName: () => "fixture.mjs",
        },
      },
    })
    const { mount } = await import(pathToFileURL(join(temporary, "fixture.mjs")).href)
    for (const layout of [true, false]) {
      const requests: { resolve: (value?: unknown) => void; reject: (error: Error) => void }[] = []
      const connections: { resolve: (value: unknown) => void }[] = []
      const completions: { resolve: () => void; reject: (error: Error) => void }[] = []
      const cancelled: string[] = []
      const opened: string[] = []
      let writes = 0
      const instance = mount(
        container,
        {
          integration: {
            get: async () => ({
              data: {
                methods: [
                  { type: "key", id: "key", label: "API key" },
                  { type: "oauth", id: "oauth", label: "Browser sign-in" },
                ],
              },
            }),
            connect: {
              key: () => {
                writes++
                return new Promise((resolve, reject) => requests.push({ resolve, reject }))
              },
            },
            oauth: {
              connect: () => new Promise((resolve) => connections.push({ resolve })),
              complete: () => new Promise<void>((resolve, reject) => completions.push({ resolve, reject })),
              cancel: async (value: { attemptID: string }) => {
                cancelled.push(value.attemptID)
              },
            },
          },
        },
        async (url: string) => {
          opened.push(url)
          return true
        },
        layout,
      )
      dispose = instance.dispose
      await settle()
      const choose = async (label: string) => {
        const item = [...container.querySelectorAll<HTMLElement>("button,[role=option]")].find((el) =>
          el.textContent?.includes(label),
        )
        expect(item).toBeDefined()
        item!.click()
        await settle()
      }
      await choose("API key")
      const fill = () => {
        const input = container.querySelector<HTMLInputElement>('input[name="apiKey"]')!
        expect(input.type).toBe("password")
        input.value = "inert-test-key"
        input.dispatchEvent(new Event("input", { bubbles: true }))
      }
      const submit = () =>
        container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
      fill()
      submit()
      submit()
      await settle()
      expect(writes).toBe(1)
      requests.shift()!.reject(new Error("native vault refused private-key-details"))
      await settle()
      expect(container.textContent).toContain("Key storage could not be confirmed")
      expect(container.textContent).not.toContain("private-key-details")
      expect(instance.fixture.toasts).toHaveLength(0)
      submit()
      await settle()
      expect(writes).toBe(2)
      instance.control.back()
      await settle()
      await choose("Browser sign-in")
      requests.shift()!.resolve()
      await settle()
      expect(instance.fixture.toasts).toHaveLength(0)
      // Return to method selection before the pending OAuth response arrives.
      instance.control.back()
      connections.shift()!.resolve({
        data: { attemptID: "late", mode: "code", url: "https://example.com/late", instructions: "", time: {} },
      })
      await settle()
      expect(cancelled).toEqual(["late"])
      expect(opened).toHaveLength(0)
      await choose("Browser sign-in")
      connections.shift()!.resolve({
        data: { attemptID: "current", mode: "code", url: "https://example.com/current", instructions: "", time: {} },
      })
      await settle()
      expect(opened).toEqual(["https://example.com/current"])
      expect(container.querySelector("a")?.href).toBe("https://example.com/current")
      const code = container.querySelector<HTMLInputElement>('input[name="code"]')!
      code.value = "inert-code"
      code.dispatchEvent(new Event("input", { bubbles: true }))
      submit()
      submit()
      await settle()
      expect(completions).toHaveLength(1)
      completions.shift()!.reject(new Error("Authorization could not be saved"))
      await settle()
      expect(instance.fixture.toasts).toHaveLength(0)
      expect(container.textContent).toContain("Sign-in completion could not be confirmed")
      submit()
      await settle()
      expect(completions).toHaveLength(0)
      await choose("Start sign-in again")
      connections
        .shift()!
        .resolve({
          data: { attemptID: "retry", mode: "code", url: "https://example.com/retry", instructions: "", time: {} },
        })
      await settle()
      expect(cancelled).toEqual(["late", "current"])
      expect(opened).toEqual(["https://example.com/current", "https://example.com/retry"])
      const retryCode = container.querySelector<HTMLInputElement>('input[name="code"]')!
      retryCode.value = "fresh-inert-code"
      retryCode.dispatchEvent(new Event("input", { bubbles: true }))
      submit()
      await settle()
      expect(completions).toHaveLength(1)
      completions.shift()!.resolve()
      await settle()
      expect(instance.fixture.toasts).toHaveLength(1)
      instance.dispose()
      await settle()
      expect(cancelled).toEqual(["late", "current"])
    }
  } finally {
    dispose?.()
    container.remove()
    await rm(temporary, { recursive: true, force: true })
  }
}, 30000)
