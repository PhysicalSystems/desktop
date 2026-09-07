// SPDX-License-Identifier: Apache-2.0
import { lstat, readFile, realpath } from "node:fs/promises"
import { isAbsolute, sep } from "node:path"
import { desktopIdentity } from "./identity"
import { releaseInputDigest } from "./inputs"
import { publicReviewDigest } from "./public-downloads"
import { validatePublicBuildInputs, verifyCompiledPublicIdentity } from "./public-build"
import type { PublicBuildInputs } from "./public-build"
import type { qualificationReport } from "./qualification"

export type PackagedQualificationOptions = {
  artifact: string
  evidence: string
  report: string
  version: string
  inspectionOnly?: boolean
  "executable-name"?: string
  "public-inputs"?: string
  "expected-public-build-sha256"?: string
  "expected-inputs-sha256"?: string
}

export function packagedQualificationArguments(args: string[]): PackagedQualificationOptions {
  const options: Record<string, string | boolean> = {}
  const flags = [
    "artifact",
    "evidence",
    "report",
    "version",
    "executable-name",
    "public-inputs",
    "expected-public-build-sha256",
    "expected-inputs-sha256",
  ]
  for (let i = 0; i < args.length; i++) {
    const key = args[i] === "--inspection-only" ? "inspectionOnly" : args[i]?.slice(2)
    if (!args[i]?.startsWith("--") || key in options || (key !== "inspectionOnly" && !flags.includes(key)))
      throw new Error("INVALID_QUALIFICATION_ARGUMENTS")
    if (key === "inspectionOnly") {
      options[key] = true
      continue
    }
    const value = args[++i]
    if (!value || value.startsWith("--")) throw new Error("INVALID_QUALIFICATION_ARGUMENTS")
    options[key] = value
  }
  if (["artifact", "evidence", "report", "version"].some((key) => !options[key]))
    throw new Error("ARTIFACT_EVIDENCE_REPORT_VERSION_REQUIRED")
  const publicFlags = ["public-inputs", "expected-public-build-sha256", "expected-inputs-sha256"]
  if (
    publicFlags.some((key) => key in options) &&
    (publicFlags.some((key) => !(key in options)) ||
      "executable-name" in options ||
      !isAbsolute(String(options["public-inputs"])) ||
      publicFlags.slice(1).some((key) => !/^[a-f0-9]{64}$/.test(String(options[key]))))
  )
    throw new Error("PUBLIC_QUALIFICATION_ARGUMENTS_INVALID")
  return options as PackagedQualificationOptions
}

export type PublicQualification = {
  build: PublicBuildInputs
  publicBuildInputsSha256: string
  releaseInputsSha256: string
}

