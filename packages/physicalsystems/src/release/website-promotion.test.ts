// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { proposeWebsiteSelection, selectionTransition } from "./website-promotion"

const selectedPath = "public/desktop-selection.json"
const prefix = "https://api.github.com/repos/PhysicalSystems/platform/"
const empty = { schemaVersion: 1, repository: "PhysicalSystems/physicalsystems", release: null }
const encode = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + "\n")
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

function selection(version = "0.1.0-beta.1") {
  return {
    schemaVersion: 1,
    repository: "PhysicalSystems/physicalsystems",
    release: {
      tag: `desktop-v${version}`,
      version,
      channel: version.includes("-beta.") ? "preview" : "stable",
      releaseId: 12345,
      publishedAt: "2026-09-07T20:00:00Z",
      sourceRevision: "a".repeat(40),
      inputsSha256: "b".repeat(64),
      assets: ["windows-x64.exe", "linux-x64.deb", "linux-x64.AppImage"].map((suffix, index) => ({
        name: `physical-systems-desktop-${version}-${suffix}`,
        bytes: 100 + index,
        sha256: digest(Buffer.from(suffix)),
      })),
    },
  }
}

function fixture(previous: unknown = empty) {
  const next = selection()
  const bytes = encode(next)
  const branch = "desktop-download-0.1.0b1"
  const token = "fixture-github-credential-do-not-expose"
  const state = {
    main: "1".repeat(40),
    mainBlob: "2".repeat(40),
    currentBlob: "2".repeat(40),
    current: encode(previous),
    branchExists: false,
    unrelated: false,
    unrelatedAfterPut: false,
    replaceAfterPut: false,
    mainMovedAfterPut: false,
    putFailure: "" as "" | "uncertain" | "conflict",
    prFailure: false,
    pull: null as null | { html_url: string },
  }
  const calls: { suffix: string; method: string; body: Record<string, unknown> | undefined; headers: Headers }[] = []
  const content = (current: Buffer, sha: string) => ({
    encoding: "base64",
    path: selectedPath,
    sha,
    content: current.toString("base64"),
  })
  const request = async (url: string, options?: RequestInit) => {
    expect(url.startsWith(prefix)).toBe(true)
    expect(options?.redirect).toBe("error")
    const suffix = url.slice(prefix.length)
    const method = options?.method ?? "GET"
    const body = options?.body ? (JSON.parse(String(options.body)) as Record<string, unknown>) : undefined
    calls.push({ suffix, method, body, headers: new Headers(options?.headers) })
    if (suffix === "git/ref/heads/main" && method === "GET") return Response.json({ object: { sha: state.main } })
    if (suffix === `contents/${selectedPath}?ref=${state.main}` && method === "GET")
      return Response.json(content(encode(previous), state.mainBlob))
    if (suffix === `git/ref/heads/${branch}` && method === "GET")
      return state.branchExists
        ? Response.json({ object: { sha: "4".repeat(40) } })
        : new Response(null, { status: 404 })
    if (suffix === "git/refs" && method === "POST") {
      expect(body).toEqual({ ref: `refs/heads/${branch}`, sha: state.main })
      state.branchExists = true
      return Response.json({ ref: `refs/heads/${branch}` })
    }
    if (suffix.endsWith(`...${branch}`) && suffix.startsWith("compare/") && method === "GET") {
      const files =
        state.unrelated || (state.unrelatedAfterPut && state.current.equals(bytes))
          ? [{ filename: selectedPath }, { filename: "src/unrelated.ts" }]
          : state.current.equals(encode(previous))
            ? []
            : [{ filename: selectedPath }]
      return Response.json({ files })
    }
    if (suffix === `contents/${selectedPath}?ref=${branch}` && method === "GET")
      return Response.json(content(state.current, state.currentBlob))
    if (suffix === `contents/${selectedPath}` && method === "PUT") {
      expect(body?.branch).toBe(branch)
      expect(body?.sha).toBe(state.currentBlob)
      if (state.putFailure === "conflict") return new Response("Conflict", { status: 409 })
      state.current = Buffer.from(String(body?.content), "base64")
      state.currentBlob = "3".repeat(40)
      if (state.replaceAfterPut) state.current = encode(selection("0.1.0-beta.2"))
      if (state.mainMovedAfterPut) state.main = "5".repeat(40)
      if (state.putFailure === "uncertain") throw new Error(`Transport failure containing ${token}`)
      return Response.json({ content: { sha: state.currentBlob } })
    }
    if (
      suffix === `pulls?state=open&head=${encodeURIComponent(`PhysicalSystems:${branch}`)}&base=main` &&
      method === "GET"
    )
      return Response.json(state.pull ? [state.pull] : [])
    if (suffix === "pulls" && method === "POST") {
      state.pull = { html_url: "https://github.com/PhysicalSystems/platform/pull/99" }
      if (state.prFailure) throw new Error(`Uncertain PR creation with ${token}`)
      return Response.json(state.pull)
    }
    throw new Error(`Unexpected fixture request ${suffix}`)
  }
  return {
    state,
    next,
    bytes,
    token,
    branch,
    calls,
    request,
    input: { bytes, expectedSha256: digest(bytes), token, fetch: request },
  }
}

