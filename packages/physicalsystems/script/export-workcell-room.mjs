// SPDX-License-Identifier: Apache-2.0
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve, join, relative, isAbsolute, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
/** Export immutable Git blobs, never checkout bytes transformed by core.autocrlf. */
export async function exportWorkcellRoom({ root, output }) {
  root = resolve(root)
  output = resolve(output)
  const target = relative(root, output)
  if (!target || (target !== ".." && !target.startsWith(`..${sep}`) && !isAbsolute(target)))
    throw new Error("Supply a source-export directory outside the source repository")
  const source = "packages/app/src/physicalsystems/rooms"
  const licenseSource = "packages/physicalsystems/LICENSE"
  const names = ["types.ts", "copy.ts", "state.ts", "room.tsx", "mount.tsx", "room.css"]
  const git = (args) => execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] })
  const revision = git(["rev-parse", "--verify", "HEAD^{commit}"]).toString("utf8").trim()
  if (git(["status", "--porcelain", "--untracked-files=all", "--", source, licenseSource]).length)
    throw new Error("Commit the shared room source and license before exporting a pinned snapshot")
  // Resolve HEAD once. A concurrent branch update cannot mix revisions during export.
  const blobs = names.map((name) => ({ name, content: git(["show", `${revision}:${source}/${name}`]) }))
  const license = git(["show", `${revision}:${licenseSource}`])
  const files = blobs.map(({ name, content }) => ({
    path: name,
    source: `${source}/${name}`,
    sha256: createHash("sha256").update(content).digest("hex"),
  }))
  await mkdir(output, { recursive: true })
  for (const { name, content } of blobs) await writeFile(join(output, name), content)
  await writeFile(join(output, "LICENSE"), license)
  await writeFile(
    join(output, "provenance.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        repository: "https://github.com/PhysicalSystems/desktop",
        revision,
        dirty: false,
        sourceFormat: "git-blob",
        license: "Apache-2.0",
        entry: "mount.tsx",
        dependencies: { "solid-js": "^1.9.10" },
        files,
      },
      null,
      2,
    ) + "\n",
  )
  await writeFile(
    join(output, "README.md"),
    "# Canonical Physical Systems workcell room\n\nReviewed source export from PhysicalSystems/desktop, used by its native app and Platform's existing console. `provenance.json` records the immutable source revision and exact Git blob hashes. The exporter rejects uncommitted shared source and reads committed Git objects, so Windows checkout line endings cannot change the exported bytes. Preserve these bytes in the destination repository with a `-text` Git attribute for this directory. Run the desktop export script after committing reviewed source to refresh it. Compile with SolidJS and vite-plugin-solid; do not apply React's JSX transform. No generated bundle is stored here.\n\n`mountWorkcellRoom(element, { workcellId, transport, theme, navigate, onPrepareTask })` returns `{ dispose, update }`. The host owns authentication. `transport.request(method, path, body?, signal?)` returns JSON and permits only the authenticated workcell endpoints. The module never receives or persists a token and has no generic agent, terminal, filesystem or robot-execution API. Messages are shared task updates, not generated assistant responses. `prepareTaskPrompt(room)` builds the common editable Assistant brief; `onPrepareTask` opens it through the existing host without sending it.\n",
  )
  return { output, revision, files: files.length }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Supply an explicit source-export directory")
  const result = await exportWorkcellRoom({
    root: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
    output: process.argv[2],
  })
  console.log(JSON.stringify(result))
}
