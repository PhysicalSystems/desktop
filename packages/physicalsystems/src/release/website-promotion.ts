// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto"
import { candidateNames } from "./artifacts"
import { unsignedWindowsPreviewWarning } from "./public-downloads"

const repository = "PhysicalSystems/platform"
const path = "public/desktop-selection.json"
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

function version(value: unknown) {
  if (typeof value !== "string" || value.length > 80 || value.trim() !== value)
    throw new Error("Invalid selected desktop version")
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.([1-9]\d*))?$/.exec(value)
  if (!match) throw new Error("Invalid selected desktop version")
  return [BigInt(match[1]), BigInt(match[2]), BigInt(match[3]), match[4] ? BigInt(match[4]) : null]
}

function record(value: unknown, keys: string[], optional: string[] = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid website selection")
  const result = value as Record<string, unknown>
  if (keys.some((key) => !(key in result)) || Object.keys(result).some((key) => ![...keys, ...optional].includes(key)))
    throw new Error("Unexpected website selection fields")
  return result
}

function parseSelection(bytes: Uint8Array) {
  if (bytes.length > 64 * 1024) throw new Error("Website selection exceeds the supported size")
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown
  } catch {
    throw new Error("Website selection must be valid public JSON")
  }
}

/** Only advances a validated, checked-in website selection. It cannot promote candidates. */
export function selectionTransition(previous: unknown, next: unknown) {
  const read = (value: unknown) => {
    const data = record(value, ["schemaVersion", "repository", "release"])
    if (
      (data.schemaVersion !== 1 && data.schemaVersion !== 2) ||
      data.repository !== "PhysicalSystems/physicalsystems" ||
      !Object.hasOwn(data, "release")
    )
      throw new Error("Unexpected website download source")
    if (data.release === null) return null
    const release = record(data.release, [
      "tag",
      "version",
      "channel",
      "releaseId",
      "publishedAt",
      "sourceRevision",
      "inputsSha256",
      "assets",
      ...(data.schemaVersion === 2 ? ["windowsSigning"] : []),
    ])
    const parts = version(release.version)
    if (
      release.tag !== `desktop-v${release.version}` ||
      release.channel !== (parts[3] === null ? "stable" : "preview") ||
      !Number.isSafeInteger(release.releaseId) ||
      Number(release.releaseId) <= 0 ||
      typeof release.sourceRevision !== "string" ||
      release.sourceRevision.length !== 40 ||
      !/^[a-f0-9]{40}$/.test(release.sourceRevision) ||
      typeof release.inputsSha256 !== "string" ||
      release.inputsSha256.length !== 64 ||
      !/^[a-f0-9]{64}$/.test(release.inputsSha256) ||
      typeof release.publishedAt !== "string" ||
      release.publishedAt.trim() !== release.publishedAt ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(release.publishedAt) ||
      !Number.isFinite(Date.parse(release.publishedAt))
    )
      throw new Error("Incomplete website release identity")
    if ("windowsSigning" in release) {
      const signing = record(release.windowsSigning, ["status"], ["warning"])
      if (
        signing.status === "unsigned-preview"
          ? release.channel !== "preview" || signing.warning !== unsignedWindowsPreviewWarning
          : signing.status !== "verified" || "warning" in signing
      )
        throw new Error("Website Windows signing status must match its preview warning and release channel")
    }
    const names = [
      ...candidateNames(String(release.version), "windows-x64"),
      ...candidateNames(String(release.version), "linux-x64"),
    ]
    if (!Array.isArray(release.assets) || release.assets.length !== 3)
      throw new Error("Incomplete website installer inventory")
    const assets = release.assets.map((asset) => record(asset, ["name", "bytes", "sha256"]))
    if (
      new Set(assets.map((asset) => asset.name)).size !== 3 ||
      assets.some(
        (asset) =>
          !names.some((entry) => entry.name === asset.name) ||
          !Number.isSafeInteger(asset.bytes) ||
          Number(asset.bytes) <= 0 ||
          Number(asset.bytes) > 2 * 1024 ** 3 ||
          typeof asset.sha256 !== "string" ||
          asset.sha256.length !== 64 ||
          !/^[a-f0-9]{64}$/.test(asset.sha256),
      )
    )
      throw new Error("Incomplete website installer inventory")
    return { release, parts, schemaVersion: data.schemaVersion }
  }
  const old = read(previous)
  const current = read(next)
  if (!current) throw new Error("An empty selection cannot be promoted")
  if (current.schemaVersion !== 2) throw new Error("New website selections require explicit Windows signing status")
  if (!old) return "advance"
  if (JSON.stringify(previous) === JSON.stringify(next)) return "unchanged"
  if (old.release.channel === "stable" && current.release.channel !== "stable")
    throw new Error("Automatic promotion cannot switch stable downloads to preview")
  for (let i = 0; i < 4; i++) {
    if (current.parts[i] === old.parts[i]) continue
    if (current.parts[i] === null || (old.parts[i] !== null && current.parts[i]! > old.parts[i]!)) return "advance"
    throw new Error("Website promotion cannot downgrade the selected desktop")
  }
  throw new Error("A selected desktop version cannot be replaced with different bytes or evidence")
}

