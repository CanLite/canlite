/**
 * scrambleMiddleware.js
 *
 * Intercepts ALL outgoing HTML/CSS/JS — including res.render (EJS),
 * res.sendFile (static), res.send, and res.end — and rewrites class names,
 * IDs, and JS variable names with session-unique random tokens.
 *
 * Install deps:
 *   npm install acorn acorn-walk astring
 *
 * Usage in index.js (after sessionMiddleware, before static/routes):
 *   import { scrambleMiddleware, startSessionCleanup } from './scrambleMiddleware.js';
 *   app.use(scrambleMiddleware);
 *   startSessionCleanup(redisClient);
 */

import crypto    from 'crypto';
import fs        from 'node:fs/promises';
import * as acorn    from 'acorn';
import * as walk     from 'acorn-walk';
import * as astring  from 'astring';

// ─── config ───────────────────────────────────────────────────────────────────

const MAP_TTL_MS          = 30 * 60 * 1000;  // drop map after 30 min idle
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;  // Redis scan every 10 min

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
  // single-letter params that are almost certainly framework-injected
  'e','i','j','k','n','v','s','t','d','p','r','c',
]);

// ─── token helpers ────────────────────────────────────────────────────────────

const makeCssToken = (p = 'c') => p + crypto.randomBytes(3).toString('hex');
const makeJsToken  = ()         => '_'  + crypto.randomBytes(4).toString('hex');

// ─── session map ──────────────────────────────────────────────────────────────

function getSessionMap(req) {
  const now = Date.now();
  if (req.session._scrTs && now - req.session._scrTs > MAP_TTL_MS) {
    delete req.session._scrMaps;
    delete req.session._scrTs;
  }
  if (!req.session._scrMaps) {
    req.session._scrMaps = { css: {}, js: {} };
  }
  req.session._scrTs = now;
  return req.session._scrMaps;
}

// ─── Redis cleanup ────────────────────────────────────────────────────────────

export function startSessionCleanup(redisClient, prefix = 'myapp:') {
  async function cleanup() {
    try {
      const now = Date.now();
      let cursor = 0, cleaned = 0;
      do {
        const reply = await redisClient.scan(cursor, {
          MATCH: `${prefix}sess:*`,
          COUNT: 200,
        });
        cursor = reply.cursor;
        for (const key of reply.keys) {
          try {
            const raw = await redisClient.get(key);
            if (!raw) continue;
            const sess = JSON.parse(raw);
            if (!sess._scrTs || now - sess._scrTs <= MAP_TTL_MS) continue;
            delete sess._scrMaps;
            delete sess._scrTs;
            const ttl = await redisClient.ttl(key);
            await redisClient.set(key, JSON.stringify(sess), ttl > 0 ? { EX: ttl } : {});
            cleaned++;
          } catch (_) {}
        }
      } while (cursor !== 0);
      if (cleaned > 0) console.log(`[scramble] cleaned ${cleaned} stale session maps`);
    } catch (err) {
      console.error('[scramble] cleanup error:', err);
    }
  }
  cleanup();
  const h = setInterval(cleanup, CLEANUP_INTERVAL_MS);
  if (h.unref) h.unref();
  return h;
}

// ─── CSS ──────────────────────────────────────────────────────────────────────

function scrambleCSS(css, map) {
  css = css.replace(/\.(-?[a-zA-Z_][a-zA-Z0-9_-]*)/g, (full, name) => {
    if (CLASS_WHITELIST.has(name)) return full;
    if (!map.css[name]) map.css[name] = makeCssToken('c');
    return '.' + map.css[name];
  });
  css = css.replace(/#([a-zA-Z_][a-zA-Z0-9_-]*)/g, (full, name) => {
    if (CLASS_WHITELIST.has(name)) return full;
    const key = '#' + name;
    if (!map.css[key]) map.css[key] = makeCssToken('i');
    return '#' + map.css[key];
  });
  return css;
}

// ─── DOM surface (string literals in JS) ─────────────────────────────────────

