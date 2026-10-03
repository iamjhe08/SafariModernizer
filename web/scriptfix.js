// Regular <script> files that Safari 15.1 can't even parse (lookbehind
// regex literals, class static blocks, regex v flag) fail completely: none
// of their code runs. When a parse error shows up, find those scripts,
// rewrite the unsupported syntax, and run the fixed copy through the
// tweak's native side (not blocked by the page's CSP).
import { fixScript, fastFixScript } from './esm-transform.js';
import { smlog } from './debug.js';
import { timed, config, getLevel } from './safety.js';

export function startScriptFix(bridge) {
  if (window.__smscriptfix) return;
  window.__smscriptfix = 1;

  const handled = new WeakSet();
  const doneUrls = new Set();
  let pending = false;
  const waiting = new Set();   // files with errors seen before the page finished parsing
  let ready = document.readyState !== 'loading';

  const isClassic = (s) => {
    const t = (s.getAttribute('type') || '').trim().toLowerCase();
    return !t || t === 'text/javascript' || t === 'application/javascript' || t === 'text/ecmascript' || t === 'application/ecmascript';
  };

  // Files served by the app itself (app://, iCab's own screen) can't be
  // downloaded by the tweak's native side; the page can read them
  const fixText = (t) => fastFixScript(t) || fixScript(t);
  const getFixed = (url) => {
    if (!/^https?:/i.test(url)) return fetch(url).then((r) => r.text()).then(fixText);
    if (!bridge) return fetch(url).then((r) => r.text()).then((t) => fastFixScript(t) || fixScript(t));
    return bridge.postMessage({ op: 'get', kind: 'cjs', url }).then((r) => {
      if (r && r.data != null) return r.data || null;
      let fixed = null;
      const name = url.replace(/^https?:\/\//, '').slice(0, 90);
      // Lookbehind-only files: fixed without parsing the whole file
      try { fixed = r.raw ? timed('quick script fix ' + name, () => fastFixScript(r.raw), smlog) : null; } catch (e) { fixed = null; }
      if (!fixed && r.raw && r.raw.length > 3 * 1024 * 1024) { smlog('script too large to fix: ' + url.split('/').pop().slice(0, 60)); return null; }
      if (!fixed) try { fixed = timed('script syntax fix ' + name, () => fixScript(r.raw), smlog); } catch (e) { fixed = null; }
      try { bridge.postMessage({ op: 'put', kind: 'cjs', url, data: fixed || '' }); } catch (e) {}
      return fixed;
    });
  };

  // The fixed copy runs late, after the page may have finished loading.
  // "Page ready" listeners it adds then would never fire (Calendly waits for
  // DOMContentLoaded to draw anything), so call those right away.
  const lateReady = () => {
    const add = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, fn, opts) {
      const missed = fn && ((this === document && type === 'DOMContentLoaded' && document.readyState !== 'loading') ||
        (this === window && type === 'load' && document.readyState === 'complete'));
      if (missed) {
        const target = this;
        setTimeout(() => {
          try { typeof fn === 'function' ? fn.call(target, new Event(type)) : fn.handleEvent(new Event(type)); }
          catch (e) { setTimeout(() => { throw e; }); }
        }, 0);
      }
      return add.call(this, type, fn, opts);
    };
    return () => { EventTarget.prototype.addEventListener = add; };
  };

  // While the fixed copy runs, document.currentScript points at its original
  // tag, as it would have: some scripts read settings from their own tag or
  // only start when they see it (Blazor, in iCab's own screen)
  const asCurrent = (el) => {
    if (!el) return () => {};
    try { Object.defineProperty(document, 'currentScript', { configurable: true, get: () => el }); }
    catch (e) { return () => {}; }
    return () => { try { delete document.currentScript; } catch (e) {} };
  };

  // Blazor apps (iCab's own screen) load blazor.*.js with autostart="false"
  // and call Blazor.start() themselves right after. That call failed while
  // the file couldn't be parsed, so make it once the fixed copy has run.
  const startBlazor = (el) => {
    if (!/\/blazor\.[\w.]*\.js(\?|$)/i.test(el.src)) return;
    const B = window.Blazor;
    if (el.getAttribute('autostart') !== 'false') { smlog('Blazor tag autostart=' + el.getAttribute('autostart') + ', Blazor ' + typeof B); return; }
    if (!B || typeof B.start !== 'function' || B.__smStarted) return;
    B.__smStarted = 1;
    try {
      const p = B.start();
      smlog('started Blazor (its start call failed before the fix)');
      if (p && p.catch) p.catch((e) => smlog('Blazor start failed: ' + (e && e.message || e)));
    } catch (e) { smlog('Blazor start failed: ' + (e && e.message || e)); }
  };

  const run = (code, label, el) => {
    const undoCs = asCurrent(el);
    const undoReady = lateReady();
    const undo = () => { undoCs(); undoReady(); };
    let done;
    try { done = bridge ? bridge.postMessage({ op: 'eval', code: code + '\n;void 0;' }) : Promise.resolve((0, eval)(code)); }
    catch (e) { done = Promise.reject(e); }
    return done.then(() => { undo(); smlog('re-ran fixed script: ' + label); }, (e) => { undo(); smlog('fixed script failed: ' + label + ': ' + (e && e.message || e)); });
  };

  const scan = async (onlyUrl) => {
    pending = false;
    const list = [...document.querySelectorAll('script')].filter((s) => isClassic(s) && !handled.has(s));
    for (const s of list) {
      if (onlyUrl && s.src !== onlyUrl) continue;
      handled.add(s);
      // each file at most once, even if it shows up again
      if (s.src) { if (doneUrls.has(s.src)) continue; doneUrls.add(s.src); }
      try {
        if (s.src) {
          if (/^(data|blob|javascript):/i.test(s.src)) continue;
          const fixed = await getFixed(s.src);
          if (fixed) {
            await run(fixed, s.src.split('/').pop().split('?')[0], s);
            startBlazor(s);
          }
          else if (onlyUrl) smlog('no known fix for ' + s.src.split('/').pop().split('?')[0]);
        } else {
          const fixed = fixScript(s.textContent || '');
          if (fixed) await run(fixed, 'inline script', s);
        }
      } catch (e) { /* not parseable by us either; leave it */ }
    }
  };

  // Listen from the very start (parse errors happen early), act once the
  // site's mode is known and allows it
  const schedule = (url) => {
    if (!ready) { pending = true; if (url) waiting.add(url); else waiting.add(null); return; }
    config.then(() => { if (getLevel() < 1) setTimeout(() => scan(url || null), 0); });
  };

  // A file from another site that Safari can't parse shows up only as
  // "Script error.", without its name (Calendly's booking bundle). Safari
  // runs a script and fires its "load" right after, with nothing in between,
  // so a hidden error just before a script's "load" came from that script
  // (or from a normal error while it ran: then the check finds nothing to fix).
  let hidden = false;
  document.addEventListener('load', (e) => {
    const t = e.target;
    if (!t || t.localName !== 'script') return;
    if (hidden && t.src && isClassic(t)) schedule(t.src);
    hidden = false;
  }, true);

  window.addEventListener('error', (e) => {
    if (e.target && e.target !== window) { hidden = false; return; }   // resource load errors
    const msg = String(e.message || '');
    if (!e.filename && /^Script error\.?$/i.test(msg)) { hidden = true; return; }
    // Only clear syntax errors in a named file. A generic cross-site
    // "Script error." is usually a normal runtime error, and checking every
    // script on the page for it is too costly on big sites.
    if (!/SyntaxError/i.test(msg) || !e.filename || e.filename === location.href) return;
    schedule(e.filename);
  }, true);

  const onReady = () => {
    ready = true;
    if (!pending) return;
    config.then(async () => {
      if (getLevel() >= 1) return;
      if (waiting.has(null)) return scan(null);
      for (const u of waiting) await scan(u);
    });
  };
  if (!ready) document.addEventListener('DOMContentLoaded', onReady);
}
