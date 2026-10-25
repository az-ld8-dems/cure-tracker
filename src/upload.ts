// Sends the state's sheet to the Worker: reads the CSV here (src/sheet.ts), then sends the people a request's worth at a time, because a
// free Worker has about 10 ms of CPU a request and could not read a large file. The admin page uses this, and so do the tests, with their
// own way of making a request. Free of browser globals.
import type { ColumnPick, StageStart, StageStarted, UploadPreview } from './api.d.ts';
import { readSheet } from './sheet.ts';

export type Request = <T>(method: 'GET' | 'POST', path: string, body?: unknown) => Promise<T>;

export interface StageOptions {
  // Which column of the file is which field, when the admin chose; else the saved choice or the name decides.
  picked?: ColumnPick;
  // Called as the people go, with how many have been sent and how many there are.
  progress?: (sent: number, total: number) => void;
  // Requests in flight at once.
  parallel?: number;
}

export interface Staged {
  token: string;
  preview: UploadPreview;
}

// Reads the file, sends its people, and asks what uploading it would do. Changes no one. Throws an ImportError when the file cannot be
// read (src/sheet.ts), and whatever `request` throws.
export async function stageSheet(text: string, filename: string, request: Request, options: StageOptions = {}): Promise<Staged> {
  const saved = await request<ColumnPick>('GET', '/api/admin/uploads/columns');
  const sheet = readSheet(text, saved, options.picked ?? {});

  const cities = new Map<string, number>();
  for (const p of sheet.people) cities.set(p.city, (cities.get(p.city) ?? 0) + 1);
  const used: ColumnPick = {};
  for (const c of sheet.columns.choices) if (c.header !== null) used[c.field] = c.header;
  const start: StageStart = {
    filename,
    expected: sheet.people.length,
    rows: sheet.rows,
    skippedOtherDistrict: sheet.skippedOtherDistrict,
    skippedInvalid: sheet.skippedInvalid,
    duplicates: sheet.duplicates,
    warnings: sheet.warnings,
    cities: [...cities].map(([city, count]) => ({ city, count })).sort((a, b) => b.count - a.count || a.city.localeCompare(b.city)),
    columns: sheet.columns,
    used,
  };
  const { token, chunk } = await request<StageStarted>('POST', '/api/admin/uploads/stage', start);

  const batches: (typeof sheet.people)[] = [];
  for (let i = 0; i < sheet.people.length; i += chunk) batches.push(sheet.people.slice(i, i + chunk));
  let next = 0;
  let sent = 0;
  options.progress?.(0, sheet.people.length);
  const worker = async (): Promise<void> => {
    for (let i = next++; i < batches.length; i = next++) {
      const rows = batches[i] ?? [];
      await request('POST', '/api/admin/uploads/stage/rows', { token, rows });
      sent += rows.length;
      options.progress?.(sent, sheet.people.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.parallel ?? 3, batches.length)) }, worker));

  return { token, preview: await request<UploadPreview>('POST', '/api/admin/uploads/stage/plan', { token }) };
}

// Applies a sheet that stageSheet has sent. Nothing is sent again.
export function finishSheet(token: string, force: boolean, request: Request): Promise<UploadPreview & { id: number }> {
  return request('POST', '/api/admin/uploads/stage/finish', { token, force });
}
