// A stand-in for the US Census batch geocoder, for tests: the same request (a multipart form with an addressFile and a benchmark) and the
// same kind of answer (a CSV with a Match, No_Match or Tie per id), with no network. It records what it was sent, so a test can check that
// nothing but an id and an address leaves the Worker. Only tests import this file.
import { parseCsv } from '../../src/sheet.ts';

export interface Sent {
  benchmark: string | null;
  // The CSV lines of the file, as received.
  lines: string[];
}

export function fakeCensus() {
  const sent: Sent[] = [];
  // matchEverything: a later Census release that finds the places it could not find before.
  const behavior = { status: 200, throws: false, matchEverything: false, during: null as (() => void) | null };

  const fetcher: typeof fetch = async (_url, init) => {
    if (behavior.throws) throw new TypeError('network down');
    const form = init?.body;
    if (!(form instanceof FormData)) throw new Error('the Census takes a multipart form');
    const file = form.get('addressFile');
    if (!(file instanceof Blob)) throw new Error('no addressFile');
    const lines = (await file.text()).split('\n').filter((l) => l !== '');
    sent.push({ benchmark: String(form.get('benchmark')), lines });
    behavior.during?.();
    if (behavior.status !== 200) return new Response('busy', { status: behavior.status });
    const answers = lines.map((line) => {
      const [id = '', street = '', city = '', state = '', zip = ''] = parseCsv(line)[0] ?? [];
      const input = `"${id}","${street}, ${city}, ${state}, ${zip}"`;
      if (!behavior.matchEverything && /NOWHERE/i.test(street)) return `${input},"No_Match"`;
      if (!behavior.matchEverything && /TIE/i.test(street)) return `"${id}","${street}, ${city}, ${state}, ${zip}","Tie"`;
      // A point in the Phoenix area that depends on the street, longitude first, as the Census writes it.
      let h = 0;
      for (const ch of `${street} ${zip}`) h = (h * 31 + ch.charCodeAt(0)) % 100000;
      const lon = (-112.2 + (h % 1000) / 2500).toFixed(11);
      const lat = (33.3 + (Math.floor(h / 1000) % 100) / 400).toFixed(11);
      return `"${id}","${street}, ${city}, ${state}, ${zip}","Match","Exact","${street.toUpperCase()}, ${city.toUpperCase()}, ${state}, ${zip}","${lon},${lat}","${100000 + h}","L"`;
    });
    return new Response(answers.join('\n'), { status: 200 });
  };
  return { fetcher, sent, behavior };
}
