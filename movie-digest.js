#!/usr/bin/env node
/**

- ╔══════════════════════════════════════════════════════╗
- ║         Movie Rating Sentinel — Daily Digest         ║
- ║  Scans RSS → checks IMDb/RT → emails top films       ║
- ╚══════════════════════════════════════════════════════╝
- 
- SETUP:
- npm install node-fetch xml2js @sendgrid/mail dotenv
- 
- ENVIRONMENT VARIABLES (.env file):
- RSS_FEED_URL=https://yoursite.com/movies/rss
- OMDB_API_KEY=your_omdb_key          # free at omdbapi.com/apikey.aspx
- SENDGRID_API_KEY=your_key           # free at sendgrid.com
- EMAIL_FROM=noreply@yourdomain.com
- EMAIL_TO=you@example.com
- 
- No paid AI API needed — titles are extracted directly from RSS using
- smart text parsing (strips noise, years, tags, site names, etc.)
- 
- SCHEDULE (cron — runs at 6 AM EST = 11:00 UTC):
- 0 11 * * * /usr/bin/node /path/to/movie-digest.js >> /var/log/movie-digest.log 2>&1
- 
- GITHUB ACTIONS ALTERNATIVE: see .github/workflows/movie-digest.yml below
  */

“use strict”;

require(“dotenv”).config();
const fetch = (…args) => import(“node-fetch”).then(({ default: f }) => f(…args));
const xml2js = require(“xml2js”);
const sgMail = require(”@sendgrid/mail”);

// ── Config ────────────────────────────────────────────────────────────────────

const CONFIG = {
rssFeedUrl:       process.env.RSS_FEED_URL       || “https://example.com/movies/rss”,
omdbApiKey:       process.env.OMDB_API_KEY        || “”,
sendgridApiKey:   process.env.SENDGRID_API_KEY    || “”,
emailFrom:        process.env.EMAIL_FROM          || “digest@yourdomain.com”,
emailTo:          process.env.EMAIL_TO            || “you@example.com”,
imdbThreshold:    parseFloat(process.env.IMDB_THRESHOLD  || “8.0”),
rtThreshold:      parseInt(process.env.RT_THRESHOLD      || “80”),
maxMoviesToCheck: parseInt(process.env.MAX_MOVIES        || “30”),
};

// ── Logging ───────────────────────────────────────────────────────────────────

const log = {
info:    (msg) => console.log(`[INFO]  ${new Date().toISOString()} ${msg}`),
warn:    (msg) => console.warn(`[WARN]  ${new Date().toISOString()} ${msg}`),
error:   (msg) => console.error(`[ERROR] ${new Date().toISOString()} ${msg}`),
success: (msg) => console.log(`[OK]    ${new Date().toISOString()} ${msg}`),
};

// ── Step 1: Fetch & Parse RSS ─────────────────────────────────────────────────

async function fetchRSSItems(url) {
log.info(`Fetching RSS feed: ${url}`);
const res = await fetch(url, {
headers: { “User-Agent”: “MovieDigestBot/1.0” },
timeout: 15000,
});
if (!res.ok) throw new Error(`RSS fetch failed: ${res.status} ${res.statusText}`);
const xml = await res.text();
const parsed = await xml2js.parseStringPromise(xml, { explicitArray: false });

const channel = parsed?.rss?.channel || parsed?.feed;
const items = channel?.item || channel?.entry || [];
const arr = Array.isArray(items) ? items : [items];

log.info(`RSS returned ${arr.length} items`);
return arr.map((item) => ({
title:       item.title?._ || item.title || “”,
description: item.description?._ || item.description || item.summary?._ || item.summary || “”,
link:        item.link?._ || item.link || “”,
}));
}

// ── Step 2: Extract Movie Titles from RSS (no AI needed) ─────────────────────

