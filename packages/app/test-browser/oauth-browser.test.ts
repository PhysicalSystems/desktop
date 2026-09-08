import { expect, test } from "bun:test"
import { build } from "vite"
import solid from "vite-plugin-solid"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

test("rendered sign-in opens once, preserves a retry link on failure and ignores an old launch result", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "oauth-browser-render-"))
  const container = document.createElement("div")
  document.body.append(container)
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  let dispose: (() => void) | undefined
  try {
    await build({
      configFile: false,
      root: resolve(import.meta.dir, ".."),
      logLevel: "error",
      plugins: [solid()],
      resolve: { alias: { "@": resolve(import.meta.dir, "../src") } },
      build: {
        target: "esnext",
        outDir: temporary,
        emptyOutDir: true,
        lib: {
          entry: resolve(import.meta.dir, "fixtures/oauth-browser/entry.tsx"),
          formats: ["es"],
          fileName: () => "fixture.mjs",
        },
      },
    })
    const { mount } = await import(pathToFileURL(join(temporary, "fixture.mjs")).href)
    const calls: string[] = []
    const pending: ((value: boolean) => void)[] = []
    const fixture = mount(container, (url: string) => {
      calls.push(url)
      return new Promise<boolean>((resolve) => pending.push(resolve))
    })
    dispose = fixture.dispose
    await settle()
    expect(calls).toEqual(["https://example.com/authorize?state=first"])
    expect(container.querySelector("a")?.getAttribute("aria-busy")).toBe("true")
    container.querySelector("a")!.click()
    await settle()
    expect(calls).toHaveLength(1)
    pending.shift()!(false)
    await settle()
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Click the sign-in link to retry")
    container.querySelector("a")!.click()
    await settle()
    expect(calls).toHaveLength(2)
    fixture.update("https://example.com/authorize?state=second")
    await settle()
    expect(calls).toHaveLength(3)
    pending.shift()!(false)
    await settle()
    expect(container.querySelector('[role="status"]')).toBeNull()
    expect(container.querySelector("a")?.getAttribute("aria-busy")).toBe("true")
    pending.shift()!(true)
    await settle()
    expect(container.querySelector("a")?.getAttribute("aria-busy")).toBe("false")
    expect(container.textContent).not.toContain("connected")
    fixture.update("javascript:alert(1)")
    await settle()
    expect(calls).toHaveLength(3)
    expect(container.querySelector("a")).toBeNull()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("invalid sign-in link")
    fixture.dispose()
    const web = mount(
      container,
      async (url: string) => {
        calls.push(url)
        return true
      },
      "web",
    )
    dispose = web.dispose
    await settle()
    expect(calls).toHaveLength(3)
    expect(container.querySelector("a")?.getAttribute("target")).toBe("_blank")
  } finally {
    dispose?.()
    container.remove()
    await rm(temporary, { recursive: true, force: true })
  }
}, 30000)
