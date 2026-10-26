// The filters Find people and the map share: search, city, precinct, party, and the "Near me" box (where the volunteer is, and how far to
// look). One module builds both pages' filters, so they look and behave the same and carry over from one page to the other in the address
// (?q=&city=&precinct=&party=&miles=), which the two pages' links in the header keep up to date.
import type { Me, PeoplePage } from './api.d.ts';
import { api, clear, failureText, field, h, plural, titleCase, toast } from './common.ts';

type Facets = NonNullable<PeoplePage['facets']>;

export interface FilterOptions {
  me: Me;
  // Called when a filter changed and the page should ask again. `force` asks even when the question is the same as the last (a saved place changes
  // the answer without changing the question).
  onChange: (force?: boolean) => void;
  // More controls for the row of filters (the list's sort).
  extra?: HTMLElement[];
  // Called whenever the near-me state is drawn. `by` is whether a search by distance is on, `started` whether it just turned on.
  onNear?: (state: { by: boolean; started: boolean }) => void;
}

export interface Filters {
  // The form to put on the page.
  element: HTMLElement;
  // The query string parts the people and map routes take: q, city, precinct, party and miles.
  params(): URLSearchParams;
  // Whether any filter narrows the people, and a hint when a precinct was typed that is not on the list.
  narrowing(): boolean;
  hint(): string;
  // The place the volunteer saved, and whether the radius is on.
  place(): Me['location'];
  searchingByDistance(): boolean;
  // Fills the city, precinct and party choices once the page knows them; the address's filters are applied then.
  load(facets: Facets): void;
  // Redraws the near-me box (after the page changed the radius or sort itself).
  syncNear(): void;
}

