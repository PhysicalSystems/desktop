// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { constants, createDecipheriv, createHash, generateKeyPairSync, privateDecrypt } from "node:crypto"
import { PassThrough } from "node:stream"
import {
  runProviderBrowserReview,
  providerReviewCredentialsCleaned,
  type ProviderBrowserReviewRequest,
} from "./provider-browser-review"
import { providerAccountMarker, observeProviderAccount } from "./provider-account"
import { providerBrowserReviewTransport } from "./provider-browser-transport"

const keys = generateKeyPairSync("rsa", { modulusLength: 3072 })
const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString()
const reviewerKeySha256 = createHash("sha256")
  .update(keys.publicKey.export({ type: "spki", format: "der" }))
  .digest("hex")

function fixture(
  options: {
    marker?: "both" | "read" | "write" | "wrong-nonce" | "none"
    opened?: boolean
    pending?: boolean
    removeFails?: boolean
  } = {},
) {
  const stderr = new PassThrough()
  const nonce = "1".repeat(64)
  const nativeEnv = {
    PHYSICALSYSTEMS_PROVIDER_REVIEW: "openai-device",
    PHYSICALSYSTEMS_QUALIFICATION_TRACE: "1",
    PHYSICALSYSTEMS_PROVIDER_REVIEW_NONCE: options.marker === "wrong-nonce" ? "2".repeat(64) : nonce,
  }
  const credential = {
    key: "physicalsystems.v2." + createHash("sha256").update("openai").digest("hex"),
    info: {
      kind: "physicalsystems-v2-credential",
      record: {
        id: "cred_owned123",
        integrationID: "openai",
        value: {
          type: "oauth",
          methodID: "chatgpt-headless",
          access: "inert-private-access",
          refresh: "inert-private-refresh",
          metadata: { accountID: "inert-private-account" },
        },
      },
    },
  }
  const state = { connected: false, calls: [] as string[], sealed: Buffer.alloc(0) }
  const request: ProviderBrowserReviewRequest = async (route, input) => {
    state.calls.push(input.method + " " + route)
    if (input.method === "GET" && route === "/api/integration/openai")
      return {
        data: {
          id: "openai",
          methods: [{ type: "oauth", id: "chatgpt-headless" }],
          connections: state.connected ? [{ type: "credential", id: "cred_owned123" }] : [],
        },
      }
    if (input.method === "POST") {
      expect(route).toBe("/api/integration/openai/connect/oauth")
      expect(input.body).toEqual({ methodID: "chatgpt-headless", inputs: {} })
      return {
        data: {
          attemptID: "con_owned123",
          mode: "auto",
          url: "https://auth.openai.com/codex/device",
          instructions: "Enter code: PRIVATE-CODE",
          time: { created: Date.now(), expires: Date.now() + 600000 },
        },
      }
    }
    if (input.method === "GET" && route === "/api/integration/attempt/con_owned123") {
      if (options.pending) return { data: { status: "pending" } }
      state.connected = true
      const mode = options.marker ?? "both"
      if (["both", "write", "wrong-nonce"].includes(mode))
        stderr.write(providerAccountMarker("set", credential, { saved: true }, nativeEnv))
      if (["both", "read", "wrong-nonce"].includes(mode))
        stderr.write(providerAccountMarker("all", {}, { [credential.key]: credential.info }, nativeEnv))
      return { data: { status: "complete" } }
    }
    if (input.method === "DELETE" && route === "/api/integration/attempt/con_owned123") return
    if (input.method === "DELETE" && route === "/api/credential/cred_owned123") {
      if (options.removeFails) throw new Error("private credential removal details")
      state.connected = false
      return
    }
    throw new Error("unexpected fixture path")
  }
  const input = {
    provider: "openai-device" as const,
    nonce,
    context: {
      runId: "123",
      runAttempt: 2,
      sourceRevision: "a".repeat(40),
      artifactSha256: "b".repeat(64),
      releaseInputsSha256: "c".repeat(64),
      platform: "linux-x64" as const,
    },
    reviewerPublicKeyPem: publicKeyPem,
    reviewerKeySha256,
    child: { stderr },
    request,
    openBrowser: async (url: string) => {
      expect(url).toBe("https://auth.openai.com/codex/device")
      return options.opened ?? true
    },
    publishChallenge: async (sealed: Uint8Array) => {
      state.sealed = Buffer.from(sealed)
    },
    timeoutMs: options.pending ? 15 : 1000,
    pollMs: 1,
    observationTimeoutMs: 10,
  }
  return { input, state, credential, nativeEnv, close: () => stderr.destroy() }
}

