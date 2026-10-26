// Writes the map's two styles (light and dark) to public/lib/ from the Protomaps basemap's own layer list (@protomaps/basemaps), run by
// tools/build.sh. The styles name the tile file by our own path, the glyphs by our own folder, and have no sprite: layers that draw an
// icon (points of interest, road shields) are left out, and the labels that remain are text.
import { mkdirSync, writeFileSync } from 'node:fs';
import { layers, namedFlavor } from '@protomaps/basemaps';

const out = new URL('../public/lib/', import.meta.url);
mkdirSync(out, { recursive: true });

for (const flavor of ['light', 'dark']) {
  const style = {
    version: 8,
    glyphs: '/lib/fonts/{fontstack}/{range}.pbf',
    sources: {
      protomaps: {
        type: 'vector',
        url: 'pmtiles:///tiles/ld8.pmtiles',
        attribution: '<a href="https://openstreetmap.org/copyright">© OpenStreetMap</a>',
      },
    },
    layers: layers('protomaps', namedFlavor(flavor), { lang: 'en' }).filter(
      (l) => !('layout' in l && l.layout && 'icon-image' in l.layout),
    ),
  };
  writeFileSync(new URL(`style-${flavor}.json`, out), `${JSON.stringify(style)}\n`);
}
