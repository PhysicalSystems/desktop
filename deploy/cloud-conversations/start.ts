// SPDX-License-Identifier: Apache-2.0
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { cloudProfile } from "./profile"
import { awaitVerifiedAgent, permittedRequest, verifiedAgent, verifiedSession } from "./policy"

if (Bun.version !== "1.4.4") throw new Error("Cloud worker requires Bun 1.4.4")
const profile = cloudProfile(process.env)
await Promise.all(
  [
    profile.workspace,
    profile.state,
    ...["home", "config", "data", "cache", "state", "tmp"].map((name) => join(profile.state, name)),
  ].map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
)
await Bun.write(join(profile.workspace, "opencode.json"), JSON.stringify(profile.config))
await Bun.write(join(profile.workspace, "models.json"), "{}")
const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") })
const internalPort = reservation.port
reservation.stop(true)
const child = Bun.spawn(
  [
    process.execPath,
    "run",
    "./src/index.ts",
    "serve",
    "--stdio",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(internalPort),
  ],
  {
    cwd: join(import.meta.dir, "../../packages/cli"),
    env: profile.childEnv,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "pipe",
  },
)
// V2 treats stdin as the worker lease, including when this parent exits unexpectedly.
process.on("SIGTERM", () => child.stdin.end())
process.on("SIGINT", () => child.stdin.end())
const origin = `http://127.0.0.1:${internalPort}`
const authorization = `Basic ${Buffer.from(`opencode:${profile.childEnv.OPENCODE_PASSWORD}`).toString("base64")}`
const agentPath = `/api/agent?${new URLSearchParams({ "location[directory]": profile.workspace })}`
const upstream = (path: string, options: { method?: string; body?: unknown } = {}) =>
  fetch(origin + path, {
    method: options.method ?? "GET",
    headers: { Authorization: authorization, "Content-Type": "application/json" },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: AbortSignal.timeout(30000),
    redirect: "error",
  })
async function readPolicy() {
  const response = await fetch(origin + agentPath, {
    headers: { Authorization: authorization },
    signal: AbortSignal.timeout(10000),
  })
  if (!response.ok) throw new Error("CLOUD_POLICY_UNAVAILABLE")
  return response.json()
}
const policy = async () => verifiedAgent(await readPolicy(), profile)
let ready = false
for (let i = 0; i < 600; i++) {
  if (child.exitCode !== null) process.exit(child.exitCode || 1)
  const health = await fetch(origin + "/api/info", {
    headers: { Authorization: authorization },
    signal: AbortSignal.timeout(1000),
  }).catch(() => undefined)
  if (health?.ok) {
    ready = true
    break
  }
  await Bun.sleep(200)
}
if (!ready) {
  child.kill()
  throw new Error("Cloud worker did not become healthy")
}
await awaitVerifiedAgent(readPolicy, profile, { alive: () => child.exitCode === null }).catch((error) => {
  child.kill()
  throw error
})
// Raw OpenCode stays loopback-only. The service port does not exist until its actual policy is verified.
const proxy = Bun.serve({
  hostname: "0.0.0.0",
  port: profile.port,
  idleTimeout: 60,
  maxRequestBodySize: 200000,
  async fetch(request) {
    if (request.headers.get("Authorization") !== authorization)
      return new Response(null, {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="Physical Systems worker"' },
      })
    const url = new URL(request.url)
    const body = request.method === "POST" ? await request.json().catch(() => null) : undefined
    if (!permittedRequest(request.method, url, profile, body))
      return Response.json({ error: "NOT_FOUND" }, { status: 404 })
    if (url.pathname === "/api/agent" || request.method === "POST") {
      const agent = await policy().catch(() => undefined)
      if (!agent) return Response.json({ error: "CLOUD_POLICY_UNAVAILABLE" }, { status: 503 })
      if (url.pathname === "/api/agent") return Response.json(agent)
    }
    const target = url.pathname.match(/^\/api\/session\/(ses_[A-Za-z0-9_-]+)(?:\/(?:message|prompt))?$/)?.[1]
    if (target) {
      const stored = await upstream(`/api/session/${target}`).catch(() => undefined)
      const metadata: unknown = await stored?.json().catch(() => undefined)
      if (!stored?.ok || !verifiedSession(metadata, target, profile))
        return Response.json({ error: "SESSION_NOT_FOUND" }, { status: 404 })
      if (request.method === "GET" && url.pathname === `/api/session/${target}`) return Response.json(metadata)
    }
    // Keep the deployed health contract while V2 serves readiness through server.info.
    const prompt = body as { id: string; prompt: { text: string }; delivery: "steer" }
    const response = await upstream(url.pathname === "/api/health" ? "/api/info" : url.pathname + url.search, {
      method: request.method,
      body: url.pathname.endsWith("/prompt") ? { id: prompt.id, text: prompt.prompt.text, delivery: prompt.delivery } : body,
    }).catch(() => undefined)
    if (!response) return Response.json({ error: "WORKER_UNAVAILABLE" }, { status: 503 })
    if (response.ok && url.pathname === "/api/health") return Response.json({ healthy: true })
    if (response.ok && request.method === "POST" && url.pathname === "/api/session") {
      const metadata: unknown = await response.json().catch(() => undefined)
      if (!verifiedSession(metadata, String((body as { id: string }).id), profile))
        return Response.json({ error: "SESSION_BINDING_CONFLICT" }, { status: 409 })
      return Response.json(metadata)
    }
    if (response.ok && url.pathname === "/api/session/active") {
      const active = (await response.json()) as { data?: Record<string, unknown> }
      const entries = Object.entries(active.data ?? {})
      if (entries.length > 1000) return Response.json({ error: "WORKER_UNAVAILABLE" }, { status: 503 })
      const visible = await Promise.all(
        entries.map(async ([id, status]) => {
          if (!/^ses_[A-Za-z0-9_-]{1,100}$/.test(id)) return []
          const stored = await upstream(`/api/session/${id}`)
            .then((value) => value.json())
            .catch(() => undefined)
          return verifiedSession(stored, id, profile) ? [[id, status]] : []
        }),
      )
      return Response.json({ data: Object.fromEntries(visible.flat()) })
    }
    // Bun fetch decompresses upstream bodies while retaining the original encoding headers.
    const headers = new Headers(response.headers)
    for (const name of [
      "content-encoding",
      "content-length",
      "connection",
      "transfer-encoding",
      "keep-alive",
      "trailer",
      "upgrade",
    ])
      headers.delete(name)
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  },
})
console.log(`Physical Systems conversation worker ready on port ${proxy.port}`)
void child.exited.then(() => proxy.stop(true))
process.exit(await child.exited)
