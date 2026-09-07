// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto"
import { candidateNames } from "./artifacts"

const repository = "PhysicalSystems/physicalsystems"
const requiredChecks = [
  "artifact-integrity",
  "bundled-runtime",
  "desktop-version",
  "launch",
  "device-isolation",
  "synthetic-chat",
  "inline-approval",
  "reload",
  "cleanup",
  "native-credential-storage",
  "provider-browser-sign-in",
  "fresh-install",
  "upgrade",
  "failed-upgrade-recovery",
  "uninstall-reinstall",
  "configuration-preservation",
  "platform-display",
] as const

/** This record must come from a protected public-distribution approval job.
 * Its shape, booleans and self-computed digest do not authenticate approval.
 * The caller must obtain expectedReviewSha256 through that separate trusted path.
 * The current unsigned candidate workflow cannot produce this record.
 */
export type PublicDistributionReview = {
  schemaVersion: 1
  kind: "approved-public-desktop-distribution"
  repository: typeof repository
  version: string
  channel: "preview" | "stable"
  tag: string
  releaseId: number
  sourceRevision: string
  inputsSha256: string
  identity: { appId: string; productName: "Physical Systems" }
  approval: { decision: "approved"; protectedRunUrl: string; qualificationBundleSha256: string }
  windowsSigning: {
    status: "verified"
    publisher: string
    certificateThumbprint: string
    installerSha256: string
    executableSha256: string
    verificationReportSha256: string
  }
  assets: {
    name: string
    bytes: number
    sha256: string
    qualification: { reportSha256: string; checks: Record<(typeof requiredChecks)[number], "PASS"> }
  }[]
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`
  }
  const result = JSON.stringify(value)
  if (result === undefined) throw new Error("Public review must contain only JSON values")
  return result
}

export function publicReviewDigest(review: unknown) {
  return createHash("sha256").update(canonical(review)).digest("hex")
}

function object(value: unknown, keys: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Malformed public distribution review")
  const result = value as Record<string, unknown>
  if (Object.keys(result).length !== keys.length || Object.keys(result).some((key) => !keys.includes(key))) {
    throw new Error("Unexpected or missing public distribution fields")
  }
  return result
}

function digest(value: unknown, length = 64): value is string {
  return typeof value === "string" && value.length === length && /^[a-f0-9]+$/.test(value)
}

function safeText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    !/[\x00-\x1f\x7f]/.test(value)
  )
}

export function validateReview(input: unknown, expectedReviewSha256: string): PublicDistributionReview {
  if (!digest(expectedReviewSha256) || publicReviewDigest(input) !== expectedReviewSha256) {
    throw new Error("Public review does not match the separately trusted approval digest")
  }
  const review = object(input, [
    "schemaVersion",
    "kind",
    "repository",
    "version",
    "channel",
    "tag",
    "releaseId",
    "sourceRevision",
    "inputsSha256",
    "identity",
    "approval",
    "windowsSigning",
    "assets",
  ])
  if (
    review.schemaVersion !== 1 ||
    review.kind !== "approved-public-desktop-distribution" ||
    review.repository !== repository
  )
    throw new Error("A protected public distribution review is required; candidate inputs are ineligible")
  if (!Number.isSafeInteger(review.releaseId) || Number(review.releaseId) <= 0)
    throw new Error("Public release source and identity must be immutable")
  const approval = object(review.approval, ["decision", "protectedRunUrl", "qualificationBundleSha256"])
  if (
    approval.decision !== "approved" ||
    !safeText(approval.protectedRunUrl, 300) ||
    !/^https:\/\/github\.com\/PhysicalSystems\/[A-Za-z0-9_.-]+\/actions\/runs\/[1-9]\d*$/.test(
      approval.protectedRunUrl,
    ) ||
    !digest(approval.qualificationBundleSha256)
  )
    throw new Error("Protected public qualification and approval evidence is required")
  validateDistributionFacts(Object.fromEntries(distributionFields.map((key) => [key, review[key]])))
  return review as PublicDistributionReview
}

export type PublicDistributionFacts = Pick<
  PublicDistributionReview,
  | "repository"
  | "version"
  | "channel"
  | "tag"
  | "sourceRevision"
  | "inputsSha256"
  | "identity"
  | "windowsSigning"
  | "assets"
>
const distributionFields = [
  "repository",
  "version",
  "channel",
  "tag",
  "sourceRevision",
  "inputsSha256",
  "identity",
  "windowsSigning",
  "assets",
] as const

/** Qualification facts share every public identity, signing and per-format check.
 * Validation of facts alone grants no publication approval.
 */
export function validateDistributionFacts(input: unknown): PublicDistributionFacts {
  const review = object(input, [...distributionFields])
  if (review.repository !== repository) throw new Error("Unexpected public download repository")
  if (
    !safeText(review.version, 80) ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.([1-9]\d*))?$/.test(review.version)
  )
    throw new Error("Invalid public desktop version")
  if (
    (review.channel !== "preview" && review.channel !== "stable") ||
    review.version.includes("-beta.") !== (review.channel === "preview") ||
    review.tag !== `desktop-v${review.version}`
  )
    throw new Error("Public release tag and channel must identify the reviewed version")
  if (!digest(review.sourceRevision, 40) || !digest(review.inputsSha256))
    throw new Error("Public release source and identity must be immutable")
  const identity = object(review.identity, ["appId", "productName"])
  if (
    !safeText(identity.appId, 160) ||
    !/^systems\.physical\.desktop(?:\.[a-z][a-z0-9-]*)*$/.test(identity.appId) ||
    /(?:^|[.-])(?:dev|development|candidate|test|testing|review|internal)(?:[.-]|$)/i.test(identity.appId) ||
    identity.productName !== "Physical Systems"
  )
    throw new Error("Development and candidate build identities cannot be publicly selected")
  const signing = object(review.windowsSigning, [
    "status",
    "publisher",
    "certificateThumbprint",
    "installerSha256",
    "executableSha256",
    "verificationReportSha256",
  ])
  if (
    signing.status !== "verified" ||
    !safeText(signing.publisher, 200) ||
    typeof signing.certificateThumbprint !== "string" ||
    !/^(?:[A-F0-9]{40}|[A-F0-9]{64})$/.test(signing.certificateThumbprint) ||
    !digest(signing.installerSha256) ||
    !digest(signing.executableSha256) ||
    !digest(signing.verificationReportSha256)
  )
    throw new Error("Verified Windows installer and executable signing evidence is required")
  const expected = [...candidateNames(review.version, "windows-x64"), ...candidateNames(review.version, "linux-x64")]
  if (!Array.isArray(review.assets) || review.assets.length !== expected.length)
    throw new Error("Every reviewed public installer format is required")
  const names = new Set<string>()
  for (const value of review.assets) {
    const asset = object(value, ["name", "bytes", "sha256", "qualification"])
    if (
      typeof asset.name !== "string" ||
      names.has(asset.name) ||
      !expected.some((item) => item.name === asset.name) ||
      !Number.isSafeInteger(asset.bytes) ||
      Number(asset.bytes) <= 0 ||
      Number(asset.bytes) > 2 * 1024 ** 3 ||
      !digest(asset.sha256)
    )
      throw new Error("Invalid or duplicate reviewed installer inventory")
    names.add(asset.name)
    const qualification = object(asset.qualification, ["reportSha256", "checks"])
    if (!digest(qualification.reportSha256))
      throw new Error("Each public artifact needs a qualification receipt digest")
    const checks = object(qualification.checks, [...requiredChecks])
    if (requiredChecks.some((key) => checks[key] !== "PASS"))
      throw new Error("Public distribution qualification is incomplete")
    if (asset.name.endsWith(".exe") && signing.installerSha256 !== asset.sha256)
      throw new Error("Windows signing evidence belongs to a different installer")
  }
  return review as PublicDistributionFacts
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

/** Anonymous readback only. Produces no selection until all three downloads match.
 * This verifies bytes against a trusted approval record; it does not grant approval,
 * sign software, publish a release, deploy a website or test native signatures itself.
 */
export async function verifyPublicDownloads(input: { review: unknown; expectedReviewSha256: string; fetch?: Fetcher }) {
  const review = validateReview(input.review, input.expectedReviewSha256)
  const request = input.fetch ?? fetch
  const metadata = await request(
    `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(review.tag)}`,
    {
      method: "GET",
      redirect: "error",
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      signal: AbortSignal.timeout(30_000),
    },
  )
  if (!metadata.ok) {
    await metadata.body?.cancel().catch(() => {})
    throw new Error("Reviewed release is not anonymously available")
  }
  const release = await boundedJson(metadata, 2 * 1024 * 1024)
  if (!release || typeof release !== "object" || Array.isArray(release))
    throw new Error("Malformed public GitHub release")
  const record = release as Record<string, unknown>
  if (
    record.id !== review.releaseId ||
    record.tag_name !== review.tag ||
    record.draft !== false ||
    record.prerelease !== (review.channel === "preview") ||
    record.html_url !== `https://github.com/${repository}/releases/tag/${review.tag}` ||
    !safeText(record.published_at, 40) ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(record.published_at) ||
    !Number.isFinite(Date.parse(record.published_at))
  )
    throw new Error("Public GitHub release does not match the reviewed publication")
  if (!Array.isArray(record.assets)) throw new Error("Public release assets are missing")
  const assets = review.assets.map((asset) => {
    const matching = (record.assets as Record<string, unknown>[]).filter((value) => value?.name === asset.name)
    const url = `https://github.com/${repository}/releases/download/${review.tag}/${encodeURIComponent(asset.name)}`
    const item = matching[0]
    if (
      matching.length !== 1 ||
      !item ||
      item.state !== "uploaded" ||
      item.size !== asset.bytes ||
      item.browser_download_url !== url ||
      !Number.isSafeInteger(item.id) ||
      Number(item.id) <= 0 ||
      (item.digest !== undefined && item.digest !== null && item.digest !== `sha256:${asset.sha256}`)
    )
      throw new Error("Public asset metadata differs from the reviewed installer")
    return { name: asset.name, bytes: asset.bytes, sha256: asset.sha256, url }
  })
  if (
    (record.assets as Record<string, unknown>[]).some(
      (asset) =>
        typeof asset?.name === "string" &&
        /\.(?:exe|deb|appimage)$/i.test(asset.name) &&
        !assets.some((item) => item.name === asset.name),
    )
  )
    throw new Error("Public release contains an unexpected installer format")
  // Bounded, sequential streams avoid retaining installer bytes in memory.
  for (const asset of assets) await verifyDownload(request, asset)
  return {
    schemaVersion: 1,
    repository,
    release: {
      tag: review.tag,
      version: review.version,
      channel: review.channel,
      releaseId: review.releaseId,
      publishedAt: record.published_at,
      sourceRevision: review.sourceRevision,
      inputsSha256: review.inputsSha256,
      assets: assets.map(({ url: _url, ...asset }) => asset),
    },
  }
}

