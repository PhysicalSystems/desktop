// SPDX-License-Identifier: Apache-2.0
import { desktopRelease } from "../packages/physicalsystems/src/release/commands"

await desktopRelease(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Desktop candidate preparation failed")
  process.exitCode = 1
})
