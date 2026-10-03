import 'construct-style-sheets-polyfill';

// The stand-in only notices a whole new list (x.adoptedStyleSheets = [...]).
// In real browsers the list can also be changed in place, and many sites do
// x.adoptedStyleSheets.push(sheet) (loadout.tf): those styles were dropped.
// Hand out a list that applies in-place changes too.
(function () {
  function wrap(proto) {
    var d = proto && Object.getOwnPropertyDescriptor(proto, 'adoptedStyleSheets');
    if (!d || !d.get || !d.set || d.get.__smWrapped) return;
    var cache = new WeakMap();
    var get = function () {
      var self = this, arr = d.get.call(self);
      if (!Array.isArray(arr)) return arr;
      var c = cache.get(self);
      if (c && c.arr === arr) return c.proxy;
      var queued = false;
      var apply = function () {
        if (queued) return;
        queued = true;
        Promise.resolve().then(function () { queued = false; d.set.call(self, Array.from(arr)); });
      };
      var proxy = new Proxy(arr, {
        set: function (t, k, v) { t[k] = v; apply(); return true; },
        deleteProperty: function (t, k) { delete t[k]; apply(); return true; }
      });
      cache.set(self, { arr: arr, proxy: proxy });
      return proxy;
    };
    get.__smWrapped = true;
    Object.defineProperty(proto, 'adoptedStyleSheets', { configurable: true, enumerable: true, get: get, set: d.set });
  }
  try { wrap(Document.prototype); } catch (e) {}
  try { if (window.ShadowRoot) wrap(ShadowRoot.prototype); } catch (e) {}
})();
