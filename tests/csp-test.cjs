const fs = require('fs');
const { JSDOM } = require(require('path').join(__dirname, '../web/node_modules/jsdom'));
const dom = new JSDOM(`<!doctype html><head><script nonce="abc">1</script></head><body></body>`, { url: 'https://gemini.test/app#smdebug', runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
w.eval(fs.readFileSync(require('path').join(__dirname, '../web/polyfill.min.js'), 'utf8'));
w.eval(fs.readFileSync(require('path').join(__dirname, '../web/smfix.min.js'), 'utf8'));
const d = w.document;
d.dispatchEvent(new w.Event('DOMContentLoaded'));
const s = d.createElement('script'); s.text = 'evalCspCompatiblyData[0]()'; d.head.appendChild(s);
const fire = () => { const e = new w.Event('securitypolicyviolation'); Object.assign(e, { violatedDirective: 'script-src', blockedURI: '', originalPolicy: "script-src 'nonce-x' 'strict-dynamic' https:", sourceFile: 'https://gemini.gstatic.com/_/js/m=LQaXg', lineNumber: 12, columnNumber: 345, disposition: 'enforce', sample: '' }); d.dispatchEvent(e); };
fire(); fire(); fire();
setTimeout(() => {
  const p = d.querySelector('[data-smdebug]');
  console.log(p ? [...p.querySelectorAll('li')].map((li) => li.textContent).join('\n') : 'no panel');
  process.exit(0);
}, 800);
