// What every page shares: talking to the API, building elements, showing messages, and the page chrome (who is signed in, the
// admin link, the first-visit question for a name). No framework: pages build their DOM with h() and never use innerHTML, so nothing
// from the data can become markup.
import type { ApiError, ContactMethod, Flag, Me, Person, Status, Volunteer } from './api.d.ts';

export class ApiFailure extends Error {
  status: number;
  problems: string[];
  constructor(status: number, message: string, problems: string[] = []) {
    super(message);
    this.status = status;
    this.problems = problems;
  }
}

export async function api<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: body === undefined ? {} : { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiFailure(0, 'Could not reach the server. Check your connection and try again.');
  }
  if (res.ok) return (await res.json()) as T;
  let err: ApiError = { error: `Something went wrong (${res.status})` };
  try {
    err = (await res.json()) as ApiError;
  } catch {
    // not JSON: keep the generic message
  }
  throw new ApiFailure(res.status, err.error, err.problems ?? []);
}

type Child = Node | string | null | false | undefined;
type Props = Record<string, string | number | boolean | ((event: Event) => void) | undefined>;

// h('button', { class: 'btn', onclick: save }, 'Save') builds an element. on* props are event listeners; false and undefined are skipped.
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (typeof value === 'function') el.addEventListener(name.slice(2), value);
    else if (name === 'class') el.className = String(value);
    else el.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children) if (child !== null && child !== false && child !== undefined) el.append(child);
  return el;
}

// A combobox's list that floats over the page instead of taking room in it: it lives in the body, fixed under the input (or above it near
// the bottom of the window; under `anchor` when the input is only part of the field), so a table's sideways scroll cannot clip it and the row does not grow. Pass it to Frostline's combobox as `list`.
export function floatingList(input: HTMLInputElement, anchor: HTMLElement = input): HTMLUListElement {
  const list = h('ul', { class: 'combo-float', 'data-for': input.id });
  document.body.append(list);
  const place = (): void => {
    if (list.hidden) return;
    // A redraw takes inputs out of the page and leaves their lists in the body: clear those away as one opens. (Not when a list is made,
    // since a table is built before it is put in the page and its inputs are not in the page yet.)
    for (const old of document.querySelectorAll<HTMLElement>('.combo-float')) {
      if (old !== list && !document.getElementById(old.dataset.for ?? '')) old.remove();
    }
    const box = anchor.getBoundingClientRect();
    const above = window.innerHeight - box.bottom < 240 && box.top > window.innerHeight - box.bottom;
    list.classList.toggle('combo-float--up', above);
    list.style.insetInlineStart = `${box.left}px`;
    list.style.minInlineSize = `${box.width}px`;
    list.style.insetBlockStart = above ? 'auto' : `${box.bottom}px`;
    list.style.insetBlockEnd = above ? `${window.innerHeight - box.top}px` : 'auto';
  };
  new MutationObserver(place).observe(list, { attributes: true, attributeFilter: ['hidden'] });
  window.addEventListener('scroll', place, { capture: true, passive: true });
  window.addEventListener('resize', place, { passive: true });
  return list;
}

export function clear(el: Element, ...children: Child[]): void {
  el.replaceChildren(...children.filter((c): c is Node | string => c !== null && c !== false && c !== undefined));
}

export function $(selector: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`no element matches ${selector}`);
  return el;
}

// Feedback for an action, through Frostline's toast (it announces itself to screen readers). Errors stay a little longer.
export function toast(message: string, kind: 'ok' | 'error' = 'ok'): void {
  window.Frostline.toast(message, { ms: kind === 'error' ? 7000 : 3500 });
}

export const failureText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ---- how things are shown

export const titleCase = (s: string): string =>
  s.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_m, sep: string, c: string) => sep + c.toUpperCase());

// A street address as the state writes it (3302 N 47TH PL PHOENIX, AZ 85018), in sentence-style capitals but with the directions, PO and
// the state kept as capitals (Ne and Nw would be wrong). Precincts are shown exactly as written: nothing here can tell ASU from a word.
export const addressText = (s: string): string => titleCase(s).replace(/\b(Ne|Nw|Se|Sw|Po|Az|Us)\b/g, (m) => m.toUpperCase());

