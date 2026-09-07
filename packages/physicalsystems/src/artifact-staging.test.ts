// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { replaceArtifactDirectory } from "./artifact-staging"

const folders: string[] = []
afterEach(async () => { await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "physical-artifacts-"))
  folders.push(root)
  const output = join(root, "vendor")
  await mkdir(output)
  await writeFile(join(output, "old.mjs"), "previous build")
  return { root, output }
}

test("successful replacement publishes only this build, excluding removed artifacts", async () => {
  const { root, output } = await fixture()
  const result = await replaceArtifactDirectory(output, async (staging) => {
    expect(await readdir(staging)).toEqual([])
    await writeFile(join(staging, "operator.mjs"), "new build")
    return "new manifest"
  })
  expect(result).toBe("new manifest")
  expect(await readdir(output)).toEqual(["operator.mjs"])
  expect(await readFile(join(output, "operator.mjs"), "utf8")).toBe("new build")
  expect(await readdir(root)).toEqual(["vendor"])
})

test("a failed build leaves the existing usable bundle intact and removes partial output", async () => {
  const { root, output } = await fixture()
  await expect(replaceArtifactDirectory(output, async (staging) => {
    await writeFile(join(staging, "half-built.mjs"), "incomplete")
    throw new Error("Build rejected dependencies")
  })).rejects.toThrow("Build rejected dependencies")
  expect(await readFile(join(output, "old.mjs"), "utf8")).toBe("previous build")
  expect(await readdir(root)).toEqual(["vendor"])
})

test("failed publication restores the previous bundle", async () => {
  const { root, output } = await fixture()
  await expect(replaceArtifactDirectory(output,
    async (staging) => { await writeFile(join(staging, "new.mjs"), "new build") },
    async (from, to) => {
      if (basename(String(from)) === "next") throw new Error("Output rename failed")
      await rename(from, to)
    },
  )).rejects.toThrow("Output rename failed")
  expect(await readdir(output)).toEqual(["old.mjs"])
  expect(await readFile(join(output, "old.mjs"), "utf8")).toBe("previous build")
  expect(await readdir(root)).toEqual(["vendor"])
})

test("if rollback also fails the previous bundle is retained for recovery", async () => {
  const { root, output } = await fixture()
  await expect(replaceArtifactDirectory(output,
    async (staging) => { await writeFile(join(staging, "new.mjs"), "new build") },
    async (from, to) => {
      if (String(to) === output) throw new Error("Output unavailable")
      await rename(from, to)
    },
  )).rejects.toThrow("recover the previous directory")
  const [transaction] = await readdir(root)
  expect(transaction).toStartWith(".vendor-build-")
  expect(await readFile(join(root, transaction!, "previous", "old.mjs"), "utf8")).toBe("previous build")
})

test("an output symlink is rejected without touching the external bundle", async () => {
  const { root, output } = await fixture()
  const linked = join(root, "linked")
  await symlink(output, linked, "dir")
  let invoked = false
  await expect(replaceArtifactDirectory(linked, async () => { invoked = true })).rejects.toThrow("real directory")
  expect(invoked).toBe(false)
  expect(await readFile(join(output, "old.mjs"), "utf8")).toBe("previous build")
})
