#!/usr/bin/env node
// Generates one real, static, crawlable HTML page per film (unique title,
// meta description, Open Graph/Twitter tags, schema.org Movie+AggregateRating
// JSON-LD, and real visible content) plus sitemap.xml/robots.txt — all derived
// directly from the same FILMS object the interactive widget itself uses, so
// there is exactly one source of truth for film data.
//
// Usage: node build-seo-pages.js <path-to-widget-index.html> <output-dir>
// Defaults let it run standalone from a checkout for local testing.
"use strict";
const fs = require("fs");
const path = require("path");

const SITE_URL = "https://themoviekernel.com";
const widgetPath = process.argv[2] || path.join(__dirname, "..", "widget", "index.html");
const outDir = process.argv[3] || path.join(__dirname, "..", "seo-build");

// Extracts the object/array literal starting at `startIdx` (which must point
// at the opening brace/bracket), respecting string/template-literal/comment
// boundaries so stray braces inside quoted text never miscount. A plain
// depth-counter would break the moment any film's insight text contained a
// "{" — this doesn't happen today, but the small stack-based scanner costs
// nothing and removes the risk entirely.
function extractBalanced(src, startIdx) {
  const open = src[startIdx];
  const close = open === "{" ? "}" : "]";
  const stack = [];
  let mode = null; // null | 'single' | 'double' | 'template' | 'line' | 'block'
  for (let i = startIdx; i < src.length; i++) {
    const c = src[i];
    const prev = src[i - 1];
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
      if (stack.length === 0) {
        if (c !== close) throw new Error(`Mismatched delimiter at index ${i}`);
        return src.slice(startIdx, i + 1);
      }
      continue;
    }
  }
  throw new Error("Unterminated literal — reached end of file while scanning");
}

function loadFilms(html) {
  const marker = "const FILMS = ";
  const declIdx = html.indexOf(marker);
  if (declIdx === -1) throw new Error("Could not find `const FILMS = ` in widget source");
  const braceIdx = declIdx + marker.length;
  if (html[braceIdx] !== "{") throw new Error("Expected `{` immediately after `const FILMS = `");
  const literalText = extractBalanced(html, braceIdx);
  // Evaluated as a standalone data literal — no DOM/script context needed,
  // since FILMS is pure data (strings/numbers/arrays/nested objects).
  return new Function(`"use strict"; return (${literalText});`)();
}

