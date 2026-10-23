import { Effect, FileSystem, Option, Path, Schema } from "effect"
import type { Database } from "./database"
import { state } from "./schema"
import { sql } from "drizzle-orm"

const DRAFT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

const DRAFT_KEEP_RECENT = 100
const PHYSICAL_IMPORT_MARKER = "physicalsystems.legacy-renderer-store:"

const Entries = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))

const decode = Schema.decodeUnknownOption(Entries)

type Candidate = { name: string; path: string; modified: number; entries: Record<string, unknown> }

// Before the state table existed, every namespace the renderer persisted was an electron-store
// JSON file in userData. Copy them into SQLite once; Physical Systems retains
// the originals for rollback, while generic OpenCode removes imported files.
// This runs before the first renderer request.
export const importLegacyStores = Effect.fn("DesktopStorage.importLegacyStores")(function* (
  db: Database,
  userData: string,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const preserve = process.env.PHYSICALSYSTEMS_DESKTOP === "1"
  const imported = preserve
    ? new Set(db.all<{ id: string }>(sql`SELECT id FROM migration`).map((row) => row.id))
    : new Set<string>()
  const names = (yield* fs.readDirectory(userData).pipe(Effect.orElseSucceed(() => []))).filter(
    (name) => isStoreFile(name) && !imported.has(PHYSICAL_IMPORT_MARKER + name),
  )

  const files = yield* Effect.forEach(
    names,
    Effect.fnUntraced(function* (name) {
      const file = path.join(userData, name)
      const stats = yield* fs.stat(file).pipe(Effect.orElseSucceed(() => undefined))

      if (stats?.type !== "File") return
      const raw = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => undefined))

      if (raw === undefined) return
      const entries = decode(raw)

      if (Option.isNone(entries)) {
        yield* Effect.logWarning("legacy store is not readable, leaving it in place", { name })

        return
      }

      return {
        name,
        path: file,
        modified: Option.getOrElse(stats.mtime, () => new Date(0)).getTime(),
        entries: entries.value,
      } satisfies Candidate
    }),
    { concurrency: 5 },
  )

  const candidates = files.filter((file) => !!file)

  const kept = new Set(
    candidates
      .filter((file) => isDraft(file.name) && Object.keys(file.entries).length > 0)
      .filter((file) => Date.now() - file.modified <= DRAFT_RETENTION_MS)
      .sort((a, b) => b.modified - a.modified)
      .slice(0, DRAFT_KEEP_RECENT)
      .map((file) => file.name),
  )

  const rows = candidates
    .filter((file) => preserve || !isDraft(file.name) || kept.has(file.name))
    .flatMap((file) =>
      Object.entries(file.entries).map(([key, value]) => ({
        name: file.name,
        key,
        value: typeof value === "string" ? value : JSON.stringify(value),
        updated_at: file.modified,
      })),
    )

  // Existing rows win: a file left behind by an interrupted import must not overwrite newer state.
  if (rows.length > 0 || (preserve && candidates.length > 0)) {
    db.transaction((tx) => {
      rows.forEach((row) => tx.insert(state).values(row).onConflictDoNothing().run())
      // Preserve original bytes for rollback, but never resurrect deleted V2
      // state on restart. Per-file markers also let unreadable sources retry.
      if (preserve) {
        for (const file of candidates)
          tx.run(
            sql`INSERT INTO migration (id, time_completed) VALUES (${PHYSICAL_IMPORT_MARKER + file.name}, ${Date.now()})`,
          )
      }
    })
  }

  const removed = preserve ? [] : candidates
  yield* Effect.forEach(removed, (file) => fs.remove(file.path, { force: true }), {
    concurrency: "unbounded",
    discard: true,
  })

  return { imported: rows.length, removed: removed.map((file) => file.name) }
})

function isStoreFile(name: string) {
  return name === "default.dat" || /^opencode\..+\.dat$/.test(name)
}

function isDraft(name: string) {
  return name.startsWith("opencode.draft.")
}
