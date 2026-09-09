// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { desktopIdentity } from "./identity"
import { publicReviewDigest } from "./public-downloads"
import {
  compiledDesktopIdentity,
  compiledIdentityRecord,
  loadPublicBuildInputs,
  publicSigningConfiguration,
  validatePublicBuildInputs,
  verifyCompiledPublicIdentity,
} from "./public-build"
import type { PublicBuildInputs } from "./public-build"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
function inputs(): PublicBuildInputs {
  return {
    schemaVersion: 1,
    kind: "public-desktop-build",
    sourceRevision: "a".repeat(40),
    releaseInputsSha256: "b".repeat(64),
    version: "0.1.0-beta.1",
    channel: "preview",
    identity: desktopIdentity("public"),
    publication: false,
    windowsSigning: {
      provider: "pfx",
      publisher: "Synthetic Fixture Publisher",
      certificateThumbprint: "C".repeat(40),
    },
  }
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "physical-public-build-"))
  roots.push(root)
  const data = inputs()
  const file = path.join(root, "public-build-inputs.json")
  await writeFile(file, JSON.stringify(data))
  const env = {
    PHYSICALSYSTEMS_PUBLIC_BUILD_INPUTS: file,
    PHYSICALSYSTEMS_EXPECTED_PUBLIC_BUILD_SHA256: publicReviewDigest(data),
    PHYSICALSYSTEMS_EXPECTED_INPUTS_SHA256: data.releaseInputsSha256,
  }
  return { root, data, env }
}

