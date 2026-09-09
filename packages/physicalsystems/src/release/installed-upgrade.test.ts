// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { qualifyInstalledUpgrade, requireDebianUpgradeStatus } from "./installed-upgrade"
import { publicReviewDigest } from "./public-downloads"
import { simulatedPublicNativeFixture } from "./public-native-fixture"
import { publicUpgradePlan } from "./public-upgrade"
import { verifyPublicSignaturePair } from "./public-qualification"
import { sha256File } from "./qualification"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(mode: "upgrade" | "recovery" = "upgrade") {
  // Inert files and fake callbacks only. These assertions are not native evidence.
  const temporary = await mkdtemp(join(tmpdir(), "installed-upgrade-fixture-"))
  roots.push(temporary)
  const root = join(temporary, "owned")
  await mkdir(root)
  const baselineArtifact = join(root, "baseline.inert")
  const targetArtifact = join(root, "target.inert")
  await writeFile(baselineArtifact, "INERT LOWER VERSION FIXTURE")
  await writeFile(targetArtifact, "INERT HIGHER VERSION FIXTURE")
  const base = simulatedPublicNativeFixture("linux-x64")
  const target = { ...base.build, version: "0.1.0-beta.2", releaseInputsSha256: "d".repeat(64) }
  const builds = {
    baseline: base.build,
    expectedBaselineSha256: base.publicBuildInputsSha256,
    target,
    expectedTargetSha256: publicReviewDigest(target),
  }
  const plan = publicUpgradePlan(builds)
  const events: string[] = []
  let installed = false
  const before = {
    version: plan.baseline.version,
    executableAndResourcesSha256: "e".repeat(64),
    vaultSha256: "c".repeat(64),
    state: {
      projectId: "project",
      sessionId: "session",
      experimentId: "experiment",
      phase: "COMPLETED" as const,
      trialCount: 3 as const,
      trialsSha256: "f".repeat(64),
      transcriptSha256: "a".repeat(64),
      pinchZoomEnabled: true,
    },
  }
  const input: Parameters<typeof qualifyInstalledUpgrade>[0] = {
    env: { ...base.env, RUNNER_TEMP: temporary },
    root,
    format: "deb",
    mode,
    plan,
    expectedPlanSha256: publicReviewDigest(plan),
    builds,
    baselineArtifact,
    baselineArtifactSha256: await sha256File(baselineArtifact),
    targetArtifact,
    targetArtifactSha256: await sha256File(targetArtifact),
    targetPayloadSha256: "b".repeat(64),
    before,
    shutdown: { applicationExited: true, descendantsExited: true },
    installationState: { unconfirmed: false },
    observeInstalled: async () => {
      events.push(installed ? "observe-target" : "observe-baseline")
      return installed
        ? { version: target.version, executableAndResourcesSha256: "b".repeat(64) }
        : { version: before.version, executableAndResourcesSha256: before.executableAndResourcesSha256 }
    },
    installTarget: async () => {
      expect(input.installationState.unconfirmed).toBe(true)
      events.push("install-target")
      installed = true
    },
    interruptTarget: async () => {
      expect(input.installationState.unconfirmed).toBe(true)
      events.push("interrupt-target")
      return {
        kind: "debian-unpacked-before-configuration",
        installerExited: true,
        descendantsExited: true,
        baselinePayloadChanged: true,
        targetInstallationComplete: false,
      }
    },
    relaunchTarget: async () => {
      events.push("relaunch-target")
      expect(input.installationState.unconfirmed).toBe(false)
      return {
        ...before,
        version: target.version,
        executableAndResourcesSha256: "b".repeat(64),
        applicationExited: true,
        descendantsExited: true,
      }
    },
  }
  return { input, events, run: () => qualifyInstalledUpgrade(input, "linux") }
}

test("actual callback order requires a lower installed baseline, exact target replacement and preserved state", async () => {
  const f = await fixture()
  const result = await f.run()
  expect(f.events).toEqual(["observe-baseline", "install-target", "observe-target", "relaunch-target"])
  expect(result.baselineVersion).toBe("0.1.0-beta.1")
  expect(result.targetVersion).toBe("0.1.0-beta.2")
  expect(result.historicalDatabaseMigrationTested).toBe(false)
  expect(result.powerLossTested).toBe(false)
  expect(JSON.stringify(result)).not.toContain("PASS")
})

