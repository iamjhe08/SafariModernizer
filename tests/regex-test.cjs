const { JSDOM } = require(require('path').join(__dirname, '../web/node_modules/jsdom'));
const src = require('fs').readFileSync(require('path').join(__dirname, '../web/polyfill.min.js'), 'utf8');
const d = new JSDOM('', { runScripts: 'outside-only' });
const w = d.window;
// Simulate Safari 15: the RegExp constructor rejects lookbehind
w.eval(String.raw`(function(){
  var O = RegExp;
  window.RegExp = new Proxy(O, { construct: function (t, a, n) {
    var s = String(a[0] instanceof O ? a[0].source : a[0]);
    if (/\(\?<[=!]/.test(s)) throw new SyntaxError('Invalid regular expression: invalid group specifier name');
    return Reflect.construct(t, a, n);
  }});
})()`);
w.eval(src);
const out = w.eval(String.raw`
  var p = '(?<! channel/|google/)google(?!(?:wv|app))|(?<! cu)bots?(?:\\b|_)';
  var r = new RegExp(p, 'i');
  [r.source, r.test('Googlebot'), r.test('scubot'), r instanceof RegExp, /x/ instanceof RegExp, RegExp('a').test('a'), new RegExp('(?<n>a)').exec('a').groups.n]
`);
console.log(out);
