# What is vendored, and who tracks it

Code and data that ships to a browser, and how it stays current. Dependabot (`.github/dependabot.yml`) only sees npm packages and the
GitHub Actions in the workflows, so anything copied in by hand is listed here.

| What | Where | Tracked by |
|---|---|---|
| Frostline components | `vendor/frostline/` (see its README) | By hand, copied from avi.me's Frostline |
| `maplibre-gl`, `pmtiles` (planned, for the map) | npm dev dependencies, built into `public/` by `tools/build.sh` | Dependabot |
| Basemap glyph and sprite files (planned) | from Protomaps' `basemaps-assets`, not on npm | By hand: record the version and source here when added |
| The `.pmtiles` extract of LD8 (planned) | a dated Protomaps planet build, cut with `pmtiles extract` | By hand: record the build date and the boundary used here when added |

See `docs/decisions.md` (16) for why.
