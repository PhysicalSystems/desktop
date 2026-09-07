// SPDX-License-Identifier: Apache-2.0
import { constants } from "node:fs"
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"
import { createHash } from "node:crypto"
import { candidateNames } from "./artifacts"
import { desktopIdentity } from "./identity"
import { validatePublicBuildInputs } from "./public-build"
import { publicReviewDigest, validateDistributionFacts } from "./public-downloads"
import { validateQualifiedDistribution, verifyQualifiedBundle } from "./public-publisher"
import { unimplementedPublicChecks, verifyPublicSignaturePair } from "./public-qualification"
import { requiredQualificationChecks, sha256File } from "./qualification"

export class PublicCollectorError extends Error {}
const invalid = () => new PublicCollectorError("PUBLIC_COLLECTION_EVIDENCE_INVALID")
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
const bytesDigest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n"
function object(value: unknown, required: string[], optional: string[] = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid()
  const record = value as Record<string, unknown>
  if (
    required.some((key) => !(key in record)) ||
    Object.keys(record).some((key) => ![...required, ...optional].includes(key))
  )
    throw invalid()
  return record
}
function equal(left: unknown, right: unknown) {
  if (publicReviewDigest(left) !== publicReviewDigest(right)) throw invalid()
}

export type PublicCollectionPlan = {
  schemaVersion: 1
  kind: "public-desktop-collection-plan"
  runId: string
  runAttempt: number
  sourceRevision: string
  releaseInputsSha256: string
  publicBuildInputsSha256: string
  artifacts: { name: string; bytes: number; sha256: string; smokeSha256: string; nativeSha256: string }[]
}

/** Authored only by the reviewed native job after its real checks finish.
 * Its separately trusted raw digest authenticates origin; the collector cannot
 * infer native behavior from fixtures, receipt fields or a self-computed hash. */
export type PublicNativeReceipt = Omit<PublicCollectionPlan, "kind" | "artifacts"> & {
  kind: "public-desktop-native-qualification"
  artifact: { name: string; bytes: number; sha256: string }
  identity: ReturnType<typeof desktopIdentity>
  platform: "windows-x64" | "linux-x64"
  checks: { id: (typeof unimplementedPublicChecks)[number]; status: "PASS" | "FAIL" | "BLOCKED" | "NOT_TESTED" }[]
}