async function boundedJson(response: Response, maximum: number) {
  if (!response.body) throw new Error("Public release response is empty")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const item = await reader.read()
      if (item.done) break
      size += item.value.byteLength
      if (size > maximum) throw new Error("Public release metadata exceeds the limit")
      chunks.push(item.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
}

async function verifyDownload(request: Fetcher, asset: { url: string; bytes: number; sha256: string }) {
  const signal = AbortSignal.timeout(300_000)
  let url = asset.url
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await request(url, {
      method: "GET",
      redirect: "manual",
      headers: { Accept: "application/octet-stream" },
      signal,
    })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel().catch(() => {})
      const location = response.headers.get("location")
      const next = location && URL.parse(location)
      if (
        !next ||
        next.protocol !== "https:" ||
        next.port ||
        next.username ||
        next.password ||
        next.hash ||
        !["release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(next.hostname)
      )
        throw new Error("Public asset redirected outside GitHub release storage")
      url = next.href
      continue
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {})
      throw new Error("Public installer download failed")
    }
    const length = response.headers.get("content-length")
    if (length !== null && (!/^\d+$/.test(length) || Number(length) !== asset.bytes)) {
      await response.body.cancel().catch(() => {})
      throw new Error("Public installer length differs from the reviewed bytes")
    }
    const reader = response.body.getReader()
    const hash = createHash("sha256")
    let size = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > asset.bytes) throw new Error("Public installer exceeded its reviewed size")
        hash.update(chunk.value)
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
    if (size !== asset.bytes || hash.digest("hex") !== asset.sha256)
      throw new Error("Public installer bytes differ from the approved artifact")
    return
  }
  throw new Error("Public installer exceeded the redirect limit")
}
