// SPDX-License-Identifier: Apache-2.0
import { mkdir } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { cloudProfile } from "./profile"
import { verifiedAgent } from "./policy"

const destination = process.argv[2]
if (!destination || !isAbsolute(destination))
  throw new Error("Pass an absolute evidence directory outside the source repository")
const directory = join(destination, `worker-${Date.now()}`)
await mkdir(directory, { recursive: true })
const requests: Record<string, unknown>[] = []
const fake = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as Record<string, unknown>
    requests.push(body)
    if (request.headers.get("Authorization") !== "Bearer fixture-provider-key")
      return new Response("unauthorized", { status: 401 })
    const base = { id: "chatcmpl_fixture", object: "chat.completion.chunk", created: 1700000000, model: "fixture-chat" }
    const chunks = [
      {
        ...base,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "Cloud worker qualification complete." },
            finish_reason: null,
          },
        ],
      },
      {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 },
      },
    ]
    return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
      headers: { "Content-Type": "text/event-stream" },
    })
  },
})
const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") })
const port = reservation.port
reservation.stop(true)
const env = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  OPENCODE_SERVER_PASSWORD: "fixture-private-worker-password-000000000",
  PHYSICALSYSTEMS_AI_API_KEY: "fixture-provider-key",
  CONVERSATION_PROVIDER: "qualification",
  CONVERSATION_MODEL: "fixture-chat",
  CONVERSATION_API_BASE_URL: `http://127.0.0.1:${fake.port}/v1`,
  CLOUD_WORKSPACE: join(directory, "workspace"),
  CLOUD_STATE_DIR: join(directory, "state"),
  PORT: String(port),
}
const profile = cloudProfile(env)
const log = Bun.file(join(directory, "worker.log"))
const child = Bun.spawn([process.execPath, "run", join(import.meta.dir, "start.ts")], {
  env,
  stdout: log,
  stderr: log,
  stdin: "ignore",
})
const headers = {
  Authorization: `Basic ${Buffer.from(`opencode:${env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`,
  "Content-Type": "application/json",
}
const origin = `http://127.0.0.1:${port}`
const check = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message)
}
async function json(path: string, body?: unknown) {
  const response = await fetch(origin + path, {
    headers,
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20000),
  })
  const value = (await response.json()) as Record<string, unknown>
  check(response.ok, `${path} returned ${response.status}: ${JSON.stringify(value)}`)
  return value
}
const evidence: Record<string, unknown> = {
  directory,
  source: "pinned local Physical Systems OpenCode",
  bun: Bun.version,
  disposition: "Retain isolated fake-provider qualification evidence; no production data or credentials",
}
try {
  let ready = false
  for (let i = 0; i < 600; i++) {
    const response = await fetch(origin + "/api/health", { headers, signal: AbortSignal.timeout(1000) }).catch(
      () => undefined,
    )
    if (response?.ok) {
      ready = true
      break
    }
    if (child.exitCode !== null) throw new Error(`Worker exited ${child.exitCode}; inspect ${log.name}`)
    await Bun.sleep(200)
  }
  check(ready, `Worker did not become ready; inspect ${log.name}`)
  check((await json("/api/health")).healthy === true, "Deployed health contract changed")
  const denied = await fetch(origin + "/api/health")
  check(denied.status === 401, "Worker health must require authorization")
  const agents = verifiedAgent(
    await json(`/api/agent?${new URLSearchParams({ "location[directory]": profile.workspace })}`),
    profile,
  )
  const forbidden = await fetch(origin + "/api/config", { headers })
  check(forbidden.status === 404, "General OpenCode API was exposed")
  const id = `ses_${crypto.randomUUID()}`
  const session = await json("/api/session", {
    id,
    agent: "physicalsystems-cloud",
    model: { id: "fixture-chat", providerID: "qualification" },
    location: { directory: profile.workspace },
  })
  check((session.data as { id?: string })?.id === id, "Session ID binding changed")
  const messageId = `msg_${crypto.randomUUID()}`
  const admission = await json(`/api/session/${id}/prompt`, {
    id: messageId,
    prompt: { text: "Reply with a short confirmation." },
    delivery: "steer",
  })
  check((admission.data as { id?: string })?.id === messageId, "Prompt was not durably admitted")
  let messages: Record<string, unknown> = {}
  for (let i = 0; i < 150; i++) {
    messages = await json(`/api/session/${id}/message?order=asc&limit=200`)
    if (JSON.stringify(messages).includes("Cloud worker qualification complete.")) break
    await Bun.sleep(200)
  }
  check(
    JSON.stringify(messages).includes("Cloud worker qualification complete."),
    `Assistant reply absent; inspect ${log.name}`,
  )
  check(requests.length > 0, "Fake provider was not reached")
  check(
    requests.every((request) => !Array.isArray(request.tools) || request.tools.length === 0),
    "Worker advertised tools",
  )
  check(
    requests.every((request) => request.model === "fixture-chat"),
    "Worker used another model",
  )
  const replay = await json(`/api/session/${id}/prompt`, {
    id: messageId,
    prompt: { text: "Reply with a short confirmation." },
    delivery: "steer",
  })
  check((replay.data as { id?: string })?.id === messageId, "Exact admission retry changed ID")
  const reread = await json(`/api/session/${id}/message?order=asc&limit=200`)
  check(JSON.stringify(reread).includes("Cloud worker qualification complete."), "Persisted history absent")
  Object.assign(evidence, {
    passed: true,
    sessionId: id,
    messageId,
    providerRequests: requests.length,
    toolsAdvertised: false,
    unauthenticatedStatus: denied.status,
    admission,
    session,
    messages,
    agents,
  })
  await Bun.write(join(directory, "qualification.json"), JSON.stringify(evidence, null, 2))
  console.log(
    JSON.stringify({
      passed: true,
      directory,
      providerRequests: requests.length,
      toolsAdvertised: false,
      unauthenticatedStatus: denied.status,
    }),
  )
  if (process.argv.includes("--keep")) {
    console.log(
      JSON.stringify({
        ready: true,
        origin,
        workspace: profile.workspace,
        provider: env.CONVERSATION_PROVIDER,
        model: env.CONVERSATION_MODEL,
      }),
    )
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 20 * 60 * 1000)
      const done = () => {
        clearTimeout(timeout)
        resolve()
      }
      process.once("SIGTERM", done)
      process.once("SIGINT", done)
    })
  }
} catch (error) {
  await Bun.write(
    join(directory, "qualification.json"),
    JSON.stringify(
      {
        ...evidence,
        passed: false,
        error: error instanceof Error ? error.message : String(error),
        providerRequests: requests.length,
      },
      null,
      2,
    ),
  )
  throw error
} finally {
  await Bun.write(join(directory, "fixture-requests.json"), JSON.stringify(requests, null, 2))
  child.kill("SIGTERM")
  await Promise.race([child.exited, Bun.sleep(5000)])
  if (child.exitCode === null) child.kill("SIGKILL")
  fake.stop(true)
}
