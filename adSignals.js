import crypto from "crypto";

const DEFAULT_PAGE_VISIT_EXCLUDE_PREFIXES = [
    "/api/",
    "/static/",
    "/dist/",
    "/uv/",
    "/~/uv/",
    "/b/",
];

export function getOrCreateVisitHash(req) {
    if (!req.session) {
        return crypto.randomUUID();
    }

    if (!req.session.adSignalVisitHash) {
        req.session.adSignalVisitHash = crypto.randomUUID();
    }

    return req.session.adSignalVisitHash;
}

export function attachVisitHash(req, res, next) {
    res.locals.visitHash = getOrCreateVisitHash(req);
    next();
}

export function buildAbsoluteRequestUrl(req) {
    return `${req.protocol}://${req.get("host")}${req.originalUrl || req.url}`;
}

export function shouldLogPageVisit(req) {
    if (req.method !== "GET") {
        return false;
    }

    const acceptHeader = String(req.get("accept") || "");
    if (!acceptHeader.includes("text/html")) {
        return false;
    }

    return !DEFAULT_PAGE_VISIT_EXCLUDE_PREFIXES.some((prefix) => req.path.startsWith(prefix));
}

export function createPageVisitLogger(options = {}) {
    return (req, res, next) => {
        const visitHash = res.locals.visitHash || getOrCreateVisitHash(req);
        res.locals.visitHash = visitHash;

        if (!shouldLogPageVisit(req)) {
            return next();
        }

        const pageUrl = buildAbsoluteRequestUrl(req);
        const apiOrigin = options.apiOrigin || `${req.protocol}://${req.get("host")}`;
        const apiPath = options.apiPath || "/api/urls";

        Promise.resolve()
            .then(() => fetch(`${apiOrigin}${apiPath}`, {
                method: "POST",
                headers: {
                    Accept: "application/json",
                    "Content-Type": "application/json",
                    "User-Agent": req.get("user-agent") || "CanLite-Page-Visit-Logger/1.0",
                },
                body: JSON.stringify({
                    url: pageUrl,
                    visitHash,
                }),
            }))
            .then(async (response) => ({
                ok: response.ok,
                status: response.status,
                body: await response.json().catch(() => ({})),
            }))
            .then((result) => {
                if (!result?.ok && result?.status !== 409) {
                    console.error("Failed to log page visit:", result?.body || result);
                }
            })
            .catch((error) => {
                console.error("Failed to log page visit:", error);
            });

        return next();
    };
}
