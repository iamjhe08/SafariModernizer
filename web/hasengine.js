// Fast :has() support for Safari 15.1.
// The CSS rewriter turns  A:has(B) C {…}  into  .js-has-pseudo [csstools-has-<A:has(B) encoded>] C {…}.
// This engine finds every encoded selector in the page's styles and keeps the
// matching elements tagged with that attribute.
//
// It works backwards: for :has(B) it finds the B elements with one native
// lookup, then marks their ancestors (or parent / previous siblings for
// > + ~). Attributes only change when a result changes, its own changes are
// ignored, and it re-checks after the page settles instead of every frame.
// It also makes querySelector(All)/matches/closest accept :has() for scripts.

import { timed } from './safety.js';
import { smlog } from './debug.js';

const PREFIX = 'csstools-has-';
const decode = (name) => {
  if (name.slice(0, PREFIX.length) !== PREFIX) return '';
  return name.slice(PREFIX.length).split('-').map((p) => String.fromCharCode(parseInt(p, 36))).join('');
};

// Split a selector list at top-level commas
function splitList(s) {
  const out = []; let depth = 0, last = 0, q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === '\\') i++;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) { out.push(s.slice(last, i).trim()); last = i + 1; }
  }
  out.push(s.slice(last).trim());
  return out.filter(Boolean);
}

// Find ":has(" groups at any depth; returns [{start, end, inner}]
function findHas(sel) {
  const res = [];
  const re = /:has\(/gi;
  let m;
  while ((m = re.exec(sel))) {
    let depth = 1, i = m.index + 5, q = null;
    for (; i < sel.length; i++) {
      const c = sel[i];
      if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'") q = c;
      else if (c === '\\') i++;
      else if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) break; }
    }
    res.push({ start: m.index, end: i + 1, inner: sel.slice(m.index + 5, i) });
    re.lastIndex = i + 1;
  }
  return res;
}

