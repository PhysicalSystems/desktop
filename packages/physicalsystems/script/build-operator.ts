// SPDX-License-Identifier: Apache-2.0
import { cp, readFile, writeFile, readdir } from "node:fs/promises"
import { resolve, join, dirname, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { replaceArtifactDirectory } from "../src/artifact-staging"

const source = resolve(process.argv[2] || "")
if (!process.argv[2]) throw new Error("Pass the canonical Physical Systems source checkout")
const output = resolve(dirname(fileURLToPath(import.meta.url)), "../vendor")
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const git = (...args: string[]) => execFileSync("git", args, { cwd: source, encoding: "utf8" }).trim()
const count = await replaceArtifactDirectory(output, async (staging) => {
  const build = await Bun.build({ entrypoints: [join(source, "packages/operator-service/src/index.js")], target: "node", format: "esm", outdir: staging, naming: "operator-service.mjs", sourcemap: "none", metafile: true })
  if (!build.success) throw new AggregateError(build.logs, "Operator build failed")
  const inputs = Object.keys(build.metafile?.inputs || {})
  if (inputs.some((file) => /node_modules|pi-coding-agent|pi-ai|electron|\/private\//.test(file))) throw new Error("Unexpected operator dependency graph")
  const files: Record<string, string> = {}
  for (const file of inputs.sort()) files[relative(source, resolve(file))] = sha(await readFile(file))
  await cp(join(source, "packages/cli/src/harness/skills"), join(staging, "skills"), { recursive: true })
  for (const name of ["LICENSE", "NOTICE"]) await cp(join(source, name), join(staging, name))
  const artifacts: Record<string, string> = {}
  async function inventory(folder: string) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) await inventory(path)
      else if (entry.name !== "manifest.json") artifacts[relative(staging, path)] = sha(await readFile(path))
    }
  }
  await inventory(staging)
  await writeFile(join(staging, "manifest.json"), JSON.stringify({ schemaVersion: 1, repository: "https://github.com/PhysicalSystems/physicalsystems", revision: git("rev-parse", "HEAD"), dirty: Boolean(git("status", "--porcelain")), sourceFiles: files, artifacts }, null, 2) + "\n")
  return inputs.length
})
console.log(`Bundled ${count} canonical files into ${output}; no agent SDK dependencies`)
