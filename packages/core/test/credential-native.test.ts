// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { Effect, Exit, Fiber, Layer, Scope } from "effect"
import { Global } from "@opencode/util/global"
import { Bus } from "@opencode/core/bus"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { Credential } from "../src/credential"
import { Integration } from "../src/integration"
import { Database } from "../src/database/database"
import { CredentialTable } from "../src/credential/sql"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { createAgentGateway } from "../../physicalsystems/src/gateway"
import { createCredentialVault } from "../../physicalsystems/src/credentials"

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "v2-native-credential-test-"))
  const file = join(root, "provider-credentials.enc")
  // Deliberate reversible test cipher, never a native encryption claim. The
  // actual Core service, authenticated gateway and vault implementation run.
  const vault = createCredentialVault(file, {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "fixture",
    encryptString: (text) => Buffer.from(Buffer.from(text).map((byte) => byte ^ 91)),
    decryptString: (bytes) => Buffer.from(bytes.map((byte) => byte ^ 91)).toString(),
  })
  const control = { write: async () => {} }
  const gateway = await createAgentGateway({
    token: "inert-native-gateway-token-1234567890",
    tools: () => [],
    binding: () => undefined,
    invoke: async () => {
      throw new Error("NO_DEVICE_OPERATIONS")
    },
    auth: async (operation, input) => {
      if (operation === "set") await control.write()
      return vault.request(operation, input)
    },
  })
  const env = {
    PHYSICALSYSTEMS_DESKTOP: "1",
    PHYSICALSYSTEMS_AUTH_URL: `${gateway.url}/auth`,
    PHYSICALSYSTEMS_AGENT_TOKEN: "inert-native-gateway-token-1234567890",
  }
  const database = Database.layer({ path: join(root, "fixture.db") }).pipe(
    Layer.provide(LayerNode.compile(Global.node)),
  )
  const layer = (environment: NodeJS.ProcessEnv = env) =>
    AppNodeBuilder.build(LayerNode.group([Credential.node, Integration.node, Database.node]), [
      Credential.node.replace(
        Credential.layerForEnvironment(environment).pipe(
          Layer.provide(Layer.merge(database, LayerNode.compile(Bus.node))),
        ),
      ),
      Database.node.replace(database),
    ])
  const run = <A, E>(
    program: Effect.Effect<A, E, Credential.Service | Integration.Service | Database.Service | Scope.Scope>,
    environment: NodeJS.ProcessEnv = env,
  ) => Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(layer(environment))))
  return {
    root,
    file,
    vault,
    control,
    env,
    run,
    close: async () => {
      await gateway.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

test("actual V2 key/OAuth credentials use the native vault across service restarts, without SQL secrets or legacy changes", async () => {
  const f = await fixture()
  const key = "inert-v2-api-key-canary-1234567890"
  const access = "inert-v2-access-canary-1234567890"
  const integrationID = Integration.ID.make("fixture-provider")
  const methodID = Integration.MethodID.make("fixture-oauth")
  try {
    await f.vault.request("set", { key: "legacy-provider", info: { type: "api", key: "inert-legacy-preserved" } })
    const id = await f.run(
      Effect.gen(function* () {
        const integrations = yield* Integration.Service
        const credentials = yield* Credential.Service
        const { db } = yield* Database.Service
        yield* integrations.transform((editor) =>
          editor.method.update({ integrationID, method: { type: "key", label: "Fixture" } }),
        )
        yield* integrations.connection.key({ integrationID, key, label: "Work" })
        const created = (yield* credentials.list(integrationID))[0]!
        expect(created.value).toEqual({ type: "key", key })
        const projection = yield* integrations.get(integrationID)
        expect(JSON.stringify(projection)).not.toContain(key)
        expect(projection?.connections).toEqual([{ type: "credential", method: "key", id: created.id, label: "Work" }])
        expect(yield* db.select().from(CredentialTable).all().pipe(Effect.orDie)).toEqual([])
        return created.id
      }),
    )
    await f.run(
      Effect.gen(function* () {
        const integrations = yield* Integration.Service
        const credentials = yield* Credential.Service
        expect((yield* credentials.get(id))?.value).toEqual({ type: "key", key })
        expect(
          yield* integrations.connection.resolve({ type: "credential", method: "key", id, label: "Work" }),
        ).toEqual({
          type: "key",
          key,
        })
        yield* Effect.all(
          [
            credentials.update(id, { label: "Personal" }),
            credentials.update(id, { value: Credential.Key.make({ type: "key", key: key + "-updated" }) }),
          ],
          { concurrency: "unbounded" },
        )
        expect(yield* credentials.get(id)).toMatchObject({ label: "Personal", value: { key: key + "-updated" } })
        yield* integrations.transform((editor) =>
          editor.method.update({
            integrationID,
            method: { id: methodID, type: "oauth", label: "Inert OAuth" },
            authorize: () =>
              Effect.succeed({
                mode: "code" as const,
                url: "https://example.invalid/fixture",
                instructions: "Fixture only",
                callback: () =>
                  Effect.succeed(
                    Credential.OAuth.make({
                      type: "oauth",
                      methodID,
                      access,
                      refresh: "inert-refresh",
                      expires: 9000000000000,
                    }),
                  ),
              }),
          }),
        )
        const attempt = yield* integrations.oauth.connect({ integrationID, methodID })
        yield* integrations.oauth.complete({ integrationID, attemptID: attempt.attemptID, code: "inert-code" })
        expect((yield* integrations.oauth.status({ integrationID, attemptID: attempt.attemptID })).status).toBe(
          "complete",
        )
        expect(yield* credentials.get(id)).toBeDefined()
      }),
    )
    await f.run(
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        const integrations = yield* Integration.Service
        const records = yield* credentials.list(integrationID)
        expect(records).toHaveLength(2)
        expect(records[1]?.value).toMatchObject({ type: "oauth", access, refresh: "inert-refresh" })
        expect(
          yield* integrations.connection.resolve({
            type: "credential",
            method: "oauth",
            id: records[1]!.id,
            label: records[1]!.label,
          }),
        ).toMatchObject({ type: "oauth", access })
        yield* integrations.connection.remove(records[0]!.id)
        yield* integrations.connection.remove(records[1]!.id)
      }),
    )
    await f.run(
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        const { db } = yield* Database.Service
        expect((yield* credentials.all()).map((item) => item.integrationID)).toEqual([
          Integration.ID.make("legacy-provider"),
        ])
        expect(yield* db.select().from(CredentialTable).all().pipe(Effect.orDie)).toEqual([])
      }),
    )
    const stored = (await f.vault.request("all", {})) as Record<string, unknown>
    expect(stored["legacy-provider"]).toEqual({ type: "api", key: "inert-legacy-preserved" })
    expect(stored["physicalsystems.v2." + createHash("sha256").update(integrationID).digest("hex")]).toEqual({
      kind: "physicalsystems-v2-credentials",
      records: [],
    })
    for (const name of ["fixture.db", "provider-credentials.enc"]) {
      const bytes = await readFile(join(f.root, name))
      for (const canary of [key, access, "inert-refresh"]) expect(bytes.includes(Buffer.from(canary))).toBe(false)
    }
  } finally {
    await f.close()
  }
}, 30000)

