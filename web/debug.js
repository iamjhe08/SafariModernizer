// Collects page errors and SafariModernizer notes. Add #smdebug to a page's
// address to see them in a panel (Safari 15 has no console on the phone).
import { getLevel, setSiteLevel, recentFreezes, getRealUA, setSiteUA } from './safety.js';
import { recentScripts } from './strictdynamic.js';

const logs = [];

// Repeated messages with the same key are counted instead of repeated
const byKey = new Map();
export function smlogOnce(key, msg) {
  const e = byKey.get(key);
  if (e) { e.n++; e.msg = e.base + ' (x' + e.n + ')'; render(); return; }
  const entry = { t: Date.now(), msg: String(msg), base: String(msg), n: 1 };
  byKey.set(key, entry);
  logs.push(entry);
  if (logs.length > 200) logs.shift();
  render();
  try { console.warn('[SafariModernizer] ' + msg); } catch (x) {}
}

export function smlog(msg) {
  logs.push({ t: Date.now(), msg: String(msg) });
  if (logs.length > 200) logs.shift();
  render();
  try { console.warn('[SafariModernizer] ' + msg); } catch (e) {}
}

let panel = null;
function wanted() { return /smdebug/i.test(location.hash); }

function render() {
  if (!panel) return;
  const list = panel.querySelector('ol');
  list.textContent = '';
  logs.forEach((l) => {
    const li = document.createElement('li');
    li.textContent = l.msg;
    list.appendChild(li);
  });
}

function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch (e) {}
  ta.remove();
}

function show() {
  if (panel || !document.body) return;
  panel = document.createElement('div');
  panel.setAttribute('data-smdebug', '');
  panel.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;max-height:55vh;overflow:auto;z-index:2147483647;' +
    'background:#111;color:#eee;font:12px/1.4 -apple-system,monospace;padding:10px 10px 10px 12px;border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,.5);-webkit-user-select:text;user-select:text';
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;font-weight:600';
  head.textContent = 'SafariModernizer log';
  const x = document.createElement('button');
  x.textContent = 'Close';
  x.style.cssText = 'font:inherit;background:#333;color:#eee;border:0;border-radius:6px;padding:4px 10px';
  x.onclick = () => { panel.remove(); panel = null; };
  const copy = document.createElement('button');
  copy.textContent = 'Copy';
  copy.style.cssText = x.style.cssText + ';margin-right:6px';
  copy.onclick = () => {
    const text = logs.map((l) => l.msg).join('\n') + (fz.textContent ? '\n' + fz.textContent : '') + '\nmode ' + getLevel() + (getRealUA() ? ', real browser ID' : '') + '\n' + location.href + '\n' + navigator.userAgent;
    const done = () => { copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1500); };
    try { navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done)); } catch (e) { fallbackCopy(text, done); }
  };
  const btns = document.createElement('div');
  btns.appendChild(copy);
  btns.appendChild(x);
  head.appendChild(btns);
  const ol = document.createElement('ol');
  ol.style.cssText = 'margin:0;padding-left:18px;word-break:break-word';
  panel.appendChild(head);

  // Per-site mode: 0 = all fixes, 1-2 = lighter, 3 = basic polyfills only
  const modes = document.createElement('div');
  modes.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:0 0 8px';
  const lbl = document.createElement('span');
  lbl.textContent = 'This site:';
  modes.appendChild(lbl);
  [['Full', 0], ['Light', 1], ['Lighter', 2], ['Basic', 3], ['Off', 4]].forEach(([name, n]) => {
    const b = document.createElement('button');
    b.textContent = name + (getLevel() === n ? ' \u2713' : '');
    b.style.cssText = 'font:inherit;border:0;border-radius:6px;padding:4px 9px;background:' + (getLevel() === n ? '#2f6f4f' : '#333') + ';color:#eee';
    b.onclick = () => { setSiteLevel(n).then(() => location.reload()); };
    modes.appendChild(b);
  });
  panel.appendChild(modes);

  // Browser ID this site sees: modern (Safari 18.6) or Safari's real one
  const ids = document.createElement('div');
  ids.style.cssText = modes.style.cssText;
  const lbl2 = document.createElement('span');
  lbl2.textContent = 'Browser ID:';
  ids.appendChild(lbl2);
  [['Modern', false], ['Real', true]].forEach(([name, real]) => {
    const on = getRealUA() === real;
    const b = document.createElement('button');
    b.textContent = name + (on ? ' \u2713' : '');
    b.style.cssText = 'font:inherit;border:0;border-radius:6px;padding:4px 9px;background:' + (on ? '#2f6f4f' : '#333') + ';color:#eee';
    b.onclick = () => { setSiteUA(real).then(() => location.reload()); };
    ids.appendChild(b);
  });
  panel.appendChild(ids);

  const fz = document.createElement('div');
  fz.style.cssText = 'margin:0 0 8px;color:#f0b35a';
  panel.appendChild(fz);
  recentFreezes().then((list) => {
    if (!list || !list.length) return;
    fz.textContent = 'Recent freezes: ' + list.slice(-5).reverse().map((e) =>
      e.host + ' (running: ' + (e.stage || 'unknown') + (e.lastDone ? '; last finished: ' + e.lastDone : '') +
      (e.escalated ? '; site set to mode ' + e.level : '; mode not changed') + ')').join(' \u2022 ');
  });
  panel.appendChild(ol);
  document.body.appendChild(panel);
  render();
}

