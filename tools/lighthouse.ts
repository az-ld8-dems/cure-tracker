// Lighthouse budgets for the cure tracker's pages. Serves the app on synthetic data (tools/lib/dev-server.ts), runs Lighthouse on
// each page for a phone (the default mobile emulation with simulated slow 4G) and for a desktop, and fails when a category score or a
// metric is outside its budget. A page that misses a timing budget is measured twice more and judged on the median of the three, so one
// slow run on a busy machine does not fail the build; tools/lib/lighthouse-budgets.ts has the rules and the tests.
// Usage: node tools/lighthouse.ts [report-dir]    (writes one JSON report per page and form factor if report-dir is given)
// Dev-only: needs `npm install` and `npx playwright install chromium` (it launches Playwright's Chromium).

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import lighthouse from 'lighthouse';
import desktopConfig from 'lighthouse/core/config/desktop-config.js';
import { chromium } from 'playwright';
import { DEV_ADMIN, DEV_VOLUNTEER, startDevServer } from './lib/dev-server.ts';
import { budgets, type LhrLike, type Loosened, measurePage } from './lib/lighthouse-budgets.ts';

type Flags = NonNullable<Parameters<typeof lighthouse>[1]>;

// Each signed-in user gets a server of their own, because Lighthouse cannot set the cookie the dev server reads.
// The map page loads MapLibre (about 1.1 MB of JavaScript, parsed on a phone throttled to a quarter of its speed), and Lighthouse here has no
// GPU to draw with, so its performance score and blocking time are looser than everyone else's; the other budgets are the same. The numbers
// leave room over what a laptop measures (74 and 1.5 s on the mobile run, 87 and 0.3 s on the desktop one) so a runner that is slower does not fail it.
const MAP_COSTS: Loosened = { performance: 0.5, metrics: { 'total-blocking-time': 3000 } };
const pages: { user: string; path: string; loosened?: Loosened }[] = [
  { user: DEV_VOLUNTEER, path: '/' },
  { user: DEV_VOLUNTEER, path: '/pool/' },
  { user: DEV_VOLUNTEER, path: '/map/', loosened: MAP_COSTS },
  { user: DEV_ADMIN, path: '/admin/' },
];

const reportDir = process.argv[2];
if (reportDir) await mkdir(reportDir, { recursive: true });
const servers = new Map<string, { server: { close(): unknown }; port: number }>();
for (const user of new Set(pages.map((p) => p.user)))
  servers.set(user, await startDevServer({ people: 200, defaultUser: user, named: true }));
const chrome = await startChrome();
const problems: string[] = [];
try {
  for (const { user, path, loosened } of pages) {
    const origin = servers.get(user);
    if (!origin) throw new Error(`no server for ${user}`);
    const url = `http://localhost:${origin.port}${path}`;
    for (const form of ['mobile', 'desktop']) {
      const flags: Flags = { port: chrome.port, output: 'json', onlyCategories: Object.keys(budgets.categories), logLevel: 'error' };
      const tag = `${path} ${form}`;
      const result = await measurePage(
        tag,
        async () => (await lighthouse(url, flags, form === 'desktop' ? desktopConfig : undefined))?.lhr ?? null,
        loosened,
      );
      problems.push(...result.problems);
      if (result.line) console.log(`${tag.padEnd(22)} ${result.line}`);
      if (reportDir) await saveReports(reportDir, `${path.replaceAll('/', '_')}${form}`, result.lhrs);
    }
  }
} finally {
  await chrome.kill();
  for (const { server } of servers.values()) server.close();
}
if (problems.length) {
  console.log(`PROBLEMS:\n${problems.join('\n')}`);
  process.exit(1);
}
console.log('lighthouse: ok');

// Starts Playwright's Chromium with a debugging port for Lighthouse to connect to. This replaces chrome-launcher, which
// takes GitHub's `ubuntu-slim` runner for WSL (its is-wsl check) and then looks for a Windows temp directory
// ("mkdtemp '/mnt/undefined/Users/undefined/AppData/Local/lighthouse.XXXXXX'"). Port 0 lets the OS pick a free port;
// Chromium prints it on stderr as "DevTools listening on ws://127.0.0.1:<port>/..." once it is ready.
async function startChrome() {
  if (!existsSync(chromium.executablePath()))
    throw new Error("Playwright's Chromium is not installed here: run `npx playwright install chromium`");
  const profile = await mkdtemp(join(tmpdir(), 'lighthouse-'));
  const child = spawn(
    chromium.executablePath(),
    [
      '--headless=new',
      '--disable-gpu',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      ...(process.env.CI ? ['--no-sandbox'] : []),
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const port = await new Promise<number>((resolve, reject) => {
    let log = '';
    const timer = setTimeout(() => reject(new Error(`Chromium did not report a debugging port within 30 s:\n${log}`)), 30_000);
    child.stderr.on('data', (chunk: Buffer) => {
      log += chunk.toString();
      const match = /DevTools listening on ws:\/\/[^:/]+:(\d+)\//.exec(log);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    void exited.then(() => {
      clearTimeout(timer);
      reject(new Error(`Chromium exited before it reported a debugging port:\n${log}`));
    });
  }).catch(async (error: unknown) => {
    child.kill();
    await rm(profile, { recursive: true, force: true });
    throw error;
  });
  return {
    port,
    async kill() {
      child.kill();
      await exited;
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

// One JSON report per run: the first as <name>.json, any rerun after a timing miss as <name>-run2.json and so on.
async function saveReports(dir: string, name: string, lhrs: LhrLike[]) {
  for (const [i, lhr] of lhrs.entries())
    await writeFile(join(dir, `${name}${i === 0 ? '' : `-run${i + 1}`}.json`), JSON.stringify(lhr, null, 1));
}