test("V1 encrypted API and OAuth accounts remain usable without rewriting originals and removed imports cannot return", async () => {
  const f = await fixture()
  const api = { type: "api", key: "inert-v1-provider-key", metadata: { region: "inert-region" } }
  const oauth = {
    type: "oauth",
    access: "inert-v1-access",
    refresh: "inert-v1-refresh",
    expires: 9000000000000,
    accountId: "inert-account",
    enterpriseUrl: "https://example.invalid",
  }
  const keyProvider = Integration.ID.make("legacy-key-provider")
  const openai = Integration.ID.make("openai")
  try {
    await f.vault.request("set", { key: keyProvider, info: api })
    await f.vault.request("set", { key: openai, info: oauth })
    await f.vault.request("set", { key: "malformed-provider", info: { type: "oauth", access: "incomplete" } })
    const original = await readFile(f.file)
    f.control.write = async () => {
      throw Error("READ_MUST_NOT_REWRITE_LEGACY")
    }
    const ids = await f.run(
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        const integrations = yield* Integration.Service
        const { db } = yield* Database.Service
        const records = yield* credentials.all()
        expect(records).toHaveLength(2)
        const key = records.find((item) => item.integrationID === keyProvider)!
        const savedOAuth = records.find((item) => item.integrationID === openai)!
        expect(key.value).toEqual({ type: "key", key: api.key, metadata: api.metadata })
        expect(savedOAuth.value).toEqual({
          type: "oauth",
          access: oauth.access,
          refresh: oauth.refresh,
          expires: oauth.expires,
            methodID: Integration.MethodID.make("chatgpt-browser"),
          metadata: { accountID: oauth.accountId, enterpriseUrl: oauth.enterpriseUrl },
        })
        expect(
          yield* integrations.connection.resolve({ type: "credential", method: "key", id: key.id, label: key.label }),
        ).toEqual(key.value)
        expect(yield* db.select().from(CredentialTable).all().pipe(Effect.orDie)).toEqual([])
        return { key: key.id, oauth: savedOAuth.id }
      }),
    )
    expect(await readFile(f.file)).toEqual(original)
    f.control.write = async () => {}
    await f.run(
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        expect((yield* credentials.list(keyProvider))[0]?.id).toBe(ids.key)
        const next = yield* credentials.create({
          integrationID: keyProvider,
          value: Credential.Key.make({ type: "key", key: "inert-new-v2-key" }),
        })
        expect((yield* credentials.list(keyProvider)).map((item) => item.id)).toEqual([ids.key, next.id])
        yield* credentials.update(ids.oauth, {
          value: Credential.OAuth.make({
            type: "oauth",
            methodID: Integration.MethodID.make("chatgpt-browser"),
            access: "inert-v2-refreshed-access",
            refresh: "inert-v2-refreshed-refresh",
            expires: 9000000000001,
          }),
        })
        yield* credentials.remove(ids.key)
        yield* credentials.remove(next.id)
      }),
    )
    await f.run(
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        expect(yield* credentials.list(keyProvider)).toEqual([])
        expect((yield* credentials.get(ids.oauth))?.value).toMatchObject({ access: "inert-v2-refreshed-access" })
        yield* credentials.remove(ids.oauth)
      }),
    )
    await f.run(
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        expect(yield* credentials.all()).toEqual([])
      }),
    )
    const stored = (await f.vault.request("all", {})) as Record<string, unknown>
    expect(stored[keyProvider]).toEqual(api)
    expect(stored[openai]).toEqual(oauth)
    for (const integrationID of [keyProvider, openai])
      expect(stored["physicalsystems.v2." + createHash("sha256").update(integrationID).digest("hex")]).toEqual({
        kind: "physicalsystems-v2-credentials",
        records: [],
      })
    for (const name of ["fixture.db", "provider-credentials.enc"]) {
      const bytes = await readFile(join(f.root, name))
      for (const canary of [api.key, oauth.access, oauth.refresh, "inert-v2-refreshed-access"])
        expect(bytes.includes(Buffer.from(canary))).toBe(false)
    }
  } finally {
    await f.close()
  }
}, 30000)

