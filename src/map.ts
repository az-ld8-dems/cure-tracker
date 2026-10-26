// "Map": the open pool as pins on a map of LD8. A solid dot is a place the geocoder found (or an admin set); a ring is a guess (the middle of
// a ZIP, or a match the Census calls non-exact). Pick a pin to see the person and claim them. MapLibre and the PMTiles reader are served from
// /lib (tools/build.sh), the tiles by the Worker from R2, so the page loads nothing from anywhere else. The map is a canvas, so the list on
// Find people is the way in for anyone who cannot use it.
import type { GeoJSONSource, MapGeoJSONFeature, Map as MapLibreMap } from '/lib/maplibre-gl.js';
import type { MapPins, Person, PersonDetail } from './api.d.ts';
import {
  $,
  addressText,
  api,
  banner,
  boot,
  clear,
  daysText,
  failureText,
  flagBadge,
  h,
  personName,
  statusBadge,
  titleCase,
  toast,
} from './common.ts';
import { createFilters } from './filters.ts';

// LD8 as the Census draws it (Arizona State Senate District 8, 2026), and the box the pins are asked for and the map may show: the
// district with about two miles around it. The tile file is cut to the same box.
interface FeatureCollection {
  type: 'FeatureCollection';
  features: {
    type: 'Feature';
    properties: { id: number; approximate: number };
    geometry: { type: 'Point'; coordinates: [number, number] };
  }[];
}

type YouCollection = {
  type: 'FeatureCollection';
  features: { type: 'Feature'; properties: Record<string, never>; geometry: { type: 'Point'; coordinates: [number, number] } }[];
};

const DISTRICT: [number, number, number, number] = [-112.0129, 33.3765, -111.63987, 33.58157];
const EDGE: [number, number, number, number] = [-112.04, 33.35, -111.61, 33.61];
const TILES_URL = `${location.origin}/tiles/ld8.pmtiles`;

const idle = (): Promise<void> =>
  new Promise((resolve) =>
    typeof requestIdleCallback === 'function' ? requestIdleCallback(() => resolve(), { timeout: 2000 }) : setTimeout(resolve, 200),
  );

const me = await boot();
const app = $('#app');

