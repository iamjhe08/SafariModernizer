// Regular <script> files that Safari 15.1 can't even parse (lookbehind
// regex literals, class static blocks, regex v flag) fail completely: none
// of their code runs. When a parse error shows up, find those scripts,
// rewrite the unsupported syntax, and run the fixed copy through the
// tweak's native side (not blocked by the page's CSP).
import { fixScript } from './esm-transform.js';
import { smlog } from './debug.js';
import { timed, config, getLevel } from './safety.js';

export function startScriptFix(bridge) {
  if (window.__smscriptfix) return;
  window.__smscriptfix = 1;

  const handled = new WeakSet();
  let pending = false;
  let ready = document.readyState !== 'loading';

  const isClassic = (s) => {
    const t = (s.getAttribute('type') || '').trim().toLowerCase();
    return !t || t === 'text/javascript' || t === 'application/javascript' || t === 'text/ecmascript' || t === 'application/ecmascript';
  };

  const getFixed = (url) => {
    if (!bridge) return fetch(url).then((r) => r.text()).then((t) => fixScript(t));
    return bridge.postMessage({ op: 'get', kind: 'cjs', url }).then((r) => {
      if (r && r.data != null) return r.data || null;
      let fixed = null;
      if (r.raw && r.raw.length > 3 * 1024 * 1024) { smlog('script too large to fix: ' + url.split('/').pop().slice(0, 60)); return null; }
      try { fixed = timed('script syntax fix ' + url.replace(/^https?:\/\//, '').slice(0, 90), () => fixScript(r.raw), smlog); } catch (e) { fixed = null; }
      try { bridge.postMessage({ op: 'put', kind: 'cjs', url, data: fixed || '' }); } catch (e) {}
      return fixed;
    });
  };

  const run = (code, label) => {
    const done = bridge ? bridge.postMessage({ op: 'eval', code: code + '\n;void 0;' }) : Promise.resolve((0, eval)(code));
    return done.then(() => smlog('re-ran fixed script: ' + label), (e) => smlog('fixed script failed: ' + label + ': ' + (e && e.message || e)));
  };

  const scan = async (onlyUrl) => {
    pending = false;
    const list = [...document.querySelectorAll('script')].filter((s) => isClassic(s) && !handled.has(s));
    for (const s of list) {
      if (onlyUrl && s.src !== onlyUrl) continue;
      handled.add(s);
      try {
        if (s.src) {
          if (!/^https?:/i.test(s.src)) continue;
          const fixed = await getFixed(s.src);
          if (fixed) await run(fixed, s.src.split('/').pop().split('?')[0]);
        } else {
          const fixed = fixScript(s.textContent || '');
          if (fixed) await run(fixed, 'inline script');
        }
      } catch (e) { /* not parseable by us either; leave it */ }
    }
  };

  // Listen from the very start (parse errors happen early), act once the
  // site's mode is known and allows it
  const schedule = (url) => {
    if (!ready) { pending = pending || true; return; }
    config.then(() => { if (getLevel() < 1) setTimeout(() => scan(url || null), 0); });
  };

  window.addEventListener('error', (e) => {
    if (e.target && e.target !== window) return;   // resource load errors
    const msg = String(e.message || '');
    // Only clear syntax errors in a named file. A generic cross-site
    // "Script error." is usually a normal runtime error, and checking every
    // script on the page for it is too costly on big sites.
    if (!/SyntaxError/i.test(msg) || !e.filename || e.filename === location.href) return;
    schedule(e.filename);
  }, true);

  const onReady = () => { ready = true; if (pending) config.then(() => { if (getLevel() < 1) scan(null); }); };
  if (!ready) document.addEventListener('DOMContentLoaded', onReady);
}
