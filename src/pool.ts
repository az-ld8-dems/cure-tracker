// "Find people": everyone who still needs curing and has no volunteer yet. Filter by city, precinct, party or how far away, sort, and claim.
import type { PeoplePage, Person } from './api.d.ts';
import {
  $,
  addressText,
  api,
  assignBox,
  banner,
  boot,
  clear,
  daysText,
  failureText,
  field,
  flagBadge,
  h,
  loadVolunteers,
  mayOrganize,
  personName,
  phoneHref,
  plural,
  statusBadge,
  titleCase,
  toast,
} from './common.ts';
import { createFilters } from './filters.ts';

const me = await boot();
const app = $('#app');

// People shown at first, and added by each press of "Show more".
const PAGE = 30;

if (me) {
  // The people loaded so far, and whether there are more after them.
  let people: Person[] = [];
  let hasMore = false;
  // Who an organizer can assign people to (everyone but themselves), and whether the list has the assign column at all.
  const assignees = me.organizes ? [...(await loadVolunteers()).values()].filter((v) => v.id !== me.id) : [];
  const organizes = me.organizes !== null;

  // Three headers sort the table: a click asks for that sort, a second click runs it the other way, and the active one says which way it
  // runs (aria-sort). The "Sort by" select does the same on a phone and stays in step, except that it only picks the natural direction.
  let reversed = false;
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
  // The filters are shared with the map (src/filters.ts). The list adds its sort, and follows a search by distance with "nearest first".
  const filters = createFilters({
    me,
    extra: [field('sort', 'Sort by', sort)],
    onChange: (force) => {
      if (force) reversed = false;
      void reload(force);
    },
    onNear: ({ by, started }) => {
      const nearest = sort.querySelector<HTMLOptionElement>('option[value="distance"]');
      if (nearest) nearest.disabled = !by;
      // Picking a radius for the first time means "who is closest"; dropping it puts the sort back.
      if (started) sort.value = 'distance';
      if (!by && sort.value === 'distance') sort.value = 'days';
      awayHead.hidden = !by;
    },
  });

  const count = h('p', { class: 'fl-note', role: 'status' });
  // Two views of the same page: a table where there is room, and compact rows on a phone. CSS shows one of them (.pool-table, .pool-rows).
  const tbody = h('tbody');
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
          organizes ? h('th', { scope: 'col' }, 'Assign') : null,
        ),
      ),
      tbody,
    ),
  );
  const list = h('ul', { class: 'pool-rows' });
  const more = h('div', { class: 'fl-cluster' });

  // "1.3 mi", or "about 1.3 mi" for someone who only has the middle of their ZIP.
  const awayText = (p: Person): string =>
    p.distanceMiles === undefined ? '' : `${p.approximate ? 'about ' : ''}${p.distanceMiles.toFixed(1)} mi`;

  // The server filters, sorts and pages; the page asks again when a filter changes. A slow answer to an older question is dropped.
  let asked = 0;

  function question(offset: number): string {
    const params = new URLSearchParams({ scope: 'pool', sort: sort.value, limit: String(PAGE), offset: String(offset) });
    if (reversed) params.set('dir', 'desc');
    for (const [name, value] of filters.params()) params.set(name, value);
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

  // Gives the person to a volunteer; they leave the pool, so the list drops them.
  const assignedAway = async (p: Person): Promise<void> => {
    people = people.filter((x) => x.id !== p.id);
    if (people.length === 0 && hasMore) await reload(true);
    else render();
  };
  const assignCell = (p: Person): HTMLElement | null => (mayOrganize(me, p.precinct) ? assignBox(p, assignees, assignedAway) : null);

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
      h('td', { class: 'fl-nowrap', hidden: !filters.searchingByDistance() }, awayText(p)),
      h('td', {}, p.reasonCode ? titleCase(p.reasonCode) : ''),
      h('td', {}, claimButton(p)),
      organizes ? h('td', {}, assignCell(p)) : null,
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
      assignCell(p),
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
    const hint = filters.hint();
    count.textContent =
      people.length === 0
        ? `${filters.narrowing() ? 'Nobody matches.' : 'Nobody is waiting for a volunteer right now.'}${hint}`
        : `Showing ${plural(people.length, 'person', 'people')}${hasMore ? ', with more to show' : ''}.${hint}`;
    clear(tbody, ...people.map(tableRow));
    clear(list, ...people.map(compactRow));
    clear(more, hasMore ? h('button', { class: 'fl-btn', type: 'button', onclick: showMore }, 'Show more') : null);
  }

  try {
    showSort();
    const firstQuestion = question(0);
    const first = await api<PeoplePage>('GET', `${firstQuestion}&facets=1`);
    people = first.people;
    hasMore = first.hasMore;
    lastQuestion = firstQuestion;
    filters.load(first.facets ?? { cities: [], parties: [], precincts: [], precinctsByCity: {} });
    clear(app, filters.element, count, table, list, more);
    render();
    // The address's filters can turn the choices into a different question (a radius picks "nearest first").
    if (question(0) !== firstQuestion) void reload();
  } catch (e) {
    clear(app, banner('warn', h('p', {}, failureText(e))));
  }
}
