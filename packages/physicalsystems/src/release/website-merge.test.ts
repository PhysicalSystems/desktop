// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mergeWebsiteSelection, waitForWebsiteSelection } from "./website-merge"

function fixture() {
  const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
  const head = "a".repeat(40)
  const main = "b".repeat(40)
  const empty = Buffer.from(
    JSON.stringify({ schemaVersion: 1, repository: "PhysicalSystems/physicalsystems", release: null }),
  )
  const bytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      repository: "PhysicalSystems/physicalsystems",
      release: {
        version: "0.1.0-beta.1",
        tag: "desktop-v0.1.0-beta.1",
        channel: "preview",
        releaseId: 123,
        publishedAt: "2026-09-07T20:00:00Z",
        sourceRevision: head,
        inputsSha256: sha("inputs"),
        assets: ["windows-x64.exe", "linux-x64.deb", "linux-x64.AppImage"].map((suffix) => ({
          name: `physical-systems-desktop-0.1.0-beta.1-${suffix}`,
          bytes: 100,
          sha256: sha(suffix),
        })),
      },
    }),
  )
  const state = {
    merged: false,
    mergeCalls: 0,
    reads: 0,
    waits: 0,
    queued: false,
    changed: false,
    unrelated: false,
    changedBytes: false,
    changedMain: false,
    uncertain: false,
    blocked: false,
    runSha: head,
    runPath: ".github/workflows/website-ci.yml",
    conclusion: "success",
    runBase: main,
    runPR: 99,
    jobConclusion: "success",
  }
  const token = "private-fixture-credential"
  const content = (value: Buffer) => ({
    path: "public/desktop-selection.json",
    encoding: "base64",
    content: value.toString("base64"),
  })
  const request = async (url: string, init?: RequestInit) => {
    expect(url.startsWith("https://api.github.com/repos/PhysicalSystems/platform/")).toBe(true)
    expect(init?.redirect).toBe("error")
    const endpoint = url.slice("https://api.github.com/repos/PhysicalSystems/platform/".length)
    if (endpoint === "pulls/99") {
      state.reads++
      return Response.json({
        base: { repo: { full_name: "PhysicalSystems/platform" }, ref: "main", sha: main },
        head: {
          repo: { full_name: "PhysicalSystems/platform" },
          ref: "desktop-download-0.1.0b1",
          sha: state.changed && state.reads > 1 ? "c".repeat(40) : head,
        },
        state: "open",
        draft: false,
        changed_files: 1,
        merged: state.merged,
        mergeable: true,
        mergeable_state: state.blocked ? "blocked" : "clean",
      })
    }
    if (endpoint === "git/ref/heads/main")
      return Response.json({ object: { sha: state.changedMain ? "d".repeat(40) : main } })
    if (endpoint.startsWith("contents/"))
      return Response.json(
        content(endpoint.endsWith(head) ? (state.changedBytes ? empty : bytes) : state.merged ? bytes : empty),
      )
    if (endpoint === "pulls/99/files?per_page=100")
      return Response.json([
        { filename: state.unrelated ? "src/unrelated.ts" : "public/desktop-selection.json", status: "modified" },
      ])
    if (endpoint.startsWith("actions/workflows/website-ci.yml/runs?"))
      return Response.json({
        total_count: 1,
        workflow_runs: [
          {
            id: 123,
            run_attempt: 2,
            pull_requests: [{ number: state.runPR, head: { sha: head }, base: { sha: state.runBase } }],
            head_sha: state.runSha,
            path: state.runPath,
            event: "pull_request",
            head_repository: { full_name: "PhysicalSystems/platform" },
            status: state.queued ? "in_progress" : "completed",
            conclusion: state.conclusion,
          },
        ],
      })
    if (endpoint === "actions/runs/123/attempts/2/jobs?per_page=100")
      return Response.json({
        total_count: 1,
        jobs: [{ name: "Website validation", head_sha: head, status: "completed", conclusion: state.jobConclusion }],
      })
    if (endpoint === "pulls/99/merge") {
      expect(init?.method).toBe("PUT")
      expect(JSON.parse(String(init?.body))).toEqual({ sha: head, merge_method: "squash" })
      state.mergeCalls++
      state.merged = true
      if (state.uncertain) throw new Error(token)
      return Response.json({ merged: true })
    }
    throw new Error(`Unexpected fixture request ${endpoint}`)
  }
  return {
    state,
    token,
    input: {
      bytes,
      expectedSha256: sha(bytes),
      token,
      url: "https://github.com/PhysicalSystems/platform/pull/99",
      fetch: request,
      wait: async () => {
        state.waits++
      },
    },
  }
}

