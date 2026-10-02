// Web API shims that core-js does not cover, for Safari 15.1
(function () {
  var w = window;

  // AbortSignal helpers (Safari 15.4 / 16 / 17.4)
  if (w.AbortSignal) {
    var AS = w.AbortSignal;
    if (!AS.prototype.throwIfAborted) {
      AS.prototype.throwIfAborted = function () {
        if (this.aborted) throw this.reason !== undefined ? this.reason : new DOMException('Aborted', 'AbortError');
      };
    }
    if (!AS.timeout) {
      AS.timeout = function (ms) {
        var c = new AbortController();
        setTimeout(function () { c.abort(new DOMException('Timed out', 'TimeoutError')); }, ms);
        return c.signal;
      };
    }
    if (!AS.any) {
      AS.any = function (signals) {
        var c = new AbortController();
        for (var i = 0; i < signals.length; i++) {
          var s = signals[i];
          if (s.aborted) { c.abort(s.reason); return c.signal; }
          s.addEventListener('abort', (function (s) { return function () { c.abort(s.reason); }; })(s), { once: true });
        }
        return c.signal;
      };
    }
  }

  // crypto.randomUUID (Safari 15.4)
  if (w.crypto && !w.crypto.randomUUID) {
    w.crypto.randomUUID = function () {
      var b = w.crypto.getRandomValues(new Uint8Array(16));
      b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
      var h = Array.prototype.map.call(b, function (x) { return (x + 0x100).toString(16).slice(1); }).join('');
      return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
    };
  }

  // requestIdleCallback and scheduler are left out on purpose: Safari 18.6
  // (the browser the tweak tells sites it is) doesn't have them either, and
  // a stand-in that fires early changes the order sites like Gemini start up.

  // form.requestSubmit (Safari 16)
  if (w.HTMLFormElement && !HTMLFormElement.prototype.requestSubmit) {
    HTMLFormElement.prototype.requestSubmit = function (submitter) {
      if (submitter) { submitter.click(); return; }
      var b = document.createElement('input');
      b.type = 'submit'; b.hidden = true;
      this.appendChild(b); b.click(); this.removeChild(b);
    };
  }

  // Element.checkVisibility (Safari 17.4)
  if (w.Element && !Element.prototype.checkVisibility) {
    Element.prototype.checkVisibility = function () {
      if (!this.isConnected) return false;
      var s = getComputedStyle(this);
      return s.display !== 'none' && s.visibility !== 'hidden' && this.getClientRects().length > 0;
    };
  }

  // RegExp lookbehind (Safari 16.4). Patterns built at runtime with
  // new RegExp("(?<!x)y") throw on Safari 15. Retry with the lookbehind
  // parts removed: the pattern then matches a little more loosely, which
  // beats crashing the whole page script.
  (function () {
    var Orig = w.RegExp;
    try { new Orig('(?<=a)b'); return; } catch (e) {}
    function stripLookbehind(p) {
      var out = '', i = 0, inClass = false;
      while (i < p.length) {
        var c = p[i];
        if (c === '\\') { out += p.substr(i, 2); i += 2; continue; }
        if (inClass) { if (c === ']') inClass = false; out += c; i++; continue; }
        if (c === '[') { inClass = true; out += c; i++; continue; }
        if (c === '(' && p[i + 1] === '?' && p[i + 2] === '<' && (p[i + 3] === '=' || p[i + 3] === '!')) {
          var depth = 0, j = i, cls = false;
          for (; j < p.length; j++) {
            var d = p[j];
            if (d === '\\') { j++; continue; }
            if (cls) { if (d === ']') cls = false; continue; }
            if (d === '[') { cls = true; continue; }
            if (d === '(') depth++;
            else if (d === ')') { depth--; if (depth === 0) break; }
          }
          i = j + 1;
          continue;
        }
        out += c; i++;
      }
      return out;
    }
    // "(?<=x)" alone (split after each x, keeping x): emulate exactly,
    // since dropping it would leave an empty pattern that splits every character.
    var ONLY_LB = /^\(\?<=((?:[^()\[\]|*+?{}\\]|\\.)+)\)$/;
    function splitAfter(inner, flags) {
      var g = new Orig(inner, (flags || '').replace(/[gyv]/g, '') + 'g');
      var re = new Orig('(?!)', (flags || '').replace(/[v]/g, ''));
      Object.defineProperty(re, Symbol.split, { value: function (str, limit) {
        str = String(str); var out = [], last = 0, m; g.lastIndex = 0;
        while ((m = g.exec(str))) {
          if (m[0] === '') { g.lastIndex++; continue; }
          var end = m.index + m[0].length;
          if (end >= str.length) break;
          out.push(str.slice(last, end)); last = end;
        }
        out.push(str.slice(last));
        return limit === undefined ? out : out.slice(0, limit >>> 0);
      } });
      return re;
    }
    function retry(args) {
      var p = args[0], f = args[1];
      if (p instanceof Orig) { if (f === undefined) f = p.flags; p = p.source; }
      p = p === undefined ? '' : String(p);
      var changed = false;
      if (/\(\?<[=!]/.test(p)) { p = stripLookbehind(p); changed = true; }
      if (typeof f === 'string' && f.indexOf('v') !== -1) { f = f.replace('v', f.indexOf('u') === -1 ? 'u' : ''); changed = true; }
      return changed ? [p, f] : null;
    }
    try {
      w.RegExp = new Proxy(Orig, {
        construct: function (t, args, nt) {
          try { return Reflect.construct(t, args, nt); }
          catch (e) {
            var lb = typeof args[0] === 'string' && ONLY_LB.exec(args[0]);
            if (lb) return splitAfter(lb[1], args[1]);
            var r = retry(args); if (r) return Reflect.construct(t, r, nt); throw e;
          }
        },
        apply: function (t, self, args) {
          try { return Reflect.apply(t, self, args); }
          catch (e) {
            var lb = typeof args[0] === 'string' && ONLY_LB.exec(args[0]);
            if (lb) return splitAfter(lb[1], args[1]);
            var r = retry(args); if (r) return Reflect.apply(t, self, r); throw e;
          }
        }
      });
    } catch (e) {}
  })();

  // Safari 15.1 has <dialog> but no "top layer": a modal dialog can end up
  // under the page's fixed menus and bars. Lift it above them and add a
  // backdrop while it's open.
  (function () {
    if (typeof w.HTMLDialogElement === 'undefined' || !HTMLDialogElement.prototype.showModal) return;
    if (!HTMLDialogElement.prototype.requestClose) {
      // Safari 18.4: close as if Escape was pressed (the page may cancel it)
      HTMLDialogElement.prototype.requestClose = function (rv) {
        if (!this.open) return;
        if (this.dispatchEvent(new Event('cancel', { cancelable: true }))) this.close(rv);
      };
    }
    try { document.createElement('dialog').matches(':modal'); return; } catch (e) {}
    var proto = HTMLDialogElement.prototype, show = proto.showModal, close = proto.close;
    var lower = function (d) {
      if (d.__lsBd) { d.__lsBd.remove(); d.__lsBd = null; }
      if (d.__lsZ) { d.style.removeProperty('z-index'); d.__lsZ = 0; }
    };
    proto.showModal = function () {
      var r = show.apply(this, arguments);
      try {
        if (getComputedStyle(this).zIndex === 'auto') { this.style.setProperty('z-index', '2147483646'); this.__lsZ = 1; }
        if (!this.__lsBd && this.parentNode) {
          var bd = document.createElement('div');
          bd.setAttribute('data-ls15-backdrop', '');
          bd.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;background:rgba(0,0,0,.45);z-index:2147483645';
          this.parentNode.insertBefore(bd, this);
          this.__lsBd = bd;
          var self = this;
          this.addEventListener('close', function once() { self.removeEventListener('close', once); lower(self); });
        }
      } catch (e) {}
      return r;
    };
    proto.close = function () { var r = close.apply(this, arguments); lower(this); return r; };
  })();

  // Minimal <dialog> support (Safari 15.4)
  if (typeof w.HTMLDialogElement === 'undefined') {
    var isDialog = function (el) { return el && el.localName === 'dialog'; };
    w.HTMLDialogElement = function HTMLDialogElement() { throw new TypeError('Illegal constructor'); };
    Object.defineProperty(w.HTMLDialogElement, Symbol.hasInstance, { value: isDialog });

    var css = 'dialog:not([open]){display:none!important}' +
      'dialog[open]{display:block;position:fixed;left:0;right:0;margin:auto;width:fit-content;height:fit-content;' +
      'max-width:calc(100% - 32px);max-height:calc(100% - 32px);overflow:auto;border:1px solid;padding:1em;background:Canvas;color:CanvasText;z-index:2147483646}' +
      'dialog[open][data-ls15-modal]{top:0;bottom:0}' +
      '.ls15-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:2147483645}';
    var addCss = function () {
      if (document.getElementById('ls15-dialog-css')) return;
      var st = document.createElement('style'); st.id = 'ls15-dialog-css'; st.textContent = css;
      (document.head || document.documentElement).appendChild(st);
    };
    addCss();
    document.addEventListener('DOMContentLoaded', addCss);

    var P = w.HTMLUnknownElement && HTMLUnknownElement.prototype;
    if (P) {
      Object.defineProperty(P, 'open', {
        configurable: true,
        get: function () { return this.hasAttribute('open'); },
        set: function (v) { v ? this.setAttribute('open', '') : this.removeAttribute('open'); }
      });
      Object.defineProperty(P, 'returnValue', {
        configurable: true,
        get: function () { return this.__ls15rv || ''; },
        set: function (v) { this.__ls15rv = String(v); }
      });
      P.show = function () { if (!isDialog(this)) return; this.setAttribute('open', ''); };
      P.showModal = function () {
        if (!isDialog(this)) return;
        if (this.hasAttribute('open')) return;
        this.setAttribute('open', ''); this.setAttribute('data-ls15-modal', '');
        var bd = document.createElement('div'); bd.className = 'ls15-backdrop';
        this.parentNode.insertBefore(bd, this); this.__ls15bd = bd;
        var self = this;
        this.__ls15esc = function (e) {
          if (e.key === 'Escape') {
            var ev = new Event('cancel', { cancelable: true });
            if (self.dispatchEvent(ev)) self.close();
          }
        };
        document.addEventListener('keydown', this.__ls15esc);
        var f = this.querySelector('[autofocus]') || this.querySelector('button,[href],input,select,textarea,[tabindex]');
        if (f && f.focus) f.focus();
      };
      P.close = function (rv) {
        if (!isDialog(this) || !this.hasAttribute('open')) return;
        if (rv !== undefined) this.returnValue = rv;
        this.removeAttribute('open'); this.removeAttribute('data-ls15-modal');
        if (this.__ls15bd) { this.__ls15bd.remove(); this.__ls15bd = null; }
        if (this.__ls15esc) { document.removeEventListener('keydown', this.__ls15esc); this.__ls15esc = null; }
        this.dispatchEvent(new Event('close'));
      };
      // requestClose (Safari 18.4): like pressing Escape
      P.requestClose = function (rv) {
        if (!isDialog(this) || !this.hasAttribute('open')) return;
        var ev = new Event('cancel', { cancelable: true });
        if (this.dispatchEvent(ev)) this.close(rv);
      };
      // So code checking HTMLDialogElement.prototype finds these methods
      w.HTMLDialogElement.prototype = P;
      // <form method="dialog"> closes its dialog
      document.addEventListener('submit', function (e) {
        var f = e.target;
        if (!f || (f.getAttribute('method') || '').toLowerCase() !== 'dialog') return;
        var d = f.closest('dialog');
        if (!d) return;
        e.preventDefault();
        var s = e.submitter;
        d.close(s && s.value !== undefined ? s.value : undefined);
      }, true);
    }
  }
})();
