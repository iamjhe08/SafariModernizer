// ES module loader for Safari 15.1 (no import maps, no lookbehind).
// Native module scripts that fail because they import bare names like
// "react" are re-run here: sources are rewritten into functions and
// executed through the tweak's native side, which isn't blocked by the
// page's Content Security Policy. Modules that work natively are reused
// through import(), so nothing runs twice.
import { transformModule, quickScan, quickDeps, isBare } from './esm-transform.js';
import { timed } from './safety.js';
import { smlog } from './debug.js';

export function startModuleLoader(bridge) {
  if (window.__smesm) return;
  window.__smesm = 1;
  if (typeof HTMLScriptElement !== 'undefined' && HTMLScriptElement.supports && HTMLScriptElement.supports('importmap')) return;

  const R = new Map();            // url -> record
  const map = { imports: {}, scopes: {} };
  let mapRead = false;

  // ---------- import map ----------
  function normKey(k, base) {
    if (isBare(k) && !/^(\/|\.\/|\.\.\/)/.test(k)) return k;
    try { return new URL(k, base).href; } catch (e) { return k; }
  }
  function readMaps() {
    mapRead = true;
    document.querySelectorAll('script[type="importmap"]').forEach((s) => {
      let j; try { j = JSON.parse(s.textContent); } catch (e) { smlog('bad import map: ' + e.message); return; }
      const base = document.baseURI;
      const add = (src, dst) => {
        for (const k in src || {}) {
          try { dst[normKey(k, base)] = new URL(src[k], base).href; } catch (e) {}
        }
      };
      add(j.imports, map.imports);
      for (const sc in j.scopes || {}) {
        const key = new URL(sc, base).href;
        map.scopes[key] = map.scopes[key] || {};
        add(j.scopes[sc], map.scopes[key]);
      }
    });
  }
  function lookup(key, table) {
    if (Object.prototype.hasOwnProperty.call(table, key)) return table[key];
    let best = null;
    for (const p in table) if (p.endsWith('/') && key.startsWith(p) && (!best || p.length > best.length)) best = p;
    return best ? table[best] + key.slice(best.length) : null;
  }
  function resolve(spec, parent) {
    if (!mapRead) readMaps();
    const key = isBare(spec) ? spec : new URL(spec, parent).href;
    const scopes = Object.keys(map.scopes).filter((s) => parent.startsWith(s)).sort((a, b) => b.length - a.length);
    for (const s of scopes) { const r = lookup(key, map.scopes[s]); if (r) return r; }
    const r = lookup(key, map.imports);
    if (r) return r;
    if (isBare(spec)) throw new TypeError('Module name "' + spec + '" is not in the import map');
    return key;
  }

  // ---------- fetching + transforming ----------
  function decodeDataURL(url) {
    const comma = url.indexOf(',');
    const meta = url.slice(5, comma), body = url.slice(comma + 1);
    if (/;base64$/i.test(meta)) {
      const bin = atob(body);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    }
    return decodeURIComponent(body);
  }
  function getText(url, kind) {
    if (/^data:/i.test(url)) return Promise.resolve({ raw: decodeDataURL(url) });
    // kind 'jsraw' is never cached, so it always returns the file itself
    if (bridge) return bridge.postMessage({ op: 'get', kind: kind || 'js', url });
    return fetch(url).then((r) => r.text()).then((t) => ({ raw: t }));
  }
  function remember(url, info) {
    if (/^data:/i.test(url)) return;
    if (bridge) { try { bridge.postMessage({ op: 'put', kind: 'js', url, data: JSON.stringify(info) }); } catch (e) {} }
  }
  const label = (u) => (/^data:/i.test(u) ? 'data: module' : u.replace(/^https?:\/\//, '').slice(0, 100));
  // Full parse + rewrite only when the quick scan can't rule it out
  // A webpack/rspack runtime that exports __webpack_require__ and loads code
  // chunks with import(): see patchRuntimes.
  const WP_RE = /\bas\s+__webpack_require__\s*\}/;
  function analyze(src, url) {
    const res = analyze2(src, url);
    if (res && WP_RE.test(src) && /\.f\.j\s*=/.test(src)) res.wp = true;
    return res;
  }
  function analyze2(src, url) {
    const quick = timed('module scan ' + label(url), () => quickScan(src), smlog);
    if (quick) return quick;
    // Parsing a multi-MB bundle here freezes the page for many seconds
    // (ChatGPT's is 5.5 MB). Let Safari run those as they are.
    if (src.length > 1500000) {
      smlog('module too big to check here, left to Safari: ' + label(url) + ' (' + Math.round(src.length / 1024) + ' KB)');
      return quickDeps(src);
    }
    return timed('module rewrite ' + Math.round(src.length / 1024) + ' KB ' + label(url), () => transformModule(src, url), smlog);
  }
  // A module that the quick scan passed but turns out to need running here
  function ensureCode(rec) {
    if (rec.info.code) return Promise.resolve();
    const src = rec.inline != null ? Promise.resolve({ raw: rec.inline }) : getText(rec.url, 'jsraw');
    return src.then((r) => {
      const raw = r.raw != null ? r.raw : null;
      if (raw == null) throw new Error('no source for ' + label(rec.url));
      rec.info = timed('module rewrite ' + label(rec.url), () => transformModule(raw, rec.url), smlog);
    });
  }
  function info(rec) {
    if (rec.info) return Promise.resolve(rec.info);
    if (rec.inline != null) return Promise.resolve(rec.info = analyze(rec.inline, rec.url));
    return getText(rec.url).then((r) => {
      if (r && r.data) return (rec.info = JSON.parse(r.data));
      const i = analyze(r.raw, rec.url);
      remember(rec.url, i);
      return (rec.info = i);
    });
  }

  function rec(url) {
    let r = R.get(url);
    if (!r) { r = { url, deps: null, ns: null }; R.set(url, r); }
    return r;
  }

  // Load a whole graph's info (breadth-first, so import cycles can't deadlock)
  function loadOne(url) {
    const r = rec(url);
    if (r.loading) return r.loading;
    r.loading = info(r).then((i) => {
      r.deps = i.deps.map((s) => resolve(s, r.base || r.url));
      // a URL-like specifier remapped by the import map also needs us
      if (!i.needsSelf) r.remap = i.deps.some((s, k) => !isBare(s) && r.deps[k] !== new URL(s, r.base || r.url).href);
      return r.deps;
    });
    return r.loading;
  }
  async function loadGraph(url) {
    const seenUrls = new Set([url]);
    let wave = [url];
    while (wave.length) {
      const results = await Promise.all(wave.map(loadOne));
      const next = [];
      results.forEach((deps) => deps.forEach((d) => { if (!seenUrls.has(d)) { seenUrls.add(d); next.push(d); } }));
      wave = next;
    }
  }

  function needs(url, stack) {
    const r = R.get(url);
    if (r.needs != null) return r.needs;
    if (stack.has(url)) return false;
    stack.add(url);
    const v = !!(r.info.needsSelf || r.remap || r.deps.some((d) => needs(d, stack)));
    stack.delete(url);
    if (!stack.size || v) r.needs = v;
    return v;
  }

  // ---------- webpack chunk loading ----------
  // Sites like GitHub run their webpack runtime as a normal module, which
  // Safari runs itself. It loads code chunks with import(); those chunks use
  // names from the import map ("react"), which Safari 15 can't resolve, so the
  // React parts of the page (menus, settings) never load. Point the runtime's
  // chunk loader at this loader instead.
  function installChunk(wr, ns) {
    const mods = ns.__webpack_modules__ || ns.__webpack_esm_modules__ || ns.modules || {};
    for (const k in mods) if (Object.prototype.hasOwnProperty.call(mods, k)) wr.m[k] = mods[k];
    const rt = ns.__rspack_esm_runtime || ns.__webpack_esm_runtime__ || ns.runtime;
    if (typeof rt === 'function') rt(wr);
  }
  function patchRuntime(wr, base) {
    if (!wr || !wr.f || typeof wr.f.j !== 'function' || wr.__smPatched) return;
    wr.__smPatched = true;
    const orig = wr.f.j;
    const done = new Map();   // chunk id -> promise
    wr.f.j = function (id, promises) {
      if (done.has(id)) { promises.push(done.get(id)); return; }
      const before = promises.length;
      orig.call(this, id, promises);
      if (promises.length === before) return;      // already part of the runtime
      const nativeTry = promises.splice(before)[0];
      if (nativeTry && nativeTry.catch) nativeTry.catch(() => {});
      const url = new URL('./' + wr.u(id), base).href;
      const p = dynImport(url, base).then((ns) => { installChunk(wr, ns); }, (e) => { done.delete(id); throw e; });
      done.set(id, p);
      promises.push(p);
    };
    smlog('webpack chunks now load through the module loader');
  }
  function patchRuntimes() {
    R.forEach((r) => {
      if (!r.info || !r.info.wp || r.wpTried || !r.deps) return;
      if (needs(r.url, new Set())) return;     // runs through this loader already
      r.wpTried = true;
      import(r.url).then((ns) => patchRuntime(ns.__webpack_require__, r.url)).catch(() => {});
    });
  }

  // ---------- defining + running ----------
  window.__smdefine = function (url, fn) { const r = R.get(url); if (r) r.fn = fn; };

  function define(r) {
    if (r.defining) return r.defining;
    r.defining = ensureCode(r).then(() => defineNow(r));
    return r.defining;
  }
  function defineNow(r) {
    const code = r.info.code;
    return (bridge
      ? bridge.postMessage({ op: 'eval', code })
      : Promise.resolve((0, eval)(code))
    ).then(() => { if (!r.fn) throw new Error('module did not define: ' + r.url); });
  }

  function makeNs(r) {
    if (r.ns) return r.ns;
    const ns = Object.create(null);
    try { Object.defineProperty(ns, Symbol.toStringTag, { value: 'Module' }); } catch (e) {}
    return (r.ns = ns);
  }

  async function run(url) {
    const r = R.get(url);
    if (r.running && !r.finished) return r.ns;   // cycle: hand back the partly filled namespace
    if (r.done) return r.done;
    if (!r.needs) {
      r.done = import(url).catch((e) => {
        smlog('native import failed, running shimmed: ' + url.split('/').pop() + ' (' + e.message + ')');
        r.needs = true; r.done = null; return run(url);
      });
      return r.done;
    }
    r.running = true;
    const ns = makeNs(r);
    r.done = (async () => {
      const depNs = [];
      for (let k = 0; k < r.deps.length; k++) depNs[k] = await run(r.deps[k]);
      await define(r);
      const exportFn = (getters, stars) => {
        for (const k in getters) Object.defineProperty(ns, k, { get: getters[k], enumerable: true, configurable: true });
        stars.forEach((k) => {
          const src = depNs[k];
          for (const key in src) {
            if (key === 'default' || Object.prototype.hasOwnProperty.call(ns, key)) continue;
            Object.defineProperty(ns, key, { get: () => src[key], enumerable: true, configurable: true });
          }
        });
      };
      const meta = { url: r.inline != null ? document.baseURI : r.url, resolve: (s) => resolve(s, r.base || r.url) };
      const dyn = (spec) => dynImport(spec, r.base || r.url);
      await r.fn(depNs, exportFn, meta, dyn);
      r.finished = true;
      return ns;
    })();
    return r.done;
  }

  async function dynImport(spec, parent) {
    const url = resolve(String(spec), parent);
    await loadGraph(url);
    needs(url, new Set());
    return run(url);
  }

  // ---------- roots ----------
  const seen = new WeakSet();
  let inlineN = 0;

  async function root(script) {
    if (seen.has(script)) return;
    seen.add(script);
    let url;
    if (script.src) { url = script.src; if (/^data:/i.test(url)) rec(url).base = document.baseURI; }
    else {
      url = document.baseURI.split('#')[0] + '#sm-inline-' + (inlineN++);
      const r = rec(url);
      r.inline = script.textContent;
      r.base = document.baseURI;
    }
    try {
      await loadGraph(url);
      const r = R.get(url);
      if (!needs(url, new Set())) {
        // Safari ran it natively, unless this tag already failed: then it's
        // a file too big to check up front that Safari can't parse
        if (!script.__smFailed) { patchRuntimes(); return; }
        r.needs = true;
      }
      // define everything this graph needs in parallel, then run in order
      const todo = [];
      const walk = (u, s) => { if (s.has(u)) return; s.add(u); const x = R.get(u); if (x.needs) todo.push(x); x.deps.forEach((d) => walk(d, s)); };
      walk(url, new Set());
      await Promise.all(todo.map((x) => define(x).catch(() => {})));
      await run(url);
      smlog('ran module graph: ' + (script.src ? script.src.split('/').pop() : 'inline') + ' (' + todo.length + ' modules)');
      patchRuntimes();
    } catch (e) {
      const label = script.src ? (/^data:/i.test(script.src) ? 'inline data: module' : script.src.split('/').pop().slice(0, 80)) : 'inline';
      smlog('module failed: ' + label + ': ' + (e && e.message));
    }
  }

  async function scanAll() {
    const list = [...document.querySelectorAll('script[type="module"]')];
    for (const s of list) await root(s);
  }

  // Only step in when Safari can't run the page's modules itself: there is
  // an import map (Safari 16.4), or a module failed to parse. Checking every
  // module of a big app (ChatGPT: hundreds, several MB) costs many seconds.
  let active = false;
  const activate = (why) => {
    if (active) return;
    active = true;
    smlog('module loader on: ' + why);
    scanAll();
  };
  const check = () => { if (document.querySelector('script[type="importmap"]')) activate('page has an import map'); };
  window.addEventListener('error', (e) => {
    if (!e) return;
    // Safari 15 reports a module file it can't parse only as a plain "error"
    // event on its <script type="module">, with no message (loadout.tf)
    const t = e.target;
    if (t && t !== window && t.localName === 'script') {
      if (t.type === 'module' && t.src) t.__smFailed = 1;
      if (!active && t.type === 'module' && t.src) activate('a module file failed (' + t.src.split('/').pop().slice(0, 60) + ')');
      return;
    }
    if (active || !(e.error instanceof SyntaxError || /SyntaxError|Unexpected|Invalid regular expression|module specifier/i.test(String(e.message)))) return;
    if (!document.querySelector('script[type="module"]')) return;
    activate('a module failed to load (' + String(e.message).slice(0, 60) + ')');
  }, true);

  // Native module scripts run after parsing; start right after that.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', check);
  else setTimeout(check, 0);

  new MutationObserver((muts) => {
    if (document.readyState === 'loading') return;
    for (const m of muts) for (const n of m.addedNodes) {
      if (n.nodeType !== 1 || n.localName !== 'script') continue;
      if (n.type === 'importmap') activate('page added an import map');
      else if (active && n.type === 'module') root(n);
    }
  }).observe(document, { childList: true, subtree: true });
}
