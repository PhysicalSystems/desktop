import { expect, test } from "bun:test"
import { checkDesktopUpdate } from "./desktop-update-discovery"

function fixture(version = "0.1.0-beta.7") {
  const preview = version.includes("-beta.")
  const tag = `desktop-v${version}`
  const repository = "PhysicalSystems/physicalsystems"
  const assets = ["windows-x64.exe", "linux-x64.deb", "linux-x64.AppImage"].map((suffix, index) => ({
    name: `physical-systems-desktop-${version}-${suffix}`,
    bytes: 100 + index,
    sha256: String(index + 1).repeat(64),
  }))
  const selection = {
    schemaVersion: 2,
    repository,
    release: {
      tag,
      version,
      channel: preview ? "preview" : "stable",
      releaseId: 100,
      publishedAt: "2026-09-13T17:18:01Z",
      sourceRevision: "a".repeat(40),
      inputsSha256: "b".repeat(64),
      windowsSigning: preview
        ? { status: "unsigned-preview", warning: "Unsigned Windows preview: Windows may warn or block installation." }
        : { status: "verified" },
      assets,
    },
  }
  const metadata = {
    id: 100,
    tag_name: tag,
    draft: false,
    prerelease: preview,
    html_url: `https://github.com/${repository}/releases/tag/${tag}`,
    published_at: selection.release.publishedAt,
    assets: assets.map((asset, index) => ({
      id: 101 + index,
      name: asset.name,
      state: "uploaded",
      size: asset.bytes,
      digest: `sha256:${asset.sha256}`,
      browser_download_url: `https://github.com/${repository}/releases/download/${tag}/${asset.name}`,
    })),
  }
  const calls: string[] = []
  const input: Parameters<typeof checkDesktopUpdate>[0] = {
    currentVersion: "0.1.0-beta.4",
    packaged: true,
    platform: "linux",
    arch: "x64",
    identity: { kind: "public", appId: "systems.physical.desktop", productName: "Physical Systems" },
    fetch: async (url, options) => {
      calls.push(url)
      expect(options.method).toBe("GET")
      expect(options.redirect).toBe("error")
      expect(options.credentials).toBe("omit")
      expect(options.signal).toBeInstanceOf(AbortSignal)
      expect(new Headers(options.headers).has("Authorization")).toBe(false)
      if (url === "https://physicalsystems.ai/desktop-selection.json") return Response.json(selection)
      expect(url).toBe(`https://api.github.com/repos/${repository}/releases/tags/${tag}`)
      return Response.json(metadata)
    },
  }
  return { input, selection, metadata, calls }
}

test("discovers only the selected owned public release and derives exact links without downloading installers", async () => {
  const f = fixture()
  const result = await checkDesktopUpdate(f.input)
  expect(result).toEqual({
    status: "available",
    version: "0.1.0-beta.7",
    channel: "preview",
    downloadUrl: "https://physicalsystems.ai/download",
    releaseNotesUrl: f.metadata.html_url,
    unsignedWindowsPreview: true,
    assets: f.selection.release.assets.map((asset, index) => ({
      ...asset,
      url: f.metadata.assets[index]!.browser_download_url,
    })),
  })
  expect(f.calls).toHaveLength(2)
})

test.each([
  ["0.1.0-beta.9", "0.1.0-beta.10", "available"],
  ["0.1.0-beta.7", "0.1.0-beta.7", "up-to-date"],
  ["0.1.0-beta.8", "0.1.0-beta.7", "selected-version-older"],
  ["0.1.0", "0.2.0-beta.1", "preview-not-allowed"],
  ["0.1.0-beta.7", "0.1.0", "available"],
  ["0.1.0", "0.1.0", "up-to-date"],
])(
  "compares %s with selected %s without downgrades or stable-to-preview moves",
  async (current, selected, expected) => {
    const f = fixture(selected)
    const result = await checkDesktopUpdate({ ...f.input, currentVersion: current })
    expect(result.status === "unavailable" ? result.reason : result.status).toBe(expected)
  },
)

