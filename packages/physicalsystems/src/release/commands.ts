// SPDX-License-Identifier: Apache-2.0
import { agentBuildChannel } from "./agent-channel"
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { gunzipSync } from "node:zlib"
import { prepareReleaseInputs, verifyReleaseInputs } from "./inputs"
import type { ReleaseHistory, ReleaseInputs } from "./inputs"
import {
  candidateDownloads,
  candidateNames,
  checksums,
  createInventory,
  verifyInventory,
  verifyQualification,
  verifyPlatformReport,
} from "./artifacts"
import type {
  CandidateArtifact,
  CandidateInventory,
  CandidatePlatform,
  Qualification,
  PlatformReport,
} from "./artifacts"

const sourceRoot = resolve(import.meta.dir, "../../../..")
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n"

export function releaseArguments(args: string[]) {
  const [command, ...rest] = args
  const allowed: Record<string, string[]> = {
    prepare: ["source-sha", "repository", "version", "channel", "history", "output"],
    "verify-inputs": ["inputs"],
    build: ["inputs", "platform", "output"],
    qualify: ["inputs", "artifacts", "output"],
    "verify-artifacts": ["inputs", "artifacts", "receipts", "output"],
    summarize: ["inputs", "reports", "output"],
    "verify-public": ["review", "expected-review-sha256", "output"],
  }
  if (!allowed[command])
    throw new Error("Use prepare, verify-inputs, build, qualify, verify-artifacts, summarize or verify-public")
  const options: Record<string, string> = {}
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.slice(2)
    if (
      !rest[i]?.startsWith("--") ||
      !allowed[command].includes(key) ||
      key in options ||
      !rest[i + 1] ||
      rest[i + 1].startsWith("--")
    )
      throw new Error("Invalid or duplicate desktop release argument")
    options[key] = rest[i + 1]
  }
  for (const key of allowed[command].filter((key) => key !== "version"))
    if (!options[key]) throw new Error(`Missing --${key}`)
  return { command, options }
}

/** Build outputs and disposable profiles must never overlap source or existing app data. */
export async function emptyOutput(path: string, root = sourceRoot) {
  if (!isAbsolute(path)) throw new Error("Candidate output must be an absolute path outside the source checkout")
  const parent = await realpath(dirname(path))
  const output = join(parent, basename(path))
  const repo = await realpath(root)
  if (output === repo || relative(repo, output).split(/[\\/]/)[0] !== "..")
    throw new Error("Candidate output must be outside the source checkout")
  const stat = await lstat(output).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
    return undefined
  })
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || (await readdir(output)).length))
    throw new Error("Candidate output must be a new or empty real directory")
  await mkdir(output, { recursive: true, mode: 0o700 })
  return output
}

export function buildEnvironment(input: NodeJS.ProcessEnv, inputs: ReleaseInputs, file: string, models: string) {
  const env = { ...input }
  for (const key of Object.keys(env))
    if (
      /^(OPENCODE_|PHYSICALSYSTEMS_|SENTRY_|VITE_SENTRY_|AWS_|AZURE_|GOOGLE_|GCP_|OPENAI_|ANTHROPIC_|GITHUB_|GH_|CSC_|WIN_CSC_|WIN_SIGNING_|APPLE_)/.test(
        key,
      ) ||
      /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY)/.test(key) ||
      key === "USE_HARD_LINKS" ||
      key === "VITEST"
    )
      delete env[key]
  return Object.assign(env, {
    OPENCODE_VERSION: inputs.version,
    OPENCODE_CHANNEL: agentBuildChannel,
    MODELS_DEV_API_JSON: models,
    PHYSICALSYSTEMS_RELEASE_INPUTS: file,
    PHYSICALSYSTEMS_ALLOW_DEVICES: "0",
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
    ELECTRON_SKIP_BINARY_DOWNLOAD: "1",
    NODE_OPTIONS: "--max-old-space-size=3072",
  })
}

