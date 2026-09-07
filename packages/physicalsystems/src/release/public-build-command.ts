// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto"
import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { buildEnvironment, emptyOutput, run, stageCandidateSource } from "./commands"
import { checksums, createInventory } from "./artifacts"
import type { CandidatePlatform } from "./artifacts"
import { verifyReleaseInputs } from "./inputs"
import type { ReleaseHistory, ReleaseInputs } from "./inputs"
import { publicSigningConfiguration, validatePublicBuildInputs, verifyCompiledPublicIdentity } from "./public-build"
import type { PublicBuildInputs } from "./public-build"

const sourceRoot = resolve(import.meta.dir, "../../../..")
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n"

export class PublicBuildProvisioningError extends Error {}

function signingPreflight(build: PublicBuildInputs, env: NodeJS.ProcessEnv, platform: string) {
  try {
    publicSigningConfiguration(build, env, platform)
  } catch {
    throw new PublicBuildProvisioningError(
      build.windowsSigning.provider === "pfx"
        ? "Windows public signing requires a provisioned PFX file and password matching the pinned signing policy"
        : "Azure public signing requires the provisioned service identity matching the pinned signing policy",
    )
  }
}

export function publicBuildArguments(args: string[]) {
  const allowed = [
    "inputs",
    "public-inputs",
    "expected-inputs-sha256",
    "expected-public-build-sha256",
    "platform",
    "output",
  ]
  const options: Record<string, string> = {}
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.slice(2)
    if (
      !args[i]?.startsWith("--") ||
      !allowed.includes(key) ||
      key in options ||
      !args[i + 1] ||
      args[i + 1].startsWith("--")
    )
      throw new Error("Invalid or duplicate public desktop build argument")
    options[key] = args[i + 1]
  }
  for (const key of allowed) if (!options[key]) throw new Error(`Missing --${key}`)
  for (const key of ["expected-inputs-sha256", "expected-public-build-sha256"])
    if (!/^[a-f0-9]{64}$/.test(options[key])) throw new Error("Public builds require explicit trusted input digests")
  if (!["windows-x64", "linux-x64"].includes(options.platform))
    throw new Error("Unsupported public desktop build target")
  return options
}

/** Only the final packaging subprocess receives the selected provider credentials. */
export function publicBuildEnvironments(input: {
  env: NodeJS.ProcessEnv
  release: ReleaseInputs
  build: PublicBuildInputs
  releaseFile: string
  publicFile: string
  publicDigest: string
  modelsFile: string
  platform: CandidatePlatform
}) {
  signingPreflight(input.build, input.env, input.platform === "windows-x64" ? "win32" : "linux")
  // Windows environment keys are case insensitive; mixed-case credentials must
  // not survive the generic candidate scrubber when handed to a subprocess.
  const source = Object.fromEntries(
    Object.entries(input.env).filter(
      ([key]) =>
        !(
          /^(OPENCODE_|PHYSICALSYSTEMS_|SENTRY_|VITE_SENTRY_|AWS_|AZURE_|GOOGLE_|GCP_|OPENAI_|ANTHROPIC_|GITHUB_|GH_|CSC_|WIN_CSC_|WIN_SIGNING_|APPLE_)/i.test(
            key,
          ) ||
          /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY)/i.test(key) ||
          /^(NODE_OPTIONS|NODE_PATH|BUN_OPTIONS|BUN_PRELOAD|ELECTRON_RUN_AS_NODE|ELECTRON_DISABLE_SANDBOX)$/i.test(key)
        ),
    ),
  )
  const build: NodeJS.ProcessEnv = {
    ...buildEnvironment(source, input.release, input.releaseFile, input.modelsFile),
    PHYSICALSYSTEMS_EXPECTED_INPUTS_SHA256: input.release.sha256,
    PHYSICALSYSTEMS_PUBLIC_BUILD_INPUTS: input.publicFile,
    PHYSICALSYSTEMS_EXPECTED_PUBLIC_BUILD_SHA256: input.publicDigest,
  }
  const packaging: NodeJS.ProcessEnv = { ...build }
  if (input.platform === "windows-x64") {
    const keys =
      input.build.windowsSigning.provider === "pfx"
        ? ["PHYSICALSYSTEMS_PFX_FILE", "WIN_CSC_KEY_PASSWORD"]
        : ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"]
    for (const key of keys) packaging[key] = input.env[key]
  }
  return { build, packaging }
}

async function regularInput(file: string, maximum: number) {
  if (!isAbsolute(file)) throw new Error("Public build inputs require absolute paths")
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maximum)
    throw new Error("Public build input must be a bounded regular file")
  return readFile(file)
}

/** Builds installers under the public identity, but grants no qualification or
 * publication authority. The runner/root injection is for isolated build tests;
 * the executable CLI always uses the real source root and command runner. */
