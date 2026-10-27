// Checks the map pins' colors (public/tokens.css) in both themes. Axe reads the page, not the map's canvas, and has no rule for the
// contrast between two shapes (WCAG 1.4.11), so this does the sums: every pin that is a solid fill has to be told from the others by
// more than its hue, and every pin has to stand out from the map's background. No browser.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/tokens.css', import.meta.url), 'utf8');

// The custom properties of one block, by name.
function block(selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `${selector} is in tokens.css`);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('\n}', start));
  const vars = new Map<string, string>();
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) vars.set(m[1] ?? '', (m[2] ?? '').trim());
  return vars;
}

const light = block(':root');
const themes: Record<string, Map<string, string>> = { light, dark: new Map([...light, ...block(':root[data-theme="dark"]')]) };

function colorOf(vars: Map<string, string>, name: string): [number, number, number] {
  let value = vars.get(name);
  for (let hops = 0; value?.startsWith('var(') && hops < 5; hops++) value = vars.get(value.slice(4, -1));
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value ?? '')?.[1];
  assert.ok(hex, `${name} is a hex color (got ${value})`);
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}

const luminance = ([r, g, b]: [number, number, number]): number => {
  const [lr, lg, lb] = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (lr ?? 0) + 0.7152 * (lg ?? 0) + 0.0722 * (lb ?? 0);
};
const ratio = (a: [number, number, number], b: [number, number, number]): number => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return ((x ?? 0) + 0.05) / ((y ?? 0) + 0.05);
};

// The solid pins: their fills must differ from each other in lightness, not only in hue. The ring (a guess) and the volunteer's own place
// (a dot with a wide halo) are told by their shape.
const FILLS = ['--pin-exact', '--pin-claimed', '--pin-stalled'];
const APART = 1.5;
// What each pin's outline is drawn in against the background: the open pool and the guess rings have their own colors, the claimed ones the text color.
const OUTLINES: [string, string][] = [
  ['--pin-exact', '--pin-exact'],
  ['--pin-guess', '--pin-guess'],
  ['--pin-you', '--pin-you'],
  ['--pin-claimed', '--ink'],
  ['--pin-stalled', '--ink'],
];
const STANDS_OUT = 3;
// The count on a group made only of claimed people is text on the claimed yellow.
const TEXT = 4.5;

for (const [theme, vars] of Object.entries(themes)) {
  for (const [i, a] of FILLS.entries()) {
    for (const b of FILLS.slice(i + 1)) {
      const r = ratio(colorOf(vars, a), colorOf(vars, b));
      assert.ok(r >= APART, `${theme}: ${a} and ${b} differ by only ${r.toFixed(2)}:1 (needs ${APART}:1), so they look alike without hue`);
    }
  }
  const onClaimed = ratio(colorOf(vars, '--on-pin-claimed'), colorOf(vars, '--pin-claimed'));
  assert.ok(
    onClaimed >= TEXT,
    `${theme}: the count on a claimed group (--on-pin-claimed) is only ${onClaimed.toFixed(2)}:1 on --pin-claimed (needs ${TEXT}:1)`,
  );
  for (const [pin, outline] of OUTLINES) {
    const r = ratio(colorOf(vars, outline), colorOf(vars, '--surface-raised'));
    assert.ok(
      r >= STANDS_OUT,
      `${theme}: the outline of ${pin} (${outline}) is only ${r.toFixed(2)}:1 against the page (needs ${STANDS_OUT}:1)`,
    );
  }
}
console.log('test-pin-contrast: ok');
