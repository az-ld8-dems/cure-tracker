// Applies the theme the header's switch saved, before the page paints (a classic script in <head>, so it cannot be a module).
// Frostline's theme switch (select[data-fl-theme]) saves under "fl-theme" and sets data-theme live; "auto" saves nothing.
try {
  const saved = localStorage.getItem('fl-theme');
  if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved);
} catch {
  // Storage is blocked: follow the browser.
}