export async function collectPublicDistribution(input: {
  plan: unknown
  expectedPlanSha256: string
  publicBuild: unknown
  expectedPublicBuildSha256: string
  expectedInputsSha256: string
  sourceRevision: string
  runId: string
  runAttempt: number
  evidence: string
  output: string
}) {
  if (!digest(input.expectedPlanSha256) || publicReviewDigest(input.plan) !== input.expectedPlanSha256) throw invalid()
  const build = validatePublicBuildInputs(input.publicBuild, input.expectedPublicBuildSha256)
  const plan = object(input.plan, [
    "schemaVersion",
    "kind",
    "runId",
    "runAttempt",
    "sourceRevision",
    "releaseInputsSha256",
    "publicBuildInputsSha256",
    "artifacts",
  ])
  const binding = {
    runId: input.runId,
    runAttempt: input.runAttempt,
    sourceRevision: input.sourceRevision,
    releaseInputsSha256: input.expectedInputsSha256,
    publicBuildInputsSha256: input.expectedPublicBuildSha256,
  }
  if (
    !/^[1-9]\d*$/.test(input.runId) ||
    !Number.isSafeInteger(input.runAttempt) ||
    input.runAttempt < 1 ||
    build.sourceRevision !== input.sourceRevision ||
    build.releaseInputsSha256 !== input.expectedInputsSha256 ||
    plan.schemaVersion !== 1 ||
    plan.kind !== "public-desktop-collection-plan"
  )
    throw invalid()
  for (const [key, value] of Object.entries(binding)) equal(plan[key], value)
  const expected = [...candidateNames(build.version, "windows-x64"), ...candidateNames(build.version, "linux-x64")]
  if (!Array.isArray(plan.artifacts) || plan.artifacts.length !== expected.length) throw invalid()
  const artifacts = plan.artifacts.map((value) => {
    const artifact = object(value, ["name", "bytes", "sha256", "smokeSha256", "nativeSha256"])
    if (
      !expected.some((item) => item.name === artifact.name) ||
      !Number.isSafeInteger(artifact.bytes) ||
      Number(artifact.bytes) < 1 ||
      Number(artifact.bytes) > 2 * 1024 ** 3 ||
      !digest(artifact.sha256) ||
      !digest(artifact.smokeSha256) ||
      !digest(artifact.nativeSha256)
    )
      throw invalid()
    return artifact as PublicCollectionPlan["artifacts"][number]
  })
  if (new Set(artifacts.map((artifact) => artifact.name)).size !== expected.length) throw invalid()
  if (!isAbsolute(input.evidence) || !isAbsolute(input.output)) throw invalid()
  const evidence = await realpath(input.evidence)
  const parent = await realpath(dirname(input.output))
  if (
    evidence !== resolve(input.evidence) ||
    parent !== resolve(dirname(input.output)) ||
    input.output !== resolve(input.output) ||
    input.output === evidence ||
    input.output.startsWith(evidence + sep) ||
    evidence.startsWith(input.output + sep)
  )
    throw invalid()
  if (
    await lstat(input.output).catch((error: NodeJS.ErrnoException) =>
      error.code === "ENOENT" ? undefined : Promise.reject(error),
    )
  )
    throw invalid()
  equal(
    (await readdir(evidence)).sort(),
    [
      ...new Set(
        artifacts.flatMap((artifact) => [
          artifact.name,
          `${artifact.smokeSha256}.json`,
          `${artifact.nativeSha256}.json`,
        ]),
      ),
    ].sort(),
  )
  const readReceipt = async (sha256: string) => {
    const file = join(evidence, `${sha256}.json`)
    const stat = await lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 256 * 1024) throw invalid()
    const bytes = await readFile(file)
    if (bytesDigest(bytes) !== sha256) throw invalid()
    try {
      return JSON.parse(bytes.toString()) as unknown
    } catch {
      throw invalid()
    }
  }
  const reports: { sha256: string; bytes: string }[] = []
  const assets = []
  let signing: ReturnType<typeof verifyPublicSignaturePair> | undefined
  for (const artifact of artifacts) {
    const file = join(evidence, artifact.name)
    const stat = await lstat(file)
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size !== artifact.bytes ||
      (await sha256File(file)) !== artifact.sha256
    )
      throw invalid()
    const inventory = { name: artifact.name, bytes: artifact.bytes, sha256: artifact.sha256 }
    const platform = artifact.name.endsWith(".exe") ? "windows-x64" : "linux-x64"
    const smoke = object(
      await readReceipt(artifact.smokeSha256),
      [
        "schemaVersion",
        "kind",
        "artifact",
        "version",
        "platform",
        "result",
        "smokeResult",
        "simulationOnly",
        "deviceConnectionsAllowed",
        "opticalFlickerMeasured",
        "publicDistribution",
        "inputsSha256",
        "sourceRevision",
        "signature",
        "payload",
        "checks",
        "publication",
        "identity",
        "publicBuildInputsSha256",
        "releaseInputsSha256",
        "compiledIdentity",
        "signing",
      ],
      ["windowsVersion"],
    )
    if (
      smoke.schemaVersion !== 1 ||
      smoke.kind !== "unqualified-public-desktop-smoke" ||
      smoke.result !== "UNQUALIFIED" ||
      smoke.smokeResult !== "PASS" ||
      smoke.publication !== false ||
      smoke.simulationOnly !== true ||
      smoke.deviceConnectionsAllowed !== false ||
      smoke.opticalFlickerMeasured !== false ||
      smoke.version !== build.version ||
      smoke.platform !== platform ||
      smoke.inputsSha256 !== input.expectedInputsSha256
    )
      throw invalid()
    equal(smoke.artifact, inventory)
    equal(smoke.identity, desktopIdentity("public"))
    for (const key of ["sourceRevision", "releaseInputsSha256", "publicBuildInputsSha256"] as const)
      equal(smoke[key], binding[key])
    const compiled = object(smoke.compiledIdentity, ["identity", "publicBuildInputsSha256", "mainSha256"])
    if (
      compiled.identity !== "public" ||
      compiled.publicBuildInputsSha256 !== input.expectedPublicBuildSha256 ||
      !digest(compiled.mainSha256)
    )
      throw invalid()
    const payload = object(smoke.payload, ["sha256", "executableSha256"])
    if (!digest(payload.sha256) || !digest(payload.executableSha256)) throw invalid()
    const distribution = object(smoke.publicDistribution, ["status", "reason"])
    if (distribution.status !== "BLOCKED" || typeof distribution.reason !== "string") throw invalid()
    const signature = object(smoke.signature, ["status", "trust"], ["signerThumbprint"])
    if (platform === "windows-x64" && (signature.status !== "PASS" || signature.trust !== "WINDOWS_AUTHENTICODE_VALID"))
      throw invalid()
    if (platform === "linux-x64") {
      equal(smoke.signing, { status: "NOT_TESTED" })
      equal(signature, { status: "NOT_TESTED", trust: "NOT_APPLICABLE_TO_LINUX_PACKAGE" })
    }
    if ("windowsVersion" in smoke) object(smoke.windowsVersion, ["productName", "fileVersion", "productVersion"])
    const smokeChecks = checkMap(smoke.checks, false)
    const required = [
      ...requiredQualificationChecks,
      "public-compiled-identity",
      ...(platform === "windows-x64"
        ? ["public-signing", "uninstall"]
        : [
            "linux-sandbox-setup",
            "linux-renderer-sandbox",
            "linux-temporary-cleanup",
            ...(artifact.name.endsWith(".deb") ? ["uninstall"] : ["appimage-launcher", "linux-sandbox-cleanup"]),
          ]),
    ]
    if (required.some((id) => smokeChecks.get(id) !== "PASS")) throw invalid()
    const native = object(await readReceipt(artifact.nativeSha256), [
      "schemaVersion",
      "kind",
      ...Object.keys(binding),
      "artifact",
      "identity",
      "platform",
      "checks",
    ])
    if (
      native.schemaVersion !== 1 ||
      native.kind !== "public-desktop-native-qualification" ||
      native.platform !== platform
    )
      throw invalid()
    for (const [key, value] of Object.entries(binding)) equal(native[key], value)
    equal(native.artifact, inventory)
    equal(native.identity, desktopIdentity("public"))
    const nativeChecks = checkMap(native.checks, true)
    if (
      nativeChecks.size !== unimplementedPublicChecks.length ||
      unimplementedPublicChecks.some((id) => nativeChecks.get(id) !== "PASS")
    )
      throw invalid()
    if (platform === "windows-x64") {
      const observed = object(smoke.signing, ["status", "policy", "installer", "executable"])
      if (observed.status !== "PASS") throw invalid()
      equal(observed.policy, build.windowsSigning)
      const installer = object(observed.installer, ["status", "publisher", "certificateThumbprint", "sha256"])
      const executable = object(observed.executable, ["status", "publisher", "certificateThumbprint", "sha256"])
      if (
        installer.status !== "PASS" ||
        executable.status !== "PASS" ||
        installer.sha256 !== artifact.sha256 ||
        executable.sha256 !== payload.executableSha256
      )
        throw invalid()
      if (signature.signerThumbprint !== installer.certificateThumbprint) throw invalid()
      signing = verifyPublicSignaturePair({
        installer: { Status: "Valid", Publisher: installer.publisher, Thumbprint: installer.certificateThumbprint },
        executable: { Status: "Valid", Publisher: executable.publisher, Thumbprint: executable.certificateThumbprint },
        mode: {
          build,
          publicBuildInputsSha256: input.expectedPublicBuildSha256,
          releaseInputsSha256: input.expectedInputsSha256,
        },
        installerSha256: artifact.sha256,
        executableSha256: payload.executableSha256,
      })
    }
    const checks = Object.fromEntries([
      ...requiredQualificationChecks
        .filter((id) => !["package-format", "payload-integrity"].includes(id))
        .map((id) => [id, smokeChecks.get(id)]),
      ...nativeChecks,
    ])
    const bytes = json({
      schemaVersion: 1,
      kind: "collected-public-desktop-artifact",
      ...binding,
      artifact: inventory,
      identity: desktopIdentity("public"),
      platform,
      smokeSha256: artifact.smokeSha256,
      nativeSha256: artifact.nativeSha256,
      payloadSha256: payload.sha256,
      executableSha256: payload.executableSha256,
      mainSha256: compiled.mainSha256,
      smokeChecks: Object.fromEntries(smokeChecks),
      checks,
    })
    const sha256 = bytesDigest(bytes)
    reports.push({ sha256, bytes })
    assets.push({ ...inventory, qualification: { reportSha256: sha256, checks } })
  }
  if (!signing) throw invalid()
  const signatureBytes = json({ schemaVersion: 1, kind: "collected-public-desktop-signatures", ...binding, ...signing })
  const signatureSha256 = bytesDigest(signatureBytes)
  reports.push({ sha256: signatureSha256, bytes: signatureBytes })
  const summary = json({
    schemaVersion: 1,
    kind: "collected-public-desktop-qualification",
    ...binding,
    planSha256: input.expectedPlanSha256,
    assets: assets.map(({ name, sha256, qualification }) => ({
      name,
      sha256,
      reportSha256: qualification.reportSha256,
    })),
    signatureReportSha256: signatureSha256,
  })
  const summarySha256 = bytesDigest(summary)
  reports.push({ sha256: summarySha256, bytes: summary })
  const facts = validateDistributionFacts({
    repository: "PhysicalSystems/physicalsystems",
    version: build.version,
    channel: build.channel,
    tag: `desktop-v${build.version}`,
    sourceRevision: input.sourceRevision,
    inputsSha256: input.expectedInputsSha256,
    identity: { appId: build.identity.appId, productName: build.identity.productName },
    windowsSigning: {
      status: "verified",
      publisher: signing.installer.publisher,
      certificateThumbprint: signing.installer.certificateThumbprint,
      installerSha256: signing.installer.sha256,
      executableSha256: signing.executable.sha256,
      verificationReportSha256: signatureSha256,
    },
    assets,
  })
  const record = {
    schemaVersion: 1,
    kind: "qualified-public-desktop-distribution",
    facts,
    qualificationBundleSha256: summarySha256,
  }
  const sha256 = publicReviewDigest(record)
  validateQualifiedDistribution(record, sha256)
  await mkdir(input.output, { mode: 0o700 })
  const owned = await lstat(input.output)
  try {
    for (const artifact of artifacts) {
      const file = join(input.output, artifact.name)
      await copyFile(join(evidence, artifact.name), file, constants.COPYFILE_EXCL)
      if ((await sha256File(file)) !== artifact.sha256) throw invalid()
    }
    for (const report of reports)
      await writeFile(join(input.output, `${report.sha256}.json`), report.bytes, { flag: "wx", mode: 0o600 })
    await writeFile(join(input.output, "qualified-distribution.json"), json(record), { flag: "wx", mode: 0o600 })
    await verifyQualifiedBundle({
      directory: input.output,
      expectedSha256: sha256,
      sourceRevision: input.sourceRevision,
    })
  } catch (error) {
    const current = await lstat(input.output)
    if (current.isDirectory() && !current.isSymbolicLink() && current.dev === owned.dev && current.ino === owned.ino)
      await rm(input.output, { recursive: true })
    throw error
  }
  return { record: validateQualifiedDistribution(record, sha256), sha256 }
}

function checkMap(value: unknown, native: boolean) {
  if (!Array.isArray(value) || value.length > 64) throw invalid()
  const entries = value.map((value) => {
    const check = object(value, ["id", "status"], native ? [] : ["detail", "failureCode"])
    const allowed = native
      ? [...unimplementedPublicChecks]
      : [
          ...unimplementedPublicChecks,
          ...requiredQualificationChecks,
          "public-compiled-identity",
          "public-signing",
          "uninstall",
          "appimage-launcher",
          "linux-sandbox-setup",
          "linux-renderer-sandbox",
          "linux-temporary-cleanup",
          "linux-sandbox-cleanup",
          "shared-terminal",
          "provider-login",
          "real-hardware",
          "startup-phase",
          "startup-observation",
          "synthetic-observation",
        ]
    if (
      typeof check.id !== "string" ||
      !allowed.includes(check.id) ||
      !["PASS", "NOT_TESTED"].includes(String(check.status)) ||
      "failureCode" in check
    )
      throw invalid()
    return [check.id, check.status] as const
  })
  const result = new Map(entries)
  if (result.size !== entries.length) throw invalid()
  return result
}
