// The map's tiles: one PMTiles file (a cut of the Protomaps basemap around LD8) kept in an R2 bucket and served from our own origin, behind
// the same Access check as everything else. PMTiles readers ask for byte ranges, so this passes a Range header on to R2. Free of
// Worker-only globals. Only erasable TypeScript syntax.

// The part of an R2 bucket this uses, so tests can stand in for it.
export interface TileObject {
  body: ReadableStream | null;
  size: number;
  httpEtag: string;
  // Present when the request asked for a range: where it starts and how many bytes it holds.
  range?: { offset?: number; length?: number; suffix?: number };
}
export interface TileBucket {
  head(key: string): Promise<unknown | null>;
  get(key: string, options: { range: Headers }): Promise<TileObject | null>;
}

// The only file served. Its name has no date, so a newer cut replaces it in the bucket without a deploy.
export const TILES_PATH = '/tiles/ld8.pmtiles';
const TILES_KEY = 'ld8.pmtiles';

const plain = (status: number, body: string): Response =>
  new Response(`${body}\n`, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });

export async function serveTiles(request: Request, bucket: TileBucket | undefined): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return plain(405, 'Method not allowed');
  if (!bucket) return plain(404, 'The map file is not set up');
  const object = await bucket.get(TILES_KEY, { range: request.headers });
  if (!object) return plain(404, 'The map file has not been uploaded');
  const headers = new Headers({
    'content-type': 'application/octet-stream',
    'accept-ranges': 'bytes',
    // The file changes only when an admin replaces it by hand; a day in the browser's cache is plenty, and the tab-long cache of the
    // PMTiles reader does the rest. Private, because Access sits in front.
    'cache-control': 'private, max-age=86400',
    etag: object.httpEtag,
  });
  const r = object.range;
  if (!r) {
    headers.set('content-length', String(object.size));
    return new Response(request.method === 'HEAD' ? null : object.body, { status: 200, headers });
  }
  const start = r.suffix !== undefined ? Math.max(0, object.size - r.suffix) : (r.offset ?? 0);
  const length = r.suffix !== undefined ? Math.min(r.suffix, object.size) : (r.length ?? object.size - start);
  headers.set('content-range', `bytes ${start}-${start + length - 1}/${object.size}`);
  headers.set('content-length', String(length));
  return new Response(request.method === 'HEAD' ? null : object.body, { status: 206, headers });
}

// Whether the file has been uploaded, so the map can say so instead of asking for tiles that are not there.
export async function tilesReady(bucket: TileBucket | undefined): Promise<boolean> {
  return bucket !== undefined && (await bucket.head(TILES_KEY)) !== null;
}
