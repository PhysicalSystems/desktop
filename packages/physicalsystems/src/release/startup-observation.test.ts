// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Writable } from "node:stream"
import { observePrivateLog, startupCheckpointDetail } from "./startup-observation"

test("private log flush is bounded and suppresses filesystem error details without changing qualification", async () => {
  const good = new Writable({
    write(_chunk, _encoding, done) {
      done()
    },
  })
  const observed = observePrivateLog(good)
  good.write("private-trap")
  expect(await observed.finish()).toBe("COMPLETE")
  const broken = new Writable({
    write(_chunk, _encoding, done) {
      done(new Error("private-path credential-trap"))
    },
  })
  const failed = observePrivateLog(broken)
  broken.write("private-trap")
  expect(await failed.finish()).toBe("FAILED")
  const hung = new Writable({ final() {} })
  expect(await observePrivateLog(hung).finish(10)).toBe("FAILED")
  expect(hung.destroyed).toBe(true)
})

test("startup observations distinguish early main, logger, operator and attachment without exposing private data", async () => {
  const root = await mkdtemp(join(tmpdir(), "private-startup-trap-"))
  try {
    expect(await startupCheckpointDetail(root)).toContain("main-directories=absent")
    for (const name of [
      "data",
      "cache",
      "state",
      "desktop",
      "session",
      "workspace",
      "desktop/logs",
      "desktop/Crashpad",
    ])
      await mkdir(join(root, name), { recursive: true })
    await writeFile(join(root, "desktop/opencode.settings"), "credential=private-trap")
    const early = await startupCheckpointDetail(root, [
      "private-argv\0--type=utility\0--token=private-trap\0",
      "private-argv\0--type=untrusted-private-trap\0",
    ])
    expect(early).toContain("main-directories=present")
    expect(early).toContain("settings=present, logging=present, crashpad=present, operator=absent, attachment=absent")
    expect(early).toContain("owned process kinds=other,utility")
    expect(early).not.toContain("private-")
    await mkdir(join(root, "operator"))
    await writeFile(join(root, "desktop/runtime-attach.json"), "credential=private-trap")
    const later = await startupCheckpointDetail(root)
    expect(later).toContain("operator=present, attachment=present")
    expect(later).not.toContain("private-")
    const rewritten = await startupCheckpointDetail(root, [
      "/opt/Physical Systems Candidate/private-argv --type=renderer --token=private-trap\0\0",
      "private-argv --type=gpu-process --token=private-trap\0",
      "private-argv\0--title=word --type=utility\0",
    ])
    expect(rewritten).toContain("owned process kinds=gpu-process,other,renderer")
    expect(rewritten).not.toContain("private-")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test.skipIf(process.platform === "win32")(
  "startup observations reject a checkpoint symlink without following it",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "private-startup-trap-"))
    try {
      await symlink(tmpdir(), join(root, "operator"))
      expect(await startupCheckpointDetail(root)).toContain("operator=invalid")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)