test("failed native mutations leave the imported V1 account available across restarts without SQL fallback", async () => {
  const f = await fixture()
  const integrationID = Integration.ID.make("github-copilot")
  try {
    await f.vault.request("set", {
      key: integrationID,
      info: { type: "oauth", access: "inert-access", refresh: "inert-refresh", expires: 9000000000000 },
    })
    const original = await readFile(f.file)
    f.control.write = async () => {
      throw Error("INERT_NATIVE_WRITE_FAILURE")
    }
    const id = await f.run(
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        const current = (yield* credentials.list(integrationID))[0]!
        expect(current.value).toMatchObject({ type: "oauth", methodID: "device" })
        expect(Exit.isFailure(yield* credentials.remove(current.id).pipe(Effect.exit))).toBe(true)
        expect(Exit.isFailure(yield* credentials.update(current.id, { label: "Uncommitted" }).pipe(Effect.exit))).toBe(
          true,
        )
        return current.id
      }),
    )
    await f.run(
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        const { db } = yield* Database.Service
        expect(yield* credentials.get(id)).toMatchObject({ label: "OAuth", value: { access: "inert-access" } })
        expect(yield* db.select().from(CredentialTable).all().pipe(Effect.orDie)).toEqual([])
      }),
    )
    expect(await readFile(f.file)).toEqual(original)
  } finally {
    await f.close()
  }
}, 30000)

