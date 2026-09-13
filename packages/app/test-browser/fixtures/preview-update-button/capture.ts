import { spawn } from "node:child_process"
import { createServer, request } from "node:http"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { setTimeout } from "node:timers/promises"
import { build } from "vite"
import solid from "vite-plugin-solid"

const destination = process.argv[2]
if (!destination || !destination.startsWith("/")) throw new Error("An absolute screenshot destination is required")
const temporary = await mkdtemp(join(tmpdir(), "preview-update-visual-"))
const fixture = import.meta.dir
const session = { id: "" }
let origin = ""
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
    path.endsWith(".js")
      ? "text/javascript"
      : path.endsWith(".css")
        ? "text/css"
        : path.endsWith(".svg")
          ? "image/svg+xml"
          : path.endsWith(".html")
            ? "text/html"
            : "application/octet-stream",
  )
  response.end(bytes)
})
let driver: ReturnType<typeof spawn> | undefined
async function wd(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  const result = await new Promise<{ value: Record<string, unknown> | string }>((resolve, reject) => {
    const connection = request(
      origin + path,
      { method, headers: { "Content-Type": "application/json" } },
      (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk: Buffer) => chunks.push(chunk))
        response.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()))
          } catch (error) {
            reject(error)
          }
        })
      },
    )
    connection.on("error", reject)
    connection.setTimeout(15000, () => connection.destroy(new Error("Fixture WebDriver timed out")))
    connection.end(body === undefined ? undefined : JSON.stringify(body))
  })
  if (result.value && typeof result.value === "object" && result.value.error)
    throw new Error(String(result.value.message))
  return result.value
}
try {
  await build({
    configFile: false,
    root: fixture,
    logLevel: "error",
    plugins: [solid()],
    resolve: {
      alias: [
        { find: "@/utils/toast", replacement: join(fixture, "environment.ts") },
        { find: "@", replacement: resolve(fixture, "../../../src") },
      ],
    },
    build: { target: "esnext", outDir: temporary, emptyOutDir: true },
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Fixture server has no port")
  const reserve = createServer()
  await new Promise<void>((resolve) => reserve.listen(0, "127.0.0.1", resolve))
  const driverAddress = reserve.address()
  if (!driverAddress || typeof driverAddress === "string") throw new Error("Fixture driver has no port")
  await new Promise<void>((resolve) => reserve.close(() => resolve()))
  origin = `http://127.0.0.1:${driverAddress.port}`
  driver = spawn("/snap/bin/geckodriver", ["--host", "127.0.0.1", "--port", String(driverAddress.port)], {
    stdio: "ignore",
    detached: true,
  })
  for (let index = 0; index < 60; index++) {
    if (
      await wd("/status").then(
        () => true,
        () => false,
      )
    )
      break
    if (index === 59) throw new Error("Fixture driver did not start")
    await setTimeout(200)
  }
  const created = (await wd("/session", {
    capabilities: { alwaysMatch: { browserName: "firefox", "moz:firefoxOptions": { args: ["-headless"] } } },
  })) as { sessionId: string }
  session.id = created.sessionId
  await wd(`/session/${session.id}/window/rect`, { width: 820, height: 720 })
  await wd(`/session/${session.id}/url`, { url: `http://127.0.0.1:${address.port}/` })
  for (let index = 0; index < 60; index++) {
    if (
      await wd(`/session/${session.id}/execute/sync`, {
        script: "return document.body.dataset.fixtureReady === 'true'",
        args: [],
      })
    )
      break
    if (index === 59) throw new Error("Fixture did not render")
    await setTimeout(100)
  }
  const element = (await wd(`/session/${session.id}/element`, { using: "css selector", value: "main" })) as Record<
    string,
    string
  >
  const screenshot = await wd(
    `/session/${session.id}/element/${element["element-6066-11e4-a52e-4f735466cecf"]}/screenshot`,
  )
  if (typeof screenshot !== "string") throw new Error("Fixture screenshot was not returned")
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, Buffer.from(screenshot, "base64"))
  console.log(destination)
} finally {
  if (session.id) await wd(`/session/${session.id}`, undefined, "DELETE").catch(() => {})
  if (driver?.pid) {
    try {
      process.kill(-driver.pid, "SIGTERM")
    } catch {
      /* The owned fixture process already exited. */
    }
  }
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(temporary, { recursive: true, force: true })
}