export class DesktopCommandFailure extends Error {
  constructor(readonly outcome: "exit" | "timeout" | "signal" | "start") {
    super(`Desktop candidate command failed (${outcome})`)
  }
}

export async function run(executable: string, args: string[], cwd: string, env = process.env, timeoutMs = 600_000) {
  const child = spawn(executable, args, { cwd, env, stdio: "inherit", shell: false })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await new Promise<void>((accept, reject) => {
      timer = setTimeout(() => {
        child.kill()
        child.unref()
        // A signal request is not shutdown proof, even if a receipt was written
        // before the controller stalled. Never advance on this outcome.
        reject(new DesktopCommandFailure("timeout"))
      }, timeoutMs)
      child.once("exit", (code, signal) => {
        if (signal || code === null) reject(new DesktopCommandFailure("signal"))
        else if (code !== 0) reject(new DesktopCommandFailure("exit"))
        else accept()
      })
      child.once("error", () => reject(new DesktopCommandFailure("start")))
    })
  } finally {
    clearTimeout(timer)
  }
}

/** This permits collecting the next format's evidence, never release eligibility.
 * A failed test can continue only after all relevant teardown is confirmed. */
function candidateTeardownConfirmed(report: Qualification, inventory: CandidateInventory, artifact: CandidateArtifact) {
  if (
    !report ||
    report.schemaVersion !== 1 ||
    report.artifact?.name !== artifact.name ||
    report.artifact.sha256 !== artifact.sha256 ||
    report.artifact.bytes !== artifact.bytes ||
    report.inputsSha256 !== inventory.inputsSha256 ||
    report.sourceRevision !== inventory.sourceRevision ||
    report.version !== inventory.version ||
    report.platform !== inventory.platform ||
    report.simulationOnly !== true ||
    report.deviceConnectionsAllowed !== false ||
    report.publicDistribution?.status !== "BLOCKED" ||
    !["PASS", "FAIL", "NOT_TESTED", "BLOCKED"].includes(report.result) ||
    !Array.isArray(report.checks) ||
    report.checks.length > 256 ||
    report.checks.some(
      (check) =>
        !check || typeof check.id !== "string" || !["PASS", "FAIL", "NOT_TESTED", "BLOCKED"].includes(check.status),
    ) ||
    new Set(report.checks.map((check) => check.id)).size !== report.checks.length
  )
    return false
  const required = [
    "cleanup",
    artifact.format === "AppImage" ? "linux-sandbox-cleanup" : "uninstall",
    ...(artifact.format === "nsis" ? [] : ["native-secret-service-cleanup", "linux-temporary-cleanup"]),
  ]
  return (
    required.every((id) => report.checks.find((check) => check.id === id)?.status === "PASS") &&
    !report.checks.some(
      (check) =>
        (/cleanup|teardown|uninstall/.test(check.id) && check.status !== "PASS") ||
        (check.status === "FAIL" &&
          /CLEANUP_UNCONFIRMED|SHUTDOWN_UNCONFIRMED|PROCESS_RETAINED/.test(check.failureCode ?? "")),
    )
  )
}

/** Inventory/output ownership is verified by the CLI before entering this loop.
 * Receipts stay untouched on failure, including when continuation is forbidden. */
