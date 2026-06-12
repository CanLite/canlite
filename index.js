import express from "express";
import fs from "node:fs";
import session from "express-session";
import path from "path";
import { dirname } from "path";
import { createBareServer } from "@tomphttp/bare-server-node";
import { fileURLToPath } from "url";
import * as http from "node:http";
import apiRoutes from "./api.js";
import requestIp from "request-ip";
import geoip from "geoip-lite";
import httpProxy from "http-proxy";
import { RedisStore } from "connect-redis";
import pool from "./db.js";
import cors from "cors";
import { getCreditBalance, roundCredits } from "./store.js";
import redisClient from "./redis.js";
import { getAccountPrivateLink, getOwnedPrivateLinks } from "./privateLinks.js";
import { canAccessPrivateLinkUpgrade, createPrivateLinkRequestGate } from "./privateLinkGate.js";
import {
  CURRENT_CONSENT_VERSION,
  hasAcceptedCurrentConsent,
  isConsentExemptPath,
  isHtmlNavigationRequest,
  normalizeReturnTo,
} from "./consent.js";
import { applyUserConsent } from "./consentService.js";
import { getSessionUser } from "./sessionUser.js";
import { getDiscordLinkSummaryForUser } from "./discordLinks.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const app = express();
const bareServer = createBareServer("/b/");
const proxy = httpProxy.createProxyServer({ ws: true, changeOrigin: true });
const DAY_MS = 86400000;
const GAME_PAGE_SIZE = 100;
const LONG_CACHE_CONTROL = "public, max-age=31557600, immutable";
const DEFAULT_CACHE_CONTROL = "public, max-age=600";
const DEFAULT_GAME_IMAGE_PATH = path.join(__dirname, "static", "logo.png");
const sitemapPath = path.join(process.cwd(), "static", "sitemap.xml");

const loadJsonArray = (filePath, label) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    console.error(`Failed to load ${label}:`, error);
    return [];
  }
};

const buildGameCatalog = (entries) => {
  const items = Array.isArray(entries) ? entries : [];
  const indexed = items.map((game) => ({
    game,
    nameLower: String(game?.name || "").toLowerCase(),
  }));

  indexed.sort((left, right) => left.game.name.localeCompare(right.game.name));

  return {
    byName: new Map(items.map((game) => [game.name, game])),
    indexed,
  };
};

const getPaginatedGames = (catalog, search, page) => {
  const normalizedSearch = String(search || "").trim().toLowerCase();
  const filtered = normalizedSearch
    ? catalog.indexed.filter((entry) => entry.nameLower.includes(normalizedSearch))
    : catalog.indexed;
  const totalPages = Math.max(1, Math.ceil(filtered.length / GAME_PAGE_SIZE));
  const currentPage = Math.min(Math.max(Number.parseInt(page, 10) || 1, 1), totalPages);
  const startIndex = (currentPage - 1) * GAME_PAGE_SIZE;

  return {
    games: filtered.slice(startIndex, startIndex + GAME_PAGE_SIZE).map((entry) => entry.game),
    currentPage,
    totalPages,
    search: String(search || "").trim(),
  };
};

const getSessionSiteOverride = (sessionData) => sessionData?.siteOverride || sessionData?.siteOveride || null;

const normalizeLeaderboardGameName = (value) => {
  const rawValue = String(value || "").trim();
  if (!rawValue) {
    return "";
  }

  try {
    return decodeURIComponent(rawValue);
  } catch {
    return rawValue;
  }
};

const renderAccountShell = async (req, res, initialPanel) => {
  if (!req.session?.token) {
    return res.status(400).json(false);
  }

  const user = await getSessionUser(req);
  if (!user) {
    return res.status(400).json(false);
  }

  const adfree = await getAdfreeSummary(user.id);
  const [privateLink, privateLinks, discordLink] = await Promise.all([
    getAccountPrivateLink({
      userId: user.id,
      hostname: req.hostname,
    }),
    getOwnedPrivateLinks(user.id),
    getDiscordLinkSummaryForUser(user.id),
  ]);

  return res.render("account-shell", {
    initialPanel,
    credits: getCreditBalance(user.data),
    email: user.email,
    adfree,
    privateLink,
    privateLinks,
    discordLink,
  });
};

