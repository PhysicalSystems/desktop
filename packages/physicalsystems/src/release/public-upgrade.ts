// SPDX-License-Identifier: Apache-2.0
import { allocateDesktopVersion, compareVersion } from "./inputs"
import type { ReleaseHistory } from "./inputs"
import { validatePublicBuildInputs } from "./public-build"
import type { PublicBuildInputs } from "./public-build"
import { publicReviewDigest } from "./public-downloads"

export type PublicUpgradePlan = {
  schemaVersion: 1
  kind: "owned-public-upgrade-plan"
  baselinePurpose: "unreleased-lab-only"
  scope: "same-reviewed-source-and-storage-schema"
  sourceRevision: string
  baseline: { version: string; releaseInputsSha256: string; publicBuildInputsSha256: string }
  target: { version: string; releaseInputsSha256: string; publicBuildInputsSha256: string }
  publication: false
}

const invalid = () => new Error("PUBLIC_UPGRADE_BASELINE_INVALID")

/** Reserve a lab version in this run's immutable history before selecting the
 * strictly newer public version. The lab installer is never a public asset. */
export function publicUpgradeVersions(input: {
  history: ReleaseHistory
  channel: "preview" | "stable"
  requestedVersion?: string
}) {
  const baselineHistory = structuredClone(input.history)
  const baselineVersion = allocateDesktopVersion({ history: baselineHistory, channel: "preview" })
  const targetHistory: ReleaseHistory = { complete: true, versions: [...baselineHistory.versions, baselineVersion] }
  const targetVersion = allocateDesktopVersion({
    history: targetHistory,
    channel: input.channel,
    requestedVersion: input.requestedVersion,
  })
  return { baselineVersion, targetVersion, baselineHistory, targetHistory }
}

export function publicUpgradePlan(input: {
  baseline: PublicBuildInputs
  expectedBaselineSha256: string
  target: PublicBuildInputs
  expectedTargetSha256: string
}): PublicUpgradePlan {
  const baseline = validatePublicBuildInputs(input.baseline, input.expectedBaselineSha256)
  const target = validatePublicBuildInputs(input.target, input.expectedTargetSha256)
  if (
    baseline.sourceRevision !== target.sourceRevision ||
    compareVersion(baseline.version, target.version) >= 0 ||
    baseline.channel !== "preview" ||
    publicReviewDigest(baseline.windowsSigning) !== publicReviewDigest(target.windowsSigning)
  )
    throw invalid()
  const entry = (build: PublicBuildInputs, sha256: string) => ({
    version: build.version,
    releaseInputsSha256: build.releaseInputsSha256,
    publicBuildInputsSha256: sha256,
  })
  return {
    schemaVersion: 1,
    kind: "owned-public-upgrade-plan",
    baselinePurpose: "unreleased-lab-only",
    scope: "same-reviewed-source-and-storage-schema",
    sourceRevision: target.sourceRevision,
    baseline: entry(baseline, input.expectedBaselineSha256),
    target: entry(target, input.expectedTargetSha256),
    publication: false,
  }
}

export function validatePublicUpgradePlan(
  value: unknown,
  expectedSha256: string,
  input: Parameters<typeof publicUpgradePlan>[0],
) {
  const expected = publicUpgradePlan(input)
  if (
    !/^[a-f0-9]{64}$/.test(expectedSha256) ||
    publicReviewDigest(value) !== expectedSha256 ||
    publicReviewDigest(expected) !== expectedSha256
  )
    throw invalid()
  return structuredClone(expected)
}
