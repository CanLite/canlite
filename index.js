import express from "express";
import { execSync } from "node:child_process";
import fs from "node:fs";
import session from "express-session";
import path from "path";
import { dirname } from "path";
import { createBareServer } from "@tomphttp/bare-server-node";
import { fileURLToPath } from "url";
import * as http from "node:http";
import * as https from "node:https";
import { createClient } from "redis";
import apiRoutes from "./api.js";
import requestIp from'request-ip';
import geoip from 'geoip-lite';
import httpProxy from "http-proxy"
import verifyUser from "./middleware/authAdmin.js";
import moment from "moment";
import { RedisStore } from "connect-redis";
import { setupCanScreen } from "./CanScreen.js"
import pool from "./db.js";
import cors from "cors";
import { scrambleMiddleware, startSessionCleanup } from './scrambleMiddleware.js';
import axios from "axios";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const app = express();
const routeCache = new Map();;
const bareServer = createBareServer("/b/");
const proxy = httpProxy.createProxyServer({ ws: true, changeOrigin: true });

let games = [];
const gamesFilePath = path.join(__dirname, "end.json");
try {
  const data = fs.readFileSync(gamesFilePath, "utf8");
  games = JSON.parse(data);
} catch (err) {
  console.error("Failed to load games data:", err);
}

let newgames = [];
const newgamesFilePath = path.join(__dirname, "new.json");
try {
  const data = fs.readFileSync(newgamesFilePath, "utf8");
  newgames = JSON.parse(data);
} catch (err) {
  console.error("Failed to load games data:", err);
}

const webhooks = Object.keys(process.env)
    .filter(k => k.startsWith("DISCORD_WEBHOOK"))
    .map(k => process.env[k])
    .filter(Boolean);

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use((req, res, next) => {
  req.on("aborted", () => {
    let e = 1
  });
  next();
});

app.use(cors({
  origin: "*"
}));

let redisClient = createClient();
redisClient.connect().catch(console.error);

let redisStore = new RedisStore({
  client: redisClient,
  prefix: "myapp:",
});

const sessionMiddleware = session({
  store: redisStore,
  secret: process.env.EXPRESSJS_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: true },
})

app.use(
    sessionMiddleware
);

app.use(scrambleMiddleware);
startSessionCleanup(redisClient);
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.use((req, res, next) => {
  try {
    const clientIp = requestIp.getClientIp(req);

    // Skip local/internal IPs
    if (!clientIp || /(^127\.)|(^10\.)|(^172\.1[6-9]\.)|(^172\.2[0-9]\.)|(^172\.3[0-1]\.)|(^192\.168\.)/.test(clientIp)) {
      return next();
    }

    // Get geo info from IP
    const geo = geoip.lookup(clientIp);

    // Redirect if IP is from Israel
    if (geo && geo.country === 'IL') {
      return res.redirect('https://en.wikipedia.org/wiki/Gaza_genocide');
    }

    next(); // Continue for non-Israeli IPs
  } catch (e) {
    console.error('Geolocation error:', e);
    next(); // Fail open on errors
  }
});

app.use((req, res, next) => {
  let override = req.session.siteOveride || null
  if((req.path === "/reset" || req.path === "/reset/") && override) {
    delete req.session.siteOveride;
    return res.redirect("/");
  }
  if(!override) {
    next()
  } else {
    proxy.web(req, res, { target: override, changeOrigin: true });
  }
})

app.use((req, res, next) => {
  const host = req.hostname;
  if (!host) return next();
  if (
      !(
          host.includes("104.36.85.249") ||
          host.includes("104-36-85-249") ||
          host.includes("nip.io") ||
          host.includes("sslip.io") ||
          host.includes("plesk.page")
      )
  ) {
    const key = `myapp:seen:${host}`;

    redisClient.set(key, "1", { EX: 43200, NX: true })
        .then(result => {
          if (!result) return;

          const webhook = webhooks[Math.floor(Math.random() * webhooks.length)];

          fetch(webhook, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              content: `New link found: https://${host}`,
              flags: 4
            })
          }).catch(() => {});
        })
        .catch(() => {});
  }

  next();
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


app.get('/sitemap.xml', async (req, res) => {
  try {
    const sitemapPath = path.join(process.cwd(), 'static', 'sitemap.xml');
    const raw = await fs.promises.readFile(sitemapPath, 'utf8'); // ✅ using promises from fs

    const domain = req.hostname;
    const modified = raw.replace(/canlite\.org/g, domain);

    res.set('Content-Type', 'application/xml');
    res.send(modified);
  } catch (err) {
    console.error('Error reading sitemap:', err);
    res.status(500).send('Internal Server Error');
  }
});

app.get("/validate-domain", async (req, res) => {
  const domain = (req.query.domain || "").toLowerCase();
  // deny domains containing your IP
  if (domain.includes("104.36.85.249") || domain.includes("104-36-85-249") || domain.includes("nip.io") || domain.includes("sslip") || domain.includes("plesk.page")) {
    return res.status(403).send("Denied");
  }
  return res.status(200).send("OK");
});

app.get("/account", async (req, res) => {
  if (req.session.token) {
    const tokenResult = await pool.query('SELECT token, admin FROM users WHERE token = $1', [req.session.token]);
    if (tokenResult.rowCount === 0) {
      return res.status(400).json(false); // Account does not exist
    } else {
      res.render("account");
    }
  } else {
    return res.status(400).json(false);
  }
})