// Noise patterns to strip from RSS item titles before sending to OMDb
const STRIP_PATTERNS = [
/\b(review|trailer|clip|featurette|interview|behind the scenes|exclusive|watch|stream|streaming|now playing|in theaters?|opens?|opening|coming soon|new release|box office)\b/gi,
/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi,
/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/gi,
/\d{4}-\d{2}-\d{2}/g,         // dates like 2024-05-01
/\b(19|20)\d{2}\b/g,          // standalone years like 2024
/[:-–|]+.*$/,                 // everything after a colon/dash/pipe (site names, subtitles)
/\s*[[(].*?[])]\s*/g,      // anything in brackets or parens
/^\s*(the|a|an)\s+/gi,         // leading articles (restored after lookup by OMDb)
/[^a-zA-Z0-9\s’&!?,.]/g,     // special characters except common ones
];

// Words that strongly suggest an item is NOT a standalone movie title
const NON_MOVIE_SIGNALS = [
/\b(episode|ep.?|season|s\d+e\d+|series|show|podcast|chapter)\b/i,
/\b(top \d+|best \d+|\d+ movies?)\b/i,
/\b(week|weekend|daily|tonight)\b/i,
];

function cleanTitle(raw) {
let t = raw;
for (const pattern of STRIP_PATTERNS) {
t = t.replace(pattern, “ “);
}
return t.replace(/\s+/g, “ “).trim();
}

function looksLikeMovieTitle(raw) {
for (const signal of NON_MOVIE_SIGNALS) {
if (signal.test(raw)) return false;
}
const cleaned = cleanTitle(raw);
// Must be between 1 and 8 words and at least 2 characters
const wordCount = cleaned.split(/\s+/).filter(Boolean).length;
return cleaned.length >= 2 && wordCount >= 1 && wordCount <= 8;
}

function extractMovieTitles(rssItems) {
log.info(“Extracting movie titles from RSS items using text parsing…”);

const seen = new Set();
const titles = [];

for (const item of rssItems) {
const raw = item.title || “”;
if (!raw) continue;

```
if (!looksLikeMovieTitle(raw)) {
  log.info(`  skip (non-movie signal): "${raw}"`);
  continue;
}

const cleaned = cleanTitle(raw);
if (!cleaned || seen.has(cleaned.toLowerCase())) continue;

seen.add(cleaned.toLowerCase());
titles.push(cleaned);
log.info(`  ✓ "${raw}" → "${cleaned}"`);
```

}

log.success(`Extracted ${titles.length} candidate title(s) from ${rssItems.length} RSS items`);
return titles;
}

// ── Step 3: Look Up Ratings on OMDb (IMDb + RT) ───────────────────────────────

async function getMovieRatings(title) {
const clean = title.replace(/(.*?)/g, “”).trim();
const url = `https://www.omdbapi.com/?t=${encodeURIComponent(clean)}&apikey=${CONFIG.omdbApiKey}`;

const res = await fetch(url, { timeout: 10000 });
const data = await res.json();

if (data.Response === “False”) {
log.warn(`  OMDb: "${title}" not found`);
return null;
}

const imdb = data.imdbRating && data.imdbRating !== “N/A”
? parseFloat(data.imdbRating) : null;

const rtSource = (data.Ratings || []).find((r) => r.Source === “Rotten Tomatoes”);
const rt = rtSource ? parseInt(rtSource.Value) : null;

return {
title:    data.Title,
year:     data.Year,
imdb,
rt,
genre:    data.Genre    || “N/A”,
director: data.Director || “N/A”,
plot:     data.Plot     || “N/A”,
poster:   data.Poster !== “N/A” ? data.Poster : null,
imdbId:   data.imdbID,
};
}

function passesThreshold(movie) {
const imdbOk   = movie.imdb !== null && movie.imdb >= CONFIG.imdbThreshold;
const rtOk     = movie.rt   !== null && movie.rt   >= CONFIG.rtThreshold;
const imdbFail = movie.imdb !== null && movie.imdb < CONFIG.imdbThreshold;
const rtFail   = movie.rt   !== null && movie.rt   < CONFIG.rtThreshold;
if (imdbOk && !rtFail) return true;
if (rtOk   && !imdbFail) return true;
return false;
}