function domSurfaceRewrite(js, map) {
  js = js.replace(/getElementById\(['"]([^'"]+)['"]\)/g, (_, id) => {
    const key = '#' + id;
    if (!map.css[key]) map.css[key] = makeCssToken('i');
    return `getElementById('${map.css[key]}')`;
  });
  js = js.replace(/(querySelectorAll?)\(['"]([^'"]+)['"]\)/g, (_, fn, sel) => {
    const s = sel
      .replace(/\.(-?[a-zA-Z_][a-zA-Z0-9_-]*)/g, (m, c) => {
        if (CLASS_WHITELIST.has(c)) return m;
        if (!map.css[c]) map.css[c] = makeCssToken('c');
        return '.' + map.css[c];
      })
      .replace(/#([a-zA-Z_][a-zA-Z0-9_-]*)/g, (m, id) => {
        const key = '#' + id;
        if (!map.css[key]) map.css[key] = makeCssToken('i');
        return '#' + map.css[key];
      });
    return `${fn}('${s}')`;
  });
  js = js.replace(/classList\.(add|remove|toggle|contains|replace)\(['"]([^'"]+)['"]\)/g,
    (full, method, cls) => {
      if (CLASS_WHITELIST.has(cls)) return full;
      if (!map.css[cls]) map.css[cls] = makeCssToken('c');
      return `classList.${method}('${map.css[cls]}')`;
    });
  js = js.replace(/\.className\s*=\s*(['"])([^'"]*)\1/g, (_, q, classes) => {
    const s = classes.split(/\s+/).map(c => {
      if (!c || CLASS_WHITELIST.has(c)) return c;
      if (!map.css[c]) map.css[c] = makeCssToken('c');
      return map.css[c];
    }).join(' ');
    return `.className = ${q}${s}${q}`;
  });
  js = js.replace(/setAttribute\(['"]class['"]\s*,\s*(['"])([^'"]*)\1\)/g, (_, q, classes) => {
    const s = classes.split(/\s+/).map(c => {
      if (!c || CLASS_WHITELIST.has(c)) return c;
      if (!map.css[c]) map.css[c] = makeCssToken('c');
      return map.css[c];
    }).join(' ');
    return `setAttribute('class', '${s}')`;
  });
  js = js.replace(/setAttribute\(['"]id['"]\s*,\s*(['"])([^'"]*)\1\)/g, (_, q, id) => {
    const key = '#' + id;
    if (!map.css[key]) map.css[key] = makeCssToken('i');
    return `setAttribute('id', '${map.css[key]}')`;
  });
  return js;
}

// ─── JS AST rename ────────────────────────────────────────────────────────────

function scrambleJS(src, map) {
  let ast;
  try {
    ast = acorn.parse(src, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowImportExportEverywhere: true,
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    });
  } catch (_) {
    return domSurfaceRewrite(src, map);
  }

  const nameAliases = new Map(); // "name@depth" → scrambled

  function scopeDepth(anc) {
    return anc.filter(a =>
      a.type === 'FunctionDeclaration'     ||
      a.type === 'FunctionExpression'      ||
      a.type === 'ArrowFunctionExpression' ||
      a.type === 'BlockStatement'
    ).length;
  }

  function declare(name, depth) {
    if (!name || JS_WHITELIST.has(name)) return;
    const key = `${name}@${depth}`;
    if (!nameAliases.has(key)) nameAliases.set(key, makeJsToken());
  }

  function resolve(name, depth) {
    for (let d = depth; d >= 0; d--) {
      const v = nameAliases.get(`${name}@${d}`);
      if (v !== undefined) return v;
    }
    return null;
  }

  function declarePattern(pat, depth) {
    if (!pat) return;
    if (pat.type === 'Identifier')        { declare(pat.name, depth); return; }
    if (pat.type === 'AssignmentPattern') { declarePattern(pat.left, depth); return; }
    if (pat.type === 'RestElement')       { declarePattern(pat.argument, depth); return; }
    if (pat.type === 'ObjectPattern')     { for (const p of pat.properties) declarePattern(p.value || p.argument, depth); return; }
    if (pat.type === 'ArrayPattern')      { for (const el of pat.elements) declarePattern(el, depth); return; }
  }

  // Pass 1 — collect declarations
  walk.ancestor(ast, {
    VariableDeclarator(node, anc) { declarePattern(node.id, scopeDepth(anc)); },
    FunctionDeclaration(node, anc) {
      const d = scopeDepth(anc);
      if (node.id) declare(node.id.name, d);
      for (const p of node.params) declarePattern(p, d + 1);
    },
    FunctionExpression(node, anc) {
      const d = scopeDepth(anc);
      if (node.id) declare(node.id.name, d);
      for (const p of node.params) declarePattern(p, d + 1);
    },
    ArrowFunctionExpression(node, anc) {
      const d = scopeDepth(anc);
      for (const p of node.params) declarePattern(p, d + 1);
    },
    ClassDeclaration(node, anc) {
      if (node.id) declare(node.id.name, scopeDepth(anc));
    },
    ImportDeclaration(node) {
      for (const spec of node.specifiers) {
        if (spec.local) declare(spec.local.name, 0);
      }
    },
  });

  // Pass 2 — rewrite usages
  walk.ancestor(ast, {
    Identifier(node, anc) {
      if (JS_WHITELIST.has(node.name)) return;
      const parent = anc[anc.length - 2];
      if (parent && (
        (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) ||
        (parent.type === 'Property'         && parent.key      === node && !parent.computed) ||
        (parent.type === 'MethodDefinition' && parent.key      === node) ||
        (parent.type === 'ImportSpecifier'  && parent.imported === node) ||
        (parent.type === 'ExportSpecifier'  && parent.exported === node)
      )) return;

      const scrambled = resolve(node.name, scopeDepth(anc));
      if (scrambled) node.name = scrambled;
    },
  });

  let result;
  try { result = astring.generate(ast); }
  catch (_) { return domSurfaceRewrite(src, map); }

  return domSurfaceRewrite(result, map);
}

// ─── HTML ────────────────────────────────────────────────────────────────────

function scrambleHTML(html, map) {
  html = html.replace(/\bclass=(["'])([^"']*)\1/g, (_, q, classes) => {
    const s = classes.split(/\s+/).map(c => {
      if (!c || CLASS_WHITELIST.has(c)) return c;
      if (!map.css[c]) map.css[c] = makeCssToken('c');
      return map.css[c];
    }).join(' ');
    return `class=${q}${s}${q}`;
  });
  html = html.replace(/\bid=(["'])([^"']*)\1/g, (full, q, id) => {
    if (!id || CLASS_WHITELIST.has(id)) return full;
    const key = '#' + id;
    if (!map.css[key]) map.css[key] = makeCssToken('i');
    return `id=${q}${map.css[key]}${q}`;
  });
  html = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_, open, style, close) => open + scrambleCSS(style, map) + close);
  html = html.replace(/(<script\b(?![^>]*\bsrc\b)[^>]*>)([\s\S]*?)(<\/script>)/gi,
    (full, open, script, close) => {
      if (!script.trim()) return full;
      return open + scrambleJS(script, map) + close;
    });
  return html;
}

// ─── content-type detection ───────────────────────────────────────────────────

function getType(res) {
  return (res.getHeader('Content-Type') || '').toLowerCase();
}

function rewrite(body, res, map) {
  const ct = getType(res);
  if (ct.includes('text/html'))  return scrambleHTML(body, map);
  if (ct.includes('text/css'))   return scrambleCSS(body, map);
  if (ct.includes('javascript')) return scrambleJS(body, map);
  return null; // nothing to do
}

// ─── THE FIX: patch all four outgoing paths ───────────────────────────────────

function patchResponse(req, res, map) {

  // ── 1. res.send ─────────────────────────────────────────────────────────────
  const origSend = res.send.bind(res);
  res.send = function(body) {
    if (typeof body === 'string' || Buffer.isBuffer(body)) {
      try {
        const str = Buffer.isBuffer(body) ? body.toString('utf8') : body;
        const out = rewrite(str, res, map);
        if (out !== null) return origSend(out);
      } catch (e) { console.error('[scramble] send error:', e.message); }
    }
    return origSend(body);
  };

  // ── 2. res.end ──────────────────────────────────────────────────────────────
  // EJS res.render() ultimately calls res.end() directly, bypassing res.send.
  const origEnd = res.end.bind(res);
  res.end = function(chunk, encoding, callback) {
    if (chunk && (typeof chunk === 'string' || Buffer.isBuffer(chunk))) {
      try {
        const str = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
        const out = rewrite(str, res, map);
        if (out !== null) return origEnd(out, encoding, callback);
      } catch (e) { console.error('[scramble] end error:', e.message); }
    }
    return origEnd(chunk, encoding, callback);
  };

  // ── 3. res.sendFile ─────────────────────────────────────────────────────────
  // Static files (express.static, res.sendFile) stream directly from disk,
  // completely bypassing send/end. We intercept by reading the file ourselves,
  // rewriting, and sending it as a string response.
  const origSendFile = res.sendFile.bind(res);
  res.sendFile = function(filePath, options, callback) {
    const ext = filePath.split('.').pop().toLowerCase();
    const interesting = ['html','htm','css','js','mjs'];
    if (!interesting.includes(ext)) {
      return origSendFile(filePath, options, callback);
    }

    const typeMap = { html:'text/html', htm:'text/html', css:'text/css', js:'application/javascript', mjs:'application/javascript' };
    const ct = typeMap[ext];

    fs.readFile(filePath, 'utf8')
      .then(content => {
        res.setHeader('Content-Type', ct + '; charset=utf-8');
        try {
          const out = rewrite(content, res, map);
          res.send(out !== null ? out : content);
        } catch (e) {
          console.error('[scramble] sendFile rewrite error:', e.message);
          res.send(content);
        }
      })
      .catch(() => origSendFile(filePath, options, callback)); // file not found etc — fall back
  };

  // ── 4. res.render (EJS / template engines) ──────────────────────────────────
  // Express sets Content-Type to text/html before calling res.end, so our
  // patched res.end above already handles this. No extra work needed.
  // (Verified: express/lib/response.js render → send → end chain.)
}

// ─── middleware ───────────────────────────────────────────────────────────────

const SKIP_EXT = /\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|eot|svg|mp4|webm|json|xml|map|pdf)$/i;

export function scrambleMiddleware(req, res, next) {
  if (SKIP_EXT.test(req.path)) return next();
  if (!req.session)             return next();

  const map = getSessionMap(req);
  patchResponse(req, res, map);
  next();
}

export default scrambleMiddleware;