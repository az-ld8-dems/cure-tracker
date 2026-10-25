// Console messages Playwright's WebKit build produces on these pages that real Safari does not, and that are not ours to fix. The same
// message appears on avi.me's pages, where it was bisected to a <select> (every page here has one, from Frostline's fl-select): the
// page works and looks right, only the console line is wrong. The smoke test counts each ignored message and lists them at the end,
// so a quirk that stops appearing can be removed. Anything not listed still fails the run. Seen in CI on 2026-10-25 (WebKit, enforcing policy).
export const webkitQuirks = [
  {
    label: 'stylesheet refusal on a page with a <select>',
    re: /^Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive/,
  },
];