test("inert protocol fixture exercises encrypted handoff, correlated native write/read and actual cleanup calls without granting native PASS", async () => {
  const f = fixture()
  try {
    const result = await runProviderBrowserReview(f.input)
    expect(result.status).toBe("OBSERVED")
    expect(result).toMatchObject({
      nativeAccountObserved: true,
      nativeTokenRetrievalObserved: true,
      browserHandoffAcknowledged: true,
      localCredentialRemoved: true,
      providerTokenUse: "NOT_TESTED",
      providerTokenRevocation: "NOT_TESTED",
    })
    expect(f.state.connected).toBe(false)
    expect(f.state.calls).toContain("DELETE /api/credential/cred_owned123")
    expect(JSON.stringify(result)).not.toContain("inert-private")
    expect(JSON.stringify(result)).not.toContain("PASS")
    expect(f.state.sealed.toString()).not.toContain("PRIVATE-CODE")
    const envelope = JSON.parse(f.state.sealed.toString())
    expect(envelope.protected.context).toEqual(f.input.context)
    const aad = Buffer.from(JSON.stringify(envelope.protected))
    const key = privateDecrypt(
      { key: keys.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256", oaepLabel: aad },
      Buffer.from(envelope.wrappedKey, "base64"),
    )
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"))
    decipher.setAAD(aad)
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"))
    const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()])
    expect(JSON.parse(plaintext.toString())).toEqual({
      url: "https://auth.openai.com/codex/device",
      instructions: "Enter code: PRIVATE-CODE",
    })
    expect(() =>
      privateDecrypt(
        {
          key: keys.privateKey,
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256",
          oaepLabel: Buffer.from("wrong run"),
        },
        Buffer.from(envelope.wrappedKey, "base64"),
      ),
    ).toThrow()
    key.fill(0)
    plaintext.fill(0)
  } finally {
    f.close()
  }
})

test("ordinary/invalid/unselected QA makes no provider request; invalid recipient or artifact cannot start an attempt", async () => {
  const f = fixture()
  try {
    expect(await runProviderBrowserReview({ ...f.input, provider: undefined })).toEqual({
      status: "NOT_TESTED",
      reason: "NO_SELECTED_PROVIDER",
    })
    await expect(runProviderBrowserReview({ ...f.input, reviewerKeySha256: "0".repeat(64) })).rejects.toThrow(
      "UNCONFIRMED",
    )
    await expect(
      runProviderBrowserReview({ ...f.input, context: { ...f.input.context, sourceRevision: "main" } }),
    ).rejects.toThrow("UNCONFIRMED")
    expect(f.state.calls).toEqual([])
    expect(providerAccountMarker("set", f.credential, { saved: true }, {})).toBeUndefined()
  } finally {
    f.close()
  }
})

test("missing/wrong/partial native evidence and failed browser opening cannot produce an observed login", async () => {
  for (const options of [
    { marker: "none" },
    { marker: "read" },
    { marker: "write" },
    { marker: "wrong-nonce" },
    { opened: false },
    { pending: true },
  ] as const) {
    const f = fixture(options)
    try {
      await expect(runProviderBrowserReview(f.input)).rejects.toThrow("PROVIDER_REVIEW_UNCONFIRMED")
      expect(f.state.connected).toBe(false)
      expect(f.state.calls).toContain("DELETE /api/integration/attempt/con_owned123")
    } finally {
      f.close()
    }
  }
  const f = fixture({ removeFails: true })
  try {
    await expect(runProviderBrowserReview(f.input)).rejects.toThrow("PROVIDER_REVIEW_CLEANUP_UNCONFIRMED")
  } finally {
    f.close()
  }
})

