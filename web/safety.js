// Freeze protection, page side.
// - Sends a heartbeat to the tweak's native side every 2 seconds. If a page
//   stops sending them, the native side knows the page froze.
// - Reports which heavy step is running ("stage"), so a freeze can be
//   traced to the step that caused it.
// - Fetches this site's safe-mode level before the heavy features start.
//   0 = everything on, 1 = heavy runtime helpers off, 2 = also CSS rewriting
//   and module loader off, 3 = only the basic polyfills and script nonces,
//   4 = off (the tweak does nothing on this site except this log).
//   Level 4 is mirrored into the site's localStorage so the polyfills, which
//   start before the native side can answer, can skip themselves too.

const bridge = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.__smcss;
const host = location.host;
const top = window.top === window;

let level = 0;
export const getLevel = () => level;
let realUA = false;
export const getRealUA = () => realUA;

const post = (msg) => { if (!bridge) return; try { bridge.postMessage(msg).catch(() => {}); } catch (e) {} };

let open = 0;
const where = top ? '' : ' [in frame ' + host + ']';
export function stageStart(name) { open++; post({ op: 'stage', host, name: (String(name) + where).slice(0, 200), phase: 'start' }); }
export function stageEnd(name) { open = Math.max(0, open - 1); post({ op: 'stage', host, name: (String(name) + where).slice(0, 200), phase: 'end' }); }

// Run fn as a tracked stage; slow steps also go to the log
export function timed(name, fn, log) {
  const t0 = Date.now();
  stageStart(name);
  try { return fn(); }
  finally {
    stageEnd(name);
    const ms = Date.now() - t0;
    if (ms > 300 && log) log('slow step (' + ms + ' ms): ' + name);
  }
}

export const config = (() => {
  if (!bridge) return Promise.resolve({ safe: 0, notes: [] });
  return bridge.postMessage({ op: 'cfg', host }).then((c) => {
    level = (c && +c.safe) || 0;
    realUA = !!(c && c.realUA);
    syncOff(level);
    return c || { safe: 0 };
  }, () => ({ safe: 0 }));
})();

export function startHeartbeat() {
  if (!bridge || !top) return;
  const beat = () => post({ op: 'beat', host, visible: document.visibilityState === 'visible' });
  beat();
  setInterval(beat, 2000);
  document.addEventListener('visibilitychange', beat);
  window.addEventListener('pagehide', () => post({ op: 'bye', host }));
  window.addEventListener('pageshow', beat);
}

function syncOff(n) {
  try {
    if (n >= 4) localStorage.setItem('__smOff', '1');
    else if (localStorage.getItem('__smOff')) localStorage.removeItem('__smOff');
  } catch (e) {}
}
// Set early so the polyfills can see "off" before the native side answers
try { if (localStorage.getItem('__smOff') === '1') level = 4; } catch (e) {}

export function setSiteLevel(n) {
  syncOff(n);
  if (!bridge) return Promise.resolve();
  return bridge.postMessage({ op: 'setsafe', host, level: n });
}

// Per site: send Safari's real browser ID instead of the modern one
export function setSiteUA(real) {
  if (!bridge) return Promise.resolve();
  return bridge.postMessage({ op: 'setua', host, real: !!real });
}

export function recentFreezes() {
  if (!bridge) return Promise.resolve([]);
  return bridge.postMessage({ op: 'events' }).then((r) => r || [], () => []);
}
