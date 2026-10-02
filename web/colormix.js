// color-mix() with CSS variables (Safari 16.2).
// Rules like  background: color-mix(in oklab, var(--bg) 60%, transparent)
// can't fall back in Safari 15.1: the var() makes the whole value fail when
// the page is drawn, so the color just disappears. This works out the mixed
// color from the page's actual theme values and writes it into the rule
// (only in the tweak's own rewritten copies of the page's styles). It reruns
// when the theme changes.
import { smlog } from './debug.js';
import { timed } from './safety.js';

// ---------- color parsing ----------
const probe = (() => { let el = null; return () => el || (el = document.createElement('i')); })();
const named = new Map(Object.entries({
  black: '#000', white: '#fff', red: '#f00', lime: '#0f0', green: '#008000', blue: '#00f', yellow: '#ff0',
  cyan: '#0ff', aqua: '#0ff', magenta: '#f0f', fuchsia: '#f0f', gray: '#808080', grey: '#808080',
  silver: '#c0c0c0', maroon: '#800000', navy: '#000080', olive: '#808000', purple: '#800080', teal: '#008080',
  orange: '#ffa500', pink: '#ffc0cb', brown: '#a52a2a', gold: '#ffd700', indigo: '#4b0082', violet: '#ee82ee',
}).map(([k, v]) => [k, v]));

function clamp01(x) { return Math.min(1, Math.max(0, x)); }
function num(s, scale) { s = s.trim(); if (s === 'none') return 0; return s.endsWith('%') ? parseFloat(s) / 100 * scale : parseFloat(s); }
function hue(s) {
  s = s.trim(); if (s === 'none') return 0;
  const v = parseFloat(s);
  if (/turn$/.test(s)) return v * 360; if (/g?rad$/.test(s)) return /grad$/.test(s) ? v * 0.9 : v * 180 / Math.PI;
  return v;
}
function args(inner) {
  const [main, alpha] = inner.split('/');
  const parts = main.trim().split(/[\s,]+/).filter(Boolean);
  let a = 1;
  if (alpha !== undefined) a = num(alpha, 1);
  else if (parts.length === 4) a = num(parts.pop(), 1);
  return { parts, a };
}

// linear sRGB <-> sRGB
const toLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const fromLin = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
function oklabToRgb(L, a, b) {
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.2914855480 * b, 3);
  return [
    fromLin(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLin(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLin(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
  ];
}
function rgbToOklab(r, g, b) {
  r = toLin(r); g = toLin(g); b = toLin(b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}
// CIE Lab (D50) -> sRGB, enough for lab()/lch() inputs
function labToRgb(L, a, b) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const e = 216 / 24389, k = 24389 / 27;
  const xr = fx ** 3 > e ? fx ** 3 : (116 * fx - 16) / k;
  const yr = L > k * e ? fy ** 3 : L / k;
  const zr = fz ** 3 > e ? fz ** 3 : (116 * fz - 16) / k;
  const X = xr * 0.96422, Y = yr, Z = zr * 0.82521;
  // D50 -> D65 (Bradford) then to linear sRGB
  const x = 0.9554734527042182 * X - 0.023098536874261423 * Y + 0.0632593086610217 * Z;
  const y = -0.028369706963208136 * X + 1.0099954580058226 * Y + 0.021041398966943008 * Z;
  const z = 0.012314001688319899 * X - 0.020507696433477912 * Y + 1.3303659366080753 * Z;
  return [
    fromLin(3.2409699419045226 * x - 1.537383177570094 * y - 0.4986107602930034 * z),
    fromLin(-0.9692436362808796 * x + 1.8759675015077202 * y + 0.04155505740717559 * z),
    fromLin(0.05563007969699366 * x - 0.20397695888897652 * y + 1.0569715142428786 * z),
  ];
}
function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const f = (n) => { const k = (n + h / 30) % 12; const a = s * Math.min(l, 1 - l); return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4)];
}

