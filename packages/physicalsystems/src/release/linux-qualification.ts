// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto"
import { realpath } from "node:fs/promises"
import { isAbsolute, join, resolve, sep } from "node:path"
import { desktopIdentity } from "./identity"

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

/** electron-builder maps prereleases to Debian ordering and appends buildNumber 0. */
export function debianPackageVersion(version: string) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.[1-9]\d*)?$/.test(version))
    throw new Error("LINUX_QUALIFICATION_DEBIAN_IDENTITY_INVALID")
  return version.replace("-beta.", "~beta.") + "-0"
}

export function debianCandidatePlan(version: string, metadata: string, kind: "candidate" | "public" = "candidate") {
  const identity = desktopIdentity(kind)
  const packageName = identity.packageName
  const packageVersion = debianPackageVersion(version)
  if (metadata.trim() !== `${packageName}\n${packageVersion}\namd64`)
    throw new Error("LINUX_QUALIFICATION_DEBIAN_IDENTITY_INVALID")
  return {
    packageName,
    packageVersion,
    executable: `/opt/${identity.productName}/${identity.executableName}`,
    paths: [
      `/opt/${identity.productName}`,
      `/usr/bin/${identity.executableName}`,
      `/etc/apparmor.d/${identity.executableName}`,
      `/var/lib/dpkg/alternatives/${identity.executableName}`,
    ],
  }
}

export function requireAbsentDebianCandidate(status: string, kind: "candidate" | "public" = "candidate") {
  if (!/^Package: /m.test(status) || !/^Status: /m.test(status))
    throw new Error("LINUX_QUALIFICATION_PACKAGE_STATUS_INVALID")
  if (status.split("\n").some((line) => line.trim() === `Package: ${desktopIdentity(kind).packageName}`))
    throw new Error("LINUX_QUALIFICATION_PACKAGE_ALREADY_PRESENT")
}

/** Same narrowly scoped userns permission as the Debian package, for a temp path. */
export function appImageSandboxProfile(executable: string, root: string, kind: "candidate" | "public" = "candidate") {
  if (
    !isAbsolute(root) ||
    resolve(root) !== root ||
    executable !== join(root, "payload", "squashfs-root", desktopIdentity(kind).executableName) ||
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

export function debianProfileIsLoaded(profiles: string, kind: "candidate" | "public" = "candidate") {
  return profiles.split("\n").some((line) => line.startsWith(desktopIdentity(kind).executableName + " ("))
}

/** Chromium replaces argv with one space-separated title after a Linux zygote fork. */
export function linuxProcessArguments(commandLine: string) {
  const args = commandLine.split("\0").filter((value) => value.length > 0)
  // Preserve real argv boundaries, including spaces inside a single argument.
  // A rewritten title has one nonempty field followed by optional NUL padding.
  return args.length === 1 ? args[0].split(/[ \t]+/).filter((value) => value.length > 0) : args
}

/** Native /proc observations, not a claim based only on BrowserWindow options. */
export function verifyLinuxRendererSandbox(processes: { commandLine: string; status: string }[]) {
  const renderers = processes
    .map((entry) => ({ ...entry, args: linuxProcessArguments(entry.commandLine) }))
    .filter((entry) => entry.args.includes("--type=renderer"))
  if (
    !renderers.length ||
    renderers.some(
      (entry) =>
        !/^Seccomp:\s+2\s*$/m.test(entry.status) ||
        !/^NoNewPrivs:\s+1\s*$/m.test(entry.status) ||
        entry.args.some((argument) =>
          /^--?(?:no-sandbox|disable-(?:setuid|namespace|seccomp-filter|gpu)-sandbox)(?:=|$)/.test(argument),
        ),
    )
  )
    throw new Error("PACKAGED_LINUX_RENDERER_SANDBOX_UNCONFIRMED")
}
