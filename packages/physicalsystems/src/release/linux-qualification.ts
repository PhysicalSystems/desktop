// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto"
import { realpath } from "node:fs/promises"
import { isAbsolute, join, resolve, sep } from "node:path"

/** Privileged qualification is confined to a fresh GitHub-hosted Linux runner. */
export async function requireDisposableLinuxRunner(env: NodeJS.ProcessEnv, root: string, platform = process.platform) {
  if (
    platform !== "linux" ||
    env.CI !== "true" ||
    env.GITHUB_ACTIONS !== "true" ||
    env.RUNNER_OS !== "Linux" ||
    env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID || "") ||
    !isAbsolute(env.RUNNER_TEMP || "")
  )
    throw new Error("LINUX_QUALIFICATION_REQUIRES_DISPOSABLE_RUNNER")
  const temporary = await realpath(env.RUNNER_TEMP!)
  const owned = await realpath(root)
  if (temporary === sep || owned !== resolve(root) || !owned.startsWith(temporary + sep))
    throw new Error("LINUX_QUALIFICATION_PATH_OUTSIDE_RUNNER")
  return owned
}

export function debianCandidatePlan(version: string, metadata: string) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.[1-9]\d*)?$/.test(version))
    throw new Error("LINUX_QUALIFICATION_DEBIAN_IDENTITY_INVALID")
  const packageName = "physical-systems-desktop-candidate"
  const packageVersion = version.replace("-beta.", "~beta.") + "-0"
  if (metadata.trim() !== `${packageName}\n${packageVersion}\namd64`)
    throw new Error("LINUX_QUALIFICATION_DEBIAN_IDENTITY_INVALID")
  return {
    packageName,
    packageVersion,
    executable: "/opt/Physical Systems Candidate/physical-systems-candidate",
    paths: [
      "/opt/Physical Systems Candidate",
      "/usr/bin/physical-systems-candidate",
      "/etc/apparmor.d/physical-systems-candidate",
      "/var/lib/dpkg/alternatives/physical-systems-candidate",
    ],
  }
}

export function requireAbsentDebianCandidate(status: string) {
  if (!/^Package: /m.test(status) || !/^Status: /m.test(status))
    throw new Error("LINUX_QUALIFICATION_PACKAGE_STATUS_INVALID")
  if (/^Package: physical-systems-desktop-candidate\s*$/m.test(status))
    throw new Error("LINUX_QUALIFICATION_PACKAGE_ALREADY_PRESENT")
}

/** Same narrowly scoped userns permission as the Debian package, for a temp path. */
export function appImageSandboxProfile(executable: string, root: string) {
  if (
    !isAbsolute(root) ||
    resolve(root) !== root ||
    executable !== join(root, "payload", "squashfs-root", "physical-systems-candidate") ||
    !/^[A-Za-z0-9_./ -]+$/.test(executable)
  )
    throw new Error("LINUX_QUALIFICATION_PROFILE_PATH_INVALID")
  const name = "ps-desktop-qualification-" + createHash("sha256").update(executable).digest("hex").slice(0, 24)
  return {
    name,
    file: join(root, "appimage-apparmor-profile"),
    text: `abi <abi/4.0>,\nprofile "${name}" "${executable}" flags=(unconfined) {\n  userns,\n}\n`,
  }
}

export function profileIsLoaded(profiles: string, name: string) {
  if (!/^ps-desktop-qualification-[a-f0-9]{24}$/.test(name)) throw new Error("LINUX_QUALIFICATION_PROFILE_PATH_INVALID")
  return profiles.split("\n").some((line) => line.startsWith(name + " ("))
}

/** Native /proc observations, not a claim based only on BrowserWindow options. */
export function verifyLinuxRendererSandbox(processes: { commandLine: string; status: string }[]) {
  const renderers = processes.filter((entry) => entry.commandLine.split("\0").includes("--type=renderer"))
  if (
    !renderers.length ||
    renderers.some(
      (entry) =>
        !/^Seccomp:\s+2\s*$/m.test(entry.status) ||
        !/^NoNewPrivs:\s+1\s*$/m.test(entry.status) ||
        entry.commandLine
          .split("\0")
          .some((argument) =>
            /^--?(?:no-sandbox|disable-(?:setuid|namespace|seccomp-filter|gpu)-sandbox)(?:=|$)/.test(argument),
          ),
    )
  )
    throw new Error("PACKAGED_LINUX_RENDERER_SANDBOX_UNCONFIRMED")
}