app.get("/offerwall", async (req, res) => {
  if (req.session.token) {
    const tokenResult = await pool.query('SELECT token, admin FROM users WHERE token = $1', [req.session.token]);
    if (tokenResult.rowCount === 0) {
      return res.status(400).json(false); // Account does not exist
    } else {
      const result = await pool.query('SELECT id, email FROM users WHERE token = $1', [req.session.token]);
      res.render("offerwall", {
        id: result.rows[0].id,
        email: result.rows[0].email,
      });
    }
  } else {
    return res.status(400).json(false);
  }
})

app.get("/allgames", async (req, res) => {
  const perPage = 100;
  let search = req.query.search || "";
  let page = parseInt(req.query.page) || 1;

  const filteredGames = games.filter((game) =>
      game.name.toLowerCase().includes(search)
  );

  const total = filteredGames.length;
  const totalPages = Math.ceil(total / perPage);
  if (page < 1) page = 1;
  if (page > totalPages) page = totalPages;

  const sortedGames = filteredGames.sort((a, b) => a.name.localeCompare(b.name));
  const startIndex = (page - 1) * perPage;
  const paginatedGames = sortedGames.slice(startIndex, startIndex + perPage);

  res.render("games", {
    games: paginatedGames,
    currentPage: page,
    totalPages: totalPages,
    hostname: req.hostname,
  });
});

app.get("/newgames", async (req, res) => {
  const perPage = 100;
  let search = req.query.search || "";
  let page = parseInt(req.query.page) || 1;

  const filteredGames = newgames.filter((newgame) =>
      newgame.name.toLowerCase().includes(search)
  );

  const total = filteredGames.length;
  const totalPages = Math.ceil(total / perPage);
  if (page < 1) page = 1;
  if (page > totalPages) page = totalPages;

  const sortedGames = filteredGames.sort((a, b) => a.name.localeCompare(b.name));
  const startIndex = (page - 1) * perPage;
  const paginatedGames = sortedGames.slice(startIndex, startIndex + perPage);

  res.render("games", {
    games: paginatedGames,
    currentPage: page,
    totalPages: totalPages,
    hostname: req.hostname,
  });
});

app.get("/games", async (req, res) => {
  try {
    const topGames = await redisClient.zRange(
        "game_leaderboard",
        0,
        7,
        { REV: true, WITHSCORES: true }
    );

    const result = [];
    for (let i = 0; i < topGames.length; i += 1) {
      const gameName = topGames[i];
      const score = topGames[i + 1];

      const game = games.find(g => g.name === gameName);

      if (game) {
        result.push({
          ...game,
        });
      } else {
        console.warn(`Game not found in database: ${gameName}`);
      }
    }

    // Split into top 3 and next 5
    const topGamesFirst = result.slice(0, 3);
    const topGamesRest = result.slice(3, 8);
    const hostname = req.hostname

    res.render("gamesRemake", {
      topGamesFirst,
      topGamesRest,
      hostname
    });
  } catch (err) {
    console.error("Error fetching top games:", err);
    res.status(500).send("Internal Server Error");
  }
});

app.get("/d/:gameName.jpg", (req, res) => {
  const gameName = req.params.gameName;
  const filePath = path.join(__dirname, "static/d/", `${gameName}.jpg`);

  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.sendFile(path.join(__dirname, "static", "logo.png"));
  }
});

app.get("/play/:id", (req, res) => {
  const gameName = req.params.id;
  const game = games.find((g) => g.name === gameName);

  if (!game) return res.status(404).send("Game not found");


  // Use pipeline with correct commands
  const hostname = req.hostname
  res.render("play", {
    game,
    hostname
  });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname + "/static/landing/index.html"));
});

app.get("/proxe", function (req, res) {
  res.sendFile(path.join(__dirname + "/dist/index.html"));
});

app.use(function (req, res, next) {
  if (
      req.path.endsWith(".png") ||
      req.path.endsWith(".jpg") ||
      req.path.endsWith(".jpeg") ||
      req.path.endsWith(".gif")
  ) {
    res.set("Cache-Control", "public, max-age=31557600, immutable");
  } else {
    res.set("Cache-Control", "max-age=600");
  }
  return next();
});

app.use("/api", apiRoutes);
app.use(express.static(__dirname + "/dist"));
app.use(express.static(__dirname + "/static"));

const server = http.createServer();

server.on("request", async (req, res) => {
  req.on("aborted", () => {
    let e = 1;
  });
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
  // Express normally calls (req, res, next), but in upgrade there is no res.
  // So we pass an empty object for res and a manual callback for next.
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
      const override = req.session?.siteOverride;
      if (override) {
        proxy.ws(req, socket, head, { target: override, changeOrigin: true });
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

if(process.env.environment === "testing") {
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
    const requestedDomain = req.query.domain;
    if (requestedDomain.includes("104.36.85.249")) {
      res.status(403).send("Forbidden");
    } else {
      res.status(200).send("OK");
    }
  } catch (error) {
    console.log("Verify error " + error);
  }
});

if(process.env.environment === "testing") {
  verify.listen(3999, () => {
    console.log("Test domain validation server running on http://localhost:3999");
  });
} else {
  verify.listen(4000, () => {
    console.log("Domain validation server running on http://localhost:4000");
  });
}

proxy.on('error', (err, req, res) => {
    console.error('Proxy error:', err);
    if (res && !res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
    }
    if (res && !res.writableEnded) res.end('Bad Gateway');
});

proxy.on('proxyReq', (pReq) => {
    pReq.setTimeout(10000, () => {
        try { pReq.destroy(); } catch (e) {}
    });
});
