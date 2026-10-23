# Design

The look comes from the **Arizona LD8 Democrats design system** (Claude artifact `VmUiLbvLFEoQkvpbUgPm9n`, version `1792785154-4559`, read 2026-10-23): warm paper background, ink text, the logo blue `#1f497d` as the voice, Sonoran copper (`accent`) for the one call to action per view, desert gold (`sun`) for decoration, Barlow Condensed headings and Public Sans body, 8 and 16 px radii. Light and dark follow the browser setting (`prefers-color-scheme`), with no toggle.

## What was copied

- `public/app.css`: the color, spacing, radius, shadow and type tokens (same names as the design system's `tokens.json`), and the button, header, kicker, card and pill shapes from its `bundle.css`.
- `public/fonts/`: Barlow Condensed Bold and Public Sans Variable (Latin subsets, OFL), self-hosted.
- `public/img/`: the logos, unchanged (wordmark, the derived dark-theme wordmark, state mark, both seal lockups); `public/favicon.svg` is the draft site icon. The dark wordmark is flagged in the design system as a derived file the committee has not yet approved; this is an internal tool.

## What differs, on purpose

- The design system targets a zero-JavaScript public site. This is an internal tool, so it runs a small first-party script (Avi's decision). The CSP is still `'self'` only.
- Status pills carry their status in words; the border color (copper, gold, blue, green) is only a second cue. Flags use `danger` with text.
- No Frostline (avi.me's design system) and no React: the design system's React components are previews only.

## Accessibility and performance

Targets from the design system: WCAG 2.2 AA, 44px targets (48px on touch), visible 3px focus ring, `prefers-reduced-motion` respected, 200% zoom without clipping. CI runs axe on every page in light and dark at phone and desktop width, and Lighthouse budgets of 100 for accessibility, best practices and SEO and Google's "good" thresholds for speed.
