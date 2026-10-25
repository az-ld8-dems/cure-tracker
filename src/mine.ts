// "My people": the voters this volunteer has claimed, with the buttons for what happened and a place for notes.
import type { ContactMethod, Person, PersonDetail, Status, Volunteer } from './api.d.ts';
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
  METHOD_LABELS,
  personName,
  statusBadge,
  tiles,
  toast,
} from './common.ts';

const me = await boot();
const app = $('#app');

// The three things a volunteer can say, with short words for the joined buttons (the badge above them says the full status).
// Cured is only ever set by an upload of the state's sheet.
const CHOICES: [Status, string][] = [
  ['needs_contact', 'Needs contact'],
  ['left_voicemail', 'Left voicemail'],
  ['contacted', 'Contacted'],
];
const ORDER: Record<Status, number> = { needs_contact: 0, left_voicemail: 1, contacted: 2, cured: 3 };

if (me) {
  let people: Person[] = [];
  let volunteers = new Map<number, Volunteer>();
  const summary = h('div', {});
  const listBox = h('div', {});
  const list = h('ul', { class: 'fl-grid people' });
  const curedBox = h('details', { class: 'fl-disclosure' });

  const mine = (): Person[] => people.filter((p) => p.assignedTo === me.id);

  function updateSummary(): void {
    const open = mine().filter((p) => p.status !== 'cured');
    const count = (s: Status) => open.filter((p) => p.status === s).length;
    clear(
      summary,
      tiles(
        [count('needs_contact'), 'To contact'],
        [count('left_voicemail'), 'Left voicemail'],
        [count('contacted'), 'Contacted'],
        [open.filter((p) => p.flag !== null).length, 'Need another look'],
      ),
    );
    const cured = mine().filter((p) => p.status === 'cured');
    curedBox.hidden = cured.length === 0;
    clear(
      curedBox,
      h('summary', {}, `Cured (${cured.length})`),
      h(
        'div',
        { class: 'fl-stack fl-stack--3' },
        h('p', { class: 'fl-help' }, 'The state’s sheet no longer lists them. Thank you.'),
        h('ul', { class: 'fl-list' }, ...cured.map((p) => h('li', {}, `${personName(p)}, ${p.city || 'unknown city'}`))),
      ),
    );
  }

  function replace(updated: Person): void {
    people = people.map((p) => (p.id === updated.id ? updated : p));
    const old = list.querySelector(`[data-id="${updated.id}"]`);
    if (updated.assignedTo !== me?.id || updated.status === 'cured') old?.remove();
    else old?.replaceWith(card(updated));
    updateSummary();
    if (list.children.length === 0) renderEmpty();
  }

  async function send(path: string, body: unknown): Promise<Person | null> {
    try {
      return await api<Person>('POST', path, body);
    } catch (e) {
      toast(failureText(e), 'error');
      return null;
    }
  }

  function card(p: Person): HTMLElement {
    const method = h(
      'select',
      {
        class: 'fl-select',
        id: `method-${p.id}`,
        onchange: async () => {
          const updated = await send(`/api/people/${p.id}/status`, {
            status: currentStatus(),
            method: method.value === '' ? null : method.value,
          });
          if (updated) replace(updated);
        },
      },
      h('option', { value: '' }, 'Not said'),
      ...(Object.entries(METHOD_LABELS) as [ContactMethod, string][]).map(([value, label]) =>
        h('option', { value, selected: p.contactMethod === value }, label),
      ),
    );

    // What the buttons show right now, which can be ahead of `p` while a change is still on its way to the server.
    const currentStatus = (): string => seg.querySelector('[aria-pressed="true"]')?.getAttribute('data-value') ?? p.status;
    const seg = h(
      'fieldset',
      { class: 'fl-seg status-seg', 'aria-label': 'What happened?' },
      ...CHOICES.map(([status, label]) =>
        h('button', { type: 'button', 'data-value': status, 'aria-pressed': String(p.status === status) }, label),
      ),
    );
    window.Frostline.segmented(seg, {
      onChange: async (value) => {
        const updated = await send(`/api/people/${p.id}/status`, { status: value, method: method.value === '' ? null : method.value });
        // On a failure the buttons already moved, so put the card back as it was.
        replace(updated ?? p);
      },
    });

    const notes = h('div', {});
    const summaryLabel = h('summary', {}, `Notes (${p.notesCount})`);
    let loaded = false;
    const details = h(
      'details',
      {
        class: 'fl-disclosure',
        ontoggle: async () => {
          if (!details.open || loaded) return;
          loaded = true;
          clear(notes, h('p', { class: 'fl-help' }, 'Loading notes…'));
          try {
            renderNotes(notes, p, await api<PersonDetail>('GET', `/api/people/${p.id}`), summaryLabel);
          } catch (e) {
            loaded = false;
            clear(notes, banner('warn', h('p', {}, failureText(e))));
          }
        },
      },
      summaryLabel,
      notes,
    );

    return h(
      'li',
      { class: 'fl-card', 'data-id': String(p.id) },
      h('div', { class: 'card-head' }, h('h2', { class: 'fl-card__title' }, personName(p)), statusBadge(p.status)),
      p.flag ? flagBadge(p.flag) : null,
      facts(p, volunteers, false),
      h('div', { class: 'fl-field' }, h('span', { class: 'fl-label' }, 'What happened?'), seg),
      field(`method-${p.id}`, 'How did you reach them?', method),
      details,
      h(
        'button',
        {
          class: 'fl-btn fl-btn--sm',
          type: 'button',
          onclick: async () => {
            const updated = await send(`/api/people/${p.id}/release`, {});
            if (updated) {
              toast(`${personName(p)} went back to the pool.`);
              replace(updated);
            }
          },
        },
        'Release back to the pool',
      ),
    );
  }

  function renderNotes(box: HTMLElement, p: Person, detail: PersonDetail, label: HTMLElement): void {
    const items = h('ul', { class: 'notes' });
    const add = (n: PersonDetail['notes'][number]) =>
      items.prepend(
        h(
          'li',
          {},
          n.body,
          h(
            'small',
            {},
            `${n.volunteerName}, ${new Date(n.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Phoenix' })}`,
          ),
        ),
      );
    for (const n of [...detail.notes].reverse()) add(n);
    let count = detail.notes.length;
    const text = h('textarea', { class: 'fl-textarea', id: `note-${p.id}`, maxlength: 2000, rows: 3 });
    const form = h(
      'form',
      {
        class: 'fl-stack fl-stack--3',
        onsubmit: async (event) => {
          event.preventDefault();
          if (text.value.trim() === '') return;
          try {
            const note = await api<PersonDetail['notes'][number]>('POST', `/api/people/${p.id}/notes`, { body: text.value });
            add(note);
            text.value = '';
            label.textContent = `Notes (${++count})`;
            toast('Note saved.');
          } catch (e) {
            toast(failureText(e), 'error');
          }
        },
      },
      field(`note-${p.id}`, 'Add a note', text),
      h('button', { class: 'fl-btn fl-btn--primary', type: 'submit' }, 'Save note'),
    );
    clear(box, h('div', { class: 'fl-stack fl-stack--3' }, items, form));
  }

  function renderEmpty(): void {
    clear(
      listBox,
      h(
        'div',
        { class: 'fl-empty fl-stack fl-stack--3', role: 'status' },
        h('p', {}, 'You have nobody yet.'),
        h('a', { class: 'btn btn--accent', href: '/pool/' }, 'Find people to call'),
      ),
    );
  }

  function renderList(): void {
    const open = mine()
      .filter((p) => p.status !== 'cured')
      .sort(
        (a, b) =>
          Number(b.flag !== null) - Number(a.flag !== null) ||
          ORDER[a.status] - ORDER[b.status] ||
          (b.daysUncured ?? -1) - (a.daysUncured ?? -1),
      );
    if (open.length === 0) renderEmpty();
    else {
      clear(list, ...open.map(card));
      clear(listBox, list);
    }
    updateSummary();
  }

  try {
    [people, volunteers] = await Promise.all([api<Person[]>('GET', '/api/people'), loadVolunteers()]);
    clear(app, summary, listBox, curedBox);
    renderList();
  } catch (e) {
    clear(app, banner('warn', h('p', {}, failureText(e))));
  }
}
