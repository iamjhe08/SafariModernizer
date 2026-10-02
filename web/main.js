// Page-side entry. Starts right away: debug log, heartbeat, script nonce
// support. Then, once this site's safe-mode level is known, the heavier
// features:  level 0 = all on, 1 = heavy helpers off (:has, color-mix,
// component CSS, script re-runs), 2 = also CSS rewriting and module loader
// off, 3 = only the basic polyfills and script nonces, 4 = off.
import { startDebug, smlog } from './debug.js';
import { startCssFix } from './cssfix-runtime.js';
import { startModuleLoader } from './esm-loader.js';
import { startShadowCss } from './shadowcss.js';
import { startScriptFix } from './scriptfix.js';
import { startHasEngine } from './hasengine.js';
import { startColorMix } from './colormix.js';
import { startStrictDynamic } from './strictdynamic.js';
import { config, startHeartbeat } from './safety.js';
import { startNonceFix } from './noncefix.js';

(function () {
  if (window.__smmain) return;
  window.__smmain = 1;
  var bridge = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.__smcss;
  try { startDebug(); } catch (e) {}
  try { startHeartbeat(); } catch (e) {}
  try { startStrictDynamic(); } catch (e) {}
  try { startNonceFix(); } catch (e) {}
  try { startScriptFix(bridge || null); } catch (e) {}   // waits for the site's mode itself
  config.then(function (cfg) {
    // The tab's browser ID was just switched for this site: load again with it
    if (cfg && cfg.reload && window.top === window) { location.reload(); return; }
    var level = (cfg && +cfg.safe) || 0;
    if (level > 0 && window.top === window) {
      smlog((level >= 4 ? 'tweak is OFF on this site' : 'safe mode ' + level + ' on this site') +
        (cfg.reason ? ' (' + (cfg.reason === 'set by hand' ? 'set by hand' : 'turned on after a freeze during: ' + cfg.reason) + ')' : ''));
    }
    if (level >= 3) return;
    if (level < 2) { try { startCssFix(); } catch (e) {} }
    if (level < 1) {
      try { startShadowCss(); } catch (e) {}
      try { startHasEngine(); } catch (e) {}
      try { startColorMix(); } catch (e) {}
    }
    if (level < 2) { try { startModuleLoader(bridge || null); } catch (e) {} }
  });
})();
