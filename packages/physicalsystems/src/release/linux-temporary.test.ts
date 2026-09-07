// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { allocateLinuxQualificationTemporary, linuxTemporaryPrefix } from "./linux-temporary"
import { qualificationEnvironment } from "./qualification"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

test("Chromium's exact single-instance socket template fits Linux's byte limit", () => {
  const runner = "/home/runner/work/_temp"
  const deep = `${runner}/desktop-release/desktop-qualification-XXXXXX/packaged-XXXXXX/profile/tmp`
  expect(Buffer.byteLength(`${deep}/scoped_dirXXXXXX/SingletonSocket`)).toBe(129)
  expect(Buffer.byteLength(`${linuxTemporaryPrefix(runner)}XXXXXX/scoped_dirXXXXXX/SingletonSocket`)).toBeLessThan(108)
  const suffix = "/ps-XXXXXX/scoped_dirXXXXXX/SingletonSocket"
  const maximum = "/" + "a".repeat(106 - suffix.length)
  expect(Buffer.byteLength(`${linuxTemporaryPrefix(maximum)}XXXXXX/scoped_dirXXXXXX/SingletonSocket`)).toBe(107)
  for (const invalid of [maximum + "a", "/" + "é".repeat(50), deep, "/", "relative", "/tmp/../tmp", "/tmp\0"])
    expect(() => linuxTemporaryPrefix(invalid)).toThrow("TEMP_PATH_INVALID")
})

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ps-t-")))
  roots.push(root)
  const profile = join(root, "evidence", "profile")
  await mkdir(profile, { recursive: true })
  // Passed only to the filesystem helper; process.env and native app launching
  // remain untouched. These tests never install a package or change CI settings.
  const env = {
    CI: "true",
    GITHUB_ACTIONS: "true",
    RUNNER_OS: "Linux",
    RUNNER_ENVIRONMENT: "github-hosted",
    GITHUB_RUN_ID: "12345",
    RUNNER_TEMP: root,
  }
  return { root, profile, env }
}

test.skipIf(process.platform !== "linux")(
  "exclusive temp ownership retains uncertain processes and only overrides temporary paths",
  async () => {
    const state = await fixture()
    const first = await allocateLinuxQualificationTemporary(state.env, state.profile)
    const second = await allocateLinuxQualificationTemporary(state.env, state.profile)
    expect(first.path).not.toBe(second.path)
    expect(first.path.startsWith(state.root + "/ps-")).toBe(true)
    expect((await lstat(first.path)).mode & 0o777).toBe(0o700)
    const original = qualificationEnvironment({ TMPDIR: "/untrusted", SECRET: "private" }, state.profile, "linux")
    const child: NodeJS.ProcessEnv = { ...original, ...first.environment }
    expect(Object.keys(first.environment).sort()).toEqual(["TEMP", "TMP", "TMPDIR"])
    expect(child.HOME).toBe(state.profile)
    expect(child.PHYSICALSYSTEMS_DATA_DIR).toBe(state.profile)
    expect(child.PHYSICALSYSTEMS_ALLOW_DEVICES).toBe("0")
    expect(child.SECRET).toBeUndefined()
    for (const [key, value] of Object.entries(original))
      if (!["TEMP", "TMP", "TMPDIR"].includes(key)) expect(child[key]).toBe(value)
    await writeFile(join(first.path, "owned-data"), "retained")
    for (const proof of [
      { applicationExited: false, descendantsExited: true },
      { applicationExited: true, descendantsExited: false },
      { applicationExited: false, descendantsExited: false },
    ]) {
      expect(await first.cleanup(proof)).toBe("RETAINED")
      expect(await readFile(join(first.path, "owned-data"), "utf8")).toBe("retained")
    }
    expect(await first.cleanup({ applicationExited: true, descendantsExited: true })).toBe("REMOVED")
    await expect(lstat(first.path)).rejects.toMatchObject({ code: "ENOENT" })
    expect(await second.cleanup({ applicationExited: true, descendantsExited: true })).toBe("REMOVED")
  },
)

test.skipIf(process.platform !== "linux")(
  "temp allocation rejects local runners and cleanup refuses a replaced directory",
  async () => {
    const state = await fixture()
    await expect(allocateLinuxQualificationTemporary({ ...state.env, CI: "false" }, state.profile)).rejects.toThrow(
      "DISPOSABLE_RUNNER",
    )
    const temporary = await allocateLinuxQualificationTemporary(state.env, state.profile)
    const displaced = temporary.path + "-original"
    await rename(temporary.path, displaced)
    await mkdir(temporary.path, { mode: 0o700 })
    await expect(temporary.cleanup({ applicationExited: true, descendantsExited: true })).rejects.toThrow(
      "TEMP_OWNERSHIP_INVALID",
    )
    await rm(temporary.path, { recursive: true })
    await symlink(displaced, temporary.path)
    await expect(temporary.cleanup({ applicationExited: true, descendantsExited: true })).rejects.toThrow(
      "TEMP_OWNERSHIP_INVALID",
    )
    expect((await lstat(displaced)).isDirectory()).toBe(true)
  },
)
