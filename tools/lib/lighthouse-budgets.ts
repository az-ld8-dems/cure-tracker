// The budget logic of tools/lighthouse.ts, kept apart from Lighthouse and Chromium so Node can test it with made-up results
// (tools/test-lighthouse-budgets.ts): what the budgets are, how one Lighthouse result is judged, and what happens when a page
// misses its budget on a timing measurement. Only erasable TypeScript.

// Category scores are 0 to 1. Metrics: first contentful paint, largest contentful paint and total blocking time in ms, cumulative
// layout shift unitless. The performance score, the three metrics and the layout shift are Google's and Lighthouse's own "good"
// thresholds, which CI now measures on a two-CPU runner: a page that cannot meet them there needs its code
// optimised, not a looser budget. Healthy pages measure about 1.4 to 1.5 s first paint on the simulated phone and 0 ms blocking time.
export const budgets = {
  categories: { performance: 0.9, accessibility: 1, 'best-practices': 1, seo: 1 } as Record<string, number>,
  metrics: {
    'first-contentful-paint': 1800,
    'largest-contentful-paint': 2500,
    'total-blocking-time': 200,
    'cumulative-layout-shift': 0.1,
  } as Record<string, number>,
};

// The part of a Lighthouse result this reads, so a test can hand in a small made-up one. The real result is assignable to it.
export interface LhrLike {
  categories: Record<string, { score: number | null; auditRefs?: { id: string; weight: number }[] } | undefined>;
  audits: Record<string, { score?: number | null; numericValue?: number } | undefined>;
  runtimeError?: { code: string; message: string };
}

// One run reduced to the numbers the budgets are about. A missing score or value is undefined.
export interface Measurement {
  scores: Record<string, number | undefined>;
  metrics: Record<string, number | undefined>;
  // Audits that did not pass, by category, for the failure message.
  failing: Record<string, string[]>;
}

export function measurementOf(lhr: LhrLike): Measurement {
  const scores: Measurement['scores'] = {};
  const failing: Measurement['failing'] = {};
  for (const cat of Object.keys(budgets.categories)) {
    scores[cat] = lhr.categories[cat]?.score ?? undefined;
    failing[cat] = (lhr.categories[cat]?.auditRefs ?? [])
      .filter((r) => {
        const score = lhr.audits[r.id]?.score;
        return r.weight > 0 && score !== null && score !== undefined && score < 1;
      })
      .map((r) => r.id);
  }
  const metrics: Measurement['metrics'] = {};
  for (const id of Object.keys(budgets.metrics)) metrics[id] = lhr.audits[id]?.numericValue;
  return { scores, metrics, failing };
}

const initials = (id: string): string =>
  id
    .split('-')
    .map((w) => w[0])
    .join('')
    .toUpperCase();
const metricText = (id: string, v: number, digits?: number): string =>
  id === 'cumulative-layout-shift' ? v.toFixed(digits ?? 3) : digits === undefined ? `${Math.round(v)}ms` : v.toFixed(digits);

export interface Verdict {
  line: string;
  problems: string[];
  // True when something missed that a rerun can change: the performance score or a metric. The other categories are decided by
  // the markup alone and give the same answer every time.
  timing: boolean;
}

export function judge(tag: string, m: Measurement): Verdict {
  const parts: string[] = [];
  const problems: string[] = [];
  let timing = false;
  for (const [cat, min] of Object.entries(budgets.categories)) {
    const score = m.scores[cat];
    if (score === undefined) {
      problems.push(`${tag}: ${cat} has no score`);
      continue;
    }
    parts.push(`${cat} ${Math.round(score * 100)}`);
    if (score < min) {
      const ids = m.failing[cat] ?? [];
      problems.push(`${tag}: ${cat} score ${Math.round(score * 100)}, budget ${min * 100}${ids.length ? ` (${ids.join(', ')})` : ''}`);
      if (cat === 'performance') timing = true;
    }
  }
  for (const [id, max] of Object.entries(budgets.metrics)) {
    const v = m.metrics[id];
    if (v === undefined) {
      problems.push(`${tag}: ${id} has no value`);
      continue;
    }
    parts.push(`${initials(id)} ${metricText(id, v)}`);
    if (v > max) {
      problems.push(`${tag}: ${id} ${metricText(id, v, id === 'cumulative-layout-shift' ? 3 : 0)}, budget ${max}`);
      timing = true;
    }
  }
  return { line: parts.join(' | '), problems, timing };
}

// The middle value of an odd number of numbers; the middle two averaged for an even number. Undefined if any is missing.
export function median(values: (number | undefined)[]): number | undefined {
  if (values.length === 0 || values.some((v) => v === undefined)) return undefined;
  const sorted = (values as number[]).toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

// Each number is the median of the runs'. The names of the audits that did not pass come from the run with the lowest
// performance score, which is the one that explains a miss.
export function medianOf(runs: Measurement[]): Measurement {
  const worst = runs.toSorted((a, b) => (a.scores.performance ?? 0) - (b.scores.performance ?? 0))[0];
  const scores: Measurement['scores'] = {};
  for (const cat of Object.keys(budgets.categories)) scores[cat] = median(runs.map((r) => r.scores[cat]));
  const metrics: Measurement['metrics'] = {};
  for (const id of Object.keys(budgets.metrics)) metrics[id] = median(runs.map((r) => r.metrics[id]));
  return { scores, metrics, failing: worst?.failing ?? {} };
}

export interface PageResult {
  line: string;
  problems: string[];
  // How many times Lighthouse ran: 1, or 1 + RETRIES when the first run missed a timing budget.
  runs: number;
  // Every run's result, in order, for the saved reports.
  lhrs: LhrLike[];
}

// A timing miss gets this many more runs, and the verdict is on the median of all the runs.
export const RETRIES = 2;

// Measures one page: one Lighthouse run, and only if that run misses a timing budget, RETRIES more and the median of all. A
// page that is really over budget misses in the median too; a single slow run on a busy machine does not fail the build. Misses
// of the categories that do not depend on timing (accessibility, best practices, SEO) are reported straight away, with no rerun.
export async function measurePage(tag: string, run: () => Promise<LhrLike | null>): Promise<PageResult> {
  const lhrs: LhrLike[] = [];
  const once = async (): Promise<{ m: Measurement } | { problem: string }> => {
    const lhr = await run();
    if (!lhr) return { problem: `${tag}: Lighthouse returned no result` };
    lhrs.push(lhr);
    if (lhr.runtimeError) return { problem: `${tag}: ${lhr.runtimeError.code} ${lhr.runtimeError.message}` };
    return { m: measurementOf(lhr) };
  };
  const first = await once();
  if ('problem' in first) return { line: '', problems: [first.problem], runs: lhrs.length, lhrs };
  const verdict = judge(tag, first.m);
  if (!verdict.timing) return { line: verdict.line, problems: verdict.problems, runs: 1, lhrs };

  const measurements = [first.m];
  for (let i = 0; i < RETRIES; i++) {
    const next = await once();
    if ('problem' in next)
      return {
        line: verdict.line,
        problems: [...verdict.problems, `${next.problem} (on a rerun after a timing miss)`],
        runs: lhrs.length,
        lhrs,
      };
    measurements.push(next.m);
  }
  const final = judge(tag, medianOf(measurements));
  const perfs = measurements.map((m) => Math.round((m.scores.performance ?? 0) * 100)).join(', ');
  return {
    line: `${final.line} [median of ${measurements.length} after a miss; performance ${perfs}]`,
    problems: final.problems,
    runs: measurements.length,
    lhrs,
  };
}
