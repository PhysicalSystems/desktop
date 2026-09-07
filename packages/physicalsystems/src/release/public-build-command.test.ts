// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { gzipSync } from "node:zlib"
import { buildPublicDesktop, publicBuildArguments, publicBuildEnvironments } from "./public-build-command"
import { prepareReleaseInputs } from "./inputs"
import type { ReleaseInputs } from "./inputs"
import { compiledIdentityRecord, loadPublicBuildInputs } from "./public-build"
import type { PublicBuildInputs } from "./public-build"
import { desktopIdentity } from "./identity"
import { publicReviewDigest } from "./public-downloads"
import { candidateNames } from "./artifacts"

const directories: string[] = []
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n"
const history = { complete: true as const, versions: [] as string[] }
const realPolicy = JSON.parse(await readFile(new URL("../../../../release/desktop.json", import.meta.url), "utf8"))
afterEach(async () => {
  await Promise.all(directories.splice(0).map((folder) => rm(folder, { recursive: true, force: true })))
})

function publicInput(): PublicBuildInputs {
  return {
    schemaVersion: 1,
    kind: "public-desktop-build",
    publication: false,
    sourceRevision: "a".repeat(40),
    releaseInputsSha256: "b".repeat(64),
    version: "0.1.0-beta.1",
    channel: "preview",
    identity: desktopIdentity("public"),
    windowsSigning: { provider: "pfx", publisher: "Fixture Publisher", certificateThumbprint: "A".repeat(40) },
  }
}

function args(folder: string) {
  return [
    "--inputs",
    join(folder, "release-inputs.json"),
    "--public-inputs",
    join(folder, "public-build-inputs.json"),
    "--expected-inputs-sha256",
    "b".repeat(64),
    "--expected-public-build-sha256",
    "c".repeat(64),
    "--platform",
    process.platform === "win32" ? "windows-x64" : "linux-x64",
    "--output",
    join(folder, "output"),
  ]
}

test("public driver requires explicit anchored inputs and has no publication, source or signing override", () => {
  const valid = args(resolve("fixture"))
  expect(publicBuildArguments(valid).platform).toBe(process.platform === "win32" ? "windows-x64" : "linux-x64")
  for (const invalid of [
    [],
    valid.slice(2),
    [...valid, "--publish", "always"],
    [...valid, "--platform", "linux-x64"],
    [...valid, "--source", "main"],
    [...valid, "--unsigned", "true"],
    [...valid, "--password", "fixture"],
  ])
    expect(() => publicBuildArguments(invalid)).toThrow()
  const wrongDigest = [...valid]
  wrongDigest[5] = "latest"
  expect(() => publicBuildArguments(wrongDigest)).toThrow("trusted input digests")
})

test("PFX credentials reach only packaging; alternate signers and mixed-case secrets are stripped", async () => {
  const folder = await mkdtemp(join(tmpdir(), "public-build-env-"))
  directories.push(folder)
  const certificate = join(folder, "signing.pfx")
  await writeFile(certificate, "synthetic PFX fixture")
  const env = {
    PATH: "/toolchain",
    PHYSICALSYSTEMS_PFX_FILE: certificate,
    WIN_CSC_KEY_PASSWORD: "fixture-pfx-password",
    AZURE_CLIENT_SECRET: "wrong-provider",
    Azure_Client_Secret: "mixed-case-secret",
    CSC_LINK: "unapproved-certificate",
    Custom_Password: "mixed-case-password",
    OPENAI_API_KEY: "fixture-model-key",
    GH_TOKEN: "fixture-token",
    NODE_PATH: "/ambient/module-hooks",
    Node_Options: "--require /ambient/hook.js",
    BUN_OPTIONS: "--preload /ambient/hook.js",
    ELECTRON_RUN_AS_NODE: "1",
    ELECTRON_DISABLE_SANDBOX: "1",
  }
  const value = publicInput()
  const input = {
    env,
    release: { version: value.version, sha256: value.releaseInputsSha256 } as ReleaseInputs,
    build: value,
    releaseFile: "/snapshot/release.json",
    publicFile: "/snapshot/public.json",
    modelsFile: "/snapshot/models.json",
    publicDigest: publicReviewDigest(value),
    platform: "windows-x64" as const,
  }
  const result = publicBuildEnvironments(input)
  for (const key of Object.keys(env).filter((key) => key !== "PATH")) expect(result.build[key]).toBeUndefined()
  expect(result.packaging.PHYSICALSYSTEMS_PFX_FILE).toBe(certificate)
  expect(result.packaging.WIN_CSC_KEY_PASSWORD).toBe(env.WIN_CSC_KEY_PASSWORD)
  for (const key of [
    "AZURE_CLIENT_SECRET",
    "Azure_Client_Secret",
    "CSC_LINK",
    "Custom_Password",
    "OPENAI_API_KEY",
    "GH_TOKEN",
  ])
    expect(result.packaging[key]).toBeUndefined()
  expect(result.build.PHYSICALSYSTEMS_ALLOW_DEVICES).toBe("0")
  expect(result.build.PHYSICALSYSTEMS_EXPECTED_PUBLIC_BUILD_SHA256).toBe(input.publicDigest)
  expect(() => publicBuildEnvironments({ ...input, env: { PATH: env.PATH } })).toThrow("provisioned PFX")
})

