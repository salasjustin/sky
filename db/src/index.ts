import { statfsSync } from "node:fs";
import { dirname } from "node:path";
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

/** Free space a migration needs beyond the live data it may rewrite: its WAL and the SQLite temp files. */
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

// drizzle applies only migrations newer than the file's last recorded one, so a file a newer
// build migrated looks up to date to older code; stop rather than query a schema it doesn't know
function refuseNewerFile(sqlite: Database.Database): void {
  const tracked = sqlite
    .prepare(
      "select 1 from sqlite_schema where type = 'table' and name = '__drizzle_migrations'",
    )
    .get();
  if (!tracked) return;
  const last = sqlite
    .prepare("select max(created_at) as at from __drizzle_migrations")
    .get() as { at: number | null };
  const known = Math.max(
    ...readMigrationFiles({ migrationsFolder }).map((m) => m.folderMillis),
  );
  if (last.at !== null && Number(last.at) > known) {
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

// a rebuild copies a table's live rows into a new one: the WAL holds all of those pages until a checkpoint,
// and the file grows by whatever the free pages already in it can't absorb (the old table's pages are freed
// only once the copy is done). Dead pages need no copying
function refuseIfNoRoom(
  sqlite: Database.Database,
  freeBytes: (dbPath: string) => number,
): void {
  const tracked = sqlite
    .prepare(
      "select 1 from sqlite_schema where type = 'table' and name = '__drizzle_migrations'",
    )
    .get();
  if (!tracked) return; // a new file has nothing to copy
  const last = sqlite
    .prepare("select max(created_at) as at from __drizzle_migrations")
    .get() as { at: number | null };
  const pending = readMigrationFiles({ migrationsFolder }).some(
    (m) => last.at === null || m.folderMillis > Number(last.at),
  );
  if (!pending) return;
  const pragma = (name: string) =>
    Number(sqlite.pragma(name, { simple: true }));
  const pageSize = pragma("page_size");
  const live = (pragma("page_count") - pragma("freelist_count")) * pageSize;
  const reusable = pragma("freelist_count") * pageSize;
  const needed = live + Math.max(0, live - reusable) + MIGRATION_MARGIN_BYTES;
  const free = freeBytes(sqlite.name);
  if (free < needed) {
    throw new Error(
      `not enough free disk space to migrate ${sqlite.name}: needs ${needed} bytes (${live} of live data in the WAL, ${Math.max(0, live - reusable)} of file growth and a ${MIGRATION_MARGIN_BYTES} margin), only ${free} bytes free; free up space or grow the volume`,
    );
  }
}

/**
 * Applies pending migrations; call once at boot, before serving. Refuses first, touching nothing, when
 * the DB's filesystem can't hold a rewrite of its live data, rather than let SQLite fill
 * the disk and roll back minutes later.
 */
export function migrate(
  db: Db,
  { freeBytes = volumeFreeBytes }: MigrateOptions = {},
): void {
  const sqlite = db.$client;
  refuseNewerFile(sqlite);
  refuseIfNoRoom(sqlite, freeBytes);
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
}
