// CSS rewriter: turns modern CSS into something Safari 15.1 understands.
import postcss from 'postcss';
import nesting from 'postcss-nesting';
import { mediaPlugin } from './mediaq.js';
import oklab from '@csstools/postcss-oklab-function';
import colorMix from '@csstools/postcss-color-mix-function';
import lightDark from '@csstools/postcss-light-dark-function';
import hasPseudo from 'css-has-pseudo';
import focusVisible from 'postcss-focus-visible';
import { extraCssPlugin, EXTRA_NEEDS, PREFIX_NEEDS, fastPrefix } from './cssextra.js';

// Make relative url(...) and @import paths absolute, since the rewritten
// CSS lives in a <style> tag instead of its original file.
const absoluteUrls = (base) => ({
  postcssPlugin: 'sm-abs-urls',
  Declaration(decl) {
    if (!base || decl.value.indexOf('url(') === -1) return;
    decl.value = decl.value.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) => {
      if (/^(data:|blob:|#|[a-z][a-z0-9+.-]*:)/i.test(u)) return m;
      try { return 'url(' + q + new URL(u, base).href + q + ')'; } catch (e) { return m; }
    });
  },
  AtRule: {
    import(rule) {
      if (!base) return;
      rule.params = rule.params.replace(/^(url\()?\s*(['"])([^'"]+)\2/, (m, fn, q, u) => {
        try { return (fn || '') + q + new URL(u, base).href + q; } catch (e) { return m; }
      });
    },
    // font-face src also goes through Declaration above
  },
});

// Strip @property (ignored by Safari 15 anyway; keeps output smaller)
// @property isn't supported by Safari 15. Keep its initial-value as the
// variable's lowest-priority default (zero specificity, first in the sheet),
// so components that rely on the default still get a value.
const dropProperty = () => ({
  postcssPlugin: 'sm-drop-property',
  AtRule: {
    property(r) {
      let init = null;
      r.walkDecls(/^initial-value$/i, (d) => { init = d.value; });
      const name = r.params.trim();
      const root = r.root();
      r.remove();
      if (init == null || !/^--[\w-]+$/.test(name)) return;
      let host = root.__smPropDefaults;
      if (!host) {
        host = postcss.rule({ selector: ':where(:root)' });
        root.prepend(host);
        root.__smPropDefaults = host;
      }
      host.append(postcss.decl({ prop: name, value: init }));
    },
  },
});

// Color functions may use "none" for a missing part (common in oklch for
// greys, e.g. oklch(16% 0 none)). Safari 15 and the color converters don't
// understand it; "none" means the same as 0 here.
const COLOR_NONE = /\b(oklch|oklab|lab|lch|hsla?|hwb|rgba?|color)\(([^()]*\bnone\b[^()]*)\)/gi;
const colorNone = () => ({
  postcssPlugin: 'sm-color-none',
  Declaration(decl) {
    if (decl.value.indexOf('none') === -1 || decl.value.indexOf('(') === -1) return;
    const v = decl.value.replace(COLOR_NONE, (m, fn, args) => fn + '(' + args.replace(/\bnone\b/gi, '0') + ')');
    if (v !== decl.value) decl.value = v;
  },
});

// One unknown pseudo in a selector list makes Safari drop the whole rule:
// Tailwind's reset "*, ::after, ::before, ::backdrop, ::file-selector-button
// {margin:0...}" is lost on Safari 15.1 (no ::backdrop), leaving every
// page with default margins. Split such lists and keep the parts this Safari
// understands (with -webkit- names where it has them).
const PSEUDO_ALIAS = { '::placeholder': '::-webkit-input-placeholder', '::file-selector-button': '::-webkit-file-upload-button' };
const pseudoCache = new Map();
let selectorTest = null;
function pseudoOK(p) {
  if (selectorTest === null) {
    try { selectorTest = typeof CSS !== 'undefined' && CSS.supports('selector(*:hover)') && !CSS.supports('selector(*:sm-nonsense)'); } catch (e) { selectorTest = false; }
  }
  if (!selectorTest) return true;
  let r = pseudoCache.get(p);
  if (r !== undefined) return r;
  let arg = '';
  if (p.endsWith('(')) arg = /nth/.test(p) ? '1)' : /lang/.test(p) ? 'en)' : /dir/.test(p) ? 'ltr)' : '*)';
  try { r = CSS.supports('selector(*' + p + arg + ')'); } catch (e) { r = true; }
  pseudoCache.set(p, r);
  return r;
}
function partOK(part) {
  // ignore escaped characters (Tailwind's .hover\:x), attribute values and strings
  const scan = part.replace(/\\[0-9a-f]{1,6}\s?|\\./gi, '_').replace(/\[[^\]]*\]/g, '').replace(/"[^"]*"|'[^']*'/g, '');
  const ps = scan.match(/::?-?[a-z][\w-]*\(?/gi);
  if (!ps) return part;
  let out = part;
  for (const p of ps) {
    if (pseudoOK(p.toLowerCase())) continue;
    const alias = PSEUDO_ALIAS[p.toLowerCase()];
    if (alias && pseudoOK(alias)) { out = out.split(p).join(alias); continue; }
    return null;
  }
  return out;
}
function splitSel(sel) {
  const out = []; let depth = 0, cur = '', q = '';
  for (const ch of sel) {
    if (q) { if (ch === q) q = ''; cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const splitBadSelectors = () => ({
  postcssPlugin: 'sm-split-selectors',
  Rule(rule) {
    const sel = rule.selector;
    if (!sel || sel.indexOf(':') === -1) return;
    if (rule.parent && rule.parent.type === 'atrule' && /keyframes/i.test(rule.parent.name)) return;
    const parts = splitSel(sel);
    const kept = [];
    let changed = false;
    for (const part of parts) {
      const k = partOK(part);
      if (k === null) { changed = true; continue; }
      if (k !== part) changed = true;
      kept.push(k);
    }
    if (!changed || !kept.length) return;
    rule.selector = kept.join(', ');
  },
});

const NEEDS = /@layer|okl(?:ch|ab)\(|color-mix\(|@container|&|@media[^{;]*[<>]|anchor-name|position-anchor|position-area|inset-area|anchor(?:-size)?\(|::backdrop|::file-selector-button|::placeholder/i;

// Rules using CSS anchor positioning, for the page-side engine (anchor.js):
// [selector, [media queries], property, value, important]
const ANCHOR_PROP = /^(anchor-name|position-anchor|position-area|inset-area|position-try-fallbacks|position-try-options|position-try)$/i;
const ANCHOR_VAL = /(^|[^\w-])anchor(-size)?\(/i;
function extractAnchors(root) {
  const out = [];
  root.walkDecls((d) => {
    if (!ANCHOR_PROP.test(d.prop) && !ANCHOR_VAL.test(d.value)) return;
    const rule = d.parent;
    if (!rule || rule.type !== 'rule' || !rule.selector) return;
    const media = [];
    for (let p = rule.parent; p && p.type !== 'root'; p = p.parent) {
      if (p.type !== 'atrule') continue;
      const n = p.name.toLowerCase();
      if (n === 'media') media.push(p.params);
      else if (n === 'supports' && /\bnot\b/i.test(p.params) && /anchor|position-area/i.test(p.params)) return;
      else if (/keyframes|font-face|page/.test(n)) return;
    }
    // other anchor-dependent properties on the same rule (width: anchor-size(...)) come along via ANCHOR_VAL
    out.push([rule.selector, media, d.prop.toLowerCase(), d.value, d.important ? 1 : 0]);
  });
  return out;
}

export function needsFix(css) {
  if (!css) return false;
  return NEEDS.test(css) || EXTRA_NEEDS.test(css) || PREFIX_NEEDS.test(css);
}

// Wrap every visitor of a plugin so an error on one odd rule skips that rule
// instead of failing the whole stylesheet.
let warned = 0;
function guard(fn, name) {
  return function () {
    try { return fn.apply(this, arguments); }
    catch (e) { if (warned++ < 5) { try { console.warn('[SafariModernizer] CSS step ' + name + ' skipped a rule: ' + e.message); } catch (x) {} } }
  };
}
function wrapVisitors(obj, name) {
  const out = {};
  for (const k in obj) {
    const v = obj[k];
    if (k === 'postcssPlugin' || k === 'postcssVersion') out[k] = v;
    else if (Array.isArray(v)) out[k] = k === 'plugins' ? v.map((x) => (x && typeof x === 'object' ? safe(x) : x)) : v;
    else if (typeof v === 'function') out[k] = k === 'prepare' ? function () { return wrapVisitors(v.apply(this, arguments) || {}, name); } : guard(v, name);
    else if (v && typeof v === 'object') { out[k] = {}; for (const kk in v) out[k][kk] = typeof v[kk] === 'function' ? guard(v[kk], name) : v[kk]; }
    else out[k] = v;
  }
  return out;
}
function safe(p) {
  return wrapVisitors(p, p && p.postcssPlugin || 'plugin');
}

const basePlugins = (base) => [
  safe(nesting({ edition: '2024-02' })),
  safe(mediaPlugin()),
  safe(hasPseudo({ preserve: false })),
  safe(focusVisible({ preserve: false, replaceWith: '.focus-visible', disablePolyfillReadyClass: true })),
  safe(lightDark({ preserve: false })),
  safe(extraCssPlugin()),
  safe(colorNone()),
  safe(oklab({ preserve: false })),
  safe(colorMix({ preserve: true })),
  safe(splitBadSelectors()),
  safe(dropProperty()),
  safe(absoluteUrls(base)),
];

// Returns { order: [layer names in declared order], layers: {name: css}, rest: css }.
// Layered CSS is returned separately so the page script can place it before
// all unlayered styles, matching how @layer works across files.
export function transformSplit(css, base) {
  if (!NEEDS.test(css) && !EXTRA_NEEDS.test(css)) {
    // only prefixes missing: skip the full processor
    return { order: [], layers: {}, rest: fastPrefix(css) };
  }
  const root = postcss(basePlugins(base)).process(css, { from: undefined }).root;
  const anchors = ANCHOR_VAL.test(css) || /anchor-name|position-a/i.test(css) ? extractAnchors(root) : [];
  const order = [];
  const seen = (n) => { if (!order.includes(n)) order.push(n); };
  const buckets = {};
  let anon = 0;
  const collect = (container, prefix) => {
    container.each((node) => {
      if (node.type !== 'atrule' || node.name.toLowerCase() !== 'layer') return;
      const params = node.params.trim();
      if (!node.nodes) {
        params.split(',').map((s) => s.trim()).filter(Boolean).forEach((n) => seen(prefix + n));
        node.remove();
        return;
      }
      const name = prefix + (params || ('__anon' + anon++ + '_' + Math.random().toString(36).slice(2, 7)));
      seen(name);
      collect(node, name + '.');
      (buckets[name] = buckets[name] || []).push(...node.nodes.map((c) => c.clone()));
      node.remove();
    });
  };
  collect(root, '');
  // Layers inside @media / @supports: unwrap where they are
  root.walkAtRules(/^layer$/i, (node) => {
    if (node.nodes) node.replaceWith(node.nodes); else node.remove();
  });
  const layers = {};
  Object.keys(buckets).forEach((n) => {
    const r = postcss.root();
    buckets[n].forEach((c) => r.append(c));
    layers[n] = r.toString();
  });
  const out = { order, layers, rest: root.toString() };
  if (anchors.length) out.anchors = anchors;
  return out;
}

// Single-string version (layered content first), used for testing
export function transform(css, base) {
  const s = transformSplit(css, base);
  const sorted = sortLayers(s.order);
  return sorted.map((n) => s.layers[n] || '').join('\n') + '\n' + s.rest;
}

// Sort layer names: siblings by first declaration, sub-layers before
// their parent's own rules.
export function sortLayers(order) {
  const idx = (n) => order.indexOf(n);
  return order.slice().sort((a, b) => {
    const pa = a.split('.'), pb = b.split('.');
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      if (pa[i] === undefined) return 1;   // a is ancestor of b: a's rules after
      if (pb[i] === undefined) return -1;
      if (pa[i] !== pb[i]) {
        const ka = idx(pa.slice(0, i + 1).join('.')), kb = idx(pb.slice(0, i + 1).join('.'));
        return (ka === -1 ? 1e9 : ka) - (kb === -1 ? 1e9 : kb);
      }
    }
    return 0;
  });
}
