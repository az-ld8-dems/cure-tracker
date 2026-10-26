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

// D1 refuses SQLite's math functions ("not authorized to use function: power"), which SQLite here allows. Refusing them in every test and in the
// dev server keeps code that only works on SQLite out: in production they made every search by distance, the map's radius and the town
// name fail.
const MATH =
  /\b(power|pow|sin|cos|tan|asin|acos|atan2?|sqrt|radians|degrees|exp|ln|log|log2|log10|floor|ceil|ceiling|sinh|cosh|tanh)\s*\(/i;

export function sqliteD1(db: DatabaseSync): Db {
  return {
    prepare: (sql) => {
      const found = MATH.exec(sql);
      if (found) throw new Error(`D1_ERROR: not authorized to use function: ${found[1]}`);
      return new SqliteStmt(db, sql);
    },
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