describe("automatic website integration after release approval", () => {
  test("waits for exact commit validation, merges once and confirms main selection", async () => {
    const data = fixture()
    data.state.queued = true
    expect(
      await mergeWebsiteSelection({
        ...data.input,
        wait: async () => {
          data.state.waits++
          data.state.queued = false
        },
      }),
    ).toEqual({
      status: "merged",
      url: data.input.url,
    })
    expect(data.state.waits).toBe(1)
    expect(data.state.mergeCalls).toBe(1)
  })
  test("does not merge stale or differently identified workflow results", async () => {
    for (const field of ["runSha", "runPath"] as const) {
      const data = fixture()
      data.state[field] = "unrelated"
      await expect(mergeWebsiteSelection(data.input)).rejects.toThrow("15 minutes")
      expect(data.state.mergeCalls).toBe(0)
      expect(data.state.waits).toBe(90)
    }
  })
  test("refuses failed checks, changed source or selection, unrelated files and repository blocks", async () => {
    for (const flag of ["changed", "changedBytes", "unrelated", "changedMain", "blocked"] as const) {
      const data = fixture()
      data.state[flag] = true
      await expect(mergeWebsiteSelection(data.input)).rejects.toThrow()
      expect(data.state.mergeCalls).toBe(0)
    }
    for (const conclusion of ["failure", "cancelled", "skipped", "neutral", "timed_out"]) {
      const data = fixture()
      data.state.conclusion = conclusion
      await expect(mergeWebsiteSelection(data.input)).rejects.toThrow("validation failed")
      expect(data.state.mergeCalls).toBe(0)
    }
  })
  test("reconciles an uncertain successful merge without another mutation and sanitizes credentials", async () => {
    const data = fixture()
    data.state.uncertain = true
    const error = await mergeWebsiteSelection(data.input).catch((error: Error) => error)
    expect(String(error)).toContain("uncertain")
    expect(String(error)).not.toContain(data.token)
    expect((await mergeWebsiteSelection(data.input)).status).toBe("merged")
    expect(data.state.mergeCalls).toBe(1)
  })
  test("refuses changed approval bytes before API access", async () => {
    const data = fixture()
    await expect(mergeWebsiteSelection({ ...data.input, expectedSha256: "0".repeat(64) })).rejects.toThrow(
      "trusted readback",
    )
    expect(data.state.reads).toBe(0)
  })
})

test("deployment retries stale and failed responses and confirms exact public bytes without credentials", async () => {
  const bytes = Buffer.from('{"fixture":"approved selection"}')
  let calls = 0
  await waitForWebsiteSelection({
    bytes,
    wait: async () => {},
    fetch: async (url, init) => {
      expect(url.startsWith("https://physicalsystems.ai/")).toBe(true)
      if (url.endsWith("/api/health")) return Response.json({ ok: true })
      if (url.endsWith("/download"))
        return new Response("<title>Download Desktop | Physical Systems</title>", {
          headers: { "content-type": "text/html" },
        })
      expect(new Headers(init?.headers).has("Authorization")).toBe(false)
      expect(init?.redirect).toBe("error")
      calls++
      if (calls === 1) return new Response(null, { status: 503 })
      if (calls === 2) return new Response("stale release")
      if (calls === 3) return new Response("x".repeat(65537))
      return new Response(bytes)
    },
  })
  expect(calls).toBe(4)
})

test("does not report deployment complete when Render never serves the selection", async () => {
  await expect(
    waitForWebsiteSelection({
      bytes: Buffer.from("expected"),
      wait: async () => {},
      fetch: async () => new Response("previous release"),
    }),
  ).rejects.toThrow("not confirmed")
})

test("refuses CI from another PR, stale base or unsuccessful current job attempt", async () => {
  for (const field of ["runBase", "runPR", "jobConclusion"] as const) {
    const data = fixture()
    if (field === "runPR") data.state.runPR = 98
    else data.state[field] = "stale"
    await expect(mergeWebsiteSelection(data.input)).rejects.toThrow()
    expect(data.state.mergeCalls).toBe(0)
  }
})

test("does not claim deployment success when the selected files exist but the app is unhealthy", async () => {
  const bytes = Buffer.from("selection")
  await expect(
    waitForWebsiteSelection({
      bytes,
      wait: async () => {},
      fetch: async (url) =>
        url.includes("desktop-selection.json") ? new Response(bytes) : Response.json({ ok: false }),
    }),
  ).rejects.toThrow("not confirmed")
})
