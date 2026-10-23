// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto"
import { Effect, Schema, Semaphore } from "effect"
import { CredentialLegacy } from "@opencode/schema/credential-legacy"
import { Credential } from "../credential.js"
import type { Bus } from "../bus.js"
import { nativeCredentialRequest } from "./native.js"

/** One atomically encrypted record per provider retains ordering and activation.
 * The original single-credential vault entries are decoded without rewriting them. */
export function nativeService(env: NodeJS.ProcessEnv, bus: Pick<Bus.Interface, "publish">): Credential.Interface {
  const prefix = "physicalsystems.v2."
  const key = (integrationID: string) => prefix + createHash("sha256").update(integrationID).digest("hex")
  const record = Schema.Struct({ ...Credential.Info.fields, value: CredentialLegacy.Value })
  const decode = Schema.decodeUnknownSync(Schema.Union([
    Schema.Struct({ kind: Schema.Literal("physicalsystems-v2-credential"), record }),
    Schema.Struct({ kind: Schema.Literal("physicalsystems-v2-credentials"), records: Schema.Array(record) }),
  ]))
  const lock = Semaphore.makeUnsafe(1)
  const serialize = <A>(operation: () => Promise<A>) => lock.withPermit(
    Effect.promise(() => operation().catch(() => { throw new Error("NATIVE_CREDENTIAL_STORE_UNAVAILABLE") })).pipe(Effect.uninterruptible),
  )
  const all = async () => {
    const values = await nativeCredentialRequest("all", {}, env)
    return Object.entries(values).filter(([name]) => name.startsWith(prefix)).flatMap(([name, value]) => {
      const stored = decode(value)
      const records = stored.kind === "physicalsystems-v2-credential" ? [stored.record] : stored.records
      if (records.some((record) => key(record.integrationID) !== name) || new Set(records.map((record) => record.id)).size !== records.length)
        throw new Error("NATIVE_CREDENTIAL_STORE_UNAVAILABLE")
      return records.map((record) => new Credential.Info(record))
    })
  }
  const save = async (integrationID: string, records: Credential.Info[]) => {
    await nativeCredentialRequest(records.length ? "set" : "remove", {
      key: key(integrationID),
      ...(records.length ? { info: { kind: "physicalsystems-v2-credentials", records } } : {}),
    }, env)
  }
  const changed = (integrationID?: Credential.Info["integrationID"], credentialID?: Credential.ID | null) =>
    bus.publish(Credential.Event.Updated, {}, { global: true }).pipe(
      Effect.andThen(integrationID === undefined ? Effect.void : bus.publish(Credential.Event.Switched, { integrationID, credentialID: credentialID ?? null }, { global: true })),
    )
  return Credential.Service.of({
    all: () => serialize(all),
    list: (integrationID) => serialize(async () => (await all()).filter((item) => item.integrationID === integrationID)),
    get: (id) => serialize(async () => (await all()).find((item) => item.id === id)),
    create: (input) => serialize(async () => {
      const existing = await all()
      const records = existing.filter((item) => item.integrationID === input.integrationID)
      const next = new Credential.Info({ id: input.id ?? Credential.ID.create(), integrationID: input.integrationID, label: input.label ?? "default", value: input.value })
      if (existing.some((item) => item.id === next.id)) throw new Error("DUPLICATE_CREDENTIAL")
      const active = input.activate !== false || records.length === 0
      await save(input.integrationID, active ? [...records, next] : [next, ...records])
      return { next, active }
    }).pipe(Effect.tap(({ next, active }) => changed(active ? next.integrationID : undefined, next.id)), Effect.map(({ next }) => next)),
    activate: (id) => serialize(async () => {
      const records = await all()
      const selected = records.find((item) => item.id === id)
      if (!selected) return
      const group = records.filter((item) => item.integrationID === selected.integrationID)
      if (group.at(-1)?.id === id) return
      await save(selected.integrationID, [...group.filter((item) => item.id !== id), selected])
      return selected
    }).pipe(Effect.flatMap((selected) => selected ? changed(selected.integrationID, selected.id) : Effect.void)),
    update: (id, updates) => serialize(async () => {
      const records = await all()
      const selected = records.find((item) => item.id === id)
      if (!selected) return false
      await save(selected.integrationID, records.filter((item) => item.integrationID === selected.integrationID).map((item) => item.id === id ? new Credential.Info({ ...item, ...updates }) : item))
      return true
    }).pipe(Effect.flatMap((saved) => saved ? changed() : Effect.void)),
    remove: (id) => serialize(async () => {
      const records = await all()
      const selected = records.find((item) => item.id === id)
      if (!selected) return
      const group = records.filter((item) => item.integrationID === selected.integrationID)
      const next = group.filter((item) => item.id !== id)
      await save(selected.integrationID, next)
      return { integrationID: group.at(-1)?.id === id ? selected.integrationID : undefined, id: next.at(-1)?.id ?? null }
    }).pipe(Effect.flatMap((removed) => removed ? changed(removed.integrationID, removed.id) : Effect.void)),
  })
}