describe("public desktop compile-time identity and signing policy", () => {
  test("an explicit unsigned preview needs no signing credentials and cannot become stable", () => {
    const data = inputs()
    data.windowsSigning = { provider: "unsigned-preview" }
    expect(validatePublicBuildInputs(data, publicReviewDigest(data)).windowsSigning).toEqual({
      provider: "unsigned-preview",
    })
    expect(publicSigningConfiguration(data, {}, "win32")).toEqual({})
    expect(publicSigningConfiguration(data, { AZURE_CLIENT_SECRET: "unused-private-fixture" }, "win32")).toEqual({})
    data.version = "0.1.0"
    data.channel = "stable"
    expect(() => validatePublicBuildInputs(data, publicReviewDigest(data))).toThrow()
    expect(() => publicSigningConfiguration(data, {}, "win32")).toThrow()
  })
  test("unsigned preview policy cannot contain a claimed publisher, certificate or credentials", () => {
    for (const extra of [
      { publisher: "invented publisher" },
      { certificateThumbprint: "C".repeat(40) },
      { password: "private-fixture" },
    ]) {
      const data = inputs()
      data.windowsSigning = { provider: "unsigned-preview", ...extra } as never
      expect(() => validatePublicBuildInputs(data, publicReviewDigest(data))).toThrow()
    }
  })
  test("retains candidate profile while public preview and stable share a separate upgrade identity", () => {
    expect(compiledDesktopIdentity({}).appId).toBe("systems.physical.desktop.development")
    expect(
      compiledDesktopIdentity({ PHYSICALSYSTEMS_APP_ID: "systems.physical.desktop", OPENCODE_CHANNEL: "latest" }).kind,
    ).toBe("candidate")
    expect(desktopIdentity("candidate").runtimeName).toBe("Physical Systems Development")
    expect(desktopIdentity("public").profileDirectory).not.toBe(desktopIdentity("candidate").profileDirectory)
    const data = inputs()
    expect(validatePublicBuildInputs(data, publicReviewDigest(data)).identity).toEqual(desktopIdentity("public"))
    data.version = "0.1.0"
    data.channel = "stable"
    expect(validatePublicBuildInputs(data, publicReviewDigest(data)).identity).toEqual(desktopIdentity("public"))
  })
  test("requires both independently trusted public and release input digests", async () => {
    const data = await fixture()
    expect(loadPublicBuildInputs(data.env)).toEqual(data.data)
    expect(() => loadPublicBuildInputs({ ...data.env, PHYSICALSYSTEMS_EXPECTED_PUBLIC_BUILD_SHA256: "" })).toThrow(
      "trusted digest",
    )
    expect(() =>
      loadPublicBuildInputs({ ...data.env, PHYSICALSYSTEMS_EXPECTED_INPUTS_SHA256: "c".repeat(64) }),
    ).toThrow("trusted release")
    expect(() => compiledDesktopIdentity({ PHYSICALSYSTEMS_EXPECTED_PUBLIC_BUILD_SHA256: "a".repeat(64) })).toThrow(
      "absolute",
    )
  })
  test("rejects candidate identities, arbitrary profiles, secret fields and unsigned modes", () => {
    for (const mutate of [
      (data: PublicBuildInputs) => {
        data.identity = desktopIdentity("candidate")
      },
      (data: PublicBuildInputs) => {
        data.identity = { ...data.identity, profileDirectory: "existing-installation" } as never
      },
      (data: PublicBuildInputs) => {
        data.publication = true as never
      },
      (data: PublicBuildInputs) => {
        data.windowsSigning = { provider: "unsigned" } as never
      },
      (data: PublicBuildInputs) => {
        data.windowsSigning = { ...data.windowsSigning, password: "fixture-secret" } as never
      },
    ]) {
      const data = inputs()
      mutate(data)
      expect(() => validatePublicBuildInputs(data, publicReviewDigest(data))).toThrow()
    }
  })
  test("candidate outputs and changed main bytes cannot be relabeled by a public packaging config", async () => {
    const data = await fixture()
    const bytes = Buffer.from("synthetic compiled main fixture")
    const record = compiledIdentityRecord(data.env, bytes)
    expect(() =>
      verifyCompiledPublicIdentity(record, data.env.PHYSICALSYSTEMS_EXPECTED_PUBLIC_BUILD_SHA256, bytes),
    ).not.toThrow()
    expect(() =>
      verifyCompiledPublicIdentity(
        compiledIdentityRecord({}, bytes),
        data.env.PHYSICALSYSTEMS_EXPECTED_PUBLIC_BUILD_SHA256,
        bytes,
      ),
    ).toThrow("cannot be relabeled")
    expect(() =>
      verifyCompiledPublicIdentity(
        record,
        data.env.PHYSICALSYSTEMS_EXPECTED_PUBLIC_BUILD_SHA256,
        Buffer.from("changed main"),
      ),
    ).toThrow("cannot be relabeled")
    expect(() => verifyCompiledPublicIdentity(record, "f".repeat(64), bytes)).toThrow("cannot be relabeled")
  })
  test("Windows PFX signing has no unsigned fallback and does not serialize passwords", async () => {
    const data = await fixture()
    expect(() => publicSigningConfiguration(data.data, {}, "win32")).toThrow("PFX file and password")
    const pfx = path.join(data.root, "fixture.pfx")
    await writeFile(pfx, "Not a real certificate; signing is not performed in this test")
    const config = publicSigningConfiguration(
      data.data,
      { PHYSICALSYSTEMS_PFX_FILE: pfx, WIN_CSC_KEY_PASSWORD: "fixture-secret" },
      "win32",
    )
    expect(JSON.stringify(config)).not.toContain("fixture-secret")
    expect(config.signtoolOptions?.publisherName).toBe("Synthetic Fixture Publisher")
    expect(config.signtoolOptions?.signingHashAlgorithms).toEqual(["sha256"])
    expect(publicSigningConfiguration(data.data, {}, "linux")).toEqual({})
    expect(() => publicSigningConfiguration(data.data, {}, "darwin")).toThrow("not qualified")
  })
  test("Azure signing requires an owned pinned endpoint and service identity without embedding secrets", () => {
    const data = inputs()
    data.windowsSigning = {
      provider: "azure-trusted-signing",
      publisher: "Synthetic Fixture Publisher",
      endpoint: "https://weu.codesigning.azure.net",
      account: "fixture-account",
      certificateProfile: "fixture-profile",
    }
    expect(() => validatePublicBuildInputs(data, publicReviewDigest(data))).not.toThrow()
    expect(() => publicSigningConfiguration(data, {}, "win32")).toThrow("service identity")
    const config = publicSigningConfiguration(
      data,
      { AZURE_TENANT_ID: "fixture-tenant", AZURE_CLIENT_ID: "fixture-client", AZURE_CLIENT_SECRET: "fixture-secret" },
      "win32",
    )
    expect(config.azureSignOptions?.codeSigningAccountName).toBe("fixture-account")
    expect(JSON.stringify(config)).not.toContain("fixture-secret")
    data.windowsSigning.endpoint = "https://example.invalid/credential-exfiltration"
    expect(() => validatePublicBuildInputs(data, publicReviewDigest(data))).toThrow("owned Azure")
  })
  test("the actual public packaging configuration requires the compiled identity and keeps publication disabled", async () => {
    if (process.platform !== "linux") return
    const data = await fixture()
    const main = Buffer.from("synthetic compiled main fixture")
    await mkdir(path.join(data.root, "out/main"), { recursive: true })
    await mkdir(path.join(data.root, "out/legal"), { recursive: true })
    await writeFile(path.join(data.root, "out/main/index.js"), main)
    await writeFile(
      path.join(data.root, "out/legal/physical-build-identity.json"),
      JSON.stringify(compiledIdentityRecord(data.env, main)),
    )
    const config = new URL("../../../desktop/physical-public.config.ts", import.meta.url).pathname
    const code = `
      import { createRequire } from "node:module";
      const config = (await import(${JSON.stringify(config)})).default;
      const require = createRequire(${JSON.stringify(config)});
      const builder = createRequire(require.resolve("electron-builder"));
      await builder("app-builder-lib/out/util/config/config").validateConfiguration(config, { isEnabled: false });
      console.log(JSON.stringify(config));
    `
    const result = JSON.parse(
      execFileSync(process.execPath, ["-e", code], {
        cwd: data.root,
        env: { ...process.env, ...data.env },
        encoding: "utf8",
      }),
    )
    expect(result.appId).toBe("systems.physical.desktop")
    expect(result.productName).toBe("Physical Systems")
    expect(result.publish).toBe(null)
    expect(result.forceCodeSigning).toBe(true)
    expect(result.win.signExecutable).toBe(true)
    expect(result.win.verifyUpdateCodeSignature).toBe(true)
    expect(result.linux.extraFiles).toEqual([{ from: "resources/AppRun.public", to: "AppRun" }])
    expect(result.deb.packageName).toBe("physical-systems-desktop")
    data.data.windowsSigning = { provider: "unsigned-preview" }
    data.env.PHYSICALSYSTEMS_EXPECTED_PUBLIC_BUILD_SHA256 = publicReviewDigest(data.data)
    await writeFile(data.env.PHYSICALSYSTEMS_PUBLIC_BUILD_INPUTS, JSON.stringify(data.data))
    await writeFile(
      path.join(data.root, "out/legal/physical-build-identity.json"),
      JSON.stringify(compiledIdentityRecord(data.env, main)),
    )
    const preview = JSON.parse(
      execFileSync(process.execPath, ["-e", code], {
        cwd: data.root,
        env: { ...process.env, ...data.env },
        encoding: "utf8",
      }),
    )
    expect(preview.appId).toBe(result.appId)
    expect(preview.productName).toBe(result.productName)
    expect(preview.publish).toBe(null)
    expect(preview.forceCodeSigning).toBe(false)
    expect(preview.win.signExecutable).toBe(false)
    expect(preview.win.verifyUpdateCodeSignature).toBe(true)
    expect(preview.win.signtoolOptions).toBeUndefined()
    expect(preview.win.azureSignOptions).toBeUndefined()
    expect(preview.linux).toEqual(result.linux)
  })
})
