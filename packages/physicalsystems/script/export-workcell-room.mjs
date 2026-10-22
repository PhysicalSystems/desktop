// SPDX-License-Identifier: Apache-2.0
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises"
import { dirname, resolve, join } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const output = process.argv[2] && resolve(process.argv[2])
if (!output || output === root) throw new Error("Supply an explicit source-export directory")
const source = "packages/app/src/physicalsystems/rooms"
const names = ["types.ts", "copy.ts", "state.ts", "room.tsx", "mount.tsx", "room.css"]
await mkdir(output, { recursive: true })
const files = []
for (const name of names) {
  const input = join(root, source, name)
  const content = await readFile(input)
  await copyFile(input, join(output, name))
  files.push({ path: name, source: `${source}/${name}`, sha256: createHash("sha256").update(content).digest("hex") })
}
await copyFile(join(root, "packages/physicalsystems/LICENSE"), join(output, "LICENSE"))
await writeFile(
  join(output, "provenance.json"),
  JSON.stringify(
    {
      schemaVersion: 1,
      repository: "https://github.com/PhysicalSystems/desktop",
      revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      dirty: Boolean(
        execFileSync("git", ["status", "--porcelain", "--", source], { cwd: root, encoding: "utf8" }).trim(),
      ),
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
  "# Canonical Physical Systems workcell room\n\nReviewed source export from PhysicalSystems/desktop, used by its native app and Platform's existing console. `provenance.json` records the source revision and exact file hashes. `dirty: true` identifies a development snapshot, not an immutable release. Run the desktop export script after review to refresh it. Compile with SolidJS and vite-plugin-solid; do not apply React's JSX transform. No generated bundle is stored here.\n\n`mountWorkcellRoom(element, { workcellId, transport, theme, navigate, onPrepareTask })` returns `{ dispose, update }`. The host owns authentication. `transport.request(method, path, body?, signal?)` returns JSON and permits only the authenticated workcell endpoints. The module never receives or persists a token and has no generic agent, terminal, filesystem or robot-execution API. Messages are shared task updates, not generated assistant responses. `prepareTaskPrompt(room)` builds the common editable Assistant brief; `onPrepareTask` opens it through the existing host without sending it.\n",
)
console.log(JSON.stringify({ output, files: files.length }))
