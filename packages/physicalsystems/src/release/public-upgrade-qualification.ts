// SPDX-License-Identifier: Apache-2.0
import { lstat, readFile } from "node:fs/promises"
import { basename, isAbsolute } from "node:path"
import { candidateNames } from "./artifacts"
import { packagedQualificationArguments, loadPublicQualification } from "./public-qualification"
import type { PublicQualification } from "./public-qualification"
import { sha256File } from "./qualification"
import { validatePublicUpgradePlan } from "./public-upgrade"

const flags = [
  "upgrade-plan",
  "expected-upgrade-plan-sha256",
  "baseline-artifact",
  "expected-baseline-artifact-sha256",
  "baseline-public-inputs",
  "expected-baseline-public-build-sha256",
  "expected-baseline-inputs-sha256",
] as const
export type PublicUpgradeQualificationOptions = Partial<Record<(typeof flags)[number], string>>
const invalid = () => new Error("PUBLIC_UPGRADE_QUALIFICATION_INVALID")

/** Upgrade flags are all-or-none and only augment public qualification. They
 * cannot change candidate executable identity or grant permission to publish. */
export function upgradeQualificationArguments(args: string[]) {
  const regular: string[] = []
  const upgrade: PublicUpgradeQualificationOptions = {}
  for (let index = 0; index < args.length; index++) {
    const key = args[index]?.slice(2) as (typeof flags)[number]
    if (!args[index]?.startsWith("--") || !flags.includes(key)) {
      regular.push(args[index]!)
      continue
    }
    const value = args[++index]
    if (key in upgrade || !value || value.startsWith("--")) throw invalid()
    upgrade[key] = value
  }
  const options = packagedQualificationArguments(regular)
  if (
    Object.keys(upgrade).length &&
    (!options["public-inputs"] ||
      options.inspectionOnly ||
      flags.some((key) => !upgrade[key]) ||
      flags.some((key) =>
        key.startsWith("expected-") ? !/^[a-f0-9]{64}$/.test(upgrade[key]!) : !isAbsolute(upgrade[key]!),
      ))
  )
    throw invalid()
  return { options, upgrade }
}

export async function loadPublicUpgradeQualification(
  options: PublicUpgradeQualificationOptions,
  target?: PublicQualification,
) {
  if (!Object.keys(options).length) return
  if (!target || flags.some((key) => !options[key])) throw invalid()
  const read = async (file: string) => {
    const stat = await lstat(file)
    if (!isAbsolute(file) || !stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 128 * 1024)
      throw invalid()
    return JSON.parse(await readFile(file, "utf8")) as unknown
  }
  const planValue = await read(options["upgrade-plan"]!)
  // The plan does not supply its own authority; its exact digest and both build
  // digests came independently from the source preparation job.
  const version = (planValue as { baseline?: { version?: unknown } }).baseline?.version
  if (typeof version !== "string") throw invalid()
  const baseline = await loadPublicQualification({
    artifact: options["baseline-artifact"]!,
    evidence: "/unused",
    report: "/unused",
    version,
    "public-inputs": options["baseline-public-inputs"],
    "expected-public-build-sha256": options["expected-baseline-public-build-sha256"],
    "expected-inputs-sha256": options["expected-baseline-inputs-sha256"],
  })
  if (!baseline) throw invalid()
  const builds = {
    baseline: baseline.build,
    target: target.build,
    expectedBaselineSha256: baseline.publicBuildInputsSha256,
    expectedTargetSha256: target.publicBuildInputsSha256,
  }
  const plan = validatePublicUpgradePlan(planValue, options["expected-upgrade-plan-sha256"]!, builds)
  const artifact = options["baseline-artifact"]!
  const stat = await lstat(artifact)
  if (
    !isAbsolute(artifact) ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 1 ||
    !candidateNames(plan.baseline.version, process.platform === "win32" ? "windows-x64" : "linux-x64").some(
      (file) => file.name === basename(artifact),
    ) ||
    (await sha256File(artifact)) !== options["expected-baseline-artifact-sha256"]
  )
    throw invalid()
  return {
    plan,
    builds,
    baseline,
    baselineArtifact: artifact,
    baselineArtifactSha256: options["expected-baseline-artifact-sha256"]!,
    planSha256: options["expected-upgrade-plan-sha256"]!,
  }
}
