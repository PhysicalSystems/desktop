import { expect, test } from "bun:test"
import { build } from "vite"
import solid from "vite-plugin-solid"
import { createServer, request } from "node:http"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout } from "node:timers/promises"

// Production Solid component and actual local JPEG decoding with inert typed IPC.
// No LeLab API, camera, robot, Node service or model is opened.
const enabled = process.env.PHYSICALSYSTEMS_UI_BROWSER_TESTS === "1"
test.skipIf(!enabled)(
  "LeLab cameras preserve selection and discard stale or cancelled previews",
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), "ps-lelab-ui-"))
    const fixture = resolve(import.meta.dir, "fixtures/lelab-cameras")
    const mocks = join(fixture, "mocks.ts")
    const feature = resolve(import.meta.dir, "../src/physicalsystems")
    const contexts = ["../context/language", "../utils/persist"]
    await build({
      configFile: false,
      root: fixture,
      logLevel: "error",
      plugins: [
        {
          name: "lelab-camera-fixture-contexts",
          enforce: "pre",
          resolveId(id, importer) {
            if (importer?.startsWith(feature) && contexts.includes(id)) return mocks
          },
        },
        solid(),
      ],
      build: { outDir: temporary, emptyOutDir: true, sourcemap: true },
    })
    const server = createServer(async (request, response) => {
      const path = request.url === "/" ? "/index.html" : (request.url ?? "")
      if (!/^\/(?:index\.html|assets\/[\w.-]+)$/.test(path)) {
        response.writeHead(404).end()
        return
      }
      const bytes = await readFile(join(temporary, path)).catch(() => undefined)
      if (!bytes) {
        response.writeHead(404).end()
        return
      }
      response.setHeader(
        "Content-Type",
        path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "text/html",
      )
      response.end(bytes)
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Fixture port unavailable")
    const reserve = createServer()
    await new Promise<void>((resolve) => reserve.listen(0, "127.0.0.1", resolve))
    const driverAddress = reserve.address()
    if (!driverAddress || typeof driverAddress === "string") throw new Error("WebDriver port unavailable")
    await new Promise<void>((resolve) => reserve.close(() => resolve()))
    const origin = `http://127.0.0.1:${driverAddress.port}`
    const driver = spawn(
      process.env.PHYSICALSYSTEMS_GECKODRIVER ?? "/snap/bin/geckodriver",
      ["--host", "127.0.0.1", "--port", String(driverAddress.port)],
      { stdio: "ignore", detached: true },
    )
    const session = { id: "" }
    const wd = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
      const result = await new Promise<{ value: { error?: string; message?: string; sessionId?: string } }>(
        (resolve, reject) => {
          const connection = request(
            origin + path,
            { method, headers: { "Content-Type": "application/json" } },
            (response) => {
              const chunks: Buffer[] = []
              response.on("data", (chunk: Buffer) => chunks.push(chunk))
              response.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString())))
            },
          )
          connection.on("error", reject)
          connection.setTimeout(12000, () => connection.destroy(new Error("WebDriver request timed out")))
          connection.end(body === undefined ? undefined : JSON.stringify(body))
        },
      )
      if (result.value?.error) throw new Error(JSON.stringify(result.value))
      return result.value
    }
    const js = async <T>(script: string, args: unknown[] = []) =>
      wd(`/session/${session.id}/execute/sync`, { script, args }) as Promise<T>
    const until = async (condition: () => Promise<boolean>) => {
      for (const attempt of Array.from({ length: 120 }, (_, index) => index)) {
        if (await condition()) return
        await setTimeout(50)
        if (attempt === 119) throw new Error("Browser condition timed out")
      }
    }
    try {
      await until(() =>
        wd("/status").then(
          () => true,
          () => false,
        ),
      )
      const created = await wd("/session", {
        capabilities: { alwaysMatch: { browserName: "firefox", "moz:firefoxOptions": { args: ["-headless"] } } },
      })
      session.id = created.sessionId!
      await wd(`/session/${session.id}/window/rect`, { width: 1280, height: 900 })
      await wd(`/session/${session.id}/url`, { url: `http://127.0.0.1:${address.port}/` })
      await until(() => js("return !!document.querySelector('[data-ps-lelab-toggle]')"))

      expect(await js("return document.querySelector('[data-ps-lelab-toggle]').getAttribute('aria-checked')")).toBe(
        "false",
      )
      expect(await js("return window.__lelabFixture.calls")).toEqual([])
      expect(await js("return document.querySelectorAll('img').length")).toBe(0)
      await js("document.querySelector('[data-ps-lelab-toggle]').click()")
      await until(() =>
        js(
          "return document.querySelectorAll('[data-ps-lelab-camera] img').length===2 && Array.from(document.querySelectorAll('img')).every(image=>image.naturalWidth===8 && image.naturalHeight===6)",
        ),
      )
      expect(
        await js("return Array.from(document.querySelectorAll('figcaption strong')).map(node=>node.textContent)"),
      ).toEqual(["overview", "wrist"])
      expect(await js("return document.querySelector('select').value")).toBe("White follower")
      expect(
        await js(
          "return Array.from(document.querySelectorAll('figcaption')).every(node=>node.getBoundingClientRect().bottom<=document.querySelector('[data-ps-lelab-cameras]').getBoundingClientRect().bottom)",
        ),
      ).toBe(true)
      expect(
        await js(
          "return Array.from(document.querySelectorAll('img')).map(image=>{const c=document.createElement('canvas');c.width=8;c.height=6;const ctx=c.getContext('2d');ctx.drawImage(image,0,0);const p=ctx.getImageData(0,0,1,1).data;return p[0]>p[2]?'red':'blue'})",
        ),
      ).toEqual(["red", "blue"])
      if (process.env.PHYSICALSYSTEMS_UI_BROWSER_EVIDENCE) {
        const screenshot = (await wd(`/session/${session.id}/screenshot`)) as unknown as string
        await Bun.write(
          join(process.env.PHYSICALSYSTEMS_UI_BROWSER_EVIDENCE, "lelab-synthetic-previews.png"),
          Buffer.from(screenshot, "base64"),
        )
      }

      // A response admitted for the previous On generation cannot reappear after Off.
      await js("window.__lelabFixture.hold=true")
      await until(() => js("return window.__lelabFixture.pending.length===2"))
      const firstClient = await js<string>("return window.__lelabFixture.pending[0].request.clientId")
      await js("document.querySelector('[data-ps-lelab-toggle]').click();window.__lelabFixture.release()")
      await setTimeout(150)
      expect(await js("return document.querySelectorAll('img').length")).toBe(0)
      expect(await js("return window.__lelabFixture.objectURLs.size")).toBe(0)
      expect(
        await js(
          "return window.__lelabFixture.calls.filter(call=>call.type==='stop').map(call=>call.request.clientId)",
        ),
      ).toEqual([firstClient])
      const offCalls = await js<number>("return window.__lelabFixture.calls.length")
      await setTimeout(200)
      expect(await js("return window.__lelabFixture.calls.length")).toBe(offCalls)

      // Receiving new bytes cannot extend displayed pixels while their decoding is blocked.
      await js("window.__lelabFixture.hold=false;document.querySelector('[data-ps-lelab-toggle]').click()")
      await until(() => js("return document.querySelectorAll('img').length===2"))
      await js("window.__lelabFixture.holdDecode=true")
      await until(() => js("return window.__lelabFixture.decodes.length>=2"))
      const decodingCalls = await js<number>(
        "return window.__lelabFixture.calls.filter(call=>call.type==='frame').length",
      )
      await until(() => js("return document.querySelectorAll('img').length===0"))
      expect(
        await js(
          "return Array.from(document.querySelectorAll('[data-ps-lelab-camera] [role=status]')).every(node=>node.textContent.includes('No current camera frame'))",
        ),
      ).toBe(true)
      expect(
        await js<number>("return window.__lelabFixture.calls.filter(call=>call.type==='frame').length"),
      ).toBeGreaterThan(decodingCalls + 2)
      await js("window.__lelabFixture.scope('project-b/session-b');window.__releaseLeLabDecodes()")
      await setTimeout(150)
      expect(await js("return document.querySelector('[data-ps-lelab-toggle]').getAttribute('aria-checked')")).toBe(
        "false",
      )
      expect(await js("return document.querySelectorAll('img').length")).toBe(0)
      expect(await js("return window.__lelabFixture.objectURLs.size")).toBe(0)

      // Multiple configured robots require an explicit choice before any frame request.
      await wd(`/session/${session.id}/url`, { url: `http://127.0.0.1:${address.port}/` })
      await until(() => js("return !!window.__lelabFixture"))
      await js("window.__lelabFixture.multiple=true;document.querySelector('[data-ps-lelab-toggle]').click()")
      await until(() => js("return document.querySelectorAll('select option').length===3"))
      expect(await js("return document.querySelector('details').open")).toBe(true)
      expect(await js("return window.__lelabFixture.calls.filter(call=>call.type==='frame').length")).toBe(0)
      await js(
        "const select=document.querySelector('select');select.value='Other follower';select.dispatchEvent(new Event('change',{bubbles:true}))",
      )
      await until(() => js("return document.querySelectorAll('img').length===2"))
      expect(
        await js(
          "return Array.from(document.querySelectorAll('[data-ps-lelab-camera]')).map(node=>node.dataset.psLelabCamera)",
        ),
      ).toEqual(["other-overview", "other-wrist"])
      expect(
        await js(
          "return window.__lelabFixture.calls.filter(call=>call.type==='frame').every(call=>call.request.robotName==='Other follower')",
        ),
      ).toBe(true)

      // A robot change clears old previews immediately and rejects held old replies.
      await js("window.__lelabFixture.hold=true")
      await until(() => js("return window.__lelabFixture.pending.length===2"))
      const otherClient = await js<string>("return window.__lelabFixture.pending[0].request.clientId")
      await js(
        "const select=document.querySelector('select');select.value='White follower';select.dispatchEvent(new Event('change',{bubbles:true}))",
      )
      await until(() => js("return window.__lelabFixture.pending.length===4"))
      expect(await js("return document.querySelectorAll('img').length")).toBe(0)
      await js("window.__lelabFixture.release(arguments[0])", [otherClient])
      await setTimeout(150)
      expect(await js("return document.querySelectorAll('img').length")).toBe(0)
      await js("window.__lelabFixture.hold=false;window.__lelabFixture.release()")
      await until(() => js("return document.querySelectorAll('img').length===2"))
      expect(
        await js(
          "return Array.from(document.querySelectorAll('[data-ps-lelab-camera]')).map(node=>node.dataset.psLelabCamera)",
        ),
      ).toEqual(["white-overview", "white-wrist"])
      const stopCount = await js<number>("return window.__lelabFixture.calls.filter(call=>call.type==='stop').length")
      await js("window.__lelabFixture.scope('project-c/session-c')")
      await until(() => js("return document.querySelectorAll('img').length===0"))
      expect(await js("return window.__lelabFixture.objectURLs.size")).toBe(0)
      expect(await js("return window.__lelabFixture.calls.filter(call=>call.type==='stop').length")).toBe(stopCount + 1)

      // Unavailable discovery and missing-camera replies never leave old images visible.
      await js("window.__lelabFixture.unavailable=true;document.querySelector('[data-ps-lelab-toggle]').click()")
      await until(() => js("return document.body.textContent.includes('Cannot reach LeLab')"))
      expect(await js("return document.querySelectorAll('img').length")).toBe(0)
      expect(await js("return document.querySelector('details').open")).toBe(true)
      const discoveries = await js<number>(
        "return window.__lelabFixture.calls.filter(call=>call.type==='discover').length",
      )
      await js(
        "const input=document.querySelector('input[type=url]');input.value='http://127.0.0.1:9000';input.dispatchEvent(new InputEvent('input',{bubbles:true}))",
      )
      await setTimeout(50)
      expect(await js("return document.querySelector('details').open")).toBe(true)
      expect(await js("return document.querySelector('input[type=url]').value")).toBe("http://127.0.0.1:9000")
      expect(await js("return window.__lelabFixture.calls.filter(call=>call.type==='discover').length")).toBe(
        discoveries,
      )
      await js(
        "document.querySelector('[data-ps-lelab-toggle]').click();window.__lelabFixture.unavailable=false;window.__lelabFixture.multiple=false;window.__lelabFixture.missing=true;document.querySelector('[data-ps-lelab-toggle]').click()",
      )
      await until(() =>
        js(
          "return document.querySelectorAll('[data-ps-lelab-camera]').length===2 && Array.from(document.querySelectorAll('[data-ps-lelab-camera] [role=status]')).every(node=>node.textContent.includes('disconnected'))",
        ),
      )
      expect(await js("return document.querySelectorAll('img').length")).toBe(0)
      // A JPEG that arrives after its receivedAt deadline is not shown as fresh.
      await js(
        "document.querySelector('[data-ps-lelab-toggle]').click();window.__lelabFixture.missing=false;window.__lelabFixture.timestampOffset=-6000;document.querySelector('[data-ps-lelab-toggle]').click()",
      )
      await until(() =>
        js(
          "return document.querySelectorAll('[data-ps-lelab-camera]').length===2 && Array.from(document.querySelectorAll('[data-ps-lelab-camera] [role=status]')).every(node=>node.textContent.includes('No current camera frame'))",
        ),
      )
      await setTimeout(200)
      expect(await js("return document.querySelectorAll('img').length")).toBe(0)
      expect(await js("return window.__lelabFixture.objectURLs.size")).toBe(0)
      await js(
        "document.querySelector('[data-ps-lelab-toggle]').click();window.__lelabFixture.timestampOffset=0;document.querySelector('[data-ps-lelab-toggle]').click()",
      )
      await until(() => js("return document.querySelectorAll('img').length===2"))
      await js("window.__lelabFixture.dispose()")
      expect(await js("return window.__lelabFixture.objectURLs.size")).toBe(0)
      const disposedCalls = await js<number>("return window.__lelabFixture.calls.length")
      await setTimeout(200)
      expect(await js("return window.__lelabFixture.calls.length")).toBe(disposedCalls)
    } finally {
      if (session.id) await wd(`/session/${session.id}`, undefined, "DELETE").catch(() => undefined)
      if (driver.pid) process.kill(-driver.pid, "SIGTERM")
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(temporary, { recursive: true, force: true })
    }
  },
  90000,
)
