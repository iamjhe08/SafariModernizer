// Simulate Safari 15.1 refusing nonce'd inline scripts: jsdom runs scripts only via
// our eval, so emulate "refused" by making the page's HTML scripts not run
// (runScripts outside-only) and dynamic scripts not run (jsdom outside-only never runs them).
const fs = require('fs');
const { JSDOM } = require(require('path').join(__dirname, '../web/node_modules/jsdom'));
const html = `<!doctype html><head><script nonce="ab-c_d">window.order=(window.order||[]).concat('one');var ytcfg={ok:1}</script>
<script nonce="ab-c_d">window.order.concat&&(window.order=window.order.concat('two:'+typeof ytcfg))</script>
<script nonce="WRONG">window.injected=1</script>
<script nonce="ab-c_d" type="application/json">{"x":1}</script></head><body></body>`;
const dom = new JSDOM('<!doctype html><head></head><body></body>', { url: 'https://y.test/', runScripts: 'outside-only' });
const w = dom.window;
w.eval(fs.readFileSync(require('path').join(__dirname, '../web/polyfill.min.js'), 'utf8'));
w.eval(fs.readFileSync(require('path').join(__dirname, '../web/smfix.min.js'), 'utf8'));
// parser-like insertion of the page's scripts (not executed by jsdom = "refused")
const tpl = new JSDOM(html).window.document;
for (const s of tpl.querySelectorAll('script')) { w.document.head.appendChild(w.document.importNode(s, true)); }
setTimeout(() => {
  // dynamic inline script added later by page code, also "refused"
  const d = w.document.createElement('script'); d.setAttribute('nonce', 'ab-c_d'); d.text = 'window.dyn=1'; w.document.body.appendChild(d);
  setTimeout(() => {
    console.log(JSON.stringify({ order: w.order, injectedRan: !!w.injected, dynamicRan: !!w.dyn }));
    process.exit(0);
  }, 200);
}, 200);
