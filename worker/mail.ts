// The emails the app sends: "someone assigned you voters, check the site" (sent by hand, once per volunteer). It never names the voter or carries any voter data; the
// volunteer signs in (Access) to see their list. Every volunteer row is made from a signed-in Access identity, and Access has confirmed
// the address (a one-time PIN sent to it, or Google), so the address is verified by the time anyone can be assigned to it. Free of
// Worker-only globals. Only erasable TypeScript syntax.

export const FROM = 'LD8 Cure Tracker <admin@azld8cures.com>';

// The slice of the Worker's `send_email` binding used here (env.EMAIL), so tests can stand in for it.
export interface Mailer {
  send(message: { from: string; to: string; subject: string; text: string; html: string; replyTo?: string }): Promise<unknown>;
}

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const FONT = "font-family:'Public Sans',-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

// The HTML shell of every message, in the LD8 colors (public/tokens.css). Mail clients ignore stylesheets, so the styles are inline, in a
// table layout. No images: the site is behind Access, so nothing on it could load in a mail client, and no external host is used.
export function emailShell(inner: string, fontSize = 16): string {
  return `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#faf7f2">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf7f2">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e3ded4;border-radius:8px">
<tr><td style="background:#1f497d;color:#ffffff;padding:16px 24px;border-radius:8px 8px 0 0;${FONT};font-size:20px;font-weight:bold">Arizona LD8 Democrats</td></tr>
<tr><td style="padding:24px;color:#14202e;${FONT};font-size:${fontSize}px;line-height:1.5">
${inner}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;
}

// The one call to action, in the copper of the LD8 design.
export const emailButton = (link: string, label: string, fontSize = 16): string =>
  `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:#b4501f;border-radius:6px"><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 24px;color:#ffffff;${FONT};font-size:${fontSize}px;font-weight:bold;text-decoration:none">${escapeHtml(label)}</a></td></tr></table>`;

const voters = (count: number): string => (count === 1 ? 'a voter' : `${count} voters`);

export function assignedHtml(who: string, link: string, count: number): string {
  return emailShell(`<h1 style="margin:0 0 16px;font-size:22px;color:#12294a">You have ${count === 1 ? 'a new voter' : `${count} new voters`} to contact</h1>
<p style="margin:0 0 24px"><strong>${escapeHtml(who)}</strong> assigned you ${voters(count)}.</p>
${emailButton(link, 'View my list')}
<p style="margin:16px 0 0;font-size:14px;color:#4a5668">Or type this address into your browser: ${escapeHtml(link)}</p>
<p style="margin:16px 0 0;font-size:14px;color:#4a5668">This email has no voter information in it. Sign in to see who to contact.</p>`);
}

export interface Assigner {
  name: string;
  email: string;
}

// Emails a volunteer once about `count` people assigned to them. An admin presses the button after assigning a batch, so a volunteer gets
// one message however many people arrive. Returns whether it went out; a failure is logged and leaves the people marked, to try again.
export async function sendAssignmentNotice(
  mailer: Mailer,
  to: { email: string },
  by: Assigner,
  count: number,
  origin: string,
): Promise<boolean> {
  const who = by.name === '' ? by.email : `${by.name} (${by.email})`;
  try {
    await mailer.send({
      from: FROM,
      to: to.email,
      replyTo: by.email,
      subject: count === 1 ? 'You have a new voter to contact' : `You have ${count} new voters to contact`,
      text: `${who} assigned you ${voters(count)}.\n\nCheck your list on the cure tracker: ${origin}/\n\nThis email has no voter information in it. Sign in to see who to contact.\n`,
      html: assignedHtml(who, `${origin}/`, count),
    });
    return true;
  } catch (e) {
    console.error('assignment email failed', e instanceof Error ? e.message : e);
    return false;
  }
}
