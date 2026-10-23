// SPDX-License-Identifier: Apache-2.0
import { mkdir, writeFile, stat } from "node:fs/promises"
import { dirname, resolve, join, relative, isAbsolute, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"

const scopes = [
  "packages/ui/src",
  "packages/ui/package.json",
  "packages/ui/LICENSE",
  "packages/session-ui/src",
  "packages/session-ui/package.json",
  "packages/core/src/util/path.ts",
  "packages/core/src/util/encode.ts",
  "packages/core/src/util/binary.ts",
  "packages/app/src/physicalsystems/cloud",
  "packages/app/src/physicalsystems/rooms/types.ts",
  "packages/app/src/physicalsystems/rooms/state.ts",
  "packages/app/src/physicalsystems/rooms/copy.ts",
  "packages/app/src/utils/session.ts",
  "packages/app/src/utils/session-title.ts",
  "packages/app/src/utils/session-message.ts",
  "packages/app/cloud-conversation.html",
  "packages/physicalsystems/LICENSE",
  "LICENSE",
  "package.json",
  "bun.lock",
  "patches/solid-js@1.9.10.patch",
  "packages/physicalsystems/script/cloud-source.vite.mjs",
  "packages/physicalsystems/script/cloud-source-build.mjs",
  "packages/physicalsystems/script/export-cloud-conversation.mjs",
]

/** Source-only export. All canonical files come from one committed Git object graph. */
export async function exportCloudConversation({ root, output }) {
  root = resolve(root)
  output = resolve(output)
  const destination = relative(root, output)
  if (!destination || (destination !== ".." && !destination.startsWith(`..${sep}`) && !isAbsolute(destination)))
    throw new Error("Supply an export directory outside the source repository")
  if (
    await stat(output).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false
        throw error
      },
    )
  )
    throw new Error("Use a new export directory to prevent stale source files")
  const git = (args, input) =>
    execFileSync("git", args, { cwd: root, input, maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] })
  const revision = git(["rev-parse", "--verify", "HEAD^{commit}"]).toString("utf8").trim()
  if (git(["status", "--porcelain", "--untracked-files=all", "--", ...scopes]).length)
    throw new Error("Commit the canonical conversation source and export tooling before exporting")
  const paths = git(["ls-tree", "-r", "--name-only", revision, "--", ...scopes])
    .toString("utf8")
    .trim()
    .split("\n")
    .filter((path) => path && !/\.(?:test|stories)\.[^.]+$/.test(path) && !path.endsWith(".md"))
  for (const required of scopes.filter((path) => /\.[^/]+$/.test(path) || /(?:^|\/)LICENSE$/.test(path)))
    if (!paths.includes(required)) throw new Error(`Missing canonical source: ${required}`)
  // Batch immutable blobs rather than reading transformed Windows checkout bytes.
  const batch = git(["cat-file", "--batch"], paths.map((path) => `${revision}:${path}\n`).join(""))
  let offset = 0
  const blobs = new Map(
    paths.map((path) => {
      const end = batch.indexOf(10, offset)
      const header = batch.subarray(offset, end).toString("utf8")
      const size = Number(header.split(" ")[2])
      if (!header.includes(" blob ") || !Number.isSafeInteger(size)) throw new Error("Invalid Git source blob")
      const content = batch.subarray(end + 1, end + 1 + size)
      offset = end + 2 + size
      return [path, content]
    }),
  )
  const original = JSON.parse(blobs.get("package.json"))
  const lock = blobs.get("bun.lock").toString("utf8")
  const compilerPins = Object.fromEntries(
    ["babel-preset-solid", "babel-plugin-jsx-dom-expressions"].map((name) => {
      const version = lock.match(new RegExp(`^\\s*"${name}": \\["${name}@([^"\\s]+)"`, "m"))?.[1]
      if (!version) throw new Error(`Missing canonical compiler pin: ${name}`)
      return [name, version]
    }),
  )
  const manifests = ["ui", "session-ui"].map((name) => JSON.parse(blobs.get(`packages/${name}/package.json`)))
  const dependencies = Object.fromEntries(
    Object.entries({
      ...manifests[0].dependencies,
      ...manifests[1].dependencies,
      ...compilerPins,
      effect: "catalog:",
      "@tailwindcss/vite": "catalog:",
      tailwindcss: "catalog:",
      vite: "catalog:",
      "vite-plugin-solid": "catalog:",
      "tw-animate-css": "1.4.0",
      "@solidjs/meta": "catalog:",
    })
      .filter(([name]) => !name.startsWith("@opencode-ai/"))
      .map(([name, version]) => {
        const pinned = version === "catalog:" ? original.workspaces.catalog[name] : version
        if (typeof pinned !== "string" || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(pinned))
          throw new Error(`Unpinned browser dependency: ${name}`)
        return [name, pinned]
      }),
  )
  const renames = {
    "package.json": "source-package.json",
    "bun.lock": "source-bun.lock",
    "packages/app/cloud-conversation.html": "packages/app/index.html",
    "packages/physicalsystems/script/cloud-source.vite.mjs": "vite.config.mjs",
    "packages/physicalsystems/script/cloud-source-build.mjs": "build.mjs",
  }
  const files = []
  await mkdir(output, { recursive: false })
  const save = async (path, content, source) => {
    await mkdir(dirname(join(output, path)), { recursive: true })
    await writeFile(join(output, path), content)
    files.push({
      path,
      ...(source ? { source } : { generated: true }),
      sha256: createHash("sha256").update(content).digest("hex"),
    })
  }
  for (const [source, content] of blobs) await save(renames[source] ?? source, content, source)
  await save(
    "package.json",
    JSON.stringify(
      {
        name: "@physicalsystems/cloud-conversation-source",
        private: true,
        type: "module",
        version: "0.0.0",
        license: "MIT AND Apache-2.0",
        engines: { node: ">=22" },
        scripts: { build: "node build.mjs" },
        dependencies,
        // Bun's canonical lock uses this compiler with the patched Solid version.
        // Keep the same pair in npm rather than silently selecting another runtime.
        overrides: { "babel-preset-solid": { "solid-js": "$solid-js" } },
      },
      null,
      2,
    ) + "\n",
  )
  await writeFile(
    join(output, "provenance.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        repository: "https://github.com/PhysicalSystems/desktop",
        revision,
        dirty: false,
        sourceFormat: "git-blob",
        license: "MIT AND Apache-2.0",
        entry: "packages/app/index.html",
        generatedDescriptor:
          "package.json is derived from the recorded source-package.json catalog and canonical UI dependency manifests; no source implementation is rewritten.",
        files,
      },
      null,
      2,
    ) + "\n",
  )
  await writeFile(
    join(output, "README.md"),
    "# Physical Systems cloud conversation source\n\nPinned canonical source from PhysicalSystems/desktop. Source files are immutable Git blobs, with checksums and their original paths in provenance.json. Keep these bytes with a -text Git attribute. Do not edit this copy; refresh it with export-cloud-conversation.mjs after a reviewed desktop commit. This package includes the existing SessionTurn, PromptInputV2 and session projection, not a second chat engine.\n\nGenerate and review package-lock.json once with npm install --package-lock-only --ignore-scripts; thereafter use npm ci --ignore-scripts and npm run build -- /absolute/output/path. The build verifies every exported source hash and applies the canonical pinned Solid patch before Vite compiles the isolated frame. Commit only source, provenance and the dependency lock; generated output belongs in deployment artifacts.\n\nServe the output at /physicalsystems-conversation/ on the authenticated host origin. index.html contains #app and exposes window.physicalSystemsCloudConversation.mount(element, options). The host supplies an account-keyed scoped transport and disposes the mount on authentication changes. No credential, server URL, directory, provider or model selection is accepted by the frame. Native uses the identical CloudConversation source directly.\n",
  )
  return {
    output,
    revision,
    files: files.length,
    bytes: [...blobs.values()].reduce((sum, bytes) => sum + bytes.length, 0),
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Supply an explicit new source-export directory")
  console.log(
    JSON.stringify(
      await exportCloudConversation({
        root: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
        output: process.argv[2],
      }),
    ),
  )
}
