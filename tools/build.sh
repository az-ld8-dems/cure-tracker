#!/bin/sh
# Compiles the frontend TypeScript in src/ to public/js/ (gitignored). Run by the dev server, the smoke and Lighthouse tools and CI.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
tsc=$root/node_modules/.bin/tsc
[ -x "$tsc" ] || { echo "tools/build.sh: TypeScript is not installed (run npm ci)" >&2; exit 1; }
"$tsc" -p "$root/src"
