// Turns an ES module's source into a classic-script function that our
// loader can run, so modules work on Safari 15.1 without import maps.
// Also rewrites syntax Safari 15.1 can't parse (regex lookbehind literals,
// class static blocks).
import { Parser } from 'acorn';

const isRelOrURL = (s) => /^(\/|\.\/|\.\.\/)/.test(s) || /^[a-z][a-z0-9+.-]*:/i.test(s);
export const isBare = (s) => !isRelOrURL(s);

// All nodes of a tree (a plain loop: generators are slow on big bundles)
function nodes(root) {
  const out = [], stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n.type !== 'string') continue;
    out.push(n);
    for (const k in n) {
      if (k === 'loc' || k === 'start' || k === 'end' || k === 'type') continue;
      const v = n[k];
      if (Array.isArray(v)) { for (let i = v.length - 1; i >= 0; i--) if (v[i] && typeof v[i].type === 'string') stack.push(v[i]); }
      else if (v && typeof v.type === 'string') stack.push(v);
    }
  }
  return out;
}

function patternNames(p, out) {
  if (!p) return out;
  switch (p.type) {
    case 'Identifier': out.push(p.name); break;
    case 'ObjectPattern': p.properties.forEach((q) => patternNames(q.type === 'RestElement' ? q.argument : q.value, out)); break;
    case 'ArrayPattern': p.elements.forEach((e) => e && patternNames(e, out)); break;
    case 'RestElement': patternNames(p.argument, out); break;
    case 'AssignmentPattern': patternNames(p.left, out); break;
  }
  return out;
}

