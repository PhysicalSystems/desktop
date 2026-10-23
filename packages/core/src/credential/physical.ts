// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto"
import { Effect, Option, Schema, Semaphore } from "effect"
import { CredentialLegacy } from "@opencode/schema/credential-legacy"
import { Integration } from "@opencode/schema/integration"
import { NonNegativeInt } from "@opencode/schema/schema"
import { Credential } from "../credential.js"
import type { Bus } from "../bus.js"
import { nativeCredentialRequest } from "./native.js"

/** One atomically encrypted record per provider retains ordering and activation.
 * The original single-credential vault entries are decoded without rewriting them. */
export function nativeService(env: NodeJS.ProcessEnv, bus: Pick<Bus.Interface, "publish">): Credential.Interface {
  const prefix = "physicalsystems.v2."
  const key = (integrationID: string) => prefix + createHash("sha256").update(integrationID).digest("hex")
  const record = Schema.Struct({ ...Credential.Info.fields, value: CredentialLegacy.Value })
  const decode = Schema.decodeUnknownSync(
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal("physicalsystems-v2-credential"), record }),
      Schema.Struct({ kind: Schema.Literal("physicalsystems-v2-credentials"), records: Schema.Array(record) }),
    ]),
  )
  // Match V1 Auth.Info and the upstream legacy credential migration without
  // exporting decrypted secrets into auth.json or the SQL credential table.
  const legacy = Schema.decodeUnknownOption(
    Schema.Union([
      Schema.Struct({
        type: Schema.Literal("api"),
        key: Schema.String,
        metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
      }),
      Schema.Struct({ type: Schema.Literal("wellknown"), key: Schema.String, token: Schema.String }),
      Schema.Struct({
        type: Schema.Literal("oauth"),
        access: Schema.String,
        refresh: Schema.String,
        expires: NonNegativeInt,
        accountId: Schema.optional(Schema.String),
        enterpriseUrl: Schema.optional(Schema.String),
      }),
    ]),
  )
  const lock = Semaphore.makeUnsafe(1)
  const serialize = <A>(operation: () => Promise<A>) =>
    lock.withPermit(
      Effect.promise(() =>
        operation().catch(() => {
          throw new Error("NATIVE_CREDENTIAL_STORE_UNAVAILABLE")
        }),
      ).pipe(Effect.uninterruptible),
    )
  const all = async () => {
    const values = await nativeCredentialRequest("all", {}, env)
    const current = Object.entries(values)
      .filter(([name]) => name.startsWith(prefix))
      .flatMap(([name, value]) => {
        const stored = decode(value)
        const records = stored.kind === "physicalsystems-v2-credential" ? [stored.record] : stored.records
        if (
          records.some((record) => key(record.integrationID) !== name) ||
          new Set(records.map((record) => record.id)).size !== records.length
        )
          throw new Error("NATIVE_CREDENTIAL_STORE_UNAVAILABLE")
        return records.map((record) => new Credential.Info(record))
      })
    const imported = Object.entries(values)
      .filter(([name]) => !name.startsWith(prefix))
      .flatMap(([name, value]) => {
        const integrationID = Integration.ID.make(name.replace(/\/+$/, ""))
        // Even an empty V2 collection is authoritative: retaining it after removal
        // prevents the preserved V1 record from returning on the next restart.
        if (!integrationID || Object.hasOwn(values, key(integrationID))) return []
        const decoded = legacy(value)
        if (Option.isNone(decoded)) return []
        const info = decoded.value
        const credential =
          info.type === "oauth"
            ? Credential.OAuth.make({
                type: "oauth",
                access: info.access,
                refresh: info.refresh,
                expires: info.expires,
                methodID: Integration.MethodID.make(
                  integrationID === "openai"
                    ? "chatgpt-browser"
                    : ["github-copilot", "opencode", "xai"].includes(integrationID)
                      ? "device"
                      : "oauth",
                ),
                metadata:
                  info.accountId || info.enterpriseUrl
                    ? {
                        ...(info.accountId ? { accountID: info.accountId } : {}),
                        ...(info.enterpriseUrl ? { enterpriseUrl: info.enterpriseUrl } : {}),
                      }
                    : undefined,
              })
            : Credential.Key.make({
                type: "key",
                key: info.type === "api" ? info.key : info.token,
                ...(info.type === "api" ? { metadata: info.metadata } : {}),
              })
        return [
          new Credential.Info({
            id: Credential.ID.make(
              "cred_" +
                createHash("sha256")
                  .update("physicalsystems-v1:" + integrationID)
                  .digest("hex")
                  .slice(0, 32),
            ),
            integrationID,
            label: credential.type === "oauth" ? "OAuth" : "API key",
            value: credential,
          }),
        ]
      })
    const records = [...current, ...imported]
    if (new Set(records.map((record) => record.id)).size !== records.length)
      throw new Error("NATIVE_CREDENTIAL_STORE_UNAVAILABLE")
    return records
  }
  const save = async (integrationID: string, records: Credential.Info[]) => {
    await nativeCredentialRequest(
      "set",
      {
        key: key(integrationID),
        info: { kind: "physicalsystems-v2-credentials", records },
      },
      env,
    )
  }
  const changed = (integrationID?: Credential.Info["integrationID"], credentialID?: Credential.ID | null) =>
    bus
      .publish(Credential.Event.Updated, {}, { global: true })
      .pipe(
        Effect.andThen(
          integrationID === undefined
            ? Effect.void
            : bus.publish(
                Credential.Event.Switched,
                { integrationID, credentialID: credentialID ?? null },
                { global: true },
              ),
        ),
      )
  return Credential.Service.of({
    all: () => serialize(all),
    list: (integrationID) =>
      serialize(async () => (await all()).filter((item) => item.integrationID === integrationID)),
    get: (id) => serialize(async () => (await all()).find((item) => item.id === id)),
    create: (input) =>
      serialize(async () => {
        const existing = await all()
        const records = existing.filter((item) => item.integrationID === input.integrationID)
        const next = new Credential.Info({
          id: input.id ?? Credential.ID.create(),
          integrationID: input.integrationID,
          label: input.label ?? "default",
          value: input.value,
        })
        if (existing.some((item) => item.id === next.id)) throw new Error("DUPLICATE_CREDENTIAL")
        const active = input.activate !== false || records.length === 0
        await save(input.integrationID, active ? [...records, next] : [next, ...records])
        return { next, active }
      }).pipe(
        Effect.tap(({ next, active }) => changed(active ? next.integrationID : undefined, next.id)),
        Effect.map(({ next }) => next),
      ),
    activate: (id) =>
      serialize(async () => {
        const records = await all()
        const selected = records.find((item) => item.id === id)
        if (!selected) return
        const group = records.filter((item) => item.integrationID === selected.integrationID)
        if (group.at(-1)?.id === id) return
        await save(selected.integrationID, [...group.filter((item) => item.id !== id), selected])
        return selected
      }).pipe(Effect.flatMap((selected) => (selected ? changed(selected.integrationID, selected.id) : Effect.void))),
    update: (id, updates) =>
      serialize(async () => {
        const records = await all()
        const selected = records.find((item) => item.id === id)
        if (!selected) return false
        await save(
          selected.integrationID,
          records
            .filter((item) => item.integrationID === selected.integrationID)
            .map((item) => (item.id === id ? new Credential.Info({ ...item, ...updates }) : item)),
        )
        return true
      }).pipe(Effect.flatMap((saved) => (saved ? changed() : Effect.void))),
    remove: (id) =>
      serialize(async () => {
        const records = await all()
        const selected = records.find((item) => item.id === id)
        if (!selected) return
        const group = records.filter((item) => item.integrationID === selected.integrationID)
        const next = group.filter((item) => item.id !== id)
        await save(selected.integrationID, next)
        return {
          integrationID: group.at(-1)?.id === id ? selected.integrationID : undefined,
          id: next.at(-1)?.id ?? null,
        }
      }).pipe(Effect.flatMap((removed) => (removed ? changed(removed.integrationID, removed.id) : Effect.void))),
  })
}
