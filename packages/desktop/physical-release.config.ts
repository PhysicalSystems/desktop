// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs"
import type { Configuration } from "electron-builder"

const file = process.env.PHYSICALSYSTEMS_RELEASE_INPUTS
if (!file) throw new Error("Use script/desktop-release.ts build with verified release inputs")
const inputs = JSON.parse(readFileSync(file, "utf8"))
if (
  inputs.schemaVersion !== 1 ||
  inputs.publication !== false ||
  !/^\d+\.\d+\.\d+(?:-beta\.[1-9]\d*)?$/.test(inputs.version)
) {
  throw new Error("Expected publication-disabled desktop candidate inputs")
}

// This candidate retains the isolated development identity. Production signing,
// updater feeds and public application identity require separate qualification.
const config: Configuration = {
  appId: "systems.physical.desktop.development",
  productName: "Physical Systems Candidate",
  buildVersion: inputs.version,
  buildNumber: "0",
  directories: { output: "candidate-dist" },
  electronDist: "node_modules/electron/dist",
  npmRebuild: false,
  files: ["out/**/*", "resources/entitlements.plist"],
  extraResources: [{ from: "icons/physicalsystems", to: "icons", filter: ["*.png", "*.ico", "*.icns", "!source.png"] }],
  extraMetadata: {
    name: "physical-systems-desktop-candidate",
    version: inputs.version,
    description: "Physical Systems Desktop — isolated simulation candidate",
    homepage: "https://physicalsystems.ai",
    author: "Physical Systems",
  },
  asar: true,
  publish: null,
  win: {
    icon: "icons/physicalsystems/icon.ico",
    target: [{ target: "nsis", arch: ["x64"] }],
    artifactName: "physical-systems-desktop-${version}-windows-${arch}.${ext}",
    signExecutable: false,
    verifyUpdateCodeSignature: true,
  },
  nsis: {
    installerIcon: "icons/physicalsystems/icon.ico",
    uninstallerIcon: "icons/physicalsystems/icon.ico",
    installerHeaderIcon: "icons/physicalsystems/icon.ico",
    oneClick: true,
    perMachine: false,
    allowElevation: false,
    runAfterFinish: false,
    createDesktopShortcut: false,
    createStartMenuShortcut: false,
    uninstallDisplayName: "Physical Systems Candidate",
  },
  linux: {
    icon: "icons/physicalsystems/icon.png",
    // Pinned builder copies appOutDir over its generated AppRun before creating
    // the final AppImage. Qualification checks the resulting launcher bytes.
    extraFiles: [{ from: "resources/AppRun", to: "AppRun" }],
    target: [
      { target: "deb", arch: ["x64"] },
      { target: "AppImage", arch: ["x64"] },
    ],
    artifactName: "physical-systems-desktop-${version}-linux-x64.${ext}",
    executableName: "physical-systems-candidate",
    category: "Development",
  },
  appImage: { executableArgs: [] },
  deb: { maintainer: "Physical Systems", packageName: "physical-systems-desktop-candidate" },
}

export default config
