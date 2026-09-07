// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises"
import { proposeWebsiteSelection } from "../packages/physicalsystems/src/release/website-promotion"
import { mergeWebsiteSelection, waitForWebsiteSelection } from "../packages/physicalsystems/src/release/website-merge"

try {
  const args = process.argv.slice(2)
  if (
    ![4, 5].includes(args.length) ||
    args[0] !== "--selection" ||
    args[2] !== "--expected-sha256" ||
    (args.length === 5 && args[4] !== "--merge-after-checks")
  )
    throw new Error("Use --selection FILE --expected-sha256 DIGEST [--merge-after-checks]")
  const input = {
    bytes: await readFile(args[1]),
    expectedSha256: args[3],
    token: process.env.DESKTOP_WEBSITE_TOKEN || "",
  }
  const proposed = await proposeWebsiteSelection(input)
  const result =
    proposed.url && args.length === 5 ? await mergeWebsiteSelection({ ...input, url: proposed.url }) : proposed
  console.log(
    result.url
      ? `Website selection ${result.status}: ${result.url}`
      : "Website already selects these verified downloads",
  )
  if (args.length === 5) {
    await waitForWebsiteSelection({ bytes: input.bytes })
    console.log(
      "The production website now serves the verified download selection: https://physicalsystems.ai/download",
    )
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Website promotion failed")
  process.exitCode = 1
}
