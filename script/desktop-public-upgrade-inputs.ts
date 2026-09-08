// SPDX-License-Identifier: Apache-2.0
import { appendFile, lstat, readFile } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import type { ReleaseHistory } from "../packages/physicalsystems/src/release/inputs"
import { preparePublicUpgradeInputs } from "../packages/physicalsystems/src/release/public-upgrade-inputs"

try {
  if (
    process.argv.length !== 2 ||
    process.env.GITHUB_REPOSITORY !== "PhysicalSystems/desktop" ||
    process.env.GITHUB_REF !== "refs/heads/main" ||
    process.env.GITHUB_EVENT_NAME !== "workflow_dispatch"
  )
    throw new Error()
  const required = (key: string) => {
    if (!process.env[key]) throw new Error()
    return process.env[key]!
  }
  const read = async (file: string) => {
    if (!isAbsolute(file)) throw new Error()
    const stat = await lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 1024 * 1024) throw new Error()
    return JSON.parse(await readFile(file, "utf8")) as unknown
  }
  const channel = required("CHANNEL")
  if (channel !== "preview" && channel !== "stable") throw new Error()
  const result = await preparePublicUpgradeInputs({
    root: resolve(import.meta.dir, ".."),
    sourceRevision: required("GITHUB_SHA"),
    history: (await read(required("PUBLIC_RELEASE_HISTORY"))) as ReleaseHistory,
    channel,
    requestedVersion: process.env.REQUESTED_VERSION || undefined,
    policy: await read(required("PUBLIC_POLICY_FILE")),
    expectedPolicySha256: required("EXPECTED_POLICY_SHA256"),
    output: required("PUBLIC_INPUT_DIRECTORY"),
  })
  if (process.env.GITHUB_OUTPUT)
    await appendFile(
      process.env.GITHUB_OUTPUT,
      Object.entries(result)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
    )
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `\nFrozen public target ${result.version} and lower unreleased lab baseline ${result.baseline_version}. The lab shares reviewed source/storage schema, has no publication authority and is excluded from public assets. Upgrade plan SHA-256: \`${result.upgrade_plan_sha256}\`.\n`,
    )
  console.log("Public target and separate owned lab baseline inputs frozen; no installer was built or published")
} catch {
  console.error(
    "PUBLIC_UPGRADE_PREPARATION_FAILED: require clean reviewed source, complete history, frozen signing policy and a target version later than the owned lab baseline",
  )
  process.exitCode = 1
}