// returns [r,g,b,a] with r,g,b in 0..1 (sRGB), or null
export function parseColor(str) {
  let s = String(str).trim().toLowerCase();
  if (!s) return null;
  if (s === 'transparent') return [0, 0, 0, 0];
  let m;
  if ((m = /^#([0-9a-f]{3,8})$/.exec(s))) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const v = (i) => parseInt(h.slice(i, i + 2), 16) / 255;
    return [v(0), v(2), v(4), h.length === 8 ? v(6) : 1];
  }
  if ((m = /^(rgba?|hsla?|hwb|oklab|oklch|lab|lch|color)\((.*)\)$/.exec(s))) {
    const fn = m[1];
    if (fn === 'color') {
      const { parts, a } = args(m[2]);
      const space = parts.shift();
      const v = parts.map((p) => num(p, 1));
      if (/srgb-linear/.test(space)) return [fromLin(v[0]), fromLin(v[1]), fromLin(v[2]), a];
      return [v[0], v[1], v[2], a];  // srgb, display-p3 (close enough)
    }
    const { parts, a } = args(m[2]);
    if (parts.length < 3) return null;
    if (fn === 'rgb' || fn === 'rgba') return [num(parts[0], 255) / 255, num(parts[1], 255) / 255, num(parts[2], 255) / 255, a];
    if (fn === 'hsl' || fn === 'hsla') return [...hslToRgb(hue(parts[0]), num(parts[1], 100) / 100, num(parts[2], 100) / 100), a];
    if (fn === 'hwb') {
      const w = num(parts[1], 100) / 100, bl = num(parts[2], 100) / 100;
      const rgb = hslToRgb(hue(parts[0]), 1, 0.5).map((c) => c * (1 - w - bl) + w);
      return [...rgb, a];
    }
    if (fn === 'oklab') return [...oklabToRgb(num(parts[0], 1), num(parts[1], 0.4), num(parts[2], 0.4)), a];
    if (fn === 'oklch') {
      const L = num(parts[0], 1), C = num(parts[1], 0.4), H = hue(parts[2]) * Math.PI / 180;
      return [...oklabToRgb(L, C * Math.cos(H), C * Math.sin(H)), a];
    }
    if (fn === 'lab') return [...labToRgb(num(parts[0], 100), num(parts[1], 125), num(parts[2], 125)), a];
    if (fn === 'lch') {
      const L = num(parts[0], 100), C = num(parts[1], 150), H = hue(parts[2]) * Math.PI / 180;
      return [...labToRgb(L, C * Math.cos(H), C * Math.sin(H)), a];
    }
  }
  if (/^[a-z]+$/.test(s)) {
    if (named.has(s)) { const v = named.get(s); return typeof v === 'string' ? parseColor(v) : v; }
    const el = probe();
    el.style.color = '';
    el.style.color = s;
    if (!el.style.color) { named.set(s, null); return null; }
    (document.body || document.documentElement).appendChild(el);
    const c = parseColor(getComputedStyle(el).color);
    el.remove();
    named.set(s, c);
    return c;
  }
  return null;
}

const fmt = (c) => {
  const to255 = (x) => Math.round(clamp01(x) * 255);
  const a = Math.round(clamp01(c[3]) * 1000) / 1000;
  return a >= 1 ? 'rgb(' + to255(c[0]) + ', ' + to255(c[1]) + ', ' + to255(c[2]) + ')'
    : 'rgba(' + to255(c[0]) + ', ' + to255(c[1]) + ', ' + to255(c[2]) + ', ' + a + ')';
};

// ---------- color-mix ----------
function splitTop(s, ch) {
  const out = []; let d = 0, last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') d++; else if (c === ')') d--;
    else if (c === ch && d === 0) { out.push(s.slice(last, i)); last = i + 1; }
  }
  out.push(s.slice(last));
  return out.map((x) => x.trim());
}