test("Azure credentials are packaging-only and Linux receives no Windows signing credentials", () => {
  const value = publicInput()
  value.windowsSigning = {
    provider: "azure-trusted-signing",
    publisher: "Fixture Publisher",
    endpoint: "https://eus.codesigning.azure.net",
    account: "fixture-account",
    certificateProfile: "fixture-profile",
  }
  const input = {
    env: {
      PATH: "/toolchain",
      AZURE_TENANT_ID: "fixture-tenant",
      AZURE_CLIENT_ID: "fixture-client",
      AZURE_CLIENT_SECRET: "fixture-secret",
      WIN_CSC_KEY_PASSWORD: "wrong-provider",
    },
    release: { version: value.version, sha256: value.releaseInputsSha256 } as ReleaseInputs,
    build: value,
    releaseFile: "/snapshot/release.json",
    publicFile: "/snapshot/public.json",
    modelsFile: "/snapshot/models.json",
    publicDigest: publicReviewDigest(value),
    platform: "windows-x64" as const,
  }
  const result = publicBuildEnvironments(input)
  expect(result.build.AZURE_CLIENT_SECRET).toBeUndefined()
  expect(result.packaging.AZURE_CLIENT_SECRET).toBe("fixture-secret")
  expect(result.packaging.WIN_CSC_KEY_PASSWORD).toBeUndefined()
  const linux = publicBuildEnvironments({ ...input, platform: "linux-x64" })
  expect(linux.packaging.AZURE_CLIENT_SECRET).toBeUndefined()
  expect(linux.packaging.AZURE_CLIENT_ID).toBeUndefined()
  expect(() => publicBuildEnvironments({ ...input, env: {} })).toThrow("provisioned service identity")
})

