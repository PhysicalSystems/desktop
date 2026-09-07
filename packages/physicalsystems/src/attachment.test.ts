// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm, symlink, chmod, stat } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { readAttachment, saveAttachment } from "./attachment"
import type { DesktopAttachment } from "./attachment"

const folders: string[] = []
const value: DesktopAttachment = { schemaVersion: 1, url: "http://127.0.0.1:43129", username: "opencode", password: "fixture-private-server-password-123456", pid: process.pid, directory: "/fixture/project", sessionId: "ses_fixture" }
async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), "physical-attachment-test-"))
  folders.push(folder)
  return { folder, file: join(folder, "runtime-attach.json") }
}
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }) })

test("private attachment preserves exact session and directory without retaining the previous project selection", async () => {
  const target = await fixture()
  await saveAttachment(target.file, value)
  expect(await readAttachment(target.file)).toEqual(value)
  if (process.platform !== "win32") expect((await stat(target.file)).mode & 0o777).toBe(0o600)
  const selected = { ...value, directory: "/fixture/other-project", sessionId: undefined }
  await saveAttachment(target.file, selected)
  expect(await readAttachment(target.file)).toEqual({ ...selected, sessionId: undefined })
  expect(await readdir(target.folder)).toEqual(["runtime-attach.json"])
})

test("attachment rejects malformed session/directory, process groups and unsafe endpoints before overwriting saved state", async () => {
  const target = await fixture()
  await saveAttachment(target.file, value)
  const before = await readFile(target.file)
  for (const change of [
    { pid: 0 }, { pid: -1 }, { sessionId: [] }, { sessionId: "not-a-session" }, { sessionId: "ses_fixture", directory: undefined },
    { directory: "relative" }, { directory: "/fixture\0path" }, { url: "http://127.0.0.1:99999" }, { url: "http://127.0.0.1:0" },
    { url: "http://127.0.0.1:43129/path" }, { url: "http://other.invalid:43129" }, { url: "http://user:secret@127.0.0.1:43129" },
    { password: "short" }, { password: "a".repeat(513) }, { approval: true },
  ]) {
    await expect(saveAttachment(target.file, { ...value, ...change } as DesktopAttachment)).rejects.toThrow("INVALID_DESKTOP_ATTACHMENT")
    expect(await readFile(target.file)).toEqual(before)
  }
})

test("attachment files must be regular, private and bounded; symbolic links are rejected", async () => {
  const target = await fixture()
  await saveAttachment(target.file, value)
  await symlink(target.file, join(target.folder, "linked.json"))
  await expect(readAttachment(join(target.folder, "linked.json"))).rejects.toThrow("INVALID_DESKTOP_ATTACHMENT")
  if (process.platform !== "win32") {
    await chmod(target.file, 0o644)
    await expect(readAttachment(target.file)).rejects.toThrow("INVALID_DESKTOP_ATTACHMENT")
    await chmod(target.file, 0o600)
  }
  await writeFile(target.file, "x".repeat(16385))
  await expect(readAttachment(target.file)).rejects.toThrow("INVALID_DESKTOP_ATTACHMENT")
  await writeFile(target.file, JSON.stringify({ ...value, pid: 0 }))
  await expect(readAttachment(target.file)).rejects.toThrow("INVALID_DESKTOP_ATTACHMENT")
})

test("a terminated owned fixture process leaves an unusable attachment without deleting evidence", async () => {
  const target = await fixture()
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject) })
  try {
    await saveAttachment(target.file, { ...value, pid: child.pid! })
    expect((await readAttachment(target.file)).pid).toBe(child.pid!)
  } finally { child.kill("SIGTERM"); await exited }
  await expect(readAttachment(target.file)).rejects.toThrow("PROCESS_UNAVAILABLE")
  expect(JSON.parse(await readFile(target.file, "utf8")).sessionId).toBe(value.sessionId)
})

test("failed attachment replacement cleans its temporary file and preserves the destination", async () => {
  const target = await fixture()
  await mkdir(target.file)
  await writeFile(join(target.file, "evidence"), "keep")
  await expect(saveAttachment(target.file, value)).rejects.toThrow()
  expect(await readdir(target.folder)).toEqual(["runtime-attach.json"])
  expect(await readFile(join(target.file, "evidence"), "utf8")).toBe("keep")
})
