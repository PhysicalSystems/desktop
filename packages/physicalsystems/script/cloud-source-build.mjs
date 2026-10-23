// SPDX-License-Identifier: Apache-2.0
import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { parsePatch, applyPatch, reversePatch } from "diff"
const root = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(await readFile(resolve(root, "provenance.json"), "utf8"))
for (const file of manifest.files) {
  if (!file.path || file.path.includes("..") || file.path.startsWith("/") || file.path.includes("\\"))
    throw new Error("Unsafe source manifest")
  const bytes = await readFile(resolve(root, file.path))
  if (createHash("sha256").update(bytes).digest("hex") !== file.sha256)
    throw new Error(`Source checksum mismatch: ${file.path}`)
}
// Preserve the reviewed browser dependency patches with npm as well as Bun.
const source = JSON.parse(await readFile(resolve(root, "source-package.json"), "utf8"))
const dependencies = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")).dependencies
for (const name of ["solid-js", "@corvu/drawer", "vite"]) {
  const version = dependencies[name]
  const directory = resolve(root, "node_modules", name)
  const patchPath = source.patchedDependencies[`${name}@${version}`]
  if (!patchPath || !manifest.files.some((file) => file.path === patchPath))
    throw new Error("Missing canonical browser patch")
  if (JSON.parse(await readFile(resolve(directory, "package.json"), "utf8")).version !== version)
    throw new Error("Unexpected browser dependency version")
  for (const patch of parsePatch(await readFile(resolve(root, patchPath), "utf8"))) {
    const path = patch.newFileName?.replace(/^b\//, "")
    if (!path || !path.startsWith("dist/") || path.includes("..") || path.includes("\\"))
      throw new Error("Unexpected browser patch target")
    const target = resolve(directory, path)
    const previous = await readFile(target, "utf8")
    const next = applyPatch(previous, patch)
    if (next !== false) {
      await writeFile(target, next)
      continue
    }
    if (applyPatch(previous, reversePatch(patch)) === false)
      throw new Error("Browser patch does not match the pinned dependency")
  }
}
const output = process.argv[2] ? resolve(process.argv[2]) : resolve(root, "dist")
// Tailwind resolves CSS package exports independently from Vite's JS resolver.
// Link only these immutable browser packages after npm installs external dependencies.
await mkdir(resolve(root, "node_modules/@opencode"), { recursive: true })
for (const name of ["ui", "session-ui"]) {
  const source = resolve(root, "packages", name)
  const link = resolve(root, "node_modules/@opencode", name)
  const existing = await realpath(link).catch((error) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (existing && existing !== (await realpath(source))) throw new Error("Unexpected browser source link")
  if (!existing) await symlink(source, link, process.platform === "win32" ? "junction" : "dir")
}
const { build } = await import("vite")
await build({ configFile: resolve(root, "vite.config.mjs"), build: { outDir: output, emptyOutDir: false } })