function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}
function commit(root: string) {
  git(root, "add", ".")
  git(
    root,
    "-c",
    "user.name=Public build fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "test: immutable public build",
  )
}
async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), "public-build-command-"))
  directories.push(folder)
  const root = join(folder, "repo")
  await mkdir(root)
  git(root, "init", "--quiet")
  await writeFile(join(root, "LICENSE"), "Fixture license\n")
  commit(root)
  const policy = structuredClone(realPolicy)
  policy.upstream.revision = git(root, "rev-parse", "HEAD")
  const artifacts = {
    "operator-service.mjs": "export const fixture = true\n",
    LICENSE: "fixture license",
    NOTICE: "fixture notice",
    "skills/inspect-workcell/SKILL.md": "# Inspect",
    "skills/inspect-workcell/physicalsystems.binding.json": "{}",
    "skills/transfer-container/SKILL.md": "# Transfer",
    "skills/transfer-container/physicalsystems.binding.json": "{}",
  }
  const models = json({ fixture: { models: { synthetic: { name: "Synthetic fixture" } } } })
  const files: Record<string, string | Buffer> = {
    ".gitignore": "node_modules\n",
    "release/desktop.json": json(policy),
    "package.json": json({ packageManager: "bun@1.3.14" }),
    "packages/desktop/package.json": json({
      version: "0.0.0",
      devDependencies: { electron: "42.3.3", "electron-builder": "26.15.2" },
    }),
    "packages/desktop/physical-public.config.ts": "// committed public config fixture\n",
    "bun.lock": "fixture lock\n",
    "release/models.dev-api.json.gz": gzipSync(models),
    "release/models.dev.LICENSE": "fixture license",
    "release/models.dev.NOTICE": "fixture notice",
    "packages/physicalsystems/vendor/manifest.json": json({
      schemaVersion: 1,
      repository: "https://github.com/PhysicalSystems/physicalsystems",
      revision: "a".repeat(40),
      dirty: false,
      sourceFiles: { "packages/operator-service/src/index.js": hash("fixture") },
      artifacts: Object.fromEntries(Object.entries(artifacts).map(([name, body]) => [name, hash(body)])),
    }),
    ...Object.fromEntries(
      Object.entries(artifacts).map(([name, body]) => ["packages/physicalsystems/vendor/" + name, body]),
    ),
  }
  for (const [file, body] of Object.entries(files)) {
    await mkdir(dirname(join(root, file)), { recursive: true })
    await writeFile(join(root, file), body)
  }
  commit(root)
  const inputs = await prepareReleaseInputs({
    repoRoot: root,
    repository: "PhysicalSystems/desktop",
    channel: "preview",
    history,
  })
  const build = { ...publicInput(), sourceRevision: inputs.source.revision, releaseInputsSha256: inputs.sha256 }
  await writeFile(join(folder, "release-inputs.json"), json(inputs))
  await writeFile(join(folder, "public-build-inputs.json"), json(build))
  await writeFile(join(folder, "history.json"), json(history))
  await writeFile(join(folder, "models.dev-api.json"), models)
  const electron = join(root, "packages/desktop/node_modules/electron")
  await mkdir(join(electron, "dist"), { recursive: true })
  await writeFile(join(electron, "dist/version"), inputs.toolchain.electron)
  await writeFile(join(electron, "path.txt"), "electron")
  const flags = args(folder)
  flags[5] = inputs.sha256
  flags[7] = publicReviewDigest(build)
  const certificate = join(folder, "certificate.pfx")
  await writeFile(certificate, "synthetic PFX fixture")
  return {
    folder,
    root,
    inputs,
    build,
    flags,
    env: { PATH: process.env.PATH, PHYSICALSYSTEMS_PFX_FILE: certificate, WIN_CSC_KEY_PASSWORD: "fixture-password" },
  }
}

