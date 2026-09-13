// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { allocateDesktopVersion, compareVersion } from "./inputs"
import { publicReviewDigest } from "./public-downloads"
import { simulatedPublicNativeFixture } from "./public-native-fixture"
import { publicUpgradePlan, publicUpgradeVersions, validatePublicUpgradePlan } from "./public-upgrade"

test("first public release keeps beta.1 and bootstraps its upgrade with a separate lab version", () => {
  expect(publicUpgradeVersions({ history: { complete: true, versions: [] }, channel: "preview" })).toEqual({
    baselineVersion: "0.0.0-beta.1",
    targetVersion: "0.1.0-beta.1",
    baselineHistory: { complete: true, versions: [] },
    targetHistory: { complete: true, versions: [] },
  })
  expect(
    publicUpgradeVersions({ history: { complete: true, versions: [] }, channel: "stable", requestedVersion: "0.1.0" })
      .targetVersion,
  ).toBe("0.1.0")
  expect(
    publicUpgradeVersions({
      history: { complete: true, versions: [] },
      channel: "preview",
      requestedVersion: "0.1.0-beta.1",
    }).targetVersion,
  ).toBe("0.1.0-beta.1")
})

test.each([
  { versions: ["0.1.0-beta.4"], expected: "0.1.0-beta.5" },
  { versions: ["0.1.0-beta.6", "0.1.0-beta.4"], expected: "0.1.0-beta.7" },
  { versions: ["0.1.0"], expected: "0.1.1-beta.1" },
])("candidate and public targets agree for complete history $versions", ({ versions, expected }) => {
  const history = { complete: true as const, versions: [...versions] }
  const original = structuredClone(history)
  const candidate = allocateDesktopVersion({ history, channel: "preview" })
  const release = publicUpgradeVersions({ history, channel: "preview", requestedVersion: candidate })
  expect(candidate).toBe(expected)
  expect(release.targetVersion).toBe(candidate)
  expect(publicUpgradeVersions({ history, channel: "preview" }).targetVersion).toBe(candidate)
  expect(compareVersion(release.baselineVersion, release.targetVersion)).toBeLessThan(0)
  expect(release.baselineHistory).toEqual(original)
  expect(release.targetHistory).toEqual(original)
  expect(history).toEqual(original)
  release.baselineHistory.versions.push("9.0.0")
  expect(release.targetHistory).toEqual(original)
  expect(history).toEqual(original)
})

test("a candidate version cannot silently change or be reused after another release reserves it", () => {
  const history = { complete: true as const, versions: ["0.1.0-beta.4", "0.1.0-beta.6"] }
  for (const requestedVersion of ["0.1.0-beta.5", "0.1.0-beta.6", "0.0.0-beta.1"])
    expect(() => publicUpgradeVersions({ history, channel: "preview", requestedVersion })).toThrow()
  expect(() => publicUpgradeVersions({ history, channel: "stable" })).toThrow()
  expect(() =>
    publicUpgradeVersions({ history: { ...history, complete: false } as never, channel: "preview" }),
  ).toThrow()
})

test("baseline plan binds both public builds, exact signing policy and limited same-source/schema scope", () => {
  const fixture = simulatedPublicNativeFixture()
  const baseline = fixture.build
  const target = { ...baseline, version: "0.1.0-beta.2", releaseInputsSha256: "d".repeat(64) }
  const input = {
    baseline,
    expectedBaselineSha256: publicReviewDigest(baseline),
    target,
    expectedTargetSha256: publicReviewDigest(target),
  }
  const plan = publicUpgradePlan(input)
  expect(plan.baselinePurpose).toBe("unreleased-lab-only")
  expect(plan.scope).toBe("same-reviewed-source-and-storage-schema")
  expect(plan.publication).toBe(false)
  expect(validatePublicUpgradePlan(plan, publicReviewDigest(plan), input)).toEqual(plan)
  for (const changed of [
    { ...target, version: baseline.version },
    { ...target, sourceRevision: "0".repeat(40) },
    { ...target, windowsSigning: { ...target.windowsSigning, publisher: "OTHER SIMULATED SIGNER" } },
  ])
    expect(() =>
      publicUpgradePlan({ ...input, target: changed, expectedTargetSha256: publicReviewDigest(changed) }),
    ).toThrow()
  expect(() =>
    validatePublicUpgradePlan(
      { ...plan, publication: true },
      publicReviewDigest({ ...plan, publication: true }),
      input,
    ),
  ).toThrow()
  expect(() => validatePublicUpgradePlan(plan, "0".repeat(64), input)).toThrow()
})
