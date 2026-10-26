// "Find people": everyone who still needs curing and has nobody yet. Filter by city, precinct, party or how far away, sort, and claim.
import type { Me, PeoplePage, Person } from './api.d.ts';
import {
  $,
  addressText,
  api,
  banner,
  boot,
  clear,
  daysText,
  failureText,
  field,
  flagBadge,
  h,
  personName,
  phoneHref,
  plural,
  statusBadge,
  titleCase,
  toast,
} from './common.ts';

const me = await boot();
const app = $('#app');

// People shown at first, and added by each press of "Show more".
const PAGE = 30;

if (me) {
  // The people loaded so far, whether there are more after them, and the precincts the filter knows.
  let people: Person[] = [];
  let hasMore = false;
  let precincts: string[] = [];
  // Where the volunteer saved themselves for "near me" (rounded to about a mile; only they ever see it), or null.
  let place: Me['location'] = me.location;

  const search = h('input', { class: 'fl-input', id: 'search', type: 'search', autocomplete: 'off', oninput: () => reset() });
  const city = h('select', { class: 'fl-select', id: 'city', onchange: () => reload() });
  // Precincts are a long list, so this is a type-to-filter combobox rather than a select. Empty means all precincts. The filter applies once
  // the text is a precinct on the list: the server matches a whole precinct, which is what its index answers.
  const precinct = h('input', {
    class: 'fl-input',
    id: 'precinct',
    type: 'text',
    placeholder: 'All precincts',
    oninput: () => reset(),
  });
  const party = h('select', { class: 'fl-select', id: 'party', onchange: () => reload() });
  const sort = h(
    'select',
    {
      class: 'fl-select',
      id: 'sort',
      onchange: () => {
        reversed = false;
        reload();
      },
    },
    h('option', { value: 'days' }, 'Longest uncured first'),
    h('option', { value: 'precinct' }, 'Precinct'),
    h('option', { value: 'city' }, 'City'),
    h('option', { value: 'name' }, 'Last name'),
    h('option', { value: 'distance', disabled: true }, 'Nearest first'),
  );
  // "Within N miles" of the place the volunteer saved. A radius is what keeps a search by distance cheap, so sorting by distance needs one.
  const radius = h(
    'select',
    {
      class: 'fl-select',
      id: 'radius',
      disabled: place === null,
      onchange: () => {
        reversed = false;
        syncRadius();
        reload();
      },
    },
    h('option', { value: '' }, 'Any distance'),
    ...[1, 3, 5, 10, 25].map((m) => h('option', { value: String(m) }, `Within ${plural(m, 'mile')}`)),
  );
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
  // The other filters sit in a disclosure on a phone. Where there is room it stays open, its summary is hidden, and they share a row with
  // the search box (app.css).
  const filters = h(
    'details',
    { class: 'fl-disclosure' },
    h('summary', {}, 'Filter and sort'),
    h(
      'div',
      { class: 'fl-stack fl-stack--3' },
      h(
        'div',
        { class: 'fl-toolbar' },
        field('city', 'City', city),
        field('precinct', 'Precinct', precinct),
        field('party', 'Party', party),
        field('sort', 'Sort by', sort),
      ),
      // Near me: where the volunteer is, and how far to look.
      h(
        'div',
        { class: 'fl-stack fl-stack--3' },
        nearStatus,
        h(
          'div',
          { class: 'fl-cluster pool-near-row' },
          field('radius', 'Show people', radius),
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
          forget,
        ),
      ),
    ),
  );
  const room = window.matchMedia('(min-width: 48rem)');
  filters.open = room.matches;
  room.addEventListener('change', () => {
    filters.open = room.matches;
  });
  const count = h('p', { class: 'fl-note', role: 'status' });
  // Two views of the same page: a table where there is room, and compact rows on a phone. CSS shows one of them (.pool-table, .pool-rows).
  const tbody = h('tbody');
  // Three headers sort the table: a click asks for that sort, a second click runs it the other way, and the active one says which way it
  // runs (aria-sort). The "Sort by" select does the same on a phone and stays in step, except that it only picks the natural direction.
  let reversed = false;
  const sortHeads = new Map<string, { th: HTMLElement; direction: 'ascending' | 'descending' }>();
  // `direction` is the way the column reads in its natural order (days uncured, longest first, reads as descending).
  function head(label: string, by?: string, direction: 'ascending' | 'descending' = 'ascending'): HTMLElement {
    if (by === undefined) return h('th', { scope: 'col' }, label);
    const th = h(
      'th',
      { scope: 'col' },
      h(
        'button',
        {
          class: 'pool-sort',
          type: 'button',
          onclick: () => {
            reversed = sort.value === by ? !reversed : false;
            sort.value = by;
            reload();
          },
        },
        label,
      ),
    );
    sortHeads.set(by, { th, direction });
    return th;
  }
  // The distance column shows only in a search by distance.
  const awayHead = head('Away', 'distance');
  awayHead.hidden = true;
  const table = h(
    'div',
    { class: 'fl-table-wrap pool-table', role: 'region', 'aria-label': 'People waiting for a volunteer', tabindex: '0' },
    h(
      'table',
      { class: 'fl-table' },
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          head('Person', 'name'),
          head('Phone'),
          head('Address'),
          head('Precinct', 'precinct'),
          head('Party'),
          head('Uncured', 'days', 'descending'),
          awayHead,
          head('Reason'),
          h('th', { scope: 'col' }, h('span', { class: 'fl-sr-only' }, 'Claim')),
        ),
      ),
      tbody,
    ),
  );
  const list = h('ul', { class: 'pool-rows' });
  const more = h('div', { class: 'fl-cluster' });

  function fill(select: HTMLSelectElement, all: string, values: string[], label: (v: string) => string = titleCase): void {
    const previous = select.value;
    clear(select, h('option', { value: '' }, all), ...values.map((v) => h('option', { value: v }, label(v))));
    select.value = previous;
  }

  const searchingByDistance = (): boolean => place !== null && radius.value !== '';
  // "1.3 mi", or "about 1.3 mi" for someone who only has the middle of their ZIP.
  const awayText = (p: Person): string =>
    p.distanceMiles === undefined ? '' : `${p.approximate ? 'about ' : ''}${p.distanceMiles.toFixed(1)} mi`;

  // What the page says and allows, given whether a place is saved and a radius picked: nearest first needs both.
  function syncRadius(): void {
    radius.disabled = place === null;
    forget.hidden = place === null;
    const by = searchingByDistance();
    const nearest = sort.querySelector<HTMLOptionElement>('option[value="distance"]');
    if (nearest) nearest.disabled = !by;
    // Picking a radius for the first time means "who is closest"; dropping it puts the sort back.
    if (by && sort.value !== 'distance' && lastRadius === '') sort.value = 'distance';
    if (!by && sort.value === 'distance') sort.value = 'days';
    lastRadius = radius.value;
    awayHead.hidden = !by;
    nearStatus.textContent =
      place === null
        ? 'Where you are: not saved. Save it to see who is closest. It is kept to about a mile, only you can see it, and you can forget it any time.'
        : 'Where you are: saved, to about a mile. Only you can see it.';
  }
  let lastRadius = '';

  // Saves, or forgets, where the volunteer is: from their device, or the middle of a ZIP (the Worker works it out).
  async function savePlace(body: object): Promise<void> {
    try {
      place = (await api<{ location: Me['location'] }>('PUT', '/api/me/location', body)).location;
      toast(place ? 'Saved where you are.' : 'Forgot where you are.');
      if (place === null) radius.value = '';
      else if (radius.value === '') radius.value = '10';
      syncRadius();
      await reload(true);
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

  // The server filters, sorts and pages; the page asks again when a filter changes. A slow answer to an older question is dropped.
  let asked = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // The precinct typed, as the list spells it, or '' when it is empty or not (yet) on the list.
  const knownPrecinct = (): string => precincts.find((v) => v.toLowerCase() === precinct.value.trim().toLowerCase()) ?? '';

  function question(offset: number): string {
    const params = new URLSearchParams({ scope: 'pool', sort: sort.value, limit: String(PAGE), offset: String(offset) });
    if (reversed) params.set('dir', 'desc');
    if (place !== null && radius.value !== '') params.set('miles', radius.value);
    for (const [name, value] of [
      ['q', search.value.trim()],
      ['city', city.value],
      ['precinct', knownPrecinct()],
      ['party', party.value],
    ] as const) {
      if (value !== '') params.set(name, value);
    }
    return `/api/people?${params}`;
  }

  function showSort(): void {
    for (const [by, { th, direction }] of sortHeads) {
      if (by !== sort.value) th.removeAttribute('aria-sort');
      else if (!reversed) th.setAttribute('aria-sort', direction);
      else th.setAttribute('aria-sort', direction === 'ascending' ? 'descending' : 'ascending');
    }
  }

  // What the page last asked for, so typing half a precinct name (which does not filter yet) does not ask again.
  let lastQuestion = '';

  async function reload(force = false): Promise<void> {
    showSort();
    const asking = question(0);
    if (!force && asking === lastQuestion) {
      render();
      return;
    }
    lastQuestion = asking;
    const mine = ++asked;
    try {
      const page = await api<PeoplePage>('GET', asking);
      if (mine !== asked) return;
      people = page.people;
      hasMore = page.hasMore;
      render();
    } catch (e) {
      lastQuestion = '';
      if (mine === asked) toast(failureText(e), 'error');
    }
  }

  // Typing waits for a pause; the selects change at once.
  function reset(): void {
    clearTimeout(timer);
    timer = setTimeout(reload, 250);
  }

  async function claim(p: Person): Promise<void> {
    try {
      await api<Person>('POST', `/api/people/${p.id}/claim`, {});
      people = people.filter((x) => x.id !== p.id);
      toast(`${personName(p)} is on your list now.`);
      // A page that was only this person, with more behind it, asks again.
      if (people.length === 0 && hasMore) await reload(true);
      else render();
    } catch (e) {
      toast(failureText(e), 'error');
      // Somebody else was faster: show the pool as it is now.
      await reload(true);
    }
  }

  const claimButton = (p: Person): HTMLElement =>
    h(
      'button',
      { class: 'fl-btn fl-btn--primary', type: 'button', 'aria-label': `Claim ${personName(p)}`, onclick: () => claim(p) },
      'Claim',
    );

  const phoneLink = (p: Person): Node | string => (p.phone ? h('a', { href: phoneHref(p.phone) }, p.phone) : 'None');

  // A name, with badges under it for what is unusual: everyone in the pool starts as "needs to be contacted", so that one is left out.
  const who = (p: Person): HTMLElement =>
    h(
      'div',
      { class: 'pool-who' },
      h('strong', {}, personName(p)),
      p.status === 'needs_contact' ? null : statusBadge(p.status),
      p.flag ? flagBadge(p.flag) : null,
    );

  function tableRow(p: Person): HTMLElement {
    return h(
      'tr',
      {},
      h('th', { scope: 'row' }, who(p)),
      h('td', { class: 'fl-nowrap' }, phoneLink(p)),
      h('td', {}, addressText(p.address)),
      h('td', {}, p.precinct || 'Unknown'),
      h('td', {}, p.party || 'Unknown'),
      h('td', { class: 'fl-nowrap' }, daysText(p)),
      h('td', { class: 'fl-nowrap', hidden: !searchingByDistance() }, awayText(p)),
      h('td', {}, p.reasonCode ? titleCase(p.reasonCode) : ''),
      h('td', {}, claimButton(p)),
    );
  }

  function compactRow(p: Person): HTMLElement {
    const meta = [p.precinct, p.party, p.daysUncured === null ? '' : daysText(p), awayText(p)].filter((v) => v !== '').join(' · ');
    return h(
      'li',
      { class: 'pool-row' },
      who(p),
      h('p', {}, addressText(p.address)),
      h('p', { class: 'fl-help' }, meta, p.phone ? ' · ' : '', p.phone ? phoneLink(p) : null),
      claimButton(p),
    );
  }

  async function showMore(): Promise<void> {
    const mine = asked;
    try {
      const page = await api<PeoplePage>('GET', question(people.length));
      if (mine !== asked) return;
      // Somebody may have claimed people since the last page, so skip anyone already shown.
      const have = new Set(people.map((p) => p.id));
      people = [...people, ...page.people.filter((p) => !have.has(p.id))];
      hasMore = page.hasMore;
      render();
    } catch (e) {
      toast(failureText(e), 'error');
    }
  }

  function render(): void {
    const filtered = [search.value.trim(), city.value, precinct.value.trim(), party.value].some((v) => v !== '');
    const unlisted = precinct.value.trim() !== '' && knownPrecinct() === '';
    const hint = unlisted ? ' Choose a precinct from the list to filter by it.' : '';
    count.textContent =
      people.length === 0
        ? `${filtered ? 'Nobody matches.' : 'Nobody is waiting for a volunteer right now.'}${hint}`
        : `Showing ${plural(people.length, 'person', 'people')}${hasMore ? ', with more to show' : ''}.${hint}`;
    clear(tbody, ...people.map(tableRow));
    clear(list, ...people.map(compactRow));
    clear(more, hasMore ? h('button', { class: 'fl-btn', type: 'button', onclick: showMore }, 'Show more') : null);
  }

  try {
    syncRadius();
    showSort();
    const first = await api<PeoplePage>('GET', `${question(0)}&facets=1`);
    people = first.people;
    hasMore = first.hasMore;
    lastQuestion = question(0);
    const facets = first.facets ?? { cities: [], parties: [], precincts: [] };
    fill(city, 'All cities', facets.cities);
    precincts = facets.precincts;
    window.Frostline.combobox(precinct, {
      mode: 'suggest',
      label: 'Precincts',
      openOnFocus: true,
      options: (query) => {
        const q = query.trim().toLowerCase();
        return precincts.filter((v) => v.toLowerCase().includes(q)).map((v) => ({ id: v, label: v }));
      },
    });
    fill(party, 'All parties', facets.parties, (v) => v);
    clear(
      app,
      h(
        'form',
        { class: 'pool-filters', role: 'search', onsubmit: (e) => e.preventDefault() },
        field('search', 'Search name or street', search),
        filters,
      ),
      count,
      table,
      list,
      more,
    );
    render();
  } catch (e) {
    clear(app, banner('warn', h('p', {}, failureText(e))));
  }
}
