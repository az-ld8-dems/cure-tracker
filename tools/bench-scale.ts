// Times the Worker on a synthetic district-sized sheet: the upload, then the reads every page makes. Run with `npm run bench -- [people]`
// (default 10000). All data is made up (tools/lib/sheet.ts); nothing here ships. The database is node:sqlite in memory, so the numbers show
// how the work grows, not what D1 will cost.

import { finishSheet, stageSheet } from '../src/upload.ts';
import { type AppEnv, handle } from '../worker/app.ts';
import { sheetCsv, syntheticPeople } from './lib/sheet.ts';
import { migratedDb, sqliteD1 } from './lib/sqlite-d1.ts';
import { requestOver, type Send } from './lib/upload-test.ts';

const size = Number(process.argv[2] ?? 10_000);
const ADMIN = 'admin@example.com';
const sqlite = migratedDb();
const env: AppEnv = {
  ACCESS_TEAM_DOMAIN: 'test.example',
  ACCESS_AUD: 'test',
  ADMIN_EMAILS: ADMIN,
  ALLOW_RESET: 'false',
  DB: sqliteD1(sqlite),
  ASSETS: { fetch: async () => new Response('asset') },
};
const verifier = { verify: async () => ({ ok: true as const, identity: { email: ADMIN, serviceToken: null, sub: ADMIN } }) };

async function call(method: string, path: string, body?: unknown): Promise<{ ms: number; bytes: number; status: number; data: unknown }> {
  const init: RequestInit = { method, headers: body === undefined ? {} : { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const t = performance.now();
  const res = await handle(new Request(`https://cure.example${path}`, init), env, { verifier });
  const text = await res.text();
  const ms = performance.now() - t;
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { ms, bytes: Buffer.byteLength(text), status: res.status, data };
}

// A hundred or so precincts, as a district has, instead of the five in the stock sheet.
const people = syntheticPeople(size).map((p, i) => ({ ...p, precinct: `PRECINCT ${String(i % 120).padStart(3, '0')}` }));
const csv = sheetCsv(people);
const row = (label: string, r: { ms: number; bytes: number; status: number }) =>
  console.log(`${label.padEnd(34)} ${r.ms.toFixed(0).padStart(6)} ms ${(r.bytes / 1024).toFixed(0).padStart(7)} KB  HTTP ${r.status}`);

console.log(`${size} synthetic people, ${(Buffer.byteLength(csv) / 1024).toFixed(0)} KB of CSV`);
// The upload as the admin page does it: the browser reads the file (not timed here) and sends the people a request's worth at a time.
// What a Worker request costs in CPU is what its handler does in JavaScript; here the database is in the same process, so the times
// below include it. The point is that no request grows with the size of the sheet.
const timings: { path: string; ms: number }[] = [];
const send: Send = async (method, path, body) => {
  const r = await call(method, path, body);
  timings.push({ path, ms: r.ms });
  return { status: r.status, data: r.data };
};
const request = requestOver(send);
async function upload(name: string): Promise<void> {
  timings.length = 0;
  const wall = performance.now();
  const { token } = await stageSheet(csv, name, request);
  await finishSheet(token, true, request);
  const of = (path: string) => timings.filter((t) => t.path === path).map((t) => t.ms);
  const chunks = of('/api/admin/uploads/stage/rows');
  const one = (path: string) => `${(of(path)[0] ?? 0).toFixed(0)} ms`;
  console.log(
    `${name.padEnd(34)} ${(performance.now() - wall).toFixed(0).padStart(6)} ms in all: start ${one('/api/admin/uploads/stage')}, ${chunks.length} chunks (avg ${(chunks.reduce((a, b) => a + b, 0) / Math.max(1, chunks.length)).toFixed(1)}, max ${Math.max(0, ...chunks).toFixed(1)} ms), plan ${one('/api/admin/uploads/stage/plan')}, finish ${one('/api/admin/uploads/stage/finish')}`,
  );
}
await upload('first upload (all new)');
row('Find people, first load (+facets)', await call('GET', '/api/people?facets=1'));
row('Find people, next page', await call('GET', '/api/people?offset=50'));
row('Find people, city + precinct', await call('GET', '/api/people?city=Mesa&precinct=PRECINCT%20007'));
row('Find people, search', await call('GET', '/api/people?q=ames'));
row('Find people, sort by name', await call('GET', '/api/people?sort=name'));
row('My people', await call('GET', '/api/people?scope=mine'));
row('Admin find someone', await call('GET', '/api/people?scope=all&limit=15&q=ames'));
row('GET /api/admin/stats', await call('GET', '/api/admin/stats'));
await upload('same sheet again (no changes)');
