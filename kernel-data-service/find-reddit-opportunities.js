require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const { callAnthropic } = require("./draft-lib");

// Draft-and-approve organic-growth listening: searches Reddit for people
// discussing films currently in Kernel's catalog, drafts a genuine reply
// grounded in real Kernel data, and stores it as a suggestion in
// kernel-data-service for a human to review and manually post. NEVER posts
// to Reddit itself — that's the whole point (see the plan this came from:
// automated reply-with-link bots are exactly what Reddit's and X's
// platform-manipulation policies target, and they read as spam to real
// people regardless of whether a platform ever catches it).
//
// Usage: node find-reddit-opportunities.js

const REDDIT_CLIENT_ID = process.env.REDDIT_CLIENT_ID;
const REDDIT_CLIENT_SECRET = process.env.REDDIT_CLIENT_SECRET;
const REDDIT_USER_AGENT = process.env.REDDIT_USER_AGENT || "kernel-reddit-listener/1.0 (by /u/kernel-bot; read-only, no posting)";
const DATA_SERVICE_URL = process.env.DATA_SERVICE_URL || "https://kernel-data-service-themoviekernel.fly.dev";
const PIPELINE_REDDIT_TOKEN = process.env.PIPELINE_REDDIT_TOKEN;
const WIDGET_PATH = path.join(__dirname, "..", "widget", "index.html");

// Matches RECENT_RELEASE_WINDOW_MS in widget/index.html and
// historical-backfill.js's RECENT_WINDOW_DAYS — searching Reddit daily for a
// film that left theaters years ago would mostly surface noise unrelated to
// today's actual discourse.
const RECENT_WINDOW_DAYS = 90;
const POST_MAX_AGE_HOURS = 48; // a 2-day-old thread is still worth a reply; older is mostly dead
const SUBREDDITS = ["movies", "flicks", "boxoffice", "TrueFilm"]; // easy to extend later
const SEARCH_LIMIT = 10;

if (!REDDIT_CLIENT_ID || !REDDIT_CLIENT_SECRET) {
  console.error("Set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET in kernel-data-service/.env first.");
  process.exit(1);
}
if (!PIPELINE_REDDIT_TOKEN) {
  console.error("Set PIPELINE_REDDIT_TOKEN in kernel-data-service/.env first.");
  process.exit(1);
}

// Brace-balanced literal extraction — duplicated from build-seo-pages.js and
// every backfill script on purpose (no shared module system between these
// Node scripts and the single static widget file).
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

function loadFilms() {
  const html = fs.readFileSync(WIDGET_PATH, "utf8");
  const marker = "const FILMS = ";
  const declIdx = html.indexOf(marker);
  if (declIdx === -1) throw new Error("Could not find `const FILMS = ` in widget source");
  const braceIdx = declIdx + marker.length;
  const { text } = extractBalanced(html, braceIdx);
  return new Function(`"use strict"; return (${text});`)();
}

// Also duplicated from build-seo-pages.js — same convention.
function filmSlug(key) {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

function currentFilms(films) {
  const now = Date.now();
  return Object.entries(films)
    .filter(([, f]) => {
      if (f.nowPlaying === true) return true;
      if (!f.releaseDate) return false;
      const age = now - new Date(f.releaseDate).getTime();
      return age >= 0 && age <= RECENT_WINDOW_DAYS * 86400000;
    })
    .map(([key, f]) => ({ key, f }));
}

async function getRedditToken() {
  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${REDDIT_CLIENT_ID}:${REDDIT_CLIENT_SECRET}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": REDDIT_USER_AGENT,
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`Reddit OAuth failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.access_token;
}

async function searchSubreddit(token, subreddit, query) {
  const url = `https://oauth.reddit.com/r/${subreddit}/search?q=${encodeURIComponent(`"${query}"`)}&restrict_sr=1&sort=new&limit=${SEARCH_LIMIT}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": REDDIT_USER_AGENT },
  });
  if (!res.ok) throw new Error(`Reddit search r/${subreddit} for "${query}" failed: ${res.status}`);
  const data = await res.json();
  return ((data.data && data.data.children) || []).map(c => c.data);
}

async function fetchKnownPostIds() {
  const res = await fetch(`${DATA_SERVICE_URL}/admin/api/reddit-opportunities/known-ids`, {
    headers: { "x-reddit-token": PIPELINE_REDDIT_TOKEN },
  });
  if (!res.ok) throw new Error(`known-ids fetch failed: ${res.status}`);
  return new Set(await res.json());
}

