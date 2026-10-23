// Checks tools/lib/lighthouse-budgets.ts with made-up Lighthouse results: how a result is judged, and the rule that a page which
// misses a timing budget is measured twice more and judged on the median. No browser, no Lighthouse.

import assert from 'node:assert/strict';
import { budgets, judge, type LhrLike, measurementOf, measurePage, median, medianOf, RETRIES } from './lib/lighthouse-budgets.ts';

interface Numbers {
  performance?: number | null;
  accessibility?: number | null;
  'best-practices'?: number | null;
  seo?: number | null;
  fcp?: number;
  lcp?: number;
  tbt?: number;
  cls?: number;
  failingAudits?: Partial<Record<string, string[]>>;
}

// A result that passes every budget, with any of its numbers replaced.
function lhr(n: Numbers = {}): LhrLike {
  const score = (key: 'performance' | 'accessibility' | 'best-practices' | 'seo') => (n[key] === undefined ? 1 : n[key]);
  const audits: LhrLike['audits'] = {
    'first-contentful-paint': { numericValue: n.fcp ?? 1500 },
    'largest-contentful-paint': { numericValue: n.lcp ?? 1500 },
    'total-blocking-time': { numericValue: n.tbt ?? 0 },
    'cumulative-layout-shift': { numericValue: n.cls ?? 0 },
  };
  const categories: LhrLike['categories'] = {};
  for (const cat of ['performance', 'accessibility', 'best-practices', 'seo'] as const) {
    const ids = n.failingAudits?.[cat] ?? [];
    for (const id of ids) audits[id] = { score: 0 };
    categories[cat] = {
      score: score(cat) ?? null,
      auditRefs: [...ids.map((id) => ({ id, weight: 1 })), { id: 'passing-audit', weight: 1 }],
    };
  }
  audits['passing-audit'] = { score: 1 };
  return { categories, audits };
}

// A fake Lighthouse that answers with the given results in order, and counts how often it was asked.
function lighthouseReturning(results: (LhrLike | null)[]) {
  let calls = 0;
  return {
    run: async () => {
      const r = results[calls++];
      if (r === undefined) throw new Error('Lighthouse was asked more times than the test expects');
      return r;
    },
    calls: () => calls,
  };
}

// --- median
assert.equal(median([3, 1, 2]), 2);
assert.equal(median([5, 100, 5]), 5);
assert.equal(median([1, 2, 3, 4]), 2.5);
assert.equal(median([7]), 7);
assert.equal(median([]), undefined);
assert.equal(median([1, undefined, 3]), undefined, 'a missing value is not guessed at');

// --- judge: the same budgets and wording as before
{
  const ok = judge('/ mobile', measurementOf(lhr()));
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.timing, false);
  assert.equal(
    ok.line,
    'performance 100 | accessibility 100 | best-practices 100 | seo 100 | FCP 1500ms | LCP 1500ms | TBT 0ms | CLS 0.000',
  );

  // The budgets are at the edge, not past it.
  const perfBudget = budgets.categories.performance;
  assert.ok(perfBudget !== undefined);
  assert.deepEqual(judge('p', measurementOf(lhr({ performance: perfBudget, fcp: 1800, lcp: 2500, tbt: 200, cls: 0.1 }))).problems, []);

  // Google's thresholds. Real numbers from a local run pass; numbers from the one-CPU runner that failed v0.1.1 do not.
  const fromCi = (n: Numbers) => judge('ci', measurementOf(lhr(n))).problems;
  assert.deepEqual(fromCi({ performance: 1, fcp: 1511, lcp: 1511, tbt: 0 }), [], '/snake/ mobile on a quiet machine');
  assert.equal(fromCi({ performance: 0.9, fcp: 1533, lcp: 1533, tbt: 386 }).length, 1, '/resume/ mobile on the slim runner');
  assert.equal(fromCi({ fcp: 1900 }).length, 1, 'first paint past 1.8 s fails');
  assert.equal(fromCi({ lcp: 2600 }).length, 1, 'largest paint past 2.5 s fails');
  assert.equal(fromCi({ tbt: 250 }).length, 1, 'blocking time past 200 ms fails');
  assert.equal(
    fromCi({ performance: 0.81, fcp: 1782, lcp: 1930, tbt: 725 }).length,
    2,
    'a blocking time of 725 ms (and a score of 81) fails on both',
  );

  const slow = judge('/snake/ mobile', measurementOf(lhr({ performance: 0.88, tbt: 800 })));
  assert.deepEqual(slow.problems, [
    '/snake/ mobile: performance score 88, budget 90',
    '/snake/ mobile: total-blocking-time 800, budget 200',
  ]);
  assert.equal(slow.timing, true);

  const shifty = judge('p', measurementOf(lhr({ cls: 0.2 })));
  assert.deepEqual(shifty.problems, ['p: cumulative-layout-shift 0.200, budget 0.1']);
  assert.equal(shifty.timing, true);

  // The audits that did not pass are named in the message.
  const named = judge('p', measurementOf(lhr({ accessibility: 0.9, failingAudits: { accessibility: ['color-contrast', 'label'] } })));
  assert.deepEqual(named.problems, ['p: accessibility score 90, budget 100 (color-contrast, label)']);
  assert.equal(named.timing, false, 'accessibility does not depend on timing');
  for (const cat of ['best-practices', 'seo'] as const) {
    const v = judge('p', measurementOf(lhr({ [cat]: 0.5 })));
    assert.equal(v.problems.length, 1);
    assert.equal(v.timing, false);
  }

  // Missing numbers are reported, not passed.
  const missing = judge('p', measurementOf({ categories: { performance: { score: null } }, audits: {} }));
  assert.ok(missing.problems.includes('p: performance has no score'));
  assert.ok(missing.problems.includes('p: total-blocking-time has no value'));
}

