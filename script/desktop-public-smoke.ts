// SPDX-License-Identifier: Apache-2.0
import { appendFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { emptyOutput, run } from "../packages/physicalsystems/src/release/commands"
import { verifyInventory } from "../packages/physicalsystems/src/release/artifacts"
import { verifyReleaseInputs } from "../packages/physicalsystems/src/release/inputs"
import type { ReleaseHistory } from "../packages/physicalsystems/src/release/inputs"
import { validatePublicBuildInputs } from "../packages/physicalsystems/src/release/public-build"
import { loadPublicUpgradeInputs } from "../packages/physicalsystems/src/release/public-upgrade-inputs"
import { publicSmokeCanContinue } from "../packages/physicalsystems/src/release/public-producer"
import {
  publicNativeJobReceipt,
  publicNativeReceipt,
  publicReceiptBytes,
  requirePublicNativeContext,
} from "../packages/physicalsystems/src/release/public-native-receipts"
import type { PublicNativeJobReceipt } from "../packages/physicalsystems/src/release/public-native-receipts"

const required = (key: string) => {
  if (!process.env[key]) throw new Error("Missing public smoke input")
  return process.env[key]!
}
const read = async (file: string) => {
  const stat = await lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || stat.size > 1024 ** 2)
    throw new Error("Invalid public smoke input")
  return JSON.parse(await readFile(file, "utf8")) as unknown
}
try {
  if (process.argv.length !== 2) throw new Error("Public smoke uses only its frozen workflow environment")
  const root = resolve(import.meta.dir, "..")
  const file = required("PUBLIC_RELEASE_INPUTS")
  const inputs = await verifyReleaseInputs({
    repoRoot: root,
    inputs: await read(file),
    history: (await read(join(dirname(file), "history.json"))) as ReleaseHistory,
    expectedRepository: "PhysicalSystems/desktop",
    expectedSha256: required("EXPECTED_RELEASE_INPUTS_SHA256"),
  })
  const publicDigest = required("EXPECTED_PUBLIC_BUILD_SHA256")
  const publicFile = required("PUBLIC_BUILD_INPUTS")
  const build = validatePublicBuildInputs(await read(publicFile), publicDigest)
  if (
    build.releaseInputsSha256 !== inputs.sha256 ||
    build.sourceRevision !== inputs.source.revision ||
    build.version !== inputs.version
  )
    throw new Error("Public smoke input binding failed")
  const upgrade = await loadPublicUpgradeInputs({ root, env: process.env })
  const baselineArtifacts = required("PUBLIC_BASELINE_BUILD_DIRECTORY")
  const baselineInventory = await verifyInventory(baselineArtifacts, upgrade.baseline)
  const artifacts = required("PUBLIC_BUILD_DIRECTORY")
  const inventory = await verifyInventory(artifacts, inputs)
  const platform = process.platform === "win32" ? "windows-x64" : "linux-x64"
  const context = { env: process.env, build, publicBuildInputsSha256: publicDigest, platform } as const
  requirePublicNativeContext(context)
  const reports = await emptyOutput(required("PUBLIC_SMOKE_DIRECTORY"), root)
  const evidence = join(dirname(reports), "private-public-smoke")
  await mkdir(evidence, { mode: 0o700 })
  const receipts: PublicNativeJobReceipt["artifacts"] = []
  for (const artifact of inventory.files) {
    const baseline = baselineInventory.files.find((file) => file.format === artifact.format)
    if (!baseline) throw new Error("Missing exact-format public lab baseline")
    const reportFile = join(evidence, `${artifact.sha256}.smoke.json`)
    await run(
      process.execPath,
      [
        join(root, "packages/physicalsystems/test/packaged-smoke.mjs"),
        "--artifact",
        join(artifacts, artifact.name),
        "--evidence",
        evidence,
        "--report",
        reportFile,
        "--version",
        inputs.version,
        "--public-inputs",
        publicFile,
        "--expected-public-build-sha256",
        publicDigest,
        "--expected-inputs-sha256",
        inputs.sha256,
        "--upgrade-plan",
        required("PUBLIC_UPGRADE_PLAN"),
        "--expected-upgrade-plan-sha256",
        required("EXPECTED_UPGRADE_PLAN_SHA256"),
        "--baseline-artifact",
        join(baselineArtifacts, baseline.name),
        "--expected-baseline-artifact-sha256",
        baseline.sha256,
        "--baseline-public-inputs",
        required("PUBLIC_BASELINE_BUILD_INPUTS"),
        "--expected-baseline-public-build-sha256",
        required("EXPECTED_BASELINE_PUBLIC_BUILD_SHA256"),
        "--expected-baseline-inputs-sha256",
        upgrade.baseline.sha256,
      ],
      root,
      process.env,
      process.env.PS_PROVIDER_REVIEW === "openai-device" ? 1_200_000 : 600_000,
    ).catch(() => {
      // A public smoke returns nonzero even when its implemented checks pass.
      // Only its exact receipt may authorize continuing to another format.
    })
    const report = await read(reportFile)
    const native = publicNativeReceipt({
      report,
      artifact,
      build,
      publicBuildInputsSha256: publicDigest,
      runId: required("GITHUB_RUN_ID"),
      runAttempt: Number(required("GITHUB_RUN_ATTEMPT")),
    })
    const smokeBytes = publicReceiptBytes(report)
    const nativeBytes = publicReceiptBytes(native)
    await writeFile(join(reports, `${smokeBytes.sha256}.json`), smokeBytes.bytes, { flag: "wx" })
    await writeFile(join(reports, `${nativeBytes.sha256}.json`), nativeBytes.bytes, { flag: "wx" })
    receipts.push({
      name: artifact.name,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      smokeSha256: smokeBytes.sha256,
      nativeSha256: nativeBytes.sha256,
    })
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        `\n${artifact.name}\n\n${native.checks.map((check) => `- ${check.id}: ${check.status}`).join("\n")}\n`,
      )
    if (!publicSmokeCanContinue({ report, artifact, build, publicBuildInputsSha256: publicDigest })) {
      console.error("Public smoke cleanup or signature state is unconfirmed; remaining artifacts were not opened")
      process.exitCode = 1
      break
    }
  }
  if (!process.exitCode) {
    const job = publicReceiptBytes(publicNativeJobReceipt({ ...context, artifacts: receipts }))
    await writeFile(join(reports, "native-job.json"), job.bytes, { flag: "wx" })
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `job_receipt_sha256=${job.sha256}\n`)
    console.log("Exact public smoke and native observations recorded; the strict collector determines qualification")
  }
} catch {
  console.error("Public smoke did not complete with confirmed ownership; no further artifact was opened or qualified")
  process.exitCode = 1
}
