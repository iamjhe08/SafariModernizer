const fs = require('fs');
const { JSDOM } = require(require('path').join(__dirname, '../web/node_modules/jsdom'));
const poly = fs.readFileSync(require('path').join(__dirname, '../web/polyfill.min.js'), 'utf8');
const bundle = fs.readFileSync(require('path').join(__dirname, '../web/smfix.min.js'), 'utf8');
function page(off) {
  const msgs = [];
  const dom = new JSDOM(`<!doctype html><head><script nonce="cXxtR8Ie">/*trusted*/</script></head><body><iframe id=f></iframe></body>`, { url: 'https://site.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  if (off) w.localStorage.setItem('__smOff', '1');
  w.webkit = { messageHandlers: { __smcss: { postMessage: (m) => { msgs.push(m); return Promise.resolve(m.op === 'cfg' ? { safe: off ? 4 : 0 } : m.op === 'events' ? [] : true); } } } };
  w.eval(poly); w.eval(bundle);
  return { w, d: w.document, msgs };
}
const { w, d, msgs } = page(false);
const s1 = d.createElement('script'); s1.src = 'https://x.test/a.js'; d.head.appendChild(s1);
const s2 = d.createElement('script'); s2.text = 'window.inlineRan = 1'; d.body.appendChild(s2);
const fd = d.getElementById('f').contentDocument;
const s3 = fd.createElement('script'); s3.text = 'var z=1'; fd.head.appendChild(s3);
const stages = msgs.filter((m) => m.op === 'stage').map((m) => m.phase + ': ' + m.name);
const o = page(true);
console.log(JSON.stringify({
  externalTagged: s1.getAttribute('nonce'), inlineTagged: s2.getAttribute('nonce'), iframeScriptTagged: s3.getAttribute('nonce'),
  stages, polyfillsSkippedWhenOff: typeof o.w.__ls15poly === 'undefined', polyfillsOnWhenFull: typeof w.__ls15poly, offPageTagged: (() => { const s = o.d.createElement('script'); o.d.body.appendChild(s); return s.getAttribute('nonce'); })(),
}, null, 1));
process.exit(0);
