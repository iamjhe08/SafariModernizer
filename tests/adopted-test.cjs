// adoptedStyleSheets.push(sheet) must apply the sheet (loadout.tf)
const fs = require('fs');
const path = require('path');
const { JSDOM } = require(path.join(__dirname, '../web/node_modules/jsdom'));
const poly = fs.readFileSync(path.join(__dirname, '../web/polyfill.min.js'), 'utf8');
const dom = new JSDOM('<!doctype html><body><div id=h></div></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
if ('adoptedStyleSheets' in w.document) { console.log('jsdom has it natively; skipped'); process.exit(0); }
w.eval(poly);
w.eval(`
  window.out = (async () => {
    const s = new CSSStyleSheet(); await s.replace('#h{display:flex}');
    document.adoptedStyleSheets.push(s);
    await new Promise(r => setTimeout(r, 50));
    return { flex: getComputedStyle(document.getElementById('h')).display === 'flex', docLen: document.adoptedStyleSheets.length };
  })();
`);
w.out.then((r) => {
  if (!r.flex || r.docLen !== 1) { console.error('FAIL', r); process.exit(1); }
  console.log('adopted push ok', r);
}).catch((e) => { console.error(e); process.exit(1); });
