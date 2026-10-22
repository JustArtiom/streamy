import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LATEST_VERSION,
  type Migration,
  MIGRATIONS,
  migrate,
  readUserVersion,
} from "./migrations";
import { LibraryError } from "./types";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
});

afterEach(() => {
  db.close();
});

const tables = () =>
  db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
    )
    .all()
    .map((row) => row.name);

const columns = (table: string) =>
  db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => [row.name, row.type, row.notnull, row.pk]);

const foreignKeysOn = () =>
  db.prepare("PRAGMA foreign_keys").get()?.foreign_keys === 1;

/** A step that fails, to check that nothing it did is kept. */
const failing = (version: number): Migration => ({
  version,
  up: (target) => {
    target.exec("CREATE TABLE half_done (x INTEGER)");
    throw new Error("step failed");
  },
});

describe("MIGRATIONS", () => {
  it("numbers its steps 1, 2, 3… in order", () => {
    expect(MIGRATIONS.map((step) => step.version)).toEqual(
      MIGRATIONS.map((_, index) => index + 1),
    );
    expect(LATEST_VERSION).toBe(MIGRATIONS.length);
  });
});

describe("migrate", () => {
  it("creates the tables of PLAN §4.6 in an empty database", () => {
    expect(migrate(db)).toEqual({ from: 0, to: LATEST_VERSION });

    expect(readUserVersion(db)).toBe(LATEST_VERSION);
    expect(tables()).toEqual(["progress", "torrents"]);
    // [name, type, NOT NULL, position in the primary key]
    expect(columns("torrents")).toEqual([
      ["info_hash", "TEXT", 1, 1],
      ["name", "TEXT", 1, 0],
      ["magnet", "TEXT", 0, 0],
      ["metadata", "BLOB", 0, 0],
      ["total_size", "INTEGER", 0, 0],
      ["added_at", "INTEGER", 1, 0],
      ["last_opened_at", "INTEGER", 1, 0],
    ]);
    expect(columns("progress")).toEqual([
      ["info_hash", "TEXT", 1, 1],
      ["file_index", "INTEGER", 1, 2],
      ["file_name", "TEXT", 1, 0],
      ["position", "REAL", 1, 0],
      ["duration", "REAL", 0, 0],
      ["audio_track", "INTEGER", 0, 0],
      ["subtitle", "TEXT", 0, 0],
      ["watched", "INTEGER", 1, 0],
      ["updated_at", "INTEGER", 1, 0],
    ]);
    const cascade = db.prepare("PRAGMA foreign_key_list(progress)").get();
    expect(cascade).toMatchObject({ table: "torrents", on_delete: "CASCADE" });
  });

  it("does nothing the second time", () => {
    migrate(db);

    expect(migrate(db)).toEqual({ from: LATEST_VERSION, to: LATEST_VERSION });
  });

  it("upgrades an older file step by step, keeping its rows", () => {
    migrate(db);
    db.exec(
      "INSERT INTO torrents VALUES ('a', 'Sintel', NULL, NULL, NULL, 1, 2)",
    );
    const v2: Migration = {
      version: LATEST_VERSION + 1,
      up: (target) => {
        target.exec("ALTER TABLE torrents ADD COLUMN hidden INTEGER");
      },
    };

    expect(migrate(db, [...MIGRATIONS, v2])).toEqual({
      from: LATEST_VERSION,
      to: LATEST_VERSION + 1,
    });
    expect(db.prepare("SELECT name, hidden FROM torrents").all()).toEqual([
      { name: "Sintel", hidden: null },
    ]);
  });

  it("keeps nothing from a run where a step fails", () => {
    expect(() =>
      migrate(db, [...MIGRATIONS, failing(LATEST_VERSION + 1)]),
    ).toThrow("step failed");

    // Not even the steps before the failing one.
    expect(readUserVersion(db)).toBe(0);
    expect(tables()).toEqual([]);
    expect(db.isTransaction).toBe(false);
    expect(foreignKeysOn()).toBe(true);
  });

  it("rolls back a step that leaves positions without their torrent", () => {
    migrate(db);
    db.exec(`
      INSERT INTO torrents VALUES ('a', 'Sintel', NULL, NULL, NULL, 1, 2);
      INSERT INTO progress VALUES ('a', 0, 'Sintel.mp4', 60, NULL, NULL, NULL, 0, 3);
    `);
    const careless: Migration = {
      version: LATEST_VERSION + 1,
      // Foreign keys are off while steps run, so nothing cascades here.
      up: (target) => {
        target.exec("DELETE FROM torrents");
      },
    };

    expect(() => migrate(db, [...MIGRATIONS, careless])).toThrow(
      "pointing at missing rows",
    );
    expect(readUserVersion(db)).toBe(LATEST_VERSION);
    expect(db.prepare("SELECT count(*) AS n FROM torrents").get()?.n).toBe(1);
  });

  it("refuses a file from a newer Streamy and leaves it as it is", () => {
    db.exec(`PRAGMA user_version = ${LATEST_VERSION + 1}`);

    let caught: unknown;
    try {
      migrate(db);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LibraryError);
    expect(caught).toMatchObject({ code: "newer_version" });
    expect(readUserVersion(db)).toBe(LATEST_VERSION + 1);
    expect(tables()).toEqual([]);
  });
});
