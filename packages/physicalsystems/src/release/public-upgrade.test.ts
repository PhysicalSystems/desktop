// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { publicReviewDigest } from "./public-downloads"
import { simulatedPublicNativeFixture } from "./public-native-fixture"
import { publicUpgradePlan, publicUpgradeVersions, validatePublicUpgradePlan } from "./public-upgrade"

test("first public upgrade uses a strictly older unreleased lab allocation without requiring a prior qualified release", () => {
  expect(publicUpgradeVersions({ history: { complete: true, versions: [] }, channel: "preview" })).toEqual({
    baselineVersion: "0.1.0-beta.1",
    targetVersion: "0.1.0-beta.2",
    baselineHistory: { complete: true, versions: [] },
    targetHistory: { complete: true, versions: ["0.1.0-beta.1"] },
  })
  expect(
    publicUpgradeVersions({ history: { complete: true, versions: [] }, channel: "stable", requestedVersion: "0.1.0" })
      .targetVersion,
  ).toBe("0.1.0")
  expect(() =>
    publicUpgradeVersions({
      history: { complete: true, versions: [] },
      channel: "preview",
      requestedVersion: "0.1.0-beta.1",
    }),
  ).toThrow()
  const history = { complete: true as const, versions: ["0.1.0"] }
  const next = publicUpgradeVersions({ history, channel: "preview" })
  expect(next.baselineVersion).toBe("0.1.1-beta.1")
  expect(next.targetVersion).toBe("0.1.1-beta.2")
  expect(history.versions).toEqual(["0.1.0"])
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
