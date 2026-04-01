/**
 * scrambleMiddleware.js
 *
 * Two-layer design:
 *
 *  Layer 1 — Global seed map (built once at startup)
 *    Crawls all static/view files and assigns every class, id, and JS
 *    identifier a stable internal key (e.g. "btn" → "__btn__").
 *    This ensures CSS/JS/HTML all agree on what needs replacing.
 *
 *  Layer 2 — Per-session token map (generated on first request)
 *    Each session independently maps every internal key to its own
 *    random token (e.g. "__btn__" → "c3a9f1" for Alice, "c7f002" for Bob).
 *    Stored in req.session._scrTokens.
 *    Expires after MAP_TTL_MS of inactivity and is regenerated fresh.
 *
 *  Result: CSS/JS/HTML are all consistent for one user, but different
 *  across users — even for the same file served at the same time.
 *
 * Install deps:
 *   npm install acorn acorn-walk astring
 *
 * Usage in index.js:
 *   import { buildScrambleMap, scrambleMiddleware, startSessionCleanup } from './scrambleMiddbleMiddleware.js';
 *   await buildScrambleMap([path.join(__dirname, 'static'), path.join(__dirname, 'dist'), path.join(__dirname, 'views')]);
 *   app.use(scrambleMiddleware);          // before express.static and routes
 *   startSessionCleanup(redisClient);     // optional, keeps Redis lean
 */

import crypto   from 'crypto';
import fs       from 'node:fs/promises';
import path     from 'node:path';
import * as acorn   from 'acorn';
import * as walk    from 'acorn-walk';
import * as astring from 'astring';

// ─── config ───────────────────────────────────────────────────────────────────

const MAP_TTL_MS          = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

const CLASS_WHITELIST = new Set([
  'active','hidden','disabled','selected','open','closed',
  'flex','grid','block','inline','relative','absolute','fixed',
  'static','sticky','visible','invisible','overflow','truncate',
  'container','row','col','sr-only',
]);

const JS_WHITELIST = new Set([
  'window','document','navigator','location','history','console','performance',
  'fetch','XMLHttpRequest','WebSocket','EventSource','Worker',
  'localStorage','sessionStorage','indexedDB','crypto',
  'setTimeout','setInterval','clearTimeout','clearInterval',
  'requestAnimationFrame','cancelAnimationFrame','queueMicrotask',
  'Promise','Proxy','Reflect','JSON','Math','Date','RegExp','Error',
  'Map','Set','WeakMap','WeakSet','Symbol','BigInt','ArrayBuffer',
  'Object','Array','String','Number','Boolean','Function',
  'parseInt','parseFloat','isNaN','isFinite',
  'encodeURIComponent','decodeURIComponent','encodeURI','decodeURI',
  'atob','btoa','structuredClone',
  'undefined','null','true','false','NaN','Infinity','globalThis','self',
  'this','super','arguments',
  'addEventListener','removeEventListener','dispatchEvent',
  'preventDefault','stopPropagation','stopImmediatePropagation',
  'querySelector','querySelectorAll','getElementById',
  'getElementsByClassName','getElementsByTagName','closest','matches',
  'setAttribute','getAttribute','removeAttribute','hasAttribute',
  'classList','className','id','style','dataset',
  'innerHTML','outerHTML','innerText','textContent',
  'value','checked','src','href','alt','title','type','name',
  'placeholder','disabled','readonly','required',
  'parentNode','parentElement','children','childNodes',
  'appendChild','removeChild','insertBefore','replaceChild','cloneNode',
  'createElement','createTextNode','createDocumentFragment',
  'getBoundingClientRect','offsetWidth','offsetHeight',
  'scrollTop','scrollLeft','focus','blur','click','submit','reset',
  'target','currentTarget','key','keyCode','clientX','clientY',
  'length','width','height','top','left','right','bottom',
  'default','module','exports','require','__dirname','__filename',
  'e','i','j','k','n','v','s','t','d','p','r','c',
]);

// ─── Layer 1: global seed map ────────────────────────────────────────────────
// seedCss: Set of class/id names found in source  (ids stored as "#name")
// seedJs:  Set of JS identifier names found in source
const seedCss = new Set();
const seedJs  = new Set();
let mapReady  = false;

// ─── Layer 2: per-session token map ──────────────────────────────────────────