const getAdfreeSummary = async (userId) => {
  const adfreeResult = await pool.query(
    "SELECT expiration FROM adfree WHERE id = $1",
    [userId]
  );

  if (adfreeResult.rowCount === 0) {
    return {
      active: false,
      expiresAt: null,
      daysRemaining: 0,
    };
  }

  const expiration = new Date(adfreeResult.rows[0].expiration);

  if (expiration <= new Date()) {
    await pool.query("DELETE FROM adfree WHERE id = $1", [userId]);
    return {
      active: false,
      expiresAt: null,
      daysRemaining: 0,
    };
  }

  const msRemaining = expiration.getTime() - Date.now();

  return {
    active: true,
    expiresAt: expiration,
    daysRemaining: roundCredits(msRemaining / DAY_MS),
  };
};

const games = loadJsonArray(path.join(__dirname, "end.json"), "games data");
const newgames = loadJsonArray(path.join(__dirname, "new.json"), "new games data");
const gamesCatalog = buildGameCatalog(games);
const newGamesCatalog = buildGameCatalog(newgames);
const sitemapTemplate = (() => {
  try {
    return fs.readFileSync(sitemapPath, "utf8");
  } catch (error) {
    console.error("Failed to load sitemap:", error);
    return null;
  }
})();

const webhooks = Object.keys(process.env)
  .filter((key) => key.startsWith("DISCORD_WEBHOOK"))
  .map((key) => process.env[key])
  .filter(Boolean);

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(cors({
  origin: "*",
}));

const redisStore = new RedisStore({
  client: redisClient,
  prefix: "myapp:",
});

const sessionMiddleware = session({
  store: redisStore,
  secret: process.env.EXPRESSJS_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: true },
});

app.use(sessionMiddleware);
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use((req, res, next) => {
  res.locals.currentConsentVersion = CURRENT_CONSENT_VERSION;
  next();
});
app.use((req, res, next) => {
  try {
    const clientIp = requestIp.getClientIp(req);

    if (!clientIp || /(^127\.)|(^10\.)|(^172\.1[6-9]\.)|(^172\.2[0-9]\.)|(^172\.3[0-1]\.)|(^192\.168\.)/.test(clientIp)) {
      return next();
    }

    const geo = geoip.lookup(clientIp);

    if (geo && geo.country === "IL") {
      return res.redirect("https://en.wikipedia.org/wiki/Gaza_genocide");
    }

    next();
  } catch (error) {
    console.error("Geolocation error:", error);
    next();
  }
});

app.use((req, res, next) => {
  const override = getSessionSiteOverride(req.session);
  if ((req.path === "/reset" || req.path === "/reset/") && override) {
    delete req.session.siteOveride;
    delete req.session.siteOverride;
    return res.redirect("/");
  }

  if (!override) {
    return next();
  }

  proxy.web(req, res, { target: override, changeOrigin: true });
});

app.use((req, res, next) => {
  const host = req.hostname;
  if (!host) {
    return next();
  }

  const blockedHost = host.includes("104.36.85.249")
    || host.includes("104-36-85-249")
    || host.includes("nip.io")
    || host.includes("sslip.io")
    || host.includes("plesk.page");

  if (blockedHost || webhooks.length === 0) {
    return next();
  }

  const key = `myapp:seen:${host}`;

  redisClient.set(key, "1", { EX: 43200, NX: true })
    .then((result) => {
      if (!result) {
        return;
      }

      const webhook = webhooks[Math.floor(Math.random() * webhooks.length)];

      fetch(webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: `New link found: https://${host}`,
          flags: 4,
        }),
      }).catch(() => {});
    })
    .catch(() => {});

  next();
});

app.use(createPrivateLinkRequestGate({ proxy }));


app.use(async (req, res, next) => {
  if (!isHtmlNavigationRequest(req) || isConsentExemptPath(req.path) || !req.session?.token) {
    return next();
  }

  try {
    const user = await getSessionUser(req);

    if (!user || hasAcceptedCurrentConsent(user)) {
      return next();
    }

    return res.redirect(`/consent?returnTo=${encodeURIComponent(req.originalUrl || "/")}`);
  } catch (error) {
    console.error("Consent enforcement error:", error);
    return next();
  }
});

app.get("/uv/sw.js", (req, res) => {
  res.set("Service-Worker-Allowed", "/~/uv/");
  res.sendFile(__dirname + "/static/uv/sw.js");
});

app.get("/~/uv/uv/uv.bundle.js", (req, res) => {
  res.sendFile(__dirname + "/static/uv/uv.bundle.js");
});

app.get("/~/uv/uv/uv.config.js", (req, res) => {
  res.sendFile(__dirname + "/static/uv/uv.config.js");
});

