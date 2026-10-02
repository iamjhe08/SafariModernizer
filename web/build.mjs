import builder from 'core-js-builder';
import { readFileSync, writeFileSync } from 'fs';
import { minify } from 'terser';
import { buildSync } from 'esbuild';

// Only include what Safari 15.1 is missing (stable ES + web features)
const corejs = await builder({
  modules: ['core-js/actual'],
  exclude: [/^esnext\./],
  targets: 'safari 15.1, ios 15.1',
  format: 'bundle',
});

const extras = readFileSync('extras.js', 'utf8');
// Popover API (Safari 17): menus on Reddit, SteamDB, GitHub
const popover = readFileSync('node_modules/@oddbird/popover-polyfill/dist/popover.iife.min.js', 'utf8');
// Each extra polyfill is built and wrapped on its own, so one failing
// can't stop the others from loading. Order matters (see entries/).
import { readdirSync } from 'fs';
const more = readdirSync('entries').filter((f) => f.endsWith('.js')).sort().map((f) =>
  'try{' + buildSync({ entryPoints: ['entries/' + f], bundle: true, write: false, format: 'iife', target: 'safari15', platform: 'browser', legalComments: 'none' }).outputFiles[0].text + '}catch(e){try{console.warn("[SafariModernizer] polyfill ' + f + ' failed",e)}catch(x){}}'
).join('\n');
const full = `(function(){if(window.__ls15poly)return;window.__ls15poly=1;try{if(localStorage.getItem('__smOff')==='1')return}catch(e){}try{\n${corejs}\n}catch(e){}\ntry{\n${extras}\n}catch(e){}\ntry{\n${popover}\n}catch(e){}\n${more}})();`;
const out = await minify(full, { ecma: 2017, compress: true, mangle: true });
writeFileSync('polyfill.min.js', out.code);
console.log('bytes', out.code.length);
