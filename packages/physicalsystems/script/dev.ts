// SPDX-License-Identifier: Apache-2.0
import { resolve, join } from "node:path"
import { readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"

const data = process.argv[2]
if (!data) throw new Error("Usage: bun packages/physicalsystems/script/dev.ts <isolated-app-data-directory>")
const repository = resolve(import.meta.dir, "../../..")
const artifact = join(repository, "packages/physicalsystems/vendor")
const manifest = JSON.parse(await readFile(join(artifact, "manifest.json"), "utf8"))
for (const [file, expected] of Object.entries(manifest.artifacts)) {
  const actual = createHash("sha256").update(await readFile(join(artifact, file))).digest("hex")
  if (actual !== expected) throw new Error("OPERATOR_ARTIFACT_INTEGRITY_MISMATCH")
}
const directory = join(repository, "packages/desktop")
const binary = process.platform === "win32" ? "electron.exe" : process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : "electron"
const child = spawn(join(directory, "node_modules/electron/dist", binary), [".", ...process.argv.slice(3)], { cwd: directory, stdio: "inherit",
  env: { ...process.env, PHYSICALSYSTEMS_DATA_DIR: resolve(data), PHYSICALSYSTEMS_ALLOW_DEVICES: "0" } })
child.on("exit", (code) => { process.exitCode = code ?? 1 })
