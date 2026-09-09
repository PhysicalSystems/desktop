// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { publicReviewDigest, unsignedWindowsPreviewWarning } from "./public-downloads"
import {
  preparePublicPublication,
  publishPreparedPublication,
  validatePublisherPrerequisites,
  validateQualifiedDistribution,
  verifyQualifiedBundle,
} from "./public-publisher"
import type { QualifiedDistribution } from "./public-publisher"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const sha = (value: string) => createHash("sha256").update(value).digest("hex")
const api = "https://api.github.com/repos/PhysicalSystems/physicalsystems/"
async function fixture(unsigned = false, skipProvider = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "physical-public-publisher-"))
  roots.push(directory)
  const version = "0.1.0-beta.1"
  const names = ["windows-x64.exe", "linux-x64.deb", "linux-x64.AppImage"].map(
    (name) => `physical-systems-desktop-${version}-${name}`,
  )
  const payloads = names.map((name) => `Synthetic public publisher unit fixture: ${name}`)
  const receipt = JSON.stringify({ scope: "unit-fixture-only", nativeVerification: "not performed by this test" })
  const receiptSha = sha(receipt)
  const data: QualifiedDistribution = {
    schemaVersion: 1,
    kind: "qualified-public-desktop-distribution",
    qualificationBundleSha256: receiptSha,
    facts: {
      repository: "PhysicalSystems/physicalsystems",
      version,
      channel: "preview",
      tag: `desktop-v${version}`,
      sourceRevision: "a".repeat(40),
      inputsSha256: "b".repeat(64),
      identity: { appId: "systems.physical.desktop.preview", productName: "Physical Systems" },
      windowsSigning: {
        status: "verified",
        publisher: "Synthetic Fixture Publisher",
        certificateThumbprint: "D".repeat(40),
        installerSha256: sha(payloads[0]!),
        executableSha256: "e".repeat(64),
        verificationReportSha256: receiptSha,
      },
      assets: names.map((name, index) => ({
        name,
        bytes: Buffer.byteLength(payloads[index]!),
        sha256: sha(payloads[index]!),
        qualification: {
          reportSha256: receiptSha,
          checks: {
            "artifact-integrity": "PASS",
            "bundled-runtime": "PASS",
            "desktop-version": "PASS",
            launch: "PASS",
            "device-isolation": "PASS",
            "synthetic-chat": "PASS",
            "inline-approval": "PASS",
            reload: "PASS",
            cleanup: "PASS",
            "native-credential-storage": "PASS",
            "provider-browser-sign-in": skipProvider ? "NOT_TESTED" : "PASS",
            "fresh-install": "PASS",
            upgrade: "PASS",
            "failed-upgrade-recovery": "PASS",
            "uninstall-reinstall": "PASS",
            "configuration-preservation": "PASS",
            "platform-display": "PASS",
          },
        },
      })),
    },
  }
  if (unsigned)
    data.facts.windowsSigning = {
      status: "unsigned-preview",
      installerSha256: data.facts.windowsSigning.installerSha256,
      executableSha256: data.facts.windowsSigning.executableSha256,
      verificationReportSha256: data.facts.windowsSigning.verificationReportSha256,
    }
  await writeFile(path.join(directory, "qualified-distribution.json"), JSON.stringify(data))
  await writeFile(path.join(directory, `${receiptSha}.json`), receipt)
  for (let index = 0; index < names.length; index++)
    await writeFile(path.join(directory, names[index]!), payloads[index]!)
  type Release = {
    id: number
    tag_name: string
    draft: boolean
    prerelease: boolean
    body: string
    assets: { id: number; name: string; size: number; state: string; digest: string; browser_download_url: string }[]
    html_url: string
    published_at: string
  }
  const state = {
    releases: [] as Release[],
    next: 200,
    calls: [] as { url: string; method: string; authorization: string | null }[],
    loseUploadAck: false,
    losePublishAck: false,
    loseCreateAck: false,
    reservedTag: false,
    corruptPublic: false,
  }
  const fetcher = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    const authorization = new Headers(init?.headers).get("authorization")
    state.calls.push({ url, method, authorization })
    if (url === `${api}releases?per_page=100&page=1`) return Response.json(state.releases)
    if (url.startsWith(`${api}git/ref/tags/`))
      return state.reservedTag ? Response.json({ ref: "reserved" }) : new Response(null, { status: 404 })
    if (url === `${api}git/ref/heads/main`) return Response.json({ object: { sha: "c".repeat(40) } })
    if (url === `${api}releases` && method === "POST") {
      const body = JSON.parse(String(init?.body))
      expect(body.draft).toBe(true)
      expect(body.target_commitish).toBe("c".repeat(40))
      const release: Release = {
        ...body,
        id: 10,
        assets: [],
        html_url: `https://github.com/PhysicalSystems/physicalsystems/releases/tag/${body.tag_name}`,
        published_at: "2026-09-07T10:00:00Z",
      }
      state.releases.push(release)
      if (state.loseCreateAck) {
        state.loseCreateAck = false
        throw new Error("lost draft acknowledgement")
      }
      return Response.json(release)
    }
    if (url.startsWith("https://uploads.github.com/")) {
      expect(method).toBe("POST")
      const name = new URL(url).searchParams.get("name")!
      const index = names.indexOf(name)
      expect(await (init?.body as Blob).text()).toBe(payloads[index])
      const asset = {
        id: state.next++,
        name,
        size: data.facts.assets[index]!.bytes,
        state: "uploaded",
        digest: `sha256:${data.facts.assets[index]!.sha256}`,
        browser_download_url: `https://github.com/PhysicalSystems/physicalsystems/releases/download/${data.facts.tag}/${name}`,
      }
      state.releases[0]!.assets.push(asset)
      if (state.loseUploadAck) {
        state.loseUploadAck = false
        throw new Error("lost upload acknowledgement")
      }
      return Response.json(asset)
    }
    if (url.startsWith(`${api}releases/assets/`)) {
      const asset = state.releases[0]?.assets.find((item) => item.id === Number(url.split("/").at(-1)))
      if (!asset) throw new Error("Unexpected draft asset ID")
      return new Response(payloads[names.indexOf(asset.name)])
    }
    if (url === `${api}releases/10`) {
      if (method === "PATCH") {
        expect(JSON.parse(String(init?.body))).toEqual({ draft: false, make_latest: "false" })
        state.releases[0]!.draft = false
        if (state.losePublishAck) {
          state.losePublishAck = false
          throw new Error("lost publication acknowledgement")
        }
      }
      return Response.json(state.releases[0])
    }
    if (url === `${api}releases/tags/${data.facts.tag}`) {
      expect(authorization).toBe(null)
      return Response.json(state.releases[0])
    }
    const asset = state.releases[0]?.assets.find((item) => item.browser_download_url === url)
    if (asset) {
      expect(authorization).toBe(null)
      return new Response(state.corruptPublic ? "altered" : payloads[names.indexOf(asset.name)])
    }
    throw new Error(`Unexpected fixture request: ${method} ${url}`)
  }
  const common = {
    directory,
    sourceRevision: data.facts.sourceRevision,
    expectedSha256: publicReviewDigest(data),
    token: "synthetic-token-not-a-credential",
    fetch: fetcher,
  }
  const publish = async (prepared: Awaited<ReturnType<typeof preparePublicPublication>>) =>
    publishPreparedPublication({
      ...common,
      prepared: prepared.prepared,
      expectedPreparedSha256: prepared.preparedSha256,
      approvedRunUrl: "https://github.com/PhysicalSystems/desktop/actions/runs/123",
      publicFetch: fetcher,
    })
  return { data, directory, state, common, publish }
}

