// The one email the app sends: "someone assigned you a voter, check the site". It never names the voter or carries any voter data; the
// volunteer signs in (Access) to see their list. Every volunteer row is made from a signed-in Access identity, and Access has confirmed
// the address (a one-time PIN sent to it, or Google), so the address is verified by the time anyone can be assigned to it. Free of
// Worker-only globals. Only erasable TypeScript syntax.
import type { Db } from './db.ts';

export const FROM = 'LD8 Cure Tracker <admin@azld8cures.com>';
// At most one email to a volunteer per this long, however many people are assigned to them.
export const THROTTLE_MS = 30 * 60_000;

// The slice of the Worker's `send_email` binding used here (env.EMAIL), so tests can stand in for it.
export interface Mailer {
  send(message: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

export interface Assigner {
  name: string;
  email: string;
}

// Emails the volunteer that `by` assigned them someone, unless they were emailed lately. A failure to send never fails the assignment: it is
// logged and the volunteer simply finds the person on their list. Returns whether a message went out.
export async function notifyAssigned(
  db: Db,
  mailer: Mailer | undefined,
  to: { id: number; email: string },
  by: Assigner,
  origin: string,
  now: Date,
): Promise<boolean> {
  if (!mailer) return false;
  // One statement claims the send, so two assignments at once send one email.
  const cutoff = new Date(now.getTime() - THROTTLE_MS).toISOString();
  const claimed = await db
    .prepare('UPDATE volunteers SET notified_at = ? WHERE id = ? AND (notified_at IS NULL OR notified_at < ?)')
    .bind(now.toISOString(), to.id, cutoff)
    .run();
  if (claimed.meta.changes === 0) return false;
  const who = by.name === '' ? by.email : `${by.name} (${by.email})`;
  try {
    await mailer.send({
      from: FROM,
      to: to.email,
      subject: 'You have a new voter to contact',
      text: `${who} assigned you a voter.\n\nCheck your list on the cure tracker: ${origin}/\n\nThis email has no voter information in it. Sign in to see who to contact.\n`,
    });
    return true;
  } catch (e) {
    console.error('assignment email failed', e instanceof Error ? e.message : e);
    // Let the next assignment try again.
    await db.prepare('UPDATE volunteers SET notified_at = NULL WHERE id = ?').bind(to.id).run();
    return false;
  }
}