export async function buildPublicDesktop(
  args: string[],
  options: { root?: string; env?: NodeJS.ProcessEnv; run?: typeof run } = {},
) {
  const flags = publicBuildArguments(args)
  const root = options.root ?? sourceRoot
  const ambient = options.env ?? process.env
  const execute = options.run ?? run
  const publicBytes = await regularInput(flags["public-inputs"], 128 * 1024)
  const build = validatePublicBuildInputs(
    JSON.parse(publicBytes.toString("utf8")),
    flags["expected-public-build-sha256"],
  )
  if (build.releaseInputsSha256 !== flags["expected-inputs-sha256"])
    throw new Error("Public build is not bound to the independently trusted release inputs")
  const file = flags.inputs
  const inputBytes = await regularInput(file, 1024 * 1024)
  const historyBytes = await regularInput(join(dirname(file), "history.json"), 1024 * 1024)
  const inputs = await verifyReleaseInputs({
    repoRoot: root,
    inputs: JSON.parse(inputBytes.toString("utf8")),
    history: JSON.parse(historyBytes.toString("utf8")) as ReleaseHistory,
    expectedRepository: "PhysicalSystems/desktop",
    expectedSha256: flags["expected-inputs-sha256"],
  })
  if (
    build.sourceRevision !== inputs.source.revision ||
    build.version !== inputs.version ||
    build.channel !== inputs.channel
  )
    throw new Error("Public build source, version or channel differs from the verified release inputs")
  const platform = flags.platform as CandidatePlatform
  const host = process.platform === "win32" ? "windows-x64" : process.platform === "linux" ? "linux-x64" : "unsupported"
  if (platform !== host || process.arch !== "x64")
    throw new Error("Build public installers on their exact supported OS/architecture")
  if (process.versions.bun !== inputs.toolchain.bun)
    throw new Error("Public build Bun version does not match release inputs")
  // Provisioning is checked before creating output or running any build command.
  signingPreflight(build, ambient, process.platform)
  const models = await regularInput(join(dirname(file), "models.dev-api.json"), 32 * 1024 * 1024)
  if (sha(models) !== inputs.modelCatalog.decodedSha256) throw new Error("Prepared model catalog was modified")
  const electron = join(root, "packages/desktop/node_modules/electron/dist")
  if ((await readFile(join(electron, "version"), "utf8")).trim() !== inputs.toolchain.electron)
    throw new Error("Prepared Electron distribution has the wrong version")
  const output = await emptyOutput(flags.output, root)
  const transaction = await mkdtemp(join(dirname(output), "desktop-public-build-"))
  try {
    const snapshots = join(transaction, "inputs")
    await mkdir(snapshots, { mode: 0o700 })
    await writeFile(join(snapshots, "release-inputs.json"), inputBytes)
    await writeFile(join(snapshots, "public-build-inputs.json"), publicBytes)
    await writeFile(join(snapshots, "history.json"), historyBytes)
    await writeFile(join(snapshots, "models.dev-api.json"), models)
    const env = publicBuildEnvironments({
      env: ambient,
      release: inputs,
      build,
      releaseFile: join(snapshots, "release-inputs.json"),
      publicFile: join(snapshots, "public-build-inputs.json"),
      modelsFile: join(snapshots, "models.dev-api.json"),
      publicDigest: flags["expected-public-build-sha256"],
      platform,
    })
    const stage = await stageCandidateSource(root, inputs.source.revision, transaction, env.build)
    await execute(process.execPath, ["install", "--frozen-lockfile", "--ignore-scripts"], stage, env.build)
    await cp(electron, join(stage, "packages/desktop/node_modules/electron/dist"), { recursive: true })
    await cp(
      join(root, "packages/desktop/node_modules/electron/path.txt"),
      join(stage, "packages/desktop/node_modules/electron/path.txt"),
    )
    const desktop = join(stage, "packages/desktop")
    const manifestFile = join(desktop, "package.json")
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"))
    await writeFile(manifestFile, json({ ...manifest, version: inputs.version }))
    await execute(process.execPath, ["packages/opencode/script/build-node.ts"], stage, env.build)
    await execute(process.execPath, ["./node_modules/electron-vite/bin/electron-vite.js", "build"], desktop, env.build)
    const identity = JSON.parse(await readFile(join(desktop, "out/legal/physical-build-identity.json"), "utf8"))
    verifyCompiledPublicIdentity(
      identity,
      flags["expected-public-build-sha256"],
      await readFile(join(desktop, "out/main/index.js")),
    )
    await writeFile(join(desktop, "out/legal/desktop-release-inputs.json"), inputBytes)
    await writeFile(join(desktop, "out/legal/public-build-inputs.json"), publicBytes)
    for (const name of ["models.dev.LICENSE", "models.dev.NOTICE"])
      await cp(join(stage, "release", name), join(desktop, "out/legal", name))
    await execute(
      process.execPath,
      [
        "./node_modules/electron-builder/cli.js",
        "--config",
        "physical-public.config.ts",
        "--publish",
        "never",
        "--x64",
        platform === "windows-x64" ? "--win" : "--linux",
      ],
      desktop,
      env.packaging,
    )
    const inventory = await createInventory(join(desktop, "public-dist"), inputs, platform)
    for (const entry of inventory.files) await cp(join(desktop, "public-dist", entry.name), join(output, entry.name))
    const copied = await createInventory(output, inputs, platform)
    if (json(copied) !== json(inventory)) throw new Error("Public installer bytes changed while copying output")
    const record = {
      schemaVersion: 1,
      kind: "unqualified-public-desktop-build",
      publicBuildInputsSha256: flags["expected-public-build-sha256"],
      releaseInputsSha256: inputs.sha256,
      sourceRevision: inputs.source.revision,
      version: inputs.version,
      channel: inputs.channel,
      platform,
      identity: build.identity,
      compiledIdentity: identity,
      inventorySha256: sha(json(inventory)),
      signing: { status: "NOT_VERIFIED", policy: build.windowsSigning },
      qualification: "NOT_TESTED",
      publication: false,
    }
    await writeFile(join(output, "artifacts.json"), json(inventory))
    await writeFile(join(output, "SHA256SUMS"), checksums(inventory.files))
    await writeFile(join(output, "public-build-inputs.json"), publicBytes)
    await writeFile(join(output, "desktop-release-inputs.json"), inputBytes)
    await writeFile(join(output, "public-build-record.json"), json(record))
    return record
  } finally {
    await rm(transaction, { recursive: true, force: true })
  }
}
