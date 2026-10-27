// Smoke test: drives the cure tracker in a real browser against the dev server (synthetic data, Access stood in for by a cookie).
// Walks a new volunteer through naming themselves, finding, claiming and working a person, then an admin through an upload and the
// panels. Checks on every page in light and dark and at phone and desktop width: no console errors or CSP violations, nothing
// overflows sideways, and axe finds no violations.
// Usage: [SMOKE_BROWSER=chromium|firefox|webkit] node tools/smoke.ts
// Dev-only: needs `npm install` and `npx playwright install <browser>`.
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { type Browser, type BrowserContext, chromium, firefox, type Page, webkit } from 'playwright';
import { chromiumQuirks } from './lib/chromium-quirks.ts';
import { DEV_ADMIN, startDevServer } from './lib/dev-server.ts';
import { firefoxQuirks } from './lib/firefox-quirks.ts';
import { sheetCsv, syntheticPeople } from './lib/sheet.ts';
import { webkitQuirks } from './lib/webkit-quirks.ts';

// Every page links the vendored Frostline's versioned folder: the version in the HTML must be the one that is built.
const frostline = readFileSync(new URL('../vendor/frostline/VERSION', import.meta.url), 'utf8').trim();
for (const file of ['index.html', 'pool/index.html', 'map/index.html', 'admin/index.html', '404.html']) {
  const html = readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
  const linked = new Set([...html.matchAll(/\/frostline\/([\d.]+)\//g)].map((m) => m[1]));
  if (linked.size !== 1 || !linked.has(frostline)) {
    console.error(`public/${file} links Frostline ${[...linked].join(', ') || 'nothing'}, but vendor/frostline is ${frostline}`);
    process.exit(1);
  }
}

const name = process.env.SMOKE_BROWSER || 'chromium';
const launcher = { chromium, firefox, webkit }[name as 'chromium'];
if (!launcher) {
  console.error(`unknown SMOKE_BROWSER: ${name}`);
  process.exit(2);
}
console.log(`smoke: ${name}`);

const PEOPLE = 40;
const { server, port, sqlite } = await startDevServer({ people: PEOPLE });
const base = `http://localhost:${port}`;
const problems: string[] = [];
// Known browser-specific console messages that were ignored, by label (tools/lib/*-quirks.ts); listed at the end.
const quirks = { webkit: webkitQuirks, chromium: chromiumQuirks, firefox: firefoxQuirks }[name as 'webkit'] ?? [];
const ignored = new Map<string, number>();
const problem = (where: string, what: string) => problems.push(`${where}: ${what}`);

// Firefox on a runner with no graphics is told to try WebGL anyway (software drawing); if it still cannot, the map page's notice is checked instead.
const browser: Browser = await launcher.launch(name === 'firefox' ? { firefoxUserPrefs: { 'webgl.force-enabled': true } } : {});

async function context(email: string, opts: { dark?: boolean; phone?: boolean } = {}): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    colorScheme: opts.dark ? 'dark' : 'light',
    viewport: opts.phone ? { width: 375, height: 812 } : { width: 1280, height: 800 },
    hasTouch: opts.phone === true,
  });
  await ctx.addCookies([{ name: 'dev_user', value: encodeURIComponent(email), url: base }]);
  return ctx;
}