let unhandledUndefined = 0;
export function startDebug() {
  if (window.top !== window) return;
  smlog('SafariModernizer 1.0.0 on ' + location.host);
  window.addEventListener('error', (e) => {
    if (e.target && e.target !== window && e.target.tagName) {
      const t = e.target;
      const u = String(t.src || t.href || '');
      const short = /^data:/i.test(u) ? 'data: URL' : u.replace(/^https?:\/\//, '').slice(0, 140);
      const extra = t.tagName === 'SCRIPT' ? ' [type=' + (t.type || 'classic') + (t.hasAttribute('nonce') || t.nonce ? ', has nonce' : ', NO nonce') + (t.async ? ', async' : '') + ']' : '';
      smlog('failed to load ' + t.tagName.toLowerCase() + ': ' + short + extra);
      return;
    }
    const f = String(e.filename || '').split('/').pop();
    const st = e.error && e.error.stack ? ' | ' + String(e.error.stack).split('\n').slice(0, 3).join(' < ').slice(0, 300) : '';
    smlog('error: ' + e.message + (f ? ' (' + f.slice(0, 60) + ':' + e.lineno + ')' : '') + st);
  }, true);
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    if (r === undefined) { unhandledUndefined++; if (unhandledUndefined > 1) return; }
    const st = r && r.stack ? ' | ' + String(r.stack).split('\n').slice(0, 3).join(' < ') : '';
    smlog(('unhandled: ' + (r && (r.message || r.name) ? (r.name + ': ' + r.message) : String(r)) + st).slice(0, 400));
  });
  // Scripts or styles blocked by the page's security policy
  // Repeats are counted. For blocked inline code, show where it came from and
  // the scripts the page added just before.
  document.addEventListener('securitypolicyviolation', (e) => {
    const pol = String(e.originalPolicy || e.violatedDirective || '');
    const polShort = (/'nonce-/.test(pol) ? 'nonce policy' : 'allowlist policy') + (/strict-dynamic/.test(pol) ? ' + strict-dynamic' : '');
    const what = e.blockedURI ? String(e.blockedURI).replace(/^https?:\/\//, '').slice(0, 100) : 'inline code or eval';
    const from = e.sourceFile ? String(e.sourceFile).replace(/^https?:\/\//, '').slice(0, 90) + ':' + e.lineNumber + ':' + e.columnNumber : 'unknown place';
    const key = 'csp|' + e.violatedDirective + '|' + what + '|' + from;
    let msg = 'blocked (' + e.violatedDirective + ', ' + polShort + (e.disposition === 'report' ? ', report only' : '') + '): ' + what + ' from ' + from + (e.sample ? ' «' + String(e.sample).slice(0, 60) + '»' : '');
    if (!e.blockedURI && !byKey.has(key)) {
      const recentOnes = recentScripts().filter((r) => Date.now() - r.t < 3000).slice(-3);
      if (recentOnes.length) msg += ' | just added: ' + recentOnes.map((r) => r.what + ' [' + r.type + ', ' + r.nonce + ']').join(' ; ');
    }
    smlogOnce(key, msg);
  }, true);
  // How this Safari handles nonces (no values are logged)
  let nonceDone = false;
  const nonceInfo = () => { if (nonceDone) return; try {
    const sc = document.createElement('script');
    const s0 = document.querySelector('script[nonce]');
    if (!s0) return;
    nonceDone = true;
    smlog('nonce support: script.nonce ' + ('nonce' in sc ? 'yes' : 'no') + ', element.nonce ' + ('nonce' in document.createElement('div') ? 'yes' : 'no') +
      '; page nonce script: attribute ' + (s0.getAttribute('nonce') ? 'visible' : 'hidden') + ', property ' + (s0.nonce ? 'set' : 'empty'));
  } catch (x) {} };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', nonceInfo); else nonceInfo();
  const check = () => { if (wanted()) show(); };
  window.SafariModernizerDebug = show;   // bookmarklet: javascript:SafariModernizerDebug()

  // Hold two fingers still on the page for 2 seconds to open the panel
  let holdTimer = 0, startXY = null;
  document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2) { clearTimeout(holdTimer); return; }
    startXY = [e.touches[0].clientX, e.touches[0].clientY, e.touches[1].clientX, e.touches[1].clientY];
    clearTimeout(holdTimer);
    holdTimer = setTimeout(show, 2000);
  }, { passive: true, capture: true });
  document.addEventListener('touchmove', (e) => {
    if (!startXY || e.touches.length !== 2) return;
    const d = Math.abs(e.touches[0].clientX - startXY[0]) + Math.abs(e.touches[0].clientY - startXY[1]) +
              Math.abs(e.touches[1].clientX - startXY[2]) + Math.abs(e.touches[1].clientY - startXY[3]);
    if (d > 30) clearTimeout(holdTimer);
  }, { passive: true, capture: true });
  ['touchend', 'touchcancel'].forEach((t) => document.addEventListener(t, () => clearTimeout(holdTimer), { passive: true, capture: true }));

  // Components that fail to register or set up leave dead buttons behind
  try {
    const def = customElements.define;
    customElements.define = function (name) {
      try { return def.apply(this, arguments); }
      catch (e) { smlog('component ' + name + ' failed to register: ' + e.message); throw e; }
    };
  } catch (e) {}
  const report = () => {
    const missing = {};
    document.querySelectorAll('*').forEach((el) => {
      const n = el.localName;
      if (n.indexOf('-') > 0 && !customElements.get(n)) missing[n] = (missing[n] || 0) + 1;
    });
    const keys = Object.keys(missing);
    if (keys.length) smlog('components never set up (' + keys.length + '): ' + keys.slice(0, 25).map((k) => k + (missing[k] > 1 ? ' x' + missing[k] : '')).join(', '));
    else smlog('all components on the page are set up');
  };
  window.addEventListener('load', () => setTimeout(report, 4000));
  window.addEventListener('hashchange', check);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', check);
  else check();
  window.addEventListener('load', () => setTimeout(check, 500));
}
