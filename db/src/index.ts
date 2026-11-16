import { readFileSync, statfsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  type BetterSQLite3Database,
  drizzle,
} from "drizzle-orm/better-sqlite3";
import { migrate as drizzleMigrate } from "drizzle-orm/better-sqlite3/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import * as schema from "./schema.js";

export * from "./schema.js";

export type Db = BetterSQLite3Database<typeof schema> & {
  $client: Database.Database;
};

/** The size a WAL is cut back to once a checkpoint has emptied it; 64 MB on a 1 GB volume. */
export const JOURNAL_SIZE_LIMIT = 64 * 1024 * 1024;

/**
 * Free space a migration needs beyond its estimate: headroom for estimation error and filesystem overhead.
 * The WAL is in the estimate, and index sorts spill to the temp directory, not the volume.
 */
export const MIGRATION_MARGIN_BYTES = 64 * 1024 * 1024;

/** Opens the one writer connection; drizzle sets no pragmas, so they go on the raw handle here. */
export function openDb(path: string): Db {
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("synchronous = NORMAL");
  // after a checkpoint, a WAL grown past this is truncated back to it rather than kept at its high-water mark
  sqlite.pragma(`journal_size_limit = ${JOURNAL_SIZE_LIMIT}`);
  return drizzle(sqlite, { schema });
}

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

type Migration = { tag: string; folderMillis: number; sql: string[] };

function readMigrations(): Migration[] {
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8"),
  ) as { entries: { tag: string; when: number }[] };
  const tags = new Map(journal.entries.map((e) => [e.when, e.tag]));
  return readMigrationFiles({ migrationsFolder }).map((m) => ({
    tag: tags.get(m.folderMillis) ?? String(m.folderMillis),
    folderMillis: m.folderMillis,
    sql: m.sql,
  }));
}

function isTracked(sqlite: Database.Database): boolean {
  const table = sqlite
    .prepare(
      "select 1 from sqlite_schema where type = 'table' and name = '__drizzle_migrations'",
    )
    .get();
  return table !== undefined;
}

// null when the file has recorded no migration, so every migration is pending
function lastMigratedAt(sqlite: Database.Database): number | null {
  const last = sqlite
    .prepare("select max(created_at) as at from __drizzle_migrations")
    .get() as { at: number | null };
  return last.at === null ? null : Number(last.at);
}

// drizzle applies only migrations newer than the file's last recorded one, so a file a newer
// build migrated looks up to date to older code; stop rather than query a schema it doesn't know
function refuseNewerFile(last: number | null, migrations: Migration[]): void {
  const known = Math.max(...migrations.map((m) => m.folderMillis));
  if (last !== null && last > known) {
    throw new Error(
      "database was migrated by a newer version of sky; refusing to open it with this one",
    );
  }
}

export type MigrateOptions = {
  /** Bytes free on the filesystem holding the DB file; the volume's own reading unless a test injects one. */
  freeBytes?: (dbPath: string) => number;
};

const volumeFreeBytes = (dbPath: string): number => {
  const fs = statfsSync(dirname(dbPath));
  return fs.bavail * fs.bsize;
};

// drizzle-kit's table rebuild copies `<name>` into this table, then drops the old one
const REBUILD = /CREATE TABLE `__new_([^`]+)`/g;

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

// a rebuild copies a table's live pages and its indexes into new ones: the WAL holds all of them until a
// checkpoint, and the file grows by whatever its free pages can't absorb. drizzle runs every pending file
// in one transaction, so a table rebuilt twice is in the WAL twice. A migration that rebuilds nothing
// needs only the margin
function refuseIfNoRoom(
  sqlite: Database.Database,
  pending: Migration[],
  freeBytes: (dbPath: string) => number,
): void {
  const tableBytes = sqlite
    .prepare(
      "select coalesce(sum(pgsize), 0) from dbstat where name in (select name from sqlite_schema where tbl_name = ?)",
    )
    .pluck();
  let rebuilt = 0;
  for (const migration of pending) {
    for (const statement of migration.sql) {
      for (const [, table] of statement.matchAll(REBUILD)) {
        rebuilt += Number(tableBytes.get(table));
      }
    }
  }
  const pragma = (name: string) =>
    Number(sqlite.pragma(name, { simple: true }));
  const reusable = pragma("freelist_count") * pragma("page_size");
  const growth = Math.max(0, rebuilt - reusable);
  const needed = rebuilt + growth + MIGRATION_MARGIN_BYTES;
  const free = freeBytes(sqlite.name);
  if (free < needed) {
    throw new Error(
      `not enough free disk space to migrate ${sqlite.name}: applying ${pending.map((m) => m.tag).join(", ")} needs ${mb(needed)} (${mb(rebuilt)} of rebuilt tables in the WAL, ${mb(growth)} of file growth, ${mb(MIGRATION_MARGIN_BYTES)} margin) but ${mb(free)} is free; free space on the volume or extend it with fly volumes extend`,
    );
  }
}

/**
 * Applies pending migrations and returns their journal tags in order, `[]` when none were pending; call
 * once at boot, before serving. Refuses first, changing no data, when the DB's filesystem can't hold
 * the tables the pending migrations rebuild, rather than let SQLite fill the disk and roll back minutes later.
 */
export function migrate(
  db: Db,
  { freeBytes = volumeFreeBytes }: MigrateOptions = {},
): string[] {
  const sqlite = db.$client;
  const migrations = readMigrations();
  const tracked = isTracked(sqlite);
  const last = tracked ? lastMigratedAt(sqlite) : null;
  refuseNewerFile(last, migrations);
  // drizzle's own test for what it will apply
  const pending = migrations.filter(
    (m) => last === null || m.folderMillis > last,
  );
  // a new file has nothing to copy
  if (tracked && pending.length > 0) {
    // a WAL left by an unclean stop holds bytes the migration's WAL would reuse; hand them back first
    sqlite.pragma("wal_checkpoint(TRUNCATE)");
    refuseIfNoRoom(sqlite, pending, freeBytes);
  }
  // drizzle runs each file inside BEGIN, where `foreign_keys` is a no-op, so a generated
  // table rebuild's DROP TABLE would cascade into child rows; switch FKs off around it instead
  sqlite.pragma("foreign_keys = OFF");
  try {
    drizzleMigrate(db, { migrationsFolder });
    const violations = sqlite.pragma("foreign_key_check");
    if (Array.isArray(violations) && violations.length > 0) {
      throw new Error(
        `migration left foreign key violations: ${JSON.stringify(violations)}`,
      );
    }
  } finally {
    sqlite.pragma("foreign_keys = ON");
  }
  return pending.map((m) => m.tag);
}
