// The admin page: upload the state's sheet, see how curing is going, answer the people the upload flagged, move people between
// volunteers, and read the audit log.

import type {
  AdminSettings,
  AdminStats,
  AuditEntry,
  ColumnField,
  ColumnMap,
  ColumnPick,
  GeocodeProgress,
  OrganizerGrant,
  OrganizerList,
  PeoplePage,
  Person,
  PossibleMatch,
  ResetResult,
  UnplacedPage,
  UploadPreview,
  UploadRecord,
  Volunteer,
} from './api.d.ts';
import { describeAudit } from './audit-text.ts';
import {
  $,
  ApiFailure,
  addressText,
  api,
  banner,
  boot,
  clear,
  dateTime,
  failureText,
  field,
  flagBadge,
  h,
  loadVolunteers,
  personName,
  plural,
  statusLabel,
  tiles,
  toast,
  volunteerName,
} from './common.ts';
import { PRECINCTS } from './precincts.ts';
import { describeColumns, ImportError } from './sheet.ts';
import { finishSheet, mergeAndPlan, stageSheet } from './upload.ts';

// Why a listed pair looks like one person.
const MATCH_WHY: Record<PossibleMatch['kind'], string> = {
  address: 'Same last name and address',
  surname: 'Same first name and address',
  moved: 'Same name, different address',
};

const me = await boot();
const app = $('#app');

