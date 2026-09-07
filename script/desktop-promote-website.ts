// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises"
import { proposeWebsiteSelection } from "../packages/physicalsystems/src/release/website-promotion"

try {
  const args = process.argv.slice(2)
  if (args.length !== 4 || args[0] !== "--selection" || args[2] !== "--expected-sha256")
    throw new Error("Use --selection FILE --expected-sha256 DIGEST")
  const result = await proposeWebsiteSelection({
    bytes: await readFile(args[1]),
    expectedSha256: args[3],
    token: process.env.DESKTOP_WEBSITE_TOKEN || "",
  })
  console.log(result.url ? `Website selection PR: ${result.url}` : "Website already selects these verified downloads")
} catch (error) {
  console.error(error instanceof Error ? error.message : "Website promotion failed")
  process.exitCode = 1
}