export async function qualifyCandidateArtifacts(
  input: {
    inventory: CandidateInventory
    artifacts: string
    output: string
    evidence: string
    env: NodeJS.ProcessEnv
  },
  execute: typeof run = run,
) {
  let failed = false
  for (const artifact of input.inventory.files) {
    const receipt = join(input.output, artifact.name + ".qualification.json")
    // The CLI already owns an empty output directory. Recheck each pathname
    // immediately before launch so a reused helper invocation cannot consume a
    // stale successful receipt after a new runner fails to write one.
    const existing = await lstat(receipt).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
      return undefined
    })
    if (existing) throw new Error("Candidate receipt already exists; no installer was started")
    try {
      await execute(
        process.execPath,
        [
          join(sourceRoot, "packages/physicalsystems/test/packaged-smoke.mjs"),
          "--artifact",
          join(input.artifacts, artifact.name),
          "--evidence",
          input.evidence,
          "--report",
          receipt,
          "--version",
          input.inventory.version,
        ],
        sourceRoot,
        input.env,
        input.env.PS_PROVIDER_REVIEW === "openai-device" ? 1_200_000 : 600_000,
      )
    } catch (error) {
      failed = true
      if (!(error instanceof DesktopCommandFailure) || error.outcome !== "exit")
        throw new Error("Candidate teardown is unconfirmed; remaining installers were not started")
    }
    let report: Qualification
    try {
      const stat = await lstat(receipt)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 1024 * 1024) throw new Error()
      report = JSON.parse(await readFile(receipt, "utf8")) as Qualification
      if (!candidateTeardownConfirmed(report, input.inventory, artifact)) throw new Error()
    } catch {
      throw new Error("Candidate teardown is unconfirmed; remaining installers were not started")
    }
    try {
      verifyQualification(artifact, input.inventory, report)
    } catch {
      failed = true
    }
  }
  if (failed) throw new Error("Packaged candidate qualification failed; inspect the bounded receipts")
}

async function readInputs(file: string) {
  const inputs: unknown = JSON.parse(await readFile(file, "utf8"))
  const history = JSON.parse(await readFile(join(dirname(file), "history.json"), "utf8")) as ReleaseHistory
  const expectedSha256 = process.env.PHYSICALSYSTEMS_EXPECTED_INPUTS_SHA256
  const expectedRepository = process.env.PHYSICALSYSTEMS_RELEASE_REPOSITORY
  if (process.env.GITHUB_ACTIONS === "true" && (!expectedSha256 || !expectedRepository))
    throw new Error("CI must bind downloaded inputs to the trusted prepare-job digest and repository")
  const verified = await verifyReleaseInputs({
    repoRoot: sourceRoot,
    inputs,
    history,
    expectedSha256,
    expectedRepository,
  })
  const models = join(dirname(file), "models.dev-api.json")
  if (sha(await readFile(models)) !== verified.modelCatalog.decodedSha256)
    throw new Error("Prepared model catalog was modified")
  return { inputs: verified, models }
}

export async function stageCandidateSource(root: string, revision: string, transaction: string, env = process.env) {
  const stage = join(transaction, "source")
  await mkdir(stage)
  await run("git", ["archive", "--format=tar", "--output", join(transaction, "source.tar"), revision], root, env)
  // Git Bash's GNU tar interprets a Windows drive prefix as a remote host.
  // Relative operands also work with Windows' native BSD tar and Linux tar.
  await run("tar", ["-xf", "source.tar", "-C", "source"], transaction, env)
  return stage
}

