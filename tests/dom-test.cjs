const fs = require('fs');
const { JSDOM } = require(require('path').join(__dirname, '../web/node_modules/jsdom'));
const runtime = fs.readFileSync(require('path').join(__dirname, '../web/smfix.min.js'), 'utf8');
const poly = fs.readFileSync(require('path').join(__dirname, '../web/polyfill.min.js'), 'utf8');

const files = {
  'https://site.test/primitives.css': '@layer base, components, utilities;:root{--x:1}',
  'https://site.test/app.css': '@layer utilities{.u{color:oklch(0.7 0.1 200)}@media (width>=48rem){.md{display:grid}}}@layer base{body{font-family:sans-serif}}.plain{margin:0}.card{&:hover{color:red}@media (width<640px){padding:0}}',
  'https://site.test/old.css': '.old{color:blue}@media (min-width:10px){.y{x:1}}',
};

const html = `<!doctype html><html><head>
<link rel="stylesheet" href="https://site.test/primitives.css">
<link rel="stylesheet" href="https://site.test/app.css">
<link rel="stylesheet" href="https://site.test/old.css">
<style>@layer components{.btn{color:green}}.inline{a:b}</style>
</head><body><p>hi</p></body></html>`;

const dom = new JSDOM(html, {
  runScripts: 'outside-only',
  beforeParse(w) {
    w.fetch = (u) => Promise.resolve({ text: () => Promise.resolve(files[u] || '') });
  },
});
const w = dom.window;
w.eval(poly);
w.eval(runtime);

setTimeout(() => {
  const head = w.document.head;
  [...head.children].forEach((el) => {
    const tag = el.localName;
    const label = tag === 'link' ? 'LINK ' + el.getAttribute('href').split('/').pop()
      : tag === 'meta' ? 'ANCHOR'
      : 'STYLE[' + (el.hasAttribute('data-smcss') ? (el.getAttribute('data-smcss') || 'rest') : 'page') + '] ' + el.textContent.replace(/\s+/g, ' ').slice(0, 110);
    console.log(label);
  });
}, 300);
