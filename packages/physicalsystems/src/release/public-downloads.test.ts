// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { publicReviewDigest, verifyPublicDownloads } from "./public-downloads"
import type { PublicDistributionReview } from "./public-downloads"

const sha = (text: string) => createHash("sha256").update(text).digest("hex")
const repository = "PhysicalSystems/physicalsystems"

function fixture() {
  const version = "0.1.0-beta.1"
  const names = [
    `physical-systems-desktop-${version}-windows-x64.exe`,
    `physical-systems-desktop-${version}-linux-x64.deb`,
    `physical-systems-desktop-${version}-linux-x64.AppImage`,
  ]
  const payloads = names.map((name) => `Synthetic download fixture bytes for ${name}`)
  const review: PublicDistributionReview = {
    schemaVersion: 1,
    kind: "approved-public-desktop-distribution",
    repository,
    version,
    channel: "preview",
    tag: `desktop-v${version}`,
    releaseId: 12345,
    sourceRevision: "a".repeat(40),
    inputsSha256: "b".repeat(64),
    identity: { appId: "systems.physical.desktop.preview", productName: "Physical Systems" },
    approval: {
      decision: "approved",
      protectedRunUrl: `https://github.com/PhysicalSystems/desktop/actions/runs/123`,
      qualificationBundleSha256: "c".repeat(64),
    },
    windowsSigning: {
      status: "verified",
      publisher: "Fixture Publisher",
      certificateThumbprint: "D".repeat(40),
      installerSha256: sha(payloads[0]!),
      executableSha256: "e".repeat(64),
      verificationReportSha256: "f".repeat(64),
    },
    assets: names.map((name, index) => ({
      name,
      bytes: Buffer.byteLength(payloads[index]!),
      sha256: sha(payloads[index]!),
      qualification: {
        reportSha256: sha(`qualification receipt ${name}`),
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
          "provider-browser-sign-in": "PASS",
          "fresh-install": "PASS",
          upgrade: "PASS",
          "failed-upgrade-recovery": "PASS",
          "uninstall-reinstall": "PASS",
          "configuration-preservation": "PASS",
          "platform-display": "PASS",
        },
      },
    })),
  }
  const metadata = {
    id: review.releaseId,
    tag_name: review.tag,
    draft: false,
    prerelease: true,
    html_url: `https://github.com/${repository}/releases/tag/${review.tag}`,
    published_at: "2026-09-07T20:00:00Z",
    assets: review.assets.map((asset, index) => ({
      id: index + 1,
      name: asset.name,
      size: asset.bytes,
      state: "uploaded",
      digest: `sha256:${asset.sha256}`,
      browser_download_url: `https://github.com/${repository}/releases/download/${review.tag}/${asset.name}`,
    })),
  }
  const calls: { url: string; options?: RequestInit }[] = []
  const request = async (url: string, options?: RequestInit) => {
    calls.push({ url, options })
    if (url === `https://api.github.com/repos/${repository}/releases/tags/${review.tag}`) return Response.json(metadata)
    const index = metadata.assets.findIndex((asset) => asset.browser_download_url === url)
    if (index < 0) throw new Error("Unexpected fixture request")
    return new Response(payloads[index])
  }
  return { review, metadata, calls, payloads, request }
}

