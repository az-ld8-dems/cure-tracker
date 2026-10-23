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
2. **Access, Applications, Add, Self-hosted.** Name `cure-tracker`, the domain you will deploy to (a `*.workers.dev` hostname does not work with Access in the same way; use a custom domain such as `cure.example.org`), no path. Session duration: the length of the campaign push is fine.
3. **Policy:** Action Allow, Include **Emails**, one entry per volunteer and admin. Access's free plan covers 50 users. A person not in the policy never reaches the app.
4. Open the application's settings and copy the **Application Audience (AUD) Tag** and your **team domain** (`yourteam.cloudflareaccess.com`).
5. Put them in `wrangler.jsonc` under `vars`: `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`, and list the admins' emails in `ADMIN_EMAILS` (comma-separated). None of them are secrets. While `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is empty, the Worker refuses every request.

Roles: an email in the Access policy is a volunteer; an email also in `ADMIN_EMAILS` is an admin. Adding a volunteer is adding their email to the policy; removing one is removing it (and, to end a session that has not expired, revoking it under Access, Users). Changing `ADMIN_EMAILS` needs a deploy.

## 3. Deploy

Add the custom domain route in `wrangler.jsonc` (`"routes": [{ "pattern": "cure.example.org", "custom_domain": true }]`), then:

```bash
npm ci
npm run deploy
```

Check it: open the site and sign in (you should see the welcome page asking for your name), then `/admin/` as an admin. A request that skips Access (the `workers.dev` hostname is off, `workers_dev: false`) gets the Worker's own 403.

## 4. Releases (optional)

`ci-proposed/release.yml` runs the full CI (WebKit, Chromium and Firefox) on a `v*` tag and then deploys. To use it: move `ci-proposed/ci.yml` and `release.yml` to `.github/workflows/`, create a `production` environment that allows tags `v*`, add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` to it as secrets (a token limited to Workers Scripts edit on this account), and tag a commit on `main` (`git tag v0.1.0 && git push origin v0.1.0`). Run `npm run db:migrate` by hand first when the release adds a migration. **Actions > release > Run workflow** runs the same checks on any branch without deploying.

## 5. First upload

Sign in as an admin, open **Admin**, choose the CSV of the LD8 sheet, press **Check the file**, read the counts, then **Upload this file**. See `docs/spec.md` for what the checks mean.

## Backups

There are none on purpose. D1 Time Travel keeps 30 days of history and restores to any minute:

```bash
npx wrangler d1 time-travel info cure-tracker
npx wrangler d1 time-travel restore cure-tracker --timestamp=2026-10-24T17:00:00Z
```

Restoring replaces the whole database in place, so anything done after that minute (claims, notes, uploads) is lost. `wrangler d1 time-travel restore` prints the bookmark it replaced, so a restore can itself be undone.

## After the election

Delete the Access application, the Worker (`npx wrangler delete`) and the D1 database. The voters' names, phones and addresses should not outlive the campaign.
