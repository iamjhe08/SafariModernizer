// Runs every test file in this folder with Node and reports which failed.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
let failed = 0;
for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith('-test.cjs')).sort()) {
  try {
    execFileSync(process.execPath, [path.join(__dirname, f)], { stdio: 'pipe', timeout: 120000 });
    console.log('ok   ' + f);
  } catch (e) {
    failed++;
    console.log('FAIL ' + f + '\n' + String(e.stdout || '') + String(e.stderr || ''));
  }
}
process.exit(failed ? 1 : 0);
