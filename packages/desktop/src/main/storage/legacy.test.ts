import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { openDatabase } from "./database"
import { importLegacyStores } from "./legacy"

const now = new Date("2026-07-01T00:00:00.000Z")

const day = 24 * 60 * 60 * 1000

const roots: string[] = []

beforeEach(() => setSystemTime(now))

afterEach(() => {
  setSystemTime()

  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-legacy-store-"))
  roots.push(root)

  return root
}

function writeStore(root: string, name: string, value: string, modified = now) {
  writeFileSync(path.join(root, name), value)
  utimesSync(path.join(root, name), modified, modified)
}

const listing = (root: string) => readdirSync(root).sort()

const rows = (db: ReturnType<typeof openDatabase>["db"]) =>
  db.all<{ name: string; key: string; value: string }>(sql`SELECT name, key, value FROM state ORDER BY name, key`)

const run = (db: ReturnType<typeof openDatabase>["db"], root: string) =>
  Effect.runPromise(
    importLegacyStores(db, root).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
  )

describe("legacy store import", () => {
  test("copies every namespace into state and removes the files", async () => {
    const root = tempRoot()
    const database = openDatabase(":memory:")
    writeStore(root, "opencode.global.dat", JSON.stringify({ model: "m", layout: { sidebar: 1 } }))
    writeStore(root, "opencode.window.w1.dat", JSON.stringify({ tabs: "[]" }))
    writeStore(root, "default.dat", JSON.stringify({ "settings.v3": "{}" }))
    writeStore(root, "opencode.settings", JSON.stringify({ keep: true }))
    writeStore(root, "unrelated.txt", "x")

    const result = await run(database.db, root)

    expect(result.imported).toBe(4)
    expect(rows(database.db)).toEqual([
      { name: "default.dat", key: "settings.v3", value: "{}" },
      { name: "opencode.global.dat", key: "layout", value: '{"sidebar":1}' },
      { name: "opencode.global.dat", key: "model", value: "m" },
      { name: "opencode.window.w1.dat", key: "tabs", value: "[]" },
    ])
    expect(listing(root)).toEqual(["opencode.settings", "unrelated.txt"])
  })

  test("does not overwrite state that already exists", async () => {
    const root = tempRoot()
    const database = openDatabase(":memory:")
    database.db.run(sql`INSERT INTO state VALUES ('opencode.global.dat', 'model', 'new', 0)`)
    writeStore(root, "opencode.global.dat", JSON.stringify({ model: "old" }))

    await run(database.db, root)

    expect(rows(database.db)).toEqual([{ name: "opencode.global.dat", key: "model", value: "new" }])
    expect(listing(root)).toEqual([])
  })

  test("leaves unreadable files in place", async () => {
    const root = tempRoot()
    const database = openDatabase(":memory:")
    writeStore(root, "opencode.global.dat", "{not json")
    writeStore(root, "opencode.workspace.x.dat", JSON.stringify({ terminal: "{}" }))

    const result = await run(database.db, root)

    expect(result.imported).toBe(1)
    expect(listing(root)).toEqual(["opencode.global.dat"])
  })

  test("applies draft retention: skips empty, stale, and excess draft files", async () => {
    const root = tempRoot()
    const database = openDatabase(":memory:")
    writeStore(root, "opencode.draft.empty.dat", "{}")
    writeStore(
      root,
      "opencode.draft.stale.dat",
      JSON.stringify({ "draft:prompt": "old" }),
      new Date(now.getTime() - 31 * day),
    )
    Array.from({ length: 102 }).forEach((_, index) =>
      writeStore(
        root,
        `opencode.draft.${index}.dat`,
        JSON.stringify({ "draft:prompt": `${index}` }),
        new Date(now.getTime() - index * 1_000),
      ),
    )

    const result = await run(database.db, root)

    expect(result.imported).toBe(100)
    const names = rows(database.db).map((row) => row.name)
    expect(names).toContain("opencode.draft.0.dat")
    expect(names).toContain("opencode.draft.99.dat")
    expect(names).not.toContain("opencode.draft.100.dat")
    expect(names).not.toContain("opencode.draft.101.dat")
    expect(names).not.toContain("opencode.draft.stale.dat")
    expect(names).not.toContain("opencode.draft.empty.dat")
    expect(listing(root)).toEqual([])
  })
})

test("Physical Systems preserves all legacy drafts and source files without resurrecting changed or deleted state", async () => {
  const original = process.env.PHYSICALSYSTEMS_DESKTOP
  process.env.PHYSICALSYSTEMS_DESKTOP = "1"
  const root = tempRoot()
  const file = path.join(root, "drafts.sqlite")
  let database = openDatabase(file)
  try {
    const sources = new Map<string, string>([
      ["opencode.global.dat", JSON.stringify({ model: "old-model" })],
      ["opencode.draft.empty.dat", "{}"],
      ["opencode.draft.stale.dat", JSON.stringify({ "draft:prompt": "preserve this old draft" })],
      ...Array.from({ length: 102 }, (_, index): [string, string] => [
        `opencode.draft.${index}.dat`,
        JSON.stringify({ "draft:prompt": `draft ${index}` }),
      ]),
    ])
    for (const [name, value] of sources) writeStore(root, name, value, new Date(now.getTime() - 365 * day))
    expect(await run(database.db, root)).toEqual({ imported: 104, removed: [] })
    expect(rows(database.db)).toHaveLength(104)
    expect(rows(database.db).find((row) => row.name === "opencode.draft.101.dat")?.value).toBe("draft 101")
    expect(rows(database.db).find((row) => row.name === "opencode.draft.stale.dat")?.value).toBe(
      "preserve this old draft",
    )
    for (const [name, value] of sources) expect(readFileSync(path.join(root, name), "utf8")).toBe(value)

    database.db.run(sql`UPDATE state SET value = 'new-model' WHERE name = 'opencode.global.dat' AND key = 'model'`)
    database.db.run(sql`DELETE FROM state WHERE name IN ('opencode.draft.0.dat', 'opencode.draft.stale.dat')`)
    database.close()
    database = openDatabase(file)
    expect(await run(database.db, root)).toEqual({ imported: 0, removed: [] })
    expect(rows(database.db)).toHaveLength(102)
    expect(rows(database.db).find((row) => row.name === "opencode.global.dat")?.value).toBe("new-model")
    expect(
      rows(database.db).some((row) => row.name === "opencode.draft.0.dat" || row.name === "opencode.draft.stale.dat"),
    ).toBe(false)
    for (const [name, value] of sources) expect(readFileSync(path.join(root, name), "utf8")).toBe(value)
  } finally {
    database.close()
    if (original === undefined) delete process.env.PHYSICALSYSTEMS_DESKTOP
    else process.env.PHYSICALSYSTEMS_DESKTOP = original
  }
})

test("Physical Systems import markers commit with data and unreadable retained sources can retry", async () => {
  const original = process.env.PHYSICALSYSTEMS_DESKTOP
  process.env.PHYSICALSYSTEMS_DESKTOP = "1"
  const root = tempRoot()
  const database = openDatabase(":memory:")
  try {
    writeStore(root, "opencode.global.dat", JSON.stringify({ model: "preserve" }))
    writeStore(root, "opencode.draft.retry.dat", "{invalid")
    database.db.run(
      sql`CREATE TRIGGER fail_legacy_import BEFORE INSERT ON state BEGIN SELECT RAISE(ABORT, 'INERT_IMPORT_FAILED'); END`,
    )
    await expect(run(database.db, root)).rejects.toThrow()
    expect(database.db.all(sql`SELECT id FROM migration WHERE id LIKE 'physicalsystems.%'`)).toEqual([])
    expect(rows(database.db)).toEqual([])
    database.db.run(sql`DROP TRIGGER fail_legacy_import`)
    expect(await run(database.db, root)).toEqual({ imported: 1, removed: [] })
    database.db.run(sql`DELETE FROM state`)
    writeStore(root, "opencode.draft.retry.dat", JSON.stringify({ prompt: "recovered" }))
    expect(await run(database.db, root)).toEqual({ imported: 1, removed: [] })
    expect(rows(database.db)).toEqual([{ name: "opencode.draft.retry.dat", key: "prompt", value: "recovered" }])
    expect(listing(root)).toEqual(["opencode.draft.retry.dat", "opencode.global.dat"])
  } finally {
    database.close()
    if (original === undefined) delete process.env.PHYSICALSYSTEMS_DESKTOP
    else process.env.PHYSICALSYSTEMS_DESKTOP = original
  }
})