export const personName = (p: Pick<Person, 'firstName' | 'lastName'>): string => titleCase(`${p.firstName} ${p.lastName}`);

export const phoneHref = (phone: string): string => `tel:${phone.replace(/[^\d+]/g, '')}`;

export const volunteerName = (v: Pick<Volunteer, 'name' | 'email'> | undefined): string => (v ? v.name || v.email : 'Someone');

const STATUS_LABELS: Record<Status, string> = {
  needs_contact: 'Needs to be contacted',
  left_voicemail: 'Left a message',
  contacted: 'Contacted',
  cured: 'Cured',
};
export const statusLabel = (s: Status): string => STATUS_LABELS[s];

const FLAG_LABELS: Record<Flag, string> = {
  still_uncured: 'Unsuccessful cure: still listed after contact',
  reappeared: 'Back on the list after being cured',
};
export const flagLabel = (f: Flag): string => FLAG_LABELS[f];

export const METHOD_LABELS: Record<ContactMethod, string> = {
  call: 'Phone call',
  text: 'Text',
  call_and_text: 'Phone call and text',
  voicemail_and_text: 'Voicemail and text',
  email: 'Email',
  in_person: 'In person: spoke with the voter',
  in_person_cured: 'In person: witnessed the cure',
  in_person_other: 'In person: spoke with someone else at the address',
  in_person_door: 'In person: left instructions at the door',
  other: 'Other',
};

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Phoenix',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export const daysText = (p: Person): string => (p.daysUncured === null ? 'Unknown' : plural(p.daysUncured, 'day'));

const STATUS_BADGES: Record<Status, string> = {
  needs_contact: 'fl-badge fl-badge--warning',
  left_voicemail: 'fl-badge',
  contacted: 'fl-badge fl-badge--accent',
  cured: 'fl-badge fl-badge--success',
};

export function statusBadge(status: Status): HTMLElement {
  return h('span', { class: STATUS_BADGES[status] }, statusLabel(status));
}

export const flagBadge = (flag: Flag): HTMLElement => h('span', { class: 'fl-badge fl-badge--danger' }, flagLabel(flag));

// A tinted note with words in it (Frostline's banner). warn is for a problem and is announced at once.
export function banner(kind: 'info' | 'warn', ...children: Child[]): HTMLElement {
  return h(
    'div',
    { class: kind === 'warn' ? 'fl-banner fl-banner--warn' : 'fl-banner', role: kind === 'warn' ? 'alert' : undefined },
    ...children,
  );
}

// A page section: a heading, then its content, a space-3 apart.
export function section(id: string, title: string, ...children: Child[]): HTMLElement {
  return h('section', { class: 'fl-stack fl-stack--3', 'aria-labelledby': id }, h('h2', { id }, title), ...children);
}

// A labelled form control in Frostline's field: label, control, optional help line.
export function field(id: string, label: string, control: HTMLElement, help?: string): HTMLElement {
  return h(
    'div',
    { class: 'fl-field' },
    h('label', { class: 'fl-label', for: id }, label),
    control,
    help ? h('p', { class: 'fl-help' }, help) : null,
  );
}

// A row of Frostline stat tiles: a number and what it counts.
export function tiles(...items: [number | string, string][]): HTMLElement {
  return h(
    'ul',
    { class: 'fl-grid tiles', 'aria-label': 'Totals' },
    ...items.map(([value, label]) =>
      h('li', { class: 'fl-tile' }, h('div', { class: 'fl-tile__label' }, label), h('div', { class: 'fl-tile__value' }, String(value))),
    ),
  );
}

// The rows of facts about a person that every card shows.
export function facts(p: Person, volunteers: Map<number, Volunteer>, withVolunteer: boolean): HTMLElement {
  const rows: [string, Node | string][] = [];
  if (p.phone) rows.push(['Phone', h('a', { href: phoneHref(p.phone) }, p.phone)]);
  else rows.push(['Phone', 'None on file']);
  rows.push(['Address', addressText(p.address)]);
  rows.push(['Precinct', p.precinct || 'Unknown']);
  rows.push(['Party', p.party || 'Unknown']);
  rows.push(['Uncured for', daysText(p)]);
  if (p.reasonCode) rows.push(['Reason', titleCase(p.reasonCode)]);
  if (withVolunteer) rows.push(['Assigned to', p.assignedTo === null ? 'Nobody' : volunteerName(volunteers.get(p.assignedTo))]);
  const dl = h('dl', { class: 'facts' });
  for (const [term, value] of rows) dl.append(h('dt', {}, term), h('dd', {}, value));
  return dl;
}

