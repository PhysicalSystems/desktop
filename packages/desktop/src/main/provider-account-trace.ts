// SPDX-License-Identifier: Apache-2.0
import { writeSync } from "node:fs"
import { providerAccountMarker } from "../../../physicalsystems/src/release/provider-account"

export function providerAccountTrace(
  operation: unknown,
  input: unknown,
  result: unknown,
  io: { env?: NodeJS.ProcessEnv; write?: (fd: number, value: string) => unknown } = {},
) {
  try {
    const marker = providerAccountMarker(operation, input, result, io.env ?? process.env)
    if (marker) (io.write ?? writeSync)(2, marker)
  } catch {
    // Optional observations never affect credential persistence or return secrets.
  }
}
