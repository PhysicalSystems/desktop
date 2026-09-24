// SPDX-License-Identifier: Apache-2.0
// Client for the LeLab HTTP camera API. Camera ownership remains inside LeLab.
import { request } from "node:http"
import type { LeLabCamera, LeLabCameraBridge, LeLabConnection, LeLabErrorCode, LeLabResult } from "./lelab-types"

const JSON_LIMIT = 256 * 1024
const JPEG_LIMIT = 4 * 1024 * 1024
const CAMERA_PATH = /^\/dev\/(?:video\d+|v4l\/by-(?:id|path)\/[^/]+-video-index0)$/

class LeLabError extends Error {
  constructor(readonly code: LeLabErrorCode) { super(code) }
}

type Camera = LeLabCamera & { path?: string; fourcc?: string }
type Robot = { name: string; cameras: Camera[] }
type Client = { url?: string; robots?: Robot[]; controller: AbortController; pending: number; touched: number }

/** One instance per renderer owner. dispose() cancels only its HTTP requests. */
export function createLeLabCameraClient(options: { timeoutMs?: number } = {}): LeLabCameraBridge & { dispose(): void } {
  const clients = new Map<string, Client>()
  let disposed = false
  const run = async <T>(input: LeLabConnection, action: (url: string, signal: AbortSignal, client: Client) => Promise<T>): Promise<LeLabResult<T>> => {
    try {
      if (disposed) throw new LeLabError("CANCELLED")
      if (!record(input) || !identifier(input.clientId)) throw new LeLabError("INVALID_REQUEST")
      const url = loopbackURL(input.url)
      // Retain cancellation tombstones beyond the maximum request lifetime.
      for (const [id, item] of clients) if (!item.pending && Date.now() - item.touched > 300_000) clients.delete(id)
      if (!clients.has(input.clientId) && clients.size >= 128) throw new LeLabError("CAPACITY")
      const client = clients.get(input.clientId) ?? { controller: new AbortController(), pending: 0, touched: Date.now() }
      clients.set(input.clientId, client)
      if (client.controller.signal.aborted) throw new LeLabError("CANCELLED")
      if (client.url && client.url !== url) throw new LeLabError("INVALID_REQUEST")
      client.url = url
      if (client.pending >= 8 || [...clients.values()].reduce((sum, item) => sum + item.pending, 0) >= 16) throw new LeLabError("CAPACITY")
      client.pending++
      client.touched = Date.now()
      const timeout = AbortSignal.timeout(options.timeoutMs ?? 5_000)
      const signal = AbortSignal.any([client.controller.signal, timeout])
      try {
        const value = await action(url, signal, client)
        signal.throwIfAborted()
        return { ok: true, value }
      } catch (error) {
        if (client.controller.signal.aborted) throw new LeLabError("CANCELLED")
        if (timeout.aborted) throw new LeLabError("TIMEOUT")
        throw error
      } finally {
        client.pending--
        client.touched = Date.now()
      }
    } catch (error) {
      return { ok: false, code: error instanceof LeLabError ? error.code : error instanceof SyntaxError ? "INVALID_RESPONSE" : "UNAVAILABLE" }
    }
  }

  return {
    discover: (input) => run(input, async (url, signal, client) => {
      const configured = await robots(url, signal)
      signal.throwIfAborted()
      client.robots = configured
      return {
        url,
        robots: configured.map((robot) => ({
          name: robot.name,
          cameras: robot.cameras.map(({ path: _path, fourcc: _fourcc, ...camera }) => camera),
        })),
      }
    }),
    frame: (input) => run(input, async (url, signal, client) => {
      if (!identifier(input.robotName) || !identifier(input.cameraId)) throw new LeLabError("INVALID_REQUEST")
      if (!client.robots) throw new LeLabError("INVALID_REQUEST")
      const camera = client.robots.find((robot) => robot.name === input.robotName)?.cameras.find((camera) => camera.id === input.cameraId)
      if (!camera) throw new LeLabError("CAMERA_MISSING")
      // Pin what the operator selected. Never silently open a replacement source
      // while the renderer still displays the previous camera's name/settings.
      const current = (await robots(url, signal)).find((robot) => robot.name === input.robotName)?.cameras.find((camera) => camera.id === input.cameraId)
      if (JSON.stringify(current) !== JSON.stringify(camera)) throw new LeLabError("CONFIG_CHANGED")
      if (!camera.previewAvailable || !camera.path) throw new LeLabError("UNSUPPORTED_CAMERA")
      const query = new URLSearchParams({ camera_path: camera.path, width: String(camera.width), height: String(camera.height), fps: String(camera.fps) })
      if (camera.fourcc) query.set("fourcc", camera.fourcc)
      const bytes = await get(url, `/camera-preview?${query}`, "image/jpeg", JPEG_LIMIT, signal)
      if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw new LeLabError("INVALID_RESPONSE")
      return { bytes: new Uint8Array(bytes), contentType: "image/jpeg" as const, receivedAt: Date.now() }
    }),
    async stop(input) {
      if (!record(input) || !identifier(input.clientId)) return
      const client = clients.get(input.clientId)
      if (client) {
        client.controller.abort()
        client.touched = Date.now()
        return
      }
      if (clients.size >= 128) return
      const controller = new AbortController()
      controller.abort()
      clients.set(input.clientId, { controller, pending: 0, touched: Date.now() })
    },
    dispose() {
      disposed = true
      for (const client of clients.values()) client.controller.abort()
      clients.clear()
    },
  }
}

