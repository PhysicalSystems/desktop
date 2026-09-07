// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  nsisInstallArguments,
  nsisSpawnOptions,
  nsisUninstallArguments,
  qualifyInstalledReinstall,
} from "./installed-reinstall"
import type { ReinstallObservation } from "./installed-reinstall"
import { qualificationFailureCode, sha256File } from "./qualification"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(format: "nsis" | "deb" = "deb") {
  // Fake callbacks and inert files only: no package manager or native app runs.
  const temporary = await mkdtemp(join(tmpdir(), "installed-reinstall-fixture-"))
  roots.push(temporary)
  const root = join(temporary, "owned")
  await mkdir(root)
  const artifact = join(root, "inert-installer-fixture")
  await writeFile(artifact, "INERT FAKE INSTALLER FOR ORCHESTRATION TESTS")
  const before: ReinstallObservation = {
    projectId: "project-fixture",
    sessionId: "session-fixture",
    experimentId: "experiment-fixture",
    phase: "COMPLETED",
    trialCount: 3,
    trialsSha256: "a".repeat(64),
    transcriptSha256: "b".repeat(64),
    pinchZoomEnabled: true,
  }
  const events: string[] = []
  const input: Parameters<typeof qualifyInstalledReinstall>[0] = {
    env: {
      CI: "true",
      GITHUB_ACTIONS: "true",
      RUNNER_ENVIRONMENT: "github-hosted",
      RUNNER_OS: format === "nsis" ? "Windows" : "Linux",
      GITHUB_RUN_ID: "12345",
      RUNNER_TEMP: temporary,
    },
    root,
    format,
    artifact,
    artifactSha256: await sha256File(artifact),
    payloadSha256: "c".repeat(64),
    before,
    installationState: { unconfirmed: false },
    shutdown: { applicationExited: true, descendantsExited: true },
    uninstall: async () => {
      events.push("uninstall")
      expect(input.installationState.unconfirmed).toBe(true)
    },
    verifyRemoved: async () => {
      events.push("verify-removed")
      expect(input.installationState.unconfirmed).toBe(true)
    },
    install: async () => {
      events.push("install")
      expect(input.installationState.unconfirmed).toBe(true)
    },
    installedPayloadSha256: async () => {
      events.push("fingerprint")
      expect(input.installationState.unconfirmed).toBe(true)
      return "c".repeat(64)
    },
    relaunch: async () => {
      events.push("relaunch")
      expect(input.installationState.unconfirmed).toBe(false)
      return { observation: { ...before }, applicationExited: true, descendantsExited: true }
    },
  }
  return { input, events, run: () => qualifyInstalledReinstall(input, format === "nsis" ? "win32" : "linux") }
}

test("same-byte installed formats wait for real uninstall completion and verified absence before reinstall", async () => {
  for (const format of ["nsis", "deb"] as const) {
    const f = await fixture(format)
    const entered = Promise.withResolvers<void>()
    const exited = Promise.withResolvers<void>()
    const uninstall = f.input.uninstall
    f.input.uninstall = async () => {
      await uninstall()
      entered.resolve()
      await exited.promise
    }
    const running = f.run()
    await entered.promise
    expect(f.events).toEqual(["uninstall"])
    expect(f.input.installationState.unconfirmed).toBe(true)
    exited.resolve()
    const result = await running
    expect(f.events).toEqual(["uninstall", "verify-removed", "install", "fingerprint", "relaunch"])
    expect(result).toEqual({
      sameInstallerBytes: true,
      sameExecutableAndResourcesFingerprint: true,
      preservedConversation: true,
      preservedCompletedExperiment: true,
      preservedTranscript: true,
      preservedPinchZoomPreference: true,
      confirmedRelaunchShutdown: true,
      upgradeTested: false,
      defaultProfileTested: false,
    })
    expect(JSON.stringify(result)).not.toContain("PASS")
  }
})

test("unconfirmed shutdown, non-disposable runners and unsupported formats admit no installer mutation", async () => {
  for (const configure of [
    (input: Awaited<ReturnType<typeof fixture>>["input"]) => {
      input.shutdown.applicationExited = false
    },
    (input: Awaited<ReturnType<typeof fixture>>["input"]) => {
      input.shutdown.descendantsExited = false
    },
    (input: Awaited<ReturnType<typeof fixture>>["input"]) => {
      input.installationState.unconfirmed = true
    },
    (input: Awaited<ReturnType<typeof fixture>>["input"]) => {
      input.env.RUNNER_ENVIRONMENT = "self-hosted"
    },
    (input: Awaited<ReturnType<typeof fixture>>["input"]) => {
      input.format = "AppImage" as "deb"
    },
  ]) {
    const f = await fixture()
    configure(f.input)
    await expect(f.run()).rejects.toThrow()
    expect(f.events).toEqual([])
  }
})

