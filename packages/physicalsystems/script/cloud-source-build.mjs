// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { parsePatch, applyPatch, reversePatch } from "diff"
import { build } from "vite"
const root = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(await readFile(resolve(root, "provenance.json"), "utf8"))
for (const file of manifest.files) {
  if (!file.path || file.path.includes("..") || file.path.startsWith("/") || file.path.includes("\\"))
    throw new Error("Unsafe source manifest")
  const bytes = await readFile(resolve(root, file.path))
  if (createHash("sha256").update(bytes).digest("hex") !== file.sha256)
    throw new Error(`Source checksum mismatch: ${file.path}`)
}
// Preserve the canonical Solid fixes with npm as well as Bun; never patch unrelated packages.
const solid = resolve(root, "node_modules/solid-js")
if (JSON.parse(await readFile(resolve(solid, "package.json"), "utf8")).version !== "1.9.10")
  throw new Error("Unexpected Solid version")
for (const patch of parsePatch(await readFile(resolve(root, "patches/solid-js@1.9.10.patch"), "utf8"))) {
  const path = patch.newFileName?.replace(/^b\//, "")
  if (!path || !/^dist\/(?:dev|server|solid)\.(?:js|cjs)$/.test(path)) throw new Error("Unexpected Solid patch target")
  const target = resolve(solid, path)
  const previous = await readFile(target, "utf8")
  const next = applyPatch(previous, patch)
  if (next !== false) {
    await writeFile(target, next)
    continue
  }
  if (applyPatch(previous, reversePatch(patch)) === false)
    throw new Error("Solid patch does not match the pinned dependency")
}
const output = process.argv[2] ? resolve(process.argv[2]) : resolve(root, "dist")
await build({ configFile: resolve(root, "vite.config.mjs"), build: { outDir: output, emptyOutDir: false } })
