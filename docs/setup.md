# Setting it up on Cloudflare (by hand)

Agents cannot do any of this: there are no Cloudflare credentials in the VM. Avi or another Cloudflare admin runs these steps from a machine that is logged in with `npx wrangler login`.

## 1. The database

```bash
npx wrangler d1 create cure-tracker
```

Copy the `database_id` it prints into `wrangler.jsonc` (it is not a secret), then create the tables:

```bash
npm run db:migrate
```

A later schema change is a new file in `db/migrations/`; run the same command again.

## 2. Access (Zero Trust)

1. **Zero Trust dashboard, Settings, Authentication, Login methods.** Add **One-time PIN** (needs nothing else) and Google, if volunteers with Google accounts should use it. Volunteers without a Google account sign in with a PIN emailed to them.
2. **Access, Applications, Add, Self-hosted.** Name `cure-tracker`, domain `azld8cures.com` (the route in `wrangler.jsonc`), no path. A custom domain keeps Access and the Worker on one hostname; Cloudflare can also put Access in front of a `*.workers.dev` address, but that is a separate switch with its own audience tag. Session duration: the length of the campaign push is fine.
3. **Policy:** Action Allow, Include **Emails**, one entry per volunteer and admin. Access's free plan covers 50 users. A person not in the policy never reaches the app.
4. Open the application's settings and copy the **Application Audience (AUD) Tag** and your **team domain** (`yourteam.cloudflareaccess.com`).
5. Put them in `wrangler.jsonc` under `vars`: `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`. They are not secrets. While either is empty, the Worker refuses every request.
6. Set the admins as a Worker secret, not in the repo: `npx wrangler secret put ADMIN_EMAILS` (if it offers to create the Worker first, say yes), and paste the admins' emails, comma-separated. It applies at once, with no deploy, and a later `wrangler deploy` keeps it. To change the admins, run the same command with the new list. While the secret is missing nobody is an admin: the admin pages and routes refuse everyone.

Roles: an email in the Access policy is a volunteer; an email also in `ADMIN_EMAILS` is an admin. Adding a volunteer is adding their email to the policy; removing one is removing it (and, to end a session that has not expired, revoking it under Access, Users). Changing `ADMIN_EMAILS` is `wrangler secret put` again, not a deploy.

## 3. Deploy

The custom domain route is already in `wrangler.jsonc` (`azld8cures.com`). Before the first deploy the zone must be on this Cloudflare account, and the name must have no DNS record of its own (a parked-page A or CNAME record on the apex would make the deploy fail: delete it first). The deploy then creates the DNS record and the certificate. Then:

```bash
npm ci
npm run deploy
```

Check it: open the site and sign in (you should see the welcome page asking for your name), then `/admin/` as an admin. A request that skips Access (the `workers.dev` hostname is off, `workers_dev: false`) gets the Worker's own 403.

## 4. Deploys on merge (optional)

The repository is public, so GitHub's standard runners are free, and `ci-proposed/` has two workflows:

