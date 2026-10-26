#!/bin/sh
# Builds what is not committed (all gitignored): the frontend TypeScript in src/ to public/js/, and the vendored Frostline's script
# (vendor/frostline/components/bundle.ts) to bundle.js, then both of its component files into public/frostline/<version>/components/,
# the versioned folder the pages link. Run by the dev server, the smoke and Lighthouse tools and CI.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
tsc=$root/node_modules/.bin/tsc
[ -x "$tsc" ] || { echo "tools/build.sh: TypeScript is not installed (run npm ci)" >&2; exit 1; }
"$tsc" -p "$root/vendor/frostline"
"$tsc" -p "$root/src"
ver=$(cat "$root/vendor/frostline/VERSION")
rm -rf "$root/public/frostline"
mkdir -p "$root/public/frostline/$ver/components"
cp "$root/vendor/frostline/components/bundle.css" "$root/vendor/frostline/components/bundle.js" "$root/public/frostline/$ver/components/"
# The map: MapLibre (its module and the worker file it loads beside itself), the PMTiles reader, the basemap styles and the vendored glyphs,
# all served from our own origin (the CSP allows nothing else).
lib=$root/public/lib
rm -rf "$lib"
mkdir -p "$lib"
# Copied as .js, which every static server knows to serve as JavaScript (.mjs is not always); the worker's address is set in src/map.ts.
cp "$root/node_modules/maplibre-gl/dist/maplibre-gl.mjs" "$lib/maplibre-gl.js"
cp "$root/node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs" "$lib/maplibre-gl-worker.js"
cp "$root/node_modules/maplibre-gl/dist/maplibre-gl.css" "$lib/"
# The PMTiles reader imports fflate by its bare name, which a browser cannot resolve without an import map (an inline script, which the CSP
# refuses), so its import is pointed at our copy of fflate.
sed 's#from"fflate"#from"/lib/fflate.js"#' "$root/node_modules/pmtiles/dist/esm/index.js" >"$lib/pmtiles.js"
cp "$root/node_modules/fflate/esm/browser.js" "$lib/fflate.js"
cp -R "$root/vendor/map-fonts" "$lib/fonts"
node "$root/tools/map-style.ts"