const nameOf = (n) => (n.type === 'Literal' ? String(n.value) : n.name);
const BAD_REGEX = /\(\?<[=!]/;

// Quick check for syntax Safari 15.1 can't parse, in classic or module code.
// A lookbehind inside a string (new RegExp(`(?<=x)`)) is fine: the RegExp
// stand-in handles it at run time. Only regex literals (/(?<=x)/) need the
// full rewrite, so look at what comes just before each hit: the nearest
// slash or quote on the same line. This avoids parsing multi-MB bundles
// (ChatGPT's) for nothing, which froze the page.
function literalLookbehind(src) {
  const re = /\(\?<[=!]/g;
  let m;
  while ((m = re.exec(src))) {
    let k = m.index - 1, stop = Math.max(0, m.index - 400), opener = '';
    for (; k >= stop; k--) {
      const c = src[k];
      if (c === '\n' || c === '\r') break;
      if ((c === '/' || c === '`' || c === '"' || c === "'") && src[k - 1] !== '\\') { opener = c; break; }
    }
    if (opener === '/' || opener === '') return true;
  }
  return false;
}
export function needsSyntaxFix(src) {
  return (BAD_REGEX.test(src) && literalLookbehind(src)) || /\bstatic\s*\{/.test(src);
}

function syntaxEdits(ast, src, edits) {
  let sb = 0, changed = false;
  for (const n of nodes(ast)) {
    if (n.type === 'Literal' && n.regex && (BAD_REGEX.test(n.regex.pattern) || n.regex.flags.includes('v'))) {
      edits.push({ s: n.start, e: n.end, t: '(new RegExp(' + JSON.stringify(n.regex.pattern) + ',' + JSON.stringify(n.regex.flags) + '))' });
      changed = true;
    } else if (n.type === 'StaticBlock') {
      const brace = src.indexOf('{', n.start);
      edits.push({ s: n.start, e: brace + 1, t: 'static __smsb' + (sb++) + '=(()=>{' });
      edits.push({ s: n.end - 1, e: n.end, t: '})();' });
      changed = true;
    }
  }
  return changed;
}

function apply(src, edits) {
  edits.sort((a, b) => b.s - a.s);
  let out = src;
  for (const ed of edits) out = out.slice(0, ed.s) + ed.t + out.slice(ed.e);
  return out;
}

// Quick fix for big classic scripts whose only problem is lookbehind regex
// literals (Calendly's 6 MB bundle has two, from the "marked" library).
// Finds each literal around a hit without parsing the whole file, checks it
// with the parser, and swaps in new RegExp(...), which the RegExp stand-in
// handles. Returns null when unsure (the full fix then decides).
const REGEX_BEFORE = /[(,=:[!&|?{};+\-*%<>~^]$|(?:^|[^\w$.])(?:return|typeof|case|do|else|in|of|void|yield|await|delete|throw|new)$/;
function literalAt(src, s) {
  let j = s + 1, cls = false;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === '\n' || c === '\r') return null;
    if (c === '\\') { j++; continue; }
    if (cls) { if (c === ']') cls = false; continue; }
    if (c === '[') cls = true;
    else if (c === '/') break;
  }
  if (j >= src.length) return null;
  let e = j + 1;
  while (e < src.length && /[a-z]/.test(src[e])) e++;
  return e;
}
export function fastFixScript(src) {
  if (!BAD_REGEX.test(src) || /\bstatic\s*\{/.test(src)) return null;
  const edits = [], done = new Set();
  const re = /\(\?<[=!]/g;
  let m;
  while ((m = re.exec(src))) {
    const stop = Math.max(0, m.index - 2000);
    // The literal's opening slash: nearest one that gives a valid regex
    // literal covering this hit, in a place where a regex can start. None:
    // the hit is inside a string, which is fine as it is.
    let found = false;
    for (let s = m.index - 1; s >= stop && !found; s--) {
      const c = src[s];
      if (c === '\n' || c === '\r') break;
      if (c !== '/' || src[s - 1] === '\\') continue;
      if (done.has(s)) { found = true; break; }
      const e = literalAt(src, s);
      if (!e || e <= m.index) continue;
      const before = src.slice(Math.max(0, s - 12), s).replace(/\s+$/, '');
      if (before && !REGEX_BEFORE.test(before)) continue;
      let node;
      try { node = Parser.parseExpressionAt('(' + src.slice(s, e) + ')', 0, { ecmaVersion: 'latest' }); } catch (x) { continue; }
      if (!node || node.type !== 'Literal' || !node.regex) continue;
      edits.push({ s, e, t: '(new RegExp(' + JSON.stringify(node.regex.pattern) + ',' + JSON.stringify(node.regex.flags) + '))' });
      done.add(s);
      found = true;
    }
  }
  return edits.length ? apply(src, edits) : null;
}

// Classic script: only fix syntax. Returns null when nothing to change.
export function fixScript(src) {
  if (!needsSyntaxFix(src)) return null;
  const ast = Parser.parse(src, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, allowReturnOutsideFunction: true });
  const edits = [];
  if (!syntaxEdits(ast, src, edits)) return null;
  return apply(src, edits);
}

// Quick text scan: does this module need rewriting at all? Returns
// { deps, needsSelf } without a full parse, or null when unsure.
// Specifiers inside strings or comments may show up as extra deps, which only
// costs an extra lookup; anything that looks bare or uses new syntax goes to
// the full parser.
const STATIC_SPEC = /(?:^|[;}\n\r)\s])(?:import|export)\s*(?:[\w$*{}\s,]+?\s*from\s*)?["']([^"'\n]+)["']/g;
// (not import("${x}") inside a template string: that's built at run time)
const DYN_BARE = /\bimport\s*\(\s*["'](?![./]|[a-z][a-z0-9+.-]*:|\$\{)[^"'$`]+["']\s*\)/i;

// Relative/URL dependencies only, no checks (for modules too big to parse here)
export function quickDeps(src) {
  const deps = [];
  let m;
  STATIC_SPEC.lastIndex = 0;
  while ((m = STATIC_SPEC.exec(src))) if (!isBare(m[1]) && deps.indexOf(m[1]) === -1) deps.push(m[1]);
  return { deps, needsSelf: false, code: null };
}
export function quickScan(src) {
  if (needsSyntaxFix(src) || DYN_BARE.test(src)) return null;
  const deps = [];
  let m;
  STATIC_SPEC.lastIndex = 0;
  while ((m = STATIC_SPEC.exec(src))) {
    const spec = m[1];
    if (isBare(spec)) return null;
    if (deps.indexOf(spec) === -1) deps.push(spec);
  }
  return { deps, needsSelf: false, code: null };
}

// Module -> { deps: [specifiers], needsSelf, code }
// code is: __smdefine(url, async function(__i,__e,__m,__d){...})
export function transformModule(src, url) {
  const ast = Parser.parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
  const deps = [];
  const depIdx = (spec) => { let i = deps.indexOf(spec); if (i === -1) { i = deps.length; deps.push(spec); } return i; };
  const edits = [];
  const header = [];
  const getters = [];   // [exportName, jsExpression]
  const stars = [];
  let needsSelf = false;
  let def = 0;
  const bindings = new Map();   // imported local name -> live access expression

  for (const n of ast.body) {
    if (n.type === 'ImportDeclaration') {
      const i = depIdx(n.source.value);
      for (const sp of n.specifiers) {
        if (sp.type === 'ImportNamespaceSpecifier') header.push('const ' + sp.local.name + '=__i[' + i + '];');
        else {
          const imported = sp.type === 'ImportDefaultSpecifier' ? 'default' : nameOf(sp.imported);
          bindings.set(sp.local.name, '__i[' + i + '][' + JSON.stringify(imported) + ']');
        }
      }
      edits.push({ s: n.start, e: n.end, t: '' });
    } else if (n.type === 'ExportNamedDeclaration') {
      if (n.declaration) {
        const d = n.declaration;
        const names = d.type === 'VariableDeclaration'
          ? d.declarations.reduce((a, v) => patternNames(v.id, a), [])
          : [d.id.name];
        names.forEach((nm) => getters.push([nm, nm]));
        edits.push({ s: n.start, e: d.start, t: '' });
      } else if (n.source) {
        const i = depIdx(n.source.value);
        n.specifiers.forEach((sp) => getters.push([nameOf(sp.exported), '__i[' + i + '][' + JSON.stringify(nameOf(sp.local)) + ']']));
        edits.push({ s: n.start, e: n.end, t: '' });
      } else {
        n.specifiers.forEach((sp) => getters.push([nameOf(sp.exported), nameOf(sp.local)]));
        edits.push({ s: n.start, e: n.end, t: '' });
      }
    } else if (n.type === 'ExportAllDeclaration') {
      const i = depIdx(n.source.value);
      if (n.exported) getters.push([nameOf(n.exported), '__i[' + i + ']']);
      else stars.push(i);
      edits.push({ s: n.start, e: n.end, t: '' });
    } else if (n.type === 'ExportDefaultDeclaration') {
      const d = n.declaration;
      if ((d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && d.id) {
        getters.push(['default', d.id.name]);
        edits.push({ s: n.start, e: d.start, t: '' });
      } else {
        const v = '__smdef' + (def++);
        getters.push(['default', v]);
        edits.push({ s: n.start, e: d.start, t: 'const ' + v + '=' });
        if (d.type !== 'FunctionDeclaration' && d.type !== 'ClassDeclaration') edits.push({ s: d.end, e: d.end, t: ';' });
      }
    }
  }

  // Named imports are live bindings. Rewrite references to read through the
  // namespace, unless the same name is declared somewhere else in the module
  // (then fall back to a one-time copy, which is fine for bundler output).
  if (bindings.size) {
    const declared = new Set();
    for (const n of nodes(ast)) {
      if (n.type === 'VariableDeclarator') patternNames(n.id, []).forEach((x) => declared.add(x));
      else if (/Function/.test(n.type)) { if (n.id) declared.add(n.id.name); n.params.forEach((p) => patternNames(p, []).forEach((x) => declared.add(x))); }
      else if ((n.type === 'ClassDeclaration' || n.type === 'ClassExpression') && n.id) declared.add(n.id.name);
      else if (n.type === 'CatchClause' && n.param) patternNames(n.param, []).forEach((x) => declared.add(x));
    }
    const live = new Map();
    bindings.forEach((expr, name) => {
      if (declared.has(name)) header.push('const ' + name + '=' + expr + ';');
      else live.set(name, expr);
    });
    if (live.size) {
      const visit = (node, parent, key) => {
        if (!node || typeof node.type !== 'string') return;
        if (node.type === 'ImportDeclaration' || (node.type === 'ExportNamedDeclaration' && !node.declaration)) return;
        if (node.type === 'Property' && node.shorthand && node.value.type === 'Identifier' && live.has(node.value.name) && parent && parent.type === 'ObjectExpression') {
          edits.push({ s: node.start, e: node.end, t: node.key.name + ':' + live.get(node.value.name) });
          return;
        }
        if (node.type === 'Identifier' && live.has(node.name)) {
          const skip = parent && (
            (parent.type === 'MemberExpression' && key === 'property' && !parent.computed) ||
            ((parent.type === 'Property' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') && key === 'key' && !parent.computed) ||
            parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' || parent.type === 'ContinueStatement' ||
            parent.type === 'MetaProperty');
          if (!skip) {
            const isWrite = parent && ((parent.type === 'AssignmentExpression' && key === 'left') || parent.type === 'UpdateExpression');
            edits.push({ s: node.start, e: node.end, t: isWrite ? node.name : '(' + live.get(node.name) + ')' });
          }
          return;
        }
        for (const k in node) {
          if (k === 'start' || k === 'end' || k === 'loc') continue;
          const v = node[k];
          if (Array.isArray(v)) v.forEach((c) => visit(c, node, k));
          else if (v && typeof v.type === 'string') visit(v, node, k);
        }
      };
      ast.body.forEach((n) => visit(n, ast, 'body'));
      // export getters that point at a live import
      getters.forEach((g) => { if (live.has(g[1])) g[1] = live.get(g[1]); });
    }
  }

  for (const n of nodes(ast)) {
    if (n.type === 'MetaProperty' && n.meta.name === 'import') {
      edits.push({ s: n.start, e: n.end, t: '__m' });
    } else if (n.type === 'ImportExpression') {
      edits.push({ s: n.start, e: n.start + 6, t: '__d' });
      if (n.source.type === 'Literal' && typeof n.source.value === 'string' && isBare(n.source.value)) needsSelf = true;
    }
  }
  if (syntaxEdits(ast, src, edits)) needsSelf = true;
  if (deps.some(isBare)) needsSelf = true;

  const exp = '__e({' + getters.map(([k, v]) => JSON.stringify(k) + ':()=>' + v).join(',') + '},[' + stars.join(',') + ']);';
  const body = apply(src, edits).replace(/^#!.*/, '');
  const code = '__smdefine(' + JSON.stringify(url) + ',async function(__i,__e,__m,__d){"use strict";' +
    header.join('') + exp + '\n' + body + '\n});void 0;';
  return { deps, needsSelf, code };
}
