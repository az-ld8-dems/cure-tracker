// What an audit log row says in words. Pure, so Node tests it (tools/test-format.ts); the admin page supplies who a volunteer id is.
import type { AuditEntry } from './api.d.ts';

const STATUS_WORDS: Record<string, string> = {
  needs_contact: 'needs to be contacted',
  left_voicemail: 'left a message',
  contacted: 'contacted',
  cured: 'cured',
};

const status = (v: unknown): string => (typeof v === 'string' ? (STATUS_WORDS[v] ?? v) : '?');
const count = (n: unknown, one: string, many = `${one}s`): string => `${String(n)} ${n === 1 ? one : many}`;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

const grantWords = (g: unknown): string => {
  if (!isRecord(g)) return '?';
  if (g.all === true) return 'all precincts';
  const list = Array.isArray(g.precincts) ? g.precincts.map(String) : [];
  return list.length === 0 ? 'nothing' : `precincts ${list.join(', ')}`;
};

// `who` names a volunteer by id; null (or an id nobody has) is the pool.
export function describeAudit(e: AuditEntry, who: (id: number | null) => string): string {
  const d = e.detail;
  const volunteer = (v: unknown): string => who(typeof v === 'number' ? v : null);
  switch (e.action) {
    case 'claim':
      return 'claimed';
    case 'release':
      return 'released back to the pool';
    case 'status':
      return `marked ${status(d.to)} (was ${status(d.from)})`;
    case 'note':
      return 'added a note';
    case 'assign':
      return `moved from ${volunteer(d.from)} to ${volunteer(d.to)}`;
    case 'reassign':
      return `moved ${count(d.count, 'person', 'people')} from ${volunteer(d.from)} to ${volunteer(d.to)}`;
    case 'organizer.set':
      return `changed what ${volunteer(d.volunteer)} organizes: ${grantWords(d.to)} (was ${grantWords(d.from)})`;
    case 'flag.dismiss':
      return 'dismissed the flag';
    case 'person.place':
      return 'placed by hand on the map';
    case 'person.unplace':
      return 'taken off the map (a place set by hand was removed)';
    case 'location.set':
      return `saved where they are for near me (${d.via === 'zip' ? 'by ZIP' : 'from their device'})`;
    case 'location.clear':
      return 'cleared where they are for near me';
    case 'geocode':
      return `${d.retry === true ? 'looked up again' : 'looked up'} ${count(d.sent, 'address', 'addresses')} with the Census geocoder: ${String(d.matched)} placed, ${String(d.noMatch)} not`;
    case 'import.cured':
      return 'cured: no longer on the state’s sheet';
    case 'import.still_uncured':
      return 'unsuccessful cure: still on the sheet after contact';
    case 'import.merged': {
      const was = isRecord(d.was) ? d.was : {};
      const now = isRecord(d.now) ? d.now : {};
      return `marked as the same person as ${String(now.name)}, ${String(now.address)} on the state’s sheet (was ${String(was.name)}, ${String(was.address)})`;
    }
    case 'import.reappeared':
      return 'back on the sheet after being cured';
    case 'upload':
      return `uploaded ${String(d.filename)}: ${String(d.added)} added, ${String(d.cured)} cured, ${count(d.stillUncured, 'unsuccessful cure')}, ${String(d.reappeared)} back after being cured`;
    case 'settings': {
      const change = isRecord(d.graceCycles) ? d.graceCycles : {};
      return `set the grace period to ${count(change.to, 'upload')} (was ${String(change.from)})`;
    }
    case 'reset':
      return `deleted all voters (${count(d.people, 'person', 'people')}, ${count(d.notes, 'note')}, ${count(d.uploads, 'upload')})`;
    case 'notify.send':
      return `emailed ${volunteer(d.volunteer)} about ${count(d.count, 'new person', 'new people')}`;
    case 'export.worked':
      return `downloaded the CSV of ${count(d.people, 'person', 'people')} volunteers have worked on`;
    case 'invite.send':
      return `emailed sign-in instructions to ${String(d.email)}`;
    case 'volunteer.join':
      return 'signed in for the first time';
    case 'volunteer.rename':
      return `now called ${String(d.to)}`;
    default:
      return e.action.replace('.', ' ');
  }
}
