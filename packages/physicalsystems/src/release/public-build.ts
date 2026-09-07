// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto"
import { lstatSync, readFileSync } from "node:fs"
import { isAbsolute } from "node:path"
import { desktopIdentity } from "./identity"
import { publicReviewDigest } from "./public-downloads"

export type PublicSigningPolicy =
  | {
      provider: "pfx"
      publisher: string
      certificateThumbprint: string
    }
  | {
      provider: "azure-trusted-signing"
      publisher: string
      endpoint: string
      account: string
      certificateProfile: string
    }
export type PublicBuildInputs = {
  schemaVersion: 1
  kind: "public-desktop-build"
  sourceRevision: string
  releaseInputsSha256: string
  version: string
  channel: "preview" | "stable"
  identity: ReturnType<typeof desktopIdentity>
  windowsSigning: PublicSigningPolicy
  publication: false
}
function exact(input: unknown, fields: string[]) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid public build input")
  const record = input as Record<string, unknown>
  if (Object.keys(record).length !== fields.length || Object.keys(record).some((key) => !fields.includes(key)))
    throw new Error("Unexpected or missing public build fields")
  return record
}
function text(input: unknown, maximum: number): input is string {
  return (
    typeof input === "string" &&
    input.length > 0 &&
    input.length <= maximum &&
    input.trim() === input &&
    !/[\x00-\x1f\x7f]/.test(input)
  )
}
/** Public identity is pinned separately from candidate inputs before compilation.
 * This record grants no publication, signing success or qualification authority.
 */
export function validatePublicBuildInputs(input: unknown, expectedSha256: string): PublicBuildInputs {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256) || publicReviewDigest(input) !== expectedSha256)
    throw new Error("Public build does not match its independently trusted digest")
  const data = exact(input, [
    "schemaVersion",
    "kind",
    "sourceRevision",
    "releaseInputsSha256",
    "version",
    "channel",
    "identity",
    "windowsSigning",
    "publication",
  ])
  if (
    data.schemaVersion !== 1 ||
    data.kind !== "public-desktop-build" ||
    data.publication !== false ||
    typeof data.sourceRevision !== "string" ||
    !/^[a-f0-9]{40}$/.test(data.sourceRevision) ||
    typeof data.releaseInputsSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(data.releaseInputsSha256) ||
    typeof data.version !== "string" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.([1-9]\d*))?$/.test(data.version) ||
    (data.channel !== "preview" && data.channel !== "stable") ||
    data.version.includes("-beta.") !== (data.channel === "preview")
  )
    throw new Error("Expected immutable publication-disabled public build inputs")
  if (publicReviewDigest(data.identity) !== publicReviewDigest(desktopIdentity("public")))
    throw new Error("Public app, profile and executable identities are fixed before compilation")
  if (!data.windowsSigning || typeof data.windowsSigning !== "object" || Array.isArray(data.windowsSigning))
    throw new Error("An explicit signing provider is required")
  const signing = data.windowsSigning as Record<string, unknown>
  if (!text(signing.publisher, 200)) throw new Error("Pin the exact expected signing publisher")
  if (signing.provider === "pfx") {
    exact(signing, ["provider", "publisher", "certificateThumbprint"])
    if (typeof signing.certificateThumbprint !== "string" || !/^[A-F0-9]{40}$/.test(signing.certificateThumbprint))
      throw new Error("Pin the expected PFX certificate thumbprint")
    return data as PublicBuildInputs
  }
  if (signing.provider === "azure-trusted-signing") {
    exact(signing, ["provider", "publisher", "endpoint", "account", "certificateProfile"])
    if (
      typeof signing.endpoint !== "string" ||
      !/^https:\/\/[a-z0-9-]+\.codesigning\.azure\.net\/?$/.test(signing.endpoint) ||
      !text(signing.account, 100) ||
      !/^[A-Za-z0-9-]+$/.test(signing.account) ||
      !text(signing.certificateProfile, 100) ||
      !/^[A-Za-z0-9-]+$/.test(signing.certificateProfile)
    )
      throw new Error("Pin the owned Azure signing endpoint, account and certificate profile")
    return data as PublicBuildInputs
  }
  throw new Error("Unsupported public signing provider; unsigned fallback is prohibited")
}