function makeSessionTokens() {
  const css = {}, js = {};
  for (const name of seedCss) {
    const isId = name.startsWith('#');
    css[name] = (isId ? 'i' : 'c') + crypto.randomBytes(3).toString('hex');
  }
  for (const name of seedJs) {
    js[name] = '_' + crypto.randomBytes(4).toString('hex');
  }
  return { css, js };
}

function getTokens(req) {
  const now = Date.now();
  // Expire idle maps
  if (req.session._scrTs && now - req.session._scrTs > MAP_TTL_MS) {
    delete req.session._scrTokens;
    delete req.session._scrTs;
  }
  if (!req.session._scrTokens) {
    req.session._scrTokens = makeSessionTokens();
  }
  req.session._scrTs = now;
  return req.session._scrTokens;
}

// ─── Redis cleanup ────────────────────────────────────────────────────────────

export function startSessionCleanup(redisClient, prefix = 'myapp:') {
  async function cleanup() {
    try {
      const now = Date.now();
      let cursor = 0, cleaned = 0;
      do {
        const reply = await redisClient.scan(cursor, { MATCH: `${prefix}sess:*`, COUNT: 200 });
        cursor = reply.cursor;
        for (const key of reply.keys) {
          try {
            const raw = await redisClient.get(key);
            if (!raw) continue;
            const sess = JSON.parse(raw);
            if (!sess._scrTs || now - sess._scrTs <= MAP_TTL_MS) continue;
            delete sess._scrTokens;
            delete sess._scrTs;
            const ttl = await redisClient.ttl(key);
            await redisClient.set(key, JSON.stringify(sess), ttl > 0 ? { EX: ttl } : {});
            cleaned++;
          } catch (_) {}
        }
      } while (cursor !== 0);
      if (cleaned > 0) console.log(`[scramble] cleaned ${cleaned} stale session token maps`);
    } catch (err) {
      console.error('[scramble] cleanup error:', err);
    }
  }
  cleanup();
  const h = setInterval(cleanup, CLEANUP_INTERVAL_MS);
  if (h.unref) h.unref();
  return h;
}

// ─── seed extraction (runs at startup) ───────────────────────────────────────

function seedFromHTML(html) {
  for (const [, classes] of html.matchAll(/\bclass=["']([^"']*)["']/g))
    for (const c of classes.split(/\s+/))
      if (c && !CLASS_WHITELIST.has(c)) seedCss.add(c);

  for (const [, id] of html.matchAll(/\bid=["']([^"']+)["']/g))
    if (!CLASS_WHITELIST.has(id)) seedCss.add('#' + id);

  for (const [, style] of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi))
    seedFromCSS(style);

  for (const [, script] of html.matchAll(/<script\b(?![^>]*\bsrc\b)[^>]*>([\s\S]*?)<\/script>/gi))
    if (script.trim()) seedFromJS(script);
}