// Collects what the page complains about while the test drives it.
// `allowed` are response statuses this page is expected to get (a refused claim is a 409), so they are not problems.
function watch(page: Page, where: string, allowed: number[] = []): void {
  page.on('console', (m) => {
    const quirk = quirks.find((q) => q.re.test(m.text()));
    if (quirk) {
      ignored.set(quirk.label, (ignored.get(quirk.label) ?? 0) + 1);
      return;
    }
    const expected = allowed.some((status) => m.text().includes(`status of ${status}`));
    if ((m.type() === 'error' || m.type() === 'warning') && !expected) problem(where, `console ${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problem(where, `page error: ${e.message}`));
  page.on('requestfailed', (r) => problem(where, `request failed: ${r.url()} ${r.failure()?.errorText ?? ''}`));
  page.on('response', (r) => {
    if (r.status() >= 400 && !allowed.includes(r.status())) problem(where, `${r.status()} for ${r.url()}`);
  });
}

async function check(page: Page, where: string): Promise<void> {
  // A toast is transient and announced to screen readers by its own live region, but Frostline puts its container outside every
  // landmark, so axe's region rule flags it while one is showing. Scan the page, not the message (reported upstream in docs/design.md).
  await page.evaluate(() => {
    for (const toast of document.querySelectorAll('.fl-toast')) toast.remove();
  });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 0) problem(where, `the page overflows sideways by ${overflow}px`);
  const axe = await new AxeBuilder({ page }).analyze();
  for (const v of axe.violations) {
    problem(
      where,
      `axe ${v.id} (${v.impact}): ${v.nodes
        .map((n) => n.target.join(' '))
        .slice(0, 3)
        .join('; ')}`,
    );
  }
}

// Waits for the map page to settle. True when the map was drawn; false when the browser has no WebGL 2 and the page said so instead, which is
// what it should do, so that is checked here and the checks that need a map are skipped.
async function mapDrawn(page: Page, where: string): Promise<boolean> {
  const webgl2 = await page.evaluate(() => document.createElement('canvas').getContext('webgl2') !== null);
  if (webgl2) {
    await page.getByText(/people? on the map/).waitFor();
    await page.locator('#map canvas').waitFor();
    return true;
  }
  await page.getByText(/The map could not start in this browser/).waitFor();
  console.log(`${where}: no WebGL 2 here; the page's notice was checked instead of the map`);
  return false;
}

const expect = (where: string, ok: boolean, what: string) => {
  if (!ok) problem(where, what);
};

try {
  // ---- a new volunteer, on a phone
  const ctx = await context('vera@example.com', { phone: true });
  const page = await ctx.newPage();
  watch(page, 'volunteer', [400]); // a ZIP nobody is placed in is refused with a 400 on purpose
  await page.goto(`${base}/`);
  await page.getByLabel('Your name').waitFor();
  await check(page, 'welcome');
  await page.getByLabel('Your name').fill('Vera Vale');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('You don’t have anybody yet.').waitFor();
  await check(page, 'my people (empty)');

  // ---- find people, filter, claim
  await page.getByRole('link', { name: 'Find people', exact: true }).click();
  await page.getByText(/Showing 30 people, with more to show/).waitFor();
  await check(page, 'find people');
  // On a phone the filters (other than the search) are in a disclosure, closed at first.
  expect('find people', !(await page.getByLabel('City').isVisible()), 'the filters should start closed on a phone');
  await page.getByText('Filter and sort').click();
  await page.getByLabel('City').selectOption('Tempe');
  await page.getByText(/Showing \d+ people/).waitFor();
  const tempe = await page.locator('.pool-row').count();
  expect('find people', tempe > 0 && tempe <= 30, `filtering by city showed ${tempe} cards`);
  // The precinct list shows only the precincts of the chosen city, and opening it moves no other control.
  const precinctBox = page.getByLabel('Precinct', { exact: true });
  const cityBox = await page.getByLabel('City').boundingBox();
  await precinctBox.click();
  const inTempe = await page.locator('.pool-popover [role="option"]').count();
  const cityBoxOpen = await page.getByLabel('City').boundingBox();
  expect('find people', JSON.stringify(cityBox) === JSON.stringify(cityBoxOpen), 'opening the precinct list moved the city field');
  await page.getByLabel('City').selectOption('');
  await precinctBox.blur();
  await precinctBox.click();
  const inAll = await page.locator('.pool-popover [role="option"]').count();
  expect('find people', inTempe > 0 && inTempe < inAll, `${inTempe} precincts in Tempe, ${inAll} in all`);
  await page.getByLabel('City').selectOption('Tempe');
  await page.getByText(/Showing \d+ people/).waitFor();
  await page.keyboard.press('Escape');
  await page.getByText('Near me', { exact: true }).click();
  await page.getByLabel('City').selectOption('');
  await page.getByLabel('Search name or street').fill('zzzz');
  await page.getByText('Nobody matches.').waitFor();
  await page.getByLabel('Search name or street').fill('');
  // Near me: nothing is saved at first, so a radius is off. Saving the middle of a ZIP picks ten miles and nearest first, and the distances show.
  expect('near me', await page.getByLabel('Show people').isDisabled(), 'a radius needs a saved place');
  expect('near me', (await page.getByRole('option', { name: 'Nearest first' }).isDisabled()) === true, 'nearest first needs a radius');
  await page.getByLabel('or the middle of a ZIP').fill('99999');
  await page.getByRole('button', { name: 'Use this ZIP' }).click();
  await page.getByText(/not enough people placed in that ZIP/).waitFor();
  await page.getByLabel('or the middle of a ZIP').fill('85018');
  await page.getByRole('button', { name: 'Use this ZIP' }).click();
  await page.getByText('Saved where you are.').waitFor();
  // Saved: the page says where you are, and the ways to save a place are gone.
  await page.getByText(/Where you are: near .*\d{5}\. Saved to about a mile/).waitFor();
  expect(
    'near me',
    !(await page.getByRole('button', { name: 'Use my location' }).isVisible()),
    'the device button goes once a place is saved',
  );
  expect('near me', !(await page.getByLabel('or the middle of a ZIP').isVisible()), 'and so does the ZIP box');
  expect('near me', await page.getByRole('button', { name: 'Change' }).isVisible(), 'a place can be changed');
  await page.locator('.pool-row').first().waitFor();
  expect('near me', (await page.getByLabel('Show people').inputValue()) === '10', 'ten miles was picked');
  expect('near me', (await page.getByLabel('Sort by').inputValue()) === 'distance', 'nearest first was picked');
  expect('near me', / mi/.test((await page.locator('.pool-row').first().textContent()) ?? ''), 'a person shows how far away they are');
  await check(page, 'find people (near me)');
  // The device's location works the same way.
  await ctx.grantPermissions(['geolocation'], { origin: base });
  await ctx.setGeolocation({ latitude: 33.4567, longitude: -112.0149 });
  await page.getByRole('button', { name: 'Change' }).click();
  await page.getByText(/Choose a new place below/).waitFor();
  expect('near me', await page.getByLabel('or the middle of a ZIP').isVisible(), 'Change brings the ways to save one back');
  await page.getByRole('button', { name: 'Cancel' }).click();
  expect('near me', !(await page.getByLabel('or the middle of a ZIP').isVisible()), 'and Cancel puts them away');
  await page.getByRole('button', { name: 'Change' }).click();
  await page.getByRole('button', { name: 'Use my location' }).click();
  await page.getByText('Saved where you are.').last().waitFor();
  await page.getByText(/Where you are: near .*\d{5}\. Saved to about a mile/).waitFor();
  // Forgetting it puts everything back.
  await page.getByRole('button', { name: 'Forget where I am' }).click();
  await page.getByText('Forgot where you are.').waitFor();
  await page.getByText(/Where you are: not saved/).waitFor();
  expect('near me', await page.getByLabel('or the middle of a ZIP').isVisible(), 'forgetting brings the ways to save one back');
  expect(
    'near me',
    (await page.getByLabel('Show people').inputValue()) === '' && (await page.getByLabel('Sort by').inputValue()) === 'days',
    'forgetting resets the search',
  );
  expect('near me', !(await page.locator('.pool-row').first().textContent())?.includes(' mi'), 'and the distances go');
  await page.getByLabel('Sort by').selectOption('name');
  const firstRow = page.locator('.pool-row').first();
  const claimedName = (await firstRow.locator('strong').textContent()) ?? '';
  await firstRow.getByRole('button', { name: /^Claim / }).click();
  await page.getByText(`${claimedName} is on your list now.`).waitFor();
  // The claimed person leaves the page, which does not refill: 29 are left of the 30 it showed, with more behind them.
  await page.getByText(/Showing 29 people, with more to show/).waitFor();

  // A second volunteer loses the race for the same person: the server says so, and the page shows the pool as it is.
  const ctxB = await context('walt@example.com');
  const pageB = await ctxB.newPage();
  watch(pageB, 'volunteer B', [409]);
  await pageB.goto(`${base}/pool/`);
  await pageB.getByLabel('Your name').fill('Walt Webb');
  await pageB.getByRole('button', { name: 'Continue' }).click();
  await pageB.getByText(/Showing 30 people, with more to show/).waitFor();
  const stale = Number(sqlite.prepare('SELECT id FROM people WHERE assigned_to IS NOT NULL LIMIT 1').get()?.id);
  const lost = await pageB.evaluate(
    async (id) =>
      (await fetch(`/api/people/${id}/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status,
    stale,
  );
  expect('claim race', lost === 409, `claiming a claimed person gave ${lost}, wanted 409`);
  await ctxB.close();

  // ---- my people: work a person
  await page.getByRole('link', { name: 'My people', exact: true }).click();
  const mine = page.locator('.people > li').first();
  await mine.waitFor();
  expect('my people', (await mine.locator('h2').textContent()) === claimedName, 'the claimed person is first on My people');
  await mine.getByRole('button', { name: 'Left voicemail' }).click();
  await mine.getByRole('button', { name: 'Left voicemail', pressed: true }).waitFor();
  await mine.getByLabel('How did you reach them?').selectOption('text');
  await mine.getByText('Notes (0)').click();
  await mine.getByLabel('Add a note').fill('Texted the flyer, will call tomorrow.');
  await mine.getByRole('button', { name: 'Save note' }).click();
  await mine.getByText('Notes (1)').waitFor();
  await check(page, 'my people (a card with notes open)');
  await page.reload();
  const again = page.locator('.people > li').first();
  await again.getByRole('button', { name: 'Left voicemail', pressed: true }).waitFor();
  expect('my people', (await again.getByLabel('How did you reach them?').inputValue()) === 'text', 'the contact method was not kept');
  await again.getByText('Notes (1)').click();
  await again.getByText('Texted the flyer, will call tomorrow.').waitFor();
  await check(page, 'my people (a worked card)');
  await page.setViewportSize({ width: 1280, height: 800 });
  await check(page, 'my people (desktop)');
  // With room, Find people is a table, and its filters are open.
  await page.getByRole('link', { name: 'Find people', exact: true }).click();
  await page.locator('.pool-table tbody tr').first().waitFor();
  expect('find people', await page.getByLabel('City').isVisible(), 'the filters should be open on a wide screen');
  expect('find people', !(await page.locator('.pool-rows').isVisible()), 'the compact rows should be hidden on a wide screen');
  // A header sorts the table: the select follows, the header says which way it runs, and the first row is the first by last name.
  await page.getByRole('button', { name: 'Person' }).click();
  await page.locator('th[aria-sort="ascending"]').waitFor();
  expect('find people', (await page.getByLabel('Sort by').inputValue()) === 'name', 'the Sort by select did not follow the header');
  // A second click on the same header runs it the other way.
  await page.getByRole('button', { name: 'Person' }).click();
  await page.locator('th[aria-sort="descending"]').waitFor();
  await check(page, 'find people (table)');

  // ---- the map: the dev server has no tile file, so the pins are drawn on a plain background and the page says so
  await page.getByRole('link', { name: 'Map', exact: true }).click();
  if (await mapDrawn(page, 'map')) {
    expect('map', await page.getByRole('list', { name: 'Legend' }).isVisible(), 'the legend is not shown');
    expect(
      'map',
      /Address found/.test((await page.getByRole('list', { name: 'Legend' }).textContent()) ?? ''),
      'the legend lacks the exact pin',
    );
    expect('map', /guess/.test((await page.getByRole('list', { name: 'Legend' }).textContent()) ?? ''), 'the legend lacks the guessed pin');
    expect(
      'map',
      /street map has not been set up/.test((await page.locator('#map-status').textContent()) ?? ''),
      'no notice that tiles are missing',
    );
    // The filters are the list's: they narrow the pins, stay in the address, and go with the link to the other page.
    const pinCount = async (): Promise<number> =>
      Number(
        /([\d,]+) (?:people|person) on the map/.exec((await page.locator('#map-status').textContent()) ?? '')?.[1]?.replaceAll(',', ''),
      );
    const all = await pinCount();
    // (A phone keeps the filters and the Near me box closed; where there is room they are open.)
    if (!(await page.getByLabel('City').isVisible())) await page.getByText('Filter and sort').click();
    await page.getByLabel('City').selectOption('Tempe');
    await page.waitForFunction((was) => {
      const m = /([\d,]+) (?:people|person) on the map/.exec(document.querySelector('#map-status')?.textContent ?? '');
      return m?.[1] !== undefined && Number(m[1].replaceAll(',', '')) !== was;
    }, all);
    const tempe = await pinCount();
    expect('map', tempe > 0 && tempe < all, `${tempe} pins in Tempe of ${all}`);
    expect('map', /[?&]city=/.test(page.url()), 'the filter is not in the address');
    expect(
      'map',
      /city=/.test(
        (await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Find people' }).getAttribute('href')) ?? '',
      ),
      'the link to Find people does not carry the filter',
    );
    // The place the volunteer saved gets a pin of its own, and a line in the legend.
    expect('map', !(await page.locator('.pin--you').isVisible()), 'a place is shown that was never saved');
    if (!(await page.getByLabel('or the middle of a ZIP').isVisible())) await page.getByText('Near me', { exact: true }).click();
    await page.getByLabel('or the middle of a ZIP').fill('85281');
    await page.getByRole('button', { name: 'Use this ZIP' }).click();
    await page.locator('.pin--you').waitFor();
    await page.getByRole('button', { name: 'Forget where I am' }).click();
    await page.locator('.pin--you').waitFor({ state: 'hidden' });
    await page.getByLabel('City').selectOption('');
  }
  await check(page, 'map');

  // the admin pages are closed to a volunteer (this page's own 403 is the point)
  const denied = await (await ctx.newPage()).goto(`${base}/admin/`);
  expect('volunteer', denied?.status() === 403, `/admin/ gave ${denied?.status()} to a volunteer`);
  await ctx.close();

  // ---- an admin
  const adminCtx = await context(DEV_ADMIN);
  const admin = await adminCtx.newPage();
  watch(admin, 'admin', [422]); // the bad file below is refused with a 422 on purpose
  await admin.goto(`${base}/`);
  await admin.getByLabel('Your name').fill('Ada Admin');
  await admin.getByRole('button', { name: 'Continue' }).click();
  await admin.getByText('You don’t have anybody yet.').waitFor();
  await admin.getByRole('link', { name: 'Admin', exact: true }).click();
  await admin.getByRole('heading', { name: 'Upload the state’s sheet' }).waitFor();
  await admin.getByRole('heading', { name: 'Audit log' }).waitFor();
  await check(admin, 'admin');

  // Upload a day-two sheet: three people gone, two new, the rest the same.
  const day2 = syntheticPeople(PEOPLE)
    .slice(3)
    .concat([
      { first: 'Newt', last: 'Newman', address: '5 W NEW ST TEMPE, AZ 85281', precinct: 'ASU WEST' },
      // The stand-in Census cannot place this one, so it ends up at the middle of its ZIP.
      { first: 'Nora', last: 'Nowhere', address: '1 NOWHERE LN TEMPE, AZ 85281', precinct: 'ASU WEST' },
    ]);
  await admin.getByLabel('CSV file').setInputFiles({ name: 'day2.csv', mimeType: 'text/csv', buffer: Buffer.from(sheetCsv(day2)) });
  await admin.getByRole('button', { name: 'Check the file' }).click();
  await admin.getByText('Newly cured').waitFor();
  expect(
    'admin upload',
    /^New people2/.test((await admin.locator('.tiles').first().textContent()) ?? ''),
    'the preview did not show 2 new people',
  );
  await check(admin, 'admin upload preview');
  await admin.getByRole('button', { name: 'Upload this file' }).click();
  await admin.getByText('Uploaded. 2 added, 3 cured, 0 flagged.').waitFor();
  await admin.getByText(/Last upload: day2\.csv/).waitFor();

  // Look up where people live (the stand-in Census answers). One person cannot be placed: she gets the middle of her ZIP, and an admin can
  // see her in a list, copy her address, download the list, and ask again.
  await admin.getByRole('heading', { name: 'Where people live' }).waitFor();
  await admin.getByRole('button', { name: /^Look up \d+ addresses$/ }).click();
  await admin
    .getByText(/^\d+ placed exactly, 1 placed roughly \(a close match, or the middle of their ZIP\), 0 waiting, 0 with no place\./)
    .waitFor();
  expect(
    'admin geocode',
    await admin.getByRole('button', { name: 'Nobody is waiting' }).isDisabled(),
    'with nobody waiting the button is off',
  );
  await admin.getByText('The geocoder could not place (1)').click();
  const unplacedTable = admin.getByRole('region', { name: 'People the geocoder could not place' });
  const unplacedRow = unplacedTable.getByRole('row', { name: /Nora Nowhere/ });
  await unplacedRow.waitFor();
  expect('admin geocode', /Middle of their ZIP/.test((await unplacedRow.textContent()) ?? ''), 'the list should say what she has for now');
  await check(admin, 'admin geocode');
  // Place her by hand: the list stays open, she is counted as placed exactly, and an admin can take it away again.
  await unplacedRow.getByLabel('Latitude and longitude for Nora Nowhere').fill('33.43, -111.96');
  await unplacedRow.getByRole('button', { name: 'Set the place of Nora Nowhere' }).click();
  await admin.getByText('Placed Nora Nowhere.').waitFor();
  await admin.getByText(/placed exactly \(1 by hand\)/).waitFor();
  const handRow = unplacedTable.getByRole('row', { name: /Nora Nowhere/ });
  await handRow.waitFor();
  expect('admin geocode', /Placed by hand/.test((await handRow.textContent()) ?? ''), 'the list should say she was placed by hand');
  expect(
    'admin geocode',
    (await handRow.getByLabel('Latitude and longitude for Nora Nowhere').inputValue()) === '33.43, -111.96',
    'and show where',
  );
  await check(admin, 'admin placed by hand');
  await handRow.getByLabel('Latitude and longitude for Nora Nowhere').fill('somewhere near Tempe');
  await handRow.getByRole('button', { name: 'Set the place of Nora Nowhere' }).click();
  await admin.getByText(/Write latitude, then longitude/).waitFor();
  await handRow.getByRole('button', { name: 'Take away the place of Nora Nowhere' }).click();
  await admin.getByText('Took away the place of Nora Nowhere.').waitFor();
  // The toast comes before the list is asked again, so wait for the row to change rather than read it at once.
  await unplacedTable
    .getByRole('row', { name: /Nora Nowhere/ })
    .getByText(/No place/)
    .waitFor();
  const [download] = await Promise.all([
    admin.waitForEvent('download'),
    admin.getByRole('button', { name: 'Download the list as a CSV' }).click(),
  ]);
  expect('admin geocode', download.suggestedFilename() === 'unplaced-addresses.csv', 'the list should download as a CSV');
  await admin.getByRole('button', { name: 'Look up the unplaced again' }).click();
  await admin.getByText(/Looked up 1 address: 0 placed/).waitFor();

  // The grace period saves, and shows after a reload.
  await admin.getByLabel('Uploads a contacted person may stay on the list').fill('0');
  await admin.getByRole('button', { name: 'Save', exact: true }).click();
  await admin.getByText('Saved: 0 uploads of grace.').waitFor();
  await admin.reload();
  await admin.getByRole('heading', { name: 'Unsuccessful cures' }).waitFor();
  expect(
    'admin settings',
    (await admin.getByLabel('Uploads a contacted person may stay on the list').inputValue()) === '0',
    'the grace was not kept',
  );
  await check(admin, 'admin settings');

  // A bad file is explained, not swallowed.
  await admin.getByLabel('CSV file').setInputFiles({ name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from('NAME,CITY\nA,B\n') });
  await admin.getByRole('button', { name: 'Check the file' }).click();
  await admin.getByText(/missing the columns FIRST, LAST, ADDRESS/).waitFor();
  // The file's columns are shown, open, so the admin can say which is which.
  await admin.getByText(/Columns: 0 of 10 matched/).waitFor();
  await check(admin, 'admin bad upload');

  // A sheet whose first and last name columns are renamed reads once the admin matches them.
  const renamed = sheetCsv([{ first: 'Rae', last: 'Roe', address: '7 W NEW ST TEMPE, AZ 85281' }]).replace(
    'FIRST,MID,LAST',
    'Given,MID,Family',
  );
  await admin.getByLabel('CSV file').setInputFiles({ name: 'renamed.csv', mimeType: 'text/csv', buffer: Buffer.from(renamed) });
  await admin.getByRole('button', { name: 'Check the file', exact: true }).click();
  await admin.getByText(/missing the columns FIRST, LAST/).waitFor();
  await admin.getByLabel('First name (needed)').selectOption('Given');
  await admin.getByLabel('Last name (needed)').selectOption('Family');
  await admin.getByRole('button', { name: 'Check the file again' }).click();
  await admin.getByText('Newly cured').waitFor();
  expect(
    'admin columns',
    /^New people1/.test((await admin.locator('.tiles').first().textContent()) ?? ''),
    'the matched columns did not read',
  );
  await check(admin, 'admin columns matched');

  // A corrected last name looks like one person gone and a stranger new. Marking them as the same person changes the counts: nobody is
  // cured or added, and the record would be updated instead.
  const corrected = day2.map((p) => (p.first === 'Newt' ? { ...p, last: 'Newmann' } : p));
  await admin
    .getByLabel('CSV file')
    .setInputFiles({ name: 'corrected.csv', mimeType: 'text/csv', buffer: Buffer.from(sheetCsv(corrected)) });
  await admin.getByRole('button', { name: 'Check the file', exact: true }).click();
  await admin.getByText('Possible matches').waitFor();
  expect(
    'admin matches',
    /^New people1/.test((await admin.locator('.tiles').first().textContent()) ?? ''),
    'the corrected name should look like a new person',
  );
  await admin.getByLabel(/Newt Newman and Newt Newmann are the same person/i).check();
  await admin.getByText(/^New people0/).waitFor();
  expect(
    'admin matches',
    /Newly cured0/.test((await admin.locator('.tiles').first().textContent()) ?? ''),
    'marked as the same person, nobody is cured',
  );
  expect(
    'admin matches',
    await admin.getByLabel(/Newt Newman and Newt Newmann are the same person/i).isChecked(),
    'the mark stays after the page is drawn again',
  );
  await check(admin, 'admin possible matches');

  // Find someone and move them; the audit log shows it.
  await admin.getByLabel('Name, street or phone').fill('newman');
  const row = admin.getByRole('row', { name: /Newt Newman/ });
  await row.getByRole('combobox').selectOption({ label: 'Ada Admin' });
  await admin.getByText(/Newt Newman now belongs to Ada Admin/).waitFor();
  await admin
    .getByRole('cell', { name: /moved from the pool to Ada Admin/ })
    .first()
    .waitFor();
  await check(admin, 'admin after a move');
  await admin.setViewportSize({ width: 375, height: 812 });
  await check(admin, 'admin (phone)');

  // ---- a precinct organizer: shut out until an admin grants them precincts, then a trimmed admin page
  const organizerCtx = await context('olive@example.com');
  const organizer = await organizerCtx.newPage();
  watch(organizer, 'organizer', [403]); // the admin page is refused with a 403 until the grant
  await organizer.goto(`${base}/`);
  await organizer.getByLabel('Your name').fill('Olive Organizer');
  await organizer.getByRole('button', { name: 'Continue' }).click();
  await organizer.getByRole('link', { name: 'Find people to call' }).waitFor();
  expect(
    'organizer',
    !(await organizer.getByRole('link', { name: 'Admin', exact: true }).isVisible()),
    'the Admin link is shown before a grant',
  );
  const refused = await organizer.goto(`${base}/admin/`);
  expect('organizer', refused?.status() === 403, `the admin page answered ${refused?.status()} before a grant`);
  await admin.setViewportSize({ width: 1280, height: 800 });
  await admin.goto(`${base}/admin/`);
  await admin.getByRole('heading', { name: 'Who organizes precincts' }).waitFor();
  await check(admin, 'admin: who organizes');
  // The list of "Move all open people to" floats over the page: it does not make its row or the table any bigger.
  const moveTo = admin.getByLabel(/^Move everyone .* has open to$/).first();
  const moveRow = moveTo.locator('xpath=ancestor::tr');
  const rowBefore = await moveRow.evaluate((el) => el.getBoundingClientRect().height);
  const tableBefore = await moveRow.evaluate((el) => el.closest('.fl-table-wrap')?.scrollWidth ?? 0);
  await moveTo.click();
  const floating = admin.locator('.combo-float:not([hidden])').first();
  await floating.waitFor();
  expect('combobox', (await floating.evaluate((el) => getComputedStyle(el).position)) === 'fixed', 'the list is not floating');
  expect(
    'combobox',
    (await moveRow.evaluate((el) => el.getBoundingClientRect().height)) === rowBefore,
    'the row grew when the list opened',
  );
  expect(
    'combobox',
    (await moveRow.evaluate((el) => el.closest('.fl-table-wrap')?.scrollWidth ?? 0)) === tableBefore,
    'the table got wider when the list opened',
  );
  await moveTo.press('Escape');

  await admin.getByRole('button', { name: 'Change what Olive Organizer organizes' }).click();
  await check(admin, 'admin: change what a volunteer organizes');
  // Precincts are picked from the district's list, one at a time, and show as buttons that take one away.
  await admin.getByLabel('Or only these precincts').fill('Alma');
  await admin.locator('.combo-float:not([hidden]) [role="option"]').first().click();
  await admin
    .getByRole('button', { name: /^Remove / })
    .first()
    .waitFor();
  await admin
    .getByRole('button', { name: /^Remove / })
    .first()
    .click();
  await admin.getByLabel('All precincts').check();
  await admin.getByRole('button', { name: 'Save access' }).click();
  await admin.getByText('Saved what Olive Organizer organizes.').waitFor();
  await organizer.goto(`${base}/`);
  await organizer.getByRole('link', { name: 'Admin', exact: true }).click();
  await organizer.getByRole('heading', { name: 'Where things stand' }).waitFor();
  await organizer.getByRole('heading', { name: 'Find someone and move them' }).waitFor();
  for (const only of ['Upload the state’s sheet', 'Who organizes precincts', 'Audit log', 'Unsuccessful cures'])
    expect('organizer', (await organizer.getByRole('heading', { name: only }).count()) === 0, `${only} is shown to an organizer`);
  await check(organizer, 'admin (organizer)');
  await organizerCtx.close();
  await adminCtx.close();

  // ---- the data agrees with what the browser did
  const cured = sqlite.prepare("SELECT COUNT(*) AS n FROM people WHERE status = 'cured'").get();
  expect('database', Number(cured?.n) === 3, `${cured?.n} cured, wanted 3`);

  // ---- dark mode: a new volunteer's welcome, then the pages with data on them
  const dora = await context('dora@example.com', { dark: true, phone: true });
  const doraPage = await dora.newPage();
  watch(doraPage, 'dark volunteer');
  await doraPage.goto(`${base}/`);
  await doraPage.getByLabel('Your name').waitFor();
  expect('dark', await doraPage.locator('.logo--dark').isVisible(), 'the dark logo is not shown in a dark browser');
  expect('dark', !(await doraPage.locator('.logo--light').isVisible()), 'the light logo is shown in a dark browser');
  // The header's theme switch overrides the browser and is remembered across pages.
  await doraPage.locator('#who').click();
  await doraPage.getByLabel('Theme').selectOption('light');
  expect('light', await doraPage.locator('.logo--light').isVisible(), 'the switch to light did not show the light logo');
  await doraPage.goto(`${base}/pool/`);
  expect('light', (await doraPage.locator('html').getAttribute('data-theme')) === 'light', 'the chosen theme was not kept');
  await doraPage.locator('#who').click();
  await doraPage.getByLabel('Theme').selectOption('auto');
  await doraPage.goto(`${base}/`);
  await doraPage.getByLabel('Your name').waitFor();
  await check(doraPage, 'welcome (dark)');
  await doraPage.getByLabel('Your name').fill('Dora Dale');
  await doraPage.getByRole('button', { name: 'Continue' }).click();
  await doraPage.getByText('You don’t have anybody yet.').waitFor();
  await doraPage.goto(`${base}/pool/`);
  await doraPage.getByText(/Showing 30 people/).waitFor();
  await doraPage
    .locator('.pool-row')
    .first()
    .getByRole('button', { name: /^Claim / })
    .click();
  await doraPage.getByText(/is on your list now/).waitFor();
  await check(doraPage, 'find people (dark)');
  await doraPage.goto(`${base}/map/`);
  await mapDrawn(doraPage, 'map (dark)');
  await check(doraPage, 'map (dark)');
  await doraPage.goto(`${base}/`);
  await doraPage.locator('.people > li').first().waitFor();
  await check(doraPage, 'my people (dark)');
  await dora.close();

  const darkAdmin = await context(DEV_ADMIN, { dark: true });
  const darkAdminPage = await darkAdmin.newPage();
  watch(darkAdminPage, 'dark admin');
  await darkAdminPage.goto(`${base}/admin/`);
  await darkAdminPage.getByRole('heading', { name: 'Audit log' }).waitFor();
  await check(darkAdminPage, 'admin (dark)');

  // Start over: the dialog asks first, Keep them changes nothing, and the second time everything goes.
  const peopleCount = () => Number(sqlite.prepare('SELECT COUNT(*) AS n FROM people').get()?.n);
  const before = peopleCount();
  expect('reset', before > 0, 'there are no voters to reset');
  const dialog = darkAdminPage.getByRole('alertdialog');
  await darkAdminPage.getByRole('button', { name: 'Delete all voters' }).click();
  await dialog.waitFor();
  await check(darkAdminPage, 'admin reset dialog (dark)');
  await dialog.getByRole('button', { name: 'Keep them' }).click();
  await dialog.waitFor({ state: 'hidden' });
  expect('reset', peopleCount() === before, 'Keep them deleted voters');
  await darkAdminPage.getByRole('button', { name: 'Delete all voters' }).click();
  await dialog.getByRole('button', { name: 'Delete all voters' }).click();
  await darkAdminPage.getByText(/Deleted \d+ voters and \d+ notes?\./).waitFor();
  expect('reset', peopleCount() === 0, 'the voters were not deleted');
  await darkAdminPage.getByText('Nothing has been uploaded yet.').waitFor();
  await check(darkAdminPage, 'admin after reset (dark)');
  await darkAdmin.close();

  // ---- a missing page is a 404 page with the site's chrome
  const nowhere = await context('vera@example.com');
  const nowherePage = await nowhere.newPage();
  watch(nowherePage, '404', [404]);
  const res = await nowherePage.goto(`${base}/nowhere`);
  expect('404', res?.status() === 404, `status ${res?.status()}`);
  await nowherePage.getByRole('heading', { name: 'Page not found' }).waitFor();
  await check(nowherePage, '404');
  await nowhere.close();
} catch (e) {
  problems.push(`stopped: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await browser.close();
  server.close();
}

for (const [label, n] of ignored) console.log(`ignored ${n}x (browser quirk): ${label}`);
if (problems.length) {
  console.log(`PROBLEMS:\n${[...new Set(problems)].join('\n')}`);
  process.exit(1);
}
console.log('smoke: ok');