- `ci.yml` runs on every pull request: `checks` (typecheck, tests, Biome) and `smoke` in Chromium, Firefox and WebKit (Safari's engine) in parallel, with Lighthouse alongside Chromium. Require `checks`, `smoke (chromium)`, `smoke (firefox)` and `smoke (webkit)` before merging.
- `deploy.yml` runs when something is merged to `main` and deploys the Worker. Run by hand (Actions > deploy > Run workflow) it redeploys `main`.

To use them: move both to `.github/workflows/`, create a `production` environment that allows only the `main` branch, and add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` to it as secrets (a token limited to editing Workers Scripts on this account). The deploy does not run database migrations: run `npm run db:migrate` by hand before merging a change that adds one.

The repository being public means everything in it is public. Nothing here is secret: the Access team domain and audience tag in `wrangler.jsonc` are not (the Worker checks the token's signature, not these values), the admins' emails are a Worker secret, and voter data never goes in the repo. The `pull_request` workflow gets no secrets for pull requests from forks.

## 5. Before the real data: turn the reset off

`ALLOW_RESET` in `wrangler.jsonc` starts as `"true"`, so admins can use **Start over** to delete every voter while you play with test data. Before the real sheet goes in, set it to `"false"` and deploy (`npm run deploy`): the reset route then refuses and the button is gone. If a reset happens by mistake with it on, restore the database (see Backups).

## 6. First upload

Sign in as an admin, open **Admin**, choose the CSV of the LD8 sheet, press **Check the file**, read the counts, then **Upload this file**. See `docs/spec.md` for what the checks mean.

## 7. The map's tiles (R2)

The Map page draws pins from the database and a street map from one file, `ld8.pmtiles`, kept in an R2 bucket and served by the Worker behind Access. Do the first step **before the next deploy**: `wrangler.jsonc` binds the bucket, and a deploy fails while it does not exist. The page works without the file (it says the street map is not set up and draws only the pins), so steps 2 to 4 can come later.

1. Create the bucket (R2 may ask you to turn it on for the account in the dashboard first; the free allowance of 10 GB stored and a million reads a month is far more than this needs):

```bash
npx wrangler r2 bucket create cure-tracker-tiles
```

2. Cut the file. Install the [`pmtiles` command-line tool](https://github.com/protomaps/go-pmtiles/releases), find the newest build's filename at https://maps.protomaps.com/builds (the daily builds keep a week), and extract the box around LD8: the Census's 2026 boundary for Arizona State Senate District 8 (`-112.0129,33.3765,-111.6399,33.5816`) plus about two miles. First ask how big it will be, with `--dry-run`:

```bash
pmtiles extract https://build.protomaps.com/YYYYMMDD.pmtiles ld8.pmtiles --bbox=-112.04,33.35,-111.61,33.61 --maxzoom=14 --dry-run
pmtiles extract https://build.protomaps.com/YYYYMMDD.pmtiles ld8.pmtiles --bbox=-112.04,33.35,-111.61,33.61 --maxzoom=14
```

A few tens of megabytes is normal. Each zoom level roughly doubles it, so if it is large, lower `--maxzoom` (the map draws the last level larger past it, so the streets only get blurrier).

3. Upload it (an R2 object may be up to about 5 GB; wrangler uploads up to 300 MiB in one go, which this is well under):

```bash
npx wrangler r2 object put cure-tracker-tiles/ld8.pmtiles --file ld8.pmtiles --content-type application/octet-stream --remote
```

4. Reload the Map page: the street map shows. Write the build date, the box and the file's size in `vendor/README.md`. To replace the file later, run step 3 again; browsers keep the old one for up to a day.

## Backups

There are none on purpose. D1 Time Travel keeps 30 days of history and restores to any minute:

```bash
npx wrangler d1 time-travel info cure-tracker
npx wrangler d1 time-travel restore cure-tracker --timestamp=2026-10-24T17:00:00Z
```

Restoring replaces the whole database in place, so anything done after that minute (claims, notes, uploads) is lost. `wrangler d1 time-travel restore` prints the bookmark it replaced, so a restore can itself be undone.

## After the election

Delete the Access application, the Worker (`npx wrangler delete`) and the D1 database. The voters' names, phones and addresses should not outlive the campaign.

## Trying the site at full size with made-up voters

`npm run synthetic -- --people 10000` writes `synthetic-sheet.csv`: a believable sheet in the real column layout, with every name, street and phone number invented (the phone numbers are in the 555-0100 to 555-0199 range reserved for fiction, so a volunteer who taps one will not ring a stranger; the streets and cities are real names with made-up house numbers). It also writes some rows for other districts and some repeated rows, to see the importer leave them out. `--day2` writes the next day's sheet from the same `--seed`: some people gone, some new, some changed, some addresses written another way (`APT 12` as `12`, `STREET` for `ST`, ZIP+4) and a few last names corrected, to see re-uploads and possible matches. Upload the first on the admin page, and the second a day later or straight after. When you are done, use **Start over** on the admin page to delete every voter, note and upload (D1 Time Travel still holds the made-up data for 30 days). The CSVs are gitignored; they never go in the repo.

