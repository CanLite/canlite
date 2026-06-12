import express from "express";
import crypto from "crypto";
import pool from "./db.js";
import path, { dirname } from "path";
import fs from "node:fs/promises";
import { fileURLToPath } from "url";
import requestIp from "request-ip";
import { getCreditBalance, roundCredits, setCreditBalance } from "./store.js";
import redisClient from "./redis.js";
import { authenticateUserCredentials } from "./auth.js";
import { CURRENT_CONSENT_VERSION, hasAcceptedCurrentConsent } from "./consent.js";
import { applyUserConsent } from "./consentService.js";
import { setSessionUser } from "./sessionUser.js";
import privateLinkRoutes from "./routes/privateLinks.js";
import {
    createDiscordLinkCodeForUser,
    getDiscordLinkSummaryForUser,
    unlinkDiscordAccountForUser,
} from "./discordLinks.js";

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const gameDataDirectory = path.join(__dirname, "private", "data");

let games = [];
const gamesFilePath = path.join(__dirname, "end.json");
try {
    const data = await fs.readFile(gamesFilePath, "utf8");
    games = JSON.parse(data);
} catch (err) {
    console.error("Failed to load games data:", err);
}

const gameByName = new Map(games.map((game) => [game.name, game]));
const popunderFilePath = path.join(__dirname, "popunder.txt");

let popunderScriptBody = "";
try {
    const popunderMarkup = await fs.readFile(popunderFilePath, "utf8");
    const popunderMatch = popunderMarkup.match(/<script[^>]*>([\s\S]*)<\/script>/i);
    popunderScriptBody = popunderMatch ? popunderMatch[1].trim() : popunderMarkup.trim();
} catch (err) {
    console.error("Failed to load popunder script:", err);
}
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

const generateRandomString = (length) => {
    return crypto.randomBytes(length).toString("hex").slice(0, length);
};

const getAdfreeStateForUserId = async (userId) => {
    if (!userId) {
        return false;
    }

    const adfreeResult = await pool.query(
        "SELECT expiration FROM adfree WHERE id = $1",
        [userId]
    );

    if (adfreeResult.rowCount === 0) {
        return false;
    }

    const expiration = new Date(adfreeResult.rows[0].expiration);
    if (expiration > new Date()) {
        return true;
    }

    await pool.query(
        "DELETE FROM adfree WHERE id = $1",
        [userId]
    );
    return false;
};

const extendAdfreeForDays = async (client, userId, days) => {
    const existing = await client.query(
        "SELECT expiration FROM adfree WHERE id = $1",
        [userId]
    );

    if (existing.rowCount > 0) {
        await client.query(
            "UPDATE adfree SET expiration = GREATEST(expiration, NOW()) + ($1 * INTERVAL '1 day') WHERE id = $2",
            [days, userId]
        );
        return;
    }

    await client.query(
        "INSERT INTO adfree (id, expiration) VALUES ($1, NOW() + ($2 * INTERVAL '1 day'))",
        [userId, days]
    );
};

const ADFREE_PLANS = {
    week: {
        price: 7,
        days: 7,
    },
    month: {
        price: 25,
        days: 30,
    },
    lifetime: {
        price: 100,
        days: 36500,
    },
};

const getCpxExpectedHash = (transId) => {
    const cpxSecureHash = process.env.CPX_SECURE_HASH;
    if (!cpxSecureHash || !transId) {
        return null;
    }

    return crypto
        .createHash("md5")
        .update(`${transId}-${cpxSecureHash}`)
        .digest("hex");
};

router.get("/ip", async (req, res) => {
    return res.send(requestIp.getClientIp(req));
});

router.get("/hit/:game", async (req, res) => {
    const gameName = normalizeLeaderboardGameName(req.params.game);

    if (gameName === "bludclart" || gameName === "Blooket") {
        return res.status(403).send("Not Found");
    }

    if (!gameByName.has(gameName)) {
        return res.status(404).send("Game not found");
    }

    redisClient.zIncrBy("game_leaderboard", 1, gameName)
        .catch((err) => console.error("Redis update error:", err));

    return res.status(200).send("Updated");
});

