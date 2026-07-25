require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// One-time backfill for trailer view/like/comment counts — every film
// already has trailer.key (backfilled earlier this session), just needs the
// YouTube Data API call and the stats patched into that same object.

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const YOUTUBE_BASE = "https://www.googleapis.com/youtube/v3";
const WIDGET_PATH = path.join(__dirname, "..", "widget", "index.html");

if (!YOUTUBE_API_KEY) {
  console.error("Set YOUTUBE_API_KEY in kernel-data-service/.env first.");
  process.exit(1);
}

async function fetchYoutubeStats(videoId) {
  const res = await fetch(`${YOUTUBE_BASE}/videos?part=statistics&id=${videoId}&key=${YOUTUBE_API_KEY}`);
  if (!res.ok) throw new Error(`YouTube API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const stats = data.items && data.items[0] && data.items[0].statistics;
  if (!stats) return null;
  return {
    viewCount: stats.viewCount != null ? Number(stats.viewCount) : null,
    likeCount: stats.likeCount != null ? Number(stats.likeCount) : null,
    commentCount: stats.commentCount != null ? Number(stats.commentCount) : null,
  };
}

function extractBalanced(src, startIdx) {
  const stack = [];
  let mode = null;
  for (let i = startIdx; i < src.length; i++) {
    const c = src[i], prev = src[i - 1];
    if (mode === "line") { if (c === "\n") mode = null; continue; }
    if (mode === "block") { if (prev === "*" && c === "/") mode = null; continue; }
    if (mode === "single") { if (c === "'" && prev !== "\\") mode = null; continue; }
    if (mode === "double") { if (c === '"' && prev !== "\\") mode = null; continue; }
    if (mode === "template") {
      if (c === "`" && prev !== "\\") { mode = null; continue; }
      if (c === "{" && prev === "$") { stack.push("tpl"); mode = null; continue; }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") { mode = "line"; continue; }
    if (c === "/" && src[i + 1] === "*") { mode = "block"; continue; }
    if (c === "'") { mode = "single"; continue; }
    if (c === '"') { mode = "double"; continue; }
    if (c === "`") { mode = "template"; continue; }
    if (c === "{" || c === "[") { stack.push("brace"); continue; }
    if (c === "}" || c === "]") {
      const top = stack.pop();
      if (top === "tpl") { mode = "template"; continue; }
      if (stack.length === 0) return { text: src.slice(startIdx, i + 1), end: i + 1 };
      continue;
    }
  }
  throw new Error("Unterminated literal — reached end of file while scanning");
}

function loadFilms(html) {
  const marker = "const FILMS = ";
  const declIdx = html.indexOf(marker);
  const braceIdx = declIdx + marker.length;
  const literalText = extractBalanced(html, braceIdx);
  return new Function(`"use strict"; return (${literalText.text});`)();
}

function assertWidgetScriptParses(html) {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error("Could not find <script> block to validate — aborting, refusing to write.");
  new vm.Script(match[1], { filename: "widget-script-check.js" });
}

(async () => {
  let html = fs.readFileSync(WIDGET_PATH, "utf8");
  const films = loadFilms(html);

  const candidates = Object.entries(films)
    .filter(([, f]) => f.trailer && f.trailer.key && f.trailer.viewCount == null)
    .map(([key, f]) => ({ key, trailerKey: f.trailer.key, trailerName: f.trailer.name }));

  console.log(`Found ${candidates.length} film(s) with a trailer but no stats yet: ${candidates.map(c => c.key).join(", ")}`);

  let patched = 0, skipped = 0;
  for (const c of candidates) {
    try {
      console.log(`\n${c.key}: fetching YouTube stats for "${c.trailerName}" [${c.trailerKey}]...`);
      const stats = await fetchYoutubeStats(c.trailerKey);
      if (!stats || stats.viewCount == null) { console.log(`  No stats available (video private/deleted?) — skipping.`); skipped++; continue; }
      console.log(`  views=${stats.viewCount}, likes=${stats.likeCount ?? "n/a"}, comments=${stats.commentCount ?? "n/a"}`);

      const declRe = new RegExp(`\\r?\\n\\s*${c.key}:\\s*\\{`);
      const declMatch = html.match(declRe);
      if (!declMatch) { console.log(`  Could not find this entry's declaration line — skipping.`); skipped++; continue; }
      const braceIdx = declMatch.index + declMatch[0].length - 1;
      const { text: entryText } = extractBalanced(html, braceIdx);

      // trailer is always a flat object (no nested braces), so a
      // non-greedy match up to the first "}" safely bounds it.
      const trailerRe = /trailer:\s*\{[^}]*\}/;
      const trailerMatch = entryText.match(trailerRe);
      if (!trailerMatch) { console.log(`  Could not find this entry's trailer object — skipping.`); skipped++; continue; }

      const statsFields = [
        `viewCount: ${stats.viewCount}`,
        stats.likeCount != null ? `likeCount: ${stats.likeCount}` : null,
        stats.commentCount != null ? `commentCount: ${stats.commentCount}` : null,
      ].filter(Boolean).join(", ");
      const originalTrailer = trailerMatch[0];
      const closingBraceOffset = originalTrailer.lastIndexOf("}");
      const newTrailer = `${originalTrailer.slice(0, closingBraceOffset)}, ${statsFields}${originalTrailer.slice(closingBraceOffset)}`;

      const insertAt = braceIdx + trailerMatch.index;
      html = html.slice(0, insertAt) + newTrailer + html.slice(insertAt + originalTrailer.length);
      patched++;
    } catch (err) {
      console.log(`  Error: ${err.message} — skipping.`);
      skipped++;
    }
  }

  assertWidgetScriptParses(html);
  fs.writeFileSync(WIDGET_PATH, html);
  console.log(`\nDone. Patched ${patched}, skipped ${skipped}.`);
})();
