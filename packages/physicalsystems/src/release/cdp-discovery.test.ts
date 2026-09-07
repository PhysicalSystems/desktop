// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test"
import { createServer, type RequestListener, type Server } from "node:http"
import { probePackagedRenderer } from "./cdp-discovery"

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }),
  )
})

async function serve(handler: RequestListener, port = 0) {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("HTTP_FIXTURE_UNAVAILABLE")
  return { server, port: address.port }
}

function target(port: number) {
  return {
    id: "A0123456789ABCDEF0123456789ABCDEF0",
    type: "page",
    url: "oc://renderer/index.html",
    webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/A0123456789ABCDEF0123456789ABCDEF0`,
  }
}

test("empty, truncated and unavailable CDP responses retry through independent GET probes", async () => {
  const replies = ["", '[{"type":"page"', "unavailable"]
  const requests: string[] = []
  const fixture = await serve((request, response) => {
    requests.push(`${request.method} ${request.url}`)
    response.statusCode = requests.length === 3 ? 503 : 200
    response.end(replies[requests.length - 1] ?? JSON.stringify([target(fixture.port)]))
  })
  // Reproduce the former unconditional response.json() failure against real HTTP.
  // Bun can turn an empty body into null, but rejects the truncated JSON observed
  // during startup. Neither response has a usable renderer target.
  expect(await (await fetch(`http://127.0.0.1:${fixture.port}/json/list`)).text()).toBe("")
  await expect((await fetch(`http://127.0.0.1:${fixture.port}/json/list`)).json()).rejects.toBeInstanceOf(SyntaxError)
  requests.length = 0
  for (let attempt = 0; attempt < replies.length; attempt++) {
    expect(await probePackagedRenderer(fixture.port)).toBeUndefined()
    expect(requests.length).toBe(attempt + 1)
  }
  expect(await probePackagedRenderer(fixture.port)).toEqual({
    id: target(fixture.port).id,
    webSocketDebuggerUrl: target(fixture.port).webSocketDebuggerUrl,
  })
  expect(requests).toEqual(Array(4).fill("GET /json/list"))
})

test("a refused owned loopback endpoint can become available without changing ports", async () => {
  const reserved = await serve((_request, response) => response.end("[]"))
  await new Promise<void>((resolve) => reserved.server.close(() => resolve()))
  expect(await probePackagedRenderer(reserved.port, 100)).toBeUndefined()
  const fixture = await serve(
    (_request, response) => response.end(JSON.stringify([target(reserved.port)])),
    reserved.port,
  )
  expect((await probePackagedRenderer(fixture.port))?.id).toBe(target(fixture.port).id)
})

test("discovery accepts only an array containing the owned renderer and a matching loopback page socket", async () => {
  let reply: unknown
  const fixture = await serve((_request, response) => response.end(JSON.stringify(reply)))
  const valid = target(fixture.port)
  for (const invalid of [
    null,
    {},
    valid,
    [null, 1, {}],
    [{ ...valid, type: "service_worker" }],
    [{ ...valid, url: "https://renderer/" }],
    [{ ...valid, url: "oc://renderer.evil/index.html" }],
    [{ ...valid, url: "oc://renderer@evil/index.html" }],
    [{ ...valid, id: "../browser/foreign" }],
    [{ ...valid, webSocketDebuggerUrl: valid.webSocketDebuggerUrl.replace("127.0.0.1", "localhost") }],
    [{ ...valid, webSocketDebuggerUrl: valid.webSocketDebuggerUrl.replace("127.0.0.1", "192.0.2.1") }],
    [{ ...valid, webSocketDebuggerUrl: valid.webSocketDebuggerUrl.replace(`:${fixture.port}/`, ":1/") }],
    [{ ...valid, webSocketDebuggerUrl: valid.webSocketDebuggerUrl.replace("/page/", "/browser/") }],
    [{ ...valid, webSocketDebuggerUrl: valid.webSocketDebuggerUrl + "?redirect=foreign" }],
    [{ ...valid, webSocketDebuggerUrl: valid.webSocketDebuggerUrl + "different-id" }],
  ]) {
    reply = invalid
    expect(await probePackagedRenderer(fixture.port)).toBeUndefined()
  }
  reply = [null, { ...valid, type: "service_worker" }, valid]
  expect((await probePackagedRenderer(fixture.port))?.id).toBe(valid.id)
})

test("unending, oversized and redirected responses remain bounded and never follow another endpoint", async () => {
  let mode = "stall"
  let redirected = 0
  const destination = await serve((_request, response) => {
    redirected++
    response.end("[]")
  })
  const fixture = await serve((_request, response) => {
    if (mode === "stall") {
      response.writeHead(200)
      response.write("[")
      return
    }
    if (mode === "large") return void response.end(" ".repeat(65537) + JSON.stringify([target(fixture.port)]))
    response.writeHead(302, { Location: `http://127.0.0.1:${destination.port}/json/list` })
    response.end()
  })
  const started = Date.now()
  expect(await probePackagedRenderer(fixture.port, 35)).toBeUndefined()
  expect(Date.now() - started).toBeLessThan(1000)
  mode = "large"
  expect(await probePackagedRenderer(fixture.port)).toBeUndefined()
  mode = "redirect"
  expect(await probePackagedRenderer(fixture.port)).toBeUndefined()
  expect(redirected).toBe(0)
})

test("perpetually malformed responses cannot admit a renderer or extend the caller's retry deadline", async () => {
  let requests = 0
  const fixture = await serve((_request, response) => {
    requests++
    response.end("[")
  })
  const deadline = Date.now() + 60
  while (Date.now() < deadline) {
    expect(await probePackagedRenderer(fixture.port, 20)).toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const stopped = requests
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(requests).toBe(stopped)
  expect(requests).toBeGreaterThan(1)
  for (const port of [0, -1, 65536, 1.5, NaN])
    await expect(probePackagedRenderer(port)).rejects.toThrow("PACKAGED_DEBUG_ENDPOINT_INVALID")
})
