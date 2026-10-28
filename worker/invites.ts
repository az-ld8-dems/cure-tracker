// Inviting people who have no account yet: an admin lists their email addresses and each gets a message with step-by-step instructions
// for signing in (Access sends a one-time code to the address). The app does not let anyone in: the address still has to be in the Access
// policy (docs/setup.md), and the admin page lists who was invited so the policy can be kept in step. Free of Worker-only globals. Only
// erasable TypeScript syntax.
import type { Db } from './db.ts';
import { emailButton, emailShell, escapeHtml, FROM, type Mailer } from './mail.ts';

export const MAX_PER_REQUEST = 25;
// An invite is not sent again within this long, so a double click or a re-pasted list sends one message.
export const RESEND_MS = 10 * 60_000;

const CHARS = '[^\\s@<>,;"()[\\]\\\\]+';
const ADDRESS = new RegExp(`^${CHARS}@${CHARS}\\.${CHARS}$`);

export interface ParsedEmails {
  emails: string[];
  rejected: string[];
}

// Addresses from pasted text: separated by spaces, commas, semicolons or new lines, `Name <a@b.c>` accepted, lowercase, once each. Anything
// with an @ that is not an address comes back in `rejected`; words with no @ (names) are ignored.
export function parseEmails(raw: string): ParsedEmails {
  const seen = new Set<string>();
  const rejected: string[] = [];
  for (const piece of raw.split(/[\s,;]+/)) {
    if (!piece.includes('@')) continue;
    const token = piece.replace(/^<|>$/g, '').toLowerCase();
    if (token.length <= 254 && ADDRESS.test(token)) seen.add(token);
    else rejected.push(piece.slice(0, 80));
  }
  return { emails: [...seen], rejected };
}

export interface InviteMessage {
  subject: string;
  text: string;
  html: string;
}

// The steps are for people who are not used to this: one thing per step, the exact address to type, where the code comes from, and who to ask.
export function inviteMessage(to: string, by: { name: string; email: string }, origin: string): InviteMessage {
  const link = `${origin}/`;
  const who = by.name === '' ? by.email : `${by.name} (${by.email})`;
  const steps = [
    `Open this address in your web browser: ${link}`,
    `When it asks for your email address, type exactly this one: ${to}`,
    'Press the button to have a code sent to you. Cloudflare, the security service that guards the site, emails you a 6-digit code. It usually arrives within a minute. If you do not see it, look in your spam or junk folder.',
    'Type the 6 digits into the page and continue.',
    'The first time, the site asks what to call you. Type your name and press Continue. You are in.',
  ];
  const text = `Hello,

${who} invited you to help the Arizona LD8 Democrats with ballot cures. This email shows you how to sign in. It takes about two minutes.

${steps.map((s, i) => `${i + 1}. ${s}`).join('\n\n')}

Later visits work the same way: the site sends you a new code from time to time. That is on purpose, because the site holds voters' information and we keep it private.

This email has no voter information in it.

Stuck? Reply to this email and ${by.name === '' ? by.email : by.name} will help you.
`;
  const html = emailShell(
    `<h1 style="margin:0 0 16px;font-size:26px;color:#12294a">You are invited to help with ballot cures</h1>
<p style="margin:0 0 16px"><strong>${escapeHtml(who)}</strong> invited you to help the Arizona LD8 Democrats. Here is how to sign in. It takes about two minutes.</p>
<p style="margin:0 0 24px">${emailButton(link, 'Open the site', 20)}</p>
<ol style="margin:0 0 24px;padding-left:24px">
<li style="margin:0 0 12px">Open <strong>${escapeHtml(link)}</strong> in your web browser (the button above does this).</li>
<li style="margin:0 0 12px">When it asks for your email address, type exactly this one: <strong>${escapeHtml(to)}</strong></li>
<li style="margin:0 0 12px">${escapeHtml(steps[2] ?? '')}</li>
<li style="margin:0 0 12px">Type the 6 digits into the page and continue.</li>
<li style="margin:0">${escapeHtml(steps[4] ?? '')}</li>
</ol>
<p style="margin:0 0 16px;font-size:16px;color:#4a5668">Later visits work the same way: the site sends you a new code from time to time. That is on purpose, because the site holds voters' information and we keep it private.</p>
<p style="margin:0 0 16px;font-size:16px;color:#4a5668">This email has no voter information in it. Stuck? Reply to this email and ${escapeHtml(by.name === '' ? by.email : by.name)} will help you.</p>`,
    18,
  );
  return { subject: 'How to sign in to the LD8 ballot cure tracker', text, html };
}

export interface InviteRow {
  id: number;
  email: string;
  invited_by: string;
  invited_at: string;
  last_sent_at: string | null;
  sent_count: number;
}

export type Outcome = 'sent' | 'failed' | 'has_account' | 'too_soon';

// Records the invite and sends the message. `has_account`: the address already signed in, so there is nothing to send. `too_soon`: sent
// in the last few minutes. `failed`: the invite is kept (the admin page shows it as not sent) so it can be tried again.
export async function invite(
  db: Db,
  mailer: Mailer,
  email: string,
  by: { name: string; email: string },
  origin: string,
  now: Date,
): Promise<Outcome> {
  const account = await db.prepare('SELECT 1 AS yes FROM volunteers WHERE email = ?').bind(email).first<{ yes: number }>();
  if (account) return 'has_account';
  const iso = now.toISOString();
  await db
    .prepare('INSERT INTO invites (email, invited_by, invited_at) VALUES (?, ?, ?) ON CONFLICT (email) DO NOTHING')
    .bind(email, by.email, iso)
    .run();
  // One statement claims the send, so two requests at once send one message.
  const cutoff = new Date(now.getTime() - RESEND_MS).toISOString();
  const claimed = await db
    .prepare(
      'UPDATE invites SET last_sent_at = ?, sent_count = sent_count + 1 WHERE email = ? AND (last_sent_at IS NULL OR last_sent_at < ?)',
    )
    .bind(iso, email, cutoff)
    .run();
  if (claimed.meta.changes === 0) return 'too_soon';
  const message = inviteMessage(email, by, origin);
  try {
    await mailer.send({ from: FROM, to: email, replyTo: by.email, ...message });
    return 'sent';
  } catch (e) {
    console.error('invite email failed', e instanceof Error ? e.message : e);
    await db.prepare('UPDATE invites SET last_sent_at = NULL, sent_count = sent_count - 1 WHERE email = ?').bind(email).run();
    return 'failed';
  }
}