export function startHasEngine() {
  const doc = document;
  const nativeQSA = Element.prototype.querySelectorAll;
  const nativeDocQSA = Document.prototype.querySelectorAll;
  const nativeQS = Element.prototype.querySelector;
  const nativeDocQS = Document.prototype.querySelector;
  const nativeMatches = Element.prototype.matches;
  const nativeClosest = Element.prototype.closest;

  let supported = false;
  try { nativeDocQS.call(doc, ':has(*)'); supported = true; } catch (e) {}
  if (supported) return;

  const markerFor = new Map();   // has-argument text -> marker attribute
  const markerSets = new Map();  // marker -> Set of elements currently marked
  let markerN = 0;
  let gen = 0;                   // bumps each pass; one computation per argument per pass
  const markerGen = new Map();

  const qsaDoc = (sel) => { try { return nativeDocQSA.call(doc, sel); } catch (e) { return []; } };

  // Elements that match ":has(arg)", computed from the inside out
  function hasMatches(arg) {
    const out = new Set();
    splitList(arg).forEach((rel) => {
      rel = rel.trim();
      let comb = ' ';
      if (rel[0] === '>' || rel[0] === '+' || rel[0] === '~') { comb = rel[0]; rel = rel.slice(1).trim(); }
      const inner = toNative(rel);
      if (!inner) return;
      const found = qsaDoc(inner);
      for (let k = 0; k < found.length; k++) {
        const el = found[k];
        if (comb === ' ') {
          for (let p = el.parentElement; p; p = p.parentElement) { if (out.has(p)) break; out.add(p); }
        } else if (comb === '>') {
          // ">.a .b": the parent of the top-most ".a" link in the chain
          const first = rel.split(/\s+|>|\+|~/).filter(Boolean)[0];
          let top = el;
          if (first && first !== rel) {
            for (let p = el.parentElement; p; p = p.parentElement) {
              if (safeMatches(p, first)) top = p;
            }
          }
          if (top.parentElement) out.add(top.parentElement);
        } else if (comb === '+') {
          if (el.previousElementSibling) out.add(el.previousElementSibling);
        } else {
          for (let s = el.previousElementSibling; s; s = s.previousElementSibling) out.add(s);
        }
      }
    });
    return out;
  }

  const safeMatches = (el, sel) => { try { return nativeMatches.call(el, sel); } catch (e) { return false; } };

  // Replace every :has(...) in a selector with a marker attribute (kept up to date)
  function toNative(sel) {
    const groups = findHas(sel);
    if (!groups.length) return sel;
    let out = '', last = 0;
    for (const g of groups) {
      const marker = updateMarker(g.inner);
      out += sel.slice(last, g.start) + '[' + marker + ']';
      last = g.end;
    }
    return out + sel.slice(last);
  }

  function updateMarker(arg) {
    let marker = markerFor.get(arg);
    if (!marker) { marker = 'smh-' + (markerN++); markerFor.set(arg, marker); markerSets.set(marker, new Set()); }
    if (markerGen.get(marker) === gen) return marker;
    markerGen.set(marker, gen);
    const now = hasMatches(arg);
    const prev = markerSets.get(marker);
    prev.forEach((el) => { if (!now.has(el)) el.removeAttribute(marker); });
    now.forEach((el) => { if (!prev.has(el)) el.setAttribute(marker, ''); });
    markerSets.set(marker, now);
    return marker;
  }

  // ---------- keep CSS-encoded selectors applied ----------
  const tracked = new Map();     // attribute name -> {selector, nodes:Set}
  let styleSig = '';

  function collectSelectors() {
    const styles = doc.querySelectorAll('style');
    let sig = '';
    const names = new Set();
    for (let i = 0; i < styles.length; i++) {
      const t = styles[i].textContent;
      if (t.indexOf(PREFIX) === -1) continue;
      sig += t.length + ',';
      const found = t.match(/csstools-has-[0-9a-z-]+/g);
      if (found) found.forEach((n) => names.add(n));
    }
    if (sig === styleSig) return;
    styleSig = sig;
    names.forEach((n) => {
      if (tracked.has(n)) return;
      const sel = decode(n);
      if (sel) tracked.set(n, { selector: sel, nodes: new Set() });
    });
  }

  let running = false;
  function refresh() {
    running = true;
    gen++;
    try {
      collectSelectors();
      if (tracked.size) doc.documentElement.classList.add('js-has-pseudo');
      tracked.forEach((t, attr) => {
        const sel = toNative(t.selector);
        const now = new Set(qsaDoc(sel));
        t.nodes.forEach((el) => { if (!now.has(el)) el.removeAttribute(attr); });
        now.forEach((el) => { if (!t.nodes.has(el)) el.setAttribute(attr, ''); });
        t.nodes = now;
      });
    } finally {
      // let our own attribute mutations flush before listening again
      setTimeout(() => { running = false; }, 0);
    }
  }

  // Space passes out by how long they take: a pass may use at most ~10% of
  // the time, so a busy page can never be swamped. Very slow pages stop.
  let timer = 0, lastRun = 0, lastCost = 0, slowStreak = 0, stopped = false;
  function schedule() {
    if (timer || stopped) return;
    const gap = Math.max(250, lastCost * 10);
    const wait = Math.max(60, gap - (Date.now() - lastRun));
    timer = setTimeout(() => {
      timer = 0; lastRun = Date.now();
      timed(':has() update (' + tracked.size + ' rules)', refresh);
      lastCost = Date.now() - lastRun;
      if (lastCost > 400) {
        if (++slowStreak >= 3) { stopped = true; smlog(':has() support paused on this page: updates took ' + lastCost + ' ms'); }
      } else slowStreak = 0;
    }, wait);
  }

  const mo = new MutationObserver((muts) => {
    if (running) return;
    for (let i = 0; i < muts.length; i++) {
      const m = muts[i];
      if (m.type === 'attributes') {
        const a = m.attributeName || '';
        if (a.indexOf('smh-') === 0 || a.indexOf(PREFIX) === 0 || a === 'style') continue;
      }
      schedule();
      return;
    }
  });
  const start = () => {
    lastRun = Date.now();
    timed(':has() first pass', refresh);
    lastCost = Date.now() - lastRun;
    mo.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, characterData: false });
  };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start); else start();
  window.addEventListener('load', schedule);
  ['focusin', 'focusout', 'input', 'change'].forEach((ev) => doc.addEventListener(ev, schedule, true));

  // ---------- :has() in script selectors ----------
  const wrap = (fn, scopeDoc) => function (sel) {
    if (typeof sel === 'string' && sel.indexOf(':has(') !== -1) {
      running = true;
      gen++;
      try { return fn.call(this, toNative(sel)); }
      finally { setTimeout(() => { running = false; }, 0); }
    }
    return fn.apply(this, arguments);
  };
  Element.prototype.querySelectorAll = wrap(nativeQSA);
  Element.prototype.querySelector = wrap(nativeQS);
  Document.prototype.querySelectorAll = wrap(nativeDocQSA);
  Document.prototype.querySelector = wrap(nativeDocQS);
  Element.prototype.matches = wrap(nativeMatches);
  Element.prototype.closest = wrap(nativeClosest);
  if (window.DocumentFragment) {
    const fq = DocumentFragment.prototype.querySelectorAll, fq1 = DocumentFragment.prototype.querySelector;
    DocumentFragment.prototype.querySelectorAll = wrap(fq);
    DocumentFragment.prototype.querySelector = wrap(fq1);
  }
}