async function buildCandidate(file: string, platform: CandidatePlatform, outputPath: string) {
  const { inputs, models } = await readInputs(file)
  const host = process.platform === "win32" ? "windows-x64" : process.platform === "linux" ? "linux-x64" : "unsupported"
  if (platform !== host || process.arch !== "x64")
    throw new Error("Build the candidate on its exact supported OS/architecture")
  if (process.versions.bun !== inputs.toolchain.bun)
    throw new Error("Candidate Bun version does not match release inputs")
  const output = await emptyOutput(outputPath)
  const transaction = await mkdtemp(join(dirname(output), "desktop-build-"))
  const env = buildEnvironment(process.env, inputs, resolve(file), models)
  try {
    const stage = await stageCandidateSource(sourceRoot, inputs.source.revision, transaction, env)
    // Installing in the generated tree avoids workspace symlinks resolving back
    // into an actively edited checkout. Only pinned dependency download caches are reused.
    await run(process.execPath, ["install", "--frozen-lockfile", "--ignore-scripts"], stage, env)
    const electron = join(sourceRoot, "packages/desktop/node_modules/electron/dist")
    if ((await readFile(join(electron, "version"), "utf8")).trim() !== inputs.toolchain.electron)
      throw new Error("Prepared Electron distribution has the wrong version")
    await cp(electron, join(stage, "packages/desktop/node_modules/electron/dist"), { recursive: true })
    await cp(
      join(sourceRoot, "packages/desktop/node_modules/electron/path.txt"),
      join(stage, "packages/desktop/node_modules/electron/path.txt"),
    )
    const manifestPath = join(stage, "packages/desktop/package.json")
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
    manifest.version = inputs.version
    await writeFile(manifestPath, json(manifest))
    await run(process.execPath, ["packages/opencode/script/build-node.ts"], stage, env)
    const desktop = join(stage, "packages/desktop")
    await run(process.execPath, ["./node_modules/electron-vite/bin/electron-vite.js", "build"], desktop, env)
    await writeFile(join(desktop, "out/legal/desktop-release-inputs.json"), json(inputs))
    for (const name of ["models.dev.LICENSE", "models.dev.NOTICE"])
      await cp(join(stage, "release", name), join(desktop, "out/legal", name))
    const args = [
      "./node_modules/electron-builder/cli.js",
      "--config",
      "physical-release.config.ts",
      "--publish",
      "never",
      "--x64",
      platform === "windows-x64" ? "--win" : "--linux",
    ]
    await run(process.execPath, args, desktop, env)
    for (const entry of candidateNames(inputs.version, platform))
      await cp(join(desktop, "candidate-dist", entry.name), join(output, entry.name))
    const inventory = await createInventory(output, inputs, platform)
    await writeFile(join(output, "artifacts.json"), json(inventory))
    await writeFile(join(output, "SHA256SUMS"), checksums(inventory.files))
    console.log(`Prepared ${inventory.files.length} ${platform} candidate installers; publication disabled`)
  } finally {
    await rm(transaction, { recursive: true, force: true })
  }
}