export function loadPublicBuildInputs(env: NodeJS.ProcessEnv) {
  const file = env.PHYSICALSYSTEMS_PUBLIC_BUILD_INPUTS
  if (!file || !isAbsolute(file)) throw new Error("Use a separate absolute public build input file")
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 128 * 1024)
    throw new Error("Invalid public build input file")
  const data = validatePublicBuildInputs(
    JSON.parse(readFileSync(file, "utf8")),
    env.PHYSICALSYSTEMS_EXPECTED_PUBLIC_BUILD_SHA256 ?? "",
  )
  if (env.PHYSICALSYSTEMS_EXPECTED_INPUTS_SHA256 !== data.releaseInputsSha256)
    throw new Error("Public identity is not bound to the trusted release input digest")
  return data
}

/** Called by electron-vite, never at application runtime. A packaged candidate
 * cannot adopt a public profile by setting a launch-time environment variable.
 */
export function compiledDesktopIdentity(env: NodeJS.ProcessEnv) {
  if (!env.PHYSICALSYSTEMS_PUBLIC_BUILD_INPUTS && !env.PHYSICALSYSTEMS_EXPECTED_PUBLIC_BUILD_SHA256)
    return desktopIdentity("candidate")
  return loadPublicBuildInputs(env).identity
}

/** Signing credentials remain runner-only and are not included in public inputs. */
export function publicSigningConfiguration(inputs: PublicBuildInputs, env: NodeJS.ProcessEnv, platform: string) {
  if (platform !== "win32" && platform !== "linux") throw new Error("Public desktop target is not qualified")
  if (platform === "linux") return {}
  if (inputs.windowsSigning.provider === "pfx") {
    if (
      !env.PHYSICALSYSTEMS_PFX_FILE ||
      !isAbsolute(env.PHYSICALSYSTEMS_PFX_FILE) ||
      env.WIN_CSC_KEY_PASSWORD === undefined
    )
      throw new Error("Windows public signing requires the provisioned PFX file and password")
    const stat = lstatSync(env.PHYSICALSYSTEMS_PFX_FILE)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 1024 ** 2)
      throw new Error("Invalid provisioned PFX file")
    return {
      signtoolOptions: {
        certificateFile: env.PHYSICALSYSTEMS_PFX_FILE,
        publisherName: inputs.windowsSigning.publisher,
        signingHashAlgorithms: ["sha256" as const],
      },
    }
  }
  if (!env.AZURE_TENANT_ID || !env.AZURE_CLIENT_ID || !env.AZURE_CLIENT_SECRET)
    throw new Error("Azure public signing requires the explicitly provisioned service identity")
  return {
    azureSignOptions: {
      publisherName: inputs.windowsSigning.publisher,
      endpoint: inputs.windowsSigning.endpoint,
      codeSigningAccountName: inputs.windowsSigning.account,
      certificateProfileName: inputs.windowsSigning.certificateProfile,
      fileDigest: "SHA256",
      timestampDigest: "SHA256",
    },
  }
}

export function compiledIdentityRecord(env: NodeJS.ProcessEnv, mainBytes: Uint8Array) {
  const identity = compiledDesktopIdentity(env)
  return {
    schemaVersion: 1,
    kind: "compiled-desktop-identity",
    identity: identity.kind,
    publicBuildInputsSha256: identity.kind === "public" ? env.PHYSICALSYSTEMS_EXPECTED_PUBLIC_BUILD_SHA256! : null,
    mainSha256: createHash("sha256").update(mainBytes).digest("hex"),
  }
}

export function verifyCompiledPublicIdentity(record: unknown, expectedBuildSha256: string, mainBytes: Uint8Array) {
  const data = exact(record, ["schemaVersion", "kind", "identity", "publicBuildInputsSha256", "mainSha256"])
  if (
    !/^[a-f0-9]{64}$/.test(expectedBuildSha256) ||
    data.schemaVersion !== 1 ||
    data.kind !== "compiled-desktop-identity" ||
    data.identity !== "public" ||
    data.publicBuildInputsSha256 !== expectedBuildSha256 ||
    data.mainSha256 !== createHash("sha256").update(mainBytes).digest("hex")
  )
    throw new Error(
      "Public packaging requires the exact main process compiled with these public inputs; candidate outputs cannot be relabeled",
    )
}
