// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { loadPublicUpgradeQualification, upgradeQualificationArguments } from "./public-upgrade-qualification"
import { publicUpgradePlan } from "./public-upgrade"
import { publicReviewDigest } from "./public-downloads"
import { simulatedPublicNativeFixture } from "./public-native-fixture"
import { sha256File } from "./qualification"

test("upgrade CLI binds one exact lower-version public artifact and rejects partial or candidate-only authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "public-upgrade-options-"))
  try {
    const fixture = simulatedPublicNativeFixture(process.platform === "win32" ? "windows-x64" : "linux-x64")
    const baseline = fixture.build
    const target = { ...baseline, version: "0.1.0-beta.2", releaseInputsSha256: "d".repeat(64) }
    const builds = {
      baseline,
      target,
      expectedBaselineSha256: publicReviewDigest(baseline),
      expectedTargetSha256: publicReviewDigest(target),
    }
    const plan = publicUpgradePlan(builds)
    const artifact = join(
      root,
      `physical-systems-desktop-${baseline.version}-${process.platform === "win32" ? "windows-x64.exe" : "linux-x64.deb"}`,
    )
    await writeFile(artifact, "INERT BASELINE, NOT A NATIVE INSTALLER")
    const file = join(root, "baseline.json")
    const planFile = join(root, "plan.json")
    const targetFile = join(root, "target.json")
    await writeFile(file, JSON.stringify(baseline))
    await writeFile(planFile, JSON.stringify(plan))
    await writeFile(targetFile, JSON.stringify(target))
    const ordinary = [
      "--artifact",
      join(root, "target.inert"),
      "--evidence",
      root,
      "--report",
      join(root, "report.json"),
      "--version",
      target.version,
    ]
    const publicArgs = [
      "--public-inputs",
      targetFile,
      "--expected-public-build-sha256",
      builds.expectedTargetSha256,
      "--expected-inputs-sha256",
      target.releaseInputsSha256,
    ]
    const extra = [
      "--upgrade-plan",
      planFile,
      "--expected-upgrade-plan-sha256",
      publicReviewDigest(plan),
      "--baseline-artifact",
      artifact,
      "--expected-baseline-artifact-sha256",
      await sha256File(artifact),
      "--baseline-public-inputs",
      file,
      "--expected-baseline-public-build-sha256",
      builds.expectedBaselineSha256,
      "--expected-baseline-inputs-sha256",
      baseline.releaseInputsSha256,
    ]
    expect(upgradeQualificationArguments(ordinary).upgrade).toEqual({})
    expect(() => upgradeQualificationArguments([...ordinary, ...extra])).toThrow()
    expect(() => upgradeQualificationArguments([...ordinary, ...publicArgs, ...extra.slice(0, -2)])).toThrow()
    expect(() => upgradeQualificationArguments([...ordinary, ...publicArgs, ...extra, ...extra])).toThrow()
    expect(() => upgradeQualificationArguments([...ordinary, ...publicArgs, ...extra, "--inspection-only"])).toThrow()
    const parsed = upgradeQualificationArguments([...ordinary, ...publicArgs, ...extra])
    const mode = {
      build: target,
      publicBuildInputsSha256: builds.expectedTargetSha256,
      releaseInputsSha256: target.releaseInputsSha256,
    }
    const result = await loadPublicUpgradeQualification(parsed.upgrade, mode)
    expect(result?.plan).toEqual(plan)
    expect(result?.baselineArtifact).toBe(artifact)
    await expect(loadPublicUpgradeQualification(parsed.upgrade)).rejects.toThrow()
    await expect(
      loadPublicUpgradeQualification({ ...parsed.upgrade, "expected-upgrade-plan-sha256": "0".repeat(64) }, mode),
    ).rejects.toThrow()
    await writeFile(artifact, "CHANGED INERT BYTES")
    await expect(loadPublicUpgradeQualification(parsed.upgrade, mode)).rejects.toThrow()
    const alias = join(root, "alias.json")
    await symlink(file, alias)
    await expect(
      loadPublicUpgradeQualification({ ...parsed.upgrade, "baseline-public-inputs": alias }, mode),
    ).rejects.toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
