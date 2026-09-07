// SPDX-License-Identifier: Apache-2.0
import { writeSync } from "node:fs"
import { credentialBackend } from "../../../physicalsystems/src/release/credential-backend"

/** Successful provider-vault operations may emit a fixed CI backend label.
 * No credential, request payload, path or new read API crosses this boundary. */
export function credentialTrace(
  storage: Parameters<typeof credentialBackend>[0],
  io: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; write?: (fd: number, message: string) => unknown } = {},
) {
  try {
    if ((io.env ?? process.env).PHYSICALSYSTEMS_QUALIFICATION_TRACE !== "1") return
    const backend = credentialBackend(storage, io.platform)
    if (backend) (io.write ?? writeSync)(2, `PHYSICALSYSTEMS_CREDENTIAL_${backend}\n`)
  } catch {
    // Optional diagnostics cannot alter a successful production credential write.
  }
}