function mixPart(part) {
  // "<color> <pct>?" or "<pct>? <color>"
  let pct = null, color = part;
  const m1 = /^(.*\))\s+(-?[\d.]+)%$/.exec(part) || /^([^\s]+)\s+(-?[\d.]+)%$/.exec(part);
  const m2 = /^(-?[\d.]+)%\s+(.*)$/.exec(part);
  if (m1) { color = m1[1]; pct = parseFloat(m1[2]); } else if (m2) { pct = parseFloat(m2[1]); color = m2[2]; }
  return { color: color.trim(), pct };
}

export function evalColorMix(inner) {
  const parts = splitTop(inner, ',');
  if (parts.length !== 3) return null;
  const space = parts[0].replace(/^in\s+/, '').trim().split(/\s+/)[0];
  const A = mixPart(parts[1]), B = mixPart(parts[2]);
  const ca = parseColor(A.color), cb = parseColor(B.color);
  if (!ca || !cb) return null;
  let p1 = A.pct, p2 = B.pct;
  if (p1 == null && p2 == null) { p1 = 50; p2 = 50; } else if (p1 == null) p1 = 100 - p2; else if (p2 == null) p2 = 100 - p1;
  const sum = p1 + p2;
  if (sum <= 0) return null;
  const alphaMul = sum < 100 ? sum / 100 : 1;
  const t = p2 / sum;
  // premultiplied interpolation
  const a = ca[3] * (1 - t) + cb[3] * t;
  const toSpace = (c) => (space === 'srgb' || space === 'hsl' || space === 'hwb') ? [c[0], c[1], c[2]]
    : (space === 'srgb-linear' || /^xyz/.test(space)) ? [toLin(c[0]), toLin(c[1]), toLin(c[2])]
    : rgbToOklab(c[0], c[1], c[2]);   // oklab, oklch, lab, lch, display-p3...
  const fromSpace = (v) => (space === 'srgb' || space === 'hsl' || space === 'hwb') ? v
    : (space === 'srgb-linear' || /^xyz/.test(space)) ? v.map(fromLin)
    : oklabToRgb(v[0], v[1], v[2]);
  let out;
  if (space === 'oklch' || space === 'lch' || space === 'hsl' || space === 'hwb') {
    // polar spaces: interpolate lightness/chroma premultiplied, hue the short way round
    const polar = (c) => {
      const [L, A, B] = rgbToOklab(c[0], c[1], c[2]);
      const C = Math.sqrt(A * A + B * B);
      return [L, C, C < 1e-4 ? NaN : Math.atan2(B, A) * 180 / Math.PI];
    };
    const pa = polar(ca), pb = polar(cb);
    let ha = pa[2], hb = pb[2];
    if (isNaN(ha)) ha = isNaN(hb) ? 0 : hb;
    if (isNaN(hb)) hb = ha;
    let dh = hb - ha;
    if (dh > 180) dh -= 360; else if (dh < -180) dh += 360;
    const H = (ha + dh * t) * Math.PI / 180;
    if (a <= 0) out = [0, 0, 0];
    else {
      const L = (pa[0] * ca[3] * (1 - t) + pb[0] * cb[3] * t) / a;
      const C = (pa[1] * ca[3] * (1 - t) + pb[1] * cb[3] * t) / a;
      out = oklabToRgb(L, C * Math.cos(H), C * Math.sin(H));
    }
  } else {
    const va = toSpace(ca), vb = toSpace(cb);
    if (a <= 0) out = [0, 0, 0];
    else out = fromSpace([0, 1, 2].map((i) => (va[i] * ca[3] * (1 - t) + vb[i] * cb[3] * t) / a));
  }
  return fmt([out[0], out[1], out[2], a * alphaMul]);
}

