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
import {
    getAdserverBaseUrl,
    getForwardedAccountId,
} from "./adserverClient.js";
import privateLinkRoutes from "./routes/privateLinks.js";
import {
    createDiscordLinkCodeForUser,
    getDiscordLinkSummaryForUser,
    unlinkDiscordAccountForUser,
} from "./discordLinks.js";

const DEFAULT_ADSERVER_BASE_URL = "http://127.0.0.1:3010";
const AUCTION_TTL_MS = 1000 * 60 * 60;
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
const behavioralAuctionStore = new Map();

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
const getBehavioralBaseUrl = () => getAdserverBaseUrl({
    adserverBaseUrl: process.env.BEHAVIORAL_INTENT_BASE_URL || process.env.ADSERVER_BASE_URL || DEFAULT_ADSERVER_BASE_URL,
});

const getBehavioralUserId = async (req, visitHash) => {
    const accountId = await getForwardedAccountId(req);
    if (accountId) {
        return String(accountId);
    }

    if (visitHash) {
        return `anon:${visitHash}`;
    }

    if (req.sessionID) {
        return `anon:${req.sessionID}`;
    }

    return `anon:${crypto.randomUUID()}`;
};

const getBehavioralSessionId = (req, visitHash) => {
    if (visitHash) {
        return String(visitHash);
    }

    if (req.session?.adSignalVisitHash) {
        return String(req.session.adSignalVisitHash);
    }

    if (req.sessionID) {
        return String(req.sessionID);
    }

    return crypto.randomUUID();
};

const getBehavioralRequestContext = async (req, explicitVisitHash = null) => {
    const visitHash = String(
        explicitVisitHash
        || req.body?.visitHash
        || req.query?.visitHash
        || req.session?.adSignalVisitHash
        || req.sessionID
        || crypto.randomUUID()
    );

    return {
        visitHash,
        sessionId: getBehavioralSessionId(req, visitHash),
        userId: await getBehavioralUserId(req, visitHash),
        ip: requestIp.getClientIp(req) || req.ip || "",
        userAgent: req.get("user-agent") || "CanLite-Behavioral-Proxy/1.0",
        language: req.get("accept-language") || "",
    };
};

const encodeTrackingToken = (payload) => Buffer.from(
    JSON.stringify(payload),
    "utf8"
).toString("base64url");