router.post("/check", async (req, res) => {
    const { token } = req.body;

    try {
        const tokenResult = await pool.query(
            "SELECT id, token, admin, email, consent_version, consented_at FROM users WHERE token = $1",
            [token]
        );

        if (tokenResult.rowCount === 0) {
            return res.status(200).json({ loggedIn: false });
        }

        const user = tokenResult.rows[0];
        setSessionUser(req, user);

        const adfreeResult = await pool.query(
            "SELECT expiration FROM adfree WHERE id = $1",
            [user.id]
        );

        let adfree = false;

        if (adfreeResult.rowCount > 0) {
            const expiration = new Date(adfreeResult.rows[0].expiration);

            if (expiration > new Date()) {
                adfree = true;
            } else {
                await pool.query(
                    "DELETE FROM adfree WHERE id = $1",
                    [user.id]
                );
            }
        }

        res.status(200).json({
            loggedIn: true,
            userId: user.id,
            adfree,
            requiresConsent: !hasAcceptedCurrentConsent(user),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get("/arcade", async (req, res) => {
    try {
        const response = await fetch("https://frogiesarcade.win/makesesh");
        const data = await response.json();

        res.json({ redir: data.redir });
    } catch (err) {
        console.error("Error fetching makesesh:", err);
        res.status(500).json({ error: "Failed to fetch makesesh" });
    }
});

router.post("/login", async (req, res) => {
    const { email, password, consentAccepted } = req.body;

    if (!consentAccepted) {
        return res.status(400).json({
            ok: false,
            reason: "consent_required",
        });
    }

    try {
        const result = await authenticateUserCredentials(email, password);

        if (!result.ok) {
            return res.status(200).json(result);
        }

        const client = await pool.connect();

        try {
            await client.query("BEGIN");
            await applyUserConsent(client, result.user.id, req);
            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }

        setSessionUser(req, result.user);
        return res.json({
            ok: true,
            token: result.user.token,
            requiresConsent: false,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({
            ok: false,
            reason: "server_error",
        });
    }
});

router.post("/register", async (req, res) => {
    const { email, password, consentAccepted } = req.body;

    if (!consentAccepted) {
        return res.status(400).json({
            ok: false,
            reason: "consent_required",
        });
    }

    try {
        const emailCheck = await pool.query("SELECT email FROM users WHERE email = $1", [email]);

        if (emailCheck.rowCount !== 0) {
            return res.status(200).json({
                ok: false,
                reason: "exists",
            });
        }

        const salt = generateRandomString(64);
        const token = generateRandomString(32);
        const userId = crypto.randomInt(1000000000, 10000000000);
        const hashedPass = crypto.createHash("sha256").update(password + salt).digest("hex");
        const client = await pool.connect();

        try {
            await client.query("BEGIN");
            await client.query(
                "INSERT INTO users (email, token, salt, password, verified, data, id, admin, consent_version, consented_at, consent_ip, consent_user_agent) VALUES ($1, $2, $3, $4, false, $5, $6, false, $7, NOW(), $8, $9)",
                [email, token, salt, hashedPass, "{}", userId, CURRENT_CONSENT_VERSION, req.ip || null, req.get("user-agent") || null]
            );
            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }

        setSessionUser(req, { id: userId, token, admin: false, email });
        return res.json({
            ok: true,
            token,
            requiresConsent: false,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({
            ok: false,
            reason: "server_error",
        });
    }
});

router.get("/ad", async (req, res) => {
    let serverKnownAdfree = false;

    try {
        serverKnownAdfree = await getAdfreeStateForUserId(req.session?.user_id);
    } catch (err) {
        console.error("Failed to load adfree state for ad bootstrap:", err);
    }

    const responseBody = `
(async () => {
    const adTagSrc = "https://5gvci.com/act/files/tag.min.js?z=10917472";
    const adTagSelector = 'script[src="https://5gvci.com/act/files/tag.min.js?z=10917472"]';
    const adServiceWorkerPath = "/sw.js";
    const popunderScriptBody = ${JSON.stringify(popunderScriptBody)};
    const serverKnownAdfree = ${JSON.stringify(serverKnownAdfree)};

    const cleanupAds = async () => {
        document.querySelectorAll(adTagSelector).forEach((element) => element.remove());

        if ("serviceWorker" in navigator) {
            try {
                const registrations = await navigator.serviceWorker.getRegistrations();
                await Promise.all(
                    registrations
                        .filter((registration) => {
                            const scriptUrl = registration.active?.scriptURL
                                || registration.installing?.scriptURL
                                || registration.waiting?.scriptURL
                                || "";
                            return scriptUrl.endsWith(adServiceWorkerPath);
                        })
                        .map((registration) => registration.unregister())
                );
            } catch (error) {
                console.error("Failed to unregister ad service worker:", error);
            }
        }
    };

    const resolveAdfreeState = async () => {
        if (window.userAdfree === true) {
            return true;
        }

        const token = localStorage.getItem("token");
        if (!token) {
            return serverKnownAdfree;
        }

        try {
            const response = await fetch("/api/check", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token })
            });

            if (!response.ok) {
                return serverKnownAdfree;
            }

            const data = await response.json();
            if (data?.loggedIn && data?.adfree) {
                window.userAdfree = true;
                return true;
            }

            return false;
        } catch (error) {
            console.error("Failed to resolve adfree state:", error);
            return serverKnownAdfree;
        }
    };

    const appendAdTagLoader = () => {
        if (document.querySelector(adTagSelector)) {
            return;
        }

        const loader = document.createElement("script");
        loader.src = adTagSrc;
        loader.async = true;
        loader.setAttribute("data-cfasync", "false");
        document.head.appendChild(loader);
    };

    const appendPopunderScript = () => {
        if (!popunderScriptBody || window.__canlitePopunderInstalled) {
            return;
        }

        window.__canlitePopunderInstalled = true;
        const script = document.createElement("script");
        script.type = "text/javascript";
        script.setAttribute("data-cfasync", "false");
        script.text = popunderScriptBody;
        document.body.appendChild(script);
    };

    const registerAdServiceWorker = async () => {
        if (!("serviceWorker" in navigator)) {
            return;
        }

        try {
            const registration = await navigator.serviceWorker.getRegistration(adServiceWorkerPath);
            if (!registration) {
                await navigator.serviceWorker.register(adServiceWorkerPath);
            }
        } catch (error) {
            console.error("Failed to register ad service worker:", error);
        }
    };

    const isAdfree = await resolveAdfreeState();
    if (isAdfree) {
        await cleanupAds();
        return;
    }

    appendAdTagLoader();
    appendPopunderScript();
    await registerAdServiceWorker();
})();
`;

    res.set("Cache-Control", "no-store");
    res.type("application/javascript");
    return res.send(responseBody);
});

router.get("/postback", async (req, res) => {
    let replayKey = null;

    try {
        const {
            status,
            trans_id,
            user_id,
            amount_local,
            hash,
        } = req.query;

        const transactionId = String(trans_id || "");
        const providedHash = String(hash || "").toLowerCase();
        const expectedHash = getCpxExpectedHash(transactionId);

        if (!expectedHash || !providedHash) {
            return res.status(403).send("forbidden");
        }

        const providedHashBuffer = Buffer.from(providedHash, "utf8");
        const expectedHashBuffer = Buffer.from(expectedHash, "utf8");

        if (
            providedHashBuffer.length !== expectedHashBuffer.length ||
            !crypto.timingSafeEqual(providedHashBuffer, expectedHashBuffer)
        ) {
            return res.status(403).send("forbidden");
        }

        replayKey = `myapp:cpx:postback:${transactionId}`;
        const replayResult = await redisClient.set(replayKey, "1", { NX: true, EX: 60 * 60 * 24 * 90 });

        if (!replayResult) {
            return res.send("OK");
        }

        if (!["1", "2"].includes(String(status))) {
            return res.send("invalid");
        }

        const credits = roundCredits(Number.parseFloat(amount_local));
        if (!credits || !user_id || !transactionId) {
            return res.send("invalid");
        }

        const userResult = await pool.query(
            "SELECT data FROM users WHERE id = $1",
            [user_id]
        );

        if (userResult.rowCount === 0) {
            return res.send("invalid");
        }

        const currentBalance = getCreditBalance(userResult.rows[0].data);
        const nextBalance = status === "1"
            ? currentBalance + credits
            : currentBalance - credits;

        await pool.query(
            "UPDATE users SET data = $1 WHERE id = $2",
            [setCreditBalance(userResult.rows[0].data, nextBalance), user_id]
        );

        res.send("OK");
    } catch (err) {
        if (replayKey) {
            await redisClient.del(replayKey).catch(() => {});
        }
        console.error(err);
        res.status(500).send("error");
    }
});

router.post("/loadGameData", async (req, res) => {
    const { result: token } = req.body;

    try {
        const user = await pool.query("SELECT id FROM users WHERE token = $1", [token]);
        if (user.rowCount === 0) {
            return res.status(403).json({ error: "Invalid token" });
        }

        const userId = user.rows[0].id;
        const filePath = path.join(gameDataDirectory, `${userId}.json`);

        let data = "{}";
        try {
            data = await fs.readFile(filePath, "utf-8");
        } catch (readErr) {
            if (readErr.code !== "ENOENT") {
                throw readErr;
            }
        }

        try {
            return res.json({ gameData: JSON.parse(data) });
        } catch {
            return res.json({ gameData: {} });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server Error" });
    }
});

router.post("/logout", async (req, res) => {
    const token = generateRandomString(32);

    try {
        await pool.query("UPDATE users SET token = $1 WHERE token = $2", [token, req.session.token]);
        req.session.destroy((error) => {
            if (error) {
                return res.status(500).json({ error });
            }

            return res.json({ success: true });
        });
    } catch (err) {
        res.status(500).json({ error: err });
    }
});

router.get("/discord/link-status", async (req, res) => {
    if (!req.session?.user_id) {
        return res.status(401).json({ error: "Not logged in" });
    }

    try {
        const discordLink = await getDiscordLinkSummaryForUser(req.session.user_id);
        return res.json({ discordLink });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: "Failed to load Discord link status" });
    }
});

router.post("/discord/link-code", async (req, res) => {
    if (!req.session?.user_id) {
        return res.status(401).json({ error: "Not logged in" });
    }

    try {
        const pendingCode = await createDiscordLinkCodeForUser(req.session.user_id);
        const discordLink = await getDiscordLinkSummaryForUser(req.session.user_id);
        return res.json({
            success: true,
            pendingCode,
            discordLink,
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: "Failed to create Discord link code" });
    }
});

router.post("/discord/unlink", async (req, res) => {
    if (!req.session?.user_id) {
        return res.status(401).json({ error: "Not logged in" });
    }

    try {
        await unlinkDiscordAccountForUser(req.session.user_id);
        const discordLink = await getDiscordLinkSummaryForUser(req.session.user_id);
        return res.json({
            success: true,
            discordLink,
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: "Failed to unlink Discord account" });
    }
});

router.post("/switch", async (req, res) => {
    const { site } = req.body;
    if (!["https://wqgqvswarit.swarit.104.36.84.31.nip.io/", "https://us4-ubg.github.io", "https://petezahgames.com", "https://securedweb.xyz", "https://flamepass.com", "https://watch.bludclart.com"].includes(site)) {
        return res.status(400).send("Invalid site");
    }
    req.session.siteOveride = site;
    req.session.siteOverride = site;
    res.redirect(site);
});

router.post("/store/adfree", async (req, res) => {
    const requestedPlan = String(req.body.plan || "");
    const plan = ADFREE_PLANS[requestedPlan];

    if (!req.session.token) {
        return res.status(401).json({ error: "Not logged in" });
    }

    if (!plan) {
        return res.status(400).json({ error: "Invalid plan" });
    }

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const userResult = await client.query(
            "SELECT id, data FROM users WHERE token = $1 FOR UPDATE",
            [req.session.token]
        );

        if (userResult.rowCount === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ error: "Account not found" });
        }

        const user = userResult.rows[0];
        const balance = getCreditBalance(user.data);

        if (balance < plan.price) {
            await client.query("ROLLBACK");
            return res.status(400).json({ error: "Not enough credits" });
        }

        await client.query(
            "UPDATE users SET data = $1 WHERE id = $2",
            [setCreditBalance(user.data, balance - plan.price), user.id]
        );

        await extendAdfreeForDays(client, user.id, plan.days);

        await client.query("COMMIT");

        return res.json({
            success: true,
            credits: roundCredits(balance - plan.price),
            plan: requestedPlan,
        });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error(err);
        return res.status(500).json({ error: "Store purchase failed" });
    } finally {
        client.release();
    }
});

router.use("/private-links", privateLinkRoutes);

router.post("/saveGameData", async (req, res) => {
    const { token, localStorageData } = req.body;

    try {
        const user = await pool.query("SELECT id FROM users WHERE token = $1", [token]);
        if (user.rowCount === 0) {
            return res.status(403).json({ error: "Invalid token" });
        }

        const userId = user.rows[0].id;
        const filePath = path.join(gameDataDirectory, `${userId}.json`);

        await fs.mkdir(gameDataDirectory, { recursive: true });
        await fs.writeFile(filePath, JSON.stringify(localStorageData, null, 2), "utf-8");

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server Error" });
    }
});

router.get("/resolve/:id", async (req, res) => {
    const rawId = String(req.params.id || "").trim();
    const safeId = /^[a-zA-Z0-9._-]+$/.test(rawId) ? rawId : "";

    if (!safeId) {
        return res.status(400).send("Invalid asset id");
    }

    try {
        const response = await fetch(`https://raw.githubusercontent.com/freebuisness/html/main/${safeId}`, {
            redirect: "error",
        });
        if (!response.ok) {
            return res.status(response.status).send("Upstream request failed");
        }

        const content = await response.text();
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.send(content);
    } catch (error) {
        console.error("Failed to resolve remote html:", error);
        res.status(502).send("Failed to resolve content");
    }
});

router.get("/img/:id", async (req, res) => {
    const gameName = req.params.id;
    const game = gameByName.get(gameName);

    try {
        if (!game) {
            return res.status(404).json({ error: "Game not found" });
        }

        if (game.prev) {
            return res.sendFile(__dirname + "/static" + game.prev);
        }

        return res.sendFile(__dirname + "/static/d/" + game.name.replace(/\//g, "") + ".jpg");
    } catch (e) {
        res.status(500).json({ error: "Server Error" });
    }
});

export default router;
