# What is vendored, and who tracks it

Code and data that ships to a browser, and how it stays current. Dependabot (`.github/dependabot.yml`) only sees npm packages and the
GitHub Actions in the workflows, so anything copied in by hand is listed here.

| What | Where | Tracked by |
|---|---|---|
| Frostline components | `vendor/frostline/` (see its README) | By hand, copied from avi.me's Frostline |
| `maplibre-gl`, `pmtiles`, `@protomaps/basemaps` (the map) | npm dev dependencies, copied or compiled into `public/lib/` by `tools/build.sh` (`fflate`, which `pmtiles` needs, comes with it) | Dependabot |
| Basemap glyph files: Noto Sans Regular, Medium and Italic, ranges 0-255, 256-511 and 8192-8447 (Latin, accented letters and punctuation); no sprite | `vendor/map-fonts/`, from https://protomaps.github.io/basemaps-assets/fonts/ (the `basemaps-assets` repository, commit `028c18f713baecad011301ff7a69acc39bcc2ae7`, fetched 2026-10-26); Noto Sans is under the SIL Open Font License 1.1 | By hand: a different language or a symbol on the map needs more ranges; `tools/map-style.ts` lists the fonts the layers use |
| The `.pmtiles` extract of LD8 | R2 bucket `cure-tracker-tiles`, object `ld8.pmtiles`: a dated Protomaps planet build cut with `pmtiles extract` (`docs/setup.md`, 7) | By hand: record the build date, the box and the size here when uploaded |

See `docs/decisions.md` (16) for why.
