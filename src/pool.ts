// "Find people": everyone who still needs curing and has nobody yet. Filter by city, precinct or party, sort, and claim.
import type { Person, Volunteer } from './api.d.ts';
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

type Sort = 'days' | 'precinct' | 'city' | 'name';

if (me) {
  let people: Person[] = [];
  let volunteers = new Map<number, Volunteer>();
  let shown = PAGE;

  const search = h('input', { class: 'fl-input', id: 'search', type: 'search', autocomplete: 'off', oninput: () => reset() });
  const city = h('select', { class: 'fl-select', id: 'city', onchange: () => reset() });
  // Precincts are a long list, so this is a type-to-filter combobox rather than a select. Empty means all precincts.
  const precinct = h('input', {
    class: 'fl-input',
    id: 'precinct',
    type: 'text',
    placeholder: 'All precincts',
    oninput: () => reset(),
  });
  const party = h('select', { class: 'fl-select', id: 'party', onchange: () => reset() });
  const sort = h(
    'select',
    { class: 'fl-select', id: 'sort', onchange: () => reset() },
    h('option', { value: 'days' }, 'Longest uncured first'),
    h('option', { value: 'precinct' }, 'Precinct'),
    h('option', { value: 'city' }, 'City'),
    h('option', { value: 'name' }, 'Last name'),
  );
  const count = h('p', { class: 'fl-note', role: 'status' });
  const list = h('ul', { class: 'fl-grid people' });
  const more = h('div', { class: 'fl-cluster' });

  const pool = (): Person[] => people.filter((p) => p.assignedTo === null && p.status !== 'cured');

  function fill(select: HTMLSelectElement, all: string, values: string[], label: (v: string) => string = titleCase): void {
    const previous = select.value;
    clear(
      select,
      h('option', { value: '' }, all),
      ...[...new Set(values)]
        .filter((v) => v !== '')
        .sort()
        .map((v) => h('option', { value: v }, label(v))),
    );
    select.value = previous;
  }

  function reset(): void {
    shown = PAGE;
    render();
  }

  function visible(): Person[] {
    const needle = search.value.trim().toLowerCase();
    const precinctNeedle = precinct.value.trim().toLowerCase();
    const matches = pool().filter(
      (p) =>
        (city.value === '' || p.city === city.value) &&
        (precinctNeedle === '' || p.precinct.toLowerCase().includes(precinctNeedle)) &&
        (party.value === '' || p.party === party.value) &&
        (needle === '' || `${p.firstName} ${p.lastName} ${p.address}`.toLowerCase().includes(needle)),
    );
    const by: Record<Sort, (a: Person, b: Person) => number> = {
      days: (a, b) => (b.daysUncured ?? -1) - (a.daysUncured ?? -1),
      precinct: (a, b) => a.precinct.localeCompare(b.precinct) || (b.daysUncured ?? -1) - (a.daysUncured ?? -1),
      city: (a, b) => a.city.localeCompare(b.city) || (b.daysUncured ?? -1) - (a.daysUncured ?? -1),
      name: (a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName),
    };
    return matches.sort(by[sort.value as Sort] ?? by.days);
  }

  async function claim(p: Person): Promise<void> {
    try {
      await api<Person>('POST', `/api/people/${p.id}/claim`, {});
      people = people.map((x) => (x.id === p.id ? { ...x, assignedTo: me?.id ?? null } : x));
      toast(`${personName(p)} is on your list now.`);
    } catch (e) {
      toast(failureText(e), 'error');
      // Somebody else was faster: show the pool as it is now.
      people = await api<Person[]>('GET', '/api/people');
    }
    render();
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

  function showMore(): void {
    shown += PAGE;
    render();
  }

  function render(): void {
    const matches = visible();
    const total = pool().length;
    const page = matches.slice(0, shown);
    count.textContent =
      total === 0
        ? 'Nobody is waiting for a volunteer right now.'
        : `Showing ${page.length} of ${plural(matches.length, 'person', 'people')}${matches.length === total ? '' : ` (${total} in all)`}.`;
    clear(list, ...page.map(card));
    clear(more, matches.length > shown ? h('button', { class: 'fl-btn', type: 'button', onclick: showMore }, 'Show more') : null);
  }

  try {
    [people, volunteers] = await Promise.all([api<Person[]>('GET', '/api/people'), loadVolunteers()]);
    const open = pool();
    fill(
      city,
      'All cities',
      open.map((p) => p.city),
    );
    const precincts = [...new Set(open.map((p) => p.precinct))].filter((v) => v !== '').sort();
    window.Frostline.combobox(precinct, {
      mode: 'suggest',
      label: 'Precincts',
      openOnFocus: true,
      options: (query) => {
        const q = query.trim().toLowerCase();
        return precincts.filter((v) => v.toLowerCase().includes(q)).map((v) => ({ id: v, label: v }));
      },
    });
    fill(
      party,
      'All parties',
      open.map((p) => p.party),
      (v) => v,
    );
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
