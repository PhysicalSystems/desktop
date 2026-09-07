// SPDX-License-Identifier: Apache-2.0
/** Product identity is a build-time decision. Public preview/stable use the same
 * installation and profile, so changing channels requires qualified upgrade
 * behavior. Candidate data and installed application identity remain separate.
 */
export function desktopIdentity(kind: "candidate" | "public") {
  if (kind === "candidate")
    return {
      kind,
      appId: "systems.physical.desktop.development",
      productName: "Physical Systems Candidate",
      runtimeName: "Physical Systems Development",
      profileDirectory: "physicalsystems-opencode-development",
      executableName: "physical-systems-candidate",
      packageName: "physical-systems-desktop-candidate",
      launcherSource: "AppRun",
      desktopEntry: "physical-systems-candidate.desktop",
    } as const
  if (kind === "public")
    return {
      kind,
      appId: "systems.physical.desktop",
      productName: "Physical Systems",
      runtimeName: "Physical Systems",
      profileDirectory: "physicalsystems-desktop",
      executableName: "physical-systems-desktop",
      packageName: "physical-systems-desktop",
      launcherSource: "AppRun.public",
      desktopEntry: "physical-systems-desktop.desktop",
    } as const
  throw new Error("Unknown compiled desktop identity")
}
