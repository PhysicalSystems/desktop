// SPDX-License-Identifier: Apache-2.0
import { appendFile, lstat, readFile, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { emptyOutput } from "../packages/physicalsystems/src/release/commands"
import { verifyReleaseInputs } from "../packages/physicalsystems/src/release/inputs"
import type { ReleaseHistory } from "../packages/physicalsystems/src/release/inputs"
import { validatePublicBuildInputs } from "../packages/physicalsystems/src/release/public-build"
import {
  buildPublicDesktop,
  PublicBuildProvisioningError,
} from "../packages/physicalsystems/src/release/public-build-command"
import { publicReviewDigest } from "../packages/physicalsystems/src/release/public-downloads"
import {
  freezePublicProducerPolicy,
  incompletePublicQualification,
  preparePublicProducerInputs,
  PublicProducerError,
  withPublicWindowsSigning,
} from "../packages/physicalsystems/src/release/public-producer"

const root = resolve(import.meta.dir, "..")
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n"
const required = (key: string) => {
  if (!process.env[key]) throw new PublicProducerError(`Missing ${key}`)
  return process.env[key]!
}
const read = async (file: string) => {
  if (!isAbsolute(file)) throw new PublicProducerError("Producer inputs must use absolute paths")
  const stat = await lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || stat.size > 1024 ** 2)
    throw new PublicProducerError("Producer inputs must be bounded regular files")
  return JSON.parse(await readFile(file, "utf8")) as unknown
}
const output = async (key: string, value: string) => {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${key}=${value}\n`)
}

try {
  const command = process.argv[2]
  if (process.argv.length !== 3 || !["preflight", "prepare", "build-windows", "incomplete"].includes(command ?? ""))
    throw new PublicProducerError("Use desktop-public-producer.ts preflight|prepare|build-windows|incomplete")
  if (command === "preflight") {
    const policy = freezePublicProducerPolicy(process.env)
    const directory = await emptyOutput(required("PUBLIC_POLICY_DIRECTORY"), root)
    await writeFile(join(directory, "producer-policy.json"), json(policy), { flag: "wx" })
    await output("source_sha", policy.sourceRevision)
    await output("policy_sha256", publicReviewDigest(policy))
    console.log("Owned main source and explicit signing policy frozen; no signing credentials accessed")
  } else if (command === "prepare") {
    const file = required("PUBLIC_RELEASE_INPUTS")
    const release = await verifyReleaseInputs({
      repoRoot: root,
      inputs: await read(file),
      history: (await read(join(dirname(file), "history.json"))) as ReleaseHistory,
      expectedRepository: "PhysicalSystems/desktop",
      expectedSha256: required("EXPECTED_RELEASE_INPUTS_SHA256"),
    })
    const prepared = preparePublicProducerInputs({
      policy: await read(required("PUBLIC_POLICY_FILE")),
      expectedPolicySha256: required("EXPECTED_POLICY_SHA256"),
      sourceRevision: required("GITHUB_SHA"),
      release,
      expectedInputsSha256: required("EXPECTED_RELEASE_INPUTS_SHA256"),
    })
    await writeFile(join(dirname(file), "public-build-inputs.json"), json(prepared.inputs), { flag: "wx" })
    await output("inputs_sha256", release.sha256)
    await output("public_build_sha256", prepared.sha256)
    await output("version", release.version)
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        `Public build inputs frozen for ${release.version} at ${release.source.revision}.\n\nRelease input SHA-256: \`${release.sha256}\`.\n\nPublic build SHA-256: \`${prepared.sha256}\`.\n\nInstallers and smoke results remain unqualified; this workflow cannot publish.\n`,
      )
  } else if (command === "build-windows") {
    if (process.platform !== "win32")
      throw new PublicProducerError("The signing build step requires its native Windows runner")
    const file = required("PUBLIC_BUILD_INPUTS")
    const expected = required("EXPECTED_PUBLIC_BUILD_SHA256")
    const inputs = validatePublicBuildInputs(await read(file), expected)
    await withPublicWindowsSigning(inputs.windowsSigning, process.env, (env) =>
      buildPublicDesktop(
        [
          "--inputs",
          required("PUBLIC_RELEASE_INPUTS"),
          "--public-inputs",
          file,
          "--expected-inputs-sha256",
          required("EXPECTED_RELEASE_INPUTS_SHA256"),
          "--expected-public-build-sha256",
          expected,
          "--platform",
          "windows-x64",
          "--output",
          required("PUBLIC_BUILD_DIRECTORY"),
        ],
        { env },
      ),
    )
  } else {
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(process.env.GITHUB_STEP_SUMMARY, `${incompletePublicQualification}\n`)
    throw new PublicProducerError(incompletePublicQualification)
  }
} catch (error) {
  console.error(
    error instanceof PublicProducerError || error instanceof PublicBuildProvisioningError
      ? error.message
      : "Public desktop producer failed; no qualification or publication authority was granted",
  )
  process.exitCode = 1
}