// Only used here to build clean, human-readable URLs — the widget itself
// still routes by the raw FILMS key (location.hash = key), so the two never
// need to agree on this function; the "Rate this film" link on each static
// page below points at #<rawKey>, not the slug.
function filmSlug(key) {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

function buildSlugMap(films) {
  const slugs = new Map();
  const used = new Map();
  for (const key of Object.keys(films)) {
    let slug = filmSlug(key);
    if (used.has(slug)) {
      // Extremely unlikely (two distinct camelCase keys collapsing to the
      // same kebab-case slug) but cheap to guard: fall back to the raw key
      // itself, which is guaranteed unique since it's a JS object key.
      console.warn(`Slug collision for "${key}" -> "${slug}" (already used by "${used.get(slug)}") — falling back to raw key.`);
      slug = key.toLowerCase();
    }
    used.set(slug, key);
    slugs.set(key, slug);
  }
  return slugs;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function truncate(text, maxLen) {
  const clean = String(text).replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  const cut = clean.slice(0, maxLen - 1);
  return cut.slice(0, cut.lastIndexOf(" ")) + "…";
}

function fmtMoney(millions) {
  if (millions == null || !Number.isFinite(Number(millions))) return null;
  return `$${Number(millions).toLocaleString("en-US", { maximumFractionDigits: 1 })}M`;
}

function moviePageHtml(key, f, slug) {
  const url = `${SITE_URL}/film/${slug}/`;
  const title = `${f.name} (${f.year}) — Review, Score & Box Office | The Kernel`;
  const description = truncate(f.insight || `${f.name} (${f.year}) on The Kernel — audience-submitted score, box office economics, and director/actor track record.`, 158);
  const posterUrl = f.poster ? `https://image.tmdb.org/t/p/w500${f.poster}` : null;
  const hasScore = f.score != null;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Movie",
    name: f.name,
    url,
    ...(posterUrl ? { image: posterUrl } : {}),
    ...(f.year ? { datePublished: String(f.year) } : {}),
    ...(f.genres && f.genres.length ? { genre: f.genres } : {}),
    ...(f.director && f.director.name ? { director: { "@type": "Person", name: f.director.name } } : {}),
    ...(f.actor && f.actor.name ? { actor: [{ "@type": "Person", name: f.actor.name }] } : {}),
    ...(hasScore
      ? {
          aggregateRating: {
            "@type": "AggregateRating",
            ratingValue: f.score,
            bestRating: 100,
            worstRating: 0,
            ratingCount: f.n || 1,
          },
        }
      : {}),
  };

  const genresLine = f.genres && f.genres.length ? f.genres.join(", ") : null;
  const econBits = [];
  if (f.econ) {
    if (fmtMoney(f.econ.budget)) econBits.push(`Budget ${fmtMoney(f.econ.budget)}`);
    if (fmtMoney(f.econ.marketing)) econBits.push(`Marketing ${fmtMoney(f.econ.marketing)}`);
    if (fmtMoney(f.econ.boxOffice)) econBits.push(`Box office ${fmtMoney(f.econ.boxOffice)}`);
  }
  const trailerUrl = f.trailer && f.trailer.key ? `https://www.youtube.com/watch?v=${f.trailer.key}` : null;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${url}">
<meta name="robots" content="index, follow">
<meta property="og:type" content="video.movie">
<meta property="og:site_name" content="The Kernel">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${url}">
${posterUrl ? `<meta property="og:image" content="${posterUrl}">\n` : ""}${f.year ? `<meta property="video:release_date" content="${escapeHtml(String(f.year))}-01-01">\n` : ""}${f.director && f.director.name ? `<meta property="video:director" content="${escapeHtml(f.director.name)}">\n` : ""}${f.actor && f.actor.name ? `<meta property="video:actor" content="${escapeHtml(f.actor.name)}">\n` : ""}<meta name="twitter:card" content="${posterUrl ? "summary_large_image" : "summary"}">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
${posterUrl ? `<meta name="twitter:image" content="${posterUrl}">\n` : ""}<script type="application/ld+json">
${JSON.stringify(jsonLd, null, 2)}
</script>
<style>
  :root{ --ink:#201E1B; --paper:#EFEBE1; --gold:#B8863A; --teal:#2F6B64; --rule:#C9C2B0; --muted:#6E6859; --card:#F7F4EC; --neg:#9C4A3C; }
  @media (prefers-color-scheme: dark){ :root{ --ink:#17181A; --paper:#EAE6DC; --gold:#D4A64C; --teal:#4FA69C; --rule:#34322D; --muted:#9C9686; --card:#1D1E20; --neg:#C2695A; } }
  *{ box-sizing:border-box; }
  body{ margin:0; background:var(--paper); color:var(--ink); font-family:-apple-system,"Segoe UI",Arial,sans-serif; line-height:1.55; }
  .doc{ max-width:720px; margin:0 auto; padding:2.5rem 1.25rem 4rem; }
  .back{ font-size:0.85rem; color:var(--teal); text-decoration:none; }
  .head{ display:flex; gap:1.5rem; margin:1.5rem 0 1.75rem; flex-wrap:wrap; }
  .poster{ width:150px; height:auto; border-radius:2px; flex-shrink:0; }
  h1{ font-family:Georgia,"Iowan Old Style",serif; font-size:1.7rem; margin:0 0 0.2rem; }
  .year{ color:var(--muted); font-weight:normal; }
  .genres{ color:var(--muted); font-size:0.85rem; margin:0.3rem 0 0.8rem; }
  .score-badge{ display:inline-flex; align-items:baseline; gap:0.4rem; background:var(--card); border:1px solid var(--rule); padding:0.5rem 0.9rem; margin-top:0.3rem; }
  .score-num{ font-family:Georgia,serif; font-size:1.5rem; color:var(--gold); }
  .score-label{ font-size:0.8rem; color:var(--muted); }
  section{ margin:1.6rem 0; }
  h2{ font-family:Georgia,serif; font-size:1.05rem; margin:0 0 0.5rem; border-bottom:1px solid var(--rule); padding-bottom:0.3rem; }
  p{ font-size:0.95rem; margin:0 0 0.6rem; max-width:64ch; }
  .econ-line{ font-size:0.88rem; color:var(--muted); }
  .cta{ display:inline-block; margin-top:0.6rem; padding:0.7rem 1.2rem; background:var(--teal); color:var(--paper); text-decoration:none; font-size:0.9rem; letter-spacing:0.02em; }
  .trailer-link{ font-size:0.88rem; }
  footer{ margin-top:2.5rem; font-size:0.75rem; color:var(--muted); border-top:1px solid var(--rule); padding-top:1rem; }
  footer a{ color:var(--teal); }
</style>
</head>
<body>
<div class="doc">
  <a class="back" href="${SITE_URL}/">&larr; The Kernel</a>
  <div class="head">
    ${posterUrl ? `<img class="poster" src="${posterUrl}" alt="${escapeHtml(f.name)} poster" width="150">` : ""}
    <div>
      <h1>${escapeHtml(f.name)} <span class="year">(${escapeHtml(String(f.year))})</span></h1>
      ${genresLine ? `<p class="genres">${escapeHtml(genresLine)}</p>` : ""}
      ${hasScore
        ? `<div class="score-badge"><span class="score-num">${f.score}</span><span class="score-label">Kernel Score${f.ci ? ` (${escapeHtml(f.ci)})` : ""} — ${escapeHtml(f.label || "")}, ${f.n || 0} review${f.n === 1 ? "" : "s"}</span></div>`
        : `<div class="score-badge"><span class="score-label">Not yet reviewed on Kernel</span></div>`}
    </div>
  </div>

  ${f.insight ? `<section><h2>The Kernel take</h2><p>${escapeHtml(f.insight)}</p></section>` : ""}
  ${f.directorInsight ? `<section><h2>Director track record${f.director && f.director.name ? `: ${escapeHtml(f.director.name)}` : ""}</h2><p>${escapeHtml(f.directorInsight)}</p></section>` : ""}
  ${f.actorInsight ? `<section><h2>Lead track record${f.actor && f.actor.name ? `: ${escapeHtml(f.actor.name)}` : ""}</h2><p>${escapeHtml(f.actorInsight)}</p></section>` : ""}
  ${econBits.length || f.legsInsight ? `<section><h2>Box office</h2>${econBits.length ? `<p class="econ-line">${escapeHtml(econBits.join(" · "))}</p>` : ""}${f.legsInsight ? `<p>${escapeHtml(f.legsInsight)}</p>` : ""}</section>` : ""}
  ${trailerUrl ? `<section><h2>Trailer</h2><p class="trailer-link"><a href="${trailerUrl}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(f.trailer.name || "Watch on YouTube")} &#8599;</a></p></section>` : ""}

  <a class="cta" href="${SITE_URL}/#${encodeURIComponent(key)}">Rate this film &amp; read audience reviews &rarr;</a>

  <footer>
    Self-reported audience data, not critic scores. Poster art and metadata via TMDb — this page uses the TMDB API but is not endorsed, certified, or otherwise approved by TMDB.
    <br><a href="${SITE_URL}/">Back to The Kernel</a>
  </footer>
</div>
</body>
</html>`;
}

function buildSitemap(entries) {
  const urls = [
    { loc: `${SITE_URL}/`, changefreq: "daily", priority: "1.0" },
    ...entries.map(({ slug }) => ({ loc: `${SITE_URL}/film/${slug}/`, changefreq: "weekly", priority: "0.8" })),
  ];
  const body = urls
    .map(u => `  <url>\n    <loc>${u.loc}</loc>\n    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

function buildRobots() {
  return `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`;
}

function main() {
  const html = fs.readFileSync(widgetPath, "utf8");
  const films = loadFilms(html);
  const slugs = buildSlugMap(films);

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const entries = [];
  for (const [key, f] of Object.entries(films)) {
    const slug = slugs.get(key);
    const pageDir = path.join(outDir, "film", slug);
    fs.mkdirSync(pageDir, { recursive: true });
    fs.writeFileSync(path.join(pageDir, "index.html"), moviePageHtml(key, f, slug), "utf8");
    entries.push({ key, slug });
  }

  fs.writeFileSync(path.join(outDir, "sitemap.xml"), buildSitemap(entries), "utf8");
  fs.writeFileSync(path.join(outDir, "robots.txt"), buildRobots(), "utf8");

  console.log(`Generated ${entries.length} film pages + sitemap.xml + robots.txt in ${outDir}`);
}

main();
