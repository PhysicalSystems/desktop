// SPDX-License-Identifier: Apache-2.0
// Called only by the isolated native fixture while its own desktop is alive.
import { spawn } from "node:child_process"
import { join, resolve } from "node:path"
import { createRequire } from "node:module"
import { readAttachment } from "../src/attachment"
import { physicalEnvironment } from "../src/environment"
import { v2AgentState } from "../src/v2-agent"

const prompt = "Confirm the recorded synthetic result from this attached terminal."
const error = (code: string) => new Error(code)
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)

export async function terminalSmoke(root: string, options: { executable?: string } = {}) {
  const attachment = await readAttachment(join(resolve(root), "desktop", "runtime-attach.json"))
  if (!attachment.directory || !attachment.sessionId) throw error("TERMINAL_FIXTURE_SESSION_REQUIRED")
  const sessionId = attachment.sessionId
  const directory = attachment.directory
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), 40_000)
  const headers = {
    Authorization: `Basic ${Buffer.from(`${attachment.username}:${attachment.password}`).toString("base64")}`,
  }
  const request = async (route: string) => {
    const url = new URL(route, attachment.url)
    url.searchParams.set("location[directory]", directory)
    const response = await fetch(url, {
      headers,
      redirect: "error",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2500)]),
    })
    if (!response.ok) throw error("TERMINAL_FIXTURE_SERVER_UNAVAILABLE")
    const text = await response.text()
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw error("TERMINAL_FIXTURE_HISTORY_TOO_LARGE")
    return JSON.parse(text) as unknown
  }
  const history = async () => {
    const value = await request(`/api/session/${encodeURIComponent(sessionId)}/message`)
    if (
      !record(value) ||
      !Array.isArray(value.data) ||
      value.data.some(
        (item) =>
          !record(item) ||
          typeof item.id !== "string" ||
          !item.id.startsWith("msg_") ||
          typeof item.type !== "string" ||
          !record(item.time) ||
          typeof item.time.created !== "number" ||
          !Number.isFinite(item.time.created) ||
          (item.type === "assistant" && (!Array.isArray(item.content) || item.content.some((part) => !record(part)))),
      )
    )
      throw error("TERMINAL_FIXTURE_HISTORY_SCOPE_MISMATCH")
    return value.data as {
      id: string
      type: string
      agent?: string
      text?: string
      files?: unknown[]
      agents?: unknown[]
      skills?: unknown[]
      time: { created: number }
      content?: { type: string; text?: string; name?: string }[]
    }[]
  }
  const session = async () => {
    const value = await request(`/api/session/${encodeURIComponent(sessionId)}`)
    const current = record(value) && record(value.data) ? value.data : undefined
    if (
      !current ||
      current.id !== sessionId ||
      !record(current.location) ||
      current.location.directory !== directory ||
      current.location.workspaceID !== undefined ||
      current.agent !== "physical-systems"
    )
      throw error("TERMINAL_FIXTURE_SESSION_SCOPE_MISMATCH")
    if (v2AgentState(await request("/api/session/active"), sessionId).busy) throw error("TERMINAL_FIXTURE_SESSION_BUSY")
  }
  try {
    await session()
    const before = await history()
    const existing = new Set(before.map((message) => message.id))
    const trialCalls = (messages: Awaited<ReturnType<typeof history>>) =>
      messages
        .flatMap((message) => message.content || [])
        .filter((part) => part.type === "tool" && part.name === "run_simulated_trial").length
    const env = physicalEnvironment(process.env, resolve(root))
    env.OPENCODE_PASSWORD = attachment.password
    env.PWD = directory
    const cli = resolve(import.meta.dir, "../../cli/src/index.ts")
    // Upstream run preserves spaces within a positional argument by adding
    // literal quotes. Separate argv words yield the exact intended prompt.
    const args = [
      "run",
      "--server",
      attachment.url,
      "--session",
      sessionId,
      "--agent",
      "physical-systems",
      "--format",
      "json",
      ...prompt.split(" "),
    ]
    const launch = options.executable
      ? args
      : ["--preload", createRequire(cli).resolve("@opentui/solid/preload"), cli, ...args]
    const child = spawn(options.executable || process.execPath, launch, {
      cwd: directory,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    const chunks: Buffer[] = []
    let bytes = 0
    let oversized = false
    const collect = (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 1024 * 1024) {
        oversized = true
        child.kill("SIGTERM")
        return
      }
      chunks.push(chunk)
    }
    child.stdout.on("data", collect)
    // Errors are captured only for the byte budget, never printed or persisted.
    child.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 1024 * 1024) {
        oversized = true
        child.kill("SIGTERM")
      }
    })
    const abort = () => child.kill("SIGTERM")
    controller.signal.addEventListener("abort", abort, { once: true })
    const force = setTimeout(() => child.kill("SIGKILL"), 35_000)
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("close", resolve)
      child.once("error", () => reject(error("TERMINAL_FIXTURE_CLIENT_FAILED")))
    }).finally(() => {
      clearTimeout(force)
      controller.signal.removeEventListener("abort", abort)
    })
    if (controller.signal.aborted || oversized || code !== 0) throw error("TERMINAL_FIXTURE_CLIENT_FAILED")
    const events = Buffer.concat(chunks)
      .toString("utf8")
      .split("\n")
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          const value: unknown = JSON.parse(line)
          return record(value) ? [value] : []
        } catch {
          return []
        }
      })
    if (!events.length || events.some((event) => event.type === "error" || event.sessionID !== sessionId))
      throw error("TERMINAL_FIXTURE_EVENT_SCOPE_MISMATCH")
    await session()
    const after = await history()
    const added = after.filter((message) => !existing.has(message.id))
    const submitted = added.filter((message) => message.type === "user")
    const user = submitted[0]
    if (
      submitted.length !== 1 ||
      user.text !== prompt ||
      [user.files, user.agents, user.skills].some(
        (value) => value !== undefined && (!Array.isArray(value) || value.length),
      )
    )
      throw error("TERMINAL_FIXTURE_MESSAGE_NOT_RECORDED")
    // V2 messages have no legacy parentID. Match the CLI's emitted text part to
    // an actual new assistant record following the one exact persisted prompt.
    if (
      !added.some(
        (message) =>
          message.type === "assistant" &&
          message.agent === "physical-systems" &&
          message.time.created >= user.time.created &&
          events.some((event) => {
            const emitted = event.part
            return (
              event.type === "text" &&
              record(emitted) &&
              emitted.messageID === message.id &&
              message.content?.some((part) => part.type === "text" && part.text === emitted.text)
            )
          }),
      )
    )
      throw error("TERMINAL_FIXTURE_MESSAGE_NOT_RECORDED")
    if (trialCalls(after) !== trialCalls(before)) throw error("TERMINAL_FIXTURE_UNEXPECTED_TRIAL")
    return {
      result: "PASS",
      kind: "command-line-attachment",
      sessionId,
      checks: [
        "actual OpenCode CLI exited successfully",
        "one terminal prompt persisted in the desktop's exact server/session",
        "assistant reply persisted in that same session",
        "no additional synthetic trial calls",
      ],
    }
  } finally {
    clearTimeout(deadline)
  }
}

if (import.meta.main) {
  const root = process.argv[2]
  if (!root) {
    console.log(JSON.stringify({ result: "FAIL", error: "ISOLATED_NATIVE_ROOT_REQUIRED" }))
    process.exitCode = 1
  } else
    await terminalSmoke(root).then(
      (result) => console.log(JSON.stringify(result)),
      (failure: unknown) => {
        const code =
          failure instanceof Error && /^TERMINAL_FIXTURE_[A-Z_]+$/.test(failure.message)
            ? failure.message
            : "TERMINAL_FIXTURE_FAILED"
        console.log(JSON.stringify({ result: "FAIL", error: code }))
        process.exitCode = 1
      },
    )
}
