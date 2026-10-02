// CSS anchor positioning (Safari 26): place a menu or popup next to another
// element (its "anchor") with anchor-name / position-anchor / position-area /
// anchor() / anchor-size(). ChatGPT uses it for its menus and the composer's
// suggestion list. Safari 15 ignores all of it, so popups land in the wrong
// place or on top of other things.
//
// The CSS rewriter collects every rule that uses these properties. This file
// finds the elements those rules match, works out where each popup should go
// and sets plain top/left/width values on it. It re-checks when the page
// changes, scrolls or resizes.
import { smlog } from './debug.js';

const rules = [];           // {sel, media, prop, value, imp, spec, order, owner}
let order = 0;
let started = false;
const managed = new Set();  // elements we have written styles on
const written = new WeakMap(); // element -> {prop: value we set}
let scheduled = false;
let logged = false;

const supported = () => { try { return CSS.supports('anchor-name: --a'); } catch (e) { return false; } };

// Rough selector specificity, enough to pick the winning rule
function specificity(sel) {
  const s = sel.replace(/\[[^\]]*\]/g, '.a').replace(/"[^"]*"|'[^']*'/g, '');
  const ids = (s.match(/#[\w-]+/g) || []).length;
  const cls = (s.match(/\.[\w-]+|:(?!:)[\w-]+/g) || []).length;
  const types = (s.replace(/[#.:][\w-]+/g, '').match(/(^|[\s>+~(])[a-z][\w-]*/gi) || []).length;
  return ids * 10000 + cls * 100 + types;
}

// Split "a, b" at top-level commas
function splitList(sel) {
  const out = []; let depth = 0, cur = '';
  for (const ch of sel) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function addAnchorRules(list, owner) {
  if (!list || !list.length || supported()) return;
  list.forEach((r) => {
    splitList(r[0]).forEach((sel) => {
      if (sel.indexOf('::') !== -1) return;   // pseudo-elements can't be positioned from script
      rules.push({ sel, media: r[1] || [], prop: r[2], value: r[3], imp: r[4] ? 1 : 0, spec: specificity(sel), order: order++, owner });
    });
  });
  if (!started) start();
  schedule();
}

export function removeAnchorRules(owner) {
  let changed = false;
  for (let i = rules.length - 1; i >= 0; i--) if (rules[i].owner === owner) { rules.splice(i, 1); changed = true; }
  if (changed) schedule();
}

const mediaOK = (m) => { try { return m.every((q) => matchMedia(q).matches); } catch (e) { return true; } };

function qsa(rule) {
  if (rule.bad) return [];
  try { return document.querySelectorAll(rule.sel); } catch (e) { rule.bad = true; return []; }
}

// ---------- values ----------

// Replace var(--x, fallback) with the element's value
function resolveVars(v, cs, depth) {
  if (v.indexOf('var(') === -1 || (depth || 0) > 8) return v;
  let out = '', i = 0;
  while (i < v.length) {
    const j = v.indexOf('var(', i);
    if (j === -1) { out += v.slice(i); break; }
    out += v.slice(i, j);
    let k = j + 4, d = 1;
    while (k < v.length && d) { if (v[k] === '(') d++; else if (v[k] === ')') d--; k++; }
    const inner = v.slice(j + 4, k - 1);
    const c = inner.indexOf(',');
    const name = (c === -1 ? inner : inner.slice(0, c)).trim();
    let val = cs.getPropertyValue(name).trim();
    if (!val && c !== -1) val = inner.slice(c + 1).trim();
    out += resolveVars(val, cs, (depth || 0) + 1);
    i = k;
  }
  return out;
}

// Replace each name(args) call in a value using fn(args) -> string
function replaceCalls(v, name, fn) {
  let out = '', i = 0;
  const re = new RegExp('(^|[^\\w-])' + name + '\\(', 'g');
  let m;
  while ((m = re.exec(v))) {
    const start = m.index + m[1].length;
    let k = start + name.length + 1, d = 1;
    while (k < v.length && d) { if (v[k] === '(') d++; else if (v[k] === ')') d--; k++; }
    out += v.slice(i, start) + fn(v.slice(start + name.length + 1, k - 1));
    i = k; re.lastIndex = k;
  }
  return out + v.slice(i);
}

const AXIS = {
  top: 'y', bottom: 'y', 'inset-block-start': 'y', 'inset-block-end': 'y',
  left: 'x', right: 'x', 'inset-inline-start': 'x', 'inset-inline-end': 'x',
};
const PHYS = { 'inset-block-start': 'top', 'inset-block-end': 'bottom', 'inset-inline-start': 'left', 'inset-inline-end': 'right' };
const isEndProp = (p) => p === 'bottom' || p === 'right';

// The coordinate (viewport px) of an anchor side along an axis
function sideCoord(A, axis, side, prop) {
  const lo = axis === 'y' ? A.top : A.left, hi = axis === 'y' ? A.bottom : A.right;
  side = side.trim().toLowerCase();
  if (/%$/.test(side)) return lo + (hi - lo) * parseFloat(side) / 100;
  switch (side) {
    case 'top': case 'left': case 'start': case 'self-start': return lo;
    case 'bottom': case 'right': case 'end': case 'self-end': return hi;
    case 'center': return (lo + hi) / 2;
    case 'inside': return isEndProp(prop) ? hi : lo;
    case 'outside': return isEndProp(prop) ? lo : hi;
  }
  return NaN;
}

// ---------- layout ----------

function containingBlock(el, cs) {
  const de = document.documentElement;
  if (cs.position === 'fixed') return { ox: 0, oy: 0, w: de.clientWidth, h: de.clientHeight };
  let op = el.offsetParent;
  if (!op || op === document.body && getComputedStyle(op).position === 'static') {
    return { ox: -window.scrollX, oy: -window.scrollY, w: de.clientWidth, h: de.clientHeight };
  }
  const r = op.getBoundingClientRect();
  return { ox: r.left + op.clientLeft - op.scrollLeft, oy: r.top + op.clientTop - op.scrollTop, w: op.clientWidth, h: op.clientHeight };
}

const V = ['top', 'center', 'bottom'], H = ['left', 'center', 'right'];
// Which tracks (0 = before the anchor, 1 = the anchor, 2 = after) a keyword covers
function tracks(word, axis) {
  const w = word.replace(/^self-/, '').replace(/^(block|inline|x|y)-/, '').replace(/^span-(block|inline|x|y)-/, 'span-');
  switch (w) {
    case 'top': case 'left': case 'start': return [0];
    case 'bottom': case 'right': case 'end': return [2];
    case 'center': return [1];
    case 'span-top': case 'span-left': case 'span-start': return [0, 1];
    case 'span-bottom': case 'span-right': case 'span-end': return [1, 2];
    case 'span-all': return [0, 1, 2];
  }
  return null;
}
const axisOf = (word) => {
  if (/top|bottom|(^|-)block|(^|-)y-/.test(word)) return 'y';
  if (/left|right|(^|-)inline|(^|-)x-/.test(word)) return 'x';
  return null;
};

function parseArea(v) {
  const words = v.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length || words[0] === 'none') return null;
  let y = null, x = null;
  if (words.length === 1) {
    const a = axisOf(words[0]), t = tracks(words[0]);
    if (!t) return null;
    if (a === 'y') { y = t; x = [0, 1, 2]; }
    else if (a === 'x') { x = t; y = [0, 1, 2]; }
    else { y = t; x = t; }
  } else {
    const a0 = axisOf(words[0]), a1 = axisOf(words[1]);
    const t0 = tracks(words[0]), t1 = tracks(words[1]);
    if (!t0 || !t1) return null;
    if (a0 === 'x' || a1 === 'y') { x = t0; y = t1; } else { y = t0; x = t1; }
  }
  return { y, x };
}

// Alignment inside the area: toward the anchor
const alignFor = (t) => (t.length === 1 ? (t[0] === 0 ? 'end' : t[0] === 2 ? 'start' : 'center') :
  t.length === 3 ? 'center' : t[0] === 0 ? 'end' : 'start');

function flipTracks(t) { return t.map((i) => 2 - i).sort(); }

// Swap top/bottom (block) or left/right (inline) in a declaration set
function flipDecls(d, block, inline) {
  const out = {};
  const swapProp = (p) => {
    if (block) { if (p === 'top') return 'bottom'; if (p === 'bottom') return 'top'; if (p === 'inset-block-start') return 'inset-block-end'; if (p === 'inset-block-end') return 'inset-block-start'; if (p === 'margin-top') return 'margin-bottom'; if (p === 'margin-bottom') return 'margin-top'; }
    if (inline) { if (p === 'left') return 'right'; if (p === 'right') return 'left'; if (p === 'inset-inline-start') return 'inset-inline-end'; if (p === 'inset-inline-end') return 'inset-inline-start'; }
    return p;
  };
  const swapSide = (v) => v.replace(/\b(top|bottom|left|right|start|end)\b/g, (s) => {
    if (block && (s === 'top' || s === 'bottom')) return s === 'top' ? 'bottom' : 'top';
    if (inline && (s === 'left' || s === 'right')) return s === 'left' ? 'right' : 'left';
    return s;
  });
  for (const p in d) {
    let v = d[p];
    if (p === 'position-area') {
      const a = parseArea(v);
      if (a) { out[p] = { area: { y: block ? flipTracks(a.y) : a.y, x: inline ? flipTracks(a.x) : a.x } }; continue; }
    }
    out[swapProp(p)] = typeof v === 'string' && v.indexOf('anchor(') !== -1 ? swapSide(v) : v;
  }
  return out;
}

const SET_PROPS = ['top', 'left', 'right', 'bottom', 'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height'];

function write(el, styles) {
  const prev = written.get(el) || {};
  let changed = false;
  for (const p of SET_PROPS) {
    const v = styles[p];
    if (v == null) { if (prev[p] != null) { el.style.removeProperty(p); changed = true; } continue; }
    if (prev[p] !== v) { el.style.setProperty(p, v); changed = true; }
  }
  if (changed || !written.has(el)) written.set(el, Object.assign({}, styles));
  managed.add(el);
  el.__smAnchorStyle = el.getAttribute('style');
}

function clear(el) {
  const prev = written.get(el);
  if (prev) for (const p in prev) el.style.removeProperty(p);
  written.delete(el);
  managed.delete(el);
  el.__smAnchorStyle = el.getAttribute('style');
}

// Work out the styles for one placement attempt
function compute(el, cs, d, names, anchorEl) {
  const cb = containingBlock(el, cs);
  const styles = {};
  const anchorRect = (name) => {
    const a = name ? names.get(name) : anchorEl;
    if (!a || !a.isConnected) return null;
    const r = a.getBoundingClientRect();
    return r.width || r.height ? r : null;
  };
  const A = anchorRect(null);

  // Sizes first: anchor-size(width) etc.
  for (const p of ['width', 'height', 'min-width', 'max-width', 'min-height', 'max-height']) {
    const v = d[p];
    if (typeof v !== 'string' || v.indexOf('anchor-size(') === -1) continue;
    let ok = true;
    styles[p] = replaceCalls(v, 'anchor-size', (args) => {
      const parts = args.split(',');
      const words = parts[0].trim().split(/\s+/);
      const name = words.find((w) => w.startsWith('--'));
      const dim = (words.find((w) => !w.startsWith('--')) || (/height/.test(p) ? 'height' : 'width')).toLowerCase();
      const r = anchorRect(name);
      if (!r) { if (parts[1]) return parts.slice(1).join(',').trim(); ok = false; return '0px'; }
      const val = /height|block|^h$/.test(dim) ? r.height : r.width;
      return val.toFixed(2) + 'px';
    });
    if (!ok) delete styles[p];
  }

  // Insets that use anchor()
  let usedInset = false;
  for (const p0 in d) {
    const axis = AXIS[p0];
    if (!axis || typeof d[p0] !== 'string' || d[p0].indexOf('anchor(') === -1) continue;
    const p = PHYS[p0] || p0;
    let ok = true;
    const val = replaceCalls(d[p0], 'anchor', (args) => {
      const parts = args.split(',');
      const words = parts[0].trim().split(/\s+/);
      const name = words.find((w) => w.startsWith('--'));
      const side = words.find((w) => !w.startsWith('--')) || 'center';
      const r = anchorRect(name);
      if (!r) { if (parts[1]) return parts.slice(1).join(',').trim(); ok = false; return '0px'; }
      const c = sideCoord(r, axis, side, p);
      if (isNaN(c)) { ok = false; return '0px'; }
      let px;
      if (p === 'top') px = c - cb.oy;
      else if (p === 'left') px = c - cb.ox;
      else if (p === 'bottom') px = cb.oy + cb.h - c;
      else px = cb.ox + cb.w - c;
      return px.toFixed(2) + 'px';
    });
    if (ok) { styles[p] = /^-?[\d.]+px$/.test(val) ? val : 'calc(' + val + ')'; usedInset = true; }
  }

  // position-area: place in a cell of the 3x3 grid around the anchor
  const pa = d['position-area'];
  const area = pa && (pa.area || (typeof pa === 'string' ? parseArea(pa) : null));
  if (area && A) {
    for (const p in styles) if (AXIS[p]) delete styles[p];
    const ys = [cb.oy, A.top, A.bottom, cb.oy + cb.h];
    const xs = [cb.ox, A.left, A.right, cb.ox + cb.w];
    const aTop = ys[area.y[0]], aBot = ys[area.y[area.y.length - 1] + 1];
    const aL = xs[area.x[0]], aR = xs[area.x[area.x.length - 1] + 1];
    // measure with the size it will have
    for (const p of ['width', 'height']) if (styles[p]) el.style.setProperty(p, styles[p]);
    const mt = parseFloat(cs.marginTop) || 0, mb = parseFloat(cs.marginBottom) || 0;
    const ml = parseFloat(cs.marginLeft) || 0, mr = parseFloat(cs.marginRight) || 0;
    const w = el.offsetWidth, h = el.offsetHeight;
    const ay = alignFor(area.y), ax = alignFor(area.x);
    let top, left;
    if (ay === 'start') top = aTop;
    else if (ay === 'end') top = aBot - h - mt - mb;
    else top = (area.y.length === 1 ? (A.top + A.bottom) / 2 : (aTop + aBot) / 2) - (h + mt + mb) / 2;
    if (ax === 'start') left = aL;
    else if (ax === 'end') left = aR - w - ml - mr;
    else left = (area.x.length === 1 ? (A.left + A.right) / 2 : (aL + aR) / 2) - (w + ml + mr) / 2;
    styles.top = (top - cb.oy).toFixed(2) + 'px';
    styles.left = (left - cb.ox).toFixed(2) + 'px';
    styles.bottom = 'auto';
    styles.right = 'auto';
    usedInset = true;
  }
  return usedInset || Object.keys(styles).length ? { styles, cb } : null;
}

// How far the element sticks out of its containing block (px)
function overflow(el, cb) {
  const r = el.getBoundingClientRect();
  return Math.max(0, cb.oy - r.top) + Math.max(0, r.bottom - (cb.oy + cb.h)) +
    Math.max(0, cb.ox - r.left) + Math.max(0, r.right - (cb.ox + cb.w));
}

function implicitAnchor(el) {
  if (!el.id) return null;
  try {
    const id = CSS.escape(el.id);
    return document.querySelector('[popovertarget="' + id + '"],[commandfor="' + id + '"],[anchor="' + id + '"]');
  } catch (e) { return null; }
}

function update() {
  scheduled = false;
  const names = new Map();
  const per = new Map();
  for (const r of rules) {
    if (r.media.length && !mediaOK(r.media)) continue;
    const els = qsa(r);
    if (r.prop === 'anchor-name') {
      for (const el of els) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none') continue;
        resolveVars(r.value, cs).split(',').forEach((n) => { n = n.trim(); if (n.startsWith('--')) names.set(n, el); });
      }
      continue;
    }
    for (const el of els) {
      let d = per.get(el);
      if (!d) per.set(el, (d = {}));
      const old = d[r.prop];
      if (!old || r.imp > old.imp || (r.imp === old.imp && (r.spec > old.spec || (r.spec === old.spec && r.order > old.order)))) d[r.prop] = r;
    }
  }

  const seen = new Set();
  per.forEach((d0, el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || (cs.position !== 'absolute' && cs.position !== 'fixed')) return;
    const d = {};
    for (const p in d0) d[p] = resolveVars(d0[p].value, cs);
    if (d['inset-area'] && !d['position-area']) d['position-area'] = d['inset-area'];
    const pa = (d['position-anchor'] || '').trim();
    let anchorEl = pa && pa !== 'auto' ? names.get(pa) : null;
    if (!anchorEl && (!pa || pa === 'auto')) anchorEl = implicitAnchor(el);
    if (!anchorEl && !Object.keys(d).some((p) => /anchor\(--/.test(d[p]))) return;
    seen.add(el);

    const tries = [d];
    const fb = d['position-try-fallbacks'] || d['position-try-options'] || (d['position-try'] || '').replace(/^\s*(most-\w+)\s*/, '');
    if (fb && fb.trim() !== 'none') {
      fb.split(',').forEach((opt) => {
        const o = opt.trim();
        const b = /flip-block|flip-y/.test(o), i = /flip-inline|flip-x/.test(o);
        if (b || i) tries.push(flipDecls(d, b, i));
        else if (/^(top|bottom|left|right|center|span-|block-|inline-|x-|y-)/.test(o)) { const t = Object.assign({}, d); t['position-area'] = o; tries.push(t); }
      });
    }
    let best = null;
    for (let k = 0; k < tries.length; k++) {
      const res = compute(el, cs, tries[k], names, anchorEl);
      if (!res) continue;
      write(el, res.styles);
      if (tries.length === 1) { best = res; break; }
      const ov = overflow(el, res.cb);
      if (!best || ov < best.ov) best = { styles: res.styles, ov };
      if (ov < 1) break;
    }
    if (best) write(el, best.styles);
    if (!logged) { logged = true; smlog('placing popups next to their anchors (CSS anchor positioning)'); }
  });
  managed.forEach((el) => { if (!seen.has(el)) clear(el); });
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => { try { update(); } catch (e) { scheduled = false; } });
}

function start() {
  started = true;
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'attributes' && m.attributeName === 'style' && m.target.__smAnchorStyle === m.target.getAttribute('style')) continue;
      schedule();
      return;
    }
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'open', 'popover', 'hidden', 'data-state', 'aria-expanded'] });
  addEventListener('resize', schedule);
  addEventListener('scroll', schedule, { capture: true, passive: true });
  if (window.visualViewport) { visualViewport.addEventListener('resize', schedule); visualViewport.addEventListener('scroll', schedule); }
  document.addEventListener('toggle', schedule, true);
  document.addEventListener('transitionend', schedule, true);
  document.addEventListener('input', schedule, true);
  // Anchors can move without any DOM change (fonts, images): check now and then
  setInterval(() => { if (managed.size && !document.hidden) schedule(); }, 400);
}