test("failed-review cleanup proof requires owned attempt cancellation and a final empty credential observation", async () => {
  for (const outcome of [
    "clean",
    "late-credential",
    "cancel-failed",
    "no-owned-attempt",
    "credential-retained",
  ] as const) {
    const f = fixture({ pending: true })
    try {
      const error = await runProviderBrowserReview({
        ...f.input,
        request: async (route, input) => {
          if (outcome === "no-owned-attempt" && input.method === "POST") return { data: {} }
          if (input.method === "DELETE" && route === "/api/integration/attempt/con_owned123") {
            if (outcome === "cancel-failed") throw new Error("PRIVATE CANCELLATION ERROR")
            if (outcome === "late-credential" || outcome === "credential-retained") f.state.connected = true
          }
          if (
            outcome === "credential-retained" &&
            input.method === "DELETE" &&
            route === "/api/credential/cred_owned123"
          )
            return
          return f.input.request(route, input)
        },
      }).catch((error) => error)
      expect(error).toBeInstanceOf(Error)
      expect(providerReviewCredentialsCleaned(error)).toBe(outcome === "clean" || outcome === "late-credential")
      expect(providerReviewCredentialsCleaned(Object.assign(new Error(error.message), { cleaned: true }))).toBe(false)
      expect(providerReviewCredentialsCleaned({ message: error.message, cleaned: true })).toBe(false)
      if (outcome === "late-credential") {
        expect(f.state.calls).toContain("DELETE /api/credential/cred_owned123")
        expect(f.state.connected).toBe(false)
      }
    } finally {
      f.close()
    }
  }
})

test("native account fingerprint is tied to nonce and exact credential and rejects conflicting accounts", () => {
  const f = fixture()
  try {
    const write = providerAccountMarker("set", f.credential, { saved: true }, f.nativeEnv)!
    const read = providerAccountMarker("all", {}, { [f.credential.key]: f.credential.info }, f.nativeEnv)!
    expect(observeProviderAccount(write + read, f.input.nonce, "cred_owned123")).toMatchObject({
      nativeWriteObserved: true,
      nativeReadObserved: true,
    })
    expect(observeProviderAccount(write, "3".repeat(64), "cred_owned123")).toBeUndefined()
    expect(observeProviderAccount(write, f.input.nonce, "cred_other")).toBeUndefined()
    const changed = structuredClone(f.credential)
    changed.info.record.value.metadata.accountID = "different-account"
    expect(() =>
      observeProviderAccount(
        write + providerAccountMarker("set", changed, { saved: true }, f.nativeEnv),
        f.input.nonce,
        "cred_owned123",
      ),
    ).toThrow("ACCOUNT_UNCONFIRMED")
    expect(write).not.toContain("inert-private")
  } finally {
    f.close()
  }
})

test("browser QA transport binds owned loopback Location, exact method routes, strict responses and bounded bodies", async () => {
  const attachment = {
    url: "http://127.0.0.1:43125",
    username: "opencode",
    password: "inert-private-password",
    directory: "/owned/fixture",
  }
  const calls: URL[] = []
  const transport = providerBrowserReviewTransport(attachment, async (url: URL, init: RequestInit) => {
    calls.push(url)
    expect(init.redirect).toBe("error")
    expect(url.searchParams.get("location[directory]")).toBe(attachment.directory)
    return new Response(JSON.stringify({ location: { directory: attachment.directory }, data: { id: "openai" } }))
  })
  const signal = AbortSignal.timeout(1000)
  expect(await transport("/api/integration/openai", { method: "GET", signal })).toMatchObject({
    data: { id: "openai" },
  })
  await expect(transport("https://other.example/api/integration/openai", { method: "GET", signal })).rejects.toThrow(
    "UNCONFIRMED",
  )
  await expect(transport("/auth/openai", { method: "GET", signal })).rejects.toThrow("UNCONFIRMED")
  expect(calls).toHaveLength(1)
  const wrong = providerBrowserReviewTransport(
    attachment,
    async () => new Response(JSON.stringify({ location: { directory: "/different" }, data: {} })),
  )
  await expect(wrong("/api/integration/openai", { method: "GET", signal })).rejects.toThrow("UNCONFIRMED")
  const oversized = providerBrowserReviewTransport(attachment, async () => new Response("x".repeat(256 * 1024 + 1)))
  await expect(oversized("/api/integration/openai", { method: "GET", signal })).rejects.toThrow("UNCONFIRMED")
  await expect(transport("/api/credential/cred_owned123", { method: "DELETE", signal })).rejects.toThrow("UNCONFIRMED")
  const count = calls.length
  await expect(
    transport("/api/integration/openai/connect/oauth", {
      method: "POST",
      body: { methodID: "chatgpt-browser", inputs: {} },
      signal,
    }),
  ).rejects.toThrow("UNCONFIRMED")
  expect(calls).toHaveLength(count)
})
