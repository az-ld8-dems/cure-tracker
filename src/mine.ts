// "My people": the voters this volunteer has claimed, with the buttons for what happened and a place for notes.
import type { ContactMethod, Person, PersonDetail, Status, Volunteer } from './api.d.ts';
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
  METHOD_LABELS,
  personName,
  statusLabel,
  statusPill,
  toast,
} from './common.ts';

const me = await boot();
const app = $('#app');

// The three things a volunteer can say. Cured is only ever set by an upload of the state's sheet.
const CHOICES: Status[] = ['needs_contact', 'left_voicemail', 'contacted'];
const ORDER: Record<Status, number> = { needs_contact: 0, left_voicemail: 1, contacted: 2, cured: 3 };

if (me) {
  let people: Person[] = [];
  let volunteers = new Map<number, Volunteer>();
  const summary = h('ul', { class: 'summary', 'aria-label': 'Your people by status' });
  const list = h('ul', { class: 'cards' });
  const curedBox = h('details', { class: 'panel' });

  const mine = (): Person[] => people.filter((p) => p.assignedTo === me.id);

  function updateSummary(): void {
    const open = mine().filter((p) => p.status !== 'cured');
    const count = (s: Status) => open.filter((p) => p.status === s).length;
    clear(
      summary,
      h('li', {}, h('strong', {}, String(count('needs_contact'))), 'to contact'),
      h('li', {}, h('strong', {}, String(count('left_voicemail'))), 'left voicemail'),
      h('li', {}, h('strong', {}, String(count('contacted'))), 'contacted'),
      h('li', {}, h('strong', {}, String(open.filter((p) => p.flag !== null).length)), 'need another look'),
    );
    const cured = mine().filter((p) => p.status === 'cured');
    curedBox.hidden = cured.length === 0;
    clear(
      curedBox,
      h('summary', {}, `Cured (${cured.length})`),
      h('p', { class: 'muted' }, 'The state’s sheet no longer lists them. Thank you.'),
      h('ul', {}, ...cured.map((p) => h('li', {}, `${personName(p)}, ${p.city || 'unknown city'}`))),
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
        id: `method-${p.id}`,
        onchange: async () => {
          const updated = await send(`/api/people/${p.id}/status`, { status: p.status, method: method.value === '' ? null : method.value });
          if (updated) replace(updated);
        },
      },
      h('option', { value: '' }, 'Not said'),
      ...(Object.entries(METHOD_LABELS) as [ContactMethod, string][]).map(([value, label]) =>
        h('option', { value, selected: p.contactMethod === value }, label),
      ),
    );
    const buttons = CHOICES.map((status) =>
      h(
        'button',
        {
          class: 'btn btn--ghost btn--small',
          type: 'button',
          'aria-pressed': String(p.status === status),
          onclick: async () => {
            const updated = await send(`/api/people/${p.id}/status`, { status, method: method.value === '' ? null : method.value });
            if (updated) replace(updated);
          },
        },
        statusLabel(status),
      ),
    );

    const notes = h('div', {});
    const summaryLabel = h('summary', {}, `Notes (${p.notesCount})`);
    let loaded = false;
    const details = h(
      'details',
      {
        ontoggle: async () => {
          if (!details.open || loaded) return;
          loaded = true;
          clear(notes, h('p', { class: 'muted' }, 'Loading notes…'));
          try {
            renderNotes(notes, p, await api<PersonDetail>('GET', `/api/people/${p.id}`), summaryLabel);
          } catch (e) {
            loaded = false;
            clear(notes, h('p', { class: 'callout callout--warn', role: 'alert' }, failureText(e)));
          }
        },
      },
      summaryLabel,
      notes,
    );

    return h(
      'li',
      { class: 'card', 'data-id': String(p.id) },
      h('div', { class: 'card__head' }, h('h2', { class: 'card__title' }, personName(p)), h('span', {}, statusPill(p.status))),
      p.flag ? h('p', { class: 'flag', role: 'note' }, flagLabel(p.flag)) : null,
      facts(p, volunteers, false),
      h('fieldset', { class: 'seg' }, h('legend', {}, 'What happened?'), ...buttons),
      h('div', { class: 'field' }, h('label', { for: `method-${p.id}` }, 'How did you reach them?'), method),
      details,
      h(
        'div',
        {},
        h(
          'button',
          {
            class: 'btn btn--ghost btn--small',
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
    const text = h('textarea', { id: `note-${p.id}`, maxlength: 2000, rows: 3 });
    const form = h(
      'form',
      {
        class: 'field',
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
      h('label', { for: `note-${p.id}` }, 'Add a note'),
      text,
      h('div', {}, h('button', { class: 'btn btn--small', type: 'submit' }, 'Save note')),
    );
    clear(box, items, form);
  }

  function renderEmpty(): void {
    clear(
      list,
      h(
        'li',
        { class: 'empty' },
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
    else clear(list, ...open.map(card));
    updateSummary();
  }

  try {
    [people, volunteers] = await Promise.all([api<Person[]>('GET', '/api/people'), loadVolunteers()]);
    app.classList.remove('status-line');
    clear(app, summary, list, curedBox);
    renderList();
  } catch (e) {
    clear(app, h('p', { class: 'callout callout--warn', role: 'alert' }, failureText(e)));
  }
}
