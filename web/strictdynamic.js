// CSP 'strict-dynamic' (Safari 15.4) plus script tracking.
//
// Sites like Reddit, YouTube and Gemini allow scripts only if they carry the
// page's nonce, plus 'strict-dynamic': "scripts that trusted code adds are
// trusted too". Safari 15.1 ignores 'strict-dynamic', so scripts the site's
// own code adds get blocked. When page code inserts a <script> without a
// nonce, give it the page's nonce, which is what 'strict-dynamic' amounts to.
// Scripts written into the page's HTML are left alone.
//
// Same-origin frames (about:blank helpers that sites create to load code)
// share the page's security policy but have their own DOM functions, so
// they get the same treatment when the page first touches them.
//
// Tracking: every script the page runs is reported to the freeze watchdog as
// a "stage" while it runs, so a freeze can name the script that caused it.
// The last few inserted scripts are kept for the log.
import { smlog } from './debug.js';
import { getLevel, stageStart, stageEnd } from './safety.js';
import { nonceCandidate, interceptExternal } from './noncefix.js';

const recent = [];
export const recentScripts = () => recent.slice();

const short = (u) => String(u).replace(/^https?:\/\//, '').replace(/\?.*$/, (q) => (q.length > 30 ? q.slice(0, 30) + '…' : q)).slice(0, 110);

let count = 0, cachedNonce = '';
function pageNonce() {
  if (cachedNonce) return cachedNonce;
  const s = document.querySelector('script[nonce]');
  if (!s) return '';
  cachedNonce = s.nonce || s.getAttribute('nonce') || '';
  return cachedNonce;
}

// Track an external script from insertion until it has run (load/error).
// Downloading doesn't stop the heartbeat, so only running can show up as a freeze.
const tracked = new WeakSet();
function trackExternal(el, how) {
  if (tracked.has(el)) return;
  tracked.add(el);
  const name = 'script ' + short(el.src) + how;
  stageStart(name);
  let done = false;
  const end = () => { if (!done) { done = true; stageEnd(name); } };
  el.addEventListener('load', end, { once: true });
  el.addEventListener('error', end, { once: true });
  setTimeout(end, 60000);   // never keep a stage open forever
}

function note(el, tagged) {
  const ext = !!el.getAttribute('src');
  recent.push({
    t: Date.now(),
    what: ext ? short(el.src) : 'inline (' + (el.text || '').length + ' chars) «' + (el.text || '').slice(0, 50).replace(/\s+/g, ' ') + '»',
    type: el.type || 'classic',
    nonce: tagged ? 'given page nonce' : (el.getAttribute('nonce') || el.nonce ? 'had nonce' : 'no nonce'),
  });
  if (recent.length > 12) recent.shift();
}

function tag(el) {
  const had = el.getAttribute('nonce') || el.nonce;
  let tagged = false;
  if (!had && getLevel() < 4) {
    const n = pageNonce();
    if (n) {
      el.setAttribute('nonce', n);
      tagged = true;
      if (count++ === 0) smlog("gave the page nonce to scripts it adds ('strict-dynamic' support)");
    }
  }
  note(el, tagged);
  return el;
}

// Returns the inline scripts in what's being inserted (they run right away)
function prepare(node) {
  const inline = [];
  if (!node || (node.nodeType !== 1 && node.nodeType !== 11)) return inline;
  const one = (s) => {
    if (s.__smSeen) return;
    s.__smSeen = 1;
    tag(s);
    if (s.getAttribute('src')) { if (!interceptExternal(s)) trackExternal(s, ''); }
    else inline.push(s);
  };
  if (node.nodeType === 1 && node.localName === 'script') one(node);
  else if (node.querySelectorAll) {
    const list = node.querySelectorAll('script');
    for (let i = 0; i < list.length; i++) one(list[i]);
  }
  return inline;
}

function install(win) {
  try {
    if (win.__smSD) return;
    win.__smSD = 1;
  } catch (e) { return; }
  const wrap = (proto, name, pick) => {
    const orig = proto && proto[name];
    if (typeof orig !== 'function') return;
    proto[name] = function () {
      let inline = [];
      try { pick(arguments).forEach((n) => { inline = inline.concat(prepare(n)); }); } catch (e) {}
      if (!inline.length) return orig.apply(this, arguments);
      // inline scripts run during this call: track it
      const s = inline[0];
      const name2 = 'inline script (' + (s.text || '').length + ' chars) «' + (s.text || '').slice(0, 60).replace(/\s+/g, ' ') + '»';
      stageStart(name2);
      try { return orig.apply(this, arguments); }
      finally {
        stageEnd(name2);
        // If Safari refused them despite the page's nonce, run them now
        inline.forEach((sc) => { try { if (sc.isConnected) nonceCandidate(sc); } catch (e) {} });
      }
    };
  };
  const first = (a) => [a[0]];
  const all = (a) => Array.prototype.slice.call(a);
  const second = (a) => [a[1]];
  const N = win.Node, E = win.Element, F = win.DocumentFragment, D = win.Document;
  wrap(N.prototype, 'appendChild', first);
  wrap(N.prototype, 'insertBefore', first);
  wrap(N.prototype, 'replaceChild', first);
  ['append', 'prepend', 'before', 'after', 'replaceWith', 'replaceChildren'].forEach((m) => {
    wrap(E.prototype, m, all);
    if (F) wrap(F.prototype, m, all);
    if (D) wrap(D.prototype, m, all);
  });
  wrap(E.prototype, 'insertAdjacentElement', second);

  // Same-origin child frames: patch them the first time the page reaches in
  const IF = win.HTMLIFrameElement && win.HTMLIFrameElement.prototype;
  if (IF) {
    ['contentWindow', 'contentDocument'].forEach((prop) => {
      const d = Object.getOwnPropertyDescriptor(IF, prop);
      if (!d || !d.get) return;
      Object.defineProperty(IF, prop, {
        configurable: true, enumerable: d.enumerable,
        get: function () {
          const v = d.get.call(this);
          try {
            const w = prop === 'contentWindow' ? v : (v && v.defaultView);
            if (w && !w.__smSD && w.document) install(w);
          } catch (e) { /* cross-origin: leave alone */ }
          return v;
        },
      });
    });
  }
}

export function startStrictDynamic() {
  install(window);
  // Scripts from the page's own HTML: track while they run (parser adds them
  // one at a time, before they execute)
  new MutationObserver((muts) => {
    for (let i = 0; i < muts.length; i++) {
      const added = muts[i].addedNodes;
      for (let j = 0; j < added.length; j++) {
        const n = added[j];
        if (n.nodeType === 1 && n.localName === 'script' && n.getAttribute('src') && !n.__smSeen) {
          n.__smSeen = 1;
          trackExternal(n, ' (from page HTML)');
        }
      }
    }
  }).observe(document, { childList: true, subtree: true });
}