describe("protected exact-byte public desktop publisher", () => {
  test("explicit unsigned preview keeps all formats, protected approval and exact warning through publication", async () => {
    const data = await fixture(true, true)
    const prepared = await preparePublicPublication(data.common)
    expect(data.state.releases[0].body).toContain(unsignedWindowsPreviewWarning)
    expect(data.state.releases[0].body).toContain("Provider sign-in has not been verified for this preview.")
    expect(data.state.releases[0].body).toContain("downloaded unsigned preview `.exe`")
    expect(data.state.releases[0].body).not.toContain("downloaded signed")
    expect(data.state.releases[0].prerelease).toBe(true)
    expect(data.state.releases[0].draft).toBe(true)
    expect(prepared.prepared.assets).toHaveLength(3)
    const published = await data.publish(prepared)
    expect(published.review.windowsSigning.status).toBe("unsigned-preview")
    expect(
      published.review.assets.every((asset) => asset.qualification.checks["provider-browser-sign-in"] === "NOT_TESTED"),
    ).toBe(true)
    expect(published.review.approval.decision).toBe("approved")
    expect(published.selection.schemaVersion).toBe(2)
    expect(published.selection.release.windowsSigning).toEqual({
      status: "unsigned-preview",
      warning: unsignedWindowsPreviewWarning,
    })
  })

  test("unsigned preview cannot be republished as stable or lose its unsigned release warning", async () => {
    const relabeled = await fixture(true)
    relabeled.data.facts.channel = "stable"
    relabeled.data.facts.version = "0.1.0"
    relabeled.data.facts.tag = "desktop-v0.1.0"
    await writeFile(path.join(relabeled.directory, "qualified-distribution.json"), JSON.stringify(relabeled.data))
    await expect(
      preparePublicPublication({ ...relabeled.common, expectedSha256: publicReviewDigest(relabeled.data) }),
    ).rejects.toThrow("stable must be signed")
    expect(relabeled.state.calls).toHaveLength(0)

    const warning = await fixture(true)
    const prepared = await preparePublicPublication(warning.common)
    warning.state.releases[0].body = warning.state.releases[0].body.replace(unsignedWindowsPreviewWarning, "")
    await expect(warning.publish(prepared)).rejects.toThrow("reservation conflicts")
    expect(warning.state.releases[0].draft).toBe(true)
  })

  test("completes one draft, publishes once and returns complete anonymous selection", async () => {
    const data = await fixture()
    const prepared = await preparePublicPublication(data.common)
    expect(data.state.releases[0]!.draft).toBe(true)
    const body = data.state.releases[0]!.body
    expect(body).toContain("sudo apt install ./physical-systems-desktop-0.1.0-beta.1-linux-x64.deb")
    expect(body).toContain("sudo apt remove physical-systems-desktop")
    expect(body).toContain("Settings → Apps → Installed apps")
    expect(body).toContain(
      `https://github.com/PhysicalSystems/desktop/blob/${data.data.facts.sourceRevision}/release/appimage-runtime.md#advanced-user-setup`,
    )
    expect(body).toContain(
      `https://github.com/PhysicalSystems/desktop/blob/${data.data.facts.sourceRevision}/release/install-desktop.md`,
    )
    expect(body).not.toContain("/blob/main/")
    expect(body).toContain("--appimage-extract-and-run")
    expect(body).toContain("artifact-specific Ubuntu AppArmor prerequisite")
    expect(body).toContain("Windows 2025 and Ubuntu 24.04")
    expect(body).toContain("X11/Xvfb")
    expect(body).toContain("AppImage double-click/FUSE startup")
    expect(body).toContain("optical flicker are not measured")
    expect(body).toContain("does not establish live robot behavior")
    for (const asset of data.data.facts.assets) expect(body).toContain(`\`${asset.name}\`: \`${asset.sha256}\``)
    expect(prepared.prepared.assets).toHaveLength(3)
    expect(JSON.stringify(prepared)).not.toContain('"approved"')
    const result = await data.publish(prepared)
    expect(result.review.approval.protectedRunUrl).toEndWith("/123")
    expect(result.selection.release.assets).toHaveLength(3)
    expect(data.state.calls.filter((call) => call.method === "POST")).toHaveLength(4)
    expect(data.state.calls.filter((call) => call.method === "PATCH")).toHaveLength(1)
    expect((await data.publish(prepared)).selection).toEqual(result.selection)
    expect(data.state.calls.filter((call) => call.method === "PATCH")).toHaveLength(1)
  })
  test("rejects unsigned candidates, incomplete qualification and development identity", async () => {
    for (const mutate of [
      (data: QualifiedDistribution) => {
        data.kind = "candidate" as never
      },
      (data: QualifiedDistribution) => {
        data.facts.windowsSigning.status = "unsigned" as never
      },
      (data: QualifiedDistribution) => {
        data.facts.identity.appId = "systems.physical.desktop.development"
      },
      (data: QualifiedDistribution) => {
        data.facts.assets[0]!.qualification.checks["native-credential-storage"] = "NOT_TESTED" as never
      },
    ]) {
      const data = await fixture()
      mutate(data.data)
      expect(() => validateQualifiedDistribution(data.data, publicReviewDigest(data.data))).toThrow()
      expect(data.state.calls).toHaveLength(0)
    }
  })
  test("requires separately anchored qualification, exact source and installer bytes before writes", async () => {
    const data = await fixture()
    await expect(verifyQualifiedBundle({ ...data.common, expectedSha256: "f".repeat(64) })).rejects.toThrow(
      "independently",
    )
    await expect(verifyQualifiedBundle({ ...data.common, sourceRevision: "e".repeat(40) })).rejects.toThrow(
      "different reviewed source",
    )
    await writeFile(path.join(data.directory, data.data.facts.assets[2]!.name), "altered")
    await expect(preparePublicPublication(data.common)).rejects.toThrow("Installer size")
    expect(data.state.calls).toHaveLength(0)
  })
  test("refuses extra evidence or credentials in a qualified bundle", async () => {
    const data = await fixture()
    await writeFile(path.join(data.directory, "auth.json"), "synthetic-fixture")
    await expect(preparePublicPublication(data.common)).rejects.toThrow("only the exact installers")
    expect(data.state.calls).toHaveLength(0)
  })
  test("reconciles lost draft and upload acknowledgements without duplicate releases or overwrites", async () => {
    for (const point of ["loseCreateAck", "loseUploadAck"] as const) {
      const data = await fixture()
      data.state[point] = true
      await expect(preparePublicPublication(data.common)).rejects.toThrow("transport failed")
      expect((await preparePublicPublication(data.common)).prepared.releaseId).toBe(10)
      expect(data.state.releases).toHaveLength(1)
      expect(data.state.releases[0]!.assets).toHaveLength(3)
      expect(data.state.calls.filter((call) => call.url === `${api}releases` && call.method === "POST")).toHaveLength(1)
      expect(data.state.calls.filter((call) => call.url.startsWith("https://uploads.github.com/"))).toHaveLength(3)
      expect(data.state.calls.some((call) => call.method === "DELETE")).toBe(false)
    }
  })
  test("refuses preexisting tag reservations and foreign draft ownership", async () => {
    const tagged = await fixture()
    tagged.state.reservedTag = true
    await expect(preparePublicPublication(tagged.common)).rejects.toThrow("already reserved")
    expect(tagged.state.calls.some((call) => call.method !== "GET")).toBe(false)
    const data = await fixture()
    await preparePublicPublication(data.common)
    data.state.releases[0]!.body = "Another release owns this version"
    const before = data.state.calls.length
    await expect(preparePublicPublication(data.common)).rejects.toThrow("reservation conflicts")
    expect(data.state.calls.slice(before).some((call) => call.method !== "GET")).toBe(false)
  })
  test("rejects altered draft bytes or replaced asset IDs after preparation", async () => {
    const data = await fixture()
    const prepared = await preparePublicPublication(data.common)
    data.state.releases[0]!.assets[0]!.id++
    await expect(data.publish(prepared)).rejects.toThrow("identities changed")
    expect(data.state.calls.some((call) => call.method === "PATCH")).toBe(false)
    const other = await fixture()
    const ready = await preparePublicPublication(other.common)
    other.state.releases[0]!.assets[0]!.digest = `sha256:${"f".repeat(64)}`
    await expect(other.publish(ready)).rejects.toThrow("asset conflicts")
    expect(other.state.calls.some((call) => call.method === "PATCH")).toBe(false)
  })
  test("recovers uncertain publication by reading the same ID without repeating publish", async () => {
    const data = await fixture()
    const prepared = await preparePublicPublication(data.common)
    data.state.losePublishAck = true
    await expect(data.publish(prepared)).rejects.toThrow("transport failed")
    expect(data.state.releases[0]!.draft).toBe(false)
    expect((await data.publish(prepared)).selection.release.releaseId).toBe(10)
    expect(data.state.calls.filter((call) => call.method === "PATCH")).toHaveLength(1)
  })
  test("emits no website selection when public readback differs", async () => {
    const data = await fixture()
    const prepared = await preparePublicPublication(data.common)
    data.state.corruptPublic = true
    await expect(data.publish(prepared)).rejects.toThrow("readback did not verify")
    expect(data.state.releases[0]!.draft).toBe(false)
    data.state.corruptPublic = false
    expect((await data.publish(prepared)).selection.release.assets).toHaveLength(3)
    expect(data.state.calls.filter((call) => call.method === "PATCH")).toHaveLength(1)
  })
  test("transport failures never expose credentials or signed redirect URLs", async () => {
    const trap = "secret-fixture-token https://release-assets.githubusercontent.com/file?signature=secret-fixture-token"
    for (const stage of ["create", "upload", "draft-readback", "publish", "public-readback"]) {
      const data = await fixture()
      const request = async (url: string, init?: RequestInit) => {
        if (
          (stage === "create" && url === `${api}releases` && init?.method === "POST") ||
          (stage === "upload" && url.startsWith("https://uploads.github.com/")) ||
          (stage === "draft-readback" && url.includes("/releases/assets/")) ||
          (stage === "publish" && init?.method === "PATCH") ||
          (stage === "public-readback" && url.includes("/releases/tags/"))
        )
          throw new Error(trap)
        return data.common.fetch(url, init)
      }
      const task = async () => {
        const prepared = await preparePublicPublication({ ...data.common, fetch: request })
        return publishPreparedPublication({
          ...data.common,
          fetch: request,
          publicFetch: request,
          prepared: prepared.prepared,
          expectedPreparedSha256: prepared.preparedSha256,
          approvedRunUrl: "https://github.com/PhysicalSystems/desktop/actions/runs/123",
        })
      }
      const error = await task().then(
        () => null,
        (error: unknown) => error,
      )
      expect(error).toBeInstanceOf(Error)
      expect(String(error)).not.toContain("secret-fixture-token")
      expect(String(error)).not.toContain("signature=")
    }
  })

  test("rejects untrusted producers, rerun attempts, forks and missing reviewers", () => {
    const run = {
      id: 20,
      run_attempt: 1,
      status: "completed",
      conclusion: "success",
      path: ".github/workflows/desktop-public-build.yml",
      head_sha: "a".repeat(40),
      head_branch: "main",
      event: "workflow_dispatch",
      repository: { full_name: "PhysicalSystems/desktop" },
      head_repository: { full_name: "PhysicalSystems/desktop" },
    }
    const environment = {
      name: "desktop-public-release",
      protection_rules: [{ type: "required_reviewers", reviewers: [{ id: 1 }] }],
    }
    const input = { run, attempt: run, environment, runId: "20", runAttempt: "1", sourceRevision: run.head_sha }
    expect(() => validatePublisherPrerequisites(input)).not.toThrow()
    for (const changed of [
      { path: ".github/workflows/desktop-release.yml" },
      { conclusion: "failure" },
      { run_attempt: 2 },
      { head_repository: { full_name: "SomeoneElse/desktop" } },
      { event: "pull_request" },
    ])
      expect(() => validatePublisherPrerequisites({ ...input, run: { ...run, ...changed } })).toThrow("trusted public")
    expect(() =>
      validatePublisherPrerequisites({ ...input, environment: { name: environment.name, protection_rules: [] } }),
    ).toThrow("required reviewers")
  })
})
