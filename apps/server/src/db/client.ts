import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";

export interface OpenDatabaseOptions {
  /** Absolute path to the SQLite file, or ":memory:" for tests. */
  file: string;
  migrationsDir: string;
}

export function openDatabase({ file, migrationsDir }: OpenDatabaseOptions) {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle({ client: sqlite, schema });
  migrate(db, { migrationsFolder: migrationsDir });
  return { db, sqlite, file };
}

export type Db = ReturnType<typeof openDatabase>["db"];
