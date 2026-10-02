const fs = require('fs');
const { JSDOM } = require(require('path').join(__dirname, '../web/node_modules/jsdom'));
const poly = fs.readFileSync(require('path').join(__dirname, '../web/polyfill.min.js'), 'utf8');
const bundle = fs.readFileSync(require('path').join(__dirname, '../web/smfix.min.js'), 'utf8');

const B = 'https://t.test/';
const files = {
  [B + 'lib.js']: `
    let count = 0;
    export default function lib(x) { return 'lib:' + x; }
    export const twice = (n) => n * 2;
    export function bump() { return ++count; }
    export { count };`,
  [B + 'u/math.js']: `export * from './more.js'; export const pi = 3.14; export * as nsMore from './more.js';`,
  [B + 'u/more.js']: `export const e = 2.71; export default 'more-default';`,
  [B + 'a.js']: `import { fromB } from './b.js'; export const A = 'A'; export function useB(){ return fromB(); }`,
  [B + 'b.js']: `import { A } from './a.js'; export function fromB(){ return 'B sees ' + A; }`,
  [B + 'syntax.js']: `
    export const lb = /(?<!x)y/.test('ay');
    export class K { static #n = 1; static { this.ready = 'static-block-ran'; } }
    export const url = import.meta.url;`,
  [B + 'lazy.js']: `export const lazy = 'lazy-loaded';`,
  [B + 'main.js']: `
    import lib, { twice, bump } from 'lib';
    import * as m from 'utils/math.js';
    import { A, useB } from './a.js';
    import { lb, K, url } from './syntax.js';
    bump(); bump();
    window.results = {
      lib: lib('x'), twice: twice(21), pi: m.pi, e: m.e, nsMoreDefault: m.nsMore.default,
      starHasDefault: 'default' in m, A, useB: useB(), lb, staticBlock: K.ready, metaUrl: url,
    };
    window.dyn = import('./lazy.js').then(x => x.lazy);
    window.dynBare = import('lib').then(x => x.twice(5));
    window.counter = import('lib').then(x => x.bump());
  `,
  [B + 'plain.js']: `window.plainRanByShim = true;`,
};

const html = `<!doctype html><html><head>
<script type="importmap">{"imports":{"lib":"https://t.test/lib.js","utils/":"https://t.test/u/"}}</script>
<script type="module" src="https://t.test/main.js"></script>
<script type="module" src="https://t.test/plain.js"></script>
<script type="module">import {twice} from 'lib'; window.inline = twice(50);</script>
</head><body>#</body></html>`;

const dom = new JSDOM(html, {
  url: 'https://t.test/page#smdebug', runScripts: 'outside-only',
  beforeParse(w) { w.fetch = (u) => Promise.resolve({ text: () => Promise.resolve(files[u] ?? '') }); },
});
const w = dom.window;
w.eval(poly);
w.eval(bundle);
w.document.dispatchEvent(new w.Event('DOMContentLoaded'));

setTimeout(async () => {
  console.log('results', w.results);
  console.log('dynamic relative:', await w.dyn, '| dynamic bare:', await w.dynBare, '| shared state counter (expect 3):', await w.counter);
  console.log('inline module:', w.inline, '| plain module re-run by shim (expect undefined):', w.plainRanByShim);
  const panel = w.document.querySelector('[data-smdebug]');
  console.log('debug panel:', panel ? panel.textContent.replace(/\s+/g, ' ').slice(0, 400) : 'none');
}, 800);
