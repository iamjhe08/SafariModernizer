const fs = require('fs');
const { JSDOM } = require(require('path').join(__dirname, '../web/node_modules/jsdom'));
const dom = new JSDOM('<!doctype html><head></head><body></body>', { url: 'https://y.test/', runScripts: 'dangerously' });
const w = dom.window;
w.eval(fs.readFileSync(require('path').join(__dirname, '../web/polyfill.min.js'), 'utf8'));
w.eval(fs.readFileSync(require('path').join(__dirname, '../web/smfix.min.js'), 'utf8'));
const s = w.document.createElement('script'); s.setAttribute('nonce', 'ok'); s.text = 'window.runs=(window.runs||0)+1'; w.document.head.appendChild(s);
const d = w.document.createElement('script'); d.setAttribute('nonce', 'ok'); d.text = 'window.druns=(window.druns||0)+1'; w.document.body.appendChild(d);
setTimeout(() => { console.log(JSON.stringify({ runs: w.runs, druns: w.druns })); process.exit(0); }, 300);
