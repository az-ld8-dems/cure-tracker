// Console messages Firefox produces in CI that are not about the pages. The smoke test counts each ignored message and lists them at the end,
// so a quirk that stops appearing can be removed. Anything not listed still fails the run.
export const firefoxQuirks = [
  {
    // Seen on every page in different runs (so a rerun "fixes" it): Firefox warns when a preloaded font was not used within a few seconds, which
    // happens when the page is not being painted yet (the smoke test opens many pages in new contexts, and Firefox does not lay out one that
    // is not shown). The font is used by every page's header text as soon as it is.
    label: 'font preload warned as unused',
    re: /^\[JavaScript Warning: "The resource at .*\.woff2.* preloaded with link preload was not used within a few seconds/,
  },
  {
    // GitHub's runner has no graphics at all and Firefox's blocklist then refuses WebGL 2. The map page says so (the smoke test checks for that
    // notice instead of the canvas when the browser has no WebGL 2).
    label: 'Firefox cannot create a WebGL context here',
    re: /^\[JavaScript Warning: "Failed to create WebGL context/,
  },
];
