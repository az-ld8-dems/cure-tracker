# cure-tracker

Assigns LD8 volunteers to voters whose ballots need curing, so nobody calls the same person twice. It replaces a shared Google Sheet that could not give volunteers and admins different permissions. An internal tool that lives a couple of weeks.

- **Volunteers** see the people they have claimed (status, how they reached them, notes), a pool of people nobody has claimed that they can filter by city, precinct and party, and a Claim button.
- **Admins** upload the state's sheet (the LD8 tab as CSV) whenever new data arrives, see how curing is going per volunteer, answer flagged people, move people between volunteers and read the audit log.
- Everyone signs in through Cloudflare Access (Google, or a one-time PIN by email for volunteers without a Google account). Everyone sees every person; volunteers change only their own claims.

How it works is in [docs/spec.md](docs/spec.md); setting it up on Cloudflare is in [docs/setup.md](docs/setup.md); how it looks, and which design system supplies what, is in [docs/design.md](docs/design.md). Agents read [CLAUDE.md](CLAUDE.md).

## Stack

One Cloudflare Worker serves the static pages, a JSON API and the Access check, on one D1 database. TypeScript, Biome, npm, no runtime dependencies.

```
worker/      the Worker: access.ts (Access JWT check), api.ts, import.ts (the sheet), uploads.ts
src/         the pages' TypeScript, compiled to public/js/ by tools/build.sh
public/      HTML, CSS, fonts, logos
vendor/frostline/   a copy of avi.me's Frostline components (docs/design.md)
db/migrations/   D1 schema
tools/       dev server, tests, smoke test, Lighthouse
```

## Working on it

```bash
npm ci
npm run dev -- --admin      # http://localhost:8080 on synthetic data; /__as?email=you@example.com switches user
npm run typecheck && npm test && npm run check
npx playwright install chromium   # once
npm run smoke && npm run lighthouse
```

`npm run dev` stands in for Access with a cookie and seeds 60 made-up people through the real upload path. Deploying is by hand (`docs/setup.md`).