test("every failed install/removal boundary retains uncertainty and never attempts another mutation", async () => {
  for (const boundary of ["uninstall", "verifyRemoved", "install", "installedPayloadSha256"] as const) {
    for (const failure of [
      "QUALIFICATION_COMMAND_FAILED",
      "QUALIFICATION_COMMAND_TIMEOUT",
      "OWNED_UNINSTALL_NOT_COMPLETE",
    ]) {
      const f = await fixture()
      const prior = f.input[boundary]
      f.input[boundary] = async () => {
        await prior()
        throw new Error(failure)
      }
      await expect(f.run()).rejects.toThrow(failure)
      const last = {
        uninstall: "uninstall",
        verifyRemoved: "verify-removed",
        install: "install",
        installedPayloadSha256: "fingerprint",
      }[boundary]
      expect(f.events.at(-1)).toBe(last)
      expect(f.events).not.toContain("relaunch")
      expect(f.input.installationState.unconfirmed).toBe(true)
    }
  }
})

test("exact installer and installed executable/resources fingerprints cannot drift across callbacks", async () => {
  const changedBefore = await fixture()
  await writeFile(changedBefore.input.artifact, "changed bytes")
  await expect(changedBefore.run()).rejects.toThrow("QUALIFICATION_ARTIFACT_CHANGED")
  expect(changedBefore.events).toEqual([])

  const changedBetween = await fixture()
  const verify = changedBetween.input.verifyRemoved
  changedBetween.input.verifyRemoved = async () => {
    await verify()
    await writeFile(changedBetween.input.artifact, "changed bytes")
    changedBetween.input.artifactSha256 = await sha256File(changedBetween.input.artifact)
  }
  await expect(changedBetween.run()).rejects.toThrow("QUALIFICATION_ARTIFACT_CHANGED")
  expect(changedBetween.events).toEqual(["uninstall", "verify-removed"])
  expect(changedBetween.input.installationState.unconfirmed).toBe(false)

  const changedPayload = await fixture()
  changedPayload.input.installedPayloadSha256 = async () => {
    changedPayload.input.payloadSha256 = "d".repeat(64)
    return changedPayload.input.payloadSha256
  }
  await expect(changedPayload.run()).rejects.toThrow("PACKAGED_REINSTALL_PAYLOAD_CHANGED")
  expect(changedPayload.events).not.toContain("relaunch")
  expect(changedPayload.input.installationState.unconfirmed).toBe(true)
})

test("relaunch must preserve the frozen conversation, experiment, transcript and deliberate preference", async () => {
  for (const change of [
    { projectId: "another-project" },
    { sessionId: "another-session" },
    { experimentId: "another-experiment" },
    { trialsSha256: "d".repeat(64) },
    { transcriptSha256: "d".repeat(64) },
    { pinchZoomEnabled: false },
  ]) {
    const f = await fixture()
    const install = f.input.install
    f.input.install = async () => {
      await install()
      Object.assign(f.input.before, change)
    }
    await expect(f.run()).rejects.toThrow("PACKAGED_REINSTALL_STATE_CHANGED")
  }
  for (const field of ["applicationExited", "descendantsExited"] as const) {
    const f = await fixture()
    f.input.relaunch = async () => ({
      observation: f.input.before,
      applicationExited: true,
      descendantsExited: true,
      [field]: false,
    })
    await expect(f.run()).rejects.toThrow("PACKAGED_REINSTALL_SHUTDOWN_UNCONFIRMED")
  }
})

test("NSIS install/uninstall keep their final directory argument raw even when the owned path contains spaces", () => {
  const directory = "C:\\Runner Temp\\owned\\payload"
  expect(nsisUninstallArguments(directory)).toEqual({ args: ["/S", `_?=${directory}`], windowsVerbatimArguments: true })
  expect(nsisInstallArguments(directory)).toEqual({ args: ["/S", `/D=${directory}`], windowsVerbatimArguments: true })
  const executable = "C:\\Runner Temp\\owned\\copied-uninstaller.exe"
  expect(nsisSpawnOptions(executable)).toEqual({ argv0: `"${executable}"`, windowsVerbatimArguments: true })
  for (const invalid of [
    "payload",
    "\\\\server\\share\\payload",
    "C:\\owned\\..\\payload",
    'C:\\owned"\\payload',
    "C:\\owned\n\\payload",
    "C:\\owned\0\\payload",
  ]) {
    expect(() => nsisUninstallArguments(invalid)).toThrow("PACKAGED_REINSTALL_PATH_INVALID")
    expect(() => nsisInstallArguments(invalid)).toThrow("PACKAGED_REINSTALL_PATH_INVALID")
    expect(() => nsisSpawnOptions(invalid)).toThrow("PACKAGED_REINSTALL_PATH_INVALID")
  }
  for (const suffix of [
    "STATE_CHANGED",
    "PATH_INVALID",
    "FORMAT_INVALID",
    "SHUTDOWN_UNCONFIRMED",
    "PAYLOAD_CHANGED",
  ] as const)
    expect(qualificationFailureCode(new Error(`PACKAGED_REINSTALL_${suffix}`))).toBe(`PACKAGED_REINSTALL_${suffix}`)
})
