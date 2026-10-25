// Lets tests (and the dev server's seeding) upload a CSV the way the admin page does: through src/upload.ts, over whatever `send` reaches
// the Worker's API. A refused request (not 2xx) throws a Refused carrying the status and body.
import type { ColumnPick, UploadPreview } from '../../src/api.d.ts';
import { finishSheet, type Request, stageSheet } from '../../src/upload.ts';

export interface Reply {
  status: number;
  data: unknown;
}

export type Send = (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) => Promise<Reply>;

export class Refused extends Error {
  status: number;
  data: unknown;
  constructor(reply: Reply) {
    super(`${reply.status} ${JSON.stringify(reply.data)}`);
    this.status = reply.status;
    this.data = reply.data;
  }
}

export const requestOver =
  (send: Send): Request =>
  async <T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> => {
    const reply = await send(method, path, body);
    if (reply.status < 200 || reply.status >= 300) throw new Refused(reply);
    return reply.data as T;
  };

interface Options {
  filename?: string;
  picked?: ColumnPick;
  force?: boolean;
}

// Sends the sheet and asks what uploading it would do. Nothing is applied.
export async function previewCsv(send: Send, csv: string, options: Options = {}): Promise<UploadPreview & { token: string }> {
  const staged = await stageSheet(
    csv,
    options.filename ?? 'sheet.csv',
    requestOver(send),
    options.picked ? { picked: options.picked } : {},
  );
  return { ...staged.preview, token: staged.token };
}

// Sends the sheet and applies it.
export async function uploadCsv(send: Send, csv: string, options: Options = {}): Promise<UploadPreview & { id: number }> {
  const { token } = await previewCsv(send, csv, options);
  return finishSheet(token, options.force ?? false, requestOver(send));
}