// --- medianOf: every number is the median; the failing audits come from the worst run
{
  const runs = [
    measurementOf(lhr({ performance: 0.88, tbt: 467, failingAudits: { performance: ['unused-javascript'] } })),
    measurementOf(lhr({ performance: 1, tbt: 0 })),
    measurementOf(lhr({ performance: 0.99, tbt: 20 })),
  ];
  const m = medianOf(runs);
  assert.equal(m.scores.performance, 0.99);
  assert.equal(m.metrics['total-blocking-time'], 20);
  assert.deepEqual(m.failing.performance, ['unused-javascript']);
}

// --- measurePage
// Passes first time: one run, nothing more.
{
  const lh = lighthouseReturning([lhr()]);
  const r = await measurePage('/ desktop', lh.run);
  assert.deepEqual(r.problems, []);
  assert.equal(lh.calls(), 1);
  assert.equal(r.runs, 1);
  assert.equal(r.lhrs.length, 1);
  assert.doesNotMatch(r.line, /median/);
}

// One slow run among good ones, the case this exists for (the first run of /snake/ mobile in PR 35): the median passes.
{
  const lh = lighthouseReturning([lhr({ performance: 0.88, tbt: 467 }), lhr(), lhr({ tbt: 10 })]);
  const r = await measurePage('/snake/ mobile', lh.run);
  assert.deepEqual(r.problems, []);
  assert.equal(lh.calls(), 1 + RETRIES);
  assert.equal(r.runs, 3);
  assert.equal(r.lhrs.length, 3, 'all three results are kept for the reports');
  assert.match(r.line, /\[median of 3 after a miss; performance 88, 100, 100\]/);
  assert.match(r.line, /TBT 10ms/);
}

// A page that is really over budget misses in the median too: the build still fails.
{
  const slow = () => lhr({ performance: 0.8, tbt: 900 });
  const lh = lighthouseReturning([slow(), lhr({ performance: 0.82, tbt: 800 }), lhr({ performance: 0.78, tbt: 1000 })]);
  const r = await measurePage('/snake/ mobile', lh.run);
  assert.equal(lh.calls(), 3);
  assert.equal(r.problems.length, 2);
  assert.match(r.problems.join('\n'), /performance score 80, budget 90/);
  assert.match(r.problems.join('\n'), /total-blocking-time 900, budget 200/, "the median value, not the first run's");
}

// Two slow runs out of three also fail: one good run cannot rescue a page that is usually slow.
{
  const lh = lighthouseReturning([lhr({ tbt: 800, performance: 0.95 }), lhr({ tbt: 0 }), lhr({ tbt: 700, performance: 0.94 })]);
  const r = await measurePage('p', lh.run);
  assert.ok(r.problems.length > 0);
}

// An accessibility miss is reported at once with no reruns, because it would be the same every time.
{
  const lh = lighthouseReturning([lhr({ accessibility: 0.9, failingAudits: { accessibility: ['label'] } })]);
  const r = await measurePage('/ mobile', lh.run);
  assert.deepEqual(r.problems, ['/ mobile: accessibility score 90, budget 100 (label)']);
  assert.equal(lh.calls(), 1);
}

// A timing miss together with an accessibility miss: the reruns happen, and the accessibility miss is still reported.
{
  const lh = lighthouseReturning([lhr({ tbt: 467, performance: 0.88, seo: 0.9 }), lhr({ seo: 0.9 }), lhr({ seo: 0.9 })]);
  const r = await measurePage('p', lh.run);
  assert.equal(lh.calls(), 3);
  assert.deepEqual(r.problems, ['p: seo score 90, budget 100']);
}

// Lighthouse failing is reported, and not retried (a runtime error is not a slow run).
{
  const none = await measurePage('p', lighthouseReturning([null]).run);
  assert.deepEqual(none.problems, ['p: Lighthouse returned no result']);
  const broken = lhr();
  broken.runtimeError = { code: 'NO_FCP', message: 'The page did not paint any content.' };
  const lh = lighthouseReturning([broken]);
  const r = await measurePage('p', lh.run);
  assert.deepEqual(r.problems, ['p: NO_FCP The page did not paint any content.']);
  assert.equal(lh.calls(), 1);
}

// A rerun that fails is a problem too, and does not hide the first run's miss.
{
  const broken = lhr();
  broken.runtimeError = { code: 'PROTOCOL_TIMEOUT', message: 'timed out' };
  const lh = lighthouseReturning([lhr({ tbt: 800, performance: 0.88 }), broken]);
  const r = await measurePage('p', lh.run);
  assert.equal(lh.calls(), 2, 'it stops at the first failed rerun');
  assert.equal(r.problems.length, 3);
  assert.ok(r.problems.some((p) => p.includes('PROTOCOL_TIMEOUT') && p.includes('rerun')));
  assert.ok(r.problems.some((p) => p.includes('total-blocking-time 800')));
}

console.log('lighthouse budgets: ok');
