// SPDX-License-Identifier: Apache-2.0
import type { Configuration } from "electron-builder"

// Deliberately separate from upstream signing, protocol registration and feeds.
// This config prepares an unpacked review app; installer qualification is separate.
const config: Configuration = {
  appId: "systems.physical.desktop.development",
  productName: "Physical Systems Development",
  artifactName: "physical-systems-review-${os}-${arch}.${ext}",
  directories: { output: "review-dist" },
  electronDist: "node_modules/electron/dist",
  npmRebuild: false,
  files: ["out/**/*", "resources/**/*", "!resources/opencode-cli*"],
  extraMetadata: { version: "0.0.0-physical-review.1", name: "physical-systems-desktop-review" },
  publish: null,
  mac: { target: "dir", identity: null, notarize: false },
  win: { target: "dir", signAndEditExecutable: false },
  linux: { target: "dir", executableName: "physical-systems-review", category: "Development" },
}
export default config
