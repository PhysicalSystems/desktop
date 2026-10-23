// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { join, relative, resolve, dirname } from "node:path"
import { tmpdir } from "node:os"
import { exportCloudConversation } from "../script/export-cloud-conversation.mjs"

const git = (root: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] })
test("source export pins canonical blobs, preserves licenses, and rejects dirty or reused destinations", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "physicalsystems-cloud-export-"))
  const root = join(temporary, "source")
  const canonical = resolve(import.meta.dir, "../../..")
  const files = [
    "package.json",
    "packages/ui/package.json",
    "packages/session-ui/package.json",
    "packages/ui/LICENSE",
    "LICENSE",
    "packages/physicalsystems/LICENSE",
    ...["path", "encode", "binary"].map((name) => `packages/core/src/util/${name}.ts`),
    ...["types", "state", "copy"].map((name) => `packages/app/src/physicalsystems/rooms/${name}.ts`),
    ...["session", "session-title", "session-message"].map((name) => `packages/app/src/utils/${name}.ts`),
    "packages/app/cloud-conversation.html",
    "packages/app/src/physicalsystems/cloud/types.ts",
    "patches/solid-js@1.9.10.patch",
    "packages/physicalsystems/script/cloud-source.vite.mjs",
    "packages/physicalsystems/script/cloud-source-build.mjs",
    "packages/physicalsystems/script/export-cloud-conversation.mjs",
  ]
  try {
    for (const path of files) {
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(join(root, path), await readFile(join(canonical, path)))
    }
    await mkdir(join(root, "packages/ui/src"), { recursive: true })
    await writeFile(
      join(root, "packages/ui/src/fixture.tsx"),
      "export const fixture = () => <p>canonical fixture</p>\n",
    )
    git(root, "init", "--quiet")
    git(root, "-c", "core.autocrlf=false", "add", "--", ".")
    git(
      root,
      "-c",
      "user.name=Export fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Canonical source fixture",
    )
    const output = join(temporary, "export")
    const result = await exportCloudConversation({ root, output })
    const manifest = JSON.parse(await readFile(join(output, "provenance.json"), "utf8"))
    expect(manifest.revision).toBe(result.revision)
    expect(manifest.dirty).toBe(false)
    expect(manifest.sourceFormat).toBe("git-blob")
    expect(manifest.license).toBe("MIT AND Apache-2.0")
    for (const file of manifest.files) {
      const bytes = await readFile(join(output, file.path))
      expect(file.sha256).toBe(createHash("sha256").update(bytes).digest("hex"))
      if (file.source) expect(bytes).toEqual(git(root, "show", `${manifest.revision}:${file.source}`))
    }
    const pkg = JSON.parse(await readFile(join(output, "package.json"), "utf8"))
    expect(pkg.dependencies["solid-js"]).toBe("1.9.10")
    expect(Object.keys(pkg.dependencies).some((name) => name.startsWith("@opencode-ai/"))).toBe(false)
    expect(Object.values(pkg.dependencies).every((version) => /^\d+\.\d+\.\d+/.test(String(version)))).toBe(true)
    expect(await readFile(join(output, "packages/app/index.html"), "utf8")).toContain('id="app"')
    await expect(exportCloudConversation({ root, output })).rejects.toThrow("new export directory")
    await expect(exportCloudConversation({ root, output: join(root, "export") })).rejects.toThrow("outside the source")
    await writeFile(join(root, "packages/ui/src/fixture.tsx"), "// dirty source")
    await expect(exportCloudConversation({ root, output: join(temporary, "dirty") })).rejects.toThrow(
      "Commit the canonical",
    )
  } finally {
    const target = relative(resolve(tmpdir()), resolve(temporary))
    if (!target.startsWith("physicalsystems-cloud-export-") || target.includes(".."))
      throw new Error("Unsafe fixture cleanup")
    await rm(temporary, { recursive: true, force: true })
  }
}, 30000)
