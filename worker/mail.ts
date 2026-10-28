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
  send(message: { from: string; to: string; subject: string; text: string; html: string }): Promise<unknown>;
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// The HTML version, in the LD8 colors (public/tokens.css). Mail clients ignore stylesheets, so the styles are inline, in a table layout.
// No images: the site is behind Access, so nothing on it could load in a mail client, and no external host is used.
export function assignedHtml(who: string, link: string): string {
  const font = "font-family:'Public Sans',-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  return `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#faf7f2">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf7f2">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e3ded4;border-radius:8px">
<tr><td style="background:#1f497d;color:#ffffff;padding:16px 24px;border-radius:8px 8px 0 0;${font};font-size:20px;font-weight:bold">Arizona LD8 Democrats</td></tr>
<tr><td style="padding:24px;color:#14202e;${font};font-size:16px;line-height:1.5">
<h1 style="margin:0 0 16px;font-size:22px;color:#12294a">You have a new voter to contact</h1>
<p style="margin:0 0 24px"><strong>${escapeHtml(who)}</strong> assigned you a voter.</p>
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:#b4501f;border-radius:6px"><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 24px;color:#ffffff;${font};font-size:16px;font-weight:bold;text-decoration:none">View my list</a></td></tr></table>
<p style="margin:16px 0 0;font-size:14px;color:#4a5668">Or type this address into your browser: ${escapeHtml(link)}</p>
<p style="margin:16px 0 0;font-size:14px;color:#4a5668">This email has no voter information in it. Sign in to see who to contact.</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;
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
      html: assignedHtml(who, `${origin}/`),
    });
    return true;
  } catch (e) {
    console.error('assignment email failed', e instanceof Error ? e.message : e);
    // Let the next assignment try again.
    await db.prepare('UPDATE volunteers SET notified_at = NULL WHERE id = ?').bind(to.id).run();
    return false;
  }
}
