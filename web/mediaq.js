// Converts new-style media/container query syntax into the old syntax
// Safari 15.1 understands.
//   (width >= 48rem)                 -> (min-width: 48rem)
//   (width <= calc(48rem - .02px))   -> (max-width: 767.98px)
//   (480px <= width < 768px)         -> (min-width: 480px) and (max-width: 767.98px)
//   (-webkit-device-pixel-ratio>=2)  -> (-webkit-min-device-pixel-ratio: 2)
// @container queries are approximated with @media (viewport width) when
// that can only err toward the narrow layout. See containerToMedia.

const OPS = ['<=', '>=', '<', '>', '='];
const FLIP = { '<': '>', '>': '<', '<=': '>=', '>=': '<=', '=': '=' };
const FEATURE = /^-?[a-z][a-z0-9-]*$/i;

// Split s at top-level (depth 0) comparison operators.
function splitRange(s) {
  const parts = [];
  let depth = 0, last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && (c === '<' || c === '>' || c === '=')) {
      const op = (c !== '=' && s[i + 1] === '=') ? c + '=' : c;
      parts.push(s.slice(last, i).trim(), op);
      i += op.length - 1;
      last = i + 1;
    }
  }
  parts.push(s.slice(last).trim());
  return parts;
}

// Turn "48rem", "768px", "calc(48rem - .02px)" into {n, unit}. rem/em use
// 16px, which is what media queries always use.
function evalLength(v) {
  v = v.trim();
  let m = /^(-?[\d.]+)(px|rem|em)?$/i.exec(v);
  if (m) {
    const n = parseFloat(m[1]);
    const u = (m[2] || '').toLowerCase();
    if (u === 'rem' || u === 'em') return { n: n * 16, unit: 'px' };
    return { n, unit: u };
  }
  m = /^calc\((.*)\)$/i.exec(v);
  if (!m) return null;
  const expr = m[1].replace(/\s+/g, ' ').trim();
  const terms = expr.match(/[+-]?\s*-?[\d.]+(px|rem|em)/gi);
  if (!terms || terms.join('').replace(/\s/g, '') !== expr.replace(/\s/g, '').replace(/^\+/, '')) return null;
  let total = 0;
  for (const t of terms) {
    const tm = /^([+-]?)\s*(-?[\d.]+)(px|rem|em)$/i.exec(t.trim());
    if (!tm) return null;
    let n = parseFloat(tm[2]) * (tm[3].toLowerCase() === 'px' ? 1 : 16);
    if (tm[1] === '-') n = -n;
    total += n;
  }
  return { n: total, unit: 'px' };
}

function fmt(n) { return String(Math.round(n * 1000) / 1000); }

function prefixed(feature, kind) {
  const f = feature.toLowerCase();
  if (f.startsWith('-webkit-')) return '-webkit-' + kind + '-' + f.slice(8);
  return kind + '-' + f;
}

function one(feature, op, value) {
  if (op === '=') return '(' + feature + ': ' + value + ')';
  const kind = op[0] === '>' ? 'min' : 'max';
  const strict = op.length === 1;
  const len = evalLength(value);
  let out = value;
  if (len) {
    let n = len.n;
    if (strict) n += (kind === 'min' ? 1 : -1) * (len.unit === 'px' ? 0.02 : 0.001);
    out = fmt(n) + len.unit;
  }
  return '(' + prefixed(feature, kind) + ': ' + out + ')';
}

// Convert the inside of one parenthesized group, or return null if it is
// not a range expression.
function convertGroup(inner) {
  const p = splitRange(inner);
  if (p.length === 3) {
    const [a, op, b] = p;
    if (FEATURE.test(a)) return one(a, op, b);
    if (FEATURE.test(b)) return one(b, FLIP[op], a);
    return null;
  }
  if (p.length === 5) {
    const [a, op1, f, op2, c] = p;
    if (!FEATURE.test(f)) return null;
    return one(f, FLIP[op1], a) + ' and ' + one(f, op2, c);
  }
  return null;
}

// Walk the query text, converting every parenthesized range group (also
// inside nested groups like "not ((width < 5px) or ...)").
export function convertQuery(q) {
  let out = '', i = 0;
  while (i < q.length) {
    const c = q[i];
    if (c !== '(') { out += c; i++; continue; }
    // find matching paren
    let depth = 0, j = i;
    for (; j < q.length; j++) {
      if (q[j] === '(') depth++;
      else if (q[j] === ')') { depth--; if (depth === 0) break; }
    }
    const inner = q.slice(i + 1, j);
    // a function like calc( or style( right before? then copy as-is
    const before = out.slice(-1);
    if (/[a-z0-9-]/i.test(before)) { out += q.slice(i, j + 1); i = j + 1; continue; }
    const trimmed = inner.trim();
    if (trimmed.startsWith('(') || /^not\s*\(/i.test(trimmed)) {
      out += '(' + convertQuery(inner) + ')';
    } else {
      const conv = convertGroup(inner);
      out += conv != null ? conv : '(' + inner + ')';
    }
    i = j + 1;
  }
  return out;
}

export const RANGE_TEST = /[<>]|=\s*[\d(]/;

// @container [name] (condition) -> @media (condition), but only when the
// condition is all max-* (true for the container whenever it is true for the
// viewport, since a container is never wider than the screen). min-* queries
// stay unsupported, so the page keeps its narrow base styles on a phone.
export function containerToMedia(params) {
  let p = params.trim();
  if (/style\s*\(|scroll-state\s*\(/i.test(p)) return null;
  // drop container name
  const nm = /^([a-z_-][\w-]*)\s+(?=\(|not\b)/i.exec(p);
  if (nm && !/^(not|and|or)$/i.test(nm[1])) p = p.slice(nm[0].length);
  if (/^[a-z_-][\w-]*$/i.test(p)) return null; // name only
  p = p.replace(/\binline-size\b/gi, 'width').replace(/\bblock-size\b/gi, 'height');
  const conv = convertQuery(p);
  if (/\bmin-/i.test(conv) || /\bnot\b/i.test(conv) || /\bor\b/i.test(conv)) return null;
  if (!/\bmax-(width|height)/i.test(conv)) return null;
  return conv;
}

export const mediaPlugin = () => ({
  postcssPlugin: 'sm-media-ranges',
  AtRule: {
    media(rule) {
      if (RANGE_TEST.test(rule.params)) rule.params = convertQuery(rule.params);
    },
    container(rule) {
      const m = containerToMedia(rule.params);
      if (m) { rule.name = 'media'; rule.params = m; }
    },
  },
});
