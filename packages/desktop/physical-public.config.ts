// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs"
import type { Configuration } from "electron-builder"
import {
  loadPublicBuildInputs,
  publicSigningConfiguration,
  verifyCompiledPublicIdentity,
} from "../physicalsystems/src/release/public-build"

const inputs = loadPublicBuildInputs(process.env)
const identity = inputs.identity
verifyCompiledPublicIdentity(
  JSON.parse(readFileSync("out/legal/physical-build-identity.json", "utf8")),
  process.env.PHYSICALSYSTEMS_EXPECTED_PUBLIC_BUILD_SHA256 ?? "",
  readFileSync("out/main/index.js"),
)
// Only an anchored preview policy may disable signing. Signed builds still fail
// on missing credentials; executable icon and version resource editing stay enabled.
const config: Configuration = {
  appId: identity.appId,
  productName: identity.productName,
  buildVersion: inputs.version,
  buildNumber: "0",
  directories: { output: "public-dist" },
  electronDist: "node_modules/electron/dist",
  npmRebuild: false,
  files: ["out/**/*", "resources/entitlements.plist"],
  extraMetadata: {
    name: identity.packageName,
    version: inputs.version,
    description: "Physical Systems Desktop",
    homepage: "https://physicalsystems.ai",
    author: "Physical Systems",
  },
  asar: true,
  publish: null,
  forceCodeSigning: inputs.windowsSigning.provider !== "unsigned-preview",
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    artifactName: "physical-systems-desktop-${version}-windows-${arch}.${ext}",
    signExecutable: inputs.windowsSigning.provider !== "unsigned-preview",
    verifyUpdateCodeSignature: true,
    ...publicSigningConfiguration(inputs, process.env, process.platform),
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    allowElevation: false,
    // Open after interactive installation; NSIS /S installs remain silent.
    runAfterFinish: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    uninstallDisplayName: identity.productName,
  },
  linux: {
    extraFiles: [{ from: `resources/${identity.launcherSource}`, to: "AppRun" }],
    target: [
      { target: "deb", arch: ["x64"] },
      { target: "AppImage", arch: ["x64"] },
    ],
    artifactName: "physical-systems-desktop-${version}-linux-x64.${ext}",
    executableName: identity.executableName,
    category: "Development",
  },
  appImage: { executableArgs: [] },
  deb: { maintainer: "Physical Systems", packageName: identity.packageName },
}
export default config