app.get("/~/uv/uv/uv.handler.js", (req, res) => {
  res.sendFile(__dirname + "/static/uv/uv.handler.js");
});

app.get("/sitemap.xml", async (req, res) => {
  try {
    if (!sitemapTemplate) {
      return res.status(500).send("Internal Server Error");
    }

    const domain = req.hostname;
    const modified = sitemapTemplate.replace(/canlite\.org/g, domain);

    res.set("Content-Type", "application/xml");
    res.send(modified);
  } catch (err) {
    console.error("Error reading sitemap:", err);
    res.status(500).send("Internal Server Error");
  }
});

app.get("/validate-domain", async (req, res) => {
  const domain = String(req.query.domain || "").toLowerCase();
  if (domain.includes("104.36.85.249") || domain.includes("104-36-85-249") || domain.includes("nip.io") || domain.includes("sslip") || domain.includes("plesk.page")) {
    return res.status(403).send("Denied");
  }
  return res.status(200).send("OK");
});

app.get("/account", async (req, res) => {
  return renderAccountShell(req, res, "account");
});

app.get("/privacy", (req, res) => {
  res.render("privacy", {
    updatedAt: "May 5, 2026",
  });
});

app.get("/terms", (req, res) => {
  res.render("terms", {
    updatedAt: "May 5, 2026",
  });
});

app.get("/consent", async (req, res) => {
  if (!req.session?.token) {
    return res.redirect("/");
  }

  const user = await getSessionUser(req);

  if (!user) {
    return res.redirect("/");
  }

  if (hasAcceptedCurrentConsent(user)) {
    return res.redirect(normalizeReturnTo(req.query.returnTo));
  }

  return res.render("consent", {
    returnTo: normalizeReturnTo(req.query.returnTo),
    email: user.email,
    updatedAt: "May 5, 2026",
  });
});

app.post("/consent", async (req, res) => {
  if (!req.session?.user_id) {
    return res.redirect("/");
  }

  const returnTo = normalizeReturnTo(req.body?.returnTo);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await applyUserConsent(client, req.session.user_id, req);
    await client.query("COMMIT");
    return res.redirect(returnTo);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Consent update failed:", error);
    return res.status(500).send("Failed to record consent");
  } finally {
    client.release();
  }
});

app.get("/link-management", async (req, res) => {
  return renderAccountShell(req, res, "link-management");
});

app.get("/offerwall", async (req, res) => {
  if (!req.session?.token) {
    return res.status(400).json(false);
  }

  const user = await getSessionUser(req);
  if (!user) {
    return res.status(400).json(false);
  }

  const adfree = await getAdfreeSummary(user.id);
  return res.render("offerwall", {
    id: user.id,
    email: user.email,
    credits: getCreditBalance(user.data),
    adfree,
  });
});

app.get("/allgames", async (req, res) => {
  const { games: paginatedGames, currentPage, totalPages, search } = getPaginatedGames(
    gamesCatalog,
    req.query.search,
    req.query.page
  );

  res.render("games", {
    games: paginatedGames,
    currentPage,
    totalPages,
    search,
    hostname: req.hostname,
  });
});

app.get("/newgames", async (req, res) => {
  const { games: paginatedGames, currentPage, totalPages, search } = getPaginatedGames(
    newGamesCatalog,
    req.query.search,
    req.query.page
  );

  res.render("games", {
    games: paginatedGames,
    currentPage,
    totalPages,
    search,
    hostname: req.hostname,
  });
});

app.get("/games", async (req, res) => {
  try {
    const topGames = await redisClient.zRange(
      "game_leaderboard",
      0,
      31,
      { REV: true, WITHSCORES: true }
    );

    const result = [];
    const seenNames = new Set();
    for (let index = 0; index < topGames.length; index += 2) {
      const gameName = normalizeLeaderboardGameName(topGames[index]);
      const game = gamesCatalog.byName.get(gameName);

      if (game && !seenNames.has(game.name)) {
        result.push({ ...game });
        seenNames.add(game.name);
        if (result.length === 8) {
          break;
        }
      } else if (!game) {
        console.warn(`Game not found in database: ${gameName}`);
      }
    }

    const topGamesFirst = result.slice(0, 3);
    const topGamesRest = result.slice(3, 8);

    res.render("gamesRemake", {
      topGamesFirst,
      topGamesRest,
      hostname: req.hostname,
    });
  } catch (err) {
    console.error("Error fetching top games:", err);
    res.status(500).send("Internal Server Error");
  }
});

app.get("/d/:gameName.jpg", (req, res) => {
  const gameName = req.params.gameName;
  const filePath = path.join(__dirname, "static/d/", `${gameName}.jpg`);

  res.sendFile(filePath, (error) => {
    if (error && !res.headersSent) {
      res.sendFile(DEFAULT_GAME_IMAGE_PATH);
    }
  });
});

app.get("/play/:id", (req, res) => {
  const gameName = req.params.id;
  const game = gamesCatalog.byName.get(gameName);

  if (!game) {
    return res.status(404).send("Game not found");
  }

  res.render("play", {
    game,
    hostname: req.hostname,
  });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname + "/static/landing/index.html"));
});

app.get("/proxe", (req, res) => {
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

app.use((req, res, next) => {
  if (
    req.path.endsWith(".png")
    || req.path.endsWith(".jpg")
    || req.path.endsWith(".jpeg")
    || req.path.endsWith(".gif")
    || req.path.endsWith(".webp")
    || req.path.endsWith(".svg")
    || req.path.endsWith(".ico")
  ) {
    res.set("Cache-Control", LONG_CACHE_CONTROL);
  } else {
    res.set("Cache-Control", DEFAULT_CACHE_CONTROL);
  }
  return next();
});

app.use("/api", apiRoutes);
app.use(express.static(__dirname + "/dist"));
app.use(express.static(__dirname + "/static"));

const server = http.createServer();

server.on("request", async (req, res) => {
  try {
    if (bareServer.shouldRoute(req)) {
      bareServer.routeRequest(req, res);
    } else {
      app(req, res);
    }
  } catch (error) {
    if (error.message && error.message.includes("aborted")) {
      return;
    }
    res.statusCode = 500;
    res.write(String(error));
    res.end();
  }
});

function runSessionMiddleware(req, socket, callback) {
  sessionMiddleware(req, {}, (err) => {
    if (err) {
      callback(err);
    } else {
      callback();
    }
  });
}

server.on("upgrade", async (req, socket, head) => {
  runSessionMiddleware(req, socket, (err) => {
    if (err) {
      socket.end();
      return;
    }

    try {
      const override = getSessionSiteOverride(req.session);
      if (override) {
        proxy.ws(req, socket, head, { target: override, changeOrigin: true });
      } else if (req.headers.host) {
        canAccessPrivateLinkUpgrade(req)
          .then((canAccess) => {
            if (canAccess === null) {
              if (bareServer.shouldRoute(req)) {
                bareServer.routeUpgrade(req, socket, head);
              } else {
                socket.end();
              }
              return;
            }

            if (canAccess && bareServer.shouldRoute(req)) {
              bareServer.routeUpgrade(req, socket, head);
              return;
            }

            socket.end();
          })
          .catch(() => socket.end());
      } else if (bareServer.shouldRoute(req)) {
        bareServer.routeUpgrade(req, socket, head);
      } else {
        socket.end();
      }
    } catch (error) {
      if (error.message && error.message.includes("aborted")) {
        socket.end();
        return;
      }
      socket.end();
    }
  });
});

app.use((err, req, res, next) => {
  if (err && err.type === "request.aborted") {
    return;
  }
  next(err);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown() {
  console.log("SIGTERM signal received: closing HTTP server");
  server.close();
  process.exit(0);
}

if (process.env.environment === "testing") {
  server.listen(9908, () => {
    console.log("Testing server http://localhost:9908");
  });
} else {
  server.listen(9909, () => {
    console.log("Main server http://localhost:9909");
  });
}

const verify = express();
verify.get("/validate-domain", (req, res) => {
  try {
    const requestedDomain = String(req.query.domain || "");
    if (requestedDomain.includes("104.36.85.249")) {
      res.status(403).send("Forbidden");
    } else {
      res.status(200).send("OK");
    }
  } catch (error) {
    console.log("Verify error " + error);
  }
});

if (process.env.environment === "testing") {
  verify.listen(3999, () => {
    console.log("Test domain validation server running on http://localhost:3999");
  });
} else {
  verify.listen(4000, () => {
    console.log("Domain validation server running on http://localhost:4000");
  });
}

proxy.on("error", (err, req, res) => {
  console.error("Proxy error:", err);
  if (res && !res.headersSent) {
    res.writeHead(502, { "Content-Type": "text/plain" });
  }
  if (res && !res.writableEnded) {
    res.end("Bad Gateway");
  }
});

proxy.on("proxyReq", (proxyRequest) => {
  proxyRequest.setTimeout(10000, () => {
    try {
      proxyRequest.destroy();
    } catch (error) {}
  });
});