export async function loadPublicQualification(
  options: PackagedQualificationOptions,
): Promise<PublicQualification | undefined> {
  if (!["public-inputs", "expected-public-build-sha256", "expected-inputs-sha256"].some((key) => key in options)) return
  try {
    if (
      !options["public-inputs"] ||
      !isAbsolute(options["public-inputs"]) ||
      options["executable-name"] ||
      !/^[a-f0-9]{64}$/.test(options["expected-public-build-sha256"] || "") ||
      !/^[a-f0-9]{64}$/.test(options["expected-inputs-sha256"] || "")
    )
      throw new Error()
    const stat = await lstat(options["public-inputs"])
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 128 * 1024) throw new Error()
    const build = validatePublicBuildInputs(
      JSON.parse(await readFile(options["public-inputs"], "utf8")),
      options["expected-public-build-sha256"] || "",
    )
    if (build.releaseInputsSha256 !== options["expected-inputs-sha256"] || build.version !== options.version)
      throw new Error()
    return {
      build,
      publicBuildInputsSha256: options["expected-public-build-sha256"]!,
      releaseInputsSha256: options["expected-inputs-sha256"]!,
    }
  } catch {
    throw new Error("PACKAGED_PUBLIC_INPUTS_INVALID")
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/** Checks the final ASAR, not the build staging directory or caller labels. */
export function verifyPublicPackagedIdentity(
  mode: PublicQualification,
  input: {
    metadata: unknown
    releaseInputs: unknown
    publicInputs: unknown
    compiledIdentity: unknown
    mainBytes: Uint8Array
  },
) {
  try {
    validatePublicBuildInputs(mode.build, mode.publicBuildInputsSha256)
    if (mode.build.releaseInputsSha256 !== mode.releaseInputsSha256) throw new Error()
    const release = input.releaseInputs
    if (
      !record(input.metadata) ||
      input.metadata.name !== desktopIdentity("public").packageName ||
      input.metadata.version !== mode.build.version ||
      !record(release) ||
      !record(release.source) ||
      release.sha256 !== mode.releaseInputsSha256 ||
      releaseInputDigest(release) !== mode.releaseInputsSha256 ||
      release.source.revision !== mode.build.sourceRevision ||
      release.version !== mode.build.version ||
      release.channel !== mode.build.channel ||
      publicReviewDigest(validatePublicBuildInputs(input.publicInputs, mode.publicBuildInputsSha256)) !==
        publicReviewDigest(mode.build)
    )
      throw new Error()
    verifyCompiledPublicIdentity(input.compiledIdentity, mode.publicBuildInputsSha256, input.mainBytes)
    return {
      identity: "public" as const,
      publicBuildInputsSha256: mode.publicBuildInputsSha256,
      mainSha256: (input.compiledIdentity as { mainSha256: string }).mainSha256,
    }
  } catch {
    throw new Error("PACKAGED_PUBLIC_IDENTITY_MISMATCH")
  }
}

/** Public installers have real desktop integration; run them only in disposable CI. */
export async function requireDisposablePublicRunner(env: NodeJS.ProcessEnv, root: string, platform = process.platform) {
  if (
    !["linux", "win32"].includes(platform) ||
    env.CI !== "true" ||
    env.GITHUB_ACTIONS !== "true" ||
    env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    env.RUNNER_OS !== (platform === "win32" ? "Windows" : "Linux") ||
    !/^[1-9]\d*$/.test(env.GITHUB_RUN_ID || "") ||
    !isAbsolute(env.RUNNER_TEMP || "")
  )
    throw new Error("PUBLIC_QUALIFICATION_REQUIRES_DISPOSABLE_RUNNER")
  const [owned, temporary, stat] = await Promise.all([realpath(root), realpath(env.RUNNER_TEMP!), lstat(root)])
  if (!stat.isDirectory() || stat.isSymbolicLink() || temporary === sep || !owned.startsWith(temporary + sep))
    throw new Error("PUBLIC_QUALIFICATION_PATH_OUTSIDE_RUNNER")
}

export function verifyPublicAuthenticode(input: unknown, policy: PublicBuildInputs["windowsSigning"]) {
  if (
    !record(input) ||
    input.Status !== "Valid" ||
    typeof input.Thumbprint !== "string" ||
    !/^[a-fA-F0-9]{40}$/.test(input.Thumbprint) ||
    input.Publisher !== policy.publisher
  )
    throw new Error("PACKAGED_PUBLIC_SIGNATURE_INVALID")
  const thumbprint = input.Thumbprint.toUpperCase()
  if (policy.provider === "pfx" && thumbprint !== policy.certificateThumbprint)
    throw new Error("PACKAGED_PUBLIC_SIGNATURE_POLICY_MISMATCH")
  return { status: "PASS" as const, publisher: policy.publisher, certificateThumbprint: thumbprint }
}

export function verifyPublicSignaturePair(input: {
  installer: unknown
  executable: unknown
  mode: PublicQualification
  installerSha256: string
  executableSha256: string
}) {
  const installer = verifyPublicAuthenticode(input.installer, input.mode.build.windowsSigning)
  const executable = verifyPublicAuthenticode(input.executable, input.mode.build.windowsSigning)
  if (![input.installerSha256, input.executableSha256].every((digest) => /^[a-f0-9]{64}$/.test(digest)))
    throw new Error("PACKAGED_PUBLIC_SIGNATURE_INVALID")
  // Both certificates are recorded. Azure certificates can rotate; the pinned
  // service configuration comes from the independently anchored build inputs.
  return {
    status: "PASS" as const,
    policy: input.mode.build.windowsSigning,
    installer: { ...installer, sha256: input.installerSha256 },
    executable: { ...executable, sha256: input.executableSha256 },
  }
}

export const unimplementedPublicChecks = [
  "native-credential-storage",
  "provider-browser-sign-in",
  "fresh-install",
  "upgrade",
  "failed-upgrade-recovery",
  "uninstall-reinstall",
  "configuration-preservation",
  "platform-display",
] as const

/** A public-identity smoke report is deliberately never a QualifiedDistribution. */
export function unqualifiedPublicSmokeReport(input: {
  base: ReturnType<typeof qualificationReport>
  mode: PublicQualification
  compiledIdentity?: ReturnType<typeof verifyPublicPackagedIdentity>
  signing?: ReturnType<typeof verifyPublicSignaturePair>
}) {
  if (input.base.checks.some((check) => unimplementedPublicChecks.some((id) => id === check.id)))
    throw new Error("PUBLIC_QUALIFICATION_UNIMPLEMENTED_CHECK_OVERRIDE")
  const name = input.base.artifact.name.toLowerCase()
  const required = [
    "public-compiled-identity",
    ...(name.endsWith(".exe")
      ? ["public-signing", "uninstall"]
      : [
          "linux-sandbox-setup",
          "linux-renderer-sandbox",
          ...(name.endsWith(".deb") ? ["uninstall"] : ["appimage-launcher", "linux-sandbox-cleanup"]),
        ]),
  ]
  const completed =
    !!input.compiledIdentity &&
    (!name.endsWith(".exe") || !!input.signing) &&
    required.every((id) => input.base.checks.some((check) => check.id === id && check.status === "PASS"))
  return {
    ...input.base,
    kind: "unqualified-public-desktop-smoke" as const,
    result: "UNQUALIFIED" as const,
    smokeResult: input.base.result === "PASS" && !completed ? ("NOT_TESTED" as const) : input.base.result,
    publication: false as const,
    identity: desktopIdentity("public"),
    sourceRevision: input.mode.build.sourceRevision,
    publicBuildInputsSha256: input.mode.publicBuildInputsSha256,
    releaseInputsSha256: input.mode.releaseInputsSha256,
    compiledIdentity: input.compiledIdentity,
    signing: input.signing || { status: "NOT_TESTED" as const },
    checks: [
      ...input.base.checks,
      ...unimplementedPublicChecks.map((id) => ({
        id,
        status: "NOT_TESTED" as const,
        detail: "This packaged simulation smoke does not exercise this public distribution requirement.",
      })),
    ],
    publicDistribution: {
      status: "BLOCKED" as const,
      reason:
        "Public identity smoke only: native distribution qualification is incomplete; this report grants no publication authority.",
    },
  }
}
