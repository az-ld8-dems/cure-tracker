// Fetches the outline of Arizona State Senate District 8 (the Census's 2026 boundary, from TIGERweb) and saves it as public/map/ld8.json for
// the map to draw. It is public geometry, not voter data, so the file is committed; run this again only if the district is redrawn:
//   node tools/fetch-ld8.ts
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

const url = new URL('https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Legislative/MapServer/1/query');
url.search = new URLSearchParams({
  where: "STATE='04' AND SLDU='008'",
  outFields: 'NAME,GEOID',
  outSR: '4326',
  // About 20 meters: plenty for an outline drawn over a city, and the file stays a few kilobytes.
  maxAllowableOffset: '0.0002',
  geometryPrecision: '5',
  f: 'geojson',
}).toString();

const res = await fetch(url);
assert.ok(res.ok, `TIGERweb answered ${res.status}`);
const body: { features?: { geometry?: { type?: string } }[] } = await res.json();
assert.equal(body.features?.length, 1, 'exactly one district came back');
const type = body.features?.[0]?.geometry?.type;
assert.ok(type === 'Polygon' || type === 'MultiPolygon', `the district is a polygon (got ${type})`);

const out = new URL('../public/map/ld8.json', import.meta.url);
writeFileSync(out, `${JSON.stringify(body)}\n`);
console.log(`wrote ${out.pathname}`);
