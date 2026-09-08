export * as Credential from "./credential"

import { asc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema, Semaphore } from "effect"
import { Credential } from "@opencode-ai/schema/credential"
import { Integration } from "@opencode-ai/schema/integration"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { CredentialTable } from "./credential/sql"
import { createHash } from "node:crypto"
import { nativeCredentialRequest, physicalCredentials } from "./credential/native"

export const ID = Credential.ID
export type ID = Credential.ID

export const OAuth = Credential.OAuth
export type OAuth = Credential.OAuth

export const Key = Credential.Key
export type Key = Credential.Key

export const Value = Credential.Value
export type Value = Credential.Value

export class Info extends Schema.Class<Info>("Credential.Info")({
  id: ID,
  integrationID: Integration.ID,
  label: Schema.String,
  value: Value,
}) {}

export interface Interface {
  /** Returns every stored credential. */
  readonly all: () => Effect.Effect<Info[]>
  /** Returns stored credentials belonging to one integration. */
  readonly list: (integrationID: Integration.ID) => Effect.Effect<Info[]>
  /** Returns one stored credential by ID. */
  readonly get: (id: ID) => Effect.Effect<Info | undefined>
  /** Replaces any credential for an integration and returns the new record. */
  readonly create: (input: {
    readonly integrationID: Integration.ID
    readonly value: Value
    readonly label?: string
  }) => Effect.Effect<Info>
  /** Updates the label or secret value of a stored credential. */
  readonly update: (id: ID, updates: Partial<Pick<Info, "label" | "value">>) => Effect.Effect<void>
  /** Removes a stored credential. */
  readonly remove: (id: ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Credential") {}

/** The supplied environment keeps the real desktop storage branch testable without
 * mutating process globals. Non-desktop callers retain the existing SQL backend. */
export const layerForEnvironment = (env: NodeJS.ProcessEnv) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      if (physicalCredentials(env)) return nativeService(env)
      const { db } = yield* Database.Service
      const decode = Schema.decodeUnknownSync(Value)
      const stored = (row: typeof CredentialTable.$inferSelect) => {
        if (!row.integration_id) return
        return new Info({
          id: row.id,
          integrationID: row.integration_id,
          label: row.label,
          value: decode(row.value),
        })
      }

      return Service.of({
        all: Effect.fn("Credential.all")(function* () {
          return (yield* db
            .select()
            .from(CredentialTable)
            .orderBy(asc(CredentialTable.time_created))
            .all()
            .pipe(Effect.orDie)).flatMap((row) => {
            const credential = stored(row)
            return credential ? [credential] : []
          })
        }),
        list: Effect.fn("Credential.list")(function* (integrationID) {
          return (yield* db
            .select()
            .from(CredentialTable)
            .where(eq(CredentialTable.integration_id, integrationID))
            .orderBy(asc(CredentialTable.time_created))
            .all()
            .pipe(Effect.orDie)).flatMap((row) => {
            const credential = stored(row)
            return credential ? [credential] : []
          })
        }),
        get: Effect.fn("Credential.get")(function* (id) {
          const row = yield* db
            .select()
            .from(CredentialTable)
            .where(eq(CredentialTable.id, id))
            .get()
            .pipe(Effect.orDie)
          return row ? stored(row) : undefined
        }),
        create: Effect.fn("Credential.create")(function* (input) {
          const credential = new Info({
            id: ID.create(),
            integrationID: input.integrationID,
            label: input.label ?? "default",
            value: input.value,
          })
          yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                yield* tx
                  .delete(CredentialTable)
                  .where(eq(CredentialTable.integration_id, credential.integrationID))
                  .run()
                yield* tx
                  .insert(CredentialTable)
                  .values({
                    id: credential.id,
                    integration_id: credential.integrationID,
                    label: credential.label,
                    value: credential.value,
                  })
                  .run()
              }),
            )
            .pipe(Effect.orDie)
          return credential
        }),
        update: Effect.fn("Credential.update")(function* (id, updates) {
          if (!updates.label && !updates.value) return
          yield* db
            .update(CredentialTable)
            .set({ label: updates.label, value: updates.value })
            .where(eq(CredentialTable.id, id))
            .run()
            .pipe(Effect.orDie)
        }),
        remove: Effect.fn("Credential.remove")(function* (id) {
          yield* db.delete(CredentialTable).where(eq(CredentialTable.id, id)).run().pipe(Effect.orDie)
        }),
      })
    }),
  )

function nativeService(env: NodeJS.ProcessEnv): Interface {
  const prefix = "physicalsystems.v2."
  const key = (integrationID: string) => prefix + createHash("sha256").update(integrationID).digest("hex")
  const decode = Schema.decodeUnknownSync(Info)
  // Waiting callers remain interruptible; once native IO begins, finish its
  // bounded outcome before releasing the lock. No canceled Promise stays queued.
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
    const records = await nativeCredentialRequest("all", {}, env)
    return Object.entries(records)
      .filter(([name]) => name.startsWith(prefix))
      .map(([name, value]) => {
        if (
          !value ||
          typeof value !== "object" ||
          !("kind" in value) ||
          value.kind !== "physicalsystems-v2-credential" ||
          !("record" in value)
        )
          throw new Error("NATIVE_CREDENTIAL_STORE_UNAVAILABLE")
        const record = decode(value.record)
        if (key(record.integrationID) !== name) throw new Error("NATIVE_CREDENTIAL_STORE_UNAVAILABLE")
        return record
      })
      .sort((a, b) => a.id.localeCompare(b.id))
  }
  const save = async (record: Info) => {
    await nativeCredentialRequest(
      "set",
      {
        key: key(record.integrationID),
        info: { kind: "physicalsystems-v2-credential", record },
      },
      env,
    )
  }
  return Service.of({
    all: () => serialize(all),
    list: (integrationID) =>
      serialize(async () => (await all()).filter((record) => record.integrationID === integrationID)),
    get: (id) => serialize(async () => (await all()).find((record) => record.id === id)),
    create: (input) =>
      serialize(async () => {
        const record = new Info({
          id: ID.create(),
          integrationID: input.integrationID,
          label: input.label ?? "default",
          value: input.value,
        })
        await save(record)
        return record
      }),
    update: (id, updates) =>
      serialize(async () => {
        if (!updates.label && !updates.value) return
        const record = (await all()).find((record) => record.id === id)
        if (!record) return
        await save(
          new Info({
            ...record,
            ...(updates.label === undefined ? {} : { label: updates.label }),
            ...(updates.value === undefined ? {} : { value: updates.value }),
          }),
        )
      }),
    remove: (id) =>
      serialize(async () => {
        const record = (await all()).find((record) => record.id === id)
        if (record) await nativeCredentialRequest("remove", { key: key(record.integrationID) }, env)
      }),
  })
}

const layer = layerForEnvironment(process.env)
export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
