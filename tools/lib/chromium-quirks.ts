// Console messages headless Chromium produces on the map page because it draws WebGL in software (SwiftShader), which real browsers on real
// graphics hardware do not. MapLibre reads pixels back (to find what is under a click), and the driver warns about the stall. The smoke
// test counts each ignored message and lists them at the end, so a quirk that stops appearing can be removed. Anything not listed still fails.
export const chromiumQuirks = [
  {
    label: 'software WebGL warns about a GPU stall on the map page',
    re: /^\[\.WebGL-[0-9a-fx]+\]GL Driver Message \(OpenGL, Performance, GL_CLOSE_PATH_NV, High\): GPU stall due to ReadPixels/,
  },
];
