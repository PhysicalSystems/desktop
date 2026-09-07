// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto"
import { selectionTransition, websiteApi } from "./website-promotion"

const selectedPath = "public/desktop-selection.json"
const workflow = ".github/workflows/website-ci.yml"

/** A publication approval already covers these exact selection bytes. The
 * integration PR still needs successful website CI for its current commit. */
export async function mergeWebsiteSelection(input: {
  bytes: Uint8Array
  expectedSha256: string
  url: string
  token: string
  fetch?: (url: string, init?: RequestInit) => Promise<Response>
  wait?: () => Promise<void>
}) {
  if (
    input.bytes.length > 64 * 1024 ||
    !/^[a-f0-9]{64}$/.test(input.expectedSha256) ||
    createHash("sha256").update(input.bytes).digest("hex") !== input.expectedSha256
  )
    throw new Error("Website selection does not match the trusted readback digest")
  const match = /^https:\/\/github\.com\/PhysicalSystems\/platform\/pull\/([1-9]\d*)$/.exec(input.url)
  if (!match) throw new Error("Unexpected website integration PR")
  const next = JSON.parse(Buffer.from(input.bytes).toString("utf8"))
  selectionTransition({ schemaVersion: 1, repository: "PhysicalSystems/physicalsystems", release: null }, next)
  const branch = `desktop-download-${next.release.version.replace("-beta.", "b")}`
  const api = websiteApi(input.token, input.fetch)
  const wait = input.wait ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 10_000)))
  const deadline = Date.now() + 15 * 60_000
  for (let attempt = 0; attempt < 90 && Date.now() < deadline; attempt++) {
    const pull = await api(`pulls/${match[1]}`)
    if (
      pull?.base?.repo?.full_name !== "PhysicalSystems/platform" ||
      pull.base.ref !== "main" ||
      pull?.head?.repo?.full_name !== "PhysicalSystems/platform" ||
      pull.head.ref !== branch ||
      !/^[a-f0-9]{40}$/.test(pull.head.sha) ||
      pull.draft ||
      pull.changed_files !== 1
    )
      throw new Error("Website PR identity or scope changed; no merge performed")
    const main = await api("git/ref/heads/main")
    if (!/^[a-f0-9]{40}$/.test(main?.object?.sha)) throw new Error("Website main revision is unavailable")
    const content = async (ref: string) => {
      const file = await api(`contents/${selectedPath}?ref=${ref}`)
      if (
        file?.path !== selectedPath ||
        file.encoding !== "base64" ||
        typeof file.content !== "string" ||
        file.content.length > 96 * 1024
      )
        throw new Error("Website selection bytes are unavailable")
      return Buffer.from(file.content, "base64")
    }
    const previous = await content(main.object.sha)
    if (pull.merged === true) {
      if (!previous.equals(Buffer.from(input.bytes)))
        throw new Error("Merged PR no longer selects the approved downloads")
      return { status: "merged" as const, url: input.url }
    }
    if (pull.state !== "open") throw new Error("Website integration PR was closed without merging")
    selectionTransition(JSON.parse(previous.toString("utf8")), next)
    if (pull.base.sha !== main.object.sha)
      throw new Error("Website main advanced; refresh and revalidate the integration PR")
    const files = await api(`pulls/${match[1]}/files?per_page=100`)
    if (
      !Array.isArray(files) ||
      files.length !== 1 ||
      files[0]?.filename !== selectedPath ||
      files[0]?.status !== "modified"
    )
      throw new Error("Website PR contains changes outside the selected downloads")
    if (!(await content(pull.head.sha)).equals(Buffer.from(input.bytes)))
      throw new Error("Website PR no longer contains the verified selection")
    const runs = await api(
      `actions/workflows/website-ci.yml/runs?head_sha=${pull.head.sha}&event=pull_request&per_page=100`,
    )
    if (!Array.isArray(runs?.workflow_runs) || !Number.isSafeInteger(runs.total_count) || runs.total_count > 100)
      throw new Error("Website validation history is incomplete")
    const matching = runs.workflow_runs.filter(
      (run: { head_sha?: string; path?: string; event?: string; head_repository?: { full_name?: string } }) =>
        run.head_sha === pull.head.sha &&
        run.path === workflow &&
        run.event === "pull_request" &&
        run.head_repository?.full_name === "PhysicalSystems/platform",
    )
    matching.sort((a: { id: number }, b: { id: number }) => b.id - a.id)
    const run = matching[0]
    if (run?.status === "completed" && run.conclusion !== "success")
      throw new Error("Website validation failed; the integration PR remains available for repair")
    if (run?.status !== "completed" || pull.mergeable === null) {
      await wait()
      continue
    }
    if (
      !Number.isSafeInteger(run.id) ||
      run.id <= 0 ||
      !Number.isSafeInteger(run.run_attempt) ||
      run.run_attempt <= 0 ||
      !Array.isArray(run.pull_requests) ||
      !run.pull_requests.some(
        (entry: { number?: number; head?: { sha?: string }; base?: { sha?: string } }) =>
          entry.number === Number(match[1]) && entry.head?.sha === pull.head.sha && entry.base?.sha === main.object.sha,
      )
    )
      throw new Error("Website validation belongs to a different PR or base revision; rerun its checks")
    const jobs = await api(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`)
    if (
      !Array.isArray(jobs?.jobs) ||
      jobs.total_count !== 1 ||
      jobs.jobs.length !== 1 ||
      jobs.jobs[0]?.name !== "Website validation" ||
      jobs.jobs[0]?.head_sha !== pull.head.sha ||
      jobs.jobs[0]?.status !== "completed" ||
      jobs.jobs[0]?.conclusion !== "success"
    )
      throw new Error("The current website validation job did not succeed")
    if (pull.mergeable !== true || pull.mergeable_state !== "clean")
      throw new Error("Website PR cannot merge under current repository rules")
    const latest = await api(`pulls/${match[1]}`)
    const latestMain = await api("git/ref/heads/main")
    if (
      latest?.head?.sha !== pull.head.sha ||
      latest?.base?.sha !== main.object.sha ||
      latestMain?.object?.sha !== main.object.sha
    )
      throw new Error("Website source changed after validation; no merge performed")
    const merged = await api(`pulls/${match[1]}/merge`, "PUT", { sha: pull.head.sha, merge_method: "squash" })
    if (merged?.merged !== true)
      throw new Error("Website merge is unconfirmed; inspect the existing PR before retrying")
    // Read the actual selected bytes after a successful or lost acknowledgement.
  }
  throw new Error("Website validation did not complete within 15 minutes; rerun promotion to resume the existing PR")
}

/** Deployment is complete only when the public site serves the approved bytes. */
export async function waitForWebsiteSelection(input: {
  bytes: Uint8Array
  fetch?: (url: string, init?: RequestInit) => Promise<Response>
  wait?: () => Promise<void>
}) {
  if (!input.bytes.length || input.bytes.length > 64 * 1024) throw new Error("Invalid deployment selection size")
  const request = input.fetch ?? fetch
  const wait = input.wait ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 10_000)))
  const digest = createHash("sha256").update(input.bytes).digest("hex")
  const deadline = Date.now() + 15 * 60_000
  for (let attempt = 0; attempt < 90 && Date.now() < deadline; attempt++) {
    const response = await request(`https://physicalsystems.ai/desktop-selection.json?release=${digest}`, {
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    }).catch(() => null)
    if (response?.ok && response.body) {
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          size += chunk.value.byteLength
          if (size > 64 * 1024) break
          chunks.push(chunk.value)
        }
        if (size <= 64 * 1024 && Buffer.concat(chunks).equals(Buffer.from(input.bytes))) {
          const ready = await verifyWebsiteEndpoints(request).catch(() => false)
          if (ready) return
        }
      } catch {
        /* Temporary deployment or transport failure; retry the read only. */
      } finally {
        await reader.cancel().catch(() => {})
      }
    } else await response?.body?.cancel().catch(() => {})
    await wait()
  }
  throw new Error(
    "Website deployment is not confirmed; check Render and rerun promotion to verify the existing selection",
  )
}

async function verifyWebsiteEndpoints(request: (url: string, init?: RequestInit) => Promise<Response>) {
  for (const endpoint of ["/api/health", "/download"]) {
    const response = await request(`https://physicalsystems.ai${endpoint}`, {
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    })
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      return false
    }
    const chunks: Uint8Array[] = []
    const reader = response.body.getReader()
    let size = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > 1024 * 1024) return false
        chunks.push(chunk.value)
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
    const body = Buffer.concat(chunks).toString("utf8")
    if (endpoint === "/api/health") {
      if (!response.headers.get("content-type")?.includes("application/json") || JSON.parse(body)?.ok !== true)
        return false
    } else if (
      !response.headers.get("content-type")?.includes("text/html") ||
      !/<title>Download Desktop \| Physical Systems<\/title>/.test(body)
    )
      return false
  }
  return true
}
