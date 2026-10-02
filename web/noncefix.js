// Work around Safari 15.1 refusing scripts that carry the page's correct
// nonce. Seen on YouTube and Gemini: Safari 15.1 rejects nonces containing
// "-" or "_" (valid in the standard) and mishandles several policies sent in
// one header. The site authorised these scripts; Safari just fails to match.
//
// At the first script with a nonce, test once: does a script with this
// nonce actually run? If not, every inline script that carries exactly the
// page's nonce is run by the tweak itself, in page order. Scripts without the
// page's nonce are never run, so protection against injected code stays.
import { smlog } from './debug.js';
import { getLevel } from './safety.js';

let pageNonce = '';
let broken = null;          // null = not tested yet
let evalOK = null;
let count = 0;
const bridge = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.__smcss;
const nativeAppend = Node.prototype.appendChild;
const nativeRemove = Node.prototype.removeChild;

const isClassicJS = (s) => {
  const t = (s.getAttribute('type') || '').trim().toLowerCase();
  return !t || t === 'text/javascript' || t === 'application/javascript' || t === 'text/ecmascript' || t === 'application/ecmascript';
};
const nonceOf = (s) => s.nonce || s.getAttribute('nonce') || '';

function test() {
  if (broken !== null || !pageNonce) return broken;
  try {
    window.__smNonceProbe = 0;
    const p = document.createElement('script');
    p.setAttribute('nonce', pageNonce);
    p.__smProbe = 1;
    p.text = 'window.__smNonceProbe=1';
    const parent = document.head || document.documentElement;
    nativeAppend.call(parent, p);
    broken = window.__smNonceProbe !== 1;
    nativeRemove.call(parent, p);
  } catch (e) { broken = false; }
  if (broken) {
    try { evalOK = (0, eval)('1') === 1; } catch (e) { evalOK = false; }
    smlog('Safari refuses this site\'s own script nonce' + (/[-_]/.test(pageNonce) ? ' (it contains - or _)' : '') +
      '; the tweak runs the site\'s nonce-carrying scripts itself' + (evalOK ? '' : ' (through the native side)'));
  }
  return broken;
}

// Scripts the tweak runs itself go through one queue, so they keep the
// page's order even when one has to be downloaded first.
const queue = [];
let busy = false;
function enqueue(job) { queue.push(job); pump(); }
async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) { const j = queue.shift(); try { await j(); } catch (e) {} }
  busy = false;
}
function evalCode(code, s, name) {
  if (evalOK) {
    let cs = false;
    try { Object.defineProperty(document, 'currentScript', { configurable: true, get: () => s }); cs = true; } catch (e) {}
    try { (0, eval)(code + '\n//# sourceURL=' + name); }
    catch (e) { smlog('site script failed: ' + e.name + ': ' + String(e.message).slice(0, 120)); setTimeout(() => { throw e; }); }
    finally { if (cs) try { delete document.currentScript; } catch (e) {} }
    return Promise.resolve();
  }
  if (!bridge) return Promise.resolve();
  try { return bridge.postMessage({ op: 'eval', code: code + '\n;void 0;' }).catch(() => {}); } catch (e) { return Promise.resolve(); }
}

