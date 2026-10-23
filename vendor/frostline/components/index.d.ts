/** Frostline behavior helpers (components/bundle.js). Documentation only. */
interface FrostlineApi {
  /** Announce a message to screen readers through a polite live region. */
  announce(message: string): void;
  /** Wire a role="tablist" element: clicks, arrow/Home/End keys, aria-selected, panels via aria-controls. */
  tabs(root: Element, opts?: { onChange?: (tab: Element) => void }): { select(tab: Element): void };
  /** Wire a .fl-seg group so exactly one button has aria-pressed="true". */
  segmented(root: Element, opts?: { onChange?: (value: string, button: Element) => void }): void;
  /** Wire a .fl-rating group of star buttons. Clicking the current value clears it. */
  rating(root: Element, opts?: { onChange?: (value: number) => void }): { get(): number; set(value: number): void };
  /** Modal dialog. Pass a native <dialog class="fl-sheet fl-sheet--modal"> (the browser traps focus, handles Escape and draws ::backdrop; this adds backdrop-click close and onClose), or the older hidden div role="dialog" with a scrim (focus trap, Escape and focus return done in script). */
  dialog(el: HTMLElement, opts?: { scrim?: HTMLElement; onClose?: () => void }): { open(trigger?: Element): void; close(): void };
  /** Combobox: a text field with a filtered, scrollable list under it (ARIA combobox, focus stays in the input). options(query) returns what is on offer and is called on every open and keystroke. mode "pick" (default) only chooses: picking clears the field and calls onPick, and Enter never submits the form. mode "suggest" allows free text: picking fills the field (firing input and change). The list is inserted after the input, or pass list to place it yourself (class fl-combobox__list--row spans a grid or wrapping row). Up to max (100) rows show, with a "keep typing" note beyond that. */
  combobox(
    input: HTMLInputElement,
    opts: {
      options: (query: string) => Array<{ id: string; label: string; sub?: string }>;
      onPick?: (item: { id: string; label: string; sub?: string }) => void;
      mode?: 'pick' | 'suggest';
      max?: number;
      list?: HTMLElement;
      label?: string;
      emptyText?: string;
      emptyIdle?: string;
      openOnFocus?: boolean;
      announce?: (item: { id: string; label: string; sub?: string }) => string;
    },
  ): { open(): void; close(): void; refresh(): void; clear(): void; destroy(): void };
  /** Keep the screen on while the page is in use. on() resolves "ok", "denied" or "unsupported" (show your own message for the last two: on a phone the person has to turn off auto-lock). The lock is requested again when the page becomes visible, until off() is called. */
  wakeLock(): { on(): Promise<'ok' | 'denied' | 'unsupported'>; off(): void; active(): boolean };
  /** Frostline release, for example "1.1". */
  version: string;
  /** Two-step confirm for a destructive action. Inline by default: the trigger is swapped for "message [confirm] [cancel]". With modal: true it opens a native alertdialog (optional title and detail) for actions that cannot be undone. Escape or cancel restores focus to the trigger. */
  confirm(
    trigger: HTMLElement,
    opts?: {
      message?: string;
      confirmLabel?: string;
      cancelLabel?: string;
      onConfirm?: () => void;
      modal?: boolean;
      title?: string;
      detail?: string;
    },
  ): { ask(): void };
  /** Turn an element into a polite .fl-status line. set(kind, text): kind is "ok", "off", "busy" or "" for the dot colour. */
  status(el: Element | string): { set(kind: 'ok' | 'off' | 'busy' | '', text: string): void };
  /** Show a short .fl-toast message and announce it. Toasts stack and clear a .fl-dock. */
  toast(message: string, opts?: { ms?: number }): void;
  /** Older name for tip(), kept for existing pages. */
  tooltip(
    container: HTMLElement,
    opts?: {
      resolve?: (
        e: PointerEvent,
        target: EventTarget | null,
      ) =>
        | string
        | {
            text: string;
            mark?: Element;
            rect?: { x: number; y: number; w: number; h: number };
            at?: { x: number; y: number };
            arc?: { cx: number; cy: number; r0: number; r1: number; a0: number; a1: number };
          }
        | null
        | undefined;
    },
  ): { hide(): void; refresh(): void };
  /** General tooltip: any element with data-tip inside root shows it on hover, focus and touch or click. Floats above the page and survives redraws. On mouse hover and keyboard focus of an ordinary element it is placed by CSS anchor positioning (script placement where that is unsupported, and for touch, chart marks and SVG). Marks inside .fl-chart, .fl-stackbar or [data-tip-group] are one tab stop with arrow/Home/End keys; a disabled control with data-tip is wrapped so the tip is reachable. On touch, dragging a finger across marks scrubs the tip between them. resolve() may supply text for a pointer position with no element (canvas charts). */
  tip(
    root: Element,
    opts?: {
      resolve?: (
        e: PointerEvent,
        target: EventTarget | null,
      ) =>
        | string
        | {
            text: string;
            mark?: Element;
            rect?: { x: number; y: number; w: number; h: number };
            at?: { x: number; y: number };
            arc?: { cx: number; cy: number; r0: number; r1: number; a0: number; a1: number };
          }
        | null
        | undefined;
    },
  ): { hide(): void; refresh(): void };
  /** Keeps the counts and Uncheck all button of .fl-checklist lists inside root. Put [data-checklist-count] (whole list) and [data-checklist-group-count] (per group) elements in the markup and a button[data-checklist-clear]. root can be a stable ancestor; call refresh() after a redraw. onChange runs after a tick; onClear replaces the default unticking. */
  checklist(root: Element, opts?: { noun?: string; onChange?: (box: HTMLInputElement) => void; onClear?: () => void }): { refresh(): void };
  /** Board: columns have data-stage, cards have data-id, optional select[data-move] on each card. */
  board(root: Element, opts?: { onMove?: (id: string, stage: string) => void }): { move(id: string, stage: string): void };
  /** Set data-theme ("light", "dark" or "terracotta") on el, default the whole page. */
  setTheme(id: string, el?: Element): void;
  /** Returns an inline <svg> string for a named icon (see Icon). size is 16, 20 (default) or 24. Without a label it is hidden from screen readers; with one it is an image with that name. Unknown names return ''. */
  icon(name: string, opts?: { size?: 16 | 20 | 24; label?: string }): string;
  /** The icon set: names lists every icon; mount(root) fills any [data-fl-icon] spans (also run on load). */
  icons: { names: string[]; mount(root?: Element): void };
  /** Wire a select[data-fl-theme] (options auto, light, dark, terracotta); remembers the choice in localStorage. Auto-mounted on load. */
  themeSwitch(sel: HTMLSelectElement): { get(): string; set(mode: string): void };
}
declare interface Window {
  Frostline: FrostlineApi;
}
