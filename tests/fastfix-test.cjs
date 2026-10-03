// Quick lookbehind fix for big classic scripts (Calendly's booking bundle)
const assert = require('assert');
const path = require('path');
(async () => {
  const { fastFixScript } = await import(path.join(__dirname, '../web/esm-transform.js'));
  const src = 'var k8=kw(/link|code/,"g").replace("link",/\\[(?:[^\\[\\]`]|(?<!`)(?<a>`+)[^`]+\\k<a>(?!`))*?\\]/).replace("code",/(?<!`)(?<b>`+)[^`]+\\k<b>(?!`)/),k7=a/b/c;' +
    'var s="(?<=x)y", t=`(?<=${n})(.*)`; function f(){return /(?<=\\$)\\d+/g}';
  const out = fastFixScript(src);
  assert(out, 'should fix');
  new Function(out);
  assert.strictEqual((out.match(/new RegExp\(/g) || []).length, 3);
  assert(out.includes('"(?<=x)y"') && out.includes('`(?<=${n})(.*)`'), 'strings left alone');
  assert(out.includes('k7=a/b/c'), 'division left alone');
  assert.strictEqual(fastFixScript('var x = "(?<=a)b";'), null, 'nothing to fix in strings');
  assert.strictEqual(fastFixScript('class A { static { } } var r=/(?<=a)/;'), null, 'static blocks go to the full fix');
  console.log('fastfix ok');
})().catch((e) => { console.error(e); process.exit(1); });