function seedFromCSS(css) {
  for (const [, name] of css.matchAll(/\.(-?[a-zA-Z_][a-zA-Z0-9_-]*)/g))
    if (!CLASS_WHITELIST.has(name)) seedCss.add(name);
  for (const [, name] of css.matchAll(/#([a-zA-Z_][a-zA-Z0-9_-]*)/g))
    if (!CLASS_WHITELIST.has(name)) seedCss.add('#' + name);
}

function seedFromJS(src) {
  let ast;
  try {
    ast = acorn.parse(src, {
      ecmaVersion: 'latest', sourceType: 'module',
      allowImportExportEverywhere: true,
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    });
  } catch { return; }

  function declarePattern(pat) {
    if (!pat) return;
    if (pat.type === 'Identifier')        { if (!JS_WHITELIST.has(pat.name)) seedJs.add(pat.name); return; }
    if (pat.type === 'AssignmentPattern') { declarePattern(pat.left); return; }
    if (pat.type === 'RestElement')       { declarePattern(pat.argument); return; }
    if (pat.type === 'ObjectPattern')     { for (const p of pat.properties) declarePattern(p.value || p.argument); return; }
    if (pat.type === 'ArrayPattern')      { for (const el of pat.elements) declarePattern(el); return; }
  }

  walk.simple(ast, {
    VariableDeclarator(node)      { declarePattern(node.id); },
    FunctionDeclaration(node)     { if (node.id && !JS_WHITELIST.has(node.id.name)) seedJs.add(node.id.name); for (const p of node.params) declarePattern(p); },
    FunctionExpression(node)      { if (node.id && !JS_WHITELIST.has(node.id.name)) seedJs.add(node.id.name); for (const p of node.params) declarePattern(p); },
    ArrowFunctionExpression(node) { for (const p of node.params) declarePattern(p); },
    ClassDeclaration(node)        { if (node.id && !JS_WHITELIST.has(node.id.name)) seedJs.add(node.id.name); },
    ImportDeclaration(node)       { for (const s of node.specifiers) if (s.local && !JS_WHITELIST.has(s.local.name)) seedJs.add(s.local.name); },
  });
}

async function listFiles(dir, exts) {
  const results = [];
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch { return results; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...await listFiles(full, exts));
    else if (exts.includes(path.extname(entry.name).toLowerCase())) results.push(full);
  }
  return results;
}

export async function buildScrambleMap(dirs) {
  console.log('[scramble] seeding token map from source files...');
  for (const dir of dirs) {
    for (const f of await listFiles(dir, ['.html','.ejs','.htm','.css','.js','.mjs'])) {
      try {
        const src = await fs.readFile(f, 'utf8');
        const ext = path.extname(f).toLowerCase();
        if (['.html','.ejs','.htm'].includes(ext)) seedFromHTML(src);
        else if (ext === '.css') seedFromCSS(src);
        else seedFromJS(src);
      } catch { /* skip unreadable */ }
    }
  }
  console.log(`[scramble] seeded — ${seedCss.size} CSS names, ${seedJs.size} JS names`);
  mapReady = true;
}

// ─── rewriters (take tokens as argument) ─────────────────────────────────────

function rewriteCSS(css, tokens) {
  css = css.replace(/\.(-?[a-zA-Z_][a-zA-Z0-9_-]*)/g, (full, name) => {
    if (CLASS_WHITELIST.has(name)) return full;
    return '.' + (tokens.css[name] || name);
  });
  css = css.replace(/#([a-zA-Z_][a-zA-Z0-9_-]*)/g, (full, name) => {
    if (CLASS_WHITELIST.has(name)) return full;
    return '#' + (tokens.css['#' + name] || name);
  });
  return css;
}

