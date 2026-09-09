// SPDX-License-Identifier: Apache-2.0
import {
  buildPublicDesktop,
  PublicBuildProvisioningError,
} from "../packages/physicalsystems/src/release/public-build-command"

await buildPublicDesktop(process.argv.slice(2))
  .then((record) => {
    console.log(
      `Built public-identity ${record.version} ${record.platform} installers. Native qualification and signing-policy verification remain unconfirmed; publication disabled.`,
    )
  })
  .catch((error: unknown) => {
    // Child tools print their own build diagnostics. Never echo arbitrary thrown
    // data from a signer or a credential-bearing environment at this boundary.
    console.error(
      error instanceof PublicBuildProvisioningError
        ? error.message
        : "Public desktop build failed. Check the anchored inputs and build stage; no qualification or publication was granted.",
    )
    process.exitCode = 1
  })
