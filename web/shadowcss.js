// Fix CSS that lives inside web components: <style> tags in shadow roots,
// and constructed stylesheets (sheet.replaceSync / replace) that components
// share through adoptedStyleSheets. Layers are flattened in place, since a
// shadow tree is its own cascade.
import { needsFix, transform } from './cssfix-entry.js';
import { smlog } from './debug.js';
import { timed } from './safety.js';

export function startShadowCss() {
  const done = new WeakMap(); // style element -> text we wrote

  const memo = new Map();   // components share the same CSS text; rewrite it once
  const fixText = (css) => {
    if (!css || !needsFix(css)) return css;
    if (memo.has(css)) return memo.get(css);
    let out = css;
    try { out = timed('component CSS rewrite ' + Math.round(css.length / 1024) + ' KB', () => transform(css, document.baseURI), smlog); }
    catch (e) { smlog('shadow CSS fix failed: ' + e.message); }
    if (memo.size > 500) memo.clear();
    memo.set(css, out);
    return out;
  };

  const fixStyle = (st) => {
    const text = st.textContent;
    if (!text || done.get(st) === text) return;
    const out = fixText(text);
    done.set(st, out);
    if (out !== text) st.textContent = out;
  };

  const scan = (root) => {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('style').forEach(fixStyle);
  };

  const watch = (root) => {
    if (!root || root.__smWatched) return;
    root.__smWatched = true;
    scan(root);
    new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'characterData') {
          const p = m.target.parentNode;
          if (p && p.localName === 'style') fixStyle(p);
          continue;
        }
        if (m.target && m.target.localName === 'style') fixStyle(m.target);
        m.addedNodes.forEach((n) => {
          if (n.nodeType !== 1) return;
          if (n.localName === 'style') fixStyle(n); else scan(n);
        });
      }
    }).observe(root, { childList: true, subtree: true, characterData: true });
  };

  // every shadow root, whether a component made it or it came from
  // server-rendered <template shadowrootmode>
  window.__smOnShadowRoot = watch;
  const origAttach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function () {
    const r = origAttach.apply(this, arguments);
    try { watch(r); } catch (e) {}
    return r;
  };
  // roots that already exist (declarative ones made before this ran)
  const sweep = () => document.querySelectorAll('*').forEach((el) => { const r = el.shadowRoot; if (r) watch(r); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sweep);
  else sweep();

  // constructed stylesheets
  const P = window.CSSStyleSheet && CSSStyleSheet.prototype;
  if (P && P.replaceSync) {
    const rs = P.replaceSync;
    P.replaceSync = function (text) { return rs.call(this, fixText(String(text))); };
  }
  if (P && P.replace) {
    const rp = P.replace;
    P.replace = function (text) { return rp.call(this, fixText(String(text))); };
  }
}
