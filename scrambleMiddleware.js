/**
 * scrambleMiddleware.js
 *
 * Express middleware that rewrites outgoing HTML/CSS/JS with session-unique
 * random tokens so every user sees structurally different markup and code.
 *
 * Features:
 *  - CSS class & ID scrambling (regex, fast)
 *  - HTML attribute scrambling (class=, id=, inline <style>, inline <script>)
 *  - Full JS variable/function/parameter renaming via acorn AST + astring
 *  - DOM surface rewriting (getElementById, querySelector, classList, etc.)
 *  - Session map reuse so CSS still matches HTML across requests
 *  - Automatic session map expiry to prevent Redis bloat
 *
 * Install deps:
 *   npm install acorn acorn-walk astring
 *
 * Usage in index.js (after session middleware, before static/routes):
 *   import { scrambleMiddleware, startSessionCleanup } from './scrambleMiddleware.js';
 *   app.use(scrambleMiddleware);
 *   startSessionCleanup(redisClient);   // pass your existing redis client
 */

import crypto from 'crypto';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import * as astring from 'astring';

// ─── config ──────────────────────────────────────────────────────────────────

// Session map TTL: maps older than this are wiped from the session.
// Keeps Redis entries small — a user who hasn't visited in 30 min gets a
// fresh map on their next request (fine, since it's just cosmetic scrambling).
const MAP_TTL_MS = 30 * 60 * 1000; // 30 minutes

// How often to scan Redis for stale session map entries (server-side cleanup).
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // every 10 minutes

// CSS classes / IDs never scrambled (CDN framework names, etc.)
const CLASS_WHITELIST = new Set([
  'active', 'hidden', 'disabled', 'selected', 'open', 'closed',
  'flex', 'grid', 'block', 'inline', 'relative', 'absolute', 'fixed',
  'static', 'sticky', 'visible', 'invisible', 'overflow', 'truncate',
  'container', 'row', 'col', 'sr-only',
  // Add your Tailwind / Bootstrap utility classes here
]);

// JS identifiers never renamed by the AST pass
const JS_WHITELIST = new Set([
  // globals
  'window','document','navigator','location','history','console','performance',
  'fetch','XMLHttpRequest','WebSocket','EventSource','Worker','SharedWorker',
  'localStorage','sessionStorage','indexedDB','caches','crypto',
  'setTimeout','setInterval','clearTimeout','clearInterval','requestAnimationFrame',
  'cancelAnimationFrame','queueMicrotask','Promise','Proxy','Reflect',
  'JSON','Math','Date','RegExp','Error','Map','Set','WeakMap','WeakSet',
  'Symbol','BigInt','ArrayBuffer','DataView','Uint8Array','Int8Array',
  'Uint16Array','Int16Array','Uint32Array','Int32Array','Float32Array',
  'Float64Array','Object','Array','String','Number','Boolean','Function',
  'parseInt','parseFloat','isNaN','isFinite','encodeURIComponent',
  'decodeURIComponent','encodeURI','decodeURI','atob','btoa','structuredClone',
  'undefined','null','true','false','NaN','Infinity','globalThis','self',
  // syntax keywords
  'this','super','arguments','new','delete','typeof','instanceof','void',
  'in','of','yield','await',
  // DOM API methods & properties
  'addEventListener','removeEventListener','dispatchEvent','preventDefault',
  'stopPropagation','stopImmediatePropagation',
  'querySelector','querySelectorAll','getElementById','getElementsByClassName',
  'getElementsByTagName','closest','matches','contains',
  'setAttribute','getAttribute','removeAttribute','hasAttribute',
  'classList','className','id','style','dataset','innerHTML','outerHTML',
  'innerText','textContent','value','checked','src','href','alt','title',
  'parentNode','parentElement','children','childNodes','firstChild','lastChild',
  'nextSibling','previousSibling','nextElementSibling','previousElementSibling',
  'appendChild','removeChild','insertBefore','replaceChild','cloneNode',
  'createElement','createTextNode','createDocumentFragment',
  'getBoundingClientRect','offsetWidth','offsetHeight','scrollTop','scrollLeft',
  'focus','blur','click','submit','reset',
  'target','currentTarget','relatedTarget','key','keyCode','which',
  'clientX','clientY','pageX','pageY','button','buttons','deltaY',
  'type','name','placeholder','disabled','readonly','required','multiple',
  'length','index','size','width','height','x','y','top','left','right','bottom',
  // module
  'default','module','exports','require','__dirname','__filename',
  'import','export',
  // common tiny names that are almost certainly framework-injected
  'el','evt','cb','fn','e','i','j','k','n','v','s','t','d','p','r','c',
]);