/** Opens a one-file PR. It never writes main, merges, publishes installers or deploys. */
export async function proposeWebsiteSelection(input: {
  bytes: Uint8Array
  expectedSha256: string
  token: string
  fetch?: Fetcher
}) {
  if (
    input.bytes.length > 64 * 1024 ||
    input.expectedSha256.length !== 64 ||
    createHash("sha256").update(input.bytes).digest("hex") !== input.expectedSha256
  )
    throw new Error("Website selection does not match the trusted readback digest")
  if (!input.token || /\s/.test(input.token))
    throw new Error("Website promotion requires its separately scoped GitHub credential")
  const next = parseSelection(input.bytes) as { release: { version: string } }
  selectionTransition({ schemaVersion: 1, repository: "PhysicalSystems/physicalsystems", release: null }, next)
  const api = websiteApi(input.token, input.fetch)
  const main = await api("git/ref/heads/main")
  if (!/^[a-f0-9]{40}$/.test(main?.object?.sha)) throw new Error("Website main revision is unavailable")
  const existing = await api(`contents/${path}?ref=${main.object.sha}`)
  if (existing?.encoding !== "base64" || existing?.path !== path || !/^[a-f0-9]{40}$/.test(existing.sha))
    throw new Error("Website selection is not installed on main")
  if (typeof existing.content !== "string" || existing.content.length > 96 * 1024)
    throw new Error("Website selection content is unavailable")
  const previousBytes = Buffer.from(existing.content, "base64")
  const previous = parseSelection(previousBytes)
  if (selectionTransition(previous, next) === "unchanged" && previousBytes.equals(Buffer.from(input.bytes)))
    return { status: "unchanged", url: null }
  const branch = `desktop-download-${next.release.version.replace("-beta.", "b")}`
  const reference = await api(`git/ref/heads/${branch}`, "GET", undefined, true)
  if (!reference) await api("git/refs", "POST", { ref: `refs/heads/${branch}`, sha: main.object.sha })
  if (reference) {
    const files = await api(`compare/${main.object.sha}...${branch}`)
    if (!Array.isArray(files?.files) || files.files.some((file: { filename?: string }) => file.filename !== path))
      throw new Error("Existing promotion branch has unrelated changes; no update made")
  }
  const current = await api(`contents/${path}?ref=${branch}`)
  if (current?.encoding !== "base64" || current?.path !== path || !/^[a-f0-9]{40}$/.test(current.sha))
    throw new Error("Promotion branch selection is unavailable")
  if (typeof current.content !== "string" || current.content.length > 96 * 1024)
    throw new Error("Promotion branch selection content is unavailable")
  const content = Buffer.from(current.content, "base64")
  if (!content.equals(Buffer.from(input.bytes))) {
    selectionTransition(parseSelection(content), next)
    await api(`contents/${path}`, "PUT", {
      branch,
      sha: current.sha,
      message: `chore(download): select desktop ${next.release.version}`,
      content: Buffer.from(input.bytes).toString("base64"),
    })
  }
  // Recheck after the conditional file update before creating/reusing a PR.
  // The contents API protects the blob SHA, not unrelated concurrent branch edits.
  const changed = await api(`compare/${main.object.sha}...${branch}`)
  if (!Array.isArray(changed?.files) || changed.files.length !== 1 || changed.files[0]?.filename !== path)
    throw new Error("Promotion branch changed outside the selected file; no PR opened")
  const confirmed = await api(`contents/${path}?ref=${branch}`)
  if (
    confirmed?.encoding !== "base64" ||
    confirmed?.path !== path ||
    typeof confirmed.content !== "string" ||
    confirmed.content.length > 96 * 1024 ||
    !Buffer.from(confirmed.content, "base64").equals(Buffer.from(input.bytes))
  )
    throw new Error("Promotion branch no longer contains the verified selection; no PR opened")
  const latestMain = await api("git/ref/heads/main")
  if (latestMain?.object?.sha !== main.object.sha)
    throw new Error("Website main changed during promotion; recheck its selected version before retrying")
  const pulls = await api(`pulls?state=open&head=${encodeURIComponent(`PhysicalSystems:${branch}`)}&base=main`)
  if (!Array.isArray(pulls) || pulls.length > 1) throw new Error("Ambiguous website promotion PR")
  const pull =
    pulls[0] ??
    (await api("pulls", "POST", {
      title: `chore(download): select desktop ${next.release.version}`,
      head: branch,
      base: "main",
      body: `Select the approved Physical Systems Desktop ${next.release.version} installers after anonymous public SHA-256 and size verification.\n\nOnly public/desktop-selection.json changes. Selection digest: ${input.expectedSha256}.\n\nThe coordinator merges only this selection change after the website checks pass for its exact commit. Merging main triggers the existing deployment; no additional release approval is requested.`,
    }))
  if (
    typeof pull?.html_url !== "string" ||
    !/^https:\/\/github\.com\/PhysicalSystems\/platform\/pull\/[1-9]\d*$/.test(pull.html_url)
  )
    throw new Error("Website PR result is uncertain; inspect the existing branch before retrying")
  return { status: "proposed", url: pull.html_url }
}

export function websiteApi(token: string, fetcher?: Fetcher) {
  if (!token || /\s/.test(token)) throw new Error("Website promotion requires its separately scoped GitHub credential")
  const request = fetcher ?? fetch
  return async (suffix: string, method = "GET", body?: unknown, missing = false) => {
    const response = await Promise.resolve()
      .then(() =>
        request(`https://api.github.com/repos/${repository}/${suffix}`, {
          method,
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      )
      .catch(() => {
        throw new Error(
          "Website promotion request outcome is uncertain; inspect the existing branch/PR before retrying",
        )
      })
    if (missing && response.status === 404) {
      await response.body?.cancel().catch(() => {})
      return null
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new Error(
        `Website promotion API failed (${response.status}); inspect the existing branch/PR before retrying`,
      )
    }
    if (!response.body) throw new Error("Website promotion API returned an empty response")
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > 4 * 1024 * 1024) throw new Error("Website API response limit exceeded")
        chunks.push(chunk.value)
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"))
    } catch {
      throw new Error("Website promotion API response is uncertain; inspect the existing branch/PR before retrying")
    } finally {
      await reader.cancel().catch(() => {})
    }
  }
}
