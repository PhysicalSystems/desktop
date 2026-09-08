// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepareAppImageReplacement } from "./appimage-replacement"
import { sha256File } from "./qualification"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const stopped = { applicationExited: true, descendantsExited: true, runtimeCacheRemoved: true }
async function fixture() {
  // Real inert file operations only. Neither file is an executable AppImage;
  // no native application, package manager or process interruption is simulated.
  const temporary = await mkdtemp(join(tmpdir(), "replace-fixture-"))
  roots.push(temporary)
  const root = join(temporary, "owned")
  await mkdir(root, { mode: 0o700 })
  const runnable = join(root, "extractable.AppImage")
  const targetArtifact = join(temporary, "target-fixture")
  const baseline = Buffer.alloc(600000, 0x61)
  const target = Buffer.alloc(700000, 0x62)
  await writeFile(runnable, baseline, { mode: 0o700 })
  await writeFile(targetArtifact, target, { mode: 0o600 })
  const input = {
    env: {
      CI: "true",
      GITHUB_ACTIONS: "true",
      RUNNER_ENVIRONMENT: "github-hosted",
      RUNNER_OS: "Linux",
      GITHUB_RUN_ID: "12345",
      RUNNER_TEMP: temporary,
    },
    root,
    runnable,
    baselineSha256: await sha256File(runnable),
    targetArtifact,
    targetSha256: await sha256File(targetArtifact),
  }
  return { input, baseline, target }
}

test("real portable staging atomically replaces exact baseline bytes with the exact target", async () => {
  const f = await fixture()
  const replacement = await prepareAppImageReplacement(f.input)
  expect(await replacement.complete(stopped)).toEqual({
    scope: "portable-atomic-replacement",
    targetBytesMatch: true,
    directorySynced: true,
    stagedFileAbsent: true,
  })
  expect(await readFile(f.input.runnable)).toEqual(f.target)
  expect(await readFile(f.input.targetArtifact)).toEqual(f.target)
  await expect(readFile(replacement.incoming)).rejects.toThrow()
  await expect(replacement.complete(stopped)).rejects.toThrow("APPIMAGE_REPLACEMENT_UNCONFIRMED")
})

test("a closed partial stage leaves the baseline usable and recovery completes only that owned replacement", async () => {
  const f = await fixture()
  const replacement = await prepareAppImageReplacement(f.input)
  const observation = await replacement.interrupt(stopped)
  expect(observation).toEqual({
    kind: "appimage-partial-staging-before-atomic-replacement",
    writerClosed: true,
    baselinePayloadChanged: false,
    targetInstallationComplete: false,
    stagedBytes: 350000,
  })
  expect(await readFile(f.input.runnable)).toEqual(f.baseline)
  expect(await readFile(replacement.incoming)).toEqual(f.target.subarray(0, 350000))
  expect(JSON.stringify(observation)).not.toContain("installerExited")
  // Actual baseline native relaunch is the common controller's separate duty.
  await replacement.complete(stopped)
  expect(await readFile(f.input.runnable)).toEqual(f.target)
  await expect(readFile(replacement.incoming)).rejects.toThrow()
})

test("uncertain processes or cache, local runners and preexisting stages prevent replacement", async () => {
  for (const boundary of ["applicationExited", "descendantsExited", "runtimeCacheRemoved"] as const) {
    const f = await fixture()
    const replacement = await prepareAppImageReplacement(f.input)
    await expect(replacement.complete({ ...stopped, [boundary]: false })).rejects.toThrow(
      "APPIMAGE_REPLACEMENT_UNCONFIRMED",
    )
    expect(await readFile(f.input.runnable)).toEqual(f.baseline)
  }
  const f = await fixture()
  await expect(prepareAppImageReplacement({ ...f.input, env: { ...f.input.env, CI: "false" } })).rejects.toThrow(
    "REQUIRES_DISPOSABLE_RUNNER",
  )
  const replacement = await prepareAppImageReplacement(f.input)
  await writeFile(replacement.incoming, "preexisting unrelated bytes")
  await expect(replacement.interrupt(stopped)).rejects.toThrow("APPIMAGE_REPLACEMENT_UNCONFIRMED")
  expect(await readFile(replacement.incoming, "utf8")).toBe("preexisting unrelated bytes")
  expect(await readFile(f.input.runnable)).toEqual(f.baseline)
})

test("changed source, baseline or remembered stage cannot be used for recovery", async () => {
  for (const variation of ["source", "baseline", "stage", "stage-symlink"]) {
    const f = await fixture()
    const replacement = await prepareAppImageReplacement(f.input)
    await replacement.interrupt(stopped)
    if (variation === "source") await writeFile(f.input.targetArtifact, Buffer.alloc(f.target.length, 0x63))
    if (variation === "baseline") await writeFile(f.input.runnable, Buffer.alloc(f.baseline.length, 0x63))
    if (variation === "stage") await writeFile(replacement.incoming, Buffer.alloc(350000, 0x63))
    if (variation === "stage-symlink") {
      await rm(replacement.incoming)
      await symlink(f.input.targetArtifact, replacement.incoming)
    }
    await expect(replacement.complete(stopped)).rejects.toThrow("APPIMAGE_REPLACEMENT_UNCONFIRMED")
    expect(await readFile(f.input.runnable)).not.toEqual(f.target)
  }
})
