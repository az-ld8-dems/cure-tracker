// "Find people": everyone who still needs curing and has nobody yet. Filter by city, precinct or party, sort, and claim.
import type { PeoplePage, Person, Volunteer } from './api.d.ts';
import {
  $,
  api,
  banner,
  boot,
  clear,
  facts,
  failureText,
  field,
  flagBadge,
  h,
  loadVolunteers,
  personName,
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
  // The people loaded so far, how many the filters match in all, and how many are in the pool.
  let people: Person[] = [];
  let total = 0;
  let open = 0;
  let volunteers = new Map<number, Volunteer>();

  const search = h('input', { class: 'fl-input', id: 'search', type: 'search', autocomplete: 'off', oninput: () => reset() });
  const city = h('select', { class: 'fl-select', id: 'city', onchange: () => reload() });
  // Precincts are a long list, so this is a type-to-filter combobox rather than a select. Empty means all precincts.
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
    { class: 'fl-select', id: 'sort', onchange: () => reload() },
    h('option', { value: 'days' }, 'Longest uncured first'),
    h('option', { value: 'precinct' }, 'Precinct'),
    h('option', { value: 'city' }, 'City'),
    h('option', { value: 'name' }, 'Last name'),
  );
  const count = h('p', { class: 'fl-note', role: 'status' });
  const list = h('ul', { class: 'fl-grid people' });
  const more = h('div', { class: 'fl-cluster' });

  function fill(select: HTMLSelectElement, all: string, values: string[], label: (v: string) => string = titleCase): void {
    const previous = select.value;
    clear(select, h('option', { value: '' }, all), ...values.map((v) => h('option', { value: v }, label(v))));
    select.value = previous;
  }

  // The server filters, sorts and pages; the page asks again when a filter changes. A slow answer to an older question is dropped.
  let asked = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function question(offset: number): string {
    const params = new URLSearchParams({ scope: 'pool', sort: sort.value, limit: String(PAGE), offset: String(offset) });
    for (const [name, value] of [
      ['q', search.value.trim()],
      ['city', city.value],
      ['precinct', precinct.value.trim()],
      ['party', party.value],
    ] as const) {
      if (value !== '') params.set(name, value);
    }
    return `/api/people?${params}`;
  }

  async function reload(): Promise<void> {
    const mine = ++asked;
    try {
      const page = await api<PeoplePage>('GET', question(0));
      if (mine !== asked) return;
      people = page.people;
      total = page.total;
      open = page.open ?? page.total;
      render();
    } catch (e) {
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
      total = Math.max(0, total - 1);
      open = Math.max(0, open - 1);
      toast(`${personName(p)} is on your list now.`);
      render();
    } catch (e) {
      toast(failureText(e), 'error');
      // Somebody else was faster: show the pool as it is now.
      await reload();
    }
  }

  function card(p: Person): HTMLElement {
    return h(
      'li',
      { class: 'fl-card' },
      h('div', { class: 'card-head' }, h('h2', { class: 'fl-card__title' }, personName(p)), statusBadge(p.status)),
      p.flag ? flagBadge(p.flag) : null,
      facts(p, volunteers, false),
      h('button', { class: 'btn btn--accent', type: 'button', onclick: () => claim(p) }, `Claim ${personName(p)}`),
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
      total = page.total;
      render();
    } catch (e) {
      toast(failureText(e), 'error');
    }
  }

  function render(): void {
    count.textContent =
      open === 0
        ? 'Nobody is waiting for a volunteer right now.'
        : `Showing ${people.length} of ${plural(total, 'person', 'people')}${total === open ? '' : ` (${open} in all)`}.`;
    clear(list, ...people.map(card));
    clear(more, total > people.length ? h('button', { class: 'fl-btn', type: 'button', onclick: showMore }, 'Show more') : null);
  }

  try {
    const [first, vols] = await Promise.all([api<PeoplePage>('GET', `${question(0)}&facets=1`), loadVolunteers()]);
    volunteers = vols;
    people = first.people;
    total = first.total;
    open = first.open ?? first.total;
    const facets = first.facets ?? { cities: [], parties: [], precincts: [] };
    fill(city, 'All cities', facets.cities);
    const precincts = facets.precincts;
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
        { class: 'fl-toolbar', role: 'search', onsubmit: (e) => e.preventDefault() },
        field('search', 'Search name or street', search),
        field('city', 'City', city),
        field('precinct', 'Precinct', precinct),
        field('party', 'Party', party),
        field('sort', 'Sort by', sort),
      ),
      count,
      list,
      more,
    );
    render();
  } catch (e) {
    clear(app, banner('warn', h('p', {}, failureText(e))));
  }
}