describe("website selection transition", () => {
  test("allows first selection, preview advancement and explicit stable advancement", () => {
    expect(selectionTransition(empty, selection())).toBe("advance")
    expect(selectionTransition(selection(), selection("0.1.0-beta.2"))).toBe("advance")
    expect(selectionTransition(selection(), selection("0.1.0"))).toBe("advance")
    expect(selectionTransition(selection("0.1.0"), selection("0.1.1"))).toBe("advance")
    expect(selectionTransition(selection(), structuredClone(selection()))).toBe("unchanged")
  })

  test("refuses downgrade, stable-to-preview and replacement of a selected version", () => {
    expect(() => selectionTransition(selection("0.1.0-beta.2"), selection())).toThrow("downgrade")
    expect(() => selectionTransition(selection("0.2.0"), selection("0.1.0"))).toThrow("downgrade")
    expect(() => selectionTransition(selection("0.1.0"), selection("0.2.0-beta.1"))).toThrow("switch stable")
    const changed = selection()
    changed.release.assets[0]!.sha256 = "f".repeat(64)
    expect(() => selectionTransition(selection(), changed)).toThrow("different bytes or evidence")
    expect(() => selectionTransition(selection(), empty)).toThrow("empty selection")
  })

  test("refuses candidate fields, malformed identity and duplicate installer inventory", () => {
    expect(() => selectionTransition(empty, { ...selection(), publication: false })).toThrow("fields")
    const duplicate = selection()
    duplicate.release.assets[2] = duplicate.release.assets[1]!
    expect(() => selectionTransition(empty, duplicate)).toThrow("inventory")
    const identity = selection()
    identity.release.sourceRevision += "\n"
    expect(() => selectionTransition(empty, identity)).toThrow("identity")
    const asset = selection()
    Object.assign(asset.release.assets[0]!, { credential: "must not enter the website" })
    expect(() => selectionTransition(empty, asset)).toThrow("fields")
  })
})