export async function desktopRelease(args: string[]) {
  const { command, options } = releaseArguments(args)
  if (command === "verify-public") {
    const { verifyPublicDownloads } = await import("./public-downloads")
    const selection = await verifyPublicDownloads({
      review: JSON.parse(await readFile(options.review, "utf8")),
      expectedReviewSha256: options["expected-review-sha256"],
    })
    const output = await emptyOutput(options.output)
    await writeFile(join(output, "desktop-selection.json"), json(selection))
    console.log(`Verified public desktop ${selection.release.version}; prepared website selection without deploying it`)
    return
  }
  if (command === "prepare") {
    const history = JSON.parse(await readFile(options.history, "utf8")) as ReleaseHistory
    if (options.channel !== "preview" && options.channel !== "stable") throw new Error("Invalid desktop channel")
    const inputs = await prepareReleaseInputs({
      repoRoot: sourceRoot,
      repository: options.repository,
      version: options.version,
      channel: options.channel,
      history,
    })
    if (inputs.source.revision !== options["source-sha"]) throw new Error("Selected source revision changed")
    const output = await emptyOutput(options.output)
    await writeFile(join(output, "release-inputs.json"), json(inputs))
    await writeFile(join(output, "history.json"), json(history))
    await writeFile(
      join(output, "models.dev-api.json"),
      gunzipSync(await readFile(join(sourceRoot, inputs.modelCatalog.path))),
    )
    const sums = await Promise.all(
      ["release-inputs.json", "history.json", "models.dev-api.json"].map(
        async (name) => `${sha(await readFile(join(output, name)))}  ${name}`,
      ),
    )
    await writeFile(join(output, "SHA256SUMS"), sums.join("\n") + "\n")
    console.log(`Prepared ${inputs.version} from ${inputs.source.revision}; publication disabled`)
    return
  }
  if (command === "build") return buildCandidate(options.inputs, options.platform as CandidatePlatform, options.output)
  const { inputs } = await readInputs(options.inputs)
  if (command === "verify-inputs") {
    console.log(`Verified exact candidate inputs ${inputs.sha256}`)
    return
  }
  const output = await emptyOutput(options.output)
  if (command === "qualify") {
    const inventory = await verifyInventory(options.artifacts, inputs)
    const evidence = await mkdtemp(join(dirname(output), "desktop-qualification-"))
    return qualifyCandidateArtifacts({ inventory, artifacts: options.artifacts, output, evidence, env: process.env })
  }
  if (command === "verify-artifacts") {
    const inventory = await verifyInventory(options.artifacts, inputs)
    const checks: PlatformReport["checks"] = []
    const qualifications: Qualification[] = []
    for (const file of inventory.files) {
      try {
        const report = JSON.parse(
          await readFile(join(options.receipts, file.name + ".qualification.json"), "utf8"),
        ) as Qualification
        verifyQualification(file, inventory, report)
        qualifications.push(report)
        checks.push({ artifact: file.name, status: "PASS" })
      } catch {
        checks.push({
          artifact: file.name,
          status: "FAIL",
          reason: "Missing, failed or mismatched packaged qualification",
        })
      }
    }
    const report: PlatformReport = {
      schemaVersion: 1,
      inputsSha256: inputs.sha256,
      inventory,
      qualifications,
      checks,
      result: checks.every((check) => check.status === "PASS") ? "PASS" : "FAIL",
      publication: false,
    }
    await writeFile(join(output, "report.json"), json(report))
    await writeFile(
      join(output, "report.md"),
      `# ${inputs.version} · ${inventory.platform}\n\nCandidate qualification: **${report.result}**. Public distribution: **BLOCKED**.\n\n${checks.map((check) => `- ${check.artifact}: ${check.status}`).join("\n")}\n\nTask execution used simulation only. Native credential observations are recorded in the per-artifact receipts; candidate results do not qualify signed public installers. Windows signing, provider login, display and upgrade/recovery qualification, and public release setup remain separate. Optical/display flicker was not measured.\n`,
    )
    await writeFile(join(output, "SHA256SUMS"), checksums(inventory.files))
    await writeFile(join(output, "candidate-downloads.json"), json(candidateDownloads(inputs, [inventory])))
    if (report.result !== "PASS") throw new Error("Candidate has missing or failed required qualification")
    return
  }
  const files = await reportFiles(options.reports)
  const reports: PlatformReport[] = await Promise.all(
    files.map(async (file) => JSON.parse(await readFile(file, "utf8"))),
  )
  if (
    reports.length !== 2 ||
    reports.some(
      (report) =>
        report.schemaVersion !== 1 ||
        report.inputsSha256 !== inputs.sha256 ||
        report.publication !== false ||
        report.result !== "PASS",
    )
  )
    throw new Error("Both exact platform qualification reports must pass")
  for (const report of reports) verifyPlatformReport(inputs, report)
  const downloads = candidateDownloads(
    inputs,
    reports.map((report) => report.inventory),
  )
  await writeFile(join(output, "summary.json"), json({ schemaVersion: 1, inputs, reports, publication: false }))
  await writeFile(join(output, "candidate-downloads.json"), json(downloads))
  await writeFile(join(output, "SHA256SUMS"), checksums(reports.flatMap((report) => report.inventory.files)))
  await writeFile(
    join(output, "summary.md"),
    `# Physical Systems Desktop ${inputs.version}\n\nWindows x64 and Linux x64 candidate checks passed. Publication and website updates remain disabled.\n\nSource: ${inputs.source.revision}\n\nInputs: ${inputs.sha256}\n\nThis is an unsigned candidate with simulated task execution; hardware was not qualified. Native credential observations are recorded in each candidate receipt. Signed public installers still require their own qualification, including provider login, platform display and installation/upgrade recovery. Signing and public release setup remain prerequisites. Optical/display flicker was not measured.\n`,
  )
  console.log(`Candidate ${inputs.version} is ready for review; no release or website was changed`)
}

async function reportFiles(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { withFileTypes: true })
  const files = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory() && !entry.isSymbolicLink()
        ? reportFiles(join(folder, entry.name))
        : entry.isFile() && entry.name === "report.json"
          ? [join(folder, entry.name)]
          : [],
    ),
  )
  return files.flat()
}