async function rateMovies(titles) {
log.info(`Checking ratings for ${Math.min(titles.length, CONFIG.maxMoviesToCheck)} movie(s)…`);
const results = [];

for (const title of titles.slice(0, CONFIG.maxMoviesToCheck)) {
log.info(`  → ${title}`);
try {
const info = await getMovieRatings(title);
if (info) {
const pass = passesThreshold(info);
log.info(`     IMDb: ${info.imdb ?? "N/A"} | RT: ${info.rt != null ? info.rt + "%" : "N/A"} | ${pass ? "✅ PASS" : "❌ skip"}`);
results.push({ …info, passes: pass });
}
} catch (err) {
log.warn(`  Error fetching "${title}": ${err.message}`);
}

```
// be polite to the API
await new Promise((r) => setTimeout(r, 300));
```

}

return results;
}

// ── Step 4: Build Email ───────────────────────────────────────────────────────

function buildHTMLEmail(movies, feedUrl) {
const date = new Date().toLocaleDateString(“en-US”, {
weekday: “long”, year: “numeric”, month: “long”, day: “numeric”,
});

const movieCards = movies.map((m) => `<tr> <td style="padding:20px 0;border-bottom:1px solid #1e293b;"> <table width="100%" cellpadding="0" cellspacing="0"> <tr> ${m.poster ?`<td width="80" valign="top" style="padding-right:16px;">
<img src="${m.poster}" width="80" style="border-radius:6px;display:block;" alt="${m.title}">
</td>`: ""} <td valign="top"> <p style="margin:0 0 6px;font-size:18px;font-weight:600;color:#f1f5f9;"> ${m.title} <span style="font-size:13px;color:#475569;font-weight:400;">(${m.year})</span> </p> <p style="margin:0 0 10px;"> ${m.imdb !== null ?`<span style="background:#14532d;color:#86efac;padding:3px 10px;border-radius:4px;font-size:12px;font-family:monospace;margin-right:8px;">IMDb ${m.imdb}/10</span>`: ""} ${m.rt  !== null ?`<span style="background:#713f12;color:#fde68a;padding:3px 10px;border-radius:4px;font-size:12px;font-family:monospace;">🍅 ${m.rt}%</span>`: ""} </p> <p style="margin:0 0 4px;font-size:12px;color:#64748b;">${m.genre} · Dir. ${m.director}</p> <p style="margin:0;font-size:13px;color:#94a3b8;line-height:1.6;">${m.plot}</p> ${m.imdbId ?`<p style="margin:8px 0 0;"><a href="https://www.imdb.com/title/${m.imdbId}/" style="color:#818cf8;font-size:12px;text-decoration:none;">View on IMDb →</a></p>`: ""} </td> </tr> </table> </td> </tr>`).join(””);

return `<!DOCTYPE html>

<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0f;font-family:Georgia,serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0f;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

```
    <!-- Header -->
    <tr><td style="background:linear-gradient(135deg,#1a0a2e,#0f0a1e);border-radius:12px 12px 0 0;padding:36px 32px;border-bottom:1px solid #1e293b;">
      <p style="margin:0 0 4px;font-size:11px;letter-spacing:0.3em;color:#7c3aed;font-family:monospace;text-transform:uppercase;">◈ Movie Rating Sentinel</p>
      <h1 style="margin:0 0 8px;font-size:28px;font-weight:400;color:#f1f5f9;letter-spacing:-0.02em;">
        🎬 Your Daily <em style="color:#818cf8;">Top Films</em>
      </h1>
      <p style="margin:0;font-size:13px;color:#475569;">${date}</p>
    </td></tr>

    <!-- Summary bar -->
    <tr><td style="background:#0f172a;padding:16px 32px;border-bottom:1px solid #1e293b;">
      <p style="margin:0;font-size:13px;color:#64748b;font-family:monospace;">
        Found <strong style="color:#818cf8;">${movies.length} film${movies.length !== 1 ? "s" : ""}</strong> rated
        IMDb ≥ ${CONFIG.imdbThreshold}/10 or RT ≥ ${CONFIG.rtThreshold}% &nbsp;·&nbsp;
        Source: <a href="${feedUrl}" style="color:#475569;">${feedUrl.replace(/https?:\/\//, "").slice(0, 50)}</a>
      </p>
    </td></tr>

    <!-- Movies -->
    <tr><td style="background:#0f172a;padding:0 32px;border-radius:0 0 12px 12px;">
      <table width="100%" cellpadding="0" cellspacing="0">
        ${movieCards}
      </table>
    </td></tr>

    <!-- Footer -->
    <tr><td style="padding:24px 0 0;text-align:center;">
      <p style="margin:0;font-size:11px;color:#334155;font-family:monospace;">
        Movie Rating Sentinel · Automated daily digest · Ratings from OMDb (IMDb + Rotten Tomatoes)
      </p>
    </td></tr>

  </table>
</td></tr>
```

  </table>
</body>
</html>`;
}

function buildPlainTextEmail(movies, feedUrl) {
const date = new Date().toLocaleDateString(“en-US”, { dateStyle: “full” });
const lines = movies.map((m, i) =>
`${i + 1}. ${m.title} (${m.year})\n` +
`   IMDb: ${m.imdb ?? "N/A"}/10  |  RT: ${m.rt != null ? m.rt + "%" : "N/A"}\n` +
`   Genre: ${m.genre}\n` +
`   Director: ${m.director}\n` +
`   ${m.plot}\n` +
(m.imdbId ? `   https://www.imdb.com/title/${m.imdbId}/\n` : “”)
);
return [
“🎬 Movie Rating Sentinel — Daily Digest”,
date,
`Source: ${feedUrl}`,
`Filter: IMDb ≥ ${CONFIG.imdbThreshold}/10 OR Rotten Tomatoes ≥ ${CONFIG.rtThreshold}%`,
“”,
`Found ${movies.length} top-rated film(s):`,
“─”.repeat(50),
…lines,
“─”.repeat(50),
“Ratings provided by OMDb (omdbapi.com)”,
].join(”\n”);
}

// ── Step 5: Send Email via SendGrid ──────────────────────────────────────────

async function sendEmail(movies, feedUrl) {
sgMail.setApiKey(CONFIG.sendgridApiKey);

const subject = movies.length > 0
? `🎬 ${movies.length} Top-Rated Film${movies.length > 1 ? "s" : ""} Today — Movie Digest`
: “🎬 Movie Digest — No Top-Rated Films Today”;

const msg = {
to:      CONFIG.emailTo,
from:    CONFIG.emailFrom,
subject,
text:    buildPlainTextEmail(movies, feedUrl),
html:    buildHTMLEmail(movies, feedUrl),
};

log.info(`Sending email to ${CONFIG.emailTo}…`);
await sgMail.send(msg);
log.success(`Email sent: "${subject}"`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
log.info(“═══ Movie Rating Sentinel starting ═══”);

// Validate config
const missing = [“omdbApiKey”, “sendgridApiKey”, “emailTo”, “emailFrom”]
.filter((k) => !CONFIG[k]);
if (missing.length) {
log.error(`Missing required config: ${missing.join(", ")}`);
log.error(“Set these in your .env file. See script header for details.”);
process.exit(1);
}

try {
// 1. Fetch RSS
const rssItems = await fetchRSSItems(CONFIG.rssFeedUrl);
if (!rssItems.length) {
log.warn(“RSS feed returned no items — sending empty digest”);
await sendEmail([], CONFIG.rssFeedUrl);
return;
}

```
// 2. Extract titles
const titles = extractMovieTitles(rssItems);
if (!titles.length) {
  log.warn("No movie titles found in RSS — sending empty digest");
  await sendEmail([], CONFIG.rssFeedUrl);
  return;
}

// 3. Rate movies
const rated = await rateMovies(titles);
const topMovies = rated.filter((m) => m.passes);

log.info(`\n${"─".repeat(40)}`);
log.success(`${topMovies.length} / ${rated.length} movies passed the threshold`);
topMovies.forEach((m) =>
  log.success(`  ★ ${m.title} (${m.year}) — IMDb ${m.imdb ?? "N/A"} | RT ${m.rt != null ? m.rt + "%" : "N/A"}`)
);

// 4. Send email
await sendEmail(topMovies, CONFIG.rssFeedUrl);

log.info("═══ Done ═══");
```

} catch (err) {
log.error(`Fatal: ${err.message}`);
log.error(err.stack);
process.exit(1);
}
}

main();