// ─── token helpers ────────────────────────────────────────────────────────────

const makeToken   = (prefix = 'c') => prefix + crypto.randomBytes(3).toString('hex');
const makeJsToken = ()              => '_' + crypto.randomBytes(4).toString('hex');

// ─── session map management ───────────────────────────────────────────────────

function getSessionMap(req) {
  const now = Date.now();

  // Expire stale map — active users get their timestamp refreshed below,
  // so this only fires for sessions that went quiet for MAP_TTL_MS.
  if (req.session._scrTs && now - req.session._scrTs > MAP_TTL_MS) {
    delete req.session._scrMaps;
    delete req.session._scrTs;
  }

  if (!req.session._scrMaps) {
    req.session._scrMaps = { css: {}, js: {} };
  }

  // Always refresh timestamp on activity
  req.session._scrTs = now;

  return req.session._scrMaps;
}

// ─── server-side Redis cleanup ────────────────────────────────────────────────

/**
 * Call once at startup. Periodically scans session keys in Redis and strips
 * _scrMaps / _scrTs from sessions that haven't been active recently.
 * This keeps per-session Redis payloads small without destroying the session.
 *
 * @param {import('redis').RedisClientType} redisClient
 * @param {string} [prefix='myapp:']  — must match your RedisStore prefix
 */
export function startSessionCleanup(redisClient, prefix = 'myapp:') {
  async function cleanup() {
    try {
      const now = Date.now();
      let cursor = 0;
      let cleaned = 0;

      do {
        const reply = await redisClient.scan(cursor, {
          MATCH: `${prefix}sess:*`,   // connect-redis stores as prefix + "sess:" + id
          COUNT: 200,
        });

        cursor = reply.cursor;

        for (const key of reply.keys) {
          try {
            const raw = await redisClient.get(key);
            if (!raw) continue;

            const sess = JSON.parse(raw);
            if (!sess._scrTs) continue;                    // never had a map
            if (now - sess._scrTs <= MAP_TTL_MS) continue; // still fresh

            delete sess._scrMaps;
            delete sess._scrTs;

            // Preserve whatever TTL the session key already has
            const ttl = await redisClient.ttl(key);
            const setOpts = ttl > 0 ? { EX: ttl } : {};
            await redisClient.set(key, JSON.stringify(sess), setOpts);

            cleaned++;
          } catch (_) {
            // Malformed or concurrently-deleted session — skip silently
          }
        }
      } while (cursor !== 0);

      if (cleaned > 0) {
        console.log(`[scramble] stripped _scrMaps from ${cleaned} stale sessions`);
      }
    } catch (err) {
      console.error('[scramble] cleanup error:', err);
    }
  }

  cleanup(); // run immediately on startup
  const handle = setInterval(cleanup, CLEANUP_INTERVAL_MS);
  if (handle.unref) handle.unref(); // don't block process exit
  return handle; // caller can clearInterval(handle) if needed
}

// ─── CSS scrambler ────────────────────────────────────────────────────────────

function scrambleCSS(css, map) {
  // .className
  css = css.replace(/\.(-?[a-zA-Z_][a-zA-Z0-9_-]*)/g, (full, name) => {
    if (CLASS_WHITELIST.has(name)) return full;
    if (!map.css[name]) map.css[name] = makeToken('c');
    return '.' + map.css[name];
  });

  // #idName
  css = css.replace(/#([a-zA-Z_][a-zA-Z0-9_-]*)/g, (full, name) => {
    if (CLASS_WHITELIST.has(name)) return full;
    const key = '#' + name;
    if (!map.css[key]) map.css[key] = makeToken('i');
    return '#' + map.css[key];
  });

  return css;
}

// ─── DOM surface rewriter ─────────────────────────────────────────────────────

/**
 * Rewrites class/id *string literals* inside common DOM API calls so that
 * JS references stay consistent with the scrambled HTML/CSS.
 * Runs on the source text — either after AST rename or as standalone fallback.
 */
