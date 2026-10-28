# Design

**The LD8 design system comes first; where it has no component, the app uses Frostline's** (Avi, 2026-10-23). Frostline is avi.me's design system; a copy of its components is in `vendor/frostline/`. The rule in practice: before building any piece of UI, look in the LD8 doc, then in Frostline, and only then write a rule of our own. Never rebuild a component Frostline has.

The LD8 doc is the **Arizona LD8 Democrats design system** (Claude artifact `VmUiLbvLFEoQkvpbUgPm9n`, version `1792785154-4559`, read 2026-10-23): warm paper background, ink text, the logo blue `#1f497d` as the voice, Sonoran copper (`ld8-accent`) for the one call to action per view, desert gold (`sun`) for decoration, Barlow Condensed headings and Public Sans body. Light and dark follow the browser setting (`prefers-color-scheme`) unless the theme switch in the header's account menu (the signed-in name opens a panel with the switch and Sign out; Auto, Light, Dark; Frostline's `themeSwitch`) chose one: the choice is kept in `localStorage` (`fl-theme`) and applied before first paint by `/js/theme.js`, as `data-theme` on `<html>`. `tokens.css` has the dark values twice, under the media query and under `data-theme="dark"`; change both. Both logos are in the header and CSS shows the one that matches.

## Who supplies what

| Piece | From | Where |
| --- | --- | --- |
| Tokens (color, type, radius, shadow), light and dark | LD8 | `public/tokens.css` |
| Logos, favicon, the header (logo, nav, hard 2px line) | LD8 | `public/img/`, `public/favicon.svg`, `.site-header` in `app.css` |
| Kicker, h1 to h3 type, lead paragraph | LD8 | `app.css` |
| Primary and accent buttons (`.btn`, `.btn--accent`): the one call to action | LD8 | `app.css` |
| Card (a record in a list), with the LD8 h3 as its title | Frostline `fl-card` | `fl-card__title` is restyled to Barlow 26/30 in `app.css` |
| Status and flag badges | Frostline `fl-badge` | `statusBadge`, `flagBadge` in `src/common.ts` |
| Joined status buttons | Frostline `fl-seg` + `Frostline.segmented` | `src/mine.ts` |
| Admin page sections | Frostline `fl-tabs` + `Frostline.tabs` | `src/admin.ts` |
| Notes and the cured list | Frostline `fl-disclosure` | |
| Notes and errors (a tinted note with words in it) | Frostline `fl-banner` | `banner()` |
| Messages after an action | Frostline `Frostline.toast` | `toast()` |
| "Move all of this volunteer's people": an in-place yes or no | Frostline `Frostline.confirm` | `src/admin.ts` |
| Fields, selects, textareas, checkboxes, filter row | Frostline `fl-field`, `fl-input`, `fl-select`, `fl-textarea`, `fl-check`, `fl-toolbar` | `field()` |
| Tables | Frostline `fl-table` in `fl-table-wrap` | `table()` in `src/admin.ts` |
| Stat tiles, the empty state | Frostline `fl-tile`, `fl-empty` | `tiles()` |
| Small and secondary buttons | Frostline `fl-btn`, `fl-btn--sm` | |
| Page frame, stacks, grids, skip link | Frostline `fl-page`, `fl-stack`, `fl-grid`, `fl-cluster`, `fl-skip` | |
| The definition list of facts about a person, the note list | ours (neither system has one) | `.facts`, `.notes` in `app.css` |
| The map's legend and its two pin looks (a solid dot, a ring), the map frame | ours (neither system has one); the pins' colors are the tokens `--pin-exact` and `--pin-guess`, aliases of the brand blue and the copper | `.map-legend`, `.pin`, `.map-frame` in `app.css`; `src/map.ts` reads the tokens |

## Tokens: how two systems share one set

Frostline's components read Frostline's token names (`--surface`, `--accent`, ...). `public/tokens.css` does not ship Frostline's tokens (no Nord palette, no IBM Plex); it defines those names with LD8 values:

| Frostline reads | Gets (LD8) |
| --- | --- |
| `--surface` (the page) | `--bg` |
| `--surface-raised`, `--ink`, `--border`, `--border-strong`, `--success`, `--danger` | the same names exist in LD8 with the same meaning |
| `--surface-sunken` (input wells) | LD8 `surface`, renamed `--ld8-surface` |
| `--ink-muted` | `--muted` |
| `--accent`, `--accent-hover`, `--on-accent` (the interactive color) | `--brand`, `--brand-strong`, `--on-brand` (logo blue) |
| `--focus-ring` | `--focus` |
| `--radius-md`, `--radius-lg`, `--radius-sm`, `--radius-full` | 8px, 16px, 4px, pill |
| `--space-1` to `--space-12` | the LD8 steps: 4, 8, 12, 16, 24, 32, 48 |
| `--font-sans` | Public Sans |
| `--font-mono` | a system monospace stack (neither system has a mono face; none is shipped) |
| `--warning`, `--shadow-sm`, `--shadow-md`, `--scrim`, `--select-chevron` | Frostline's own roles with LD8-matched values (LD8 has no warning color; `#7b5915` on light and `#ebcb8b` on dark are Frostline's) |

Two names collide with a different meaning, so the LD8 ones carry a prefix: `--ld8-accent` (copper) and `--ld8-surface` (panel). Frostline's `--accent` is the logo blue here. Frostline's own themes (`terracotta`, the theme switch) are not used.

## Spacing and margins

The LD8 doc gives the scale and the container widths but no rules for using them, so the app follows Frostline's (`GUIDELINES.md` and `README.md` in avi.me's `packages/frostline`):

- **Space comes from `gap` on the container, never from margins on children.** Headings, paragraphs and lists have no margins here (`app.css` resets them). Page CSS never adds a margin to separate siblings; if two things are too close, fix the gap of their container.
- **Each step has a role**, and the same relationship always gets the same step: `space-1` (4px) between an icon and its label, or a label and its field; `space-2` (8px) between tightly related controls in a row and inside a badge; `space-3` (12px) between blocks inside a card, a heading and its content, and list items; `space-4` (16px) for card padding and the gap in a form or toolbar; `space-6` (24px) between cards and between tiles; `space-8` (32px) between page sections; `space-12` (48px) for wide-screen page margins.
- **`fl-stack` is the column** (`space-4`; `fl-stack--3`, `--6`, `--8` for the other roles). A page is `fl-page fl-stack fl-stack--8`; a section is `fl-stack fl-stack--3`; a card is already a grid with a `space-3` gap, so its content goes straight inside.
- **Only the steps above.** No in-between values and no page-local margins. Frostline's CSS is in `@layer frostline`, so one plain rule in `app.css` overrides it without `!important`.
- Exceptions that are padding, not spacing between siblings: the card's own padding, the page's bottom padding (`.page`) and the header.

## What differs from the LD8 doc, on purpose

- The LD8 doc targets a zero-JavaScript public site. This is an internal tool, so it runs small first-party scripts, plus Frostline's. The CSP is still `'self'` only.
- Status badges carry their status in words; the border color is a second cue. Flags use the `danger` badge with text.
- The LD8 doc shows its Button at one size; Frostline's small button (`fl-btn--sm`) is used where a row needs one.

## Found while building, to report upstream

- **Frostline's toast container sits outside every landmark**, so axe's `region` rule flags it while a toast is showing. The smoke test clears toasts before scanning (they are transient and announced by their own live region). The fix belongs in Frostline: put the container in a landmark or give it one.
- Frostline's `bundle.css` header comment still says "1.6".
- **`fl-table` has no phone layout.** Wide tables only scroll sideways (`fl-table-wrap`), which is poor for Find people on a phone. The page renders the table and a compact list of rows and shows one by width (`.pool-table`, `.pool-rows` in `app.css`). A responsive stacked mode in Frostline would replace the second rendering.
- **`fl-table` styles a row header (`<th scope="row">`) like a column header** (small, letter-spaced, muted, no wrap). Find people needs the person's name there for screen readers, so `app.css` resets it (`.fl-table tbody th`). The fix belongs in Frostline: scope the header look to `thead th`.
- **`fl-toolbar` columns are `auto-fit` at 200px**, so four filters in about 830px wrap to a second row. `app.css` pins four columns there (`.pool-filters .fl-toolbar`); a column-count modifier would do it.

## Updating Frostline

`vendor/frostline/README.md` has the copy commands. After copying, bump the version in the pages' links (`/frostline/<version>/...` in each `public/**/*.html`); the smoke test fails if a page links a different version than the one built.

## Accessibility and performance

WCAG 2.2 AA, 44px targets on touch, a visible focus ring, `prefers-reduced-motion` respected, 200% zoom without clipping. CI runs axe on every page in light and dark at phone and desktop width, and Lighthouse budgets of 100 for accessibility, best practices and SEO and Google's "good" thresholds for speed.
