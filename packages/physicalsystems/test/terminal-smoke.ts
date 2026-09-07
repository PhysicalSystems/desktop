// SPDX-License-Identifier: Apache-2.0
// Called only by the isolated native fixture while its own desktop is alive.
import { spawn } from "node:child_process"
import { join, resolve } from "node:path"
import { readAttachment } from "../src/attachment"
import { physicalEnvironment } from "../src/environment"

const prompt = "Confirm the recorded synthetic result from this attached terminal."
const error = (code: string) => new Error(code)
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)

export async function terminalSmoke(root: string) {
  const attachment = await readAttachment(join(resolve(root), "desktop", "runtime-attach.json"))
  if (!attachment.directory || !attachment.sessionId) throw error("TERMINAL_FIXTURE_SESSION_REQUIRED")
  const sessionId = attachment.sessionId
  const directory = attachment.directory
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), 40_000)
  const headers = { Authorization: `Basic ${Buffer.from(`${attachment.username}:${attachment.password}`).toString("base64")}` }
  const request = async (route: string) => {
    const url = new URL(route, attachment.url)
    url.searchParams.set("directory", directory)
    const response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2500)]) })
    if (!response.ok) throw error("TERMINAL_FIXTURE_SERVER_UNAVAILABLE")
    const text = await response.text()
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw error("TERMINAL_FIXTURE_HISTORY_TOO_LARGE")
    return JSON.parse(text) as unknown
  }
  const history = async () => {
    const value = await request(`/session/${encodeURIComponent(sessionId)}/message`)
    if (!Array.isArray(value) || value.some((item) => !record(item) || !record(item.info) || item.info.sessionID !== sessionId || !Array.isArray(item.parts))) throw error("TERMINAL_FIXTURE_HISTORY_SCOPE_MISMATCH")
    return value as { info: { id: string; sessionID: string; role: string; parentID?: string; agent?: string }; parts: { type: string; text?: string; tool?: string }[] }[]
  }
  try {
    const current = await request(`/session/${encodeURIComponent(sessionId)}`)
    if (!record(current) || current.id !== sessionId || current.directory !== directory) throw error("TERMINAL_FIXTURE_SESSION_SCOPE_MISMATCH")
    const before = await history()
    const existing = new Set(before.map((message) => message.info.id))
    const trialCalls = (messages: Awaited<ReturnType<typeof history>>) => messages.flatMap((message) => message.parts).filter((part) => part.type === "tool" && part.tool === "run_simulated_trial").length
    const env = physicalEnvironment(process.env, resolve(root))
    env.OPENCODE_SERVER_USERNAME = attachment.username
    env.OPENCODE_SERVER_PASSWORD = attachment.password
    const cli = resolve(import.meta.dir, "../../opencode/src/index.ts")
    // Upstream run preserves spaces within a positional argument by adding
    // literal quotes. Separate argv words yield the exact intended prompt.
    const child = spawn(process.execPath, [cli, "run", "--attach", attachment.url, "--dir", directory, "--session", sessionId, "--agent", "physical-systems", "--format", "json", ...prompt.split(" ")], { env, stdio: ["ignore", "pipe", "pipe"] })
    const chunks: Buffer[] = []
    let bytes = 0
    let oversized = false
    const collect = (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 1024 * 1024) { oversized = true; child.kill("SIGTERM"); return }
      chunks.push(chunk)
    }
    child.stdout.on("data", collect)
    // Errors are captured only for the byte budget, never printed or persisted.
    child.stderr.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1024 * 1024) { oversized = true; child.kill("SIGTERM") } })
    const abort = () => child.kill("SIGTERM")
    controller.signal.addEventListener("abort", abort, { once: true })
    const force = setTimeout(() => child.kill("SIGKILL"), 35_000)
    const code = await new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", () => reject(error("TERMINAL_FIXTURE_CLIENT_FAILED"))) }).finally(() => { clearTimeout(force); controller.signal.removeEventListener("abort", abort) })
    if (controller.signal.aborted || oversized || code !== 0) throw error("TERMINAL_FIXTURE_CLIENT_FAILED")
    const events = Buffer.concat(chunks).toString("utf8").split("\n").filter((line) => line.trim()).flatMap((line) => {
      try { const value: unknown = JSON.parse(line); return record(value) ? [value] : [] } catch { return [] }
    })
    if (!events.length || events.some((event) => event.type === "error" || event.sessionID !== sessionId)) throw error("TERMINAL_FIXTURE_EVENT_SCOPE_MISMATCH")
    const after = await history()
    const added = after.filter((message) => !existing.has(message.info.id))
    const submitted = added.filter((message) => message.info.role === "user" && message.info.agent === "physical-systems" && message.parts.some((part) => part.type === "text" && part.text === prompt))
    if (submitted.length !== 1 || !added.some((message) => message.info.role === "assistant" && message.info.parentID === submitted[0].info.id)) throw error("TERMINAL_FIXTURE_MESSAGE_NOT_RECORDED")
    if (trialCalls(after) !== trialCalls(before)) throw error("TERMINAL_FIXTURE_UNEXPECTED_TRIAL")
    return { result: "PASS", kind: "command-line-attachment", sessionId, checks: ["actual OpenCode CLI exited successfully", "one terminal prompt persisted in the desktop's exact server/session", "assistant reply persisted in that same session", "no additional synthetic trial calls"] }
  } finally { clearTimeout(deadline) }
}

if (import.meta.main) {
  const root = process.argv[2]
  if (!root) { console.log(JSON.stringify({ result: "FAIL", error: "ISOLATED_NATIVE_ROOT_REQUIRED" })); process.exitCode = 1 }
  else await terminalSmoke(root).then((result) => console.log(JSON.stringify(result)), (failure: unknown) => {
    const code = failure instanceof Error && /^TERMINAL_FIXTURE_[A-Z_]+$/.test(failure.message) ? failure.message : "TERMINAL_FIXTURE_FAILED"
    console.log(JSON.stringify({ result: "FAIL", error: code }))
    process.exitCode = 1
  })
}
