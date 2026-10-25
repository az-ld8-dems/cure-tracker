// The slice of the D1 API the Worker uses, so this code runs on real D1 and, in tests and the dev server, on a node:sqlite wrapper
// (tools/lib/sqlite-d1.ts). Only erasable TypeScript syntax.
export type Value = string | number | null;

export interface Stmt {
  bind(...values: Value[]): Stmt;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{ meta: { changes: number; last_row_id: number } }>;
}

export interface Db {
  prepare(sql: string): Stmt;
  // All or nothing.
  batch(statements: Stmt[]): Promise<unknown[]>;
}