// Script files the site allowed with its nonce but Safari's nonce bug
// refuses (Google's account menu and sign-in pages): the tweak downloads and
// runs them, in page order. Only when the refusal came from the nonce policy
// alone: if another of the site's policies (a host allowlist) also refused
// the file, it is left alone.
const origin = (u) => { try { return new URL(u, location.href).origin; } catch (e) { return ''; } };
const refusals = new Map();   // origin -> [policy text of each refusal]
const nonceOnly = (url, n) => {
  const list = refusals.get(origin(url)) || [];
  return !!n && list.length > 0 && list.every((pol) => pol.indexOf("'nonce-" + n + "'") !== -1);
};
let extLogged = 0;
async function download(url) {
  try {
    if (bridge) {
      const r = await bridge.postMessage({ op: 'get', kind: 'jsraw', url });
      return r && r.raw != null ? r.raw : null;
    }
    return await fetch(url, { credentials: 'omit' }).then((r) => (r.ok ? r.text() : null));
  } catch (e) { return null; }
}
async function runFile(s) {
  const code = await download(s.src);
  if (code == null) { smlog('could not download refused script ' + s.src.replace(/^https?:\/\//, '').slice(0, 90)); return false; }
  await evalCode(code, s, s.src);
  if (!extLogged++) smlog('ran script files Safari refused despite the site\'s nonce (' + s.src.replace(/^https?:\/\//, '').slice(0, 60) + ')');
  return true;
}
const pageNonceFor = (s) => {
  if (getLevel() >= 4 || s.__smRan || !s.src || !isClassicJS(s)) return false;
  const n = nonceOf(s);
  if (!n) return false;
  if (!pageNonce) pageNonce = n;
  return n === pageNonce && !!test();
};

// Script files the page adds itself (module loaders): once Safari has shown
// it refuses this site's files only over the nonce, don't let it try. Hold
// the file, run it, then report "load" like the browser would.
export function interceptExternal(s) {
  if (!pageNonceFor(s) || !nonceOnly(s.src, pageNonce)) return false;
  s.__smRan = 1;
  const type = s.getAttribute('type');
  s.setAttribute('type', 'text/sm-held');
  enqueue(async () => {
    const ok = await runFile(s);
    if (type == null) s.removeAttribute('type'); else s.setAttribute('type', type);
    try { s.dispatchEvent(new Event(ok ? 'load' : 'error')); } catch (e) {}
  });
  return true;
}

// Script files in the page's HTML: keep the queue in page order. Wait for
// the file's outcome before running later inline scripts.
function gateParserFile(s) {
  if (document.readyState !== 'loading' || s.async || s.defer || !pageNonceFor(s)) return;
  s.__smGate = 1;
  enqueue(() => new Promise((resolve) => {
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(); } };
    s.addEventListener('load', fin, { once: true });
    s.addEventListener('error', () => {
      setTimeout(async () => {
        if (!s.__smRan && nonceOnly(s.src, nonceOf(s))) { s.__smRan = 1; await runFile(s); }
        fin();
      }, 150);
    }, { once: true });
    setTimeout(fin, 8000);
  }));
}

function runOne(s) {
  if (s.__smRan || s.__smProbe) return;
  s.__smRan = 1;
  const code = s.text || '';
  if (!code.trim()) return;
  count++;
  if (busy || queue.length || !evalOK) {
    const name = location.href.split('#')[0] + '#inline-' + count;
    enqueue(() => evalCode(code, s, name));
    return;
  }
  if (evalOK) {
    // Scripts may read document.currentScript (for data-* settings on the tag)
    let cs = false;
    try { Object.defineProperty(document, 'currentScript', { configurable: true, get: () => s }); cs = true; } catch (e) {}
    try { (0, eval)(code + '\n//# sourceURL=' + location.href.split('#')[0] + '#inline-' + count); }
    catch (e) {
      // Text still arriving: try again once the parser has moved past it
      if (e instanceof SyntaxError && document.readyState === 'loading' && !s.__smRetry) {
        s.__smRetry = 1; s.__smRan = 0; count--;
        pending.unshift(s);
        return;
      }
      smlog('site script failed: ' + e.name + ': ' + String(e.message).slice(0, 120));
      setTimeout(() => { throw e; });
    } finally {
      if (cs) try { delete document.currentScript; } catch (e) {}
    }
  }
}

// Called for every script element the page gets, in order
export function nonceCandidate(s) {
  if (getLevel() >= 4 || s.__smProbe || s.__smRan) return;
  if (s.getAttribute('src') || !isClassicJS(s)) return;
  const n = nonceOf(s);
  if (!n) return;
  if (!pageNonce) pageNonce = n;
  if (n !== pageNonce) return;          // only the site's own nonce
  if (test()) runOne(s);
}

// A script from the page's HTML can be seen while its text is still
// arriving (big inline scripts come in pieces). It is complete once the
// parser has moved past it (something follows it) or the page is parsed.
const pending = [];
const closed = (s) => !!s.nextSibling || document.readyState !== 'loading' || !s.isConnected;
function flush(all) {
  while (pending.length && (all || closed(pending[0]))) {
    const s = pending.shift();
    nonceCandidate(s);
    if (pending[0] === s) break;    // text still arriving: wait for more
  }
}

export function startNonceFix() {
  // Scripts from the page's HTML: the parser has already tried (and Safari
  // refused) them by the time this sees them, so run them, in order, once
  // their text is complete.
  new MutationObserver((muts) => {
    for (let i = 0; i < muts.length; i++) {
      const added = muts[i].addedNodes;
      for (let j = 0; j < added.length; j++) {
        const n = added[j];
        if (muts[i].target && muts[i].target.localName === 'script') continue;   // more text for a script
        flush(true);    // the parser moved on: earlier scripts are complete
        if (n.nodeType === 1 && n.localName === 'script' && !n.__smSeen && !n.__smQueued) {
          n.__smQueued = 1;
          if (n.getAttribute('src')) { flush(true); gateParserFile(n); }
          else pending.push(n);
        }
      }
    }
    flush(false);
  }).observe(document, { childList: true, subtree: true });
  // Safari reports the refusal right after it tried the whole script
  document.addEventListener('securitypolicyviolation', () => flush(false), true);
  document.addEventListener('securitypolicyviolation', (e) => {
    if (e.disposition === 'report' || !e.blockedURI || !/^https?:/.test(e.blockedURI)) return;
    const o = origin(e.blockedURI);
    if (!refusals.has(o)) refusals.set(o, []);
    refusals.get(o).push(String(e.originalPolicy || ''));
  }, true);
  // Other refused files (async ones, or added before the tweak knew)
  window.addEventListener('error', (e) => {
    const t = e.target;
    if (!t || t.localName !== 'script' || !t.src || t.__smGate || t.__smRan || broken === false) return;
    setTimeout(() => {
      if (t.__smRan || !nonceOnly(t.src, nonceOf(t)) || !pageNonceFor(t)) return;
      t.__smRan = 1;
      enqueue(async () => { if (await runFile(t)) { try { t.dispatchEvent(new Event('load')); } catch (x) {} } });
    }, 150);
  }, true);
  document.addEventListener('DOMContentLoaded', () => flush(true));
}