async function ingestOpportunity(opportunity) {
  const res = await fetch(`${DATA_SERVICE_URL}/admin/api/reddit-opportunities/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-reddit-token": PIPELINE_REDDIT_TOKEN },
    body: JSON.stringify(opportunity),
  });
  if (!res.ok) throw new Error(`ingest failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

const REPLY_SYSTEM = `You write short, genuine-sounding Reddit comment replies for the person behind a small film-data side project called Kernel (themoviekernel.com). You are given a real Reddit post about a specific film and real facts already fetched about that film from Kernel's own data — never invent numbers, plot details, or facts not given to you. Write 2-4 sentences in a casual Reddit register (not marketing copy, no exclamation-heavy hype, no "check out my amazing site!"). Always disclose that Kernel is something you built — never present the link as if a neutral third party is casually mentioning it. If the post doesn't actually give you anything genuine to add (e.g. it's just a meme, or unrelated to the film's data), it's fine to write a reply that skips the data and just shares the link with honest context instead of forcing a stat in. Output ONLY the reply text — no quotes, no preamble, no markdown formatting.`;

function buildReplyPrompt(post, subreddit, filmKey, f) {
  const facts = [];
  if (f.score != null) facts.push(`Kernel audience score: ${f.score}/100${f.label ? ` ("${f.label}")` : ""}`);
  if (f.rottenTomatoes != null) facts.push(`Rotten Tomatoes: ${f.rottenTomatoes}%`);
  if (f.econ && f.econ.budget != null && f.econ.boxOffice != null) {
    facts.push(`Budget $${f.econ.budget}M vs. $${f.econ.boxOffice}M worldwide gross so far`);
  }
  if (f.insight) facts.push(`Kernel's take: ${f.insight}`);

  return `Reddit post in r/${subreddit}: "${post.title}"
${post.selftext ? `Post body: ${post.selftext.slice(0, 500)}` : "(link post, no body text)"}

Film discussed: ${f.name} (${f.year})
Real facts about it from Kernel's data:
${facts.length ? facts.join("\n") : "(no additional facts available yet)"}

Kernel link for this film: https://themoviekernel.com/film/${filmSlug(filmKey)}/

Write the reply.`;
}

async function main() {
  const films = loadFilms();
  const current = currentFilms(films);
  console.log(`Searching Reddit for ${current.length} current film(s): ${current.map(c => c.key).join(", ") || "(none)"}`);
  if (!current.length) return;

  const token = await getRedditToken();
  const knownIds = await fetchKnownPostIds();
  console.log(`${knownIds.size} post(s) already known — will be skipped.`);

  const cutoff = Date.now() - POST_MAX_AGE_HOURS * 3600000;
  let found = 0, skipped = 0, drafted = 0, failed = 0;

  for (const { key, f } of current) {
    for (const subreddit of SUBREDDITS) {
      let posts;
      try {
        posts = await searchSubreddit(token, subreddit, f.name);
      } catch (err) {
        console.warn(`  ${err.message} — skipping.`);
        continue;
      }
      for (const post of posts) {
        found++;
        const postId = post.name; // Reddit's own fullname (e.g. "t3_abc123") — globally unique
        const removedText = post.selftext === "[removed]" || post.selftext === "[deleted]";
        if (knownIds.has(postId) || post.created_utc * 1000 < cutoff || post.removed_by_category || removedText) {
          skipped++;
          continue;
        }

        try {
          const reply = await callAnthropic(REPLY_SYSTEM, buildReplyPrompt(post, subreddit, key, f), 300);
          const { inserted } = await ingestOpportunity({
            filmKey: key,
            filmName: `${f.name} (${f.year})`,
            subreddit,
            postId,
            postTitle: post.title,
            postUrl: `https://reddit.com${post.permalink}`,
            postExcerpt: post.selftext ? post.selftext.slice(0, 300) : null,
            draftedReply: reply,
          });
          knownIds.add(postId); // avoid re-drafting the same post twice in one run
          if (inserted) {
            drafted++;
            console.log(`  Drafted reply for r/${subreddit}: "${post.title}" (${key})`);
          }
        } catch (err) {
          failed++;
          console.warn(`  Failed to draft/ingest for "${post.title}": ${err.message}`);
        }
      }
    }
  }

  console.log(`\nDone. Found ${found}, skipped ${skipped} (already known/stale/removed), drafted ${drafted}, failed ${failed}.`);
}

main().catch(err => {
  console.error("find-reddit-opportunities failed:", err);
  process.exit(1);
});