if (me && !me.isAdmin && !me.organizes) {
  clear(app, banner('warn', h('p', {}, 'This page is for admins.')));
} else if (me) {
  // A site admin sees everything; a precinct organizer sees the numbers, the flagged people and the volunteers of their own precincts, and can move people.
  const siteAdmin = me.isAdmin;
  let volunteers = new Map<number, Volunteer>();
  const sections = {
    upload: h('section', { class: 'fl-stack fl-stack--3', 'aria-labelledby': 'h-upload' }),
    settings: h('section', { class: 'fl-stack fl-stack--3', 'aria-labelledby': 'h-settings' }),
    stats: h('section', { class: 'fl-stack fl-stack--3', 'aria-labelledby': 'h-stats' }),
    geocode: h('section', { class: 'fl-stack fl-stack--3', 'aria-labelledby': 'h-geocode' }),
    flagged: h('section', { class: 'fl-stack fl-stack--3', 'aria-labelledby': 'h-flagged' }),
    volunteers: h('section', { class: 'fl-stack fl-stack--3', 'aria-labelledby': 'h-volunteers' }),
    find: h('section', { class: 'fl-stack fl-stack--3', 'aria-labelledby': 'h-find' }),
    organizers: h('section', { class: 'fl-stack fl-stack--3', 'aria-labelledby': 'h-organizers' }),
    reset: h('section', { class: 'fl-stack fl-stack--3', 'aria-labelledby': 'h-reset' }),
    audit: h('section', { class: 'fl-stack fl-stack--3', 'aria-labelledby': 'h-audit' }),
  };

  const heading = (id: string, text: string) => h('h2', { id }, text);
  const table = (label: string, head: (Node | string)[], rows: (Node | string)[][], numeric: number[] = []) =>
    h(
      'div',
      { class: 'fl-table-wrap', role: 'region', 'aria-label': label, tabindex: '0' },
      h(
        'table',
        { class: 'fl-table' },
        h('thead', {}, h('tr', {}, ...head.map((t, i) => h('th', { scope: 'col', class: numeric.includes(i) ? 'fl-num' : undefined }, t)))),
        h(
          'tbody',
          {},
          ...rows.map((r) => h('tr', {}, ...r.map((c, i) => h('td', { class: numeric.includes(i) ? 'fl-num' : undefined }, c)))),
        ),
      ),
    );

  const volunteerSelect = (id: string, current: number | null, none: string, exclude?: number): HTMLSelectElement =>
    h(
      'select',
      { class: 'fl-select', id },
      h('option', { value: '' }, none),
      ...[...volunteers.values()]
        .filter((v) => v.id !== exclude)
        .map((v) => h('option', { value: String(v.id), selected: v.id === current }, volunteerName(v))),
    );
  const idOrNull = (select: HTMLSelectElement): number | null => (select.value === '' ? null : Number(select.value));

  // ---- upload
  function uploadSection(): void {
    const file = h('input', { class: 'fl-input', id: 'sheet', type: 'file', accept: '.csv,text/csv,text/plain' });
    const result = h('div', { class: 'fl-stack', role: 'status' });
    // The file's text, so the columns can be shown again when it cannot be read, and the upload the Worker is holding for it.
    let csv = '';
    let token = '';

    const show = (...children: (Node | null)[]) => clear(result, ...children);
    const problem = (e: unknown): HTMLElement => {
      const failure = e instanceof ApiFailure || e instanceof ImportError ? e : null;
      return banner(
        'warn',
        h('p', {}, h('strong', {}, failureText(e))),
        failure && failure.problems.length > 0 ? h('ul', { class: 'fl-list' }, ...failure.problems.map((t) => h('li', {}, t))) : null,
      );
    };

    // Which column of the file is which field, as the admin chose it. Unset, the server matches by name and by what the last upload used.
    let picks: ColumnPick | undefined;

    // The file's columns and what each field is matched to, as selects. It is open when a required column has no match.
    function mappingForm(map: ColumnMap): HTMLElement {
      const matched = map.choices.filter((c) => c.header !== null).length;
      const selects = new Map<ColumnField, HTMLSelectElement>();
      const rows = map.choices.map((c) => {
        const example = h('p', { class: 'fl-help', id: `col-${c.field}-example` });
        const select = h(
          'select',
          { class: 'fl-select', id: `col-${c.field}`, 'aria-describedby': example.id },
          h('option', { value: '' }, c.required ? 'Choose a column' : 'No column in this file'),
          ...map.headers.map((name) => h('option', { value: name, selected: name === c.header }, name)),
        );
        const showExample = () => {
          const sample = select.value === '' ? null : map.sample[map.headers.indexOf(select.value)];
          example.textContent = sample === null || sample === undefined ? '' : `Example: ${sample === '' ? '(empty)' : sample}`;
        };
        select.addEventListener('change', showExample);
        showExample();
        selects.set(c.field, select);
        const wrap = field(`col-${c.field}`, c.required ? `${c.label} (needed)` : c.label, select);
        wrap.append(example);
        return wrap;
      });
      const again = h(
        'button',
        {
          class: 'btn',
          type: 'button',
          onclick: () => {
            const chosen: ColumnPick = {};
            for (const [name, select] of selects) chosen[name] = select.value === '' ? null : select.value;
            void check(chosen);
          },
        },
        'Check the file again',
      );
      const box = h(
        'details',
        { class: 'fl-disclosure' },
        h('summary', {}, `Columns: ${matched} of ${map.choices.length} matched`),
        h(
          'div',
          { class: 'fl-stack fl-stack--3' },
          h(
            'p',
            { class: 'fl-help' },
            'The state may rename or move columns. Say which column of this file holds each thing; the next upload starts from this.',
          ),
          h('div', { class: 'fl-toolbar columns-grid' }, ...rows),
          h('div', { class: 'fl-cluster' }, again),
        ),
      );
      box.open = !map.ready;
      return box;
    }

    async function check(choice?: ColumnPick): Promise<void> {
      const chosen = file.files?.[0];
      if (!chosen) {
        show(banner('warn', h('p', {}, 'Choose the CSV file first.')));
        return;
      }
      picks = choice;
      token = '';
      csv = await chosen.text();
      show(h('p', { class: 'fl-help' }, 'Reading the file…'));
      let tenth = -1;
      try {
        const staged = await stageSheet(csv, chosen.name, api, {
          ...(picks ? { picked: picks } : {}),
          // Say so at every tenth, not every request: the status line is read out as it changes.
          progress: (sent, total) => {
            if (Math.floor((sent * 10) / total) === tenth) return;
            tenth = Math.floor((sent * 10) / total);
            show(h('p', { class: 'fl-help' }, `Sending the people to the server: ${sent} of ${total}…`));
          },
        });
        token = staged.token;
        showPreview(staged.preview);
      } catch (e) {
        show(problem(e));
        // Most often the file's columns are not the ones expected: show them, so the admin can say which is which.
        if (e instanceof ImportError) {
          try {
            const saved = await api<ColumnPick>('GET', '/api/admin/uploads/columns');
            show(problem(e), mappingForm(describeColumns(csv, saved, picks)));
          } catch {
            show(problem(e));
          }
        }
      }
    }

    // Mark a listed pair as the same person, or not: the Worker keeps the marks with the staged sheet and works the counts out again. A
    // person can be in one pair, so choosing one clears any other pair with the same person in it.
    async function decide(p: UploadPreview, m: PossibleMatch, on: boolean, row: number): Promise<void> {
      const keep = p.possibleMatches.filter((x) => x.merged && x.existing.id !== m.existing.id && x.incoming.key !== m.incoming.key);
      const chosen = (on ? [...keep, m] : p.possibleMatches.filter((x) => x.merged && x !== m)).map((x) => ({
        id: x.existing.id,
        key: x.incoming.key,
      }));
      try {
        showPreview(await mergeAndPlan(token, chosen, api), row);
      } catch (e) {
        show(problem(e));
      }
    }

    function showPreview(p: UploadPreview, focusRow?: number): void {
      const force = h('input', { id: 'force', type: 'checkbox' });
      const go = h(
        'button',
        {
          class: 'btn btn--accent',
          type: 'button',
          onclick: async () => {
            go.disabled = true;
            try {
              const done = await finishSheet(token, force.checked, api);
              toast(`Upload ${done.id} applied: ${p.added} added, ${p.cured} cured.`);
              file.value = '';
              show(banner('info', h('p', {}, `Uploaded. ${p.added} added, ${p.cured} cured, ${p.stillUncured + p.reappeared} flagged.`)));
              await refresh();
            } catch (e) {
              go.disabled = false;
              show(problem(e));
            }
          },
        },
        'Upload this file',
      );
      show(
        tiles(
          [p.added, 'New people'],
          [p.updated, 'Already known'],
          [p.cured, 'Newly cured'],
          [p.stillUncured, 'Unsuccessful cures'],
          [p.reappeared, 'Back after being cured'],
        ),
        h(
          'p',
          { class: 'fl-help' },
          `${plural(p.rows, 'row')} read. Left out: ${p.skippedOtherDistrict} from other districts, ${p.skippedInvalid} without a name or address, ${p.duplicates} repeated.`,
        ),
        p.warnings.length > 0
          ? banner(
              'warn',
              h('p', {}, h('strong', {}, 'Check before uploading')),
              h('ul', { class: 'fl-list' }, ...p.warnings.map((w) => h('li', {}, w))),
            )
          : null,
        p.possibleMatchCount > 0
          ? h(
              'div',
              { class: 'fl-stack fl-stack--3' },
              h('h3', {}, 'Possible matches'),
              h(
                'p',
                { class: 'fl-help' },
                'A new person next to someone who disappeared. If they are the same person, tick it: the upload then updates the old record, with its notes, volunteer and status. If not, the old one is cured and the new one added as a stranger.',
              ),
              table(
                'Possible matches',
                ['Same person?', 'Who disappeared', 'Who appeared', 'Why'],
                p.possibleMatches.map((m, i) => [
                  h(
                    'label',
                    { class: 'fl-check', for: `merge-${i}` },
                    h('input', {
                      id: `merge-${i}`,
                      type: 'checkbox',
                      checked: m.merged,
                      onchange: (e: Event) => void decide(p, m, (e.target as HTMLInputElement).checked, i),
                    }),
                    h('span', { class: 'fl-sr-only' }, `${m.existing.name} and ${m.incoming.name} are `),
                    'the same person',
                  ),
                  `${m.existing.name}, ${m.existing.address}`,
                  `${m.incoming.name}, ${m.incoming.address}`,
                  MATCH_WHY[m.kind],
                ]),
              ),
              p.possibleMatchCount > p.possibleMatches.length
                ? h('p', { class: 'fl-help' }, `And ${p.possibleMatchCount - p.possibleMatches.length} more.`)
                : null,
            )
          : null,
        p.looksPartial
          ? h(
              'label',
              { class: 'fl-check', for: 'force' },
              force,
              `Upload it anyway. I know this cures ${p.cured} of ${p.openBefore} people.`,
            )
          : null,
        mappingForm(p.columns),
        go,
        h('p', { class: 'fl-help' }, `Cities found: ${p.cities.map((c) => `${c.city || 'unknown'} (${c.count})`).join(', ')}.`),
      );
      // The page was drawn again with the new counts: keep the keyboard where it was.
      if (focusRow !== undefined) document.querySelector<HTMLInputElement>(`#merge-${focusRow}`)?.focus();
    }

    clear(
      sections.upload,
      heading('h-upload', 'Upload the state’s sheet'),
      h(
        'div',
        { class: 'fl-card' },
        h(
          'p',
          {},
          'Export the LD8 tab as a CSV and choose it here. Nothing changes until you press Upload; this check only shows what would happen.',
        ),
        field('sheet', 'CSV file', file),
        h('button', { class: 'btn', type: 'button', onclick: () => check() }, 'Check the file'),
        result,
      ),
    );
  }

  // ---- the grace period
  function settingsSection(settings: AdminSettings): void {
    const grace = h('input', {
      class: 'fl-input',
      id: 'grace',
      type: 'number',
      min: '0',
      max: '30',
      step: '1',
      inputmode: 'numeric',
      required: true,
      value: String(settings.graceCycles),
    });
    clear(
      sections.settings,
      heading('h-settings', 'Unsuccessful cures'),
      h(
        'form',
        {
          class: 'fl-card',
          onsubmit: async (event) => {
            event.preventDefault();
            try {
              const saved = await api<AdminSettings>('PUT', '/api/admin/settings', { graceCycles: Number(grace.value) });
              toast(`Saved: ${plural(saved.graceCycles, 'upload')} of grace.`);
            } catch (e) {
              toast(failureText(e), 'error');
            }
          },
        },
        field(
          'grace',
          'Uploads a contacted person may stay on the list',
          grace,
          'The state’s data runs behind the phone calls. After a volunteer marks someone contacted, this many uploads may still list them before it counts as an unsuccessful cure.',
        ),
        h('button', { class: 'btn', type: 'submit' }, 'Save'),
      ),
    );
  }

  // ---- who organizes which precincts
  let organizerList: OrganizerList = { grants: [], precincts: [], siteAdmins: [] };
  let editingGrant: number | null = null;
  function organizersSection(): void {
    const known = new Set(organizerList.precincts.map((p) => p.toLowerCase()));
    const grantOf = (id: number) => organizerList.grants.find((g) => g.volunteerId === id);
    const words = (g: OrganizerGrant | undefined, siteAdmin: boolean): string =>
      siteAdmin
        ? 'All precincts (site admin)'
        : g === undefined
          ? 'Nothing'
          : g.all
            ? 'All precincts'
            : g.precincts.map((p) => (known.has(p.toLowerCase()) ? p : `${p} (no one is in it)`)).join(', ');

    const form = (v: Volunteer): HTMLElement => {
      const g = grantOf(v.id);
      const all = h('input', { id: 'grant-all', type: 'checkbox', checked: g?.all === true });
      const list = h('input', {
        class: 'fl-input',
        id: 'grant-precincts',
        type: 'text',
        autocomplete: 'off',
        list: 'grant-known',
        maxlength: '2000',
        value: g && !g.all ? g.precincts.join(', ') : '',
      });
      return h(
        'form',
        {
          class: 'fl-card fl-stack fl-stack--3',
          onsubmit: async (event: Event) => {
            event.preventDefault();
            const precincts = list.value
              .split(',')
              .map((t) => t.trim())
              .filter((t) => t !== '');
            try {
              await api<OrganizerGrant>('PUT', `/api/admin/volunteers/${v.id}/organizer`, { all: all.checked, precincts });
              toast(`Saved what ${volunteerName(v)} organizes.`);
              editingGrant = null;
              await refresh();
            } catch (e) {
              toast(failureText(e), 'error');
            }
          },
        },
        h('h3', {}, `What ${volunteerName(v)} organizes`),
        organizerList.siteAdmins.includes(v.id)
          ? h(
              'p',
              { class: 'fl-help' },
              `${volunteerName(v)} is a site admin, who organizes every precinct whatever is set here. Site admins are set in the Worker secret, not in this page.`,
            )
          : null,
        h('label', { class: 'fl-check', for: 'grant-all' }, all, 'All precincts'),
        field(
          'grant-precincts',
          'Or only these precincts',
          list,
          'Precincts of the district, separated with commas (the box suggests them). Leave it empty, with the box unchecked, to take the access away. People with no precinct can be moved by anyone who organizes.',
        ),
        h('datalist', { id: 'grant-known' }, ...PRECINCTS.map(([city, name]) => h('option', { value: name }, city))),
        h(
          'div',
          { class: 'fl-cluster' },
          h('button', { class: 'btn', type: 'submit' }, 'Save access'),
          h(
            'button',
            {
              class: 'fl-btn',
              type: 'button',
              onclick: () => {
                editingGrant = null;
                organizersSection();
              },
            },
            'Cancel',
          ),
        ),
      );
    };

    const editing = editingGrant === null ? undefined : volunteers.get(editingGrant);
    clear(
      sections.organizers,
      heading('h-organizers', 'Who organizes precincts'),
      h(
        'p',
        { class: 'fl-help' },
        'A precinct organizer can move the people of their precincts to any volunteer and clear their flags. They cannot upload, delete or change who organizes. Site admins are set in the Worker secret and organize everything.',
      ),
      editing ? form(editing) : null,
      volunteers.size === 0
        ? h('p', { class: 'fl-help' }, 'Nobody has signed in yet.')
        : table(
            'Volunteers and what they organize',
            ['Volunteer', 'Organizes', 'Change'],
            [...volunteers.values()].map((v) => [
              volunteerName(v),
              words(grantOf(v.id), organizerList.siteAdmins.includes(v.id)),
              h(
                'button',
                {
                  class: 'fl-btn fl-btn--sm',
                  type: 'button',
                  'aria-label': `Change what ${volunteerName(v)} organizes`,
                  onclick: () => {
                    editingGrant = v.id;
                    organizersSection();
                    $('#grant-all').focus();
                  },
                },
                'Change',
              ),
            ]),
          ),
    );
  }

  // ---- numbers and people
  // ---- where people live
  // Whether the list of unplaced people was open, so it stays open when the page draws itself again after a change.
  let unplacedOpen = false;
  function geocodeSection(s: AdminStats): void {
    const g = s.geocode;
    const status = h('p', { class: 'fl-help', role: 'status' });

    // Looks up, a chunk at a time, until nobody is left. `retry` asks again about those the geocoder could not place.
    async function lookUp(buttons: HTMLButtonElement[], retry: boolean, total: number): Promise<void> {
      for (const b of buttons) b.disabled = true;
      let after = 0;
      let sent = 0;
      let placed = 0;
      let roughly = 0;
      let tenth = -1;
      try {
        for (;;) {
          const r = await api<GeocodeProgress>('POST', '/api/admin/geocode', { after, retry });
          sent += r.sent;
          placed += r.matched;
          roughly += r.approximated;
          // Say so at every tenth: the status line is read out as it changes.
          if (Math.floor((sent * 10) / Math.max(1, total)) !== tenth) {
            tenth = Math.floor((sent * 10) / Math.max(1, total));
            status.textContent = `Looked up ${sent} of ${total} addresses: ${placed} placed…`;
          }
          if (r.next === null) break;
          after = r.next;
        }
        toast(
          `Looked up ${plural(sent, 'address', 'addresses')}: ${placed} placed${roughly > 0 ? `, ${roughly} put at the middle of their ZIP` : ''}.`,
        );
        await refresh();
      } catch (e) {
        for (const b of buttons) b.disabled = false;
        status.textContent = `Stopped after ${sent} addresses: ${failureText(e)} Press the button to continue; the ones already done are not sent again.`;
      }
    }

    const go = h(
      'button',
      { class: 'btn', type: 'button', disabled: g.waiting === 0, onclick: () => lookUp([go, again], false, g.waiting) },
      g.waiting === 0 ? 'Nobody is waiting' : `Look up ${plural(g.waiting, 'address', 'addresses')}`,
    );
    const again = h(
      'button',
      { class: 'btn', type: 'button', disabled: g.unmatched === 0, onclick: () => lookUp([go, again], true, g.unmatched) },
      'Look up the unplaced again',
    );

    // The people it could not place, so an admin can look them up by hand: loaded when the list is first opened, 50 at a time.
    const rows = h('div', { class: 'fl-stack fl-stack--3' });
    let shown: UnplacedPage['people'] = [];
    let loaded = false;
    const WHY = { no_match: 'No match', tie: 'More than one place' } as const;
    // "33.4295, -111.9628" as a map shows it (latitude first), or null.
    function parsePlace(text: string): { lat: number; lon: number } | null {
      const nums = (text.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
      const [lat, lon] = nums;
      return nums.length === 2 && lat !== undefined && lon !== undefined && Math.abs(lat) <= 90 ? { lat, lon } : null;
    }
    async function placeByHand(p: UnplacedPage['people'][number], body: object, done: string): Promise<void> {
      try {
        await api('POST', `/api/admin/people/${p.id}/place`, body);
        toast(done);
        await refresh();
      } catch (e) {
        toast(failureText(e), 'error');
      }
    }
    function placeBox(p: UnplacedPage['people'][number]): HTMLElement {
      const input = h('input', {
        class: 'fl-input',
        type: 'text',
        inputmode: 'decimal',
        autocomplete: 'off',
        placeholder: '33.4295, -111.9628',
        'aria-label': `Latitude and longitude for ${p.name}`,
        value: p.byHand ? `${p.byHand.lat}, ${p.byHand.lon}` : '',
      });
      return h(
        'form',
        {
          class: 'fl-cluster pool-near-row',
          onsubmit: (e: Event) => {
            e.preventDefault();
            const place = parsePlace(input.value);
            if (!place) {
              toast('Write latitude, then longitude, like 33.4295, -111.9628.', 'error');
              return;
            }
            void placeByHand(p, place, `Placed ${p.name}.`);
          },
        },
        input,
        h('button', { class: 'fl-btn fl-btn--sm', type: 'submit', 'aria-label': `Set the place of ${p.name}` }, 'Set'),
        p.byHand
          ? h(
              'button',
              {
                class: 'fl-btn fl-btn--sm',
                type: 'button',
                'aria-label': `Take away the place of ${p.name}`,
                onclick: () => void placeByHand(p, { clear: true }, `Took away the place of ${p.name}.`),
              },
              'Clear',
            )
          : null,
      );
    }
    async function loadMore(after: number): Promise<void> {
      const page = await api<UnplacedPage>('GET', `/api/admin/geocode/unplaced?after=${after}`);
      shown = [...shown, ...page.people];
      clear(
        rows,
        shown.length === 0
          ? h('p', { class: 'fl-help' }, 'Everyone has a place.')
          : table(
              'People the geocoder could not place',
              ['Person', 'Address', 'Why', 'For now', 'Place by hand', h('span', { class: 'fl-sr-only' }, 'Copy')],
              shown.map((p) => [
                p.name,
                addressText(p.address),
                WHY[p.reason],
                p.byHand ? 'Placed by hand' : p.approximate ? 'Middle of their ZIP' : 'No place',
                placeBox(p),
                h(
                  'button',
                  {
                    class: 'fl-btn fl-btn--sm',
                    type: 'button',
                    'aria-label': `Copy the address of ${p.name}`,
                    onclick: async () => {
                      await navigator.clipboard.writeText(addressText(p.address));
                      toast('Address copied.');
                    },
                  },
                  'Copy',
                ),
              ]),
            ),
        page.next === null
          ? null
          : h('button', { class: 'fl-btn', type: 'button', onclick: () => void loadMore(page.next ?? 0) }, 'Show more'),
      );
    }
    // The whole list as a CSV, to take to another tool.
    async function download(): Promise<void> {
      const lines = ['NAME,ADDRESS,WHY,FOR_NOW'];
      const quote = (v: string) => `"${v.replaceAll('"', '""')}"`;
      for (let after = 0; ; ) {
        const page = await api<UnplacedPage>('GET', `/api/admin/geocode/unplaced?after=${after}`);
        for (const p of page.people)
          lines.push([p.name, p.address, WHY[p.reason], p.approximate ? 'middle of ZIP' : 'none'].map(quote).join(','));
        if (page.next === null) break;
        after = page.next;
      }
      const link = h('a', {
        href: URL.createObjectURL(new Blob([`${lines.join('\n')}\n`], { type: 'text/csv' })),
        download: 'unplaced-addresses.csv',
      });
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(link.href);
    }
    const list = h(
      'details',
      { class: 'fl-disclosure' },
      h('summary', {}, `The geocoder could not place (${g.unmatched})`),
      h(
        'div',
        { class: 'fl-stack fl-stack--3' },
        h(
          'p',
          { class: 'fl-help' },
          'People the geocoder could not place, often a PO box, a rural route, a new street or a typo. To place one by hand, look the address up on a map and write latitude, then longitude, in the box (a right-click on Google Maps or Apple Maps gives both). Looking them up again also tries the street alone, with no city or ZIP, which finds addresses on a boundary between towns, and accepts the answer only if it is within about 15 miles of the middle of their ZIP. Until someone looks them up, each is put at the middle of their ZIP (marked approximate) when enough people there were placed.',
        ),
        rows,
        h(
          'div',
          { class: 'fl-cluster' },
          h('button', { class: 'btn', type: 'button', onclick: () => void download() }, 'Download the list as a CSV'),
        ),
      ),
    );
    list.addEventListener('toggle', () => {
      unplacedOpen = list.open;
      if (!list.open || loaded) return;
      loaded = true;
      void loadMore(0);
    });
    if (unplacedOpen) {
      list.open = true;
      loaded = true;
      void loadMore(0);
    }

    clear(
      sections.geocode,
      heading('h-geocode', 'Where people live'),
      h(
        'div',
        { class: 'fl-card' },
        h(
          'p',
          {},
          `${g.matched} placed exactly${g.byHand > 0 ? ` (${g.byHand} by hand)` : ''}, ${g.approximate} placed roughly (a close match, or the middle of their ZIP), ${g.waiting} waiting, ${g.noPlace} with no place.`,
        ),
        h(
          'p',
          { class: 'fl-help' },
          'Looking people up sends each waiting address (street, city, state and ZIP, with an id) to the US Census Bureau’s public geocoder, a couple of hundred at a time. Names, phone numbers and notes are never sent, and an address already looked up is not sent again. A new upload that changes someone’s address puts them back in line.',
        ),
        g.sample.length > 0
          ? h(
              'div',
              { class: 'fl-stack fl-stack--3' },
              h('p', { class: 'fl-help' }, 'The first lines of the next request:'),
              h('ul', { class: 'fl-list' }, ...g.sample.map((line) => h('li', {}, h('code', {}, line)))),
            )
          : null,
        h('div', { class: 'fl-cluster' }, go, again),
        status,
        g.unmatched > 0 ? list : null,
      ),
    );
  }

  function statsSection(s: AdminStats): void {
    const t = s.totals;
    const last: UploadRecord | null = s.lastUpload;
    clear(
      sections.stats,
      heading('h-stats', 'Where things stand'),
      tiles(
        [t.unassigned, 'Waiting for a volunteer'],
        [t.needsContact, 'To contact'],
        [t.leftVoicemail, 'Left voicemail'],
        [t.contacted, 'Contacted'],
        [t.cured, 'Cured'],
      ),
      h(
        'p',
        { class: 'fl-help' },
        !siteAdmin
          ? null
          : last
            ? `Last upload: ${last.filename || `number ${last.id}`}, ${dateTime(last.createdAt)}, by ${last.uploadedBy}.`
            : 'Nothing has been uploaded yet.',
      ),
    );
  }

  function flaggedSection(s: AdminStats): void {
    clear(
      sections.flagged,
      heading('h-flagged', `Needs another look (${s.flagged.length})`),
      s.flagged.length === 0
        ? h(
            'p',
            { class: 'fl-help' },
            'Nobody is flagged. People show up here as an unsuccessful cure (still on the state’s sheet after a volunteer marked them contacted) or when someone who was cured is listed again.',
          )
        : table(
            'People who need another look',
            ['Person', 'Why', 'Volunteer', 'Move to', ''],
            s.flagged.map((p) => {
              const move = volunteerSelect(`flag-${p.id}`, p.assignedTo, 'Back to the pool');
              move.setAttribute('aria-label', `Move ${personName(p)}`);
              move.addEventListener('change', () => assign(p, idOrNull(move)));
              return [
                h('span', {}, personName(p), h('br', {}), h('span', { class: 'fl-help' }, `${p.phone || 'no phone'}, ${p.city}`)),
                p.flag ? flagBadge(p.flag) : '',
                p.assignedTo === null ? 'Nobody' : volunteerName(volunteers.get(p.assignedTo)),
                move,
                h('button', { class: 'fl-btn fl-btn--sm', type: 'button', onclick: () => dismiss(p) }, 'Dismiss'),
              ];
            }),
          ),
    );
  }

  function volunteersSection(s: AdminStats): void {
    clear(
      sections.volunteers,
      heading('h-volunteers', 'Volunteers'),
      s.volunteers.length === 0
        ? h('p', { class: 'fl-help' }, 'Nobody has signed in yet.')
        : table(
            'Volunteers and their people',
            ['Volunteer', 'Open', 'To contact', 'Voicemail', 'Contacted', 'Cured', 'Flagged', 'Last seen', 'Move all open people to'],
            s.volunteers.map((v) => {
              const to = volunteerSelect(`move-${v.id}`, null, 'Back to the pool', v.id);
              to.setAttribute('aria-label', `Move everyone ${volunteerName(v)} has open`);
              const move = h('button', { class: 'fl-btn fl-btn--sm', type: 'button', disabled: v.assigned === 0 }, 'Move');
              // Moving a volunteer's whole list is one step too big to do on one click: Frostline asks first, in place.
              window.Frostline.confirm(move, {
                message: `Move ${plural(v.assigned, 'person', 'people')} from ${volunteerName(v)}?`,
                confirmLabel: 'Move them',
                cancelLabel: 'Keep them',
                onConfirm: async () => {
                  try {
                    const r = await api<{ moved: number }>('POST', `/api/admin/volunteers/${v.id}/reassign`, { volunteerId: idOrNull(to) });
                    toast(`Moved ${plural(r.moved, 'person', 'people')} from ${volunteerName(v)}.`);
                    await refresh();
                  } catch (e) {
                    toast(failureText(e), 'error');
                  }
                },
              });
              return [
                h('span', {}, volunteerName(v), v.name ? h('span', { class: 'fl-help' }, ` ${v.email}`) : null),
                String(v.assigned),
                String(v.needsContact),
                String(v.leftVoicemail),
                String(v.contacted),
                String(v.cured),
                String(v.flagged),
                dateTime(v.lastSeenAt),
                h('span', { class: 'fl-cluster' }, to, move),
              ];
            }),
            [1, 2, 3, 4, 5, 6],
          ),
    );
  }

  async function assign(p: Person, volunteerId: number | null): Promise<void> {
    try {
      await api<Person>('POST', `/api/admin/people/${p.id}/assign`, { volunteerId });
      toast(`${personName(p)} now belongs to ${volunteerId === null ? 'the pool' : volunteerName(volunteers.get(volunteerId))}.`);
      await refresh();
    } catch (e) {
      toast(failureText(e), 'error');
    }
  }

  async function dismiss(p: Person): Promise<void> {
    try {
      await api<Person>('POST', `/api/admin/people/${p.id}/dismiss-flag`, {});
      await refresh();
    } catch (e) {
      toast(failureText(e), 'error');
    }
  }

  // ---- find someone and move them
  function findSection(): void {
    let pause: ReturnType<typeof setTimeout> | undefined;
    const q = h('input', {
      class: 'fl-input',
      id: 'find',
      type: 'search',
      autocomplete: 'off',
      oninput: () => {
        clearTimeout(pause);
        pause = setTimeout(results, 250);
      },
    });
    const out = h('div', { class: 'fl-stack' });
    // The server searches; a slow answer to an older search is dropped.
    let searches = 0;
    async function results(): Promise<void> {
      const needle = q.value.trim();
      const mine = ++searches;
      if (needle.length < 2) {
        clear(out, h('p', { class: 'fl-help' }, 'Type at least two letters.'));
        return;
      }
      let found: Person[];
      try {
        found = (await api<PeoplePage>('GET', `/api/people?scope=all&limit=15&q=${encodeURIComponent(needle)}`)).people;
      } catch (e) {
        if (mine === searches) clear(out, banner('warn', h('p', {}, failureText(e))));
        return;
      }
      if (mine !== searches) return;
      clear(
        out,
        found.length === 0
          ? h('p', { class: 'fl-help' }, 'Nobody matches.')
          : table(
              'People found',
              ['Person', 'Status', 'Volunteer', 'Move to'],
              found.map((p) => {
                const move = volunteerSelect(`assign-${p.id}`, p.assignedTo, 'Nobody (the pool)');
                move.setAttribute('aria-label', `Move ${personName(p)}`);
                move.disabled = p.status === 'cured';
                move.addEventListener('change', () => assign(p, idOrNull(move)));
                return [
                  h('span', {}, personName(p), h('br', {}), h('span', { class: 'fl-help' }, addressText(p.address))),
                  statusLabel(p.status),
                  p.assignedTo === null ? 'Nobody' : volunteerName(volunteers.get(p.assignedTo)),
                  move,
                ];
              }),
            ),
      );
    }
    clear(
      sections.find,
      heading('h-find', 'Find someone and move them'),
      h('div', { class: 'fl-card' }, field('find', 'Name, street or phone', q), out),
    );
    results();
  }

  // ---- start over (only where the deployment turns it on)
  function resetSection(settings: AdminSettings): void {
    sections.reset.hidden = !settings.resetEnabled;
    if (!settings.resetEnabled) {
      clear(sections.reset);
      return;
    }
    const button = h('button', { class: 'fl-btn fl-btn--danger', type: 'button' }, 'Delete all voters');
    // Deleting everything gets a dialog of its own, with the way back named in it.
    window.Frostline.confirm(button, {
      modal: true,
      title: 'Delete all voters?',
      message:
        'Every voter, every note and the upload history will be deleted. Volunteers, the grace period setting and the audit log stay.',
      detail:
        'This cannot be undone from here. A site admin can restore the database to an earlier minute (D1 Time Travel, docs/setup.md).',
      confirmLabel: 'Delete all voters',
      cancelLabel: 'Keep them',
      onConfirm: async () => {
        try {
          const done = await api<ResetResult>('POST', '/api/admin/reset', { confirm: 'delete all voters' });
          toast(`Deleted ${plural(done.deleted.people, 'voter')} and ${plural(done.deleted.notes, 'note')}.`);
          await refresh();
        } catch (e) {
          toast(failureText(e), 'error');
        }
      },
    });
    clear(
      sections.reset,
      heading('h-reset', 'Start over'),
      h(
        'div',
        { class: 'fl-card' },
        h(
          'p',
          {},
          'Delete every voter, note and upload, for starting over after trying the tool with test data. Turn this off before the real sheet goes in.',
        ),
        button,
      ),
    );
  }

  // ---- audit log
  let log: AuditEntry[] = [];
  const logBody = h('div', { class: 'fl-stack' });
  const describe = (e: AuditEntry): string => describeAudit(e, (id) => (id === null ? 'the pool' : volunteerName(volunteers.get(id))));
  function renderLog(more: boolean): void {
    clear(
      logBody,
      table(
        'Audit log entries',
        ['When', 'Who', 'What', 'Person'],
        log.map((e) => [
          dateTime(e.at),
          e.actor,
          describe(e),
          e.personName ? e.personName.toLowerCase().replace(/(^|\s)\S/g, (m) => m.toUpperCase()) : '',
        ]),
      ),
      more ? h('div', { class: 'fl-cluster' }, h('button', { class: 'fl-btn', type: 'button', onclick: loadMoreLog }, 'Show older')) : null,
    );
  }
  async function loadMoreLog(): Promise<void> {
    const before = log.at(-1)?.id;
    const page = await api<AuditEntry[]>('GET', `/api/admin/audit?limit=50${before === undefined ? '' : `&before=${before}`}`);
    log = [...log, ...page];
    renderLog(page.length === 50);
  }

  async function refresh(): Promise<void> {
    const [stats, vols, firstPage, settings, organizers] = await Promise.all([
      api<AdminStats>('GET', '/api/admin/stats'),
      loadVolunteers(),
      siteAdmin ? api<AuditEntry[]>('GET', '/api/admin/audit?limit=50') : null,
      siteAdmin ? api<AdminSettings>('GET', '/api/admin/settings') : null,
      siteAdmin ? api<OrganizerList>('GET', '/api/admin/organizers') : null,
    ]);
    volunteers = vols;
    statsSection(stats);
    flaggedSection(stats);
    volunteersSection(stats);
    findSection();
    if (firstPage && settings && organizers) {
      log = firstPage;
      organizerList = organizers;
      settingsSection(settings);
      geocodeSection(stats);
      organizersSection();
      resetSection(settings);
      clear(sections.audit, heading('h-audit', 'Audit log'), logBody);
      renderLog(firstPage.length === 50);
    }
  }

  try {
    const shown = siteAdmin ? Object.values(sections) : [sections.stats, sections.flagged, sections.volunteers, sections.find];
    if (!siteAdmin) $('.lead').textContent = 'Check on volunteers and move the people of your precincts around.';
    clear(app, ...shown);
    if (siteAdmin) uploadSection();
    await refresh();
  } catch (e) {
    clear(app, banner('warn', h('p', {}, failureText(e))));
  }
}
