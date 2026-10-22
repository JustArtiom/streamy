import type { DatabaseSync } from "node:sqlite";
import { LibraryError } from "./types";

// The database's layout, version by version. `PRAGMA user_version` (a number
// stored in the file's header) says which version a file is at; opening it
// runs the missing steps in order, all in one transaction with the version
// bump, so a file is either fully upgraded or not touched at all.
//
// Adding version 2 later:
//   1. Append a step. Never edit a step that has shipped: people's files
//      already went through it.
//        {
//          version: 2,
//          up: (db) => {
//            db.exec("ALTER TABLE progress ADD COLUMN speed REAL");
//          },
//        },
//   2. Update the queries in ./sqlite-library.ts, and add a test that opens
//      a version-1 file (see migrations.test.ts).
// Foreign keys are off while steps run, so a step may rebuild a table the way
// https://sqlite.org/lang_altertable.html#otheralter describes; they're
// checked before the commit. An older Streamy refuses a file whose version it
// doesn't know (code "newer_version") rather than misreading it.

export interface Migration {
  /** The version the database is at once this step has run. */
  version: number;
  up(db: DatabaseSync): void;
}

// STRICT makes SQLite reject a value of the wrong type (e.g. text in
// `position`) instead of storing it. Times are milliseconds since 1970.
// No extra indexes: the tables stay small (hundreds of rows), and the
// progress primary key starts with info_hash, which is what the
// ON DELETE CASCADE lookup needs.
const V1 = `
  CREATE TABLE torrents (
    info_hash      TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    magnet         TEXT,
    metadata       BLOB,
    total_size     INTEGER,
    added_at       INTEGER NOT NULL,
    last_opened_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE progress (
    info_hash   TEXT NOT NULL REFERENCES torrents ON DELETE CASCADE,
    file_index  INTEGER NOT NULL,
    file_name   TEXT NOT NULL,
    position    REAL NOT NULL,
    duration    REAL,
    audio_track INTEGER,
    subtitle    TEXT,
    watched     INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (info_hash, file_index)
  ) STRICT;
`;

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(V1);
    },
  },
];

/** The version this Streamy writes. */
export const LATEST_VERSION = MIGRATIONS.length;

export function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get();
  const version = row?.user_version;
  if (typeof version !== "number") {
    throw new Error("PRAGMA user_version returned no number");
  }
  return version;
}

export function newerVersionError(
  fileVersion: number,
  knownVersion: number,
): LibraryError {
  return new LibraryError(
    "newer_version",
    `library.db was made by a newer Streamy (version ${fileVersion}; this one knows up to ${knownVersion}). It was left untouched.`,
  );
}

/**
 * Brings the database up to the last version in `migrations`. Throws (and
 * changes nothing) if a step fails or the file is from a newer Streamy.
 */
export function migrate(
  db: DatabaseSync,
  migrations: readonly Migration[] = MIGRATIONS,
): { from: number; to: number } {
  const latest = migrations.length;
  // Can only be changed outside a transaction.
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    // IMMEDIATE takes the write lock first, so two processes can't both
    // run the same steps.
    db.exec("BEGIN IMMEDIATE");
    try {
      const from = readUserVersion(db);
      if (from > latest) throw newerVersionError(from, latest);
      for (const step of migrations.slice(from)) step.up(db);
      assertForeignKeysHold(db);
      // Written even when nothing changed: a read-only file fails here, at
      // open, instead of on the first save.
      db.exec(`PRAGMA user_version = ${latest}`);
      db.exec("COMMIT");
      return { from, to: latest };
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function assertForeignKeysHold(db: DatabaseSync): void {
  const broken = db.prepare("PRAGMA foreign_key_check").all();
  if (broken.length > 0) {
    throw new Error(
      `A library migration left ${broken.length} rows pointing at missing rows`,
    );
  }
}
