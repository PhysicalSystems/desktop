// SPDX-License-Identifier: Apache-2.0
import { resolve, join } from "node:path"
import { spawn } from "node:child_process"
import { readAttachment } from "../src/attachment"
import { physicalEnvironment } from "../src/environment"

const root = process.argv[2]
if (!root) throw new Error("Usage: bun packages/physicalsystems/script/attach.ts <isolated-app-data-directory>")
const attachment = await readAttachment(join(resolve(root), "desktop", "runtime-attach.json"))
if (!attachment.directory || !attachment.sessionId) throw new Error("Select a bound Physical Systems conversation in the desktop first")
const env = physicalEnvironment(process.env, resolve(root))
env.OPENCODE_SERVER_USERNAME = attachment.username
env.OPENCODE_SERVER_PASSWORD = attachment.password
const cli = resolve(import.meta.dir, "../../opencode/src/index.ts")
const child = spawn(process.execPath, [cli, "attach", attachment.url, "--dir", attachment.directory, "--session", attachment.sessionId], { env, stdio: "inherit" })
child.on("exit", (code) => { process.exitCode = code ?? 1 })