// ---- the chrome

// The account menu is a <details>; it also closes on Escape (focus returns to its summary) and on a click anywhere else.
function wireAccountMenu(): void {
  const menu = document.querySelector('#account');
  if (!(menu instanceof HTMLDetailsElement)) return;
  document.addEventListener('click', (e) => {
    if (menu.open && e.target instanceof Node && !menu.contains(e.target)) menu.open = false;
  });
  menu.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !menu.open) return;
    menu.open = false;
    menu.querySelector('summary')?.focus();
  });
}

// Loads who is signed in, fills the header, and, on a first visit, asks for a name before showing anything. Returns null while the
// name is still missing (the page stops there; saving the name reloads it).
export async function boot(): Promise<Me | null> {
  let me: Me;
  try {
    me = await api<Me>('GET', '/api/me');
  } catch (e) {
    const app = document.querySelector('#app');
    if (app) clear(app, banner('warn', h('p', {}, failureText(e))));
    return null;
  }
  $('#nav-admin').hidden = !me.isAdmin && !me.organizes;
  $('#who').textContent = me.name || me.email;
  wireAccountMenu();
  if (me.name !== '') return me;

  const app = document.querySelector('#app');
  if (!app) return me;
  const input = h('input', { class: 'fl-input', id: 'name', name: 'name', autocomplete: 'name', required: true, maxlength: 80 });
  const form = h(
    'form',
    {
      class: 'fl-card',
      onsubmit: async (event) => {
        event.preventDefault();
        try {
          await api<Me>('PUT', '/api/me', { name: input.value });
          location.reload();
        } catch (e) {
          toast(failureText(e), 'error');
        }
      },
    },
    h('h2', { class: 'fl-card__title' }, 'Welcome'),
    h(
      'p',
      {},
      `You are signed in as ${me.email}. What should we call you? Other volunteers and admins will see this name next to the people you claim.`,
    ),
    field('name', 'Your name', input),
    h('button', { class: 'btn btn--accent', type: 'submit' }, 'Continue'),
  );
  clear(app, form);
  return null;
}

export async function loadVolunteers(): Promise<Map<number, Volunteer>> {
  const list = await api<Volunteer[]>('GET', '/api/volunteers');
  return new Map(list.map((v) => [v.id, v]));
}

// Whether the signed-in volunteer organizes this precinct (the server checks again). A blank precinct can be moved by anyone who organizes.
export const mayOrganize = (me: Me, precinct: string): boolean => {
  if (!me.organizes) return false;
  if (me.organizes.all || precinct === '') return true;
  const want = precinct.toLowerCase();
  return me.organizes.precincts.some((p) => p.toLowerCase() === want);
};

// "Assign to": pick a volunteer and give them this person. The volunteer is not emailed here: an admin sends one email for a batch from the Admin page (worker/mail.ts).
export function assignBox(p: Person, volunteers: Volunteer[], assigned: (p: Person, to: Volunteer) => void | Promise<void>): HTMLElement {
  const pick = h(
    'select',
    { class: 'fl-select', id: `assign-${p.id}`, 'aria-label': `Assign ${personName(p)} to` },
    h('option', { value: '' }, 'Assign to...'),
    ...volunteers.map((v) => h('option', { value: String(v.id) }, volunteerName(v))),
  );
  const go = h(
    'button',
    {
      class: 'fl-btn',
      type: 'button',
      onclick: async () => {
        const to = volunteers.find((v) => String(v.id) === pick.value);
        if (!to) return;
        try {
          await api<Person>('POST', `/api/admin/people/${p.id}/assign`, { volunteerId: to.id });
          toast(`${personName(p)} is on ${volunteerName(to)}'s list now. They are not emailed until you send it from the Admin page.`);
          await assigned(p, to);
        } catch (e) {
          toast(failureText(e), 'error');
        }
      },
    },
    'Assign',
  );
  return h('div', { class: 'fl-cluster' }, pick, go);
}