test("native V2 account activation survives restarts and upgrades the existing single-record format without losing accounts", async () => {
  const f = await fixture()
  const integrationID = Integration.ID.make("existing-native-provider")
  const oldID = Credential.ID.create()
  try {
    await f.vault.request("set", {
      key: "physicalsystems.v2." + createHash("sha256").update(integrationID).digest("hex"),
      info: {
        kind: "physicalsystems-v2-credential",
        record: {
          id: oldID,
          integrationID,
          label: "Original",
          value: { type: "key", key: "inert-original" },
        },
      },
    })
    const addedID = await f.run(
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        expect((yield* credentials.list(integrationID)).map((item) => item.id)).toEqual([oldID])
        const added = yield* credentials.create({
          integrationID,
          activate: false,
          label: "Second",
          value: Credential.Key.make({ type: "key", key: "inert-second" }),
        })
        expect((yield* credentials.list(integrationID)).map((item) => item.id)).toEqual([added.id, oldID])
        const duplicate = yield* credentials
          .create({
            id: oldID,
            integrationID: Integration.ID.make("other-provider"),
            value: Credential.Key.make({ type: "key", key: "inert-duplicate" }),
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(duplicate)).toBe(true)
        yield* credentials.activate(added.id)
        return added.id
      }),
    )
    await f.run(
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        expect((yield* credentials.list(integrationID)).map((item) => item.id)).toEqual([oldID, addedID])
        expect(yield* credentials.all()).toHaveLength(2)
        yield* credentials.remove(addedID)
      }),
    )
    await f.run(
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        expect((yield* credentials.list(integrationID)).map((item) => item.id)).toEqual([oldID])
        expect((yield* credentials.get(oldID))?.value).toEqual({ type: "key", key: "inert-original" })
      }),
    )
  } finally {
    await f.close()
  }
}, 30000)

test("desktop mode never falls back to SQL or imports/deletes existing SQL credentials when native storage fails", async () => {
  const f = await fixture()
  const integrationID = Integration.ID.make("existing-sql-provider")
  try {
    const existing = await f.run(
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        return yield* credentials.create({
          integrationID,
          value: Credential.Key.make({ type: "key", key: "untouched-existing-sql-fixture" }),
        })
      }),
      {},
    )
    await f.run(
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        const { db } = yield* Database.Service
        expect(Exit.isFailure(yield* credentials.all().pipe(Effect.exit))).toBe(true)
        expect(
          Exit.isFailure(
            yield* credentials
              .create({ integrationID, value: Credential.Key.make({ type: "key", key: "must-not-hit-sql" }) })
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        const rows = yield* db.select().from(CredentialTable).all().pipe(Effect.orDie)
        expect(rows).toHaveLength(1)
        expect(rows[0]?.id).toBe(existing.id)
        expect(rows[0]?.value).toEqual(existing.value)
      }),
      { PHYSICALSYSTEMS_DESKTOP: "1" },
    )
    await f.run(
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        expect(yield* credentials.all()).toEqual([])
      }),
    )
    expect((await readFile(join(f.root, "fixture.db"))).includes(Buffer.from("must-not-hit-sql"))).toBe(false)
  } finally {
    await f.close()
  }
}, 30000)

