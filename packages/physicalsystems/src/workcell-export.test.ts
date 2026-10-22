// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { join, relative, resolve } from "node:path"
import { tmpdir } from "node:os"
import { exportWorkcellRoom } from "../script/export-workcell-room.mjs"

const source = "packages/app/src/physicalsystems/rooms"
const names = ["types.ts", "copy.ts", "state.ts", "room.tsx", "mount.tsx", "room.css"]
const git = (root: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] })

async function fixture(run: (temporary: string, repository: string) => Promise<void>) {
  const temporary = await mkdtemp(join(tmpdir(), "physicalsystems-room-export-"))
  const repository = join(temporary, "source")
  try {
    await mkdir(join(repository, source), { recursive: true })
    await mkdir(join(repository, "packages/physicalsystems"), { recursive: true })
    for (const name of names) await writeFile(join(repository, source, name), `// ${name}\n// committed source\n`)
    await writeFile(join(repository, "packages/physicalsystems/LICENSE"), "Apache-2.0\n")
    git(repository, "init", "--quiet")
    git(repository, "config", "core.autocrlf", "false")
    git(repository, "add", "--", "packages")
    git(
      repository,
      "-c",
      "user.name=Export fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Fixture source",
    )
    await run(temporary, repository)
  } finally {
    const target = relative(resolve(tmpdir()), resolve(temporary))
    if (!target.startsWith("physicalsystems-room-export-") || target.includes(".."))
      throw new Error("Unsafe fixture cleanup target")
    await rm(temporary, { recursive: true, force: true })
  }
}

test("pinned exports are byte-identical from actual LF and CRLF Git checkouts", async () => {
  await fixture(async (temporary, repository) => {
    const lf = join(temporary, "lf")
    const crlf = join(temporary, "crlf")
    git(temporary, "clone", "--quiet", "--config", "core.autocrlf=false", repository, lf)
    git(temporary, "clone", "--quiet", "--config", "core.autocrlf=true", repository, crlf)
    expect((await readFile(join(lf, source, "types.ts"), "utf8")).includes("\r\n")).toBe(false)
    expect((await readFile(join(crlf, source, "types.ts"), "utf8")).includes("\r\n")).toBe(true)
    const outputs = [join(temporary, "lf-export"), join(temporary, "crlf-export")]
    await exportWorkcellRoom({ root: lf, output: outputs[0] })
    await exportWorkcellRoom({ root: crlf, output: outputs[1] })
    for (const name of [...names, "LICENSE", "README.md", "provenance.json"])
      expect(await readFile(join(outputs[0], name))).toEqual(await readFile(join(outputs[1], name)))
    const manifest = JSON.parse(await readFile(join(outputs[0], "provenance.json"), "utf8"))
    expect(manifest.revision).toBe(git(repository, "rev-parse", "HEAD").toString().trim())
    expect(manifest.dirty).toBe(false)
    expect(manifest.sourceFormat).toBe("git-blob")
    for (const file of manifest.files) {
      const bytes = git(repository, "show", `${manifest.revision}:${file.source}`)
      expect(await readFile(join(outputs[0], file.path))).toEqual(bytes)
      expect(file.sha256).toBe(createHash("sha256").update(bytes).digest("hex"))
    }
  })
}, 30000)

test("uncommitted shared source and license cannot be labelled as a pinned export", async () => {
  await fixture(async (temporary, repository) => {
    const output = join(temporary, "export")
    await writeFile(join(repository, source, "types.ts"), "// uncommitted edit\n")
    await expect(exportWorkcellRoom({ root: repository, output })).rejects.toThrow("Commit the shared room")
    git(repository, "restore", "--", `${source}/types.ts`)
    await writeFile(join(repository, "packages/physicalsystems/LICENSE"), "Changed license\n")
    await expect(exportWorkcellRoom({ root: repository, output })).rejects.toThrow("Commit the shared room")
    git(repository, "restore", "--", "packages/physicalsystems/LICENSE")
    await expect(exportWorkcellRoom({ root: repository, output: join(repository, "export") })).rejects.toThrow(
      "outside the source repository",
    )
  })
}, 30000)
