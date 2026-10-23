# Decisions

1. **One Worker, one D1 database, no framework** (2026-10-23, Avi). Serves the pages, the API and the Access check. A couple of weeks of life does not justify more.
2. **No backups; D1 Time Travel only** (Avi). 30 days of point-in-time restore covers the lifetime of the app.
3. **Access for sign-in, with one-time PIN for volunteers without Gmail** (Avi). Emails go in the Access policy. Admins are `ADMIN_EMAILS` in `wrangler.jsonc`, because the Cloudflare team can add volunteers and no app-side user table is needed. About 20 volunteers fits Access's free tier.
4. **Everyone sees everything** (Avi). The current sheet works that way; the app adds who may change what, not who may see what.
5. **People are keyed by normalized first name, last name and address** (Avi). The state's sheets do not reliably carry a voter id. Near-misses are reported on upload, never merged.
6. **Only an upload cures** (Avi). A volunteer's "Contacted" is a claim; the state's data is the verification. A contacted person still on a later sheet is flagged for the admin and returns to needs-contact with the same volunteer.
7. **Claims do not expire and are not capped** (Avi). Volunteers and admins can release them.
8. **No distance sorting** (Avi). Addresses only, no geocoding. Sort by days uncured, city, precinct, party or name.
9. **JavaScript is allowed** (Avi). The design system's no-JS rule is for the public site; this is an internal tool. The CSP stays `'self'`.
10. **CSV upload, not xlsx** (Avi). The admin exports the LD8 tab; parsing xlsx without dependencies is fragile.
11. **One Chromium browser in CI** (this repo). It is an internal tool for staff and volunteers; WebKit and Firefox smoke runs are `SMOKE_BROWSER=webkit|firefox` away if needed.
