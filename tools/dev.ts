// Runs the cure tracker locally on synthetic data, with a stand-in for Access: the signed-in email comes from a cookie.
// Usage: node tools/dev.ts [port] [--admin]     then open /__as?email=someone@example.com to sign in as someone else.
import { networkInterfaces } from 'node:os';
import { DEV_ADMIN, DEV_VOLUNTEER, startDevServer } from './lib/dev-server.ts';

const port = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 8080);
const asAdmin = process.argv.includes('--admin');
const { port: listening } = await startDevServer({ port, host: '0.0.0.0', people: 60, defaultUser: asAdmin ? DEV_ADMIN : DEV_VOLUNTEER });
console.log(`signed in as ${asAdmin ? DEV_ADMIN : DEV_VOLUNTEER} (admins: ${DEV_ADMIN}); /__as?email=you@example.com switches`);
for (const list of Object.values(networkInterfaces())) {
  for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) console.log(`  http://${i.address}:${listening}/`);
}
console.log(`  http://localhost:${listening}/`);
