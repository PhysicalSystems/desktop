// SPDX-License-Identifier: Apache-2.0
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  preparePublicPublication,
  publishPreparedPublication,
  validatePublisherPrerequisites,
} from "../packages/physicalsystems/src/release/public-publisher"
import { createHash } from "node:crypto"

try {
  const command = process.argv[2]
  if (process.argv.length !== 3 || !["preflight", "prepare", "publish"].includes(command ?? ""))
    throw new Error("Use desktop-public-release.ts preflight|prepare|publish with the documented environment")
  const required = (key: string) => {
    const value = process.env[key]
    if (!value) throw new Error(`Missing ${key}`)
    return value
  }
  const output = async (name: string, value: string) => {
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`)
  }
  if (command === "preflight") {
    if (required("GITHUB_REPOSITORY") !== "PhysicalSystems/desktop" || required("GITHUB_REF") !== "refs/heads/main")
      throw new Error("Public publisher must run reviewed main in the owned desktop repository")
    if (process.env.DESKTOP_PUBLIC_RELEASE_ENABLED !== "true")
      throw new Error(
        "Public publishing is disabled until the declared signing policy, native qualification and protected credentials are ready",
      )
    const token = required("GH_TOKEN")
    const get = async (endpoint: string) => {
      const response = await fetch(`https://api.github.com/repos/PhysicalSystems/desktop/${endpoint}`, {
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }).catch(() => {
        throw new Error("Publisher prerequisite transport failed")
      })
      if (!response.ok) throw new Error(`Publisher prerequisite could not be read (${response.status})`)
      return response.json().catch(() => {
        throw new Error("Publisher prerequisite returned malformed metadata")
      }) as Promise<unknown>
    }
    const runId = required("QUALIFICATION_RUN_ID")
    const runAttempt = required("QUALIFICATION_RUN_ATTEMPT")
    if (!/^[1-9]\d*$/.test(runId) || !/^[1-9]\d*$/.test(runAttempt))
      throw new Error("Invalid qualification run identity")
    const [run, attempt, environment] = await Promise.all([
      get(`actions/runs/${runId}`),
      get(`actions/runs/${runId}/attempts/${runAttempt}`),
      get("environments/desktop-public-release"),
    ])
    validatePublisherPrerequisites({
      run,
      attempt,
      environment,
      runId,
      runAttempt,
      sourceRevision: required("GITHUB_SHA"),
    })
    if (!/^[a-f0-9]{64}$/.test(required("EXPECTED_QUALIFICATION_SHA256")))
      throw new Error("Missing separately trusted qualification digest")
    console.log("Public producer identity and final approval protection verified")
  } else {
    const work = required("PUBLICATION_OUTPUT")
    await mkdir(work, { recursive: true })
    const common = {
      directory: required("QUALIFICATION_DIR"),
      expectedSha256: required("EXPECTED_QUALIFICATION_SHA256"),
      sourceRevision: required("GITHUB_SHA"),
      token: required("DESKTOP_RELEASE_TOKEN"),
    }
    if (command === "prepare") {
      const result = await preparePublicPublication(common)
      await writeFile(path.join(work, "prepared-publication.json"), JSON.stringify(result.prepared, null, 2) + "\n", {
        flag: "wx",
      })
      await output("prepared_sha256", result.preparedSha256)
      if (process.env.GITHUB_STEP_SUMMARY)
        await appendFile(
          process.env.GITHUB_STEP_SUMMARY,
          `Draft ready for final approval: release ID **${result.prepared.releaseId}**, tag **${result.prepared.tag}**.\n\nPrepared SHA-256: \`${result.preparedSha256}\`. All installer bytes are uploaded and verified; no public download selection exists yet.\n`,
        )
    } else {
      const result = await publishPreparedPublication({
        ...common,
        prepared: await readFile(required("PREPARED_PUBLICATION"), "utf8").then((bytes) => {
          try {
            return JSON.parse(bytes) as unknown
          } catch {
            throw new Error("Prepared publication must be valid JSON")
          }
        }),
        expectedPreparedSha256: required("EXPECTED_PREPARED_SHA256"),
        approvedRunUrl: `https://github.com/PhysicalSystems/desktop/actions/runs/${required("GITHUB_RUN_ID")}`,
      })
      await writeFile(path.join(work, "public-review.json"), JSON.stringify(result.review, null, 2) + "\n", {
        flag: "wx",
      })
      const selectionBytes = JSON.stringify(result.selection, null, 2) + "\n"
      await writeFile(path.join(work, "desktop-selection.json"), selectionBytes, { flag: "wx" })
      await output("review_sha256", result.reviewSha256)
      await output("selection_sha256", createHash("sha256").update(selectionBytes).digest("hex"))
      if (process.env.GITHUB_STEP_SUMMARY)
        await appendFile(
          process.env.GITHUB_STEP_SUMMARY,
          `Published exact qualified bytes: [${result.review.tag}](https://github.com/${result.review.repository}/releases/tag/${result.review.tag}).\n\nAnonymous Windows/Linux downloads passed complete hash readback. Public review SHA-256: \`${result.reviewSha256}\`.\n\nHeadless UI blanking passed; optical/display flicker was not measured.\n`,
        )
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Public desktop publication failed")
  process.exitCode = 1
}
