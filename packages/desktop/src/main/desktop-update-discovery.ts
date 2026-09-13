import { compareVersion } from "../../../physicalsystems/src/release/inputs"
import { selectionTransition } from "../../../physicalsystems/src/release/website-promotion"

const repository = "PhysicalSystems/physicalsystems"
const selectionUrl = "https://physicalsystems.ai/desktop-selection.json"
const downloadUrl = "https://physicalsystems.ai/download"
type Fetcher = (url: string, options: RequestInit) => Promise<Response>
type Asset = { name: string; bytes: number; sha256: string }
type Selection = {
  release: {
    tag: string
    version: string
    channel: "preview" | "stable"
    releaseId: number
    publishedAt: string
    windowsSigning: { status: "verified" | "unsigned-preview" }
    assets: Asset[]
  }
}

export type DesktopUpdateDiscoveryResult =
  | {
      status: "available"
      version: string
      channel: "preview" | "stable"
      downloadUrl: string
      releaseNotesUrl: string
      unsignedWindowsPreview: boolean
      assets: (Asset & { url: string })[]
    }
  | { status: "up-to-date"; version: string }
  | {
      status: "unavailable"
      reason:
        | "unsupported-installation"
        | "invalid-current-version"
        | "selected-version-older"
        | "preview-not-allowed"
        | "check-failed"
    }

/** Public release discovery only. Metadata checks do not verify installer bytes,
 * authenticate a native publisher, or authorize installation or app shutdown.
 */
export async function checkDesktopUpdate(input: {
  currentVersion: string
  packaged: boolean
  platform: string
  arch: string
  identity: { kind: string; appId: string; productName: string }
  fetch?: Fetcher
}): Promise<DesktopUpdateDiscoveryResult> {
  if (
    !input.packaged ||
    !["win32", "linux"].includes(input.platform) ||
    input.arch !== "x64" ||
    input.identity.kind !== "public" ||
    input.identity.appId !== "systems.physical.desktop" ||
    input.identity.productName !== "Physical Systems"
  )
    return { status: "unavailable", reason: "unsupported-installation" }
  try {
    if (input.currentVersion.length > 80 || compareVersion(input.currentVersion, "0.1.0-beta.1") < 0)
      return { status: "unavailable", reason: "invalid-current-version" }
  } catch {
    return { status: "unavailable", reason: "invalid-current-version" }
  }

  try {
    const request = input.fetch ?? fetch
    const selected = await readJson(request, selectionUrl, 64 * 1024)
    // Reuse the production website's complete schema, identity, channel,
    // signing-warning and exact three-format inventory validation.
    selectionTransition({ schemaVersion: 2, repository, release: null }, selected)
    const release = (selected as Selection).release
    const releaseNotesUrl = `https://github.com/${repository}/releases/tag/${release.tag}`
    const metadata = await readJson(
      request,
      `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(release.tag)}`,
      2 * 1024 * 1024,
    )
    if (
      !isRecord(metadata) ||
      metadata.id !== release.releaseId ||
      metadata.tag_name !== release.tag ||
      metadata.draft !== false ||
      metadata.prerelease !== (release.channel === "preview") ||
      metadata.html_url !== releaseNotesUrl ||
      metadata.published_at !== release.publishedAt ||
      !Array.isArray(metadata.assets)
    )
      throw new Error()
    const remote = metadata.assets
    const assets = release.assets.map((asset) => {
      const matches = remote.filter((item) => isRecord(item) && item.name === asset.name)
      const observed = matches[0]
      const url = `https://github.com/${repository}/releases/download/${release.tag}/${encodeURIComponent(asset.name)}`
      if (
        matches.length !== 1 ||
        !isRecord(observed) ||
        !Number.isSafeInteger(observed.id) ||
        Number(observed.id) <= 0 ||
        observed.state !== "uploaded" ||
        observed.size !== asset.bytes ||
        observed.digest !== `sha256:${asset.sha256}` ||
        observed.browser_download_url !== url
      )
        throw new Error()
      return { ...asset, url }
    })
    if (
      remote.some(
        (item) =>
          !isRecord(item) ||
          typeof item.name !== "string" ||
          (/\.(?:exe|deb|appimage)$/i.test(item.name) && !assets.some((asset) => asset.name === item.name)),
      )
    )
      throw new Error()
    if (!input.currentVersion.includes("-beta.") && release.channel === "preview")
      return { status: "unavailable", reason: "preview-not-allowed" }
    const comparison = compareVersion(release.version, input.currentVersion)
    if (comparison < 0) return { status: "unavailable", reason: "selected-version-older" }
    if (comparison === 0) return { status: "up-to-date", version: input.currentVersion }
    return {
      status: "available",
      version: release.version,
      channel: release.channel,
      downloadUrl,
      releaseNotesUrl,
      unsignedWindowsPreview: release.windowsSigning.status === "unsigned-preview",
      assets,
    }
  } catch {
    // Network responses, URLs, paths and exception text never become UI copy.
    return { status: "unavailable", reason: "check-failed" }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

async function readJson(request: Fetcher, url: string, maximum: number): Promise<unknown> {
  const response = await request(url, {
    method: "GET",
    redirect: "error",
    credentials: "omit",
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
    headers: { Accept: "application/json", "X-GitHub-Api-Version": "2022-11-28" },
  })
  if (
    !response.ok ||
    response.redirected ||
    (response.url && response.url !== url) ||
    !response.body ||
    Number(response.headers.get("content-length")) > maximum
  ) {
    await response.body?.cancel().catch(() => {})
    throw new Error()
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > maximum) throw new Error()
      chunks.push(chunk.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
}
