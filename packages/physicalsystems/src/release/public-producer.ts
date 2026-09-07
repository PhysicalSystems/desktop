// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { desktopIdentity } from "./identity"
import { releaseInputDigest } from "./inputs"
import type { ReleaseInputs } from "./inputs"
import { validatePublicBuildInputs, validatePublicSigningPolicy } from "./public-build"
import type { PublicSigningPolicy } from "./public-build"
import { publicReviewDigest } from "./public-downloads"
import type { CandidateArtifact } from "./artifacts"
import type { PublicBuildInputs } from "./public-build"

export class PublicProducerError extends Error {}

export type PublicProducerPolicy = {
  schemaVersion: 1
  kind: "public-desktop-producer-policy"
  sourceRevision: string
  windowsSigning: PublicSigningPolicy
  publication: false
}

/** Called before dependency installation or access to signing credentials. */
export function freezePublicProducerPolicy(env: NodeJS.ProcessEnv): PublicProducerPolicy {
  if (
    env.GITHUB_REPOSITORY !== "PhysicalSystems/desktop" ||
    env.GITHUB_REF !== "refs/heads/main" ||
    env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "")
  )
    throw new PublicProducerError("Public builds require an owned main dispatch at its exact workflow commit")
  if (env.DESKTOP_PUBLIC_BUILD_ENABLED !== "true")
    throw new PublicProducerError("Public builds are disabled until signing policy and credentials are provisioned")
  try {
    const text = env.DESKTOP_WINDOWS_SIGNING_POLICY
    if (!text || text.length > 8192) throw new Error("Missing policy")
    return {
      schemaVersion: 1,
      kind: "public-desktop-producer-policy",
      sourceRevision: env.GITHUB_SHA!,
      windowsSigning: structuredClone(validatePublicSigningPolicy(JSON.parse(text))),
      publication: false,
    }
  } catch {
    throw new PublicProducerError("Provision a valid DESKTOP_WINDOWS_SIGNING_POLICY; unsigned fallback is prohibited")
  }
}

export function validatePublicProducerPolicy(input: unknown, expectedSha256: string, sourceRevision: string) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256) || publicReviewDigest(input) !== expectedSha256)
    throw new PublicProducerError("Frozen signing policy differs from its trusted preparation digest")
  const data = input as PublicProducerPolicy
  if (
    !data ||
    typeof data !== "object" ||
    Object.keys(data).sort().join(",") !== "kind,publication,schemaVersion,sourceRevision,windowsSigning" ||
    data.schemaVersion !== 1 ||
    data.kind !== "public-desktop-producer-policy" ||
    data.publication !== false ||
    !/^[a-f0-9]{40}$/.test(sourceRevision) ||
    data.sourceRevision !== sourceRevision
  )
    throw new PublicProducerError("Frozen public policy does not belong to this exact source commit")
  validatePublicSigningPolicy(data.windowsSigning)
  return data
}

/** ReleaseInputs are independently source-verified by the preparation command. */
export function preparePublicProducerInputs(input: {
  policy: unknown
  expectedPolicySha256: string
  sourceRevision: string
  release: ReleaseInputs
  expectedInputsSha256: string
}) {
  const policy = validatePublicProducerPolicy(input.policy, input.expectedPolicySha256, input.sourceRevision)
  if (
    !/^[a-f0-9]{64}$/.test(input.expectedInputsSha256) ||
    input.release.sha256 !== input.expectedInputsSha256 ||
    releaseInputDigest(input.release) !== input.expectedInputsSha256 ||
    input.release.source.repository !== "PhysicalSystems/desktop" ||
    input.release.source.revision !== policy.sourceRevision ||
    input.release.publication !== false
  )
    throw new PublicProducerError(
      "Public build preparation must bind the exact verified release input digest and source",
    )
  const build = {
    schemaVersion: 1,
    kind: "public-desktop-build",
    sourceRevision: policy.sourceRevision,
    releaseInputsSha256: input.expectedInputsSha256,
    version: input.release.version,
    channel: input.release.channel,
    identity: desktopIdentity("public"),
    windowsSigning: structuredClone(policy.windowsSigning),
    publication: false,
  }
  const sha256 = publicReviewDigest(build)
  return { inputs: validatePublicBuildInputs(build, sha256), sha256 }
}

/** Materialize a PFX only within the Windows build step; never serialize its
 * bytes, password or path into immutable inputs or upload directories. */
