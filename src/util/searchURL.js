import axios from 'axios';

function normalizeQuery(q) {
    return q
        .toLowerCase()
        .replace(/[^a-z0-9\s.]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/*
EXTREMELY ILLEGAL / DANGEROUS TERMS
*/
const HARD_BLOCK = [

    // CSAM related
    "cp",
    "little boy",
    "little girl",
    "child porn",
    "children naked",
    "childporn",
    "childpornography",
    "minor sex",
    "underage sex",
    "teen sex",
    "preteens",
    "lolicon",
    "shotacon",
    "pthc",
    "pedo",
    "pedophile",
    "pedophilia",

    // porn sites
    "pornhub",
    "xvideos",
    "xnxx",
    "xhamster",
    "redtube",
    "youporn",
    "tube8",
    "spankbang",
    "hentai",
    "rule34",
    "rule 34",
    "sexvideos",
    "porn",
    "xxx",
    "nsfw",

    // dark web / illegal markets
    "dark web market",
    "carding site",
    "credit card dump",
    "buy stolen credit card",
    "buy cocaine",
    "buy heroin",
    "buy meth",
    "buy fentanyl",
    "hire a hitman",
    "hire hitman",
    "murder for hire",

    // violent illegal guides
    "how to build a bomb",
    "how to make a bomb",
    "pipe bomb",
    "pressure cooker bomb",
    "how to dispose of a body",
    "how to hide a body",
    "how to dissolve a body",

];

/*
SEXUAL CONTEXT WORDS
Used with age detection
*/
const SEX_CONTEXT = [
    "sex",
    "nude",
    "naked",
    "porn",
    "xxx",
    "rule34",
    "hentai",
    "lewd",
    "nsfw",
    "boobs",
    "blowjob",
    "anal",
    "fetish",
    "cum",
    "milf",
    "bdsm",
    "bikini",
    "topless",
    "penis",
    "butt",
    "booty",
    "bootty",
    "rape",
    "vag",
    "vagina",
    "dick"
];

// --- helpers ---
function tokenize(q) {
  return q.split(/\s+/).filter(Boolean);
}

function isURL(input) {
  return /^https?:\/\//i.test(input) ||
         (input.includes(".") && !input.includes(" "));
}

function looksRandom(token) {
  return token.length > 20 && /^[a-z0-9\-_]+$/i.test(token);
}

// normalize repeated letters (anti-bypass)
function normalizeRepeats(str) {
  return str.replace(/(.)\1{2,}/g, "$1$1");
}

// collapse spaced bypass ("b a d" -> "bad")
function collapseSpaced(str) {
  return str.replace(/\b(?:\w\s+){2,}\w\b/g, m =>
    m.replace(/\s+/g, "")
  );
}

// turn your word lists into SAFE regex (word boundaries)
function buildWordRegex(list) {
  return list.map(word => {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i");
  });
}

const HARD_BLOCK_REGEX = buildWordRegex(HARD_BLOCK);
const SEX_CONTEXT_REGEX = buildWordRegex(SEX_CONTEXT);

// --- improved checks ---

function hasHardBlock(q) {
  return HARD_BLOCK_REGEX.some(r => r.test(q));
}

function hasSexContext(tokens) {
  return tokens.some(t => SEX_CONTEXT.includes(t));
}

function hasUnderage(q) {
  return /\b([0-9]|1[0-7])\b/.test(q);
}

// --- main filter ---
function isBlocked(query) {
  if (!query) return false;

  // 1. Skip URLs entirely (fixes your OAuth issue)
  if (isURL(query)) return false;

  // 2. Normalize + anti-bypass cleanup
  let q = normalizeQuery(query);
  q = normalizeRepeats(q);
  q = collapseSpaced(q);

  // 3. Tokenize + remove random garbage
  const tokens = tokenize(q).filter(t => !looksRandom(t));

  let score = 0;

  // 4. HARD BLOCK (exact word / phrase match only)
  if (hasHardBlock(q)) score += 5;

  // 5. Context-based rule (no longer overly aggressive)
  if (hasSexContext(tokens) && hasUnderage(q)) {
    score += 5;
  }

  // 6. Optional: weak signal (very short suspicious queries)
  if (tokens.length <= 2 && tokens.some(t => t.length <= 2)) {
    score += 1;
  }

  return score >= 5;
}

async function getIP() {
    try {
        const res = await fetch("/api/ip");
        const data = await res.text();
        return data;
    } catch (err) {
        console.error("Failed to fetch IP:", err);
    }
}

function showBlockMessage() {
    const box = document.createElement("div");

    box.textContent = "This search is blocked on this proxy and has been logged.";
    box.style.position = "fixed";
    box.style.bottom = "20px";
    box.style.right = "20px";
    box.style.background = "#c0392b";
    box.style.color = "white";
    box.style.padding = "12px 16px";
    box.style.borderRadius = "6px";
    box.style.zIndex = "9999";

    document.body.appendChild(box);

    setTimeout(() => box.remove(), 4000);
}

async function searchURL(
    input,
    searchEngine = "https://www.google.com/search?q=%s",
) {

    plausible("Search", {props: {"Query": input}});

    if (isBlocked(input)) {

        plausible("Illegal search", {props: {"Bad Query": input, "IP": await getIP(), "Time": new Date().toISOString()}});

        showBlockMessage();

        return (
            window.location.origin +
            window.__uv$config.prefix +
            window.__uv$config.encodeUrl("https://example.com")
        );
    }

    const q = normalizeQuery(input);

    if (q.includes('roblox')) {
        alert('go to nowgg.lol for unblocked roblox');
    }

    let resolvedUrl;

    if (input.match(/^https?:\/\//)) {
        resolvedUrl = input;
    } else if (input.includes(".") && !input.includes(" ")) {
        resolvedUrl = "https://" + input;
    } else {
        resolvedUrl = searchEngine.replace("%s", encodeURIComponent(input));
    }

    return (
        window.location.origin +
        window.__uv$config.prefix +
        window.__uv$config.encodeUrl(resolvedUrl)
    );
}

export { searchURL };
