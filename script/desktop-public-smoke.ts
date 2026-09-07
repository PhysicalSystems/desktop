// SPDX-License-Identifier: Apache-2.0
import { lstat, mkdir, readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { emptyOutput, run } from "../packages/physicalsystems/src/release/commands"
import { verifyInventory } from "../packages/physicalsystems/src/release/artifacts"
import { verifyReleaseInputs } from "../packages/physicalsystems/src/release/inputs"
import type { ReleaseHistory } from "../packages/physicalsystems/src/release/inputs"
import { validatePublicBuildInputs } from "../packages/physicalsystems/src/release/public-build"
import {
  incompletePublicQualification,
  publicSmokeCanContinue,
} from "../packages/physicalsystems/src/release/public-producer"

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
  const artifacts = required("PUBLIC_BUILD_DIRECTORY")
  const inventory = await verifyInventory(artifacts, inputs)
  const reports = await emptyOutput(required("PUBLIC_SMOKE_DIRECTORY"), root)
  const evidence = join(dirname(reports), "private-public-smoke")
  await mkdir(evidence, { mode: 0o700 })
  for (const artifact of inventory.files) {
    const reportFile = join(reports, `${artifact.sha256}.json`)
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
      ],
      root,
    ).catch(() => {
      // A public smoke returns nonzero even when its implemented checks pass.
      // Only its exact receipt may authorize continuing to another format.
    })
    if (
      !publicSmokeCanContinue({
        report: await read(reportFile),
        artifact,
        build,
        publicBuildInputsSha256: publicDigest,
      })
    ) {
      console.error("Public smoke cleanup or signature state is unconfirmed; remaining artifacts were not opened")
      break
    }
  }
  console.error(incompletePublicQualification)
  process.exitCode = 1
} catch {
  console.error("Public smoke did not complete with confirmed ownership; no further artifact was opened or qualified")
  process.exitCode = 1
}
