// SPDX-License-Identifier: Apache-2.0
import { resolve, join } from "node:path"
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { readAttachment } from "../src/attachment"
import { physicalEnvironment } from "../src/environment"

const root = process.argv[2]
if (!root) throw new Error("Usage: bun packages/physicalsystems/script/attach.ts <isolated-app-data-directory>")
const attachment = await readAttachment(join(resolve(root), "desktop", "runtime-attach.json"))
if (!attachment.directory || !attachment.sessionId) throw new Error("Select a bound Physical Systems conversation in the desktop first")
const url = new URL(`/api/session/${attachment.sessionId}`, attachment.url)
url.searchParams.set("location[directory]", attachment.directory)
const response = await fetch(url, {
  headers: { Authorization: `Basic ${Buffer.from(`${attachment.username}:${attachment.password}`).toString("base64")}` },
  redirect: "error",
  signal: AbortSignal.timeout(5000),
})
if (!response.ok) throw new Error("The selected desktop conversation is no longer available")
const session = (await response.json()).data
if (session?.id !== attachment.sessionId || session.location?.directory !== attachment.directory || session.agent !== "physical-systems")
  throw new Error("The selected desktop conversation no longer matches its attachment")
const env = physicalEnvironment(process.env, resolve(root))
if (attachment.username !== "opencode") throw new Error("Unsupported desktop attachment identity")
env.OPENCODE_PASSWORD = attachment.password
const cli = resolve(import.meta.dir, "../../cli/src/index.ts")
const preload = createRequire(cli).resolve("@opentui/solid/preload")
const child = spawn(process.execPath, ["--preload", preload, cli, "--server", attachment.url, "--session", attachment.sessionId, attachment.directory], { env, stdio: "inherit" })
child.on("exit", (code) => { process.exitCode = code ?? 1 })