// Replace var() using a lookup, then evaluate every color-mix(), innermost first.
export function resolveValue(text, lookup, depth) {
  depth = depth || 0;
  if (depth > 8) return null;
  let s = text, guard = 0;
  // var(--x, fallback)
  while (s.indexOf('var(') !== -1 && guard++ < 50) {
    const i = s.lastIndexOf('var(');
    let d = 0, j = i + 4;
    for (; j < s.length; j++) { if (s[j] === '(') d++; else if (s[j] === ')') { if (d === 0) break; d--; } }
    const inner = s.slice(i + 4, j);
    const comma = splitTop(inner, ',');
    const name = comma[0];
    const fallback = comma.length > 1 ? inner.slice(inner.indexOf(',') + 1).trim() : null;
    // null = variable not set (use the fallback); '' = set to empty, as in
    // the "space toggle" trick light/dark themes use (substitute nothing)
    let v = lookup(name);
    if (v == null) v = fallback;
    if (v == null) return null;
    if (v.indexOf('var(') !== -1 || v.indexOf('color-mix(') !== -1) { v = resolveValue(v, lookup, depth + 1); if (v == null) return null; }
    s = s.slice(0, i) + v + s.slice(j + 1);
  }
  guard = 0;
  while (s.indexOf('color-mix(') !== -1 && guard++ < 50) {
    const i = s.lastIndexOf('color-mix(');
    let d = 0, j = i + 10;
    for (; j < s.length; j++) { if (s[j] === '(') d++; else if (s[j] === ')') { if (d === 0) break; d--; } }
    const v = evalColorMix(s.slice(i + 10, j));
    if (v == null) return null;
    s = s.slice(0, i) + v + s.slice(j + 1);
  }
  return s.trim();
}

