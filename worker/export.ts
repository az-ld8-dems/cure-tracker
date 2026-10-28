// The CSV of open people a volunteer has worked on, for keeping the old spreadsheet in step: name, the status a volunteer set, the volunteer who has them, and their notes.
// No phone, address or other detail. Free of Worker-only globals. Only erasable TypeScript syntax.

const STATUS_TEXT: Record<string, string> = {
  needs_contact: 'Needs to be contacted',
  left_voicemail: 'Left a message',
  contacted: 'Contacted',
};

// One CSV field. A spreadsheet runs a cell that starts with = + - @ (or a tab or return) as a formula, and volunteers type the notes, so
// such a cell is prefixed with an apostrophe, which the spreadsheet shows as nothing.
export function csvField(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

export interface ExportPerson {
  first_name: string;
  middle_name: string;
  last_name: string;
  status: string;
  volunteer: string;
}

export interface ExportNote {
  author: string;
  at: string;
  body: string;
}

export const fullName = (p: Pick<ExportPerson, 'first_name' | 'middle_name' | 'last_name'>): string =>
  [p.first_name, p.middle_name, p.last_name].filter((s) => s !== '').join(' ');

export function exportCsv(rows: { person: ExportPerson; notes: ExportNote[] }[]): string {
  const lines = ['Name,Status,Volunteer,Notes'];
  for (const { person, notes } of rows) {
    const text = notes.map((n) => `${n.at.slice(0, 10)} ${n.author}: ${n.body}`).join('\n');
    lines.push([fullName(person), STATUS_TEXT[person.status] ?? person.status, person.volunteer, text].map(csvField).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}
