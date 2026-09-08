// SPDX-License-Identifier: Apache-2.0
// Test support only: all bytes, signing observations and probe outcomes here are
// explicitly simulated. Nothing in this module installs, launches or signs an app.
import { createHash } from "node:crypto"
import { candidateNames } from "./artifacts"
import type { CandidatePlatform } from "./artifacts"
import { desktopIdentity } from "./identity"
import type { PublicBuildInputs } from "./public-build"
import { publicReviewDigest } from "./public-downloads"
import { publicNativeProbeIds } from "./public-native-receipts"
import { unqualifiedPublicSmokeReport, verifyPublicSignaturePair } from "./public-qualification"
import { qualificationReport, requiredQualificationChecks } from "./qualification"

export function simulatedPublicNativeFixture(platform: CandidatePlatform = "windows-x64", index = 0, complete = false) {
  const build: PublicBuildInputs = {
    schemaVersion: 1,
    kind: "public-desktop-build",
    sourceRevision: "a".repeat(40),
    releaseInputsSha256: "b".repeat(64),
    version: "0.1.0-beta.1",
    channel: "preview",
    identity: desktopIdentity("public"),
    publication: false,
    windowsSigning: { provider: "pfx", publisher: "SIMULATED FIXTURE ONLY", certificateThumbprint: "C".repeat(40) },
  }
  const publicBuildInputsSha256 = publicReviewDigest(build)
  const name = candidateNames(build.version, platform)[index]!
  const bytes = `SIMULATED INERT INSTALLER: ${name.name}`
  const artifact = {
    ...name,
    bytes: Buffer.byteLength(bytes),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sha512: "unused-fixture",
  }
  const mode = { build, publicBuildInputsSha256, releaseInputsSha256: build.releaseInputsSha256 }
  const windows = platform === "windows-x64"
  const observed = { Status: "Valid", Publisher: build.windowsSigning.publisher, Thumbprint: "C".repeat(40) }
  const signing = windows
    ? verifyPublicSignaturePair({
        installer: observed,
        executable: observed,
        mode,
        installerSha256: artifact.sha256,
        executableSha256: "d".repeat(64),
      })
    : undefined
  const ids = [
    ...requiredQualificationChecks,
    "public-compiled-identity",
    "native-credential-probe",
    ...(windows
      ? ["public-signing", "uninstall", "native-reinstall-probe"]
      : [
          "linux-sandbox-setup",
          "linux-renderer-sandbox",
          "native-secret-service-cleanup",
          "linux-temporary-cleanup",
          ...(artifact.format === "deb"
            ? ["uninstall", "native-reinstall-probe"]
            : ["appimage-launcher", "linux-sandbox-cleanup"]),
        ]),
    ...(complete
      ? [...publicNativeProbeIds, ...(artifact.format === "AppImage" ? ["native-reinstall-probe"] : [])]
      : []),
  ]
  const base = qualificationReport({
    artifact: artifact.name,
    artifactBytes: artifact.bytes,
    artifactSha256: artifact.sha256,
    version: build.version,
    checks: ids.map((id) => ({ id, status: "PASS" as const, detail: "SIMULATED FIXTURE ONLY" })),
    signature: windows
      ? { status: "PASS", trust: "WINDOWS_AUTHENTICODE_VALID", signerThumbprint: "C".repeat(40) }
      : { status: "NOT_TESTED", trust: "NOT_APPLICABLE_TO_LINUX_PACKAGE" },
    payload: { sha256: "e".repeat(64), executableSha256: "d".repeat(64) },
    inputsSha256: build.releaseInputsSha256,
    sourceRevision: build.sourceRevision,
  })
  const report = unqualifiedPublicSmokeReport({
    base: { ...base, platform },
    mode,
    signing,
    compiledIdentity: { identity: "public", publicBuildInputsSha256, mainSha256: "f".repeat(64) },
  })
  const env = {
    CI: "true",
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "PhysicalSystems/desktop",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: build.sourceRevision,
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_RUN_ID: "12345",
    GITHUB_RUN_ATTEMPT: "1",
    RUNNER_ENVIRONMENT: "github-hosted",
    RUNNER_OS: windows ? "Windows" : "Linux",
  }
  return { build, publicBuildInputsSha256, artifact, bytes, report, env, runId: "12345", runAttempt: 1 }
}
