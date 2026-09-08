// SPDX-License-Identifier: Apache-2.0
import { constants, createCipheriv, createHash, createPublicKey, publicEncrypt, randomBytes } from "node:crypto"
import type { ChildProcess } from "node:child_process"
import { watchProviderAccount } from "./provider-account"

export type ProviderBrowserReviewContext = {
  runId: string
  runAttempt: number
  sourceRevision: string
  artifactSha256: string
  releaseInputsSha256: string
  platform: "windows-x64" | "linux-x64"
}
export type ProviderBrowserReviewRequest = (
  route: string,
  input: {
    method: "GET" | "POST" | "DELETE"
    body?: unknown
    signal: AbortSignal
  },
) => Promise<unknown>

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const fail = () => new Error("PROVIDER_REVIEW_UNCONFIRMED")
const record = (input: unknown): Record<string, unknown> => {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw fail()
  return input as Record<string, unknown>
}

/** Real device OAuth only, called inside the owned native process controller.
 * The request adapter authenticates the exact sidecar; openBrowser invokes that
 * renderer's native API. No manual PASS/receipt input or fixture fallback exists.
 * publishChallenge uploads ciphertext while this same bounded process keeps polling.
 * The caller independently verifies native shutdown/profile cleanup afterwards. */
export async function runProviderBrowserReview(input: {
  provider?: "openai-device"
  context: ProviderBrowserReviewContext
  nonce: string
  reviewerPublicKeyPem: string
  reviewerKeySha256: string
  child: Pick<ChildProcess, "stderr">
  request: ProviderBrowserReviewRequest
  openBrowser: (url: string) => Promise<boolean>
  publishChallenge: (sealed: Uint8Array) => Promise<void>
  timeoutMs?: number
  pollMs?: number
  observationTimeoutMs?: number
}) {
  if (input.provider === undefined) return { status: "NOT_TESTED" as const, reason: "NO_SELECTED_PROVIDER" as const }
  if (input.provider !== "openai-device" || !/^[a-f0-9]{64}$/.test(input.nonce)) throw fail()
  const context = validateProviderBrowserReviewContext(input.context)
  const key = (() => {
    try {
      if (
        input.reviewerPublicKeyPem.length > 16384 ||
        !/^\s*-----BEGIN PUBLIC KEY-----\s+[A-Za-z0-9+/=\s]+-----END PUBLIC KEY-----\s*$/.test(
          input.reviewerPublicKeyPem,
        )
      )
        throw fail()
      const value = createPublicKey({ key: input.reviewerPublicKeyPem, format: "pem", type: "spki" })
      if (
        value.asymmetricKeyType !== "rsa" ||
        (value.asymmetricKeyDetails?.modulusLength ?? 0) < 3072 ||
        (value.asymmetricKeyDetails?.modulusLength ?? 0) > 16384 ||
        digest(value.export({ format: "der", type: "spki" })) !== input.reviewerKeySha256
      )
        throw fail()
      return value
    } catch {
      throw fail()
    }
  })()
  const timeoutMs = input.timeoutMs ?? 9 * 60 * 1000
  const pollMs = input.pollMs ?? 1000
  const observationTimeoutMs = input.observationTimeoutMs ?? 6500
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 9 * 60 * 1000 ||
    !Number.isInteger(pollMs) ||
    pollMs < 1 ||
    pollMs > 1000 ||
    !Number.isInteger(observationTimeoutMs) ||
    observationTimeoutMs < 1 ||
    observationTimeoutMs > 6500
  )
    throw fail()
  const deadline = Date.now() + timeoutMs
  const observed = watchProviderAccount(input.child, input.nonce)
  const state: {
    attemptID?: string
    credentialID?: string
    fingerprint?: string
    challengeSha256?: string
    opened: boolean
    authorized: boolean
    clean: boolean
  } = { opened: false, authorized: false, clean: false }
  const request = (route: string, method: "GET" | "POST" | "DELETE", body?: unknown) =>
    bounded((signal) => input.request(route, { method, body, signal }), 6500)
  const integration = async () => record(record(await request("/api/integration/openai", "GET")).data)
  const connections = (value: Record<string, unknown>) => {
    if (value.id !== "openai" || !Array.isArray(value.connections)) throw fail()
    return value.connections.map((item) => {
      const connection = record(item)
      if (
        connection.type !== "credential" ||
        typeof connection.id !== "string" ||
        !/^cred_[a-zA-Z0-9]{1,128}$/.test(connection.id)
      )
        throw fail()
      return connection.id
    })
  }
  try {
    const before = await integration()
    if (
      connections(before).length ||
      !Array.isArray(before.methods) ||
      !before.methods.some((item) => {
        const method = record(item)
        return method.type === "oauth" && method.id === "chatgpt-headless"
      })
    )
      throw fail()
    const authorization = record(
      record(
        await request("/api/integration/openai/connect/oauth", "POST", { methodID: "chatgpt-headless", inputs: {} }),
      ).data,
    )
    if (typeof authorization.attemptID !== "string" || !/^con_[a-zA-Z0-9]{1,128}$/.test(authorization.attemptID))
      throw fail()
    state.attemptID = authorization.attemptID
    const time = record(authorization.time)
    if (
      authorization.mode !== "auto" ||
      authorization.url !== "https://auth.openai.com/codex/device" ||
      typeof authorization.instructions !== "string" ||
      !/^Enter code: [A-Za-z0-9-]{4,64}$/.test(authorization.instructions) ||
      typeof time.created !== "number" ||
      typeof time.expires !== "number" ||
      !Number.isFinite(time.created) ||
      !Number.isFinite(time.expires) ||
      time.created > Date.now() + 5000 ||
      time.expires <= Date.now() ||
      time.expires - time.created > 10 * 60 * 1000
    )
      throw fail()
    const expiresAt = Math.min(deadline, time.expires)
    const header = {
      schemaVersion: 1,
      kind: "physicalsystems-provider-review",
      context,
      provider: "openai",
      methodID: "chatgpt-headless",
      reviewNonceSha256: digest(input.nonce),
      attemptSha256: digest(state.attemptID),
      expiresAt,
      recipientKeySha256: input.reviewerKeySha256,
      contentEncryption: "AES-256-GCM",
      keyEncryption: "RSA-OAEP-SHA256",
    }
    const aad = Buffer.from(JSON.stringify(header))
    const secret = randomBytes(32)
    const iv = randomBytes(12)
    const plaintext = Buffer.from(JSON.stringify({ url: authorization.url, instructions: authorization.instructions }))
    const envelope = (() => {
      try {
        const cipher = createCipheriv("aes-256-gcm", secret, iv)
        cipher.setAAD(aad)
        return Buffer.from(
          JSON.stringify({
            protected: header,
            wrappedKey: publicEncrypt(
              { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256", oaepLabel: aad },
              secret,
            ).toString("base64"),
            iv: iv.toString("base64"),
            ciphertext: Buffer.concat([cipher.update(plaintext), cipher.final()]).toString("base64"),
            tag: cipher.getAuthTag().toString("base64"),
          }) + "\n",
        )
      } finally {
        secret.fill(0)
        plaintext.fill(0)
      }
    })()
    state.opened = await bounded(() => input.openBrowser(authorization.url as string), 6000)
    if (state.opened !== true) throw fail()
    state.challengeSha256 = digest(envelope)
    await bounded(() => input.publishChallenge(envelope), 30000)
    while (Date.now() < expiresAt) {
      const current = record(record(await request(`/api/integration/attempt/${state.attemptID}`, "GET")).data)
      if (current.status === "complete") {
        const ids = connections(await integration())
        if (ids.length !== 1) throw fail()
        state.credentialID = ids[0]!
        const until = Date.now() + observationTimeoutMs
        let account = observed.result(state.credentialID)
        while ((!account?.nativeReadObserved || !account.nativeWriteObserved) && Date.now() < until) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, until - Date.now()))))
          account = observed.result(state.credentialID)
        }
        if (!account?.nativeReadObserved || !account.nativeWriteObserved) throw fail()
        state.fingerprint = account.accountFingerprint
        state.authorized = true
        break
      }
      if (current.status !== "pending") throw fail()
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, expiresAt - Date.now()))))
    }
    if (!state.authorized) throw fail()
  } catch {
    throw fail()
  } finally {
    try {
      if (state.attemptID) {
        if ((await request(`/api/integration/attempt/${state.attemptID}`, "DELETE")) !== undefined) throw fail()
        const ids = connections(await integration())
        if (ids.length > 1 || (state.credentialID && ids.length && ids[0] !== state.credentialID)) throw fail()
        if (ids.length && (await request(`/api/credential/${ids[0]}`, "DELETE")) !== undefined) throw fail()
        if (connections(await integration()).length) throw fail()
        state.clean = true
      }
    } catch {
      throw new Error("PROVIDER_REVIEW_CLEANUP_UNCONFIRMED")
    } finally {
      observed.dispose()
    }
  }
  return {
    status: "OBSERVED" as const,
    context,
    provider: "openai" as const,
    methodID: "chatgpt-headless" as const,
    attemptSha256: digest(state.attemptID!),
    accountFingerprint: state.fingerprint!,
    browserHandoffAcknowledged: state.opened,
    reviewNonceSha256: digest(input.nonce),
    recipientKeySha256: input.reviewerKeySha256,
    challengeSha256: state.challengeSha256!,
    nativeAccountObserved: state.authorized,
    nativeTokenRetrievalObserved: state.authorized,
    localCredentialRemoved: state.clean,
    deviceGrant: "ACTUAL_PROVIDER" as const,
    providerTokenUse: "NOT_TESTED" as const,
    providerTokenRevocation: "NOT_TESTED" as const,
  }
}

async function bounded<A>(operation: (signal: AbortSignal) => Promise<A>, timeoutMs: number) {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(fail())
        }, timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export function validateProviderBrowserReviewContext(value: ProviderBrowserReviewContext) {
  if (
    !value ||
    Object.keys(value).sort().join(",") !==
      "artifactSha256,platform,releaseInputsSha256,runAttempt,runId,sourceRevision" ||
    typeof value.runId !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(value.runId) ||
    !Number.isSafeInteger(value.runAttempt) ||
    value.runAttempt < 1 ||
    typeof value.sourceRevision !== "string" ||
    !/^[a-f0-9]{40}$/.test(value.sourceRevision) ||
    typeof value.artifactSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.artifactSha256) ||
    typeof value.releaseInputsSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.releaseInputsSha256) ||
    !["linux-x64", "windows-x64"].includes(value.platform)
  )
    throw fail()
  return structuredClone(value)
}