function loopbackURL(value: unknown) {
  if (typeof value !== "string" || value.length > 100) throw new LeLabError("INVALID_URL")
  const match = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):([0-9]{1,5})\/?$/.exec(value)
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) throw new LeLabError("INVALID_URL")
  return `http://${match[1]}:${Number(match[2])}`
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 160 && !/[\x00-\x1f\x7f]/.test(value)
}

async function robots(url: string, signal: AbortSignal): Promise<Robot[]> {
  const data: unknown = JSON.parse((await get(url, "/robots", "application/json", JSON_LIMIT, signal)).toString("utf8"))
  if (!record(data) || data.status !== "success" || !Array.isArray(data.robots) || data.robots.length > 64) throw new LeLabError("INVALID_RESPONSE")
  const result = data.robots.map((robot): Robot => {
    if (!record(robot) || !identifier(robot.name) || !Array.isArray(robot.cameras) || robot.cameras.length > 8) throw new LeLabError("INVALID_RESPONSE")
    const cameras = robot.cameras.map((camera): Camera => {
      if (!record(camera) || !identifier(camera.id) || !identifier(camera.name)) throw new LeLabError("INVALID_RESPONSE")
      const width = camera.width === undefined ? 640 : camera.width
      const height = camera.height === undefined ? 480 : camera.height
      const fps = camera.fps === undefined ? 30 : camera.fps
      if (!Number.isInteger(width) || Number(width) < 1 || Number(width) > 1920 || !Number.isInteger(height) || Number(height) < 1 || Number(height) > 1080 || !Number.isInteger(fps) || Number(fps) < 1 || Number(fps) > 60) throw new LeLabError("INVALID_RESPONSE")
      const path = typeof camera.camera_path === "string" && camera.camera_path.length <= 1024 && !/[\x00-\x1f\x7f]/.test(camera.camera_path) && CAMERA_PATH.test(camera.camera_path) ? camera.camera_path : undefined
      if (camera.fourcc != null && camera.fourcc !== "" && (typeof camera.fourcc !== "string" || !/^[A-Za-z0-9]{4}$/.test(camera.fourcc))) throw new LeLabError("INVALID_RESPONSE")
      return { id: camera.id, name: camera.name, width: Number(width), height: Number(height), fps: Number(fps), path, fourcc: camera.fourcc ? String(camera.fourcc) : undefined, previewAvailable: camera.type === "opencv" && Boolean(path) }
    })
    if (new Set(cameras.map((camera) => camera.id)).size !== cameras.length) throw new LeLabError("INVALID_RESPONSE")
    return { name: robot.name, cameras }
  })
  if (new Set(result.map((robot) => robot.name)).size !== result.length) throw new LeLabError("INVALID_RESPONSE")
  return result
}

function get(base: string, path: string, type: string, limit: number, signal: AbortSignal): Promise<Buffer> {
  const url = new URL(base)
  return new Promise((resolve, reject) => {
    const req = request({
      protocol: "http:", hostname: url.hostname === "[::1]" ? "::1" : "127.0.0.1",
      port: url.port || 80, path, method: "GET", signal,
      headers: { Accept: type, "Cache-Control": "no-store" },
    }, (response) => {
      const fail = (code: LeLabErrorCode) => { signal.removeEventListener("abort", abort); response.destroy(); reject(new LeLabError(code)) }
      if (response.statusCode !== 200) {
        const code = response.statusCode
        if (path === "/robots") return fail(code === 504 ? "TIMEOUT" : code && code >= 300 && code < 500 ? "INVALID_RESPONSE" : "UNAVAILABLE")
        return fail(code === 409 ? "CAMERA_BUSY" : code === 404 ? "CAMERA_MISSING" : code === 504 ? "TIMEOUT" : code === 400 ? "UNSUPPORTED_CAMERA" : code && code >= 300 && code < 400 ? "INVALID_RESPONSE" : "UNAVAILABLE")
      }
      if (response.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== type || response.headers["content-encoding"] || Number(response.headers["content-length"] ?? 0) > limit) return fail("INVALID_RESPONSE")
      const chunks: Buffer[] = []
      let size = 0
      response.on("data", (chunk: Buffer) => {
        size += chunk.length
        if (size > limit) return fail("INVALID_RESPONSE")
        chunks.push(chunk)
      })
      response.on("end", () => { signal.removeEventListener("abort", abort); resolve(Buffer.concat(chunks)) })
      response.on("error", (error) => { signal.removeEventListener("abort", abort); reject(error) })
    })
    // Explicit cancellation also settles the promise on runtimes whose HTTP
    // AbortSignal support does not emit an error for a response without headers.
    const abort = () => { signal.removeEventListener("abort", abort); req.destroy(); reject(signal.reason) }
    req.on("error", (error) => { signal.removeEventListener("abort", abort); reject(error) })
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) return abort()
    req.end()
  })
}
