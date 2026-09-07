// SPDX-License-Identifier: Apache-2.0
import { appendFile, lstat, readFile, realpath } from "node:fs/promises"
import { isAbsolute, resolve, sep } from "node:path"
import { collectPublicDistribution } from "../packages/physicalsystems/src/release/public-collector"

try {
  const flags = [
    "plan",
    "expected-plan-sha256",
    "public-inputs",
    "expected-public-build-sha256",
    "expected-inputs-sha256",
    "source-sha",
    "run-id",
    "run-attempt",
    "evidence",
    "output",
  ]
  const options: Record<string, string> = {}
  const args = process.argv.slice(2)
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.slice(2)
    if (
      !args[index]?.startsWith("--") ||
      !flags.includes(key) ||
      key in options ||
      !args[index + 1] ||
      args[index + 1].startsWith("--")
    )
      throw new Error()
    options[key] = args[index + 1]
  }
  if (flags.some((key) => !options[key]) || !/^[1-9]\d*$/.test(options["run-attempt"])) throw new Error()
  const root = resolve(import.meta.dir, "..")
  for (const key of ["evidence", "output"])
    if (!isAbsolute(options[key]) || resolve(options[key]) === root || resolve(options[key]).startsWith(root + sep))
      throw new Error()
  if (
    process.env.GITHUB_ACTIONS === "true" &&
    (process.env.GITHUB_REPOSITORY !== "PhysicalSystems/desktop" ||
      process.env.GITHUB_REF !== "refs/heads/main" ||
      process.env.GITHUB_SHA !== options["source-sha"] ||
      process.env.GITHUB_RUN_ID !== options["run-id"] ||
      process.env.GITHUB_RUN_ATTEMPT !== options["run-attempt"])
  )
    throw new Error()
  const read = async (file: string) => {
    if (!isAbsolute(file) || (await realpath(file)) !== resolve(file)) throw new Error()
    const stat = await lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 256 * 1024) throw new Error()
    return JSON.parse(await readFile(file, "utf8")) as unknown
  }
  const result = await collectPublicDistribution({
    plan: await read(options.plan),
    expectedPlanSha256: options["expected-plan-sha256"],
    publicBuild: await read(options["public-inputs"]),
    expectedPublicBuildSha256: options["expected-public-build-sha256"],
    expectedInputsSha256: options["expected-inputs-sha256"],
    sourceRevision: options["source-sha"],
    runId: options["run-id"],
    runAttempt: Number(options["run-attempt"]),
    evidence: options.evidence,
    output: options.output,
  })
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `qualification_sha256=${result.sha256}\n`)
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `Collected all three exact public installer formats for ${result.record.facts.version}.\n\nSource: \`${result.record.facts.sourceRevision}\`. Qualified distribution SHA-256: \`${result.sha256}\`.\n\nThis collection step does not publish installers or select website downloads.\n`,
    )
  console.log(`Public installer evidence collected. Qualification SHA-256: ${result.sha256}`)
} catch {
  console.error(
    "PUBLIC_COLLECTION_FAILED: exact signed public artifacts and complete independently anchored native evidence are required; no publication occurred",
  )
  process.exitCode = 1
}