test("actual immutable source staging builds only exact public outputs and emits no native qualification claims", async () => {
  const data = await fixture()
  const phases: string[] = []
  let stage = ""
  const record = await buildPublicDesktop(data.flags, {
    root: data.root,
    env: data.env,
    run: async (_executable, command, cwd, env) => {
      if (command[0] === "install") {
        stage = cwd
        phases.push("install")
        expect(command).toEqual(["install", "--frozen-lockfile", "--ignore-scripts"])
        await writeFile(join(data.root, "packages/desktop/physical-public.config.ts"), "concurrent working-copy edit")
        await writeFile(join(data.folder, "public-build-inputs.json"), "caller changed after preflight")
        await writeFile(join(data.folder, "release-inputs.json"), "caller changed release inputs")
        await writeFile(join(data.folder, "models.dev-api.json"), "caller changed model catalog")
        expect(await readFile(join(cwd, "packages/desktop/physical-public.config.ts"), "utf8")).toBe(
          "// committed public config fixture\n",
        )
      } else if (command[0].includes("build-node")) phases.push("agent")
      else if (command[0].includes("electron-vite")) {
        phases.push("bundle")
        expect(loadPublicBuildInputs(env!)).toEqual(data.build)
        expect(JSON.parse(await readFile(env!.PHYSICALSYSTEMS_RELEASE_INPUTS!, "utf8"))).toEqual(data.inputs)
        expect(hash(await readFile(env!.MODELS_DEV_API_JSON!))).toBe(data.inputs.modelCatalog.decodedSha256)
        await mkdir(join(cwd, "out/main"), { recursive: true })
        await mkdir(join(cwd, "out/legal"), { recursive: true })
        const main = Buffer.from("public identity fixture main")
        await writeFile(join(cwd, "out/main/index.js"), main)
        await writeFile(join(cwd, "out/legal/physical-build-identity.json"), json(compiledIdentityRecord(env!, main)))
      } else {
        phases.push("package")
        expect(command).toContain("physical-public.config.ts")
        expect(command.slice(command.indexOf("--publish"), command.indexOf("--publish") + 2)).toEqual([
          "--publish",
          "never",
        ])
        expect(JSON.parse(await readFile(join(cwd, "out/legal/public-build-inputs.json"), "utf8"))).toEqual(data.build)
        expect(JSON.parse(await readFile(join(cwd, "out/legal/desktop-release-inputs.json"), "utf8"))).toEqual(
          data.inputs,
        )
        await mkdir(join(cwd, "public-dist"))
        for (const entry of candidateNames(
          data.inputs.version,
          process.platform === "win32" ? "windows-x64" : "linux-x64",
        ))
          await writeFile(join(cwd, "public-dist", entry.name), "synthetic installer fixture " + entry.format)
      }
      if (phases.at(-1) !== "package") expect(env?.WIN_CSC_KEY_PASSWORD).toBeUndefined()
    },
  })
  expect(phases).toEqual(["install", "agent", "bundle", "package"])
  expect(record.kind).toBe("unqualified-public-desktop-build")
  expect(record.signing.status).toBe("NOT_VERIFIED")
  expect(record.qualification).toBe("NOT_TESTED")
  expect(record.publication).toBe(false)
  expect(json(record)).not.toContain(data.env.WIN_CSC_KEY_PASSWORD)
  expect(json(record)).not.toContain('"PASS"')
  expect(record.inventorySha256).toBe(hash(await readFile(join(data.folder, "output/artifacts.json"))))
  await expect(readdir(stage)).rejects.toThrow()
  expect(await readFile(join(data.root, "packages/desktop/physical-public.config.ts"), "utf8")).toBe(
    "concurrent working-copy edit",
  )
})

test("binding mismatches and symlink inputs fail before any build or output mutation", async () => {
  for (const field of ["sourceRevision", "version", "channel"] as const) {
    const data = await fixture()
    if (field === "sourceRevision") data.build.sourceRevision = "d".repeat(40)
    if (field === "version") data.build.version = "0.1.0-beta.2"
    if (field === "channel") {
      data.build.channel = "stable"
      data.build.version = "0.1.0"
    }
    await writeFile(join(data.folder, "public-build-inputs.json"), json(data.build))
    data.flags[7] = publicReviewDigest(data.build)
    await expect(
      buildPublicDesktop(data.flags, {
        root: data.root,
        env: data.env,
        run: async () => {
          throw new Error("build must not run")
        },
      }),
    ).rejects.toThrow("differs")
    await expect(readdir(join(data.folder, "output"))).rejects.toThrow()
  }
  const data = await fixture()
  const alias = join(data.folder, "alias.json")
  await symlink(join(data.folder, "public-build-inputs.json"), alias)
  data.flags[3] = alias
  await expect(buildPublicDesktop(data.flags, { root: data.root, env: data.env })).rejects.toThrow(
    "bounded regular file",
  )
})

test("candidate-compiled main cannot be repackaged with public identity and failed staging is cleaned", async () => {
  const data = await fixture()
  let stage = ""
  let packaged = false
  await expect(
    buildPublicDesktop(data.flags, {
      root: data.root,
      env: data.env,
      run: async (_exe, command, cwd) => {
        if (command[0] === "install") stage = cwd
        if (command[0].includes("electron-vite")) {
          await mkdir(join(cwd, "out/main"), { recursive: true })
          await mkdir(join(cwd, "out/legal"), { recursive: true })
          const main = Buffer.from("candidate main")
          await writeFile(join(cwd, "out/main/index.js"), main)
          await writeFile(join(cwd, "out/legal/physical-build-identity.json"), json(compiledIdentityRecord({}, main)))
        }
        if (command[0].includes("electron-builder")) packaged = true
      },
    }),
  ).rejects.toThrow("candidate outputs cannot be relabeled")
  expect(packaged).toBe(false)
  await expect(readdir(stage)).rejects.toThrow()
  expect(await readdir(join(data.folder, "output"))).toEqual([])
})
