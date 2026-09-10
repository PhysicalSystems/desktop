import { describe, expect, test } from "bun:test"
import { desktopUpdaterPolicy, REVIEWED_UPDATER_CONFIGURATION } from "./updater-policy"

// Synthetic policy fixture only; no feed or signing identity is provisioned.
function fixture(): Parameters<typeof desktopUpdaterPolicy>[0] {
  return {
    packaged: true,
    platform: "win32",
    arch: "x64",
    identity: { kind: "public", appId: "systems.physical.desktop", productName: "Physical Systems" },
    configuration: {
      provider: "generic",
      url: "https://github.com/PhysicalSystems/physicalsystems/releases/download/desktop-v0.1.0-beta.99/",
      publisherName: "Physical Systems Test Fixture",
      verifyUpdateCodeSignature: true,
    },
    packagedConfiguration: { publisherName: "Physical Systems Test Fixture", verifyUpdateCodeSignature: true },
    nativeSignatureVerification: true,
  }
}

describe("desktop updater policy", () => {
  test("keeps the actual release disabled without a reviewed configuration", () => {
    expect(REVIEWED_UPDATER_CONFIGURATION).toBeUndefined()
    expect(desktopUpdaterPolicy({ ...fixture(), configuration: REVIEWED_UPDATER_CONFIGURATION })).toEqual({
      enabled: false,
      reason: "unqualified-release",
    })
  })

  test("accepts the future Windows constraints only with a matching packaged publisher and active verifier", () => {
    const input = fixture()
    expect(desktopUpdaterPolicy(input)).toEqual({ enabled: true, configuration: input.configuration })
    expect(
      desktopUpdaterPolicy({
        ...input,
        packagedConfiguration: { publisherName: [input.configuration!.publisherName], verifyUpdateCodeSignature: true },
      }).enabled,
    ).toBe(true)
  })

  test("accepts a selected immutable stable Desktop release directory", () => {
    const input = fixture()
    expect(
      desktopUpdaterPolicy({
        ...input,
        configuration: {
          ...input.configuration!,
          url: "https://github.com/PhysicalSystems/physicalsystems/releases/download/desktop-v0.1.0/",
        },
      }).enabled,
    ).toBe(true)
  })

  test.each([{ packaged: false }, { platform: "linux" }, { platform: "darwin" }, { arch: "arm64" }, { arch: "ia32" }])(
    "rejects unqualified installations: %j",
    (change) => {
      expect(desktopUpdaterPolicy({ ...fixture(), ...change })).toEqual({
        enabled: false,
        reason: "unsupported-installation",
      })
    },
  )

  test.each([
    { kind: "candidate" },
    { appId: "systems.physical.desktop.development" },
    { appId: "ai.opencode.desktop" },
    { productName: "Physical Systems Candidate" },
    { productName: "OpenCode" },
  ])("rejects a different app identity: %j", (change) => {
    const input = fixture()
    expect(desktopUpdaterPolicy({ ...input, identity: { ...input.identity, ...change } })).toEqual({
      enabled: false,
      reason: "unsupported-identity",
    })
  })

  test.each([
    "http://github.com/PhysicalSystems/physicalsystems/releases/download/desktop-v0.1.0/",
    "https://github.com/anomalyco/opencode/releases/download/v1.0.0/",
    "https://updates.example.com/desktop/",
    "https://github.com.evil.example/PhysicalSystems/physicalsystems/releases/download/desktop-v0.1.0/",
    "https://github.com@evil.example/PhysicalSystems/physicalsystems/releases/download/desktop-v0.1.0/",
    "https://github.com:8443/PhysicalSystems/physicalsystems/releases/download/desktop-v0.1.0/",
    "https://github.com/PhysicalSystems/desktop/releases/download/desktop-v0.1.0/",
    "https://github.com/PhysicalSystems/physicalsystems/releases/latest/download/",
    "https://github.com/PhysicalSystems/physicalsystems/releases/download/physicalsystems-node-v0.2.1-candidate/",
    "https://github.com/PhysicalSystems/physicalsystems/releases/download/desktop-v0.1.0/../other/",
    "https://github.com/PhysicalSystems/physicalsystems/releases/download/desktop-v0.1.0/%2e%2e/",
    "https://github.com/PhysicalSystems/physicalsystems/releases/download/desktop-v01.1.0/",
    "https://github.com/PhysicalSystems/physicalsystems/releases/download/desktop-v0.1.0-beta.0/",
    "https://github.com/PhysicalSystems/physicalsystems/releases/download/desktop-v0.1.0/?redirect=elsewhere",
    "https://github.com/PhysicalSystems/physicalsystems/releases/download/desktop-v0.1.0/#latest.yml",
    "https://github.com/PhysicalSystems/physicalsystems/releases/download/desktop-v0.1.0/\n",
  ])("rejects an unowned or ambiguous feed: %s", (url) => {
    const input = fixture()
    expect(desktopUpdaterPolicy({ ...input, configuration: { ...input.configuration!, url } })).toEqual({
      enabled: false,
      reason: "untrusted-feed",
    })
  })

  test.each(["", " ", " Physical Systems", "Physical Systems ", "Physical\nSystems", "x".repeat(201)])(
    "rejects a missing or malformed expected publisher: %j",
    (publisherName) => {
      const input = fixture()
      expect(desktopUpdaterPolicy({ ...input, configuration: { ...input.configuration!, publisherName } })).toEqual({
        enabled: false,
        reason: "unverified-publisher",
      })
    },
  )

  test("rejects disabled signature verification in the reviewed configuration", () => {
    const input = fixture()
    expect(
      desktopUpdaterPolicy({ ...input, configuration: { ...input.configuration!, verifyUpdateCodeSignature: false } }),
    ).toEqual({ enabled: false, reason: "unverified-publisher" })
  })

  test.each(
    [
      undefined,
      null,
      {},
      "Physical Systems Test Fixture",
      [],
      { verifyUpdateCodeSignature: true },
      { publisherName: "Physical Systems Test Fixture" },
      { publisherName: "Physical Systems Test Fixture", verifyUpdateCodeSignature: false },
      { publisherName: "Someone Else", verifyUpdateCodeSignature: true },
      { publisherName: [], verifyUpdateCodeSignature: true },
      { publisherName: ["Physical Systems Test Fixture", "Someone Else"], verifyUpdateCodeSignature: true },
    ].map((packagedConfiguration) => ({ packagedConfiguration })),
  )("rejects missing or mismatched packaged verification: %j", (input) => {
    expect(desktopUpdaterPolicy({ ...fixture(), packagedConfiguration: input.packagedConfiguration })).toEqual({
      enabled: false,
      reason: "native-verification-unavailable",
    })
  })

  test("a publisher and verification flags do not substitute for an active native verifier", () => {
    expect(desktopUpdaterPolicy({ ...fixture(), nativeSignatureVerification: false })).toEqual({
      enabled: false,
      reason: "native-verification-unavailable",
    })
  })
})
