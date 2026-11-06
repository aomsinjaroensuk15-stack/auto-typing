/*!
 * typing-bot.js — auto-typer payload loaded by the bookmarklet.
 * Prompts once for a target WPM, scrapes the on-page text, finds the input
 * target and types it with humanized timing. Press Esc or the on-screen Stop
 * button to abort. For practice / demos / your own UIs (see README).
 */
(() => {
  'use strict';

  /* ───────── 0. Singleton + the ONE prompt ───────── */
  const UI_ID = '__typingbot_ui';
  if (window.__typingBot) { try { window.__typingBot.stop('relaunched'); } catch (_) {} }

  const raw = window.prompt('Target speed in WPM (5–600):', '80');
  if (raw === null) return;
  const WPM = parseFloat(raw);
  if (!(WPM >= 5 && WPM <= 600)) { window.alert('Please enter a number from 5 to 600.'); return; }
  const I = 12000 / WPM; // ms per keystroke; standard WPM = 5 keystrokes per "word"

  /* ───────── 1. Helpers ───────── */
  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const gauss = () => { // Box–Muller
    let u = 0, v = 0;
    while (!u) u = Math.random();
    while (!v) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  };
  const norm = (s) => s.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

  /* ───────── 2. Text sources ─────────
   * A source exposes next() -> the next character to type (or null) and advance().
   * "Live" adapters are STATELESS: they derive the next char from the page's own
   * progress markers every keystroke, so they self-correct and handle endless
   * word streams (Monkeytype time mode). The generic source snapshots the text. */
  const ADAPTERS = [
    {
      name: 'monkeytype',
      detect: () => !!document.querySelector('#words .word'),
      next() {
        const w = document.querySelector('#words .word.active');
        if (!w) return null;
        for (const l of w.querySelectorAll('letter')) {
          if (l.classList.contains('extra')) continue;
          if (!l.classList.contains('correct') && !l.classList.contains('incorrect')) return l.textContent;
        }
        return w.nextElementSibling ? ' ' : null; // word finished -> space (none after the last word)
      },
      advance() {},
    },
    {
      name: '10fastfingers',
      detect: () => !!document.querySelector('#row1 .highlight, #words .highlight'),
      next() {
        const w = document.querySelector('#row1 .highlight, #words .highlight');
        if (!w) return null;
        const word = w.textContent.trim();
        const typed = (document.querySelector('#inputfield') || {}).value || '';
        return typed.length < word.length ? word[typed.length] : ' ';
      },
      advance() {},
    },
  ];

  // Selectors whose concatenated textContent is the full prompt (TypeRacer splits it into 3 spans).
  const HINTS = ['.inputPanel span[unselectable="on"]'];

  // Turn a container of many fragments (span per char OR per word) back into plain text.
  function fragmentsToText(el) {
    const kids = [...el.children].filter((k) => k.textContent.length);
    const wordish = kids.filter((k) => /\S{2,}/.test(k.textContent) && !/\s/.test(k.textContent.trim())).length;
    // span-per-word with no whitespace between nodes -> join with spaces; span-per-char -> textContent keeps spaces
    return norm(wordish > kids.length * 0.6 ? kids.map((k) => k.textContent.trim()).join(' ') : el.textContent);
  }

  function scrapeGenericText() {
    // (a) site-specific hints
    for (const sel of HINTS) {
      const els = [...document.querySelectorAll(sel)];
      if (els.length) { const t = norm(els.map((e) => e.textContent).join('')); if (t.length > 10) return t; }
    }
    // (b) heuristic: visible container made of many short leaf fragments (char/word spans)
    let best = null, bestScore = 0;
    for (const el of document.body.querySelectorAll('*')) {
      if (/^(SCRIPT|STYLE|NOSCRIPT|SVG|CANVAS|SELECT|OPTION)$/i.test(el.tagName)) continue;
      const kids = el.children;
      if (kids.length < 8) continue;
      let leafy = 0;
      for (const k of kids) if (k.children.length <= 1 && k.textContent.length <= 24) leafy++;
      if (leafy < kids.length * 0.7 || !visible(el)) continue;
      const text = fragmentsToText(el);
      if (text.length < 25) continue;
      const r = el.getBoundingClientRect();
      let score = text.length * (r.bottom > 0 && r.top < innerHeight ? 1 : 0.3);
      if (el.querySelector('input,textarea,button,select,a')) score *= 0.4;
      if (score > bestScore) { bestScore = score; best = text; }
    }
    if (best) return best;
    // (c) plain-text prompt: largest visible block of prose that isn't a field
    let blk = null, len = 0;
    for (const el of document.body.querySelectorAll('p,div,span,pre,blockquote')) {
      if (el.children.length > 3 || el.closest('input,textarea,nav,header,footer')) continue;
      const t = norm(el.textContent);
      if (t.length > Math.max(40, len) && t.length < 3000 && visible(el)) { blk = t; len = t.length; }
    }
    return blk;
  }

  function makeGenericSource() {
    let text = scrapeGenericText();
    if (!text) return null;
    let idx = 0;
    return {
      name: 'generic',
      next() {
        if (idx < text.length) return text[idx];
        // exhausted: look for freshly revealed text (scrolling / next row) once
        const fresh = scrapeGenericText();
        if (fresh && fresh !== text) {
          const p = fresh.indexOf(text);
          const tail = p >= 0 ? fresh.slice(p + text.length).trim() : fresh;
          if (tail) { text = ' ' + tail; idx = 0; return text[0]; }
        }
        return null;
      },
      advance() { idx++; },
    };
  }

  function pickSource() {
    for (const a of ADAPTERS) { try { if (a.detect() && a.next() !== null) return a; } catch (_) {} }
    return makeGenericSource();
  }

  /* ───────── 3. Input targeting ───────── */
  const FIELD_SEL = 'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]),textarea,[contenteditable=""],[contenteditable="true"],[role=textbox]';
  const isTextField = (el) => el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLInputElement && !/^(checkbox|radio|button|submit|file|range|color)$/.test(el.type));

  function resolveTarget() {
    const ok = (e) => !e.disabled && !e.readOnly && !e.closest('#' + UI_ID);
    const ae = document.activeElement;
    if (ae && ae !== document.body && ae.matches && ae.matches(FIELD_SEL) && ok(ae)) return ae;
    const c = [...document.querySelectorAll(FIELD_SEL)].filter(ok);
    const known = c.find((e) => /wordsInput|txtInput|inputfield|typing|type-here|input-field/i
      .test(e.id + ' ' + e.className + ' ' + (e.name || '') + ' ' + (e.placeholder || '')));
    // Off-screen hidden inputs are legitimate targets (canvas / hidden-input UIs), so fall back to any field.
    // No field at all -> window/body key listeners: events bubble up from the focused element or body.
    return known || c.find(visible) || c[0] || document.activeElement || document.body;
  }
  const focusIt = (el) => {
    if (el && el !== document.body && document.activeElement !== el && el.focus) el.focus({ preventScroll: true });
  };

  /* ───────── 4. Event synthesis ───────── */
  const SHIFT_DIGITS = ')!@#$%^&*(';
  const PUNCT = { ';': ['Semicolon', 186], '=': ['Equal', 187], ',': ['Comma', 188], '-': ['Minus', 189], '.': ['Period', 190],
    '/': ['Slash', 191], '`': ['Backquote', 192], '[': ['BracketLeft', 219], '\\': ['Backslash', 220], ']': ['BracketRight', 221], "'": ['Quote', 222] };
  const SHIFTED = { ':': ';', '+': '=', '<': ',', '_': '-', '>': '.', '?': '/', '~': '`', '{': '[', '|': '\\', '}': ']', '"': "'" };

  function keyInfo(ch) {
    if (ch === ' ') return { code: 'Space', kc: 32, shift: false };
    if (/[a-z]/i.test(ch)) { const u = ch.toUpperCase(); return { code: 'Key' + u, kc: u.charCodeAt(0), shift: ch !== ch.toLowerCase() }; }
    if (/[0-9]/.test(ch)) return { code: 'Digit' + ch, kc: ch.charCodeAt(0), shift: false };
    const si = SHIFT_DIGITS.indexOf(ch);
    if (si >= 0) return { code: 'Digit' + si, kc: 48 + si, shift: true };
    if (PUNCT[ch]) return { code: PUNCT[ch][0], kc: PUNCT[ch][1], shift: false };
    if (SHIFTED[ch]) { const p = PUNCT[SHIFTED[ch]]; return { code: p[0], kc: p[1], shift: true }; }
    return { code: '', kc: ch.charCodeAt(0), shift: false }; // non-US-layout char: `key` value only
  }

  function kev(type, ch, info) {
    const e = new KeyboardEvent(type, {
      key: ch, code: info.code, shiftKey: info.shift, bubbles: true, cancelable: true, composed: true, view: window,
      charCode: type === 'keypress' ? ch.charCodeAt(0) : 0, keyCode: info.kc, which: info.kc,
    });
    // Legacy fields are read-only on some engines; sites (and old frameworks) still read them.
    for (const [k, v] of [['keyCode', info.kc], ['which', info.kc]]) {
      if (e[k] !== v) Object.defineProperty(e, k, { get: () => v });
    }
    return e;
  }

  // Native value setter bypasses React/Vue value-tracking so the framework sees a real change on `input`.
  function insertIntoField(el, ch) {
    const veto = !el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: ch, bubbles: true, cancelable: true, composed: true }));
    if (veto) return;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    const v = el.value;
    let s = v.length, e = v.length;
    try { if (el.selectionStart != null) { s = el.selectionStart; e = el.selectionEnd; } } catch (_) {}
    setter.call(el, v.slice(0, s) + ch + v.slice(e));
    try { el.setSelectionRange(s + ch.length, s + ch.length); } catch (_) {}
    el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: ch, bubbles: true, composed: true }));
  }

  function insertIntoEditable(el, ch) {
    const sel = getSelection();
    if (!sel.rangeCount || !el.contains(sel.anchorNode)) {
      const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
      sel.removeAllRanges(); sel.addRange(r);
    }
    if (!document.execCommand('insertText', false, ch)) { // standard editor path; manual fallback below
      el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: ch, bubbles: true, cancelable: true, composed: true }));
      const r = sel.getRangeAt(0); r.deleteContents(); r.insertNode(document.createTextNode(ch)); r.collapse(false);
      el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: ch, bubbles: true, composed: true }));
    }
  }

  // Same order a browser uses; honour preventDefault like a real keystroke would.
  function typeChar(el, ch) {
    const info = keyInfo(ch);
    let go = el.dispatchEvent(kev('keydown', ch, info));
    if (go) go = el.dispatchEvent(kev('keypress', ch, info));
    if (go) {
      if (isTextField(el)) insertIntoField(el, ch);
      else if (el.isContentEditable) insertIntoEditable(el, ch);
    }
    el.dispatchEvent(kev('keyup', ch, info));
  }

  /* ───────── 5. Overlay UI (Stop button works on mobile too) ───────── */
  function makeUI() {
    const host = document.createElement('div');
    host.id = UI_ID;
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:12px;bottom:12px;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = '<style>.b{font:13px/1.3 system-ui,sans-serif;background:rgba(17,17,17,.85);color:#fff;padding:8px 10px;' +
      'border-radius:10px;display:flex;gap:10px;align-items:center}button{font:inherit;border:0;border-radius:6px;padding:4px 10px;' +
      'background:#e5484d;color:#fff}</style><div class="b"><span id="s"></span><button id="x">Stop</button></div>';
    document.documentElement.appendChild(host);
    const s = root.getElementById ? root.getElementById('s') : root.querySelector('#s');
    root.querySelector('#x').addEventListener('click', () => stop('button'));
    return { set: (t) => { s.textContent = t; }, remove: () => host.remove() };
  }

  /* ───────── 6. Engine: humanized scheduling ─────────
   * Keystroke i is aimed at the fixed grid t0 + i*I (so the long-run speed is exactly WPM),
   * displaced by a mean-reverting random offset (AR(1) "rhythm" noise) plus small bumps after
   * spaces/punctuation and rare hesitations at word starts. Displacements never accumulate,
   * and a minimum inter-key gap keeps post-pause bursts plausible. */
  let stopped = false;
  const ui = makeUI();
  let sent = 0, startedAt = 0;
  const tick = setInterval(() => {
    if (stopped || sent < 5) return;
    const live = (sent / 5) / ((performance.now() - startedAt) / 60000);
    ui.set(live.toFixed(0) + ' / ' + WPM + ' WPM · ' + sent + ' keys');
  }, 250);
  const onKey = (e) => { if (e.isTrusted && e.key === 'Escape') stop('Esc'); };
  window.addEventListener('keydown', onKey, true);

  function stop(why) {
    if (stopped) return;
    stopped = true;
    clearInterval(tick);
    window.removeEventListener('keydown', onKey, true);
    ui.set(why ? 'Stopped (' + why + ')' : 'Stopped');
    setTimeout(ui.remove, 4000);
  }
  window.__typingBot = { stop };

  (async () => {
    const src = pickSource();
    if (!src) { stop('no text found'); window.alert('Typing Bot: could not find the typing text on this page.'); return; }
    let target = resolveTarget();
    ui.set('Starting ' + WPM + ' WPM · ' + src.name);
    focusIt(target);
    await sleep(900);

    let t0 = performance.now(), i = 0, last = 0, offset = 0, idle = 0, prev = '';
    while (!stopped) {
      const ch = src.next();
      if (ch == null) { // nothing to type: wait briefly for the page to reveal more, else we're done
        idle += 80;
        if (idle > 2500) { stop('finished'); break; }
        await sleep(80);
        continue;
      }
      idle = 0;

      offset = clamp(0.8 * offset + gauss() * 0.28 * I, -0.6 * I, 2.5 * I);
      let bump = 0;
      if (ch === ' ') bump += 0.25 * I; else if (/[.,;:!?]/.test(ch)) bump += 0.2 * I;
      if (prev === ' ' && Math.random() < 0.012) bump += I * (2 + Math.random() * 3); // brief hesitation
      let due = Math.max(t0 + i * I + offset + bump, last + Math.max(6, 0.25 * I));
      const now = performance.now();
      if (now - due > 3 * I) { t0 += now - due; due = now; } // page lagged: re-anchor instead of bursting
      await sleep(due - now);
      if (stopped) break;

      if (!target || !target.isConnected) target = resolveTarget(); // framework re-rendered the input
      focusIt(target);
      typeChar(target, ch);
      src.advance();
      prev = ch; i++; sent++; last = performance.now();
      if (sent === 1) startedAt = last;
      await sleep(0); // let the framework flush before we read the DOM again
    }
  })();
})();