test("recovery needs actual partial mutation and confirmed installer shutdown before exact target continuation", async () => {
  const f = await fixture("recovery")
  expect((await f.run()).interruption).toBe("debian-unpacked-before-configuration")
  expect(f.events).toEqual([
    "observe-baseline",
    "interrupt-target",
    "install-target",
    "observe-target",
    "relaunch-target",
  ])
  for (const change of [
    { baselinePayloadChanged: false },
    { targetInstallationComplete: true },
    { installerExited: false },
    { descendantsExited: false },
    { kind: "windows-partial-payload-copy" as const },
  ]) {
    const f = await fixture("recovery")
    const interrupt = f.input.interruptTarget
    f.input.interruptTarget = async () => {
      const original = await interrupt()
      if (original.kind === "appimage-partial-staging-before-atomic-replacement")
        throw new Error("Wrong fixture format")
      return { ...original, ...change }
    }
    await expect(f.run()).rejects.toThrow("PUBLIC_UPGRADE_INTERRUPTION_UNCONFIRMED")
    expect(f.events).not.toContain("install-target")
    expect(f.input.installationState.unconfirmed).toBe(true)
  }
})

test("changed artifacts, unconfirmed baseline/shutdown and failed install boundaries never proceed as qualified", async () => {
  const changed = await fixture()
  const observe = changed.input.observeInstalled
  changed.input.observeInstalled = async () => {
    await writeFile(changed.input.targetArtifact, "changed")
    return observe()
  }
  await expect(changed.run()).rejects.toThrow("PUBLIC_UPGRADE_ARTIFACT_CHANGED")
  expect(changed.events).not.toContain("install-target")
  for (const field of ["applicationExited", "descendantsExited"] as const) {
    const f = await fixture()
    f.input.shutdown[field] = false
    await expect(f.run()).rejects.toThrow("PUBLIC_UPGRADE_SHUTDOWN_UNCONFIRMED")
    expect(f.events).toEqual([])
  }
  const failed = await fixture()
  failed.input.installTarget = async () => {
    throw new Error("OWNED_INSTALLER_TIMEOUT")
  }
  await expect(failed.run()).rejects.toThrow("OWNED_INSTALLER_TIMEOUT")
  expect(failed.input.installationState.unconfirmed).toBe(true)
  expect(failed.events).not.toContain("relaunch-target")
  const baseline = await fixture()
  baseline.input.observeInstalled = async () => ({
    version: "0.1.0-beta.2",
    executableAndResourcesSha256: "b".repeat(64),
  })
  await expect(baseline.run()).rejects.toThrow("PUBLIC_UPGRADE_BASELINE_UNCONFIRMED")
})

test("callback mutation cannot rewrite the baseline state against which recovery is checked", async () => {
  const f = await fixture()
  const install = f.input.installTarget
  f.input.installTarget = async () => {
    await install()
    f.input.before.state.transcriptSha256 = "c".repeat(64)
  }
  await expect(f.run()).rejects.toThrow("PUBLIC_UPGRADE_STATE_CHANGED")
})

test("Windows baseline and target both require observed signatures before any upgrade mutation", async () => {
  const f = await fixture()
  f.input.format = "nsis"
  f.input.env.RUNNER_OS = "Windows"
  await expect(qualifyInstalledUpgrade(f.input, "win32")).rejects.toThrow("PUBLIC_UPGRADE_SIGNATURE_UNCONFIRMED")
  expect(f.events).toEqual([])
  expect(f.input.installationState.unconfirmed).toBe(false)
})

