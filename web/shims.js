// Shims for features Safari gained after 15.1 that no package covers well.
(function () {
  var w = window;

  // ---------- Declarative Shadow DOM (Safari 16.4) ----------
  // <template shadowrootmode="open"> from server-rendered web components
  // becomes a real shadow root, like modern Safari does while parsing.
  if (w.Element && !('shadowRootMode' in HTMLTemplateElement.prototype)) {
    var origAttach = Element.prototype.attachShadow;
    var desc = Object.getOwnPropertyDescriptor(Element.prototype, 'shadowRoot');
    var closedRoots = new WeakMap();
    var declarative = new WeakSet();
    // Only look for templates once a page has shown it uses them; most pages never do
    var anyDSD = false;

    var isDSD = function (t) {
      return t && t.localName === 'template' && (t.hasAttribute('shadowrootmode') || t.hasAttribute('shadowroot'));
    };
    var findTemplate = function (host) {
      if (!anyDSD) return null;
      for (var c = host.firstElementChild; c; c = c.nextElementSibling) if (isDSD(c)) return c;
      return null;
    };
    var attachFrom = function (t) {
      var host = t.parentNode;
      if (!host || host.nodeType !== 1) return null;
      if (desc.get.call(host) || closedRoots.has(host)) { t.remove(); return null; }
      var mode = (t.getAttribute('shadowrootmode') || t.getAttribute('shadowroot') || 'open').toLowerCase();
      var root;
      try {
        root = origAttach.call(host, {
          mode: mode === 'closed' ? 'closed' : 'open',
          delegatesFocus: t.hasAttribute('shadowrootdelegatesfocus') || t.hasAttribute('shadowrootdelegatefocus'),
        });
      } catch (e) { return null; }
      root.appendChild(t.content);
      t.remove();
      declarative.add(root);
      if (mode === 'closed') closedRoots.set(host, root);
      processTree(root);
      if (w.__smOnShadowRoot) { try { w.__smOnShadowRoot(root); } catch (e) {} }
      return root;
    };
    var processTree = function (node) {
      if (!node || !node.querySelectorAll) return;
      var list = node.querySelectorAll('template[shadowrootmode],template[shadowroot]');
      if (list.length) anyDSD = true;
      for (var i = 0; i < list.length; i++) if (list[i].isConnected || list[i].parentNode) attachFrom(list[i]);
    };

    Object.defineProperty(Element.prototype, 'shadowRoot', {
      configurable: true, enumerable: desc.enumerable,
      get: function () {
        var r = desc.get.call(this);
        if (r) return r;
        var t = findTemplate(this);
        if (t) { r = attachFrom(t); if (r && r.mode === 'open') return r; }
        return null;
      },
    });
    Element.prototype.attachShadow = function (init) {
      var existing = desc.get.call(this) || closedRoots.get(this);
      if (!existing) { var t = findTemplate(this); if (t) existing = attachFrom(t); }
      if (existing && declarative.has(existing)) {
        // Spec: a declarative root is handed back, emptied, to the component
        while (existing.firstChild) existing.removeChild(existing.firstChild);
        declarative.delete(existing);
        return existing;
      }
      return origAttach.call(this, init);
    };

    var html = function (target, markup) {
      target.innerHTML = markup;
      processTree(target.content || target);
    };
    if (!Element.prototype.setHTMLUnsafe) {
      Element.prototype.setHTMLUnsafe = function (m) { html(this, m); };
      if (w.ShadowRoot) ShadowRoot.prototype.setHTMLUnsafe = function (m) { html(this, m); };
    }
    if (!Document.parseHTMLUnsafe) {
      Document.parseHTMLUnsafe = function (m) {
        var d = new DOMParser().parseFromString(m, 'text/html');
        processTree(d);
        return d;
      };
    }
    Object.defineProperty(HTMLTemplateElement.prototype, 'shadowRootMode', {
      configurable: true,
      get: function () { return this.getAttribute('shadowrootmode') || ''; },
      set: function (v) { this.setAttribute('shadowrootmode', v); },
    });

    var mo = new MutationObserver(function (muts) {
      if (document.readyState === 'loading') {
        // still parsing: just note that the page uses these templates
        if (!anyDSD) for (var a = 0; a < muts.length && !anyDSD; a++) {
          var nodes = muts[a].addedNodes;
          for (var b = 0; b < nodes.length; b++) if (isDSD(nodes[b])) { anyDSD = true; break; }
        }
        return;
      }
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var n = added[j];
          if (n.nodeType !== 1) continue;
          if (isDSD(n)) { anyDSD = true; attachFrom(n); } else processTree(n);
        }
      }
    });
    mo.observe(document, { childList: true, subtree: true });
    var start = function () { processTree(document); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, true);
    else start();
  }

  // ---------- Custom states: :state(foo) (Safari 17.4) ----------
  // The ElementInternals polyfill only accepts the old "--foo" names; modern
  // sites use "foo". Accept both. Each state shows as a state--foo attribute,
  // which the CSS rewriter targets in place of :state(foo).
  if (w.CustomStateSet && w.CustomStateSet.isPolyfilled) {
    var P = w.CustomStateSet.prototype, origAdd = P.add, origDel = P.delete;
    var norm = function (n) { n = String(n); return /^--/.test(n) ? n : '--' + n; };
    P.add = function (n) { origAdd.call(this, norm(n)); return this; };
    P.delete = function (n) { return origDel.call(this, norm(n)); };
    P.has = function (n) { return Set.prototype.has.call(this, norm(n)); };
  }

  // ---------- BroadcastChannel (Safari 15.4) ----------
  if (!w.BroadcastChannel) {
    var channels = {};
    var BC = function (name) {
      this.name = String(name);
      this.onmessage = null;
      this._l = [];
      (channels[this.name] = channels[this.name] || []).push(this);
    };
    BC.prototype.postMessage = function (data) {
      var self = this, list = (channels[this.name] || []).slice();
      list.forEach(function (c) {
        if (c === self || c._closed) return;
        setTimeout(function () {
          var ev; try { ev = new MessageEvent('message', { data: data }); } catch (e) { ev = { type: 'message', data: data }; }
          if (typeof c.onmessage === 'function') c.onmessage(ev);
          c._l.forEach(function (f) { f.call(c, ev); });
        });
      });
      try { localStorage.setItem('__smbc__' + this.name, JSON.stringify({ d: data, t: Math.random() })); localStorage.removeItem('__smbc__' + this.name); } catch (e) {}
    };
    BC.prototype.addEventListener = function (t, f) { if (t === 'message' && f) this._l.push(f); };
    BC.prototype.removeEventListener = function (t, f) { this._l = this._l.filter(function (x) { return x !== f; }); };
    BC.prototype.close = function () { this._closed = true; var a = channels[this.name] || []; var i = a.indexOf(this); if (i > -1) a.splice(i, 1); };
    w.addEventListener('storage', function (e) {
      if (!e.key || e.key.indexOf('__smbc__') !== 0 || !e.newValue) return;
      var name = e.key.slice(8), data;
      try { data = JSON.parse(e.newValue).d; } catch (x) { return; }
      (channels[name] || []).forEach(function (c) {
        var ev; try { ev = new MessageEvent('message', { data: data }); } catch (x) { ev = { type: 'message', data: data }; }
        if (typeof c.onmessage === 'function') c.onmessage(ev);
        c._l.forEach(function (f) { f.call(c, ev); });
      });
    });
    w.BroadcastChannel = BC;
  }


  // ---------- AbortSignal.reason / abort(reason) (Safari 15.4) ----------
  if (w.AbortController && !('reason' in AbortSignal.prototype)) {
    var reasons = new WeakMap();
    var origAbort = AbortController.prototype.abort;
    AbortController.prototype.abort = function (reason) {
      if (!this.signal.aborted) reasons.set(this.signal, reason === undefined ? new DOMException('signal is aborted without reason', 'AbortError') : reason);
      return origAbort.call(this);
    };
    Object.defineProperty(AbortSignal.prototype, 'reason', {
      configurable: true,
      get: function () { return this.aborted ? (reasons.has(this) ? reasons.get(this) : new DOMException('signal is aborted without reason', 'AbortError')) : undefined; },
    });
  }

  // ---------- navigator.locks (Safari 15.4), single-page version ----------
  if (w.navigator && !navigator.locks) {
    var queues = {};
    var locks = {
      request: function (name, opts, cb) {
        if (typeof opts === 'function') { cb = opts; opts = {}; }
        opts = opts || {};
        if (opts.ifAvailable && queues[name] && queues[name].length) return Promise.resolve(cb(null));
        var q = queues[name] = queues[name] || [];
        var prev = q.length ? q[q.length - 1] : Promise.resolve();
        var run = prev.then(function () { return cb({ name: name, mode: opts.mode || 'exclusive' }); });
        var settled = run.then(function () {}, function () {});
        q.push(settled);
        settled.then(function () { var i = q.indexOf(settled); if (i > -1) q.splice(i, 1); });
        return run;
      },
      query: function () { return Promise.resolve({ held: [], pending: [] }); },
    };
    try { Object.defineProperty(navigator, 'locks', { configurable: true, value: locks }); } catch (e) {}
  }

  // ---------- for await (chunk of readableStream) (Safari 18.?) ----------
  if (w.ReadableStream && !ReadableStream.prototype[Symbol.asyncIterator]) {
    var values = function (opts) {
      var reader = this.getReader();
      var keep = opts && opts.preventCancel;
      return {
        next: function () { return reader.read(); },
        return: function (v) {
          var done = function () { try { reader.releaseLock(); } catch (e) {} return { done: true, value: v }; };
          return keep ? Promise.resolve(done()) : reader.cancel(v).then(done, done);
        },
        [Symbol.asyncIterator]: function () { return this; },
      };
    };
    ReadableStream.prototype.values = values;
    ReadableStream.prototype[Symbol.asyncIterator] = values;
  }

  // ---------- container queries: tell sites they're supported ----------
  // The tweak's CSS rewriter turns @container rules into screen-width rules.
  // Without this, sites like ChatGPT load their own container-query helper,
  // which re-parses every stylesheet (megabytes) in script and kept ChatGPT
  // on a white screen for 20+ seconds. Safari 18.6, which the tweak tells
  // sites it is, has container queries.
  try {
    var dstyle = document.createElement('div').style;
    if (dstyle && !('container' in dstyle) && w.CSSStyleDeclaration) {
      ['container', 'containerType', 'containerName'].forEach(function (p) {
        Object.defineProperty(CSSStyleDeclaration.prototype, p, { configurable: true, get: function () { return ''; }, set: function () {} });
      });
    }
  } catch (e) {}

  // ---------- navigator.userActivation (Safari 16.4) ----------
  if (w.navigator && !navigator.userActivation) {
    var everActive = false, lastActive = 0;
    var mark = function (e) { if (e.isTrusted === false) return; everActive = true; lastActive = Date.now(); };
    ['keydown', 'mousedown', 'pointerdown', 'pointerup', 'touchend'].forEach(function (t) { w.addEventListener(t, mark, true); });
    try {
      Object.defineProperty(navigator, 'userActivation', { configurable: true, value: {
        get hasBeenActive() { return everActive; },
        get isActive() { return Date.now() - lastActive < 5000; },
      } });
    } catch (e) {}
  }


  // ---------- element.nonce on every element (newer Safari) ----------
  // Pages with a strict security policy copy a script's nonce onto scripts
  // they add later. Safari 15.1 only has .nonce on some elements, so the copy
  // comes out empty and Safari blocks the new script.
  (function () {
    var protos = [w.HTMLElement && HTMLElement.prototype, w.SVGElement && SVGElement.prototype];
    var store = new WeakMap();
    protos.forEach(function (P) {
      if (!P || 'nonce' in P) return;
      Object.defineProperty(P, 'nonce', {
        configurable: true, enumerable: true,
        get: function () { return store.has(this) ? store.get(this) : (this.getAttribute('nonce') || ''); },
        set: function (v) { v = String(v); store.set(this, v); this.setAttribute('nonce', v); },
      });
    });
  })();

  // ---------- View Transitions (Safari 18) ----------
  // No animation, but the update runs and the promises resolve, so pages
  // that call it unconditionally keep working.
  if (w.document && !document.startViewTransition) {
    document.startViewTransition = function (arg) {
      var cb = typeof arg === 'function' ? arg : (arg && arg.update);
      var done = Promise.resolve().then(function () { return cb ? cb() : undefined; });
      var finished = done.then(function () {}, function () {});
      return {
        updateCallbackDone: done,
        ready: done.then(function () {}),
        finished: finished,
        skipTransition: function () {},
        types: new Set(),
      };
    };
  }
})();