test.each([
  { packaged: false },
  { platform: "darwin" },
  { arch: "arm64" },
  { identity: { kind: "candidate", appId: "systems.physical.desktop", productName: "Physical Systems" } },
  { identity: { kind: "public", appId: "ai.opencode.desktop", productName: "OpenCode" } },
])("unsupported installations cannot contact release services: %j", async (change) => {
  const f = fixture()
  expect(await checkDesktopUpdate({ ...f.input, ...change })).toEqual({
    status: "unavailable",
    reason: "unsupported-installation",
  })
  expect(f.calls).toHaveLength(0)
})

test.each(["", "1.0", "0.1.0-beta.0", "0.1.0-beta.7 ", "0.0.0-beta.1", "99999999999999999999.0.0"])(
  "rejects invalid or lab installed version %s before a network request",
  async (version) => {
    const f = fixture()
    expect(await checkDesktopUpdate({ ...f.input, currentVersion: version })).toEqual({
      status: "unavailable",
      reason: "invalid-current-version",
    })
    expect(f.calls).toHaveLength(0)
  },
)

test.each(["repository", "tag", "assets", "warning"])(
  "rejects malformed selection %s before GitHub lookup",
  async (change) => {
    const f = fixture()
    if (change === "repository") f.selection.repository = "anomalyco/opencode"
    if (change === "tag") f.selection.release.tag = "../../untrusted"
    if (change === "assets") f.selection.release.assets[0]!.name = "../../installer.exe"
    if (change === "warning") f.selection.release.windowsSigning.warning = ""
    expect(await checkDesktopUpdate(f.input)).toEqual({ status: "unavailable", reason: "check-failed" })
    expect(f.calls).toHaveLength(1)
  },
)

test.each(["draft", "id", "published", "size", "digest", "url", "missing", "duplicate", "extra"])(
  "rejects conflicting public release metadata: %s",
  async (change) => {
    const f = fixture()
    if (change === "draft") f.metadata.draft = true
    if (change === "id") f.metadata.id++
    if (change === "published") f.metadata.published_at = "2026-09-12T17:18:01Z"
    if (change === "size") f.metadata.assets[0]!.size++
    if (change === "digest") f.metadata.assets[0]!.digest = `sha256:${"0".repeat(64)}`
    if (change === "url") f.metadata.assets[0]!.browser_download_url = "https://untrusted.example/installer.exe"
    if (change === "missing") f.metadata.assets.pop()
    if (change === "duplicate") f.metadata.assets.push(f.metadata.assets[0]!)
    if (change === "extra") f.metadata.assets.push({ ...f.metadata.assets[0]!, name: "unexpected.exe" })
    expect(await checkDesktopUpdate(f.input)).toEqual({ status: "unavailable", reason: "check-failed" })
    expect(f.calls).toHaveLength(2)
  },
)

test.each(["redirect", "http", "json", "oversize", "announced-oversize", "transport", "aborted"])(
  "bounded discovery fails closed without exposing response or exception text: %s",
  async (mode) => {
    const f = fixture()
    const result = await checkDesktopUpdate({
      ...f.input,
      fetch: async () => {
        if (mode === "transport") throw new Error("private-credential-trap")
        if (mode === "aborted") throw new DOMException("private-credential-trap", "AbortError")
        if (mode === "redirect")
          return new Response(null, { status: 302, headers: { Location: "https://untrusted.example" } })
        if (mode === "http") return new Response("private-credential-trap", { status: 503 })
        if (mode === "json") return new Response("private-credential-trap")
        if (mode === "announced-oversize") return new Response("{}", { headers: { "Content-Length": "65537" } })
        return new Response("x".repeat(65537))
      },
    })
    expect(result).toEqual({ status: "unavailable", reason: "check-failed" })
    expect(JSON.stringify(result)).not.toContain("private-credential-trap")
  },
)
