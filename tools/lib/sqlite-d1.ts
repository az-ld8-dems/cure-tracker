// A D1-shaped wrapper over node:sqlite, so the Worker's database code runs in Node with the real migration: just the calls the Worker
// makes (prepare, bind, all, first, run, batch). The tests and the local dev server use it; nothing here ships.
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { Db, Stmt, Value } from '../../worker/db.ts';

class SqliteStmt implements Stmt {
  sql: string;
  params: Value[];
  db: DatabaseSync;
  constructor(db: DatabaseSync, sql: string, params: Value[] = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...values: Value[]): Stmt {
    return new SqliteStmt(this.db, this.sql, values);
  }
  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    return {
      results: this.db
        .prepare(this.sql)
        .all(...this.params)
        .map((row) => ({ ...row })) as T[],
    };
  }
  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params);
    return row ? ({ ...row } as T) : null;
  }
  async run(): Promise<{ meta: { changes: number; last_row_id: number } }> {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}

export function sqliteD1(db: DatabaseSync): Db {
  return {
    prepare: (sql) => new SqliteStmt(db, sql),
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const out: unknown[] = [];
        for (const s of statements) {
          if (!(s instanceof SqliteStmt)) throw new Error('not a statement of this database');
          out.push(await s.run());
        }
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

// An empty in-memory database with every migration applied and foreign keys on, as D1 has them.
export function migratedDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const dir = new URL('../../db/migrations/', import.meta.url);
  for (const f of readdirSync(dir)
    .filter((n) => n.endsWith('.sql'))
    .sort())
    db.exec(readFileSync(new URL(f, dir), 'utf8'));
  return db;
}