export async function withPublicWindowsSigning<T>(
  policy: PublicSigningPolicy,
  env: NodeJS.ProcessEnv,
  operation: (env: NodeJS.ProcessEnv) => Promise<T>,
) {
  validatePublicSigningPolicy(policy)
  const clean = Object.fromEntries(
    Object.entries(env).filter(([key]) => !/^(PHYSICALSYSTEMS_PFX_|WIN_CSC_|CSC_|AZURE_)/i.test(key)),
  )
  if (policy.provider === "azure-trusted-signing") {
    if (!env.AZURE_TENANT_ID || !env.AZURE_CLIENT_ID || !env.AZURE_CLIENT_SECRET)
      throw new PublicProducerError("Provision the Azure signing service identity before running a public build")
    return operation({
      ...clean,
      AZURE_TENANT_ID: env.AZURE_TENANT_ID,
      AZURE_CLIENT_ID: env.AZURE_CLIENT_ID,
      AZURE_CLIENT_SECRET: env.AZURE_CLIENT_SECRET,
    })
  }
  const encoded = env.PHYSICALSYSTEMS_PFX_BASE64
  if (
    !encoded ||
    encoded.length > 1_398_104 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded) ||
    !env.WIN_CSC_KEY_PASSWORD
  )
    throw new PublicProducerError("Provision the bounded base64 PFX and its password before running a public build")
  const bytes = Buffer.from(encoded, "base64")
  if (!bytes.length || bytes.length > 1024 ** 2 || bytes.toString("base64") !== encoded)
    throw new PublicProducerError("The provisioned PFX encoding is invalid")
  const directory = await mkdtemp(join(tmpdir(), "desktop-public-signing-"))
  try {
    const file = join(directory, "certificate.pfx")
    await writeFile(file, bytes, { flag: "wx", mode: 0o600 })
    bytes.fill(0)
    return await operation({ ...clean, PHYSICALSYSTEMS_PFX_FILE: file, WIN_CSC_KEY_PASSWORD: env.WIN_CSC_KEY_PASSWORD })
  } finally {
    bytes.fill(0)
    await rm(directory, { recursive: true, force: true })
  }
}

export const incompletePublicQualification =
  "PUBLIC_NATIVE_QUALIFICATION_INCOMPLETE: Build and smoke receipts remain unqualified. Verified installer/payload signatures, native credential storage, provider browser sign-in, installation/upgrade/failure recovery, configuration preservation and platform display evidence are required for every exact public artifact. No qualified distribution, release, tag or website selection was produced."

/** Continue to another format only after this exact artifact reports confirmed
 * application, private-service, temporary-directory and installation cleanup. Missing native qualification is allowed
 * here solely to collect more evidence; it never grants release eligibility. */
export function publicSmokeCanContinue(input: {
  report: unknown
  artifact: CandidateArtifact
  build: PublicBuildInputs
  publicBuildInputsSha256: string
}) {
  const report = input.report as {
    kind?: unknown
    result?: unknown
    publication?: unknown
    sourceRevision?: unknown
    publicBuildInputsSha256?: unknown
    releaseInputsSha256?: unknown
    artifact?: { name?: unknown; bytes?: unknown; sha256?: unknown }
    checks?: { id?: unknown; status?: unknown }[]
  }
  if (
    !report ||
    report.kind !== "unqualified-public-desktop-smoke" ||
    report.result !== "UNQUALIFIED" ||
    report.publication !== false ||
    report.sourceRevision !== input.build.sourceRevision ||
    report.publicBuildInputsSha256 !== input.publicBuildInputsSha256 ||
    report.releaseInputsSha256 !== input.build.releaseInputsSha256 ||
    report.artifact?.name !== input.artifact.name ||
    report.artifact.bytes !== input.artifact.bytes ||
    report.artifact.sha256 !== input.artifact.sha256 ||
    !Array.isArray(report.checks) ||
    report.checks.some(
      (check) =>
        !check ||
        typeof check.id !== "string" ||
        !["PASS", "FAIL", "NOT_TESTED", "BLOCKED"].includes(String(check.status)),
    ) ||
    new Set(report.checks.map((check) => check.id)).size !== report.checks.length
  )
    throw new PublicProducerError("Public smoke receipt does not identify the exact build and installer bytes")
  const passed = (id: string) => report.checks!.find((check) => check.id === id)?.status === "PASS"
  return (
    passed("cleanup") &&
    passed(input.artifact.format === "AppImage" ? "linux-sandbox-cleanup" : "uninstall") &&
    (input.artifact.format === "nsis" ||
      (passed("native-secret-service-cleanup") && passed("linux-temporary-cleanup"))) &&
    (input.artifact.format !== "nsis" || passed("public-signing")) &&
    !report.checks.some((check) => /signing|signature/.test(String(check.id)) && check.status !== "PASS")
  )
}
