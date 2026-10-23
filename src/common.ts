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

export function clear(el: Element, ...children: Child[]): void {
  el.replaceChildren(...children.filter((c): c is Node | string => c !== null && c !== false && c !== undefined));
}

export function $(selector: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`no element matches ${selector}`);
  return el;
}

export function toast(message: string, kind: 'ok' | 'error' = 'ok'): void {
  const box = $('#toasts');
  const t = h('p', { class: kind === 'error' ? 'toast toast--error' : 'toast' }, message);
  box.append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 8000 : 4000);
}

export const failureText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ---- how things are shown

export const titleCase = (s: string): string =>
  s.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_m, sep: string, c: string) => sep + c.toUpperCase());

export const personName = (p: Pick<Person, 'firstName' | 'lastName'>): string => titleCase(`${p.firstName} ${p.lastName}`);

export const phoneHref = (phone: string): string => `tel:${phone.replace(/[^\d+]/g, '')}`;

export const volunteerName = (v: Pick<Volunteer, 'name' | 'email'> | undefined): string => (v ? v.name || v.email : 'Someone');

const STATUS_LABELS: Record<Status, string> = {
  needs_contact: 'Needs to be contacted',
  left_voicemail: 'Left voicemail / texted flyer',
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
  email: 'Email',
  in_person: 'In person',
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

export function statusPill(status: Status): HTMLElement {
  return h('span', { class: `pill pill--${status}` }, statusLabel(status));
}

// The rows of facts about a person that every card shows.
export function facts(p: Person, volunteers: Map<number, Volunteer>, withVolunteer: boolean): HTMLElement {
  const rows: [string, Node | string][] = [];
  if (p.phone) rows.push(['Phone', h('a', { href: phoneHref(p.phone) }, p.phone)]);
  else rows.push(['Phone', 'None on file']);
  rows.push(['Address', titleCase(p.address).replace(/,\s*Az\b/, ', AZ')]);
  rows.push(['Precinct', p.precinct ? titleCase(p.precinct) : 'Unknown']);
  rows.push(['Party', p.party || 'Unknown']);
  rows.push(['Uncured for', daysText(p)]);
  if (p.reasonCode) rows.push(['Reason', titleCase(p.reasonCode)]);
  if (withVolunteer) rows.push(['Assigned to', p.assignedTo === null ? 'Nobody' : volunteerName(volunteers.get(p.assignedTo))]);
  const dl = h('dl', { class: 'facts' });
  for (const [term, value] of rows) dl.append(h('dt', {}, term), h('dd', {}, value));
  return dl;
}

// ---- the chrome

// Loads who is signed in, fills the header, and, on a first visit, asks for a name before showing anything. Returns null while the
// name is still missing (the page stops there; saving the name reloads it).
export async function boot(): Promise<Me | null> {
  let me: Me;
  try {
    me = await api<Me>('GET', '/api/me');
  } catch (e) {
    const app = document.querySelector('#app');
    if (app) clear(app, h('p', { class: 'callout callout--warn', role: 'alert' }, failureText(e)));
    return null;
  }
  $('#nav-admin').hidden = !me.isAdmin;
  $('#who').textContent = me.name || me.email;
  if (me.name !== '') return me;

  const app = document.querySelector('#app');
  if (!app) return me;
  const input = h('input', { id: 'name', name: 'name', autocomplete: 'name', required: true, maxlength: 80 });
  const form = h(
    'form',
    {
      class: 'panel field',
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
    h('h2', {}, 'Welcome'),
    h(
      'p',
      {},
      `You are signed in as ${me.email}. What should we call you? Other volunteers and admins will see this name next to the people you claim.`,
    ),
    h('label', { for: 'name' }, 'Your name'),
    input,
    h('div', {}, h('button', { class: 'btn btn--accent', type: 'submit' }, 'Continue')),
  );
  clear(app, form);
  app.classList.remove('status-line');
  return null;
}

export async function loadVolunteers(): Promise<Map<number, Volunteer>> {
  const list = await api<Volunteer[]>('GET', '/api/volunteers');
  return new Map(list.map((v) => [v.id, v]));
}
