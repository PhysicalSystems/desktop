// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { desktopIdentity } from "../physicalsystems/src/release/identity"
import { compiledIdentityRecord, type PublicBuildInputs } from "../physicalsystems/src/release/public-build"
import { publicReviewDigest } from "../physicalsystems/src/release/public-downloads"

const roots: string[] = []
const temporaryRoot = resolve(tmpdir())

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    if (dirname(root) !== temporaryRoot || !basename(root).startsWith("physical-launch-config-"))
      throw new Error("Unexpected packaging fixture directory")
    await rm(root, { recursive: true, force: true })
  }))
})

async function fixture() {
  const root = await mkdtemp(join(temporaryRoot, "physical-launch-config-"))
  roots.push(root)
  return root
}

function configuration(file: string, root: string, env: NodeJS.ProcessEnv = {}) {
  // Import the real config in a separate Bun process. No ambient build inputs,
  // signing credentials, module-cache mutation, or application startup is needed.
  const source = `const config = (await import(${JSON.stringify(new URL(file, import.meta.url).href)})).default;
console.log(JSON.stringify(config));`
  return JSON.parse(execFileSync(process.execPath, ["--eval", source], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 15_000,
  })) as {
    appId: string
    productName: string
    protocols?: unknown
    publish?: unknown
    win?: { protocols?: unknown }
    mac?: { protocols?: unknown }
    linux?: { protocols?: unknown }
  }
}

test.skipIf(process.platform !== "win32" && process.platform !== "linux")(
  "the public installer registers only the Physical Systems launch scheme",
  async () => {
    const root = await fixture()
    const inputs: PublicBuildInputs = {
      schemaVersion: 1,
      kind: "public-desktop-build",
      sourceRevision: "a".repeat(40),
      releaseInputsSha256: "b".repeat(64),
      version: "0.1.0-beta.1",
      channel: "preview",
      identity: desktopIdentity("public"),
      publication: false,
      windowsSigning: { provider: "unsigned-preview" },
    }
    const env = {
      PHYSICALSYSTEMS_PUBLIC_BUILD_INPUTS: join(root, "public-build-inputs.json"),
      PHYSICALSYSTEMS_EXPECTED_PUBLIC_BUILD_SHA256: publicReviewDigest(inputs),
      PHYSICALSYSTEMS_EXPECTED_INPUTS_SHA256: inputs.releaseInputsSha256,
    }
    await writeFile(env.PHYSICALSYSTEMS_PUBLIC_BUILD_INPUTS, JSON.stringify(inputs))
    const main = Buffer.from("synthetic compiled main fixture")
    await mkdir(join(root, "out/main"), { recursive: true })
    await mkdir(join(root, "out/legal"), { recursive: true })
    await writeFile(join(root, "out/main/index.js"), main)
    await writeFile(join(root, "out/legal/physical-build-identity.json"), JSON.stringify(compiledIdentityRecord(env, main)))

    const config = configuration("./physical-public.config.ts", root, env)
    expect(config.appId).toBe("systems.physical.desktop")
    expect(config.productName).toBe("Physical Systems")
    expect(config.protocols).toEqual({ name: "Physical Systems", schemes: ["physicalsystems"] })
    expect(config.win?.protocols).toBeUndefined()
    expect(config.mac?.protocols).toBeUndefined()
    expect(config.linux?.protocols).toBeUndefined()
    expect(config.publish).toBeNull()
  },
)

for (const file of ["physical-release.config.ts", "physical-review.config.ts"]) {
  test(`${file} cannot claim the installed public launch scheme`, async () => {
    const root = await fixture()
    const inputs = join(root, "candidate-inputs.json")
    await writeFile(inputs, JSON.stringify({ schemaVersion: 1, publication: false, version: "0.1.0-beta.1" }))

    const config = configuration(`./${file}`, root, { PHYSICALSYSTEMS_RELEASE_INPUTS: inputs })
    expect(config.appId).toBe("systems.physical.desktop.development")
    expect(config.protocols).toBeUndefined()
    expect(config.win?.protocols).toBeUndefined()
    expect(config.mac?.protocols).toBeUndefined()
    expect(config.linux?.protocols).toBeUndefined()
    expect(config.publish).toBeNull()
  })
}