for (const mode of ["code", "auto"] as const)
  test(`actual ${mode} OAuth remains pending during a native write and becomes failed if persistence fails`, async () => {
    const f = await fixture()
    const requested = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    f.control.write = async () => {
      requested.resolve()
      await release.promise
      throw new Error("PRIVATE-STORAGE-FAILURE-CANARY")
    }
    try {
      await f.run(
        Effect.gen(function* () {
          const integrations = yield* Integration.Service
          const credentials = yield* Credential.Service
          const integrationID = Integration.ID.make("failed-storage-provider")
          const methodID = Integration.MethodID.make("inert-oauth")
          const callback = Effect.succeed(
            Credential.OAuth.make({
              type: "oauth",
              methodID,
              access: "inert-access",
              refresh: "inert-refresh",
              expires: 9000000000000,
            }),
          )
          yield* integrations.transform((editor) =>
            editor.method.update({
              integrationID,
              method: { id: methodID, type: "oauth", label: "Fixture" },
              authorize: () =>
                Effect.succeed(
                  mode === "auto"
                    ? { mode, url: "https://example.invalid/fixture", instructions: "Fixture", callback }
                    : {
                        mode,
                        url: "https://example.invalid/fixture",
                        instructions: "Fixture",
                        callback: () => callback,
                      },
                ),
            }),
          )
          const attempt = yield* integrations.oauth.connect({ integrationID, methodID })
          const completion =
            mode === "code"
              ? yield* integrations.oauth
                  .complete({ integrationID, attemptID: attempt.attemptID, code: "fixture-code" })
                  .pipe(Effect.exit, Effect.forkScoped)
              : undefined
          yield* Effect.promise(() => requested.promise)
          expect((yield* integrations.oauth.status({ integrationID, attemptID: attempt.attemptID })).status).toBe(
            "pending",
          )
          release.resolve()
          if (completion) expect(Exit.isFailure(yield* Fiber.join(completion))).toBe(true)
          for (
            let count = 0;
            (yield* integrations.oauth.status({ integrationID, attemptID: attempt.attemptID })).status === "pending" &&
            count < 100;
            count++
          )
            yield* Effect.sleep("5 millis")
          const status = yield* integrations.oauth.status({ integrationID, attemptID: attempt.attemptID })
          expect(status.status).toBe("failed")
          expect(
            Exit.isFailure(
              yield* integrations.oauth
                .complete({ integrationID, attemptID: attempt.attemptID, code: "retry" })
                .pipe(Effect.exit),
            ),
          ).toBe(true)
          expect(JSON.stringify(status)).not.toContain("PRIVATE-STORAGE-FAILURE-CANARY")
          expect(yield* credentials.all()).toEqual([])
        }),
      )
    } finally {
      release.resolve()
      await f.close()
    }
  }, 30000)

test("canceling a queued native mutation prevents its later write", async () => {
  const f = await fixture()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let writes = 0
  f.control.write = async () => {
    writes++
    if (writes === 1) {
      started.resolve()
      await release.promise
    }
  }
  try {
    await f.run(
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        const first = yield* credentials
          .create({
            integrationID: Integration.ID.make("first"),
            value: Credential.Key.make({ type: "key", key: "first-inert" }),
          })
          .pipe(Effect.forkScoped)
        yield* Effect.promise(() => started.promise)
        const second = yield* credentials
          .create({
            integrationID: Integration.ID.make("canceled"),
            value: Credential.Key.make({ type: "key", key: "canceled-inert" }),
          })
          .pipe(Effect.forkScoped)
        yield* Effect.yieldNow
        yield* Fiber.interrupt(second)
        release.resolve()
        yield* Fiber.join(first)
        expect((yield* credentials.all()).map((record) => record.integrationID)).toEqual([Integration.ID.make("first")])
        expect(writes).toBe(1)
      }),
    )
  } finally {
    release.resolve()
    await f.close()
  }
}, 30000)