export function createFilters({ me, onChange, extra = [], onNear }: FilterOptions): Filters {
  let place: Me['location'] = me.location;
  let precincts: string[] = [];
  // The cities, and the precincts of each, so a city narrows the precincts offered and a precinct narrows the cities.
  let cities: string[] = [];
  let byCity: Record<string, string[]> = {};
  const start = new URLSearchParams(location.search);

  // Typing waits for a pause; the selects change at once.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const changed = (): void => {
    rememberInAddress();
    onChange();
  };
  const typed = (): void => {
    clearTimeout(timer);
    timer = setTimeout(changed, 250);
  };

  const search = h('input', {
    class: 'fl-input',
    id: 'search',
    type: 'search',
    autocomplete: 'off',
    value: start.get('q') ?? '',
    oninput: typed,
  });
  const city = h('select', {
    class: 'fl-select',
    id: 'city',
    onchange: () => {
      // A precinct typed that this city has no one in no longer applies.
      if (precinct.value.trim() !== '' && knownPrecinct() === '') precinct.value = '';
      changed();
    },
  });
  // Precincts are a long list, so this is a type-to-filter combobox rather than a select. Empty means all precincts. The filter applies once
  // the text is a precinct on the list: the server matches a whole precinct, which is what its index answers.
  const precinct = h('input', {
    class: 'fl-input',
    id: 'precinct',
    type: 'text',
    placeholder: 'All precincts',
    value: start.get('precinct') ?? '',
    oninput: () => {
      syncCities();
      typed();
    },
  });
  // The list of matches floats under the field, so opening it moves nothing else (Frostline's own puts it in the flow).
  const precinctList = h('ul', { class: 'pool-popover' });
  const party = h('select', { class: 'fl-select', id: 'party', onchange: changed });
  // "Within N miles" of the place the volunteer saved. A radius is what keeps a search by distance cheap, so sorting by distance needs one.
  const radius = h(
    'select',
    {
      class: 'fl-select',
      id: 'radius',
      disabled: place === null,
      onchange: () => {
        syncNear();
        changed();
      },
    },
    h('option', { value: '' }, 'Any distance'),
    ...[1, 3, 5, 10, 25].map((m) => h('option', { value: String(m) }, `Within ${plural(m, 'mile')}`)),
  );
  if (place !== null && [...radius.options].some((o) => o.value === start.get('miles'))) radius.value = start.get('miles') ?? '';
  const zip = h('input', {
    class: 'fl-input',
    id: 'zip',
    type: 'text',
    inputmode: 'numeric',
    autocomplete: 'postal-code',
    maxlength: '5',
    placeholder: '85018',
  });
  const nearStatus = h('p', { class: 'fl-help', role: 'status' });
  const forget = h('button', { class: 'fl-btn', type: 'button', onclick: () => void savePlace({ clear: true }) }, 'Forget where I am');
  // Once a place is saved the ways to save one go away, and the page says where it is; "Change" brings them back.
  let changing = false;
  const change = h(
    'button',
    {
      class: 'fl-btn',
      type: 'button',
      onclick: () => {
        changing = true;
        syncNear();
        zip.focus();
      },
    },
    'Change',
  );
  const cancel = h(
    'button',
    {
      class: 'fl-btn',
      type: 'button',
      onclick: () => {
        changing = false;
        syncNear();
        change.focus();
      },
    },
    'Cancel',
  );
  // The ways to save where you are: the device's location, or the middle of a ZIP.
  const setPlace = h(
    'div',
    { class: 'fl-cluster pool-near-row' },
    h('button', { class: 'fl-btn', type: 'button', onclick: () => here() }, 'Use my location'),
    h(
      'form',
      {
        class: 'fl-cluster pool-near-row',
        onsubmit: (e: Event) => {
          e.preventDefault();
          void savePlace({ zip: zip.value.trim() });
        },
      },
      field('zip', 'or the middle of a ZIP', zip),
      h('button', { class: 'fl-btn', type: 'submit' }, 'Use this ZIP'),
    ),
    cancel,
  );
  // The other filters sit in a disclosure on a phone. Where there is room it stays open, its summary is hidden, and they share a row with
  // the search box (app.css).
  const filters = h(
    'details',
    { class: 'fl-disclosure' },
    h('summary', {}, 'Filter and sort'),
    h(
      'div',
      { class: 'fl-toolbar' },
      field('city', 'City', city),
      h('div', { class: 'fl-field pool-combo' }, h('label', { class: 'fl-label', for: 'precinct' }, 'Precinct'), precinct, precinctList),
      field('party', 'Party', party),
      ...extra,
    ),
  );
  // Near me is a box of its own, labelled, because these controls are about the volunteer's own place and not about the voters: where they are
  // and how far to look. It is one row of controls under what the page knows.
  const near = h(
    'details',
    { class: 'fl-disclosure pool-near' },
    h('summary', {}, 'Near me'),
    h(
      'div',
      { class: 'fl-stack fl-stack--3' },
      nearStatus,
      h('div', { class: 'fl-cluster pool-near-row' }, field('radius', 'Show people', radius), change, forget, setPlace),
    ),
  );
  const room = window.matchMedia('(min-width: 48rem)');
  for (const box of [filters, near]) box.open = room.matches;
  room.addEventListener('change', () => {
    for (const box of [filters, near]) box.open = room.matches;
  });

  const element = h(
    'form',
    { class: 'pool-filters', role: 'search', onsubmit: (e: Event) => e.preventDefault() },
    field('search', 'Search name or street', search),
    filters,
    near,
  );

  const precinctsShown = (): string[] => (city.value === '' ? precincts : (byCity[city.value] ?? []));
  // The precinct typed, as the list spells it, or '' when it is empty or not (yet) on the list.
  const knownPrecinct = (): string => precinctsShown().find((v) => v.toLowerCase() === precinct.value.trim().toLowerCase()) ?? '';

  function fill(select: HTMLSelectElement, all: string, values: string[], label: (v: string) => string = titleCase): void {
    const previous = select.value;
    clear(select, h('option', { value: '' }, all), ...values.map((v) => h('option', { value: v }, label(v))));
    select.value = previous;
  }

  // The cities offered: all of them, or the ones the precinct typed is in.
  function syncCities(): void {
    const only = knownPrecinct();
    fill(city, 'All cities', only === '' ? cities : cities.filter((c) => byCity[c]?.includes(only)));
  }

  const searchingByDistance = (): boolean => place !== null && radius.value !== '';
  let lastRadius = '';

  // What the box says and allows, given whether a place is saved and a radius picked. Drawn when the filters are made, not when the choices
  // arrive, so the box does not change height under a page that is already showing (a layout shift).
  function drawNear(): void {
    radius.disabled = place === null;
    // With a place saved, the page says where it is and offers to change or forget it; without one (or while changing), the ways to save one.
    forget.hidden = place === null;
    change.hidden = place === null || changing;
    cancel.hidden = place === null;
    setPlace.hidden = place !== null && !changing;
    nearStatus.className = place === null ? 'fl-help' : 'fl-note';
    nearStatus.textContent =
      place === null
        ? 'Where you are: not saved. Save it to see who is closest. It is kept to about a mile, only you can see it, and you can forget it any time.'
        : changing
          ? `Where you are: ${place.near ? `near ${place.near}` : 'saved'}. Choose a new place below.`
          : place.near
            ? `Where you are: near ${place.near}. Saved to about a mile; only you can see it.`
            : 'Where you are: saved, but no one waiting is within 25 miles of it. Only you can see it.';
  }

  // The same, and tells the page whether a search by distance is on.
  function syncNear(): void {
    drawNear();
    const by = searchingByDistance();
    onNear?.({ by, started: by && lastRadius === '' });
    lastRadius = radius.value;
  }
  drawNear();

  // Saves, or forgets, where the volunteer is: from their device, or the middle of a ZIP (the Worker works it out).
  async function savePlace(body: object): Promise<void> {
    try {
      place = (await api<{ location: Me['location'] }>('PUT', '/api/me/location', body)).location;
      toast(place ? 'Saved where you are.' : 'Forgot where you are.');
      changing = false;
      zip.value = '';
      if (place === null) radius.value = '';
      else if (radius.value === '') radius.value = '10';
      syncNear();
      // The buttons that were pressed have gone: leave the keyboard somewhere that is still there.
      (place ? change : zip).focus();
      rememberInAddress();
      onChange(true);
    } catch (e) {
      toast(failureText(e), 'error');
    }
  }

  // The device's location, rounded to about a mile here before it is sent.
  function here(): void {
    if (!('geolocation' in navigator)) {
      toast('This browser cannot share where it is. Use a ZIP instead.', 'error');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => void savePlace({ lat: Math.round(pos.coords.latitude * 100) / 100, lon: Math.round(pos.coords.longitude * 100) / 100 }),
      () => toast('Your browser did not share where you are. Use a ZIP instead.', 'error'),
      { maximumAge: 600_000, timeout: 15_000 },
    );
  }

  // Until the page has the choices (the first question is asked along with them), the filters are what the address says.
  let loaded = false;
  function params(): URLSearchParams {
    const out = new URLSearchParams();
    if (!loaded) {
      for (const name of ['q', 'city', 'precinct', 'party'] as const) {
        const v = (start.get(name) ?? '').trim();
        if (v !== '') out.set(name, v);
      }
      const miles = start.get('miles') ?? '';
      if (place !== null && miles !== '') out.set('miles', miles);
      return out;
    }
    for (const [name, value] of [
      ['q', search.value.trim()],
      ['city', city.value],
      ['precinct', knownPrecinct()],
      ['party', party.value],
      ['miles', place !== null ? radius.value : ''],
    ] as const) {
      if (value !== '') out.set(name, value);
    }
    return out;
  }

  // The filters stay in the address, and in the header's links to the pages that share them, so they carry over from one page to the other and
  // survive a reload.
  function rememberInAddress(): void {
    const query = params().toString();
    const suffix = query === '' ? '' : `?${query}`;
    history.replaceState(null, '', `${location.pathname}${suffix}`);
    for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href^="/pool/"], a[href^="/map/"]')) {
      a.href = `${a.pathname}${suffix}`;
    }
  }

  return {
    element,
    params,
    narrowing: () => [search.value.trim(), city.value, precinct.value.trim(), party.value].some((v) => v !== ''),
    hint: () => (precinct.value.trim() !== '' && knownPrecinct() === '' ? ' Choose a precinct from the list to filter by it.' : ''),
    place: () => place,
    searchingByDistance,
    load(facets) {
      loaded = true;
      cities = facets.cities;
      byCity = facets.precinctsByCity;
      precincts = facets.precincts;
      const wanted = start.get('city') ?? '';
      syncCities();
      if (wanted !== '' && cities.includes(wanted)) city.value = wanted;
      fill(party, 'All parties', facets.parties, (v) => v);
      const p = start.get('party') ?? '';
      if (p !== '' && facets.parties.includes(p)) party.value = p;
      window.Frostline.combobox(precinct, {
        mode: 'suggest',
        label: 'Precincts',
        list: precinctList,
        openOnFocus: true,
        options: (query) => {
          const q = query.trim().toLowerCase();
          return precinctsShown()
            .filter((v) => v.toLowerCase().includes(q))
            .map((v) => ({ id: v, label: v }));
        },
      });
      syncNear();
      rememberInAddress();
    },
    syncNear,
  };
}
