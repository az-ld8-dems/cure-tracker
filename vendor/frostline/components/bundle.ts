/* Frostline behavior helpers. TypeScript compiled to one plain script, no imports, no network. Assigns window.Frostline. */
(() => {
  /* Inside a frame (an artifact in the Claude app) the page can sit under the app's own header; the CSS keeps phone sheets below it. */
  try {
    if (window.top !== window.self) document.documentElement.setAttribute('data-fl-embedded', '');
  } catch {
    document.documentElement.setAttribute('data-fl-embedded', '');
  }
  const FOCUSABLE =
    'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  function all<T extends Element = HTMLElement>(sel: string, root?: ParentNode | null): T[] {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  /* The option objects each helper takes, and the objects it returns. */
  interface TabsOptions {
    onChange?: (tab: HTMLElement) => void;
  }
  interface SegmentedOptions {
    onChange?: (value: string, button: HTMLElement) => void;
  }
  interface RatingOptions {
    onChange?: (value: number) => void;
  }
  interface DialogOptions {
    scrim?: HTMLElement | null;
    onClose?: (() => void) | null;
  }
  interface DialogApi {
    open(trigger?: HTMLElement | null): void;
    close(): void;
  }
  interface NativeDialogState {
    onClose: (() => void) | null | undefined;
    opener: HTMLElement | null;
  }
  type FlDialog = HTMLDialogElement & { _flDialog?: { state: NativeDialogState; api: DialogApi } };

  /* A polite live region for screen readers. */
  let live: HTMLElement | null = null;
  function announce(msg: string): void {
    if (!live) {
      live = document.createElement('div');
      live.className = 'fl-sr-only';
      live.setAttribute('role', 'status');
      live.setAttribute('aria-live', 'polite');
      document.body.appendChild(live);
    }
    const region = live;
    region.textContent = '';
    setTimeout(() => {
      region.textContent = msg;
    }, 50);
  }

  /* Tabs: roving tabindex, arrow/Home/End keys, shows the panel named by aria-controls. */
  function tabs(root: HTMLElement, opts?: TabsOptions) {
    const list = root.getAttribute('role') === 'tablist' ? root : root.querySelector<HTMLElement>('[role="tablist"]');
    if (!list) throw new Error('Frostline.tabs: no [role="tablist"] in the element');
    const items = all('[role="tab"]', list);
    function select(tab: HTMLElement, focus: boolean, silent: boolean): void {
      items.forEach((t) => {
        const on = t === tab;
        t.setAttribute('aria-selected', on ? 'true' : 'false');
        t.tabIndex = on ? 0 : -1;
        const id = t.getAttribute('aria-controls');
        const panel = id ? document.getElementById(id) : null;
        if (panel) panel.hidden = !on;
      });
      if (focus) tab.focus();
      if (!silent && opts && opts.onChange) opts.onChange(tab);
    }
    list.addEventListener('click', (e) => {
      const t = (e.target as Element).closest<HTMLElement>('[role="tab"]');
      if (t && items.indexOf(t) > -1) select(t, false, false);
    });
    list.addEventListener('keydown', (e) => {
      const i = items.indexOf(document.activeElement as HTMLElement);
      if (i < 0) return;
      let n = i;
      if (e.key === 'ArrowRight') n = (i + 1) % items.length;
      else if (e.key === 'ArrowLeft') n = (i - 1 + items.length) % items.length;
      else if (e.key === 'Home') n = 0;
      else if (e.key === 'End') n = items.length - 1;
      else return;
      e.preventDefault();
      const next = items[n];
      if (next) select(next, true, false);
    });
    const start = items.filter((t) => t.getAttribute('aria-selected') === 'true')[0] || items[0];
    if (start) select(start, false, true);
    return {
      select: (t: HTMLElement) => {
        select(t, false, false);
      },
    };
  }

  /* Segmented control: exactly one button has aria-pressed="true". */
  function segmented(root: HTMLElement, opts?: SegmentedOptions): void {
    const buttons = all<HTMLButtonElement>('button', root);
    root.addEventListener('click', (e) => {
      const t = (e.target as Element).closest('button');
      if (!t || buttons.indexOf(t) < 0) return;
      buttons.forEach((b) => {
        b.setAttribute('aria-pressed', b === t ? 'true' : 'false');
      });
      const value = t.getAttribute('data-value');
      if (opts?.onChange) opts.onChange(value !== null ? value : (t.textContent ?? '').trim(), t);
    });
  }

  /* Star rating: click sets the value, clicking the current value clears it. */
  function rating(root: HTMLElement, opts?: RatingOptions) {
    const buttons = all<HTMLButtonElement>('button', root);
    /* An empty star button gets the star icon, so the markup can stay just the buttons. */
    buttons.forEach((b) => {
      if (!b.firstChild) b.innerHTML = icon('star', { size: 20 });
    });
    function get() {
      return buttons.filter((b) => b.getAttribute('aria-pressed') === 'true').length;
    }
    function set(v: number): void {
      buttons.forEach((b, i) => {
        b.setAttribute('aria-pressed', i < v ? 'true' : 'false');
      });
    }
    root.addEventListener('click', (e) => {
      const clicked = (e.target as Element).closest('button');
      const i = clicked ? buttons.indexOf(clicked) : -1;
      if (i < 0) return;
      const v = get() === i + 1 ? 0 : i + 1;
      set(v);
      if (opts?.onChange) opts.onChange(v);
    });
    return { get: get, set: set };
  }

  /* Dialog: opens hidden element el, traps Tab, closes on Escape, returns focus to the opener. */
  function dialog(el: HTMLElement, options?: DialogOptions): DialogApi {
    const opts: DialogOptions = options || {};
    if (window.HTMLDialogElement && el instanceof window.HTMLDialogElement) return nativeDialog(el, opts);
    const scrim = opts.scrim || null;
    let opener: HTMLElement | null = null;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('tabindex', '-1');
    function focusables() {
      return all(FOCUSABLE, el).filter((x) => x.offsetParent !== null);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
        return;
      }
      if (e.key !== 'Tab') return;
      const f = focusables();
      if (!f.length) {
        e.preventDefault();
        return;
      }
      const first = f[0],
        last = f[f.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    function open(trigger?: HTMLElement | null): void {
      opener = trigger || (document.activeElement as HTMLElement | null);
      el.hidden = false;
      if (scrim) scrim.hidden = false;
      el.addEventListener('keydown', onKey);
      (focusables()[0] || el).focus();
    }
    function close(): void {
      el.hidden = true;
      if (scrim) scrim.hidden = true;
      el.removeEventListener('keydown', onKey);
      if (opener?.focus) opener.focus();
      if (opts.onClose) opts.onClose();
    }
    if (scrim) scrim.addEventListener('click', close);
    return { open: open, close: close };
  }

  /* Native dialog (1.2): el is a <dialog class="fl-sheet fl-sheet--modal">. The browser provides the focus trap, Escape, the backdrop (::backdrop), the top layer and focus return; this adds
     a click on the backdrop to close and onClose. A button with command="show-modal" commandfor="id" opens it with no script at all; call dialog(el) once for the backdrop click and onClose. */
  function nativeDialog(el: FlDialog, opts: DialogOptions): DialogApi {
    if (el._flDialog) {
      if (opts.onClose) el._flDialog.state.onClose = opts.onClose;
      return el._flDialog.api;
    }
    const state: NativeDialogState = { onClose: opts.onClose || null, opener: null };
    el.removeAttribute('hidden');
    el.addEventListener('click', (e) => {
      if (e.target !== el) return;
      const r = el.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) el.close();
    });
    /* Touch scroll lock (1.4): iOS Safari chains a swipe on a dialog with nothing to scroll into the page behind it, even with overflow hidden on the root. Block the move when the dialog is not scrollable. */
    el.addEventListener(
      'touchmove',
      (e) => {
        if (el.scrollHeight <= el.clientHeight + 1) e.preventDefault();
      },
      { passive: false },
    );
    el.addEventListener('close', () => {
      const o = state.opener;
      state.opener = null;
      if (o?.isConnected && o.focus) o.focus();
      if (state.onClose) state.onClose();
    });
    const api: DialogApi = {
      open: (trigger?: HTMLElement | null) => {
        state.opener = trigger || (document.activeElement as HTMLElement | null);
        if (!el.open) el.showModal();
      },
      close: () => {
        if (el.open) el.close();
      },
    };
    el._flDialog = { state, api };
    return api;
  }

  /* Wake lock (1.4): keeps the screen on while a page is in use (cooking, a shopping list). wakeLock() returns { on(), off(), active() }. on() resolves "ok", "denied" (the browser refused, for example a low battery or a page that is not visible) or "unsupported"; show the caller's own message for the last two, since on a phone the person has to turn off auto-lock themselves. The browser drops the lock whenever the page is hidden, so while on() has been called and off() has not, the lock is requested again when the page becomes visible. */
  function wakeLock() {
    let sentinel: WakeLockSentinel | null = null,
      wanted = false;
    function request(): Promise<string> {
      if (!navigator.wakeLock) return Promise.resolve('unsupported');
      if (sentinel) return Promise.resolve('ok');
      try {
        return navigator.wakeLock.request('screen').then(
          (w) => {
            sentinel = w;
            if (w.addEventListener)
              w.addEventListener('release', () => {
                if (sentinel === w) sentinel = null;
              });
            return 'ok';
          },
          () => 'denied',
        );
      } catch {
        return Promise.resolve('denied');
      }
    }
    document.addEventListener('visibilitychange', () => {
      if (wanted && !document.hidden) request();
    });
    return {
      on: () => {
        wanted = true;
        return request();
      },
      off: () => {
        wanted = false;
        try {
          if (sentinel) {
            sentinel.release();
            sentinel = null;
          }
        } catch {}
      },
      active: () => !!sentinel,
    };
  }

  /* Toast: a short message near the bottom, also announced to screen readers. Toasts stack in one container and clear a .fl-dock. Where popovers are supported the container is a manual popover that is shown again for every toast, so it sits in the top layer above any modal dialog that is open (a modal <dialog> would otherwise cover it); elsewhere it stays an ordinary fixed element. */
  let toasts: HTMLElement | null = null;
  function toast(message: string, opts?: { ms?: number }): void {
    const ms = opts?.ms || 2500;
    if (!toasts || !document.body.contains(toasts)) {
      toasts = document.createElement('div');
      toasts.className = 'fl-toasts';
      if (typeof toasts.showPopover === 'function') toasts.setAttribute('popover', 'manual');
      document.body.appendChild(toasts);
    }
    const dock = document.querySelector<HTMLElement>('.fl-dock');
    toasts.style.setProperty('--fl-dock-h', dock ? `${dock.offsetHeight}px` : '0px');
    const t = document.createElement('div');
    t.className = 'fl-toast';
    t.textContent = message;
    toasts.appendChild(t);
    raiseToasts(true);
    announce(message);
    setTimeout(() => {
      if (t.parentNode) t.parentNode.removeChild(t);
      if (toasts && !toasts.childElementCount) raiseToasts(false);
    }, ms);
  }
  /* Put the toast container at the end of the top layer (above dialogs opened since), or take it out when it is empty. */
  function raiseToasts(on: boolean): void {
    if (!toasts?.hasAttribute('popover')) return;
    try {
      if (toasts.matches(':popover-open')) toasts.hidePopover();
      if (on) toasts.showPopover();
    } catch {}
  }

  /* Status: a small mono status line. status(el).set('ok'|'off'|'busy'|'', text) sets the dot and the text, and el is a polite live region. */
  function status(target: HTMLElement | string) {
    const el = typeof target === 'string' ? document.querySelector<HTMLElement>(target) : target;
    if (!el) throw new Error('Frostline.status: element not found');
    el.classList.add('fl-status');
    el.setAttribute('role', 'status');
    return {
      set: (kind: string, text: string) => {
        el.classList.remove('fl-status--ok', 'fl-status--off', 'fl-status--busy');
        if (kind) el.classList.add(`fl-status--${kind}`);
        el.textContent = text;
      },
    };
  }

  /* Confirm: two-step for a destructive action. confirm(trigger, {message, confirmLabel, cancelLabel, onConfirm}) swaps the trigger for "message [confirm] [cancel]"; Escape or cancel restores it and focus.
     With modal:true it opens a native <dialog role="alertdialog"> instead (optional title and detail), for an action that cannot be undone and needs more than one line of explanation. Cancel has focus, Escape and a click on the backdrop cancel, and focus returns to the trigger. */
  interface ConfirmOptions {
    message?: string;
    title?: string;
    detail?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    modal?: boolean;
    onConfirm?: () => void;
  }
  function confirm(trigger: HTMLElement, options?: ConfirmOptions) {
    const opts: ConfirmOptions = options || {};
    function askModal(): void {
      const dlg = document.createElement('dialog');
      dlg.className = 'fl-sheet fl-sheet--modal fl-confirm-dialog';
      dlg.setAttribute('role', 'alertdialog');
      const tid = `fl-cd-${Math.random().toString(36).slice(2, 8)}`,
        did = `${tid}-d`;
      dlg.setAttribute('aria-labelledby', tid);
      const h = document.createElement('h2');
      h.className = 'fl-sheet__title';
      h.id = tid;
      h.textContent = opts.title || opts.message || 'Delete?';
      dlg.appendChild(h);
      if (opts.title && opts.message) {
        const m = document.createElement('p');
        m.className = 'fl-note';
        m.id = did;
        m.textContent = opts.message;
        dlg.appendChild(m);
        dlg.setAttribute('aria-describedby', did);
      }
      if (opts.detail) {
        const dt = document.createElement('p');
        dt.className = 'fl-note';
        dt.textContent = opts.detail;
        dlg.appendChild(dt);
      }
      const act = document.createElement('div');
      act.className = 'fl-sheet__actions';
      const yes = document.createElement('button');
      yes.type = 'button';
      yes.className = 'fl-btn fl-btn--danger';
      yes.textContent = opts.confirmLabel || 'Yes, delete';
      const no = document.createElement('button');
      no.type = 'button';
      no.className = 'fl-btn';
      no.textContent = opts.cancelLabel || 'Keep it';
      act.appendChild(no);
      act.appendChild(yes);
      dlg.appendChild(act);
      let confirmed = false;
      document.body.appendChild(dlg);
      dlg.addEventListener('close', () => {
        if (dlg.parentNode) dlg.parentNode.removeChild(dlg);
        if (confirmed) {
          if (opts.onConfirm) opts.onConfirm();
        } else if (trigger.isConnected) trigger.focus();
      });
      dlg.addEventListener('click', (e) => {
        if (e.target !== dlg) return;
        const r = dlg.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close();
      });
      no.addEventListener('click', () => {
        dlg.close();
      });
      yes.addEventListener('click', () => {
        confirmed = true;
        dlg.close();
      });
      dlg.showModal();
      no.focus();
    }
    function ask(): void {
      if (opts.modal && typeof HTMLDialogElement === 'function' && typeof HTMLDialogElement.prototype.showModal === 'function') {
        askModal();
        return;
      }
      const box = document.createElement('span');
      box.className = 'fl-confirm';
      box.setAttribute('role', 'group');
      const q = document.createElement('span');
      q.className = 'fl-confirm__q';
      q.textContent = opts.message || 'Delete?';
      const yes = document.createElement('button');
      yes.type = 'button';
      yes.className = 'fl-btn fl-btn--sm fl-btn--danger';
      yes.textContent = opts.confirmLabel || 'Yes, delete';
      const no = document.createElement('button');
      no.type = 'button';
      no.className = 'fl-btn fl-btn--sm';
      no.textContent = opts.cancelLabel || 'Keep it';
      box.appendChild(q);
      box.appendChild(yes);
      box.appendChild(no);
      const parent = trigger.parentNode;
      if (!parent) return; // a trigger that is not on the page has nowhere to ask
      parent.insertBefore(box, trigger);
      trigger.hidden = true;
      function close(restore: boolean): void {
        document.removeEventListener('keydown', onKey, true);
        if (box.parentNode) box.parentNode.removeChild(box);
        trigger.hidden = false;
        if (restore) trigger.focus();
      }
      function onKey(e: KeyboardEvent): void {
        if (e.key === 'Escape' && box.contains(document.activeElement)) {
          e.stopPropagation();
          e.preventDefault();
          close(true);
        }
      }
      document.addEventListener('keydown', onKey, true);
      no.addEventListener('click', () => {
        close(true);
      });
      yes.addEventListener('click', () => {
        close(false);
        if (opts.onConfirm) opts.onConfirm();
      });
      announce(`${opts.message || 'Delete?'} Confirm or cancel.`);
      yes.focus();
    }
    trigger.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      ask();
    });
    return { ask: ask };
  }

  /* Older name for the chart tooltip. It is now the same as tip(), so charts scrub and float like everything else. */
  function tooltip(container: HTMLElement, opts?: TipOptions) {
    return tip(container, opts);
  }

  /* Tip: the general tooltip. Any element with data-tip inside root shows its text on hover, keyboard focus and touch or click.
     One floating box, fixed to the viewport, so it is never clipped. Events are delegated, so it survives the page redrawing its markup.
     Touch scrubbing works everywhere: press and drag a finger across the marks and the tip follows. Give charts touch-action:none (fl-chart does) so the drag is not taken for a page scroll.
     opts.resolve(event, target) may return text for a pointer position that has no element of its own (a canvas chart, for example). */
  interface TipRect {
    x: number;
    y: number;
    w: number;
    h: number;
  }
  interface TipArc {
    cx: number;
    cy: number;
    r0: number;
    r1: number;
    a0: number;
    a1: number;
  }
  interface TipExtra {
    text?: string;
    mark?: HTMLElement | null;
    rect?: TipRect;
    at?: { x: number; y: number };
    arc?: TipArc;
  }
  interface TipOptions {
    resolve?: (e: PointerEvent, target: Element | null) => string | TipExtra | null | undefined;
  }
  function tip(root: HTMLElement, options?: TipOptions) {
    const opts: TipOptions = options || {};
    const box = document.createElement('div');
    box.className = 'fl-tooltip fl-tooltip--float';
    box.setAttribute('role', 'tooltip');
    box.id = `fl-tip-${Math.random().toString(36).slice(2, 8)}`;
    box.hidden = true;
    document.body.appendChild(box);
    let current: HTMLElement | null = null;
    /* CSS anchor positioning (Baseline since January 2026) places the tip under an ordinary element when a mouse hovers it or the keyboard focuses it. Touch, chart marks, SVG and resolve() results keep the pointer-based place() below, which is also the fallback where anchor positioning is missing. */
    const CAN_ANCHOR = !!(window.CSS && CSS.supports?.('anchor-name', '--x') && CSS.supports('position-anchor', '--x'));
    let anchorName = `--${box.id}`,
      anchored: HTMLElement | null = null;
    function anchorable(t: HTMLElement | null | undefined, touch: boolean, extra: unknown) {
      return (
        CAN_ANCHOR &&
        t &&
        !touch &&
        !extra &&
        !(window.SVGElement && t instanceof window.SVGElement) &&
        !t.closest?.('.fl-chart,.fl-stackbar,[data-tip-group]')
      );
    }
    function anchorTo(t: HTMLElement): void {
      if (anchored && anchored !== t) anchored.style.removeProperty('anchor-name');
      if (anchored !== t) t.style.setProperty('anchor-name', anchorName);
      anchored = t;
      box.style.setProperty('position-anchor', anchorName);
      box.classList.add('fl-tooltip--anchored');
      box.style.left = '';
      box.style.top = '';
    }
    function unanchor(): void {
      if (anchored) {
        anchored.style.removeProperty('anchor-name');
        anchored = null;
      }
      box.style.removeProperty('position-anchor');
      box.classList.remove('fl-tooltip--anchored');
    }
    function place(x: number, y: number, touch: boolean): void {
      const w = box.offsetWidth,
        h = box.offsetHeight,
        vw = window.innerWidth,
        vh = window.innerHeight;
      /* Touch: up and to the left of the finger so a right thumb does not cover it. Otherwise below and right of the pointer. */
      const left = touch ? x - w - 12 : x + 12;
      let top = touch ? y - h - 12 : y + 16;
      if (!touch && top + h > vh - 8) top = y - h - 12;
      box.style.left = `${Math.max(8, Math.min(left, vw - w - 8))}px`;
      box.style.top = `${Math.max(8, Math.min(top, vh - h - 8))}px`;
    }
    /* The outline for a chart position that has no element of its own, in viewport pixels: a box (rect), a ring (at), or a wedge (arc: {cx, cy, r0, r1, a0, a1}, radians clockwise from 3 o'clock as canvas draws them) that traces a donut slice. */
    let mark: HTMLElement | null = null,
      arcMark: SVGSVGElement | null = null;
    function arcPath(a: TipArc): string {
      const P = (r: number, t: number): string => `${(a.cx + r * Math.cos(t)).toFixed(2)} ${(a.cy + r * Math.sin(t)).toFixed(2)}`;
      const sweep = a.a1 - a.a0,
        big = Math.abs(sweep) > Math.PI ? 1 : 0;
      if (Math.abs(sweep) >= Math.PI * 2 - 0.001) {
        const m = a.a0 + Math.PI;
        return (
          'M' +
          P(a.r1, a.a0) +
          'A' +
          a.r1 +
          ' ' +
          a.r1 +
          ' 0 1 1 ' +
          P(a.r1, m) +
          'A' +
          a.r1 +
          ' ' +
          a.r1 +
          ' 0 1 1 ' +
          P(a.r1, a.a0) +
          'Z' +
          'M' +
          P(a.r0, a.a0) +
          'A' +
          a.r0 +
          ' ' +
          a.r0 +
          ' 0 1 0 ' +
          P(a.r0, m) +
          'A' +
          a.r0 +
          ' ' +
          a.r0 +
          ' 0 1 0 ' +
          P(a.r0, a.a0) +
          'Z'
        );
      }
      return (
        'M' +
        P(a.r1, a.a0) +
        'A' +
        a.r1 +
        ' ' +
        a.r1 +
        ' 0 ' +
        big +
        ' 1 ' +
        P(a.r1, a.a1) +
        'L' +
        P(a.r0, a.a1) +
        'A' +
        a.r0 +
        ' ' +
        a.r0 +
        ' 0 ' +
        big +
        ' 0 ' +
        P(a.r0, a.a0) +
        'Z'
      );
    }
    function outline(o: TipExtra | null | undefined): void {
      if (mark) mark.hidden = true;
      if (arcMark) arcMark.style.display = 'none';
      if (!o) return;
      if (o.arc) {
        if (!arcMark) {
          arcMark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          arcMark.setAttribute('class', 'fl-tip-arc');
          arcMark.setAttribute('aria-hidden', 'true');
          arcMark.innerHTML = '<path class="halo"/><path class="line"/>';
          document.body.appendChild(arcMark);
        }
        const d = arcPath(o.arc);
        (arcMark.firstChild as Element).setAttribute('d', d);
        (arcMark.lastChild as Element).setAttribute('d', d);
        arcMark.style.display = '';
        return;
      }
      const b = o.rect || (o.at ? { x: o.at.x - 8, y: o.at.y - 8, w: 16, h: 16 } : null);
      if (!b) return;
      if (!mark) {
        mark = document.createElement('div');
        mark.setAttribute('aria-hidden', 'true');
        mark.hidden = true;
        document.body.appendChild(mark);
      }
      mark.className = `fl-tip-mark${o.rect ? '' : ' fl-tip-mark--dot'}`;
      mark.style.cssText = `left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px`;
      mark.hidden = false;
    }
    function show(
      text: string | null | undefined,
      x: number,
      y: number,
      touch: boolean,
      target?: HTMLElement | null,
      extra?: TipExtra | null,
    ): void {
      if (!text) {
        hide();
        return;
      }
      outline(extra);
      if (current && current !== target) {
        current.removeAttribute('aria-describedby');
        current.classList.remove('fl-tip-active');
      }
      current = target || null;
      if (current) {
        current.setAttribute('aria-describedby', box.id);
        current.classList.add('fl-tip-active');
      }
      if (box.textContent !== text) box.textContent = text;
      box.hidden = false;
      if (target && anchorable(target, touch, extra)) {
        anchorTo(target);
      } else {
        unanchor();
        place(x, y, touch);
      }
    }
    function hide(): void {
      unanchor();
      box.hidden = true;
      outline(null);
      if (current) {
        current.removeAttribute('aria-describedby');
        current.classList.remove('fl-tip-active');
      }
      current = null;
    }
    /* On touch the browser keeps sending events to the element the finger landed on, so find what is under the finger now. */
    function under(e: Event): EventTarget | null {
      const p = e as PointerEvent;
      return p.pointerType === 'touch' ? document.elementFromPoint(p.clientX, p.clientY) || e.target : e.target;
    }
    function targetOf(e: Event): HTMLElement | null {
      const el = under(e) as Element | null,
        t = el?.closest ? el.closest<HTMLElement>('[data-tip]') : null;
      return t && root.contains(t) ? t : null;
    }
    const GROUP = '.fl-chart,.fl-stackbar,[data-tip-group]';
    let byText: Record<string, HTMLElement> = {};
    function refresh(): void {
      byText = {};
      all('[data-tip]', root).forEach((t) => {
        t.classList.add('fl-tip-target');
        const tipText = t.getAttribute('data-tip') ?? '';
        byText[tipText] = t;
        /* A disabled control cannot take focus or show a tip, so the tip moves to a focusable wrapper. */
        if ((t as HTMLButtonElement).disabled && t.parentNode) {
          const w = document.createElement('span');
          w.className = 'fl-tip-wrap';
          w.setAttribute('data-tip', tipText);
          t.removeAttribute('data-tip');
          t.classList.remove('fl-tip-target');
          t.parentNode.insertBefore(w, t);
          w.appendChild(t);
          w.setAttribute('tabindex', '0');
          w.classList.add('fl-tip-target');
          return;
        }
        if (!t.hasAttribute('tabindex') && !t.matches(FOCUSABLE)) t.setAttribute('tabindex', '0');
      });
      /* Marks in a chart, stacked bar or [data-tip-group] are one tab stop; arrows, Home and End move between them. */
      const groups = all(GROUP, root);
      if (root.matches?.(GROUP)) groups.unshift(root);
      groups.forEach((g) => {
        const marks = all('[data-tip]', g);
        if (marks.length < 2) return;
        const keep = marks.filter((m) => m.getAttribute('tabindex') === '0' && m.hasAttribute('data-fl-rv'))[0] || marks[0];
        marks.forEach((m) => {
          m.setAttribute('data-fl-rv', '');
          m.setAttribute('tabindex', m === keep ? '0' : '-1');
        });
      });
      if (current && !document.body.contains(current)) hide();
    }
    function at(e: PointerEvent): void {
      const t = targetOf(e),
        touch = e.pointerType === 'touch';
      if (t) show(t.getAttribute('data-tip'), e.clientX, e.clientY, touch, t);
      else if (opts.resolve) {
        /* resolve returns the text, or {text, mark, rect, at, arc}: mark is an element to outline; rect ({x,y,w,h}), at ({x,y}) or arc ({cx,cy,r0,r1,a0,a1}, a donut slice) in viewport pixels draws an outline where there is no element. With none of them, a mark whose data-tip is the same text is outlined. */
        const res = opts.resolve(e, under(e) as Element | null),
          obj = res && typeof res === 'object' ? res : null,
          text = obj ? obj.text : (res as string | null | undefined);
        if (text) {
          const el = obj?.mark || (obj && (obj.rect || obj.at || obj.arc) ? null : byText[text]) || null;
          show(text, e.clientX, e.clientY, touch, el, obj);
        } else if (!touch) hide();
      } else if (!touch && current) hide();
    }
    /* Scrub: while a finger is down, dragging across the chart moves the tip to whatever is under it. It stays after the finger lifts. */
    let down: number | null = null;
    root.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'touch' || down === e.pointerId) at(e);
    });
    root.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') down = e.pointerId;
      at(e);
    });
    root.addEventListener('pointerup', (e) => {
      if (down === e.pointerId) down = null;
    });
    root.addEventListener('pointercancel', (e) => {
      if (down === e.pointerId) down = null;
      hide();
    });
    root.addEventListener('pointerleave', (e) => {
      if (e.pointerType !== 'touch') hide();
    });
    /* While a finger is scrubbing, stop iOS from starting a text selection, a long-press menu or an image/canvas drag. */
    function whileScrubbing(e: Event): void {
      if (down !== null) e.preventDefault();
    }
    root.addEventListener('contextmenu', whileScrubbing);
    root.addEventListener('selectstart', whileScrubbing);
    root.addEventListener('dragstart', (e) => {
      const t = e.target as Element | null;
      if (down !== null || t?.closest?.('canvas,svg')) e.preventDefault();
    });
    root.addEventListener('focusin', (e) => {
      const t = targetOf(e);
      if (!t) return;
      const r = t.getBoundingClientRect();
      show(t.getAttribute('data-tip'), r.left + r.width / 2 - 12, r.bottom - 16, false, t);
    });
    root.addEventListener('keydown', (e) => {
      if (!/^(Arrow(Left|Right|Up|Down)|Home|End)$/.test(e.key)) return;
      const t = (e.target as Element).closest?.<HTMLElement>('[data-tip]'),
        g = t?.closest<HTMLElement>(GROUP);
      if (!t || !g || !root.contains(g) || !t.hasAttribute('data-fl-rv')) return;
      const m = all('[data-tip]', g),
        i = m.indexOf(t),
        n = m.length;
      const k = e.key,
        to = k === 'Home' ? 0 : k === 'End' ? n - 1 : k === 'ArrowLeft' || k === 'ArrowUp' ? (i + n - 1) % n : (i + 1) % n;
      e.preventDefault();
      m.forEach((x) => {
        x.setAttribute('tabindex', '-1');
      });
      const dest = m[to];
      if (dest) {
        dest.setAttribute('tabindex', '0');
        dest.focus();
      }
    });
    root.addEventListener('focusout', hide);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hide();
    });
    document.addEventListener('pointerdown', (e) => {
      if (!root.contains(e.target as Node)) hide();
    });
    window.addEventListener('scroll', hide, true);
    const mo = window.MutationObserver ? new MutationObserver(refresh) : null;
    if (mo) mo.observe(root, { childList: true, subtree: true });
    refresh();
    return { hide: hide, refresh: refresh };
  }

  /* Board: columns have data-stage, cards have data-id. Drag and drop, plus a select[data-move] on each card as the keyboard path. */
  function board(root: HTMLElement, opts?: { onMove?: (id: string, stage: string) => void }) {
    const cols = all('[data-stage]', root);
    function colFor(stage: string | null) {
      return cols.filter((c) => c.getAttribute('data-stage') === stage)[0];
    }
    function cardFor(id: string | null) {
      return all('[data-id]', root).filter((c) => c.getAttribute('data-id') === id)[0];
    }
    function counts(): void {
      cols.forEach((c) => {
        const b = c.querySelector('.fl-col__head .fl-badge');
        if (b) b.textContent = String(all('[data-id]', c).length);
      });
    }
    function move(id: string, stage: string): void {
      const card = cardFor(id),
        col = colFor(stage);
      if (!card || !col) return;
      col.appendChild(card);
      counts();
      const head = col.querySelector('.fl-col__head span');
      announce(`Moved to ${head ? (head.textContent ?? '').toLowerCase() : stage}`);
      if (opts?.onMove) opts.onMove(id, stage);
    }
    all('[data-id]', root).forEach((card) => {
      card.draggable = true;
      card.addEventListener('dragstart', (e) => {
        const cardId = card.getAttribute('data-id');
        if (cardId !== null) e.dataTransfer?.setData('text/plain', cardId);
      });
      const sel = card.querySelector<HTMLSelectElement>('select[data-move]');
      if (sel)
        sel.addEventListener('change', () => {
          const cardId = card.getAttribute('data-id');
          if (sel.value && cardId !== null) move(cardId, sel.value);
          sel.selectedIndex = 0;
        });
    });
    cols.forEach((col) => {
      col.addEventListener('dragover', (e) => {
        e.preventDefault();
        col.classList.add('fl-col--over');
      });
      col.addEventListener('dragleave', () => {
        col.classList.remove('fl-col--over');
      });
      col.addEventListener('drop', (e) => {
        e.preventDefault();
        col.classList.remove('fl-col--over');
        const id = e.dataTransfer?.getData('text/plain');
        const stage = col.getAttribute('data-stage');
        if (id && stage !== null) move(id, stage);
      });
    });
    counts();
    return { move: move };
  }

  /* Theme: 'light', 'dark' or 'terracotta' on el (default: the whole page). */
  function setTheme(id: string, el?: HTMLElement | null): void {
    (el || document.documentElement).setAttribute('data-theme', id);
  }

  /* Theme switch: a select[data-fl-theme] with options auto, light, dark, terracotta.
     The choice is kept in localStorage under "fl-theme" ("auto" removes it and follows the system).
     The page's head snippet applies it before first paint; this wires the control and applies changes live. */
  function themeSwitch(sel: HTMLSelectElement) {
    const KEY = 'fl-theme',
      mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    function get() {
      try {
        return localStorage.getItem(KEY) || 'auto';
      } catch {
        return 'auto';
      }
    }
    function apply(mode: string): void {
      setTheme(mode === 'auto' ? (mq?.matches ? 'dark' : 'light') : mode);
    }
    sel.value = get();
    sel.addEventListener('change', () => {
      try {
        if (sel.value === 'auto') localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, sel.value);
      } catch {}
      apply(sel.value);
    });
    return {
      get: get,
      set: (m: string) => {
        sel.value = m;
        sel.dispatchEvent(new Event('change'));
      },
    };
  }
  function mountThemes() {
    const els = document.querySelectorAll<HTMLSelectElement>('select[data-fl-theme]');
    for (const el of els) themeSwitch(el);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountThemes);
  else mountThemes();

  /* Icons: original 20 px outline glyphs, 1.5 px round strokes, drawn in currentColor.
     Frostline.icon(name, {size: 16|20|24, label}) returns an <svg> string for a template; with a label it is an image with that name, without one it is hidden from screen readers.
     Any <span data-fl-icon="name"> on the page is filled in on load (or call Frostline.icons.mount(root)). Keep an icon-only control's name on the button itself with aria-label. */
  const D = 'currentColor';
  const PATHS: Record<string, string> = {
    search: '<circle cx="9" cy="9" r="5.5"/><path d="M13.2 13.2L17 17"/>',
    plus: '<path d="M10 4v12M4 10h12"/>',
    minus: '<path d="M4 10h12"/>',
    close: '<path d="M5 5l10 10M15 5L5 15"/>',
    check: '<path d="M4 10.5l4 4 8-9"/>',
    'chevron-up': '<path d="M5 12.5l5-5 5 5"/>',
    'chevron-down': '<path d="M5 7.5l5 5 5-5"/>',
    'chevron-left': '<path d="M12.5 5l-5 5 5 5"/>',
    'chevron-right': '<path d="M7.5 5l5 5-5 5"/>',
    'arrow-left': '<path d="M16 10H4M9 5l-5 5 5 5"/>',
    'arrow-right': '<path d="M4 10h12M11 5l5 5-5 5"/>',
    menu: '<path d="M3 5.5h14M3 10h14M3 14.5h14"/>',
    more:
      '<g fill="' +
      D +
      '" stroke="none"><circle cx="4.5" cy="10" r="1.4"/><circle cx="10" cy="10" r="1.4"/><circle cx="15.5" cy="10" r="1.4"/></g>',
    list:
      '<path d="M7 5.5h10M7 10h10M7 14.5h10"/><g fill="' +
      D +
      '" stroke="none"><circle cx="3.5" cy="5.5" r="1"/><circle cx="3.5" cy="10" r="1"/><circle cx="3.5" cy="14.5" r="1"/></g>',
    grid: '<rect x="3.5" y="3.5" width="5.5" height="5.5" rx="1.2"/><rect x="11" y="3.5" width="5.5" height="5.5" rx="1.2"/><rect x="3.5" y="11" width="5.5" height="5.5" rx="1.2"/><rect x="11" y="11" width="5.5" height="5.5" rx="1.2"/>',
    edit: '<path d="M13.5 3.5l3 3L7 16l-4 1 1-4z"/><path d="M12 5l3 3"/>',
    trash: '<path d="M3.5 6h13M8 6V4h4v2M5.5 6l.7 10h7.6l.7-10M8.5 9v4M11.5 9v4"/>',
    copy: '<rect x="7" y="7" width="9.5" height="9.5" rx="1.8"/><path d="M13 7V5.5A1.5 1.5 0 0 0 11.5 4h-6A1.5 1.5 0 0 0 4 5.5v6A1.5 1.5 0 0 0 5.5 13H7"/>',
    download: '<path d="M10 3v9.5M6 8.5l4 4 4-4M4 16.5h12"/>',
    upload: '<path d="M10 13V3.5M6 7l4-4 4 4M4 16.5h12"/>',
    external:
      '<path d="M11.5 3.5h5v5M16.5 3.5L9.5 10.5M14 11.5V15a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 15V7.5A1.5 1.5 0 0 1 5 6h3.5"/>',
    link: '<path d="M8.5 11.5a3 3 0 0 0 4.2 0l2.5-2.5a3 3 0 0 0-4.2-4.2L10 5.8M11.5 8.5a3 3 0 0 0-4.2 0L4.8 11a3 3 0 0 0 4.2 4.2l1-1"/>',
    filter: '<path d="M3 4.5h14l-5.3 6.3V16l-3.4-1.7v-3.5z"/>',
    sort: '<path d="M6 16.5v-13M3 6.5l3-3 3 3M14 3.5v13M11 13.5l3 3 3-3"/>',
    refresh: '<path d="M16 10a6 6 0 1 1-1.8-4.3"/><path d="M16.2 3.3v3.4h-3.4"/>',
    settings: '<path d="M3 6h7.5M15.5 6H17M3 14h1.5M9.5 14H17"/><circle cx="13" cy="6" r="2.5"/><circle cx="7" cy="14" r="2.5"/>',
    info: `<circle cx="10" cy="10" r="7"/><path d="M10 9.2v4.3"/><circle cx="10" cy="6.6" r=".9" fill="${D}" stroke="none"/>`,
    alert: `<path d="M10 3.5l7.3 12.7H2.7z"/><path d="M10 8.3v3.5"/><circle cx="10" cy="14" r=".9" fill="${D}" stroke="none"/>`,
    error: '<circle cx="10" cy="10" r="7"/><path d="M7.5 7.5l5 5M12.5 7.5l-5 5"/>',
    success: '<circle cx="10" cy="10" r="7"/><path d="M6.8 10.2l2.2 2.2 4.2-4.6"/>',
    help:
      '<circle cx="10" cy="10" r="7"/><path d="M8 8.2a2 2 0 1 1 3 1.7c-.7.4-1 .8-1 1.6"/><circle cx="10" cy="13.7" r=".9" fill="' +
      D +
      '" stroke="none"/>',
    bell: '<path d="M5 14V9a5 5 0 0 1 10 0v5l1.5 1.5h-13z"/><path d="M8.5 17.5h3"/>',
    calendar: '<rect x="3" y="4.5" width="14" height="12.5" rx="2"/><path d="M3 8.5h14M7 3v3M13 3v3"/>',
    clock: '<circle cx="10" cy="10" r="7"/><path d="M10 6v4.2l2.7 1.6"/>',
    star: '<path d="M10 2.8l2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L2.8 8.1l5-.7z"/>',
    bookmark: '<path d="M5.5 3.5h9v13L10 13l-4.5 3.5z"/>',
    home: '<path d="M3 9.5l7-6 7 6M5 8.2V16h3.5v-4h3v4H15V8.2"/>',
    user: '<circle cx="10" cy="7" r="3"/><path d="M4 16.5c.5-3 3-4.5 6-4.5s5.5 1.5 6 4.5"/>',
    lock: '<rect x="4.5" y="9" width="11" height="8" rx="2"/><path d="M7 9V6.5a3 3 0 0 1 6 0V9"/>',
    eye: '<path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10z"/><circle cx="10" cy="10" r="2.4"/>',
    'eye-off': '<path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10z"/><path d="M4 16L16 4"/>',
    sun: '<circle cx="10" cy="10" r="3"/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4"/>',
    moon: '<path d="M16.5 11.5A6.5 6.5 0 0 1 8.5 3.5a6.5 6.5 0 1 0 8 8z"/>',
    palette:
      '<path d="M10 3a7 7 0 1 0 0 14c1 0 1.5-.7 1.5-1.4 0-1-.9-1.3-.9-2.1 0-.8.6-1.2 1.4-1.2H14a3 3 0 0 0 3-3C17 5.7 13.9 3 10 3z"/><g fill="' +
      D +
      '" stroke="none"><circle cx="6.5" cy="9.5" r="1"/><circle cx="9" cy="6.5" r="1"/><circle cx="13" cy="7" r="1"/></g>',
    'chart-bar': '<path d="M4.5 16.5v-6M10 16.5v-13M15.5 16.5v-9"/>',
    'chart-line': '<path d="M3 3.5V17h14M6 13l3.5-3.5 2.5 2.5 4.5-5.5"/>',
    dollar:
      '<path d="M10 2.5v15M13.5 6.2C13 5.2 11.7 4.6 10 4.6c-2 0-3.4 1-3.4 2.5s1.4 2.2 3.4 2.6 3.4 1.1 3.4 2.6-1.4 2.6-3.4 2.6c-1.8 0-3.2-.7-3.7-1.9"/>',
    wallet:
      '<path d="M15.5 6.5V5.2a1.2 1.2 0 0 0-1.5-1.2L5 6a2 2 0 0 0-1.5 2v6.5A2 2 0 0 0 5.5 16.5h10A1.5 1.5 0 0 0 17 15V8a1.5 1.5 0 0 0-1.5-1.5H5"/><circle cx="13.3" cy="11.5" r=".9" fill="' +
      D +
      '" stroke="none"/>',
    case: '<rect x="3" y="6.5" width="14" height="9.5" rx="2"/><path d="M7.5 6.5V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.5M3 11h14"/>',
    cutlery: '<path d="M5 3v4a2 2 0 0 0 4 0V3M7 9v8M14 17V3c-2 1-3 3.5-3 6.5 0 1 .8 1.5 3 1.5"/>',
    bolt: '<path d="M11 2.5L4.5 11.2H10l-1 6.3 6.5-8.7H10z"/>',
    controller:
      '<rect x="2.5" y="6" width="15" height="8.5" rx="4"/><path d="M6.5 10.2h3M8 8.7v3"/><circle cx="13" cy="9.4" r=".8" fill="' +
      D +
      '" stroke="none"/><circle cx="14.8" cy="11.2" r=".8" fill="' +
      D +
      '" stroke="none"/>',
  };
  const ICON_NAMES = Object.keys(PATHS);
  function icon(name: string, options?: { size?: number; label?: string | null }): string {
    const inner = PATHS[name];
    if (!inner) return '';
    const opts = options || {};
    const size = opts.size === 16 || opts.size === 24 ? opts.size : 20;
    const cls = `fl-icon${size === 16 ? ' fl-icon--sm' : size === 24 ? ' fl-icon--lg' : ''}`;
    const a11y = opts.label
      ? ` role="img" aria-label="${String(opts.label).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}"`
      : ' aria-hidden="true" focusable="false"';
    return `<svg class="${cls}" viewBox="0 0 20 20" width="${size}" height="${size}"${a11y}>${inner}</svg>`;
  }
  /* Checklist: keeps the "N of M" counts and the Uncheck all button of one or more .fl-checklist inside root.
     root may be a stable ancestor, so the list can be redrawn: call refresh() afterwards. */
  interface ChecklistOptions {
    noun?: string;
    onChange?: (box: HTMLInputElement) => void;
    onClear?: () => void;
  }
  function checklist(root: HTMLElement, options?: ChecklistOptions) {
    const opts: ChecklistOptions = options || {};
    const noun = opts.noun || 'checked';
    function boxes(scope: ParentNode): HTMLInputElement[] {
      return all<HTMLInputElement>('.fl-checklist__item input[type=checkbox]', scope);
    }
    function refresh(): void {
      const b = boxes(root),
        n = b.length,
        k = b.filter((x) => x.checked).length;
      all('[data-checklist-count]', root).forEach((el) => {
        el.textContent = `${k} of ${n} ${noun}${n && k === n ? '. All done.' : ''}`;
      });
      all('.fl-checklist__group', root).forEach((g) => {
        const gb = boxes(g),
          gk = gb.filter((x) => x.checked).length;
        all('[data-checklist-group-count]', g).forEach((el) => {
          el.textContent = `${gk} of ${gb.length}`;
        });
      });
      const clear = all<HTMLButtonElement>('[data-checklist-clear]', root);
      clear.forEach((c) => {
        c.disabled = !k;
      });
    }
    root.addEventListener('change', (e) => {
      if ((e.target as Element).closest?.('.fl-checklist__item')) {
        refresh();
        if (opts.onChange) opts.onChange(e.target as HTMLInputElement);
      }
    });
    root.addEventListener('click', (e) => {
      if (!(e.target as Element).closest?.('[data-checklist-clear]')) return;
      if (opts.onClear) opts.onClear();
      else
        boxes(root).forEach((x) => {
          if (x.checked) {
            x.checked = false;
            x.dispatchEvent(new Event('change', { bubbles: true }));
          }
        });
      refresh();
    });
    refresh();
    return { refresh: refresh };
  }

  function mountIcons(root?: ParentNode | null): void {
    const els = (root || document).querySelectorAll('[data-fl-icon]');
    for (const el of els) {
      if (el.firstChild) continue;
      el.innerHTML = icon(el.getAttribute('data-fl-icon') ?? '', {
        size: +(el.getAttribute('data-size') ?? '') || 20,
        label: el.getAttribute('data-label'),
      });
    }
  }
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', () => {
      mountIcons();
    });
  else mountIcons();

  /* Combobox (1.3): a text field with a filtered, scrollable list under it (WAI-ARIA combobox with a listbox popup, focus stays in the input).
     opts.options(query) returns [{id, label, sub?}] and is called on every open and keystroke, so the page decides what is on offer (and what to leave out).
     mode 'pick' (default): the list only chooses; picking clears the field and calls opts.onPick(item); Enter never submits the form.
     mode 'suggest': free text is allowed; picking fills the field (and fires input and change) and calls onPick; Enter with nothing highlighted is left alone.
     The list is inserted after the input unless opts.list names an element; give that element class fl-combobox__list--row to span a grid or wrapping row. */
  interface ComboItem {
    id?: string | number;
    label: string;
    sub?: string;
  }
  interface ComboboxOptions {
    mode?: string;
    max?: number;
    list?: HTMLElement | null;
    label?: string;
    options?: (query: string) => ComboItem[] | null | undefined;
    emptyText?: string;
    emptyIdle?: string;
    openOnFocus?: boolean;
    announce?: (item: ComboItem) => string;
    onPick?: (item: ComboItem) => void;
  }
  function combobox(input: HTMLInputElement, options?: ComboboxOptions) {
    const opts: ComboboxOptions = options || {};
    const mode = opts.mode === 'suggest' ? 'suggest' : 'pick';
    const max = opts.max || 100;
    const uid = `fl-cb-${Math.random().toString(36).slice(2, 8)}`;
    let made = false,
      list = (opts.list || null) as HTMLElement;
    if (!list) {
      list = document.createElement('ul');
      input.insertAdjacentElement('afterend', list);
      made = true;
    }
    list.classList.add('fl-combobox__list');
    list.setAttribute('role', 'listbox');
    if (!list.id) list.id = `${uid}-list`;
    if (opts.label) list.setAttribute('aria-label', opts.label);
    list.hidden = true;
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', list.id);
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('spellcheck', 'false');

    let items: ComboItem[] = [],
      active = -1,
      quiet = false;
    function esc(t: unknown): string {
      return String(t == null ? '' : t).replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
      );
    }
    function isOpen(): boolean {
      return !list.hidden;
    }
    function render(): void {
      const all = (opts.options ? opts.options(input.value) : []) || [];
      items = all.slice(0, max);
      if (active >= items.length) active = items.length - 1;
      if (!items.length) {
        if (mode === 'suggest') {
          close();
          return;
        }
        list.innerHTML =
          '<li role="presentation" class="fl-combobox__note">' +
          esc(input.value.trim() ? opts.emptyText || 'No matches.' : opts.emptyIdle || 'Nothing to choose from.') +
          '</li>';
        input.removeAttribute('aria-activedescendant');
        return;
      }
      list.innerHTML =
        items
          .map(
            (it, i) =>
              '<li role="option" id="' +
              uid +
              '-opt-' +
              i +
              '" data-i="' +
              i +
              '" aria-selected="' +
              (i === active ? 'true' : 'false') +
              '">' +
              esc(it.label) +
              (it.sub ? `<small>${esc(it.sub)}</small>` : '') +
              '</li>',
          )
          .join('') +
        (all.length > max
          ? '<li role="presentation" class="fl-combobox__note">Showing the first ' +
            max +
            ' of ' +
            all.length +
            '. Keep typing to narrow the list.</li>'
          : '');
      if (active >= 0) input.setAttribute('aria-activedescendant', `${uid}-opt-${active}`);
      else input.removeAttribute('aria-activedescendant');
    }
    function open(): void {
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      render();
    }
    function close(): void {
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      active = -1;
    }
    function move(step: number): void {
      if (!items.length) return;
      active = active < 0 ? (step > 0 ? 0 : items.length - 1) : (active + step + items.length) % items.length;
      render();
      const el = document.getElementById(`${uid}-opt-${active}`);
      if (el?.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    }
    function pick(it: ComboItem | undefined): void {
      if (!it) return;
      active = -1;
      if (mode === 'suggest') {
        quiet = true;
        input.value = it.label;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        quiet = false;
      } else {
        input.value = '';
      }
      close();
      announce(opts.announce ? opts.announce(it) : `${it.label} selected`);
      if (opts.onPick) opts.onPick(it);
      input.focus();
    }

    function onFocus(): void {
      if (opts.openOnFocus !== false) open();
    }
    function onClick(): void {
      if (!isOpen()) open();
    }
    function onInput(): void {
      if (quiet) return;
      active = -1;
      open();
    }
    function onKey(e: KeyboardEvent): void {
      const o = isOpen();
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!o) open();
        move(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (!o) open();
        move(-1);
      } else if (e.key === 'Enter') {
        if (o && active >= 0 && items[active]) {
          e.preventDefault();
          pick(items[active]);
        } else if (mode === 'pick') {
          e.preventDefault();
          if (o && items.length === 1) pick(items[0]);
        } /* never submit the form from a pick-only field */
      } else if (e.key === 'Escape' && o) {
        e.preventDefault();
        e.stopPropagation();
        close();
      } /* close the list first, not the sheet around it */ else if (e.key === 'Tab') close();
    }
    function onBlur(): void {
      setTimeout(() => {
        if (document.activeElement !== input) close();
      }, 120);
    }
    function onListDown(e: Event): void {
      e.preventDefault();
    } /* keep focus in the input while the list is used */
    function onListClick(e: Event): void {
      const li = (e.target as Element).closest ? (e.target as Element).closest('[role="option"]') : null;
      if (li) pick(items[+(li.getAttribute('data-i') ?? '')]);
    }
    input.addEventListener('focus', onFocus);
    input.addEventListener('click', onClick);
    input.addEventListener('input', onInput);
    input.addEventListener('keydown', onKey);
    input.addEventListener('blur', onBlur);
    list.addEventListener('mousedown', onListDown);
    list.addEventListener('click', onListClick);

    return {
      open: open,
      close: close,
      refresh: () => {
        if (isOpen()) render();
      },
      clear: () => {
        input.value = '';
        close();
      },
      destroy: () => {
        input.removeEventListener('focus', onFocus);
        input.removeEventListener('click', onClick);
        input.removeEventListener('input', onInput);
        input.removeEventListener('keydown', onKey);
        input.removeEventListener('blur', onBlur);
        list.removeEventListener('mousedown', onListDown);
        list.removeEventListener('click', onListClick);
        ['role', 'aria-autocomplete', 'aria-expanded', 'aria-controls', 'aria-activedescendant'].forEach((a) => {
          input.removeAttribute(a);
        });
        if (made && list.parentNode) list.parentNode.removeChild(list);
        else {
          list.hidden = true;
          list.innerHTML = '';
        }
      },
    };
  }

  (window as unknown as { Frostline: object }).Frostline = {
    version: '1.11',
    wakeLock: wakeLock,
    combobox: combobox,
    confirm: confirm,
    status: status,
    themeSwitch: themeSwitch,
    announce: announce,
    tabs: tabs,
    segmented: segmented,
    rating: rating,
    checklist: checklist,
    dialog: dialog,
    toast: toast,
    tooltip: tooltip,
    tip: tip,
    board: board,
    setTheme: setTheme,
    icon: icon,
    icons: { names: ICON_NAMES, mount: mountIcons },
  };
})();