describe("anonymous public desktop download readback", () => {
  test("emits exactly the website selection after all reviewed installer bytes match", async () => {
    const data = fixture()
    const result = await verifyPublicDownloads({
      review: data.review,
      expectedReviewSha256: publicReviewDigest(data.review),
      fetch: data.request,
    })
    expect(result).toEqual({
      schemaVersion: 1,
      repository,
      release: {
        tag: data.review.tag,
        version: data.review.version,
        channel: "preview",
        releaseId: data.review.releaseId,
        publishedAt: data.metadata.published_at,
        sourceRevision: data.review.sourceRevision,
        inputsSha256: data.review.inputsSha256,
        assets: data.review.assets.map(({ qualification: _qualification, ...asset }) => asset),
      },
    })
    expect(data.calls).toHaveLength(4)
    for (const call of data.calls) {
      expect(new Headers(call.options?.headers).has("authorization")).toBe(false)
      expect(call.options?.method).toBe("GET")
      expect(call.options?.signal).toBeInstanceOf(AbortSignal)
    }
    expect(data.calls[0]?.options?.redirect).toBe("error")
    expect(data.calls[1]?.options?.redirect).toBe("manual")
    expect(JSON.stringify(result)).not.toContain("Fixture Publisher")
  })

  test("does not accept a self-declared approval without the independent trusted digest", async () => {
    const data = fixture()
    const expectedReviewSha256 = publicReviewDigest(data.review)
    data.review.releaseId++
    await expect(
      verifyPublicDownloads({ review: data.review, expectedReviewSha256, fetch: data.request }),
    ).rejects.toThrow("separately trusted")
    await expect(
      verifyPublicDownloads({ review: data.review, expectedReviewSha256: "", fetch: data.request }),
    ).rejects.toThrow("separately trusted")
    expect(data.calls).toHaveLength(0)
  })

  test("rejects candidate input records, unsigned evidence, development identities and incomplete qualification", async () => {
    for (const mutate of [
      (review: Record<string, unknown>) => {
        review.publication = false
      },
      (review: Record<string, unknown>) => {
        review.kind = "candidate"
      },
      (review: Record<string, unknown>) => {
        ;(review.identity as Record<string, unknown>).appId = "systems.physical.desktop.development"
      },
      (review: Record<string, unknown>) => {
        ;(review.identity as Record<string, unknown>).productName = "Physical Systems Candidate"
      },
      (review: Record<string, unknown>) => {
        ;(review.windowsSigning as Record<string, unknown>).status = "unsigned"
      },
      (review: Record<string, unknown>) => {
        ;(review.windowsSigning as Record<string, unknown>).installerSha256 = "9".repeat(64)
      },
      (review: Record<string, unknown>) => {
        ;(review.assets as PublicDistributionReview["assets"])[0]!.qualification.checks["native-credential-storage"] =
          "NOT_TESTED" as never
      },
      (review: Record<string, unknown>) => {
        ;(review.assets as PublicDistributionReview["assets"])[1]!.qualification.reportSha256 = ""
      },
    ]) {
      const data = fixture()
      mutate(data.review)
      await expect(
        verifyPublicDownloads({
          review: data.review,
          expectedReviewSha256: publicReviewDigest(data.review),
          fetch: data.request,
        }),
      ).rejects.toThrow()
      expect(data.calls).toHaveLength(0)
    }
  })

  test("rejects duplicate formats and arbitrary fields before requesting public data", async () => {
    const data = fixture()
    data.review.assets[2] = data.review.assets[1]!
    await expect(
      verifyPublicDownloads({
        review: data.review,
        expectedReviewSha256: publicReviewDigest(data.review),
        fetch: data.request,
      }),
    ).rejects.toThrow("duplicate")
    const record = { ...fixture().review, token: "must not enter public metadata" }
    await expect(
      verifyPublicDownloads({ review: record, expectedReviewSha256: publicReviewDigest(record), fetch: data.request }),
    ).rejects.toThrow("Unexpected")
    expect(data.calls).toHaveLength(0)
  })

  test("requires the exact public, non-draft release and expected published channel", async () => {
    for (const mutate of [
      (data: ReturnType<typeof fixture>) => {
        data.metadata.draft = true
      },
      (data: ReturnType<typeof fixture>) => {
        data.metadata.prerelease = false
      },
      (data: ReturnType<typeof fixture>) => {
        data.metadata.id++
      },
      (data: ReturnType<typeof fixture>) => {
        data.metadata.tag_name = "desktop-v0.2.0"
      },
      (data: ReturnType<typeof fixture>) => {
        data.metadata.published_at = ""
      },
      (data: ReturnType<typeof fixture>) => {
        data.metadata.html_url = "https://github.com/SomeoneElse/desktop/releases/tag/latest"
      },
    ]) {
      const data = fixture()
      mutate(data)
      await expect(
        verifyPublicDownloads({
          review: data.review,
          expectedReviewSha256: publicReviewDigest(data.review),
          fetch: data.request,
        }),
      ).rejects.toThrow("reviewed publication")
      expect(data.calls).toHaveLength(1)
    }
  })

  test("rejects missing, duplicate, misplaced or mismatched public asset metadata", async () => {
    for (const mutate of [
      (data: ReturnType<typeof fixture>) => {
        data.metadata.assets.pop()
      },
      (data: ReturnType<typeof fixture>) => {
        data.metadata.assets.push(data.metadata.assets[0]!)
      },
      (data: ReturnType<typeof fixture>) => {
        data.metadata.assets[0]!.size++
      },
      (data: ReturnType<typeof fixture>) => {
        data.metadata.assets[0]!.state = "new"
      },
      (data: ReturnType<typeof fixture>) => {
        data.metadata.assets[0]!.digest = `sha256:${"0".repeat(64)}`
      },
      (data: ReturnType<typeof fixture>) => {
        data.metadata.assets[0]!.browser_download_url = "https://example.invalid/installer.exe"
      },
    ]) {
      const data = fixture()
      mutate(data)
      await expect(
        verifyPublicDownloads({
          review: data.review,
          expectedReviewSha256: publicReviewDigest(data.review),
          fetch: data.request,
        }),
      ).rejects.toThrow("asset metadata")
      expect(data.calls).toHaveLength(1)
    }
  })

  test("does not emit a partial selection when the last download is altered or truncated", async () => {
    for (const body of ["changed bytes", "", "x".repeat(1000)]) {
      const data = fixture()
      const request = async (url: string, options?: RequestInit) =>
        url.endsWith(".AppImage") ? new Response(body) : data.request(url, options)
      await expect(
        verifyPublicDownloads({
          review: data.review,
          expectedReviewSha256: publicReviewDigest(data.review),
          fetch: request,
        }),
      ).rejects.toThrow("Public installer")
      expect(data.calls).toHaveLength(3)
    }
  })

  test("accepts GitHub storage redirects but never follows redirects to a private or foreign host", async () => {
    const data = fixture()
    const redirected: string[] = []
    const request = async (url: string, options?: RequestInit) => {
      if (url.startsWith("https://github.com/"))
        return new Response(null, {
          status: 302,
          headers: {
            location: `https://release-assets.githubusercontent.com/review/${encodeURIComponent(url.split("/").at(-1)!)}?fixture=public`,
          },
        })
      if (url.startsWith("https://release-assets.githubusercontent.com/")) {
        redirected.push(url)
        expect(new Headers(options?.headers).has("authorization")).toBe(false)
        return new Response(data.payloads[data.review.assets.findIndex((asset) => url.includes(asset.name))])
      }
      return data.request(url, options)
    }
    expect(
      (
        await verifyPublicDownloads({
          review: data.review,
          expectedReviewSha256: publicReviewDigest(data.review),
          fetch: request,
        })
      ).release.assets,
    ).toHaveLength(3)
    expect(redirected).toHaveLength(3)
    for (const location of [
      "http://127.0.0.1/credentials",
      "https://example.invalid/installer",
      "https://release-assets.githubusercontent.com:8443/file",
      "https://user:password@release-assets.githubusercontent.com/file",
    ]) {
      const unsafe = async (url: string, options?: RequestInit) =>
        url.startsWith("https://github.com/")
          ? new Response(null, { status: 302, headers: { location } })
          : data.request(url, options)
      await expect(
        verifyPublicDownloads({
          review: data.review,
          expectedReviewSha256: publicReviewDigest(data.review),
          fetch: unsafe,
        }),
      ).rejects.toThrow("outside GitHub release storage")
    }
  })

  test("bounds metadata, failed downloads and redirect chains", async () => {
    const data = fixture()
    const options = { review: data.review, expectedReviewSha256: publicReviewDigest(data.review) }
    await expect(
      verifyPublicDownloads({ ...options, fetch: async () => new Response("unavailable", { status: 404 }) }),
    ).rejects.toThrow("anonymously available")
    await expect(
      verifyPublicDownloads({ ...options, fetch: async () => new Response(" ".repeat(2 * 1024 * 1024 + 1)) }),
    ).rejects.toThrow("exceeds the limit")
    let redirects = 0
    const request = async (url: string, init?: RequestInit) => {
      if (url.startsWith("https://api.github.com/")) return data.request(url, init)
      redirects++
      return new Response(null, { status: 302, headers: { location: "https://objects.githubusercontent.com/file" } })
    }
    await expect(verifyPublicDownloads({ ...options, fetch: request })).rejects.toThrow("redirect limit")
    expect(redirects).toBe(4)
  })
})
