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
