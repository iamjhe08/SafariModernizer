// Extra CSS conversions for Safari 15.1.
// - dvh/svh/lvh, dvw..., container units -> viewport units
// - :state(x), :--x -> [state--x] (matches the ElementInternals polyfill)
// - overflow: clip -> adds overflow: hidden before it
// - -webkit- prefixes Safari 15 still needs

const UNIT_MAP = {
  dvh: 'vh', svh: 'vh', lvh: 'vh', dvw: 'vw', svw: 'vw', lvw: 'vw',
  dvi: 'vw', svi: 'vw', lvi: 'vw', dvb: 'vh', svb: 'vh', lvb: 'vh',
  dvmin: 'vmin', svmin: 'vmin', lvmin: 'vmin', dvmax: 'vmax', svmax: 'vmax', lvmax: 'vmax',
  cqw: 'vw', cqi: 'vw', cqh: 'vh', cqb: 'vh', cqmin: 'vmin', cqmax: 'vmax',
};
const UNIT_RE = /(\d*\.?\d+)(dvh|svh|lvh|dvw|svw|lvw|dvi|svi|lvi|dvb|svb|lvb|dvmin|svmin|lvmin|dvmax|svmax|lvmax|cqw|cqi|cqh|cqb|cqmin|cqmax)\b/gi;

const PREFIX_PROPS = new Set([
  'backdrop-filter', 'user-select', 'text-size-adjust', 'box-decoration-break', 'hyphens', 'appearance',
  'mask', 'mask-image', 'mask-size', 'mask-position', 'mask-repeat', 'mask-origin', 'mask-clip',
  'text-emphasis', 'text-emphasis-color', 'text-emphasis-style', 'initial-letter',
]);

function hasSibling(decl, prop) {
  let found = false;
  decl.parent.each((n) => { if (n.type === 'decl' && n.prop.toLowerCase() === prop) found = true; });
  return found;
}

export const extraCssPlugin = () => ({
  postcssPlugin: 'sm-extra-css',
  Declaration(decl) {
    if (decl.__sm) return;
    const prop = decl.prop.toLowerCase();

    // viewport-relative and container units
    if (UNIT_RE.test(decl.value)) {
      UNIT_RE.lastIndex = 0;
      decl.value = decl.value.replace(UNIT_RE, (m, n, u) => {
        u = u.toLowerCase();
        // iOS: 1vh is the tall viewport (toolbars hidden). The small and dynamic
        // heights come from variables the page script keeps up to date.
        if (u === 'svh' || u === 'svb') return 'calc(' + n + ' * var(--sm-svh, 1vh))';
        if (u === 'dvh' || u === 'dvb') return 'calc(' + n + ' * var(--sm-dvh, 1vh))';
        return n + UNIT_MAP[u];
      });
    }
    UNIT_RE.lastIndex = 0;

    // overflow: clip (Safari 16)
    if (/^overflow(-x|-y)?$/.test(prop) && /\bclip\b/i.test(decl.value)) {
      const fb = decl.clone({ value: decl.value.replace(/\bclip\b/gi, 'hidden') });
      fb.__sm = true;
      decl.before(fb);
    }

    // background-clip: text needs the prefix for gradient text
    if (prop === 'background-clip' && /\btext\b/i.test(decl.value) && !hasSibling(decl, '-webkit-background-clip')) {
      const p = decl.clone({ prop: '-webkit-background-clip' });
      p.__sm = true;
      decl.before(p);
    }

    if (PREFIX_PROPS.has(prop) && !hasSibling(decl, '-webkit-' + prop)) {
      const p = decl.clone({ prop: '-webkit-' + prop });
      p.__sm = true;
      decl.before(p);
    }
    decl.__sm = true;
  },
  Rule(rule) {
    if (rule.__smRule) return;
    rule.__smRule = true;
    // :popover-open -> the class the Popover polyfill sets
    // (skip the escaped class form ".\:popover-open", or this would loop)
    if (/(^|[^\\]):popover-open\b/.test(rule.selector)) rule.selector = rule.selector.replace(/(^|[^\\]):popover-open\b/g, '$1.\\:popover-open');
    if (!/:state\(|:--[a-zA-Z]/.test(rule.selector)) return;
    rule.selector = rule.selector
      // skip escaped colons inside class names (Tailwind's .bg-\(image\:--x\))
      .replace(/(\\*):state\(\s*([\w-]+)\s*\)/g, (m, bs, n) => (bs.length % 2 ? m : bs + '[state--' + n.replace(/^--/, '') + ']'))
      .replace(/(\\*):--([\w-]+)/g, (m, bs, n) => (bs.length % 2 ? m : bs + '[state--' + n + ']'));
  },
});

// Features that need the full CSS processor
export const EXTRA_NEEDS = /(?:\d)(?:dv|sv|lv)(?:h|w|i|b|min|max)\b|\dcq(?:w|h|i|b|min|max)\b|:state\(|:--[a-z]|:has\(|:focus-visible|light-dark\(|:popover-open|overflow(?:-[xy])?\s*:\s*clip/i;
// Only -webkit- prefixes needed: handled with a quick text replacement
export const PREFIX_NEEDS = /(?:^|[;{\s])(?:backdrop-filter|mask(?:-image|-size|-position|-repeat)?|user-select|text-size-adjust|appearance|box-decoration-break|hyphens)\s*:|background-clip\s*:\s*text/i;
export function fastPrefix(css) {
  return css
    .replace(/(^|[;{\s])(backdrop-filter|mask|mask-image|mask-size|mask-position|mask-repeat|user-select|text-size-adjust|appearance|box-decoration-break|hyphens)\s*:([^;}]*)/g,
      (m, pre, prop, val) => pre + '-webkit-' + prop + ':' + val + ';' + prop + ':' + val)
    .replace(/(^|[;{\s])background-clip\s*:\s*text\b/g, '$1-webkit-background-clip:text;background-clip:text');
}