if (me) {
  const myId = me.id;
  const theme = (): 'light' | 'dark' => {
    const set = document.documentElement.getAttribute('data-theme');
    if (set === 'light' || set === 'dark') return set;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  };
  // The pins' colors are the page's own tokens, so the map, the legend and both themes agree.
  const token = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  let pins: MapPins | null = null;
  let map: MapLibreMap | null = null;
  let picked: number | null = null;

  const status = h('p', { class: 'fl-help', role: 'status', id: 'map-status' });
  const frame = h('div', { class: 'map-frame', id: 'map', role: 'region', 'aria-label': 'Map of voters who need their ballot cured' });
  const detail = h('div', { class: 'fl-stack fl-stack--3', id: 'picked', tabindex: '-1' });
  const youLegend = h(
    'li',
    { hidden: me.location === null },
    h('span', { class: 'pin pin--you', 'aria-hidden': 'true' }),
    'You (the place you saved, to about a mile)',
  );
  const legend = h(
    'ul',
    { class: 'map-legend', 'aria-label': 'Legend' },
    h('li', {}, h('span', { class: 'pin', 'aria-hidden': 'true' }), 'Address found'),
    h('li', {}, h('span', { class: 'pin pin--guess', 'aria-hidden': 'true' }), 'Place is a guess (the middle of a ZIP, or a rough match)'),
    h('li', {}, h('span', { class: 'pin pin--claimed', 'aria-hidden': 'true' }), 'Yellow, dark edge: a volunteer has them'),
    h(
      'li',
      {},
      h('span', { class: 'pin pin--stalled', 'aria-hidden': 'true' }),
      'Red, dark edge: a volunteer has them, and nothing has happened for days',
    ),
    youLegend,
  );
  const refresh = h('button', { class: 'fl-btn', type: 'button', onclick: () => void load() }, 'Refresh');
  // The filters are the ones Find people has (src/filters.ts), applied to the pins; the place the volunteer saved is drawn in a color of its own.
  const filters = createFilters({ me, onChange: () => void load() });

  clear(
    app,
    filters.element,
    h('div', { class: 'fl-cluster' }, legend, refresh),
    frame,
    detail,
    status,
    h(
      'p',
      { class: 'fl-help' },
      'A number is a group of people; zoom in to see each one. The map is a picture, so for a list that works with a keyboard or screen reader, use ',
      h('a', { href: '/pool/' }, 'Find people'),
      ', which can also sort by how far away people are.',
    ),
  );

  const styleFor = async (t: 'light' | 'dark', tiles: boolean): Promise<Record<string, unknown>> => {
    const res = await fetch(`/lib/style-${t}.json`);
    if (!res.ok) throw new Error('The map style would not load');
    const style: { sources: Record<string, { url: string }>; layers: { id: string; type: string }[] } = await res.json();
    if (!tiles) {
      // No tile file yet: a plain background, and the pins on it.
      const background = style.layers.find((l) => l.type === 'background');
      return { ...style, sources: {}, layers: background ? [background] : [] };
    }
    for (const source of Object.values(style.sources)) source.url = `pmtiles://${TILES_URL}`;
    return style;
  };

  // The pins and their layers go into whichever style is showing, so a change of theme puts them back.
  function addPins(m: MapLibreMap): void {
    const exact = token('--pin-exact');
    const guess = token('--pin-guess');
    const ring = token('--surface-raised');
    m.addSource('pins', {
      type: 'geojson',
      data: toGeoJson(),
      cluster: true,
      clusterRadius: 36,
      clusterMaxZoom: 15,
    });
    m.addLayer({
      id: 'groups',
      type: 'circle',
      source: 'pins',
      filter: ['has', 'point_count'],
      paint: {
        'circle-color': token('--brand-strong'),
        'circle-stroke-color': ring,
        'circle-stroke-width': 2,
        'circle-radius': ['step', ['get', 'point_count'], 14, 25, 18, 100, 22, 500, 28],
      },
    });
    m.addLayer({
      id: 'group-counts',
      type: 'symbol',
      source: 'pins',
      filter: ['has', 'point_count'],
      layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': ['Noto Sans Medium'], 'text-size': 12 },
      paint: { 'text-color': token('--on-brand') },
    });
    m.addLayer({
      id: 'exact',
      type: 'circle',
      source: 'pins',
      filter: ['all', ['!', ['has', 'point_count']], ['==', ['get', 'who'], 0], ['==', ['get', 'approximate'], 0]],
      paint: { 'circle-color': exact, 'circle-stroke-color': ring, 'circle-stroke-width': 2, 'circle-radius': 7 },
    });
    m.addLayer({
      id: 'guess',
      type: 'circle',
      source: 'pins',
      filter: ['all', ['!', ['has', 'point_count']], ['==', ['get', 'who'], 0], ['==', ['get', 'approximate'], 1]],
      paint: { 'circle-color': ring, 'circle-stroke-color': guess, 'circle-stroke-width': 3, 'circle-radius': 7 },
    });
    // A volunteer has them: yellow with a dark edge, red when nothing has happened for days.
    m.addLayer({
      id: 'claimed',
      type: 'circle',
      source: 'pins',
      filter: ['all', ['!', ['has', 'point_count']], ['>=', ['get', 'who'], 1]],
      paint: {
        'circle-color': ['case', ['==', ['get', 'who'], 2], token('--pin-stalled'), token('--pin-claimed')],
        'circle-stroke-color': token('--ink'),
        'circle-stroke-width': 2,
        'circle-radius': 7,
      },
    });
    addYou(m);
    markPicked(m);
  }

  // Where the volunteer saved themselves: a dot with a wide, faint halo, in a color no pin has. Drawn above the pins.
  function addYou(m: MapLibreMap): void {
    const you = token('--pin-you');
    m.addSource('you', { type: 'geojson', data: youGeoJson() });
    m.addLayer({
      id: 'you-halo',
      type: 'circle',
      source: 'you',
      paint: { 'circle-color': you, 'circle-opacity': 0.25, 'circle-radius': 18 },
    });
    m.addLayer({
      id: 'you',
      type: 'circle',
      source: 'you',
      paint: { 'circle-color': you, 'circle-stroke-color': token('--surface-raised'), 'circle-stroke-width': 3, 'circle-radius': 8 },
    });
  }

  function youGeoJson(): YouCollection {
    const place = filters.place();
    return {
      type: 'FeatureCollection',
      features: place ? [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [place.lon, place.lat] } }] : [],
    };
  }

  // The picked pin is bigger and has a dark edge, whichever color it is.
  function markPicked(m: MapLibreMap): void {
    const is: ['==', ['get', string], number] = ['==', ['get', 'id'], picked ?? -1];
    for (const [layer, edge, width] of [
      ['exact', token('--surface-raised'), 2],
      ['guess', token('--pin-guess'), 3],
      ['claimed', token('--ink'), 2],
    ] as const) {
      m.setPaintProperty(layer, 'circle-stroke-color', ['case', is, token('--ink'), edge]);
      m.setPaintProperty(layer, 'circle-stroke-width', ['case', is, 4, width]);
      m.setPaintProperty(layer, 'circle-radius', ['case', is, 10, 7]);
    }
  }

  function toGeoJson(): FeatureCollection {
    return {
      type: 'FeatureCollection',
      features: (pins?.pins ?? []).map(([id, lat, lon, approximate, who]) => ({
        type: 'Feature',
        properties: { id, approximate, who },
        geometry: { type: 'Point', coordinates: [lon, lat] },
      })),
    };
  }

  async function start(tiles: boolean): Promise<void> {
    // MapLibre is over a megabyte of script, so it is fetched and run only once the page has its content and the browser is idle.
    await idle();
    const { addProtocol, Map: MapLibre, NavigationControl, setWorkerUrl } = await import('/lib/maplibre-gl.js');
    const { PMTiles, Protocol } = await import('/lib/pmtiles.js');
    setWorkerUrl('/lib/maplibre-gl-worker.js');
    if (tiles) {
      const protocol = new Protocol();
      protocol.add(new PMTiles(TILES_URL));
      addProtocol('pmtiles', protocol.tile);
    }
    const m = new MapLibre({
      container: frame,
      style: (await styleFor(theme(), tiles)) as never,
      bounds: DISTRICT,
      fitBoundsOptions: { padding: 24 },
      maxBounds: EDGE,
      attributionControl: { compact: true },
    });
    map = m;
    m.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    m.on('style.load', () => addPins(m));
    for (const layer of ['exact', 'guess', 'claimed']) {
      m.on('click', layer, (e) => {
        const feature: MapGeoJSONFeature | undefined = e.features?.[0];
        const id = feature?.properties.id;
        if (typeof id === 'number') void pick(id);
      });
    }
    m.on('click', 'groups', (e) => {
      const feature: MapGeoJSONFeature | undefined = e.features?.[0];
      const source = m.getSource<GeoJSONSource>('pins');
      if (!feature || !source) return;
      const clusterId = feature.properties.cluster_id;
      const center = feature.geometry.type === 'Point' ? feature.geometry.coordinates : null;
      if (typeof clusterId !== 'number' || !center) return;
      void source.getClusterExpansionZoom(clusterId).then((zoom) => m.easeTo({ center: [center[0] ?? 0, center[1] ?? 0], zoom }));
    });
    for (const layer of ['exact', 'guess', 'claimed', 'groups']) {
      m.on('mouseenter', layer, () => {
        m.getCanvas().style.cursor = 'pointer';
      });
      m.on('mouseleave', layer, () => {
        m.getCanvas().style.cursor = '';
      });
    }
    // A change of theme (the header's switch, or the browser's setting) is a different basemap.
    const retheme = async (): Promise<void> => {
      m.setStyle((await styleFor(theme(), tiles)) as never);
    };
    new MutationObserver(() => void retheme()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => void retheme());
  }

  function show(): void {
    const source = map?.getSource<GeoJSONSource>('pins');
    source?.setData(toGeoJson());
    map?.getSource<GeoJSONSource>('you')?.setData(youGeoJson());
    youLegend.hidden = filters.place() === null;
    if (map?.getLayer('claimed')) markPicked(map);
  }

  async function pick(id: number): Promise<void> {
    picked = id;
    show();
    try {
      const detailed = await api<PersonDetail>('GET', `/api/people/${id}`);
      renderPerson(detailed);
      // The card sits right under the map. Focus it without the browser's own scroll, and scroll only as far as it takes to show it.
      detail.focus({ preventScroll: true });
      detail.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    } catch (e) {
      toast(failureText(e), 'error');
      await load();
    }
  }

  // "3 days ago" for the last thing a volunteer did, counted in whole days from the time the server stored.
  function sinceText(iso: string): string {
    const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
    return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  }

  function renderPerson({ person: p, claimedBy, lastActivityAt }: PersonDetail): void {
    const claimable = p.assignedTo === null && p.status !== 'cured';
    clear(
      detail,
      h(
        'div',
        { class: 'fl-card fl-stack fl-stack--3' },
        h('h2', { class: 'fl-card__title' }, personName(p)),
        h(
          'div',
          { class: 'fl-cluster' },
          statusBadge(p.status),
          ...(p.flag ? [flagBadge(p.flag)] : []),
          h('span', {}, `${daysText(p)} uncured`),
        ),
        h('p', {}, addressText(`${p.address}, ${p.city} ${p.zip}`)),
        p.party ? h('p', { class: 'fl-help' }, `Party ${titleCase(p.party)}`) : h('span'),
        claimable
          ? h(
              'button',
              { class: 'fl-btn fl-btn--primary', type: 'button', 'aria-label': `Claim ${personName(p)}`, onclick: () => void claim(p) },
              'Claim',
            )
          : claimedBy
            ? banner(
                'info',
                h('p', {}, `${claimedBy.id === myId ? 'You have' : `${claimedBy.name || claimedBy.email} has`} this person.`),
                h(
                  'p',
                  {},
                  claimedBy.id === myId ? '' : h('a', { href: `mailto:${claimedBy.email}` }, claimedBy.email),
                  lastActivityAt ? ` Last activity ${sinceText(lastActivityAt)}.` : '',
                ),
              )
            : banner('info', h('p', {}, 'Somebody has this person now.')),
      ),
    );
  }

  async function claim(p: Person): Promise<void> {
    try {
      await api<Person>('POST', `/api/people/${p.id}/claim`, {});
      toast(`${personName(p)} is on your list now.`);
      picked = null;
      clear(detail);
    } catch (e) {
      toast(failureText(e), 'error');
    }
    await load();
  }

  // The whole district at once, not a box per pan: a pan would read the pool again, and the pool is what the day's reads are spent on.
  // The filters narrow it; a slow answer to an older question is dropped.
  let asked = 0;
  let begun = false;
  async function load(): Promise<void> {
    const mine = ++asked;
    let got: MapPins;
    try {
      const [west, south, east, north] = EDGE;
      const query = new URLSearchParams({ west: String(west), south: String(south), east: String(east), north: String(north) });
      for (const [name, value] of filters.params()) query.set(name, value);
      if (!begun) query.set('facets', '1');
      got = await api<MapPins>('GET', `/api/map?${query}`);
    } catch (e) {
      if (mine === asked) clear(status, failureText(e));
      return;
    }
    if (mine !== asked) return;
    pins = got;
    // The first answer brings the choices for the filters; the address's filters may turn them into a different question.
    if (!begun && got.facets) {
      const before = filters.params().toString();
      filters.load(got.facets);
      if (filters.params().toString() !== before) void load();
    }
    const n = pins.pins.length;
    const guesses = pins.pins.filter((p) => p[3] === 1).length;
    clear(
      status,
      pins.more
        ? `Showing the first ${n.toLocaleString()} people. Find people has the rest.`
        : `${n.toLocaleString()} ${n === 1 ? 'person' : 'people'} on the map, ${guesses.toLocaleString()} of them at a guessed place. People without a place are not here; Find people lists them.`,
    );
    if (begun) show();
    else {
      begun = true;
      try {
        await start(pins.tiles);
      } catch (e) {
        clear(frame);
        frame.hidden = true;
        clear(
          app,
          banner(
            'warn',
            h('p', {}, `The map could not start in this browser (${failureText(e)}). Find people has the same people as a list.`),
          ),
        );
        return;
      }
      if (!pins.tiles) status.append(' The street map has not been set up, so only the pins are drawn.');
    }
  }

  await load();
}