test("unsigned Windows upgrade and recovery require both exact unsigned observations and preserve all state gates", async () => {
  for (const scenario of [
    "upgrade",
    "recovery",
    "missing",
    "signed-status",
    "signer",
    "changed-bytes",
    "state",
  ] as const) {
    const f = await fixture(scenario === "recovery" ? "recovery" : "upgrade")
    f.input.format = "nsis"
    f.input.env.RUNNER_OS = "Windows"
    for (const key of ["baseline", "target"] as const)
      f.input.builds[key].windowsSigning = { provider: "unsigned-preview" }
    f.input.builds.expectedBaselineSha256 = publicReviewDigest(f.input.builds.baseline)
    f.input.builds.expectedTargetSha256 = publicReviewDigest(f.input.builds.target)
    f.input.plan = publicUpgradePlan(f.input.builds)
    f.input.expectedPlanSha256 = publicReviewDigest(f.input.plan)
    const observed = { Status: "NotSigned", Publisher: null, Thumbprint: null }
    const pair = (key: "baseline" | "target") =>
      verifyPublicSignaturePair({
        installer: observed,
        executable: observed,
        installerSha256: key === "baseline" ? f.input.baselineArtifactSha256 : f.input.targetArtifactSha256,
        executableSha256: "c".repeat(64),
        mode: {
          build: f.input.builds[key],
          publicBuildInputsSha256:
            key === "baseline" ? f.input.builds.expectedBaselineSha256 : f.input.builds.expectedTargetSha256,
          releaseInputsSha256: f.input.builds[key].releaseInputsSha256,
        },
      })
    f.input.signatures = { baseline: pair("baseline"), target: pair("target") }
    if (scenario === "missing") f.input.signatures = undefined
    if (scenario === "signed-status") f.input.signatures!.target.status = "PASS"
    if (scenario === "signer")
      f.input.signatures!.target.installer = {
        ...f.input.signatures!.target.installer,
        publisher: "Invented Publisher",
      } as never
    if (scenario === "changed-bytes") f.input.signatures!.target.installer.sha256 = "0".repeat(64)
    if (scenario === "state") {
      const relaunch = f.input.relaunchTarget
      f.input.relaunchTarget = async () => ({ ...(await relaunch()), vaultSha256: "0".repeat(64) })
    }
    f.input.interruptTarget = async () => ({
      kind: "windows-partial-payload-copy",
      installerExited: true,
      descendantsExited: true,
      baselinePayloadChanged: true,
      targetInstallationComplete: false,
    })
    if (scenario === "upgrade" || scenario === "recovery") {
      const result = await qualifyInstalledUpgrade(f.input, "win32")
      expect(result.preservedEncryptedVault).toBe(true)
      expect(result.preservedConversation).toBe(true)
      expect(result.sameInstallerBytes).toBe(true)
      if (scenario === "recovery") expect(result.interruption).toBe("windows-partial-payload-copy")
      continue
    }
    await expect(qualifyInstalledUpgrade(f.input, "win32")).rejects.toThrow()
    if (scenario !== "state") expect(f.events).toEqual([])
  }
})

test("Debian phase interruption requires the exact public package/version unpacked state", () => {
  const status = "Package: physical-systems-desktop\nVersion: 0.1.0-beta.2\nStatus: install ok unpacked\n"
  expect(() => requireDebianUpgradeStatus(status, "0.1.0-beta.2", "unpacked")).not.toThrow()
  for (const changed of [
    status.replace("unpacked", "installed"),
    status.replace("desktop", "desktop-candidate"),
    status.replace("beta.2", "beta.1"),
    status + "Status: install ok installed\n",
    status + "\n" + status,
  ])
    expect(() => requireDebianUpgradeStatus(changed, "0.1.0-beta.2", "unpacked")).toThrow(
      "PUBLIC_UPGRADE_DEBIAN_STATE_UNCONFIRMED",
    )
})

test("portable recovery requires a real baseline relaunch with unchanged state and encrypted vault", async () => {
  const f = await fixture("recovery")
  f.input.format = "appimage"
  f.input.interruptTarget = async () => ({
    kind: "appimage-partial-staging-before-atomic-replacement",
    writerClosed: true,
    stagedBytes: 1024,
    baselinePayloadChanged: false,
    targetInstallationComplete: false,
  })
  await expect(f.run()).rejects.toThrow("BASELINE_UNCONFIRMED")
  expect(f.events).not.toContain("install-target")
  f.input.installationState.unconfirmed = false
  f.input.relaunchBaseline = async () => {
    f.events.push("baseline-recovery-relaunch")
    return { ...f.input.before, applicationExited: true, descendantsExited: true }
  }
  expect((await f.run()).interruption).toBe("appimage-partial-staging-before-atomic-replacement")
  expect(f.events.indexOf("baseline-recovery-relaunch")).toBeLessThan(f.events.indexOf("install-target"))
  const changed = await fixture()
  const relaunch = changed.input.relaunchTarget
  changed.input.relaunchTarget = async () => ({ ...(await relaunch()), vaultSha256: "0".repeat(64) })
  await expect(changed.run()).rejects.toThrow("STATE_CHANGED")
})
