// Times the Worker on a synthetic district-sized sheet: the upload, then the reads every page makes. Run with `npm run bench -- [people]`
// (default 10000). All data is made up (tools/lib/sheet.ts); nothing here ships. The database is node:sqlite in memory, so the numbers show
// how the work grows, not what D1 will cost.
import { type AppEnv, handle } from '../worker/app.ts';
import { sheetCsv, syntheticPeople } from './lib/sheet.ts';
import { migratedDb, sqliteD1 } from './lib/sqlite-d1.ts';

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

async function call(method: string, path: string, body?: unknown): Promise<{ ms: number; bytes: number; status: number }> {
  const init: RequestInit = { method, headers: body === undefined ? {} : { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const t = performance.now();
  const res = await handle(new Request(`https://cure.example${path}`, init), env, { verifier });
  const text = await res.text();
  return { ms: performance.now() - t, bytes: Buffer.byteLength(text), status: res.status };
}

// A hundred or so precincts, as a district has, instead of the five in the stock sheet.
const people = syntheticPeople(size).map((p, i) => ({ ...p, precinct: `PRECINCT ${String(i % 120).padStart(3, '0')}` }));
const csv = sheetCsv(people);
const row = (label: string, r: { ms: number; bytes: number; status: number }) =>
  console.log(`${label.padEnd(34)} ${r.ms.toFixed(0).padStart(6)} ms ${(r.bytes / 1024).toFixed(0).padStart(7)} KB  HTTP ${r.status}`);

console.log(`${size} synthetic people, ${(Buffer.byteLength(csv) / 1024).toFixed(0)} KB of CSV`);
row('upload preview', await call('POST', '/api/admin/uploads/preview', { csv }));
row('upload apply', await call('POST', '/api/admin/uploads', { csv, filename: 'bench.csv' }));
row('Find people, first load (+facets)', await call('GET', '/api/people?facets=1'));
row('Find people, next page', await call('GET', '/api/people?offset=50'));
row('Find people, city + precinct', await call('GET', '/api/people?city=Mesa&precinct=PRECINCT%20007'));
row('Find people, search', await call('GET', '/api/people?q=ames'));
row('Find people, sort by name', await call('GET', '/api/people?sort=name'));
row('My people', await call('GET', '/api/people?scope=mine'));
row('Admin find someone', await call('GET', '/api/people?scope=all&limit=15&q=ames'));
row('GET /api/admin/stats', await call('GET', '/api/admin/stats'));
row('upload apply again (no changes)', await call('POST', '/api/admin/uploads', { csv, filename: 'bench2.csv' }));
