// SPDX-License-Identifier: Apache-2.0
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join } from "node:path"
import { gunzipSync } from "node:zlib"
import { emptyOutput } from "./commands"
import { prepareReleaseInputs, verifyReleaseInputs } from "./inputs"
import type { ReleaseHistory } from "./inputs"
import { preparePublicProducerInputs, validatePublicProducerPolicy } from "./public-producer"
import { validatePublicBuildInputs } from "./public-build"
import { publicReviewDigest } from "./public-downloads"
import { publicUpgradePlan, publicUpgradeVersions, validatePublicUpgradePlan } from "./public-upgrade"

/** One preparation transaction freezes both versions from the same clean,
 * reviewed source. No signing credential, package installation or publication. */
export async function preparePublicUpgradeInputs(input: {
  root: string
  sourceRevision: string
  history: ReleaseHistory
  channel: "preview" | "stable"
  requestedVersion?: string
  policy: unknown
  expectedPolicySha256: string
  output: string
}) {
  const policy = validatePublicProducerPolicy(input.policy, input.expectedPolicySha256, input.sourceRevision)
  const versions = publicUpgradeVersions(input)
  const baseline = await prepareReleaseInputs({
    repoRoot: input.root,
    repository: "PhysicalSystems/desktop",
    channel: "preview",
    version: versions.baselineVersion,
    history: versions.baselineHistory,
  })
  const target = await prepareReleaseInputs({
    repoRoot: input.root,
    repository: "PhysicalSystems/desktop",
    channel: input.channel,
    version: versions.targetVersion,
    history: versions.targetHistory,
  })
  if (baseline.source.revision !== input.sourceRevision || target.source.revision !== input.sourceRevision)
    throw new Error("PUBLIC_UPGRADE_SOURCE_CHANGED")
  const prepared = (release: typeof target) =>
    preparePublicProducerInputs({
      policy,
      expectedPolicySha256: input.expectedPolicySha256,
      sourceRevision: input.sourceRevision,
      release,
      expectedInputsSha256: release.sha256,
    })
  const baselinePublic = prepared(baseline)
  const targetPublic = prepared(target)
  const plan = publicUpgradePlan({
    baseline: baselinePublic.inputs,
    expectedBaselineSha256: baselinePublic.sha256,
    target: targetPublic.inputs,
    expectedTargetSha256: targetPublic.sha256,
  })
  const output = await emptyOutput(input.output, input.root)
  const baselineOutput = join(output, "baseline")
  await mkdir(baselineOutput, { mode: 0o700 })
  const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n"
  for (const [directory, release, build, history] of [
    [output, target, targetPublic.inputs, versions.targetHistory],
    [baselineOutput, baseline, baselinePublic.inputs, versions.baselineHistory],
  ] as const) {
    await writeFile(join(directory, "release-inputs.json"), json(release), { flag: "wx" })
    await writeFile(join(directory, "public-build-inputs.json"), json(build), { flag: "wx" })
    await writeFile(join(directory, "history.json"), json(history), { flag: "wx" })
    await writeFile(
      join(directory, "models.dev-api.json"),
      gunzipSync(await readFile(join(input.root, release.modelCatalog.path))),
      { flag: "wx" },
    )
  }
  await writeFile(join(output, "upgrade-plan.json"), json(plan), { flag: "wx" })
  return {
    inputs_sha256: target.sha256,
    public_build_sha256: targetPublic.sha256,
    version: target.version,
    baseline_inputs_sha256: baseline.sha256,
    baseline_public_build_sha256: baselinePublic.sha256,
    baseline_version: baseline.version,
    upgrade_plan_sha256: publicReviewDigest(plan),
  }
}

/** Load the same independently anchored pair before any build secret or native
 * installer is used. Ambient paths carry no authority without both digests. */
export async function loadPublicUpgradeInputs(input: { root: string; env: NodeJS.ProcessEnv }) {
  const required = (key: string) => {
    if (!input.env[key]) throw new Error("PUBLIC_UPGRADE_INPUT_MISSING")
    return input.env[key]!
  }
  const read = async (file: string) => {
    if (!isAbsolute(file)) throw new Error("PUBLIC_UPGRADE_INPUT_INVALID")
    const stat = await lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 1024 ** 2)
      throw new Error("PUBLIC_UPGRADE_INPUT_INVALID")
    return JSON.parse(await readFile(file, "utf8")) as unknown
  }
  const release = async (fileKey: string, digestKey: string) => {
    const file = required(fileKey)
    return verifyReleaseInputs({
      repoRoot: input.root,
      inputs: await read(file),
      history: (await read(join(dirname(file), "history.json"))) as ReleaseHistory,
      expectedRepository: "PhysicalSystems/desktop",
      expectedSha256: required(digestKey),
    })
  }
  const target = await release("PUBLIC_RELEASE_INPUTS", "EXPECTED_RELEASE_INPUTS_SHA256")
  const baseline = await release("PUBLIC_BASELINE_RELEASE_INPUTS", "EXPECTED_BASELINE_RELEASE_INPUTS_SHA256")
  const targetPublic = validatePublicBuildInputs(
    await read(required("PUBLIC_BUILD_INPUTS")),
    required("EXPECTED_PUBLIC_BUILD_SHA256"),
  )
  const baselinePublic = validatePublicBuildInputs(
    await read(required("PUBLIC_BASELINE_BUILD_INPUTS")),
    required("EXPECTED_BASELINE_PUBLIC_BUILD_SHA256"),
  )
  for (const [build, frozen] of [
    [targetPublic, target],
    [baselinePublic, baseline],
  ] as const)
    if (
      build.releaseInputsSha256 !== frozen.sha256 ||
      build.version !== frozen.version ||
      build.sourceRevision !== frozen.source.revision ||
      build.channel !== frozen.channel
    )
      throw new Error("PUBLIC_UPGRADE_INPUT_BINDING_INVALID")
  const builds = {
    baseline: baselinePublic,
    expectedBaselineSha256: required("EXPECTED_BASELINE_PUBLIC_BUILD_SHA256"),
    target: targetPublic,
    expectedTargetSha256: required("EXPECTED_PUBLIC_BUILD_SHA256"),
  }
  const plan = validatePublicUpgradePlan(
    await read(required("PUBLIC_UPGRADE_PLAN")),
    required("EXPECTED_UPGRADE_PLAN_SHA256"),
    builds,
  )
  return { target, baseline, targetPublic, baselinePublic, plan, builds }
}
