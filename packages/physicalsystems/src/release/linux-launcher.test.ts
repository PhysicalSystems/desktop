// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmod, copyFile, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { verifyAppImageLauncher, sha256File } from "./qualification"
import { desktopIdentity } from "./identity"

const reviewed = fileURLToPath(new URL("../../../desktop/resources/AppRun", import.meta.url))
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture(kind: "candidate" | "public" = "candidate") {
  const identity = desktopIdentity(kind)
  const root = await mkdtemp(join(tmpdir(), "ps-appimage-launcher-"))
  roots.push(root)
  const launcher = join(root, "AppRun")
  await copyFile(join(dirname(reviewed), identity.launcherSource), launcher)
  await chmod(launcher, 0o755)
  const desktop = join(root, identity.desktopEntry)
  await writeFile(desktop, "[Desktop Entry]\nName=Physical Systems Candidate\nExec=AppRun %U\nType=Application\n")
  return { root, launcher, desktop }
}

test.skipIf(process.platform === "win32")(
  "public launcher verifies and executes only the distinct public application identity",
  async () => {
    const data = await fixture("public")
    const publicSource = join(dirname(reviewed), "AppRun.public")
    expect((await verifyAppImageLauncher(data.root, publicSource, "public")).sha256).toBe(
      await sha256File(publicSource),
    )
    await expect(verifyAppImageLauncher(data.root, publicSource)).rejects.toThrow("LAUNCHER_INVALID")
    await writeFile(
      join(data.root, "physical-systems-desktop"),
      '#!/bin/sh\nprintf \'%s\\n\' "public fixture" "$@"\n',
      { mode: 0o755 },
    )
    const result = spawnSync(data.launcher, ["literal argument"], {
      env: { PATH: "/nonexistent-qualification-path" },
      timeout: 3000,
    })
    expect(result.status).toBe(0)
    expect(result.stdout.toString()).toBe("public fixture\nliteral argument\n")
    const rejected = spawnSync(data.launcher, ["--no-sandbox"], {
      env: { PATH: "/nonexistent-qualification-path" },
      timeout: 3000,
    })
    expect(rejected.status).toBe(78)
    expect(rejected.stdout.toString()).toBe("")
  },
)

test.skipIf(process.platform === "win32")(
  "final AppImage launcher must match the reviewed executable bytes",
  async () => {
    const data = await fixture()
    expect(await verifyAppImageLauncher(data.root, reviewed)).toEqual({
      launcher: data.launcher,
      sha256: await sha256File(reviewed),
    })
    await writeFile(data.launcher, (await readFile(reviewed, "utf8")) + "\n# modified after review\n")
    await expect(verifyAppImageLauncher(data.root, reviewed)).rejects.toThrow("PACKAGED_APPIMAGE_LAUNCHER_INVALID")
  },
)

test.skipIf(process.platform === "win32")(
  "final AppImage desktop entry cannot introduce unsafe or alternate execution",
  async () => {
    const data = await fixture()
    for (const entry of [
      "Exec=AppRun --no-sandbox %U",
      "Exec=AppRun --disable-setuid-sandbox %U",
      "Exec=AppRun %U\nExec=other-command",
      "Exec=AppRun %U\nTryExec=other-command",
      " Exec=AppRun %U",
      "Name=No executable",
    ]) {
      await writeFile(data.desktop, "[Desktop Entry]\n" + entry + "\n")
      await expect(verifyAppImageLauncher(data.root, reviewed)).rejects.toThrow(
        "PACKAGED_APPIMAGE_DESKTOP_ENTRY_INVALID",
      )
    }
  },
)

test.skipIf(process.platform === "win32")("launcher inspection rejects symlinks and nonexecutable files", async () => {
  const data = await fixture()
  await chmod(data.launcher, 0o644)
  await expect(verifyAppImageLauncher(data.root, reviewed)).rejects.toThrow("PACKAGED_APPIMAGE_LAUNCHER_INVALID")
  await rm(data.launcher)
  await symlink(reviewed, data.launcher)
  await expect(verifyAppImageLauncher(data.root, reviewed)).rejects.toThrow("PACKAGED_APPIMAGE_LAUNCHER_INVALID")
})

test.skipIf(process.platform === "win32")(
  "owned launcher preserves literal arguments and process ownership without a toolchain on PATH",
  async () => {
    const data = await fixture()
    const executable = join(data.root, "physical-systems-candidate")
    await writeFile(
      executable,
      '#!/bin/sh\nprintf \'%s\\0\' "$$" "$APPDIR" "${ELECTRON_DISABLE_SANDBOX-unset}" "$@"\n',
      { mode: 0o755 },
    )
    const args = ["", "with spaces", 'quoted"value', "$(must-not-execute)", "line\nbreak", "--remote-debugging-port=0"]
    const result = spawnSync(data.launcher, args, {
      env: { PATH: "/nonexistent-qualification-path", APPDIR: "/untrusted-other-app", ELECTRON_DISABLE_SANDBOX: "1" },
      timeout: 3000,
    })
    expect(result.status).toBe(0)
    expect(result.stderr.toString()).toBe("")
    expect(result.stdout.toString().split("\0")).toEqual([String(result.pid), data.root, "unset", ...args, ""])
  },
)

test.skipIf(process.platform === "win32")(
  "owned launcher refuses sandbox bypasses before executing even a harmless fixture",
  async () => {
    const data = await fixture()
    await writeFile(
      join(data.root, "physical-systems-candidate"),
      "#!/bin/sh\nprintf '%s\\n' \"fixture must not execute\"\n",
      { mode: 0o755 },
    )
    for (const argument of [
      "--no-sandbox",
      "--no-sandbox=1",
      "-no-sandbox",
      "-no-sandbox=1",
      "--disable-setuid-sandbox",
      "--disable-setuid-sandbox=1",
      "--disable-namespace-sandbox",
      "--disable-seccomp-filter-sandbox",
      "--disable-gpu-sandbox",
      "--no-zygote",
      "--single-process",
      "-disable-setuid-sandbox=1",
      "-disable-namespace-sandbox=1",
      "-disable-seccomp-filter-sandbox=1",
      "-disable-gpu-sandbox=1",
      "-no-zygote=1",
      "-single-process=1",
    ]) {
      const result = spawnSync(data.launcher, ["--safe-argument", argument], {
        env: { PATH: "/nonexistent-qualification-path" },
        timeout: 3000,
      })
      expect(result.status).toBe(78)
      expect(result.stdout.toString()).toBe("")
      expect(result.stderr.toString()).toBe("PHYSICALSYSTEMS_SANDBOX_REQUIRED\n")
    }
  },
)
