import Database from 'better-sqlite3';
import { config } from '../config';

/**
 * Opens a better-sqlite3 connection with the pragmas we rely on:
 *  - WAL: better read/write concurrency for the worker + API sharing one file.
 *  - foreign_keys ON: enforce the analyses -> feedback reference (off by default in SQLite).
 *
 * Exported as a factory so tests can open an isolated ':memory:' database while the app
 * uses the configured file. `migrate()` must be run against the returned handle on boot.
 */
export type Db = Database.Database;

export function openDatabase(path: string): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

/** Process-wide singleton used by the running app (tests open their own in-memory db). */
export const db: Db = openDatabase(config.dbPath);