const decodeTrackingToken = (token) => {
    if (!token) {
        return null;
    }

    try {
        const decoded = Buffer.from(String(token), "base64url").toString("utf8");
        const parsed = JSON.parse(decoded);
        if (!parsed || typeof parsed !== "object") {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
};

const escapeHtml = (value) => String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const buildSyntheticSearchUrl = (query) => {
    const normalizedQuery = String(query || "").trim();
    return `https://www.google.com/search?q=${encodeURIComponent(normalizedQuery)}`;
};

const buildBehavioralHeaders = (req) => ({
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": req.get("user-agent") || "CanLite-Behavioral-Proxy/1.0",
});

const behavioralFetchJson = async (req, apiPath, payload) => {
    const baseUrl = getBehavioralBaseUrl();
    const response = await fetch(`${baseUrl}${apiPath}`, {
        method: "POST",
        headers: buildBehavioralHeaders(req),
        body: JSON.stringify(payload || {}),
    });
    const rawText = await response.text();
    let body = {};

    try {
        body = rawText ? JSON.parse(rawText) : {};
    } catch {
        body = rawText ? { error: rawText } : {};
    }

    return {
        ok: response.ok,
        status: response.status,
        body,
    };
};

const cleanupBehavioralAuctionStore = () => {
    const cutoff = Date.now() - AUCTION_TTL_MS;

    for (const [auctionId, meta] of behavioralAuctionStore.entries()) {
        if (!meta || meta.createdAt < cutoff) {
            behavioralAuctionStore.delete(auctionId);
        }
    }
};

const rememberAuction = (auctionId, meta) => {
    cleanupBehavioralAuctionStore();
    behavioralAuctionStore.set(auctionId, {
        clickRecorded: false,
        ...meta,
        createdAt: Date.now(),
    });
};

const buildAuctionClickUrl = (auctionId, token) => `/api/ads/click/${encodeURIComponent(auctionId)}?token=${encodeURIComponent(token)}`;

const buildAffiliateMarkup = ({ auctionId, token, ad, width, height }) => {
    const clickHref = buildAuctionClickUrl(auctionId, token);
    const title = escapeHtml(ad.title || ad.category || "Sponsored");
    const text = escapeHtml(ad.text || ad.merchant || "");
    const image = ad.image ? `<img src="${escapeHtml(ad.image)}" alt="${title}" style="display:block;width:100%;height:auto;border-radius:10px;object-fit:cover;">` : "";
    const icon = ad.icon ? `<img src="${escapeHtml(ad.icon)}" alt="" style="width:28px;height:28px;border-radius:999px;object-fit:cover;flex:0 0 auto;">` : "";
    const maxWidth = Number(width) > 0 ? Number(width) : 300;
    const minHeight = Number(height) > 0 ? Number(height) : 250;

    return `
<a href="${clickHref}" target="_top" rel="nofollow sponsored noopener" style="box-sizing:border-box;display:flex;flex-direction:column;gap:12px;width:100%;max-width:${maxWidth}px;min-height:${minHeight}px;padding:14px;border-radius:14px;background:linear-gradient(180deg,#101820 0%,#16283b 100%);color:#f5f7fa;font-family:Arial,sans-serif;text-decoration:none;overflow:hidden;">
${image}
<div style="display:flex;align-items:flex-start;gap:10px;">
${icon}
<div style="min-width:0;">
<div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#8cc8ff;margin-bottom:6px;">Sponsored</div>
<div style="font-size:16px;font-weight:700;line-height:1.25;margin-bottom:6px;">${title}</div>
${text ? `<div style="font-size:13px;line-height:1.45;color:#d4dde8;">${text}</div>` : ""}
</div>
</div>
<div style="margin-top:auto;display:inline-flex;align-self:flex-start;padding:9px 12px;border-radius:999px;background:#2f7ff7;color:#fff;font-size:12px;font-weight:700;">Learn more</div>
</a>`.trim();
};

const buildAuctionResponse = (req, serveBody, fallbackDimensions = {}) => {
    const topAd = Array.isArray(serveBody?.ads) ? serveBody.ads[0] : null;
    const auctionId = crypto.randomUUID();

    if (!topAd?.ad_id || !topAd?.impression_id) {
        return {
            auction: {
                id: auctionId,
                provider: serveBody?.provider || null,
            },
            winner: null,
            count: Number(serveBody?.count || 0),
        };
    }

    const trackingToken = encodeTrackingToken({
        auctionId,
        impressionId: topAd.impression_id,
        adId: String(topAd.ad_id),
        clickUrl: topAd.click_url || "",
    });
    const width = Number(fallbackDimensions.width || topAd.w || 300);
    const height = Number(fallbackDimensions.height || topAd.h || 250);

    rememberAuction(auctionId, {
        token: trackingToken,
        impressionId: topAd.impression_id,
        adId: String(topAd.ad_id),
        clickUrl: topAd.click_url || "",
    });

    return {
        auction: {
            id: auctionId,
            provider: serveBody?.provider || null,
            triedProviders: serveBody?.tried_providers || [],
        },
        winner: {
            affiliate: true,
            w: width,
            h: height,
            adm: buildAffiliateMarkup({
                auctionId,
                token: trackingToken,
                ad: topAd,
                width,
                height,
            }),
            tracking: {
                impressionToken: trackingToken,
                clickToken: trackingToken,
            },
            clickUrl: buildAuctionClickUrl(auctionId, trackingToken),
            title: topAd.title || "",
            text: topAd.text || "",
            image: topAd.image || null,
            icon: topAd.icon || null,
        },
        count: Number(serveBody?.count || 1),
    };
};

const seedBehavioralContext = async (req, context, { pageUrl = "", query = "" } = {}) => {
    const normalizedPageUrl = String(pageUrl || "").trim();
    const normalizedQuery = String(query || "").trim();
    const seedUrl = normalizedPageUrl || (normalizedQuery ? buildSyntheticSearchUrl(normalizedQuery) : "");

    if (!seedUrl) {
        return null;
    }

    return behavioralFetchJson(req, "/ingest", {
        user_id: context.userId,
        session_id: context.sessionId,
        timestamp: Date.now(),
        url: seedUrl,
        referrer: req.get("referer") || null,
    });
};

const recordBehavioralClickOnce = async (req, tokenPayload) => {
    const auctionId = String(tokenPayload?.auctionId || "").trim();
    const impressionId = Number(tokenPayload?.impressionId);
    const adId = String(tokenPayload?.adId || "").trim();

    if (!auctionId || !Number.isFinite(impressionId) || !adId) {
        return {
            ok: false,
            status: 400,
            body: { error: "Invalid click tracking payload." },
        };
    }

    const meta = behavioralAuctionStore.get(auctionId);
    if (meta?.clickRecorded) {
        return {
            ok: true,
            status: 200,
            body: { status: "already_recorded" },
        };
    }

    const response = await behavioralFetchJson(req, "/feedback/click", {
        impression_id: impressionId,
        ad_id: adId,
    });

    if (response.ok) {
        behavioralAuctionStore.set(auctionId, {
            ...(meta || {}),
            clickRecorded: true,
            createdAt: meta?.createdAt || Date.now(),
        });
    }

    return response;
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

router.post("/urls", async (req, res) => {
    try {
        const url = String(req.body?.url || "").trim();
        if (!url) {
            return res.status(400).json({ error: "url is required" });
        }

        const context = await getBehavioralRequestContext(req, req.body?.visitHash);
        const response = await behavioralFetchJson(req, "/ingest", {
            user_id: context.userId,
            session_id: context.sessionId,
            timestamp: Date.now(),
            url,
            referrer: req.get("referer") || null,
        });

        return res.status(response.status).json(response.body);
    } catch (error) {
        console.error("Failed to proxy URL submission:", error);
        return res.status(500).json({ error: "Failed to proxy URL submission." });
    }
});

router.post("/searches", async (req, res) => {
    try {
        const query = String(req.body?.query || "").trim();
        if (!query) {
            return res.status(400).json({ error: "query is required" });
        }

        const context = await getBehavioralRequestContext(req, req.body?.visitHash);
        const response = await behavioralFetchJson(req, "/ingest", {
            user_id: context.userId,
            session_id: context.sessionId,
            timestamp: Date.now(),
            url: buildSyntheticSearchUrl(query),
            referrer: String(req.body?.pageUrl || req.get("referer") || "").trim() || null,
        });

        return res.status(response.status).json(response.body);
    } catch (error) {
        console.error("Failed to proxy search submission:", error);
        return res.status(500).json({ error: "Failed to proxy search submission." });
    }
});

router.post("/ads/auction", async (req, res) => {
    try {
        const context = await getBehavioralRequestContext(req, req.body?.visitHash);
        const keywords = Array.isArray(req.body?.keywords)
            ? req.body.keywords.map((value) => String(value || "").trim()).filter(Boolean)
            : [];

        const seededContext = await seedBehavioralContext(req, context, {
            pageUrl: req.body?.pageUrl,
            query: req.body?.query,
        });
        let behavioralSessionId = String(
            seededContext?.body?.session_id
            || context.sessionId
        );

        let response = await behavioralFetchJson(req, "/ads/serve", {
            user_id: context.userId,
            session_id: behavioralSessionId,
            ua: context.userAgent,
            ip: context.ip,
            var: context.userId.slice(0, 40),
            lang: context.language,
            top_k: 1,
            event_types: [],
            session_signals: {
                placement_id: req.body?.placementId || null,
                page_url: req.body?.pageUrl || null,
                page_title: req.body?.pageTitle || null,
                page_context: req.body?.pageContext || null,
                ad_type: req.body?.adType || null,
                width: Number(req.body?.width || 0) || null,
                height: Number(req.body?.height || 0) || null,
                query: req.body?.query || null,
                keywords,
            },
        });

        if (response.status === 404) {
            const retrySeededContext = await seedBehavioralContext(req, context, {
                query: req.body?.query,
            });
            behavioralSessionId = String(
                retrySeededContext?.body?.session_id
                || behavioralSessionId
            );
            response = await behavioralFetchJson(req, "/ads/serve", {
                user_id: context.userId,
                session_id: behavioralSessionId,
                ua: context.userAgent,
                ip: context.ip,
                var: context.userId.slice(0, 40),
                lang: context.language,
                top_k: 1,
                event_types: [],
                session_signals: {
                    placement_id: req.body?.placementId || null,
                    page_url: req.body?.pageUrl || null,
                    page_title: req.body?.pageTitle || null,
                    page_context: req.body?.pageContext || null,
                    ad_type: req.body?.adType || null,
                    width: Number(req.body?.width || 0) || null,
                    height: Number(req.body?.height || 0) || null,
                    query: req.body?.query || null,
                    keywords,
                },
            });
        }

        if (!response.ok) {
            return res.status(response.status).json(response.body);
        }

        return res.json(buildAuctionResponse(req, response.body, {
            width: req.body?.width,
            height: req.body?.height,
        }));
    } catch (error) {
        console.error("Failed to proxy ad auction:", error);
        return res.status(500).json({ error: "Failed to proxy ad auction." });
    }
});

router.post("/ads/events", async (req, res) => {
    try {
        const eventType = String(req.body?.eventType || "").trim().toLowerCase();
        const tokenPayload = decodeTrackingToken(req.body?.token);

        if (!eventType || !tokenPayload?.impressionId || !tokenPayload?.adId) {
            return res.status(400).json({ error: "Invalid ad event payload." });
        }

        if (eventType === "impression") {
            return res.json({ ok: true, status: "ignored" });
        }

        let response;
        if (eventType === "click") {
            response = await recordBehavioralClickOnce(req, tokenPayload);
        } else if (eventType === "conversion") {
            response = await behavioralFetchJson(req, "/feedback/conversion", {
                impression_id: Number(tokenPayload.impressionId),
                ad_id: String(tokenPayload.adId),
                conversion_value: req.body?.conversionValue ?? null,
            });
        } else if (eventType === "dwell") {
            response = await behavioralFetchJson(req, "/feedback/dwell", {
                impression_id: Number(tokenPayload.impressionId),
                dwell_seconds: Number(req.body?.dwellSeconds || 0),
                bounced: Boolean(req.body?.bounced),
            });
        } else {
            return res.status(400).json({ error: "Unsupported ad event type." });
        }

        return res.status(response.status).json(response.body);
    } catch (error) {
        console.error("Failed to proxy ad event:", error);
        return res.status(500).json({ error: "Failed to proxy ad event." });
    }
});

router.get("/ads/click/:auctionId", async (req, res) => {
    try {
        const auctionMeta = behavioralAuctionStore.get(String(req.params.auctionId));
        const tokenPayload = decodeTrackingToken(req.query?.token) || decodeTrackingToken(auctionMeta?.token);

        if (!tokenPayload?.clickUrl) {
            return res.status(404).send("Ad click target not found.");
        }

        if (tokenPayload.impressionId && tokenPayload.adId) {
            const response = await recordBehavioralClickOnce(req, tokenPayload);

            if (!response.ok) {
                return res.status(response.status).json(response.body);
            }
        }

        return res.redirect(302, tokenPayload.clickUrl);
    } catch (error) {
        console.error("Failed to proxy ad click:", error);
        return res.status(500).json({ error: "Failed to proxy ad click." });
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
