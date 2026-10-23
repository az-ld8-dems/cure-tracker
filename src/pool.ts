// "Find people": everyone who still needs curing and has nobody yet. Filter by city, precinct or party, sort, and claim.
import type { Person, Volunteer } from './api.d.ts';
import {
  $,
  api,
  boot,
  clear,
  facts,
  failureText,
  flagLabel,
  h,
  loadVolunteers,
  personName,
  plural,
  statusPill,
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

  const search = h('input', { id: 'search', type: 'search', autocomplete: 'off', oninput: () => reset() });
  const city = h('select', { id: 'city', onchange: () => reset() });
  const precinct = h('select', { id: 'precinct', onchange: () => reset() });
  const party = h('select', { id: 'party', onchange: () => reset() });
  const sort = h(
    'select',
    { id: 'sort', onchange: () => reset() },
    h('option', { value: 'days' }, 'Longest uncured first'),
    h('option', { value: 'precinct' }, 'Precinct'),
    h('option', { value: 'city' }, 'City'),
    h('option', { value: 'name' }, 'Last name'),
  );
  const count = h('p', { class: 'muted', role: 'status' });
  const list = h('ul', { class: 'cards' });
  const more = h('div', { class: 'row' });

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
    const matches = pool().filter(
      (p) =>
        (city.value === '' || p.city === city.value) &&
        (precinct.value === '' || p.precinct === precinct.value) &&
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
      { class: 'card' },
      h('div', { class: 'card__head' }, h('h2', { class: 'card__title' }, personName(p)), statusPill(p.status)),
      p.flag ? h('p', { class: 'flag', role: 'note' }, flagLabel(p.flag)) : null,
      facts(p, volunteers, false),
      h('div', {}, h('button', { class: 'btn btn--accent', type: 'button', onclick: () => claim(p) }, `Claim ${personName(p)}`)),
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
    clear(more, matches.length > shown ? h('button', { class: 'btn btn--ghost', type: 'button', onclick: showMore }, 'Show more') : null);
  }

  try {
    [people, volunteers] = await Promise.all([api<Person[]>('GET', '/api/people'), loadVolunteers()]);
    const open = pool();
    fill(
      city,
      'All cities',
      open.map((p) => p.city),
    );
    fill(
      precinct,
      'All precincts',
      open.map((p) => p.precinct),
    );
    fill(
      party,
      'All parties',
      open.map((p) => p.party),
      (v) => v,
    );
    app.classList.remove('status-line');
    const field = (label: string, id: string, control: HTMLElement) =>
      h('div', { class: 'field' }, h('label', { for: id }, label), control);
    clear(
      app,
      h(
        'form',
        { class: 'filters', role: 'search', onsubmit: (e) => e.preventDefault() },
        field('Search name or street', 'search', search),
        field('City', 'city', city),
        field('Precinct', 'precinct', precinct),
        field('Party', 'party', party),
        field('Sort by', 'sort', sort),
      ),
      count,
      list,
      more,
    );
    render();
  } catch (e) {
    clear(app, h('p', { class: 'callout callout--warn', role: 'alert' }, failureText(e)));
  }
}