test("interrupting OAuth completion during a native commit cannot expose canceled state before a late credential write", async () => {
  const f = await fixture()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  f.control.write = async () => {
    started.resolve()
    await release.promise
  }
  try {
    await f.run(
      Effect.gen(function* () {
        const integrations = yield* Integration.Service
        const credentials = yield* Credential.Service
        const integrationID = Integration.ID.make("interrupt-commit")
        const methodID = Integration.MethodID.make("inert-code")
        yield* integrations.transform((editor) =>
          editor.method.update({
            integrationID,
            method: { id: methodID, type: "oauth", label: "Fixture" },
            authorize: () =>
              Effect.succeed({
                mode: "code" as const,
                url: "https://example.invalid",
                instructions: "Fixture",
                callback: () =>
                  Effect.succeed(
                    Credential.OAuth.make({
                      type: "oauth",
                      methodID,
                      access: "inert-access",
                      refresh: "inert-refresh",
                      expires: 9000000000000,
                    }),
                  ),
              }),
          }),
        )
        const attempt = yield* integrations.oauth.connect({ integrationID, methodID })
        const completion = yield* integrations.oauth
          .complete({ integrationID, attemptID: attempt.attemptID, code: "inert" })
          .pipe(Effect.forkScoped)
        yield* Effect.promise(() => started.promise)
        const interrupt = yield* Fiber.interrupt(completion).pipe(Effect.forkScoped)
        const cancel = yield* integrations.oauth
          .cancel({ integrationID, attemptID: attempt.attemptID })
          .pipe(Effect.forkScoped)
        yield* Effect.sleep("10 millis")
        expect((yield* integrations.oauth.status({ integrationID, attemptID: attempt.attemptID })).status).toBe(
          "pending",
        )
        release.resolve()
        yield* Fiber.join(interrupt)
        yield* Fiber.join(cancel)
        expect((yield* integrations.oauth.status({ integrationID, attemptID: attempt.attemptID })).status).toBe(
          "complete",
        )
        expect(yield* credentials.list(integrationID)).toHaveLength(1)
      }),
    )
  } finally {
    release.resolve()
    await f.close()
  }
}, 30000)

test("OAuth canceled before its callback resolves cannot write or report a successful late completion", async () => {
  const f = await fixture()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  try {
    await f.run(
      Effect.gen(function* () {
        const integrations = yield* Integration.Service
        const credentials = yield* Credential.Service
        const integrationID = Integration.ID.make("canceled-before-commit")
        const methodID = Integration.MethodID.make("inert-code")
        yield* integrations.transform((editor) =>
          editor.method.update({
            integrationID,
            method: { id: methodID, type: "oauth", label: "Fixture" },
            authorize: () =>
              Effect.succeed({
                mode: "code" as const,
                url: "https://example.invalid",
                instructions: "Fixture",
                callback: () =>
                  Effect.promise(async () => {
                    started.resolve()
                    await release.promise
                    return Credential.OAuth.make({
                      type: "oauth",
                      methodID,
                      access: "inert-access",
                      refresh: "inert-refresh",
                      expires: 9000000000000,
                    })
                  }),
              }),
          }),
        )
        const attempt = yield* integrations.oauth.connect({ integrationID, methodID })
        const completion = yield* integrations.oauth
          .complete({ integrationID, attemptID: attempt.attemptID, code: "inert" })
          .pipe(Effect.exit, Effect.forkScoped)
        yield* Effect.promise(() => started.promise)
        yield* integrations.oauth.cancel({ integrationID, attemptID: attempt.attemptID })
        release.resolve()
        expect(Exit.isFailure(yield* Fiber.join(completion))).toBe(true)
        expect(yield* credentials.list(integrationID)).toEqual([])
      }),
    )
  } finally {
    release.resolve()
    await f.close()
  }
}, 30000)