function domSurfaceRewrite(js, tokens) {
  js = js.replace(/getElementById\(['"]([^'"]+)['"]\)/g, (full, id) => {
    const t = tokens.css['#' + id];
    return t ? `getElementById('${t}')` : full;
  });
  js = js.replace(/(querySelectorAll?)\(['"]([^'"]+)['"]\)/g, (full, fn, sel) => {
    const s = sel
      .replace(/\.(-?[a-zA-Z_][a-zA-Z0-9_-]*)/g, (m, c) => CLASS_WHITELIST.has(c) ? m : '.' + (tokens.css[c] || c))
      .replace(/#([a-zA-Z_][a-zA-Z0-9_-]*)/g,    (m, id) => '#' + (tokens.css['#' + id] || id));
    return `${fn}('${s}')`;
  });
  js = js.replace(/classList\.(add|remove|toggle|contains|replace)\(['"]([^'"]+)['"]\)/g,
    (full, method, cls) => {
      if (CLASS_WHITELIST.has(cls)) return full;
      const t = tokens.css[cls];
      return t ? `classList.${method}('${t}')` : full;
    });
  js = js.replace(/\.className\s*=\s*(['"])([^'"]*)\1/g, (_, q, classes) => {
    const s = classes.split(/\s+/).map(c => (!c || CLASS_WHITELIST.has(c)) ? c : (tokens.css[c] || c)).join(' ');
    return `.className = ${q}${s}${q}`;
  });
  js = js.replace(/setAttribute\(['"]class['"]\s*,\s*(['"])([^'"]*)\1\)/g, (_, q, classes) => {
    const s = classes.split(/\s+/).map(c => (!c || CLASS_WHITELIST.has(c)) ? c : (tokens.css[c] || c)).join(' ');
    return `setAttribute('class', '${s}')`;
  });
  js = js.replace(/setAttribute\(['"]id['"]\s*,\s*(['"])([^'"]*)\1\)/g, (_, q, id) => {
    const t = tokens.css['#' + id];
    return t ? `setAttribute('id', '${t}')` : _;
  });
  return js;
}

function rewriteJS(src, tokens) {
  let ast;
  try {
    ast = acorn.parse(src, {
      ecmaVersion: 'latest', sourceType: 'module',
      allowImportExportEverywhere: true,
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    });
  } catch {
    return domSurfaceRewrite(src, tokens);
  }

  walk.ancestor(ast, {
    Identifier(node, anc) {
      if (JS_WHITELIST.has(node.name)) return;
      const t = tokens.js[node.name];
      if (!t) return;
      const parent = anc[anc.length - 2];
      if (parent && (
        (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) ||
        (parent.type === 'Property'         && parent.key      === node && !parent.computed) ||
        (parent.type === 'MethodDefinition' && parent.key      === node) ||
        (parent.type === 'ImportSpecifier'  && parent.imported === node) ||
        (parent.type === 'ExportSpecifier'  && parent.exported === node)
      )) return;
      node.name = t;
    },
  });

  let result;
  try { result = astring.generate(ast); }
  catch { return domSurfaceRewrite(src, tokens); }
  return domSurfaceRewrite(result, tokens);
}

function rewriteHTML(html, tokens) {
  html = html.replace(/\bclass=(["'])([^"']*)\1/g, (_, q, classes) => {
    const s = classes.split(/\s+/).map(c => (!c || CLASS_WHITELIST.has(c)) ? c : (tokens.css[c] || c)).join(' ');
    return `class=${q}${s}${q}`;
  });
  html = html.replace(/\bid=(["'])([^"']*)\1/g, (full, q, id) => {
    if (!id || CLASS_WHITELIST.has(id)) return full;
    const t = tokens.css['#' + id];
    return t ? `id=${q}${t}${q}` : full;
  });
  html = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_, open, style, close) => open + rewriteCSS(style, tokens) + close);
  html = html.replace(/(<script\b(?![^>]*\bsrc\b)[^>]*>)([\s\S]*?)(<\/script>)/gi,
    (full, open, script, close) => {
      if (!script.trim()) return full;
      return open + rewriteJS(script, tokens) + close;
    });
  return html;
}

// ─── response patcher ────────────────────────────────────────────────────────

function patchResponse(res, tokens) {
  function tryRewrite(body, ct) {
    if (!body) return null;
    const str = Buffer.isBuffer(body) ? body.toString('utf8') : body;
    if (typeof str !== 'string') return null;
    const t = ct.toLowerCase();
    if (t.includes('text/html'))  return rewriteHTML(str, tokens);
    if (t.includes('text/css'))   return rewriteCSS(str, tokens);
    if (t.includes('javascript')) return rewriteJS(str, tokens);
    return null;
  }

  // res.send
  const origSend = res.send.bind(res);
  res.send = function(body) {
    try {
      const out = tryRewrite(body, res.getHeader('Content-Type') || '');
      if (out !== null) return origSend(out);
    } catch (e) { console.error('[scramble] send:', e.message); }
    return origSend(body);
  };

  // res.end  (EJS render, anything bypassing send)
  const origEnd = res.end.bind(res);
  res.end = function(chunk, encoding, cb) {
    try {
      const out = tryRewrite(chunk, res.getHeader('Content-Type') || '');
      if (out !== null) return origEnd(out, encoding, cb);
    } catch (e) { console.error('[scramble] end:', e.message); }
    return origEnd(chunk, encoding, cb);
  };

  // res.sendFile  (static file streaming, bypasses send+end entirely)
  const origSendFile = res.sendFile.bind(res);
  res.sendFile = function(filePath, options, callback) {
    const ext = path.extname(filePath).toLowerCase();
    const ctMap = { '.html':'text/html', '.htm':'text/html', '.css':'text/css', '.js':'application/javascript', '.mjs':'application/javascript' };
    const ct = ctMap[ext];
    if (!ct) return origSendFile(filePath, options, callback);

    fs.readFile(filePath, 'utf8')
      .then(src => {
        res.setHeader('Content-Type', ct + '; charset=utf-8');
        try {
          const out = tryRewrite(src, ct);
          origSend(out !== null ? out : src);
        } catch (e) {
          console.error('[scramble] sendFile rewrite:', e.message);
          origSend(src);
        }
      })
      .catch(() => origSendFile(filePath, options, callback));
  };
}

// ─── middleware ───────────────────────────────────────────────────────────────

const SKIP_EXT = /\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|eot|svg|mp4|webm|json|xml|map|pdf)$/i;

export function scrambleMiddleware(req, res, next) {
  if (!mapReady)               return next();
  if (SKIP_EXT.test(req.path)) return next();
  if (!req.session)            return next();

  const tokens = getTokens(req);   // per-session, lazily created
  patchResponse(res, tokens);
  next();
}

export default scrambleMiddleware;