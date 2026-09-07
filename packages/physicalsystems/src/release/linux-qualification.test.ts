// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  appImageSandboxProfile,
  debianCandidatePlan,
  debianProfileIsLoaded,
  profileIsLoaded,
  requireAbsentDebianCandidate,
  requireDisposableLinuxRunner,
  verifyLinuxRendererSandbox,
} from "./linux-qualification"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
test("privileged Linux qualification refuses local, self-hosted and escaped directories", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ps-disposable-runner-")))
  roots.push(root)
  const owned = join(root, "owned")
  await mkdir(owned)
  const env = {
    CI: "true",
    GITHUB_ACTIONS: "true",
    RUNNER_OS: "Linux",
    RUNNER_ENVIRONMENT: "github-hosted",
    GITHUB_RUN_ID: "12345",
    RUNNER_TEMP: root,
  }
  expect(await requireDisposableLinuxRunner(env, owned, "linux")).toBe(owned)
  for (const [key, value] of [
    ["CI", "false"],
    ["GITHUB_ACTIONS", ""],
    ["RUNNER_OS", "Windows"],
    ["RUNNER_ENVIRONMENT", "self-hosted"],
    ["GITHUB_RUN_ID", ""],
    ["RUNNER_TEMP", "relative"],
  ])
    await expect(requireDisposableLinuxRunner({ ...env, [key]: value }, owned, "linux")).rejects.toThrow(
      "DISPOSABLE_RUNNER",
    )
  await expect(requireDisposableLinuxRunner(env, owned, "win32")).rejects.toThrow("DISPOSABLE_RUNNER")
  await expect(requireDisposableLinuxRunner(env, root, "linux")).rejects.toThrow("PATH_OUTSIDE_RUNNER")
  const alias = join(root, "alias")
  await symlink(owned, alias, process.platform === "win32" ? "junction" : "dir")
  await expect(requireDisposableLinuxRunner(env, alias, "linux")).rejects.toThrow("PATH_OUTSIDE_RUNNER")
})
test("Debian qualification accepts only the exact package identity and preserves preexisting installs", () => {
  const plan = debianCandidatePlan("0.1.0-beta.1", "physical-systems-desktop-candidate\n0.1.0~beta.1-0\namd64\n")
  expect(plan.packageName).toBe("physical-systems-desktop-candidate")
  for (const metadata of [
    "foreign\n0.1.0~beta.1-0\namd64",
    "physical-systems-desktop-candidate\n0.2.0-0\namd64",
    "physical-systems-desktop-candidate\n0.1.0~beta.1-0\narm64",
  ])
    expect(() => debianCandidatePlan("0.1.0-beta.1", metadata)).toThrow("IDENTITY_INVALID")
  expect(() => requireAbsentDebianCandidate("Package: ordinary-package\nStatus: install ok installed\n")).not.toThrow()
  for (const status of ["install ok installed", "deinstall ok config-files", "install reinstreq half-installed"])
    expect(() =>
      requireAbsentDebianCandidate(`Package: physical-systems-desktop-candidate\nStatus: ${status}\n`),
    ).toThrow("ALREADY_PRESENT")
  expect(() => requireAbsentDebianCandidate("invalid status database")).toThrow("STATUS_INVALID")
})

test("public Linux qualification uses only its fixed separate installation identity", () => {
  const metadata = "physical-systems-desktop\n0.1.0~beta.1-0\namd64\n"
  const plan = debianCandidatePlan("0.1.0-beta.1", metadata, "public")
  expect(plan.executable).toBe("/opt/Physical Systems/physical-systems-desktop")
  expect(plan.paths).not.toContain("/opt/Physical Systems Candidate")
  expect(() => debianCandidatePlan("0.1.0-beta.1", metadata)).toThrow("IDENTITY_INVALID")
  expect(() =>
    requireAbsentDebianCandidate(
      "Package: physical-systems-desktop-candidate\nStatus: install ok installed\n",
      "public",
    ),
  ).not.toThrow()
  expect(() =>
    requireAbsentDebianCandidate("Package: physical-systems-desktop\nStatus: install ok installed\n", "public"),
  ).toThrow("ALREADY_PRESENT")
  expect(debianProfileIsLoaded("physical-systems-candidate (unconfined)\n")).toBe(true)
  expect(debianProfileIsLoaded("physical-systems-candidate (unconfined)\n", "public")).toBe(false)
  expect(debianProfileIsLoaded("physical-systems-desktop (unconfined)\n", "public")).toBe(true)
  expect(debianProfileIsLoaded("physical-systems-candidate-other (unconfined)\n")).toBe(false)
})
test.skipIf(process.platform === "win32")(
  "AppImage sandbox permission names one exact owned executable without wildcard or policy injection",
  () => {
    const root = "/home/runner/work/_temp/qualification-root"
    const executable = join(root, "payload/squashfs-root/physical-systems-candidate")
    const profile = appImageSandboxProfile(executable, root)
    expect(profile.text).toContain(`"${executable}" flags=(unconfined)`)
    expect(profile.text).toContain("  userns,")
    expect(profile.text).not.toContain("*")
    expect(profileIsLoaded(`${profile.name} (unconfined)\n`, profile.name)).toBe(true)
    expect(profileIsLoaded(`${profile.name}-other (unconfined)\n`, profile.name)).toBe(false)
    for (const unsafe of [
      "/opt/application",
      executable + '" { userns,',
      executable.replace("qualification-root", "wild*"),
      executable.replace("qualification-root", "line\nbreak"),
    ])
      expect(() => appImageSandboxProfile(unsafe, root)).toThrow("PROFILE_PATH_INVALID")
  },
)
test("sandbox qualification requires every observed renderer to retain seccomp and no-new-privileges", () => {
  const good = { commandLine: "app\0--type=renderer\0", status: "Name:\tapp\nSeccomp:\t2\nNoNewPrivs:\t1\n" }
  expect(() => verifyLinuxRendererSandbox([good])).not.toThrow()
  for (const bad of [
    [],
    [{ ...good, status: "Seccomp:\t0\nNoNewPrivs:\t0\n" }],
    [{ ...good, commandLine: "app\0--type=utility\0" }],
    [good, { ...good, commandLine: good.commandLine + "--no-sandbox\0" }],
    [good, { ...good, status: "private status credential trap" }],
  ])
    expect(() => verifyLinuxRendererSandbox(bad)).toThrow("PACKAGED_LINUX_RENDERER_SANDBOX_UNCONFIRMED")
})