// ---------- applying to the page ----------
export function startColorMix() {
  if (window.CSS && CSS.supports && CSS.supports('color', 'color-mix(in srgb, red, blue)')) return;
  const entries = [];            // {rule, prop, raw, prio, local}
  const seenSheets = new WeakSet();

  function collect(rules, out) {
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i];
      if (r.cssRules && !r.style) { collect(r.cssRules, out); continue; }
      if (!r.style) continue;
      let local = null;
      const mine = [];
      for (let k = 0; k < r.style.length; k++) {
        const prop = r.style[k];
        const raw = r.style.getPropertyValue(prop);
        if (prop.indexOf('--') === 0) { (local = local || {})[prop] = raw; }
        if (raw.indexOf('color-mix(') !== -1 && raw.indexOf('var(') !== -1) {
          mine.push({ rule: r, prop, raw, prio: r.style.getPropertyPriority(prop) });
        }
      }
      mine.forEach((e) => { e.local = local; out.push(e); });
    }
  }

  function scanSheets() {
    const styles = document.querySelectorAll('style[data-smcss]');
    let added = 0;
    styles.forEach((st) => {
      const sheet = st.sheet;
      if (!sheet || seenSheets.has(sheet)) return;
      seenSheets.add(sheet);
      if ((st.textContent || '').indexOf('color-mix(') === -1) return;
      let rules; try { rules = sheet.cssRules; } catch (e) { return; }
      const before = entries.length;
      collect(rules, entries);
      added += entries.length - before;
    });
    return added;
  }

  let rootCS = null, bodyCS = null, probe = null, defined = new Map(), snap = new Map();
  // Ask the browser itself whether a variable is set: a var() fallback is
  // used only when it is not. Needed because an empty value and an unset one
  // both read back as "".
  // Check many names with one style calculation (one per name froze big
  // pages like ChatGPT for many seconds)
  const probeAll = (names) => {
    const todo = names.filter((n) => !defined.has(n));
    if (!todo.length) return;
    try {
      if (!probe || !probe.isConnected) {
        probe = document.createElement('i');
        probe.setAttribute('data-sm-probe', '');
        probe.style.display = 'none';
        (document.body || document.documentElement).appendChild(probe);
      }
      probe.style.cssText = 'display:none;' + todo.map((n, i) => '--sm-p' + i + ':var(' + n + ', __smunset__)').join(';');
      const cs = getComputedStyle(probe);
      todo.forEach((n, i) => defined.set(n, cs.getPropertyValue('--sm-p' + i).indexOf('__smunset__') === -1));
      probe.style.cssText = 'display:none';
    } catch (e) {}
  };
  const isDefined = (name) => {
    if (defined.has(name)) return defined.get(name);
    let r = false;
    try {
      if (!probe || !probe.isConnected) {
        probe = document.createElement('i');
        probe.setAttribute('data-sm-probe', '');
        probe.style.display = 'none';
        (document.body || document.documentElement).appendChild(probe);
      }
      probe.style.setProperty('--sm-p', 'var(' + name + ', __smunset__)');
      r = getComputedStyle(probe).getPropertyValue('--sm-p').indexOf('__smunset__') === -1;
    } catch (e) {}
    defined.set(name, r);
    return r;
  };
  const lookupFor = (entry) => (name) => {
    if (entry.local && entry.local[name] != null) {
      const lv = entry.local[name].trim();
      return /^(initial|unset|revert|revert-layer)$/i.test(lv) ? null : lv;
    }
    let v;
    if (snap.has(name)) v = snap.get(name);
    else {
      v = bodyCS ? bodyCS.getPropertyValue(name) : '';
      if (!v && rootCS) v = rootCS.getPropertyValue(name);
      v = (v || '').trim();
      snap.set(name, v);
    }
    if (v) return v;
    return isDefined(name) ? '' : null;
  };

  let applied = 0;
  function apply() {
    if (!entries.length) return;
    rootCS = getComputedStyle(document.documentElement);
    bodyCS = document.body ? getComputedStyle(document.body) : null;
    defined = new Map();
    const names = new Set();
    entries.forEach((e) => { const m = e.raw.match(/var\(\s*--[\w-]+/g); if (m) m.forEach((x) => names.add(x.replace(/^var\(\s*/, ''))); });
    // Read every value before changing any rule: each read after a change
    // makes the browser restyle the whole page (474 times on ChatGPT = frozen)
    snap = new Map();
    let todo = Array.from(names);
    for (let round = 0; round < 6 && todo.length; round++) {
      const next = [];
      todo.forEach((nm) => {
        if (snap.has(nm)) return;
        let v = bodyCS ? bodyCS.getPropertyValue(nm) : '';
        if (!v && rootCS) v = rootCS.getPropertyValue(nm);
        v = (v || '').trim();
        snap.set(nm, v);
        const m = v.match(/var\(\s*--[\w-]+/g);
        if (m) m.forEach((x) => { x = x.replace(/^var\(\s*/, ''); if (!snap.has(x)) { names.add(x); next.push(x); } });
      });
      todo = next;
    }
    probeAll(Array.from(names));
    // custom properties first, so normal properties see resolved values
    const order = entries.slice().sort((a, b) => (b.prop.indexOf('--') === 0) - (a.prop.indexOf('--') === 0));
    let n = 0;
    order.forEach((e) => {
      const v = resolveValue(e.raw, lookupFor(e));
      if (v == null || v === e.last) return;
      try { e.rule.style.setProperty(e.prop, v, e.prio); e.last = v; n++; } catch (x) {}
      if (e.prop.indexOf('--') === 0 && !e.local) snap.set(e.prop, v);
    });
    if (n && !applied++) smlog('color-mix: resolved ' + n + ' colors');
  }

  let timer = 0;
  const later = (ms) => { clearTimeout(timer); timer = setTimeout(() => { timed('color-mix resolve', () => { scanSheets(); apply(); }, smlog); }, ms); };

  // new rewritten stylesheets
  new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) {
      if (n.nodeType === 1 && n.localName === 'style' && n.hasAttribute('data-smcss')) { later(50); return; }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  // theme switches usually change a class/attribute on <html> or <body>
  const themeObs = new MutationObserver(() => later(30));
  const watchTheme = () => {
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-color-mode', 'data-mode'] });
    if (document.body) themeObs.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { watchTheme(); later(0); });
  else { watchTheme(); later(0); }
  window.addEventListener('load', () => later(0));
  try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => later(0)); } catch (e) {}
}