describe("selection-only website PR promotion", () => {
  test("rejects a changed trusted byte digest before any API request", async () => {
    const data = fixture()
    await expect(proposeWebsiteSelection({ ...data.input, expectedSha256: "0".repeat(64) })).rejects.toThrow(
      "trusted readback digest",
    )
    expect(data.calls).toHaveLength(0)
  })

  test("creates only a dedicated branch, a blob-CAS selection change and a review PR", async () => {
    const data = fixture()
    expect(await proposeWebsiteSelection(data.input)).toEqual({
      status: "proposed",
      url: "https://github.com/PhysicalSystems/platform/pull/99",
    })
    const mutations = data.calls.filter((call) => call.method !== "GET")
    expect(mutations.map(({ suffix, method }) => `${method} ${suffix}`)).toEqual([
      "POST git/refs",
      `PUT contents/${selectedPath}`,
      "POST pulls",
    ])
    const update = mutations[1]!.body!
    expect(update.branch).toBe(data.branch)
    expect(update.sha).toBe(data.state.mainBlob)
    expect(Buffer.from(String(update.content), "base64")).toEqual(data.bytes)
    expect(mutations[2]!.body?.base).toBe("main")
    expect(mutations[2]!.body?.head).toBe(data.branch)
    expect(JSON.stringify(mutations.map((call) => call.body))).not.toContain(data.token)
    expect(
      data.calls.some((call) => call.suffix.includes("merge") || call.method === "PATCH" || call.method === "DELETE"),
    ).toBe(false)
  })

  test("returns unchanged without a branch or PR when main already selects the exact evidence", async () => {
    const data = fixture(selection())
    expect(await proposeWebsiteSelection(data.input)).toEqual({ status: "unchanged", url: null })
    expect(data.calls).toHaveLength(2)
    expect(data.calls.every((call) => call.method === "GET")).toBe(true)
  })

  test("refuses a promotion branch containing unrelated changes", async () => {
    const data = fixture()
    data.state.branchExists = true
    data.state.unrelated = true
    await expect(proposeWebsiteSelection(data.input)).rejects.toThrow("unrelated changes")
    expect(data.calls.every((call) => call.method === "GET")).toBe(true)
  })

  test("does not open a PR after detecting unrelated concurrent branch edits", async () => {
    const data = fixture()
    data.state.unrelatedAfterPut = true
    await expect(proposeWebsiteSelection(data.input)).rejects.toThrow("outside the selected file")
    expect(data.calls.filter((call) => call.method === "PUT")).toHaveLength(1)
    expect(data.calls.some((call) => call.suffix === "pulls" && call.method === "POST")).toBe(false)
  })

  test("rechecks the selected bytes and main revision before opening a PR", async () => {
    for (const flag of ["replaceAfterPut", "mainMovedAfterPut"] as const) {
      const data = fixture()
      data.state[flag] = true
      await expect(proposeWebsiteSelection(data.input)).rejects.toThrow(
        flag === "replaceAfterPut" ? "no longer contains" : "main changed",
      )
      expect(data.calls.filter((call) => call.method === "PUT")).toHaveLength(1)
      expect(data.calls.some((call) => call.suffix === "pulls" && call.method === "POST")).toBe(false)
    }
  })

  test("sanitizes synchronously thrown transport and malformed JSON errors", async () => {
    const data = fixture()
    for (const request of [
      (): Promise<Response> => {
        throw new Error(data.token)
      },
      async () => new Response(`not JSON: ${data.token}`),
    ]) {
      const failure = await proposeWebsiteSelection({ ...data.input, fetch: request }).catch((error: Error) => error)
      expect(failure).toBeInstanceOf(Error)
      expect(String(failure)).toContain("uncertain")
      expect(String(failure)).not.toContain(data.token)
    }
  })

  test("reuses an existing exact selection PR without a second file update", async () => {
    const data = fixture()
    data.state.branchExists = true
    data.state.current = data.bytes
    data.state.pull = { html_url: "https://github.com/PhysicalSystems/platform/pull/99" }
    expect(await proposeWebsiteSelection(data.input)).toEqual({ status: "proposed", url: data.state.pull.html_url })
    expect(data.calls.every((call) => call.method === "GET")).toBe(true)
  })

  test("an uncertain successful PUT is reconciled by reading the branch on explicit retry", async () => {
    const data = fixture()
    data.state.putFailure = "uncertain"
    const failure = await proposeWebsiteSelection(data.input).catch((error: Error) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toContain("outcome is uncertain")
    expect(String(failure)).not.toContain(data.token)
    expect(data.calls.filter((call) => call.method === "PUT")).toHaveLength(1)
    expect(data.calls.some((call) => call.suffix === "pulls" && call.method === "POST")).toBe(false)
    data.state.putFailure = ""
    await proposeWebsiteSelection(data.input)
    expect(data.calls.filter((call) => call.method === "PUT")).toHaveLength(1)
    expect(data.calls.filter((call) => call.suffix === "pulls" && call.method === "POST")).toHaveLength(1)
  })

  test("does not blindly retry a conflicting file update or duplicate an uncertain PR", async () => {
    const data = fixture()
    data.state.putFailure = "conflict"
    await expect(proposeWebsiteSelection(data.input)).rejects.toThrow("409")
    expect(data.calls.filter((call) => call.method === "PUT")).toHaveLength(1)
    expect(data.calls.some((call) => call.suffix === "pulls" && call.method === "POST")).toBe(false)
    const uncertain = fixture()
    uncertain.state.prFailure = true
    await expect(proposeWebsiteSelection(uncertain.input)).rejects.toThrow("outcome is uncertain")
    uncertain.state.prFailure = false
    await proposeWebsiteSelection(uncertain.input)
    expect(uncertain.calls.filter((call) => call.suffix === "pulls" && call.method === "POST")).toHaveLength(1)
    expect(uncertain.calls.filter((call) => call.method === "PUT")).toHaveLength(1)
  })
})
