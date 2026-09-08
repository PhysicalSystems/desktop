// SPDX-License-Identifier: Apache-2.0
import { constants } from "node:fs"
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"
import type { CandidatePlatform } from "./artifacts"
import { validatePublicBuildInputs } from "./public-build"
import { collectPublicDistribution } from "./public-collector"
import type { PublicCollectionPlan } from "./public-collector"
import { publicReviewDigest } from "./public-downloads"
import { publicReceiptBytes, validatePublicNativeJob } from "./public-native-receipts"
import { PublicProducerError } from "./public-producer"
import { sha256File } from "./qualification"

const invalid = () => new PublicProducerError("PUBLIC_COLLECTION_JOB_INPUT_INVALID")

/** The expected native-job hashes arrive through two distinct trusted workflow
 * job outputs. Never derive either expected hash from these downloaded files. */
export async function collectPublicProducer(input: {
  env: NodeJS.ProcessEnv
  publicBuild: unknown
  expectedPublicBuildSha256: string
  expectedInputsSha256: string
  windows: { artifacts: string; receipts: string; expectedJobSha256: string }
  linux: { artifacts: string; receipts: string; expectedJobSha256: string }
  staging: string
  output: string
}) {
  const build = validatePublicBuildInputs(input.publicBuild, input.expectedPublicBuildSha256)
  const runId = input.env.GITHUB_RUN_ID || ""
  const runAttempt = Number(input.env.GITHUB_RUN_ATTEMPT)
  if (
    input.env.GITHUB_REPOSITORY !== "PhysicalSystems/desktop" ||
    input.env.GITHUB_REF !== "refs/heads/main" ||
    input.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    input.env.GITHUB_SHA !== build.sourceRevision ||
    input.expectedInputsSha256 !== build.releaseInputsSha256
  )
    throw invalid()
  const plan: PublicCollectionPlan = {
    schemaVersion: 1,
    kind: "public-desktop-collection-plan",
    runId,
    runAttempt,
    sourceRevision: build.sourceRevision,
    releaseInputsSha256: build.releaseInputsSha256,
    publicBuildInputsSha256: input.expectedPublicBuildSha256,
    artifacts: [],
  }
  const sources: { source: string; name: string; sha256: string; bytes?: number }[] = []
  for (const [platform, job] of [
    ["windows-x64", input.windows],
    ["linux-x64", input.linux],
  ] as const) {
    for (const folder of [job.artifacts, job.receipts]) {
      if (!isAbsolute(folder) || (await realpath(folder)) !== resolve(folder)) throw invalid()
      const stat = await lstat(folder)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid()
    }
    const bytes = await receiptBytes(join(job.receipts, "native-job.json"), job.expectedJobSha256)
    const native = validatePublicNativeJob(JSON.parse(bytes), {
      build,
      publicBuildInputsSha256: input.expectedPublicBuildSha256,
      platform: platform as CandidatePlatform,
      runId,
      runAttempt,
    })
    const receiptNames = [
      ...new Set([
        "native-job.json",
        ...native.artifacts.flatMap((item) => [`${item.smokeSha256}.json`, `${item.nativeSha256}.json`]),
      ]),
    ]
    if ((await readdir(job.receipts)).sort().join(",") !== receiptNames.sort().join(",")) throw invalid()
    for (const artifact of native.artifacts) {
      plan.artifacts.push(artifact)
      sources.push({
        source: join(job.artifacts, artifact.name),
        name: artifact.name,
        sha256: artifact.sha256,
        bytes: artifact.bytes,
      })
      for (const sha256 of [artifact.smokeSha256, artifact.nativeSha256]) {
        const name = `${sha256}.json`
        await receiptBytes(join(job.receipts, name), sha256)
        sources.push({ source: join(job.receipts, name), name, sha256 })
      }
    }
  }
  const directories = [input.staging, input.output]
  for (const folder of directories) {
    if (
      !isAbsolute(folder) ||
      resolve(folder) !== folder ||
      (await realpath(dirname(folder))) !== dirname(folder) ||
      [input.windows.artifacts, input.windows.receipts, input.linux.artifacts, input.linux.receipts].some(
        (source) => folder === source || folder.startsWith(source + sep) || source.startsWith(folder + sep),
      )
    )
      throw invalid()
  }
  if (
    input.staging === input.output ||
    input.staging.startsWith(input.output + sep) ||
    input.output.startsWith(input.staging + sep)
  )
    throw invalid()
  await mkdir(input.staging, { mode: 0o700 })
  for (const source of sources) {
    const stat = await lstat(source.source)
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (source.bytes !== undefined && stat.size !== source.bytes) ||
      (await sha256File(source.source)) !== source.sha256
    )
      throw invalid()
    await copyFile(source.source, join(input.staging, source.name), constants.COPYFILE_EXCL)
    if ((await sha256File(join(input.staging, source.name))) !== source.sha256) throw invalid()
  }
  // This plan is synthesized solely from the independently anchored job outputs.
  // Preserve it outside the strict flat evidence directory for durable review.
  const frozen = publicReceiptBytes(plan)
  await writeFile(`${input.staging}.plan.json`, frozen.bytes, { flag: "wx", mode: 0o600 })
  return collectPublicDistribution({
    plan,
    expectedPlanSha256: publicReviewDigest(plan),
    publicBuild: build,
    expectedPublicBuildSha256: input.expectedPublicBuildSha256,
    expectedInputsSha256: input.expectedInputsSha256,
    sourceRevision: build.sourceRevision,
    runId,
    runAttempt,
    evidence: input.staging,
    output: input.output,
  })
}

async function receiptBytes(file: string, sha256: string) {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw invalid()
  const stat = await lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 256 * 1024) throw invalid()
  const bytes = await readFile(file, "utf8")
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw invalid()
  return bytes
}