function domSurfaceRewrite(js, map) {
  // getElementById('id')
  js = js.replace(/getElementById\(['"]([^'"]+)['"]\)/g, (full, id) => {
    const key = '#' + id;
    if (!map.css[key]) map.css[key] = makeToken('i');
    return `getElementById('${map.css[key]}')`;
  });

  // querySelector / querySelectorAll
  js = js.replace(/(querySelectorAll?)\(['"]([^'"]+)['"]\)/g, (full, fn, sel) => {
    const scrambled = sel
      .replace(/\.(-?[a-zA-Z_][a-zA-Z0-9_-]*)/g, (m, c) => {
        if (CLASS_WHITELIST.has(c)) return m;
        if (!map.css[c]) map.css[c] = makeToken('c');
        return '.' + map.css[c];
      })
      .replace(/#([a-zA-Z_][a-zA-Z0-9_-]*)/g, (m, id) => {
        const key = '#' + id;
        if (!map.css[key]) map.css[key] = makeToken('i');
        return '#' + map.css[key];
      });
    return `${fn}('${scrambled}')`;
  });

  // classList.add/remove/toggle/contains/replace('cls')
  js = js.replace(
    /classList\.(add|remove|toggle|contains|replace)\(['"]([^'"]+)['"]\)/g,
    (full, method, cls) => {
      if (CLASS_WHITELIST.has(cls)) return full;
      if (!map.css[cls]) map.css[cls] = makeToken('c');
      return `classList.${method}('${map.css[cls]}')`;
    }
  );

  // .className = 'foo bar'
  js = js.replace(/\.className\s*=\s*['"]([^'"]*)['"]/g, (full, classes) => {
    const scrambled = classes.split(/\s+/).map(c => {
      if (!c || CLASS_WHITELIST.has(c)) return c;
      if (!map.css[c]) map.css[c] = makeToken('c');
      return map.css[c];
    }).join(' ');
    return `.className = '${scrambled}'`;
  });

  // setAttribute('class', 'foo bar')
  js = js.replace(
    /setAttribute\(['"]class['"]\s*,\s*['"]([^'"]*)['"]\)/g,
    (full, classes) => {
      const scrambled = classes.split(/\s+/).map(c => {
        if (!c || CLASS_WHITELIST.has(c)) return c;
        if (!map.css[c]) map.css[c] = makeToken('c');
        return map.css[c];
      }).join(' ');
      return `setAttribute('class', '${scrambled}')`;
    }
  );

  // setAttribute('id', 'foo')
  js = js.replace(
    /setAttribute\(['"]id['"]\s*,\s*['"]([^'"]*)['"]\)/g,
    (full, id) => {
      const key = '#' + id;
      if (!map.css[key]) map.css[key] = makeToken('i');
      return `setAttribute('id', '${map.css[key]}')`;
    }
  );

  return js;
}

// ─── JS AST scrambler ────────────────────────────────────────────────────────

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
    // Unparseable snippet (template literal, partial chunk, etc.)
    // Fall back to DOM-surface-only rewriting which is regex-safe.
    return domSurfaceRewrite(src, map);
  }

  // ── scope-aware rename collection ────────────────────────────────────────
  // nameAliases: scopeKey → scrambled name
  // scopeKey = "varName@depth" so shadowed inner vars get independent names.
  const nameAliases = new Map();

  function scopeDepth(ancestors) {
    return ancestors.filter(a =>
      a.type === 'FunctionDeclaration'     ||
      a.type === 'FunctionExpression'      ||
      a.type === 'ArrowFunctionExpression' ||
      a.type === 'BlockStatement'
    ).length;
  }

  function declare(name, depth) {
    if (JS_WHITELIST.has(name)) return;
    const key = `${name}@${depth}`;
    if (!nameAliases.has(key)) nameAliases.set(key, makeJsToken());
  }

  function resolve(name, depth) {
    for (let d = depth; d >= 0; d--) {
      const val = nameAliases.get(`${name}@${d}`);
      if (val !== undefined) return val;
    }
    return null;
  }

  // Pass 1 — collect declarations
  walk.ancestor(ast, {
    VariableDeclarator(node, anc) {
      const d = scopeDepth(anc);
      const declarePattern = (pat) => {
        if (!pat) return;
        if (pat.type === 'Identifier') { declare(pat.name, d); return; }
        if (pat.type === 'ObjectPattern') {
          for (const p of pat.properties) declarePattern(p.value || p.argument);
        }
        if (pat.type === 'ArrayPattern') {
          for (const el of pat.elements) declarePattern(el);
        }
        if (pat.type === 'AssignmentPattern') declarePattern(pat.left);
        if (pat.type === 'RestElement')        declarePattern(pat.argument);
      };
      declarePattern(node.id);
    },

    FunctionDeclaration(node, anc) {
      const d = scopeDepth(anc);
      if (node.id) declare(node.id.name, d);
      for (const p of node.params) {
        if (p.type === 'Identifier') declare(p.name, d + 1);
        if (p.type === 'AssignmentPattern' && p.left.type === 'Identifier')
          declare(p.left.name, d + 1);
        if (p.type === 'RestElement' && p.argument.type === 'Identifier')
          declare(p.argument.name, d + 1);
      }
    },

    FunctionExpression(node, anc) {
      const d = scopeDepth(anc);
      if (node.id) declare(node.id.name, d);
      for (const p of node.params) {
        if (p.type === 'Identifier') declare(p.name, d + 1);
      }
    },

    ArrowFunctionExpression(node, anc) {
      const d = scopeDepth(anc);
      for (const p of node.params) {
        if (p.type === 'Identifier') declare(p.name, d + 1);
        if (p.type === 'AssignmentPattern' && p.left.type === 'Identifier')
          declare(p.left.name, d + 1);
      }
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

  // Pass 2 — rename usages
  walk.ancestor(ast, {
    Identifier(node, anc) {
      if (JS_WHITELIST.has(node.name)) return;

      // Skip property keys on member expressions (obj.foo) and object literals
      const parent = anc[anc.length - 2];
      if (parent) {
        if (
          (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) ||
          (parent.type === 'Property'         && parent.key === node      && !parent.computed) ||
          (parent.type === 'MethodDefinition' && parent.key === node) ||
          (parent.type === 'ImportSpecifier'  && parent.imported === node) ||
          (parent.type === 'ExportSpecifier'  && parent.exported === node)
        ) return;
      }

      const scrambled = resolve(node.name, scopeDepth(anc));
      if (scrambled) node.name = scrambled;
    },
  });

  // Re-serialise
  let result;
  try {
    result = astring.generate(ast);
  } catch (_) {
    return domSurfaceRewrite(src, map);
  }

  // DOM surface pass to align class/id string literals with scrambled HTML
  return domSurfaceRewrite(result, map);
}

// ─── HTML scrambler ───────────────────────────────────────────────────────────

function scrambleHTML(html, map) {
  // class="..." and class='...'
  html = html.replace(/\bclass=(["'])([^"']*)\1/g, (full, q, classes) => {
    const scrambled = classes.split(/\s+/).map(c => {
      if (!c || CLASS_WHITELIST.has(c)) return c;
      if (!map.css[c]) map.css[c] = makeToken('c');
      return map.css[c];
    }).join(' ');
    return `class=${q}${scrambled}${q}`;
  });

  // id="..." and id='...'
  html = html.replace(/\bid=(["'])([^"']*)\1/g, (full, q, id) => {
    if (!id || CLASS_WHITELIST.has(id)) return full;
    const key = '#' + id;
    if (!map.css[key]) map.css[key] = makeToken('i');
    return `id=${q}${map.css[key]}${q}`;
  });

  // Inline <style> blocks
  html = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_, open, style, close) => open + scrambleCSS(style, map) + close
  );

  // Inline <script> blocks — full AST rename
  html = html.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi,
    (full, open, script, close) => {
      if (!script.trim()) return full; // external script tag, no body
      return open + scrambleJS(script, map) + close;
    }
  );

  return html;
}

// ─── response interceptor ────────────────────────────────────────────────────

function interceptResponse(req, res, map) {
  const originalSend = res.send.bind(res);

  res.send = function(body) {
    if (typeof body !== 'string' && !Buffer.isBuffer(body)) {
      return originalSend(body);
    }

    try {
      const str = Buffer.isBuffer(body) ? body.toString('utf8') : body;
      const ct  = (res.getHeader('Content-Type') || '').toLowerCase();

      if (ct.includes('text/html'))  return originalSend(scrambleHTML(str, map));
      if (ct.includes('text/css'))   return originalSend(scrambleCSS(str, map));
      if (ct.includes('javascript')) return originalSend(scrambleJS(str, map));
    } catch (e) {
      console.error('[scramble] rewrite error:', e.message);
    }

    return originalSend(body);
  };
}

// ─── middleware ───────────────────────────────────────────────────────────────

const SKIP_EXT = /\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|eot|svg|mp4|webm|json|xml|map|pdf)$/i;

export function scrambleMiddleware(req, res, next) {
  if (SKIP_EXT.test(req.path)) return next();
  if (!req.session)             return next();

  const map = getSessionMap(req);
  interceptResponse(req, res, map);
  next();
}

export default scrambleMiddleware;
