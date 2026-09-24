// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test"
import { createServer } from "node:http"
import type { RequestListener, Server } from "node:http"
import { createLeLabCameraClient } from "./lelab"

const servers: Server[] = []
const clients: ReturnType<typeof createLeLabCameraClient>[] = []
const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9])
const cameras = [
  { id: "wrist-id", name: "USB Camera", type: "opencv", camera_path: "/dev/v4l/by-id/usb-wrist-video-index0", width: 800, height: 600, fps: 20, fourcc: "YUYV" },
  { id: "overview-id", name: "USB Camera", type: "opencv", camera_path: "/dev/v4l/by-id/usb-overview-video-index0", width: 640, height: 480, fps: 30 },
]
const robotData = { status: "success", robots: [{ name: "White arm", cameras }] }

afterEach(async () => {
  clients.splice(0).forEach((client) => client.dispose())
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
    server.closeAllConnections()
  })))
})

function client(timeoutMs?: number) {
  const value = createLeLabCameraClient({ timeoutMs })
  clients.push(value)
  return value
}

async function serve(handler: RequestListener) {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Fixture did not bind")
  return `http://127.0.0.1:${address.port}`
}

async function service(frame: RequestListener, data: unknown = robotData) {
  return serve((request, response) => {
    if (request.url === "/robots") {
      response.setHeader("Content-Type", "application/json")
      response.end(JSON.stringify(data))
      return
    }
    frame(request, response)
  })
}

test("discovers configured robots without opening cameras and preserves distinct IDs with identical names", async () => {
  let frames = 0
  const url = await service((_request, response) => { frames++; response.end() })
  const result = await client().discover({ url, clientId: "panel" })
  expect(result).toEqual({ ok: true, value: { url, robots: [{ name: "White arm", cameras: cameras.map((camera) => ({ id: camera.id, name: camera.name, width: camera.width, height: camera.height, fps: camera.fps, previewAvailable: true })) }] } })
  expect(frames).toBe(0)
})

test("fetches JPEG using the exact discovered camera identity and settings, with GET only", async () => {
  const queries: URL[] = []
  const data = structuredClone(robotData)
  const url = await service((request, response) => {
    expect(request.method).toBe("GET")
    queries.push(new URL(request.url!, "http://fixture"))
    response.setHeader("Content-Type", "image/jpeg")
    response.end(jpeg)
  }, data)
  const bridge = client()
  const input = { url, clientId: "panel", robotName: "White arm", cameraId: "wrist-id" }
  expect((await bridge.discover(input)).ok).toBe(true)
  const first = await bridge.frame(input)
  expect(first.ok).toBe(true)
  if (first.ok) {
    expect(first.value.bytes).toEqual(new Uint8Array(jpeg))
    expect(first.value.contentType).toBe("image/jpeg")
    expect(first.value.receivedAt).toBeGreaterThan(0)
  }
  expect(queries[0].pathname).toBe("/camera-preview")
  expect(Object.fromEntries(queries[0].searchParams)).toEqual({ camera_path: cameras[0].camera_path, width: "800", height: "600", fps: "20", fourcc: "YUYV" })
})

test("requires discovery and rejects changed identity, labels or settings before opening a camera", async () => {
  let opened = 0
  const data = structuredClone(robotData)
  const url = await service((_request, response) => { opened++; response.setHeader("Content-Type", "image/jpeg"); response.end(jpeg) }, data)
  const bridge = client()
  const input = { url, clientId: "panel", robotName: "White arm", cameraId: "wrist-id" }
  expect(await bridge.frame(input)).toEqual({ ok: false, code: "INVALID_REQUEST" })
  expect((await bridge.discover(input)).ok).toBe(true)
  for (const change of [
    { camera_path: "/dev/v4l/by-path/new-port-video-index0" },
    { name: "Replacement camera" }, { width: 640 }, { height: 480 },
    { fps: 30 }, { fourcc: "MJPG" }, { id: "replacement-id" },
  ]) {
    data.robots[0].cameras[0] = { ...cameras[0], ...change }
    expect(await bridge.frame(input)).toEqual({ ok: false, code: "CONFIG_CHANGED" })
  }
  expect(opened).toBe(0)
  data.robots[0].cameras[0] = { ...cameras[0], camera_path: "/dev/v4l/by-path/new-port-video-index0" }
  expect((await bridge.discover(input)).ok).toBe(true)
  expect((await bridge.frame(input)).ok).toBe(true)
  expect(opened).toBe(1)
})

test("rejects non-loopback, ambiguous and decorated URLs before any request", async () => {
  const bridge = client()
  for (const url of ["http://example.com:8000", "https://localhost:8000", "http://localhost", "http://127.1:8000", "http://2130706433:8000", "http://127.0.0.1.evil:8000", "http://u:p@localhost:8000", "http://localhost:8000/path", "http://localhost:8000?x=1", "http://localhost:8000#x", "http://localhost:0", "http://localhost:65536", "file:///etc/passwd"]) {
    expect(await bridge.discover({ url, clientId: "panel" })).toEqual({ ok: false, code: "INVALID_URL" })
  }
})

test("localhost is supported without resolving arbitrary DNS names", async () => {
  const url = (await service((_request, response) => response.end())).replace("127.0.0.1", "localhost")
  expect((await client().discover({ url, clientId: "panel" })).ok).toBe(true)
})

test("never follows redirects", async () => {
  let redirected = 0
  const target = await serve((_request, response) => { redirected++; response.end() })
  const url = await serve((_request, response) => { response.writeHead(302, { Location: target }); response.end() })
  expect(await client().discover({ url, clientId: "panel" })).toEqual({ ok: false, code: "INVALID_RESPONSE" })
  expect(redirected).toBe(0)
})

test("a missing robots endpoint is an invalid service response, not a missing camera", async () => {
  const url = await serve((_request, response) => { response.writeHead(404); response.end() })
  expect(await client().discover({ url, clientId: "panel" })).toEqual({ ok: false, code: "INVALID_RESPONSE" })
})

test("rejects missing and unsupported sources without opening an arbitrary path or falling back to numeric index", async () => {
  let frames = 0
  const data = { status: "success", robots: [{ name: "White arm", cameras: [{ id: "legacy", name: "Camera", type: "opencv", camera_index: 4, camera_path: "http://example.com/video", width: 640, height: 480 }] }] }
  const url = await service((_request, response) => { frames++; response.end() }, data)
  const bridge = client()
  const input = { url, clientId: "panel", robotName: "White arm", cameraId: "legacy" }
  expect((await bridge.discover(input)).ok).toBe(true)
  expect(await bridge.frame(input)).toEqual({ ok: false, code: "UNSUPPORTED_CAMERA" })
  expect(await bridge.frame({ ...input, cameraId: "invented" })).toEqual({ ok: false, code: "CAMERA_MISSING" })
  expect(frames).toBe(0)
})

test("rejects malformed or ambiguous robot metadata", async () => {
  for (const data of [
    { status: "success", robots: [{ name: "arm", cameras: [cameras[0], cameras[0]] }] },
    { status: "success", robots: [robotData.robots[0], robotData.robots[0]] },
    { status: "success", robots: [{ name: "arm\u0000", cameras: [] }] },
    { status: "success", robots: [{ name: "arm", cameras: [{ ...cameras[0], width: 999999 }] }] },
    { status: "success", robots: [{ name: "arm", cameras: [{ ...cameras[0], fps: "20" }] }] },
    { status: "success", robots: [{ name: "arm", cameras: [{ ...cameras[0], fps: null }] }] },
    { status: "error", robots: [] },
  ]) {
    const url = await service((_request, response) => response.end(), data)
    expect(await client().discover({ url, clientId: "panel" })).toEqual({ ok: false, code: "INVALID_RESPONSE" })
  }
})

test("maps camera busy and missing status without exposing untrusted server error text", async () => {
  for (const [status, code] of [[409, "CAMERA_BUSY"], [404, "CAMERA_MISSING"], [504, "TIMEOUT"], [503, "UNAVAILABLE"]] as const) {
    const url = await service((_request, response) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end('{"detail":"untrusted server text"}') })
    const bridge = client()
    expect((await bridge.discover({ url, clientId: "panel" })).ok).toBe(true)
    expect(await bridge.frame({ url, clientId: "panel", robotName: "White arm", cameraId: "wrist-id" })).toEqual({ ok: false, code })
  }
})

test("bounds JSON bodies even without Content-Length and rejects malformed JSON", async () => {
  for (const body of ["not-json", " ".repeat(256 * 1024 + 1)]) {
    const url = await serve((_request, response) => { response.setHeader("Content-Type", "application/json"); response.write(body); response.end() })
    expect(await client().discover({ url, clientId: "panel" })).toEqual({ ok: false, code: "INVALID_RESPONSE" })
  }
})

test("rejects oversized, mislabeled or invalid JPEG responses", async () => {
  for (const [mime, body] of [["text/html", jpeg], ["image/jpeg", Buffer.from("not a jpeg")], ["image/jpeg", Buffer.alloc(4 * 1024 * 1024 + 1)]] as const) {
    const url = await service((_request, response) => { response.setHeader("Content-Type", mime); response.write(body); response.end() })
    const bridge = client()
    expect((await bridge.discover({ url, clientId: "panel" })).ok).toBe(true)
    expect(await bridge.frame({ url, clientId: "panel", robotName: "White arm", cameraId: "wrist-id" })).toEqual({ ok: false, code: "INVALID_RESPONSE" })
  }
})

test("Stop aborts only its client, prevents late requests, and never sends a LeLab stop command", async () => {
  let acknowledge: () => void = () => {}
  const started = new Promise<void>((resolve) => { acknowledge = resolve })
  const routes: string[] = []
  const url = await serve((request, response) => {
    routes.push(request.url!)
    if (request.url === "/robots") { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(robotData)); return }
    acknowledge()
  })
  const bridge = client()
  const input = { url, clientId: "a", robotName: "White arm", cameraId: "wrist-id" }
  expect((await bridge.discover(input)).ok).toBe(true)
  const pending = bridge.frame(input)
  await started
  await bridge.stop({ clientId: "a" })
  expect(await pending).toEqual({ ok: false, code: "CANCELLED" })
  expect(await bridge.frame(input)).toEqual({ ok: false, code: "CANCELLED" })
  expect((await bridge.discover({ url, clientId: "b" })).ok).toBe(true)
  await bridge.stop({ clientId: "not-yet-started" })
  expect(await bridge.discover({ url, clientId: "not-yet-started" })).toEqual({ ok: false, code: "CANCELLED" })
  expect(routes.every((route) => route === "/robots" || route.startsWith("/camera-preview?"))).toBe(true)
})

test("timeouts bound stalled responses and disposing a window aborts pending requests", async () => {
  const url = await serve(() => {})
  expect(await client(25).discover({ url, clientId: "panel" })).toEqual({ ok: false, code: "TIMEOUT" })
  const bridge = client()
  const pending = bridge.discover({ url, clientId: "panel" })
  bridge.dispose()
  expect(await pending).toEqual({ ok: false, code: "CANCELLED" })
  expect(await bridge.discover({ url, clientId: "fresh" })).toEqual({ ok: false, code: "CANCELLED" })
})

test("one client ID cannot switch services and malformed IPC requests fail closed", async () => {
  const url = await service((_request, response) => response.end())
  const bridge = client()
  expect((await bridge.discover({ url, clientId: "panel" })).ok).toBe(true)
  expect(await bridge.discover({ url: "http://localhost:8000", clientId: "panel" })).toEqual({ ok: false, code: "INVALID_REQUEST" })
  expect(await bridge.discover({ url, clientId: "" })).toEqual({ ok: false, code: "INVALID_REQUEST" })
  expect(await bridge.discover(null as never)).toEqual({ ok: false, code: "INVALID_REQUEST" })
})
