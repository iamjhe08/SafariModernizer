// Runs in every page at document start. Finds stylesheets that use CSS
// Safari 15.1 can't read, rewrites them, and adds the result to the page.
// Layered styles go at the top of <head> (in layer order), unlayered
// styles go right after the original stylesheet.
import { needsFix, transformSplit, sortLayers } from './cssfix-entry.js';
import { timed } from './safety.js';
import { smlog } from './debug.js';
import { addAnchorRules, removeAnchorRules } from './anchor.js';

export function startCssFix() {
  if (window.__smcss) return;
  window.__smcss = 1;

  var bridge = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.__smcss;

  // Values for svh/dvh units (rewritten to var(--sm-svh)/var(--sm-dvh)):
  // dvh follows the visible height, svh is the smallest seen (toolbars shown).
  (function () {
    var st = document.createElement('style');
    st.setAttribute('data-smcss', '');
    var small = {};
    var big = {}, dyn = {};
    var typing = function () {
      var a = document.activeElement;
      return !!a && (a.isContentEditable || /^(input|textarea|select)$/i.test(a.localName));
    };
    var set = function () {
      var h = window.innerHeight, key = window.innerWidth > h ? 'l' : 'p';
      if (!big[key] || h > big[key]) big[key] = h;
      // The on-screen keyboard also shrinks the window: don't take that as
      // the "small viewport", or the page stays squeezed after it closes.
      if (!typing() && h > big[key] * 0.8 && (!small[key] || h < small[key])) small[key] = h;
      if (!small[key]) small[key] = big[key];
      // Same for dvh: iOS keeps the page height when the keyboard opens
      if (!typing() || !dyn[key]) dyn[key] = h;
      var t = ':root{--sm-dvh:' + (dyn[key] / 100) + 'px;--sm-svh:' + (small[key] / 100) + 'px}';
      if (st.textContent !== t) st.textContent = t;
      if (!st.isConnected) (document.head || document.documentElement).appendChild(st);
    };
    set();
    window.addEventListener('resize', set);
    if (window.visualViewport) visualViewport.addEventListener('resize', set);
    document.addEventListener('DOMContentLoaded', set);
    document.addEventListener('focusout', function () { setTimeout(set, 300); }, true);
  })();
  var linkDone = new WeakSet();
  var owned = new WeakMap();      // source element -> [our <style> elements]
  var styleOut = new WeakMap();   // inline <style> -> last text we wrote
  var layerOrder = [];            // global layer declaration order
  var sourceOrders = new Map();   // source element -> its layer names
  var anchor = null;              // marker where layer styles start

  function log(e) { try { console.warn('[SafariModernizer] CSS fix failed:', e && e.message); } catch (x) {} }

  var memo = new Map();   // same CSS text (common for repeated inline styles) is rewritten once
  function fix(css, base) {
    if (!needsFix(css)) return null;
    var key = css.length + ':' + base + ':' + css.slice(0, 200) + css.slice(-200);
    if (css.length < 200000 && memo.has(key)) return memo.get(key);
    var label = 'CSS rewrite ' + Math.round(css.length / 1024) + ' KB ' + String(base).replace(/^https?:\/\//, '').slice(0, 90);
    var out = timed(label, function () { return transformSplit(css, base); }, smlog);
    if (css.length < 200000) { if (memo.size > 200) memo.clear(); memo.set(key, out); }
    return out;
  }

  function getSheet(url) {
    if (bridge) return bridge.postMessage({ op: 'get', kind: 'css', url: url });
    return fetch(url, { credentials: 'omit' }).then(function (r) { return r.text(); }).then(function (t) { return { raw: t }; });
  }

  function remember(url, result) {
    if (!bridge) return;
    try { bridge.postMessage({ op: 'put', kind: 'css', url: url, data: result ? JSON.stringify(result) : '' }); } catch (e) {}
  }

  function makeStyle(css, media, layer) {
    var s = document.createElement('style');
    s.setAttribute('data-smcss', layer == null ? '' : layer);
    if (media) s.media = media;
    s.textContent = css;
    return s;
  }

  function own(src, el) {
    var list = owned.get(src);
    if (!list) owned.set(src, (list = []));
    list.push(el);
  }

  function dropOwned(src) {
    removeAnchorRules(src);
    var list = owned.get(src);
    if (list) list.forEach(function (e) { e.remove(); });
    owned.delete(src);
  }

  function ensureAnchor() {
    if (anchor && anchor.isConnected) return anchor;
    anchor = document.createElement('meta');
    anchor.setAttribute('data-smcss-anchor', '');
    var head = document.head || document.documentElement;
    head.insertBefore(anchor, head.firstChild);
    return anchor;
  }

  // Place each layer's CSS after the anchor, sorted by global layer order
  function placeLayers(src, result, media) {
    sourceOrders.set(src, result.order);
    recomputeOrder();
    var names = Object.keys(result.layers);
    if (!names.length) return;
    var sorted = sortLayers(layerOrder);
    var a = ensureAnchor();
    names.forEach(function (name) {
      var el = makeStyle(result.layers[name], media, name);
      var rank = sorted.indexOf(name);
      // find the first existing layer style with a higher rank
      var node = a.nextSibling, before = null;
      while (node && node.nodeType === 1 && node.hasAttribute && node.hasAttribute('data-smcss') && node.getAttribute('data-smcss') !== '') {
        if (sorted.indexOf(node.getAttribute('data-smcss')) > rank) { before = node; break; }
        node = node.nextSibling;
      }
      if (!before) before = node;
      a.parentNode.insertBefore(el, before);
      own(src, el);
    });
  }

  // Layer order follows the order sources appear in the document
  function recomputeOrder() {
    var next = [];
    var list = document.querySelectorAll('link[rel~="stylesheet" i], style:not([data-smcss])');
    for (var i = 0; i < list.length; i++) {
      var o = sourceOrders.get(list[i]);
      if (o) o.forEach(function (n) { if (next.indexOf(n) === -1) next.push(n); });
    }
    sourceOrders.forEach(function (o, el) {
      if (!el.isConnected) { sourceOrders.delete(el); return; }
      o.forEach(function (n) { if (next.indexOf(n) === -1) next.push(n); });
    });
    layerOrder = next;
  }

  function reorderLayers() {
    if (!anchor || !anchor.isConnected) return;
    var sorted = sortLayers(layerOrder);
    var els = [], node = anchor.nextSibling;
    while (node && node.nodeType === 1 && node.hasAttribute('data-smcss') && node.getAttribute('data-smcss') !== '') {
      els.push(node); node = node.nextSibling;
    }
    els.sort(function (x, y) { return sorted.indexOf(x.getAttribute('data-smcss')) - sorted.indexOf(y.getAttribute('data-smcss')); });
    var ref = node;
    els.forEach(function (e) { anchor.parentNode.insertBefore(e, ref); });
  }

  function apply(link, result) {
    dropOwned(link);
    if (!result || !link.isConnected) return;
    if (result.anchors) addAnchorRules(result.anchors, link);
    placeLayers(link, result, link.media);
    reorderLayers();
    if (result.rest && result.rest.trim()) {
      var s = makeStyle(result.rest, link.media, null);
      link.insertAdjacentElement('afterend', s);
      own(link, s);
    }
  }

  function handleLink(link) {
    if (linkDone.has(link)) return;
    if (!/(^|\s)stylesheet(\s|$)/i.test(link.rel || '') || !link.href) return;
    if (!/^https?:/i.test(link.href)) return;
    linkDone.add(link);
    var url = link.href;
    getSheet(url).then(function (r) {
      if (!r) return;
      var result;
      if (r.data != null) {
        result = r.data ? JSON.parse(r.data) : null;
      } else {
        result = fix(r.raw, url);
        remember(url, result);
      }
      if (result) apply(link, result);
    }).catch(log);
  }

  // A <style> in the page's HTML can be seen while its text is still
  // arriving. Wait until the parser has moved past it.
  var waiting = new Set();
  var tried = new WeakMap();
  function streaming(st) {
    return document.readyState === 'loading' && !st.nextSibling && st.parentNode &&
      (st.parentNode === document.head || st.parentNode === document.body);
  }
  function recheck() {
    Array.from(waiting).forEach(function (st) { if (!streaming(st)) { waiting.delete(st); handleStyle(st); } });
  }

  function handleStyle(st) {
    if (st.hasAttribute('data-smcss')) return;
    var text = st.textContent;
    if (!text || styleOut.get(st) === text) return;
    if (streaming(st)) { waiting.add(st); return; }
    if (document.readyState === 'loading' && tried.get(st) === text) { waiting.add(st); return; }
    try {
      var result = fix(text, document.baseURI);
      if (!result) { styleOut.set(st, text); return; }
      dropOwned(st);
      if (result.anchors) addAnchorRules(result.anchors, st);
      placeLayers(st, result, st.media);
      reorderLayers();
      // Leave the page's own <style> untouched (scripts may read it) and add
      // the rewritten copy right after it.
      styleOut.set(st, text);
      if (result.rest && result.rest.trim()) {
        var copy = makeStyle(result.rest, st.media, null);
        st.insertAdjacentElement('afterend', copy);
        own(st, copy);
      }
    } catch (e) {
      if (document.readyState === 'loading' && /Unclosed|Unknown word/.test(e && e.message)) { tried.set(st, text); waiting.add(st); return; }
      styleOut.set(st, text); log(e);
    }
  }

  function scan(root) {
    if (!root.querySelectorAll) return;
    if (root.localName === 'link') handleLink(root);
    else if (root.localName === 'style') handleStyle(root);
    var list = root.querySelectorAll('link[rel~="stylesheet" i], style:not([data-smcss])');
    for (var i = 0; i < list.length; i++) {
      if (list[i].localName === 'link') handleLink(list[i]); else handleStyle(list[i]);
    }
  }

  var mo = new MutationObserver(function (muts) {
    if (waiting.size) recheck();
    for (var i = 0; i < muts.length; i++) {
      var m = muts[i];
      if (m.type === 'childList') {
        for (var j = 0; j < m.addedNodes.length; j++) {
          var n = m.addedNodes[j];
          if (n.nodeType === 1) scan(n);
          else if (n.nodeType === 3 && n.parentNode && n.parentNode.localName === 'style') handleStyle(n.parentNode);
        }
        for (var k = 0; k < m.removedNodes.length; k++) {
          var r = m.removedNodes[k];
          if (r.nodeType === 1 && (r.localName === 'link' || r.localName === 'style') && owned.has(r)) {
            dropOwned(r); linkDone.delete(r);
          }
        }
        if (m.target && m.target.localName === 'style') handleStyle(m.target);
      } else if (m.type === 'characterData') {
        var p = m.target.parentNode;
        if (p && p.localName === 'style') handleStyle(p);
      } else if (m.type === 'attributes') {
        var t = m.target;
        if (t.localName === 'link') {
          if (m.attributeName === 'href') { dropOwned(t); linkDone.delete(t); handleLink(t); }
          else if (m.attributeName === 'media') { (owned.get(t) || []).forEach(function (e) { e.media = t.media; }); }
          else if (m.attributeName === 'rel') handleLink(t);
        }
      }
    }
  });

  mo.observe(document, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['href', 'rel', 'media'] });
  scan(document);
  document.addEventListener('DOMContentLoaded', function () { recheck(); scan(document); });
}
