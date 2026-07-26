const crypto = require("node:crypto");
const push = require("./push");

// A small admin panel for reviewing/merging/closing the PRs the daily
// catalog-review pipeline opens — reachable from a link in the daily email,
// gated by a long random shared secret (ADMIN_TOKEN) rather than a login
// flow, per the "secret link token" choice made for this project. Merging
// through here is a real `git merge` via GitHub's own API (not a shortcut
// that bypasses anything) — it pushes to main exactly like clicking
// "Merge" on github.com would, which in turn triggers the existing
// gh-pages auto-deploy workflow.
//
// Also installable as a PWA with real push notifications (iOS 16.4+ Safari
// supports Web Push for home-screen-installed PWAs) — see manifest/service
// worker below. The manifest embeds the live admin token in start_url so
// tapping the home-screen icon opens straight into the authenticated view,
// exactly like the bookmarked link already works; it's gated by the same
// requireAdminToken as everything else here rather than served from a
// static, guessable path, so the token never sits in a public file.

const GITHUB_REPO = "jerod00/kernel";
const GITHUB_API = "https://api.github.com";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const GITHUB_ADMIN_TOKEN = process.env.GITHUB_ADMIN_TOKEN;
// Separate from ADMIN_TOKEN on purpose: this one is held by the GitHub
// Actions workflow (a machine caller, not a browser) to ping /admin/api/notify-pr
// right after opening a PR — keeping it distinct means a leak of either
// token doesn't also compromise the other.
const PIPELINE_NOTIFY_TOKEN = process.env.PIPELINE_NOTIFY_TOKEN;
// Separate again from both of the above: this one writes real facts into the
// permanent hash-chained log (seed_content), not just a notification or a
// read-only PR list — a smaller, differently-scoped blast radius deserves
// its own token rather than reusing PIPELINE_NOTIFY_TOKEN.
const PIPELINE_INGEST_TOKEN = process.env.PIPELINE_INGEST_TOKEN;
// Its own token again: this one only ever reads/writes the mutable, dismissable
// reddit_opportunities table — never the hash-chained log, never a PR or a
// push. Smallest blast radius of the four if it ever leaks.
const PIPELINE_REDDIT_TOKEN = process.env.PIPELINE_REDDIT_TOKEN;

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireAdminToken(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(500).json({ error: "ADMIN_TOKEN not configured on the server." });
  }
  const provided = req.query.token || req.get("x-admin-token");
  if (!provided || !timingSafeEqual(provided, ADMIN_TOKEN)) {
    return res.status(401).json({ error: "Missing or invalid admin token." });
  }
  next();
}

function requireNotifyToken(req, res, next) {
  if (!PIPELINE_NOTIFY_TOKEN) {
    return res.status(500).json({ error: "PIPELINE_NOTIFY_TOKEN not configured on the server." });
  }
  const provided = req.get("x-notify-token");
  if (!provided || !timingSafeEqual(provided, PIPELINE_NOTIFY_TOKEN)) {
    return res.status(401).json({ error: "Missing or invalid notify token." });
  }
  next();
}

function requireIngestToken(req, res, next) {
  if (!PIPELINE_INGEST_TOKEN) {
    return res.status(500).json({ error: "PIPELINE_INGEST_TOKEN not configured on the server." });
  }
  const provided = req.get("x-ingest-token");
  if (!provided || !timingSafeEqual(provided, PIPELINE_INGEST_TOKEN)) {
    return res.status(401).json({ error: "Missing or invalid ingest token." });
  }
  next();
}

function requireRedditToken(req, res, next) {
  if (!PIPELINE_REDDIT_TOKEN) {
    return res.status(500).json({ error: "PIPELINE_REDDIT_TOKEN not configured on the server." });
  }
  const provided = req.get("x-reddit-token");
  if (!provided || !timingSafeEqual(provided, PIPELINE_REDDIT_TOKEN)) {
    return res.status(401).json({ error: "Missing or invalid reddit token." });
  }
  next();
}

async function gh(pathName, options = {}) {
  if (!GITHUB_ADMIN_TOKEN) throw new Error("GITHUB_ADMIN_TOKEN not configured on the server.");
  const res = await fetch(`${GITHUB_API}${pathName}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${GITHUB_ADMIN_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(data.message || `GitHub API ${pathName} responded ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function listOpenPRs() {
  const prs = await gh(`/repos/${GITHUB_REPO}/pulls?state=open&sort=created&direction=desc`);
  const withComments = await Promise.all(
    prs.map(async pr => {
      let factCheck = null;
      try {
        const comments = await gh(`/repos/${GITHUB_REPO}/issues/${pr.number}/comments`);
        const botComment = comments.find(c => c.user && c.user.type === "Bot" && /automated fact-check/i.test(c.body || ""));
        factCheck = botComment ? botComment.body : null;
      } catch (err) {
        factCheck = `(couldn't load fact-check comment: ${err.message})`;
      }
      return {
        number: pr.number,
        title: pr.title,
        branch: pr.head.ref,
        createdAt: pr.created_at,
        url: pr.html_url,
        factCheck,
      };
    })
  );
  return withComments;
}

async function mergePR(number) {
  return gh(`/repos/${GITHUB_REPO}/pulls/${number}/merge`, {
    method: "PUT",
    body: JSON.stringify({ merge_method: "merge" }),
  });
}

async function closePR(number) {
  return gh(`/repos/${GITHUB_REPO}/pulls/${number}`, {
    method: "PATCH",
    body: JSON.stringify({ state: "closed" }),
  });
}

function adminManifestJson(token) {
  return {
    name: "Kernel Admin",
    short_name: "Kernel Admin",
    // Embeds the live token so launching from the home-screen icon lands
    // straight in the authenticated view — see the file-level comment above
    // on why this route is gated rather than static.
    start_url: `/admin?token=${encodeURIComponent(token)}`,
    scope: "/admin",
    display: "standalone",
    background_color: "#201E1B",
    theme_color: "#201E1B",
    icons: [
      { src: "/admin/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/admin/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}

// Public (unauthenticated) — no secret or user data in here, and it needs to
// be fetchable before any auth context exists (registration happens from
// plain markup, not an authenticated fetch).
const SERVICE_WORKER_JS = `
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (err) { /* non-JSON payload, use defaults */ }
  const title = data.title || "Kernel Admin";
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || "A pull request needs your review.",
    icon: "/admin/icon-192.png",
    badge: "/admin/icon-192.png",
    data: { url: data.url || "/admin" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/admin";
  const urlPath = url.split("?")[0];
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(urlPath) && "focus" in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
`;

function adminPageHtml(token) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kernel — Admin</title>
<link rel="manifest" href="/admin/manifest.webmanifest?token=${encodeURIComponent(token)}">
<link rel="apple-touch-icon" href="/admin/apple-touch-icon.png">
<meta name="theme-color" content="#201E1B">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Kernel Admin">
<style>
  :root{
    --ink:#201E1B; --paper:#EFEBE1; --gold:#B8863A; --teal:#2F6B64;
    --rule:#C9C2B0; --muted:#6E6859; --card:#F7F4EC; --neg:#9C4A3C;
  }
  @media (prefers-color-scheme: dark){
    :root{ --ink:#17181A; --paper:#EAE6DC; --gold:#D4A64C; --teal:#4FA69C; --rule:#34322D; --muted:#9C9686; --card:#1D1E20; --neg:#C2695A; }
  }
  *{ box-sizing:border-box; }
  body{ margin:0; background:var(--ink); color:var(--paper); font-family:-apple-system,"Segoe UI",Arial,sans-serif; line-height:1.5; }
  .doc{ max-width:760px; margin:0 auto; padding:3rem 1.5rem 5rem; }
  h1{ font-family:Georgia,"Iowan Old Style",serif; font-size:1.9rem; margin:0 0 0.3rem; }
  .sub{ color:var(--muted); font-size:0.92rem; margin:0 0 2rem; }
  .empty{ color:var(--muted); padding:2rem 0; text-align:center; }
  .pr-card{ background:var(--card); border:1px solid var(--rule); padding:1.2rem 1.4rem; margin-bottom:1.2rem; }
  .pr-head{ display:flex; justify-content:space-between; align-items:baseline; gap:1rem; margin-bottom:0.5rem; flex-wrap:wrap; }
  .pr-head h2{ font-family:Georgia,serif; font-size:1.05rem; margin:0; }
  .pr-meta{ font-family:ui-monospace,Consolas,monospace; font-size:0.75rem; color:var(--muted); white-space:nowrap; }
  .pr-meta a{ color:var(--teal); }
  .fact-check{
    font-size:0.85rem; white-space:pre-wrap; background:var(--ink); border:1px solid var(--rule);
    padding:0.9rem 1rem; margin:0.8rem 0; max-height:280px; overflow-y:auto;
  }
  .fact-check.none{ color:var(--muted); font-style:italic; white-space:normal; }
  .actions{ display:flex; gap:0.6rem; margin-top:0.8rem; }
  button{
    font-family:ui-monospace,Consolas,monospace; font-size:0.78rem; letter-spacing:0.03em; text-transform:uppercase;
    padding:0.55rem 1rem; border:1px solid var(--rule); background:transparent; color:var(--paper); cursor:pointer;
  }
  button.merge{ border-color:var(--teal); color:var(--teal); }
  button.merge:hover{ background:var(--teal); color:var(--ink); }
  button.close{ border-color:var(--neg); color:var(--neg); }
  button.close:hover{ background:var(--neg); color:var(--ink); }
  button:disabled{ opacity:0.4; cursor:default; }
  .status{ font-size:0.82rem; margin-top:0.6rem; }
  .status.ok{ color:var(--teal); }
  .status.err{ color:var(--neg); }
  .loading{ color:var(--muted); padding:2rem 0; }
  .push-banner{
    background:var(--card); border:1px solid var(--rule); padding:0.9rem 1.1rem;
    margin-bottom:1.5rem; font-size:0.85rem; display:flex; align-items:center; justify-content:space-between; gap:1rem; flex-wrap:wrap;
  }
  .push-banner.ok{ color:var(--teal); }
  .push-btn{
    font-family:ui-monospace,Consolas,monospace; font-size:0.78rem; letter-spacing:0.03em; text-transform:uppercase;
    padding:0.5rem 0.9rem; border:1px solid var(--gold); color:var(--gold); background:transparent; cursor:pointer; white-space:nowrap;
  }
  .push-btn:hover{ background:var(--gold); color:var(--ink); }
  .push-btn:disabled{ opacity:0.4; cursor:default; }
  .section-block{ margin-top:2.6rem; }
  .section-block h2{ font-family:Georgia,serif; font-size:1.15rem; margin:0 0 0.9rem; border-bottom:1px solid var(--rule); padding-bottom:0.4rem; }
  .stat-grid{ display:flex; gap:0.8rem; flex-wrap:wrap; margin-bottom:1.1rem; }
  .stat-tile{ background:var(--card); border:1px solid var(--rule); padding:0.8rem 1.1rem; flex:1; min-width:110px; }
  .stat-num{ font-family:Georgia,serif; font-size:1.4rem; color:var(--gold); display:block; }
  .stat-label{ font-size:0.72rem; color:var(--muted); text-transform:uppercase; letter-spacing:0.03em; }
  .break-lists{ display:flex; gap:1.5rem; flex-wrap:wrap; }
  .break-list{ flex:1; min-width:200px; }
  .break-list h3{ font-family:Georgia,serif; font-size:0.85rem; color:var(--muted); font-weight:normal; margin:0 0 0.4rem; }
  .break-list ol{ list-style:none; margin:0; padding:0; font-size:0.85rem; }
  .break-list li{ display:flex; justify-content:space-between; gap:0.6rem; padding:0.3rem 0; border-bottom:1px solid var(--rule); }
  .break-list li span:last-child{ color:var(--muted); font-family:ui-monospace,Consolas,monospace; }
  .error-card{ background:var(--card); border:1px solid var(--neg); border-left-width:3px; padding:0.9rem 1.1rem; margin-bottom:0.8rem; }
  .error-head{ display:flex; justify-content:space-between; gap:1rem; align-items:baseline; flex-wrap:wrap; }
  .error-msg{ font-size:0.9rem; color:var(--neg); }
  .error-time{ font-family:ui-monospace,Consolas,monospace; font-size:0.72rem; color:var(--muted); white-space:nowrap; }
  .error-stack{ font-family:ui-monospace,Consolas,monospace; font-size:0.75rem; color:var(--muted); white-space:pre-wrap; margin-top:0.5rem; max-height:200px; overflow-y:auto; }
  .reddit-card{ background:var(--card); border:1px solid var(--rule); padding:1.1rem 1.3rem; margin-bottom:1.1rem; }
  .reddit-head{ display:flex; justify-content:space-between; gap:1rem; align-items:baseline; flex-wrap:wrap; margin-bottom:0.3rem; }
  .reddit-head h3{ font-family:Georgia,serif; font-size:1rem; margin:0; }
  .reddit-meta{ font-family:ui-monospace,Consolas,monospace; font-size:0.75rem; color:var(--muted); white-space:nowrap; }
  .reddit-meta a{ color:var(--teal); }
  .reddit-film{ font-size:0.8rem; color:var(--gold); margin-bottom:0.6rem; }
  .reddit-reply{ font-size:0.9rem; white-space:pre-wrap; background:var(--ink); color:var(--paper); border:1px solid var(--rule); padding:0.8rem 0.95rem; margin:0.6rem 0; }
  .review-card{ display:flex; gap:1rem; align-items:flex-start; background:var(--card); border:1px solid var(--rule); padding:1rem 1.2rem; margin-bottom:0.9rem; }
  .review-rating{ font-family:Georgia,serif; font-size:1.6rem; color:var(--gold); flex-shrink:0; min-width:2.4rem; text-align:center; }
  .review-body{ flex:1; min-width:0; }
  .review-head{ display:flex; justify-content:space-between; gap:1rem; align-items:baseline; flex-wrap:wrap; }
  .review-film a{ color:var(--teal); font-family:ui-monospace,Consolas,monospace; font-size:0.85rem; }
  .review-time{ font-family:ui-monospace,Consolas,monospace; font-size:0.72rem; color:var(--muted); white-space:nowrap; }
  .review-comment{ font-size:0.9rem; margin:0.4rem 0 0; }
  .review-comment.none{ color:var(--muted); font-style:italic; }
</style>
</head>
<body>
<div class="doc">
  <h1>Kernel — Admin</h1>
  <p class="sub">Open pull requests from the daily catalog-review pipeline. Merging here pushes to <code>main</code> exactly like the GitHub "Merge" button — nothing skipped.</p>
  <div id="pushBanner" class="push-banner" hidden></div>
  <div id="list" class="loading">Loading open PRs…</div>

  <div class="section-block">
    <h2>Reddit Opportunities</h2>
    <p class="sub" style="margin-bottom:0.9rem;">Drafted replies only — nothing here ever posts on its own. Copy, review, and post manually if it's a good fit.</p>
    <div id="redditList" class="loading">Loading opportunities…</div>
  </div>

  <div class="section-block">
    <h2>Traffic (last 7 days)</h2>
    <div id="analyticsSummary" class="loading">Loading traffic…</div>
  </div>

  <div class="section-block">
    <h2>Recent Errors</h2>
    <div id="errorList" class="loading">Loading errors…</div>
  </div>

  <div class="section-block">
    <h2>Recent Reviews</h2>
    <p class="sub" style="margin-bottom:0.9rem;">Real self-reported audience reviews as they come in, newest first — this is the data "Kernel Score" promotes to once a film has enough of it.</p>
    <div id="reviewList" class="loading">Loading reviews…</div>
  </div>
</div>
<script>
  const token = new URLSearchParams(location.search).get("token") || "";
  const listEl = document.getElementById("list");
  const VAPID_PUBLIC_KEY = ${JSON.stringify(push.VAPID_PUBLIC_KEY || "")};

  async function api(path, opts) {
    const res = await fetch(path + (path.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token), opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");
    return data;
  }

  // iOS only grants the notification permission prompt when the page is
  // running standalone (opened from the Home Screen icon, not a Safari
  // tab) — the display-mode media query covers other platforms that
  // support installed-PWA push the same way.
  function isStandalone() {
    return window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
  }

  async function initPush() {
    const banner = document.getElementById("pushBanner");
    // VAPID misconfigured server-side, or a browser too old to ever support
    // this — genuinely nothing to show. Everything else below still shows
    // *some* banner, since iOS deliberately doesn't expose PushManager on
    // window at all until the page is running standalone — checking for it
    // before checking isStandalone() would silently hide the "add to home
    // screen" hint on exactly the visit where it's most needed.
    if (!VAPID_PUBLIC_KEY || !("serviceWorker" in navigator)) {
      banner.hidden = true;
      return;
    }
    banner.hidden = false;
    const reg = await navigator.serviceWorker.register("/admin/sw.js", { scope: "/admin" });
    if (!isStandalone()) {
      banner.className = "push-banner";
      banner.textContent = "Add this page to your Home Screen, then open it from there to enable push notifications.";
      return;
    }
    if (!("PushManager" in window)) {
      banner.className = "push-banner";
      banner.textContent = "This device/browser doesn't support push notifications.";
      return;
    }
    const existing = await reg.pushManager.getSubscription();
    if (existing) {
      banner.className = "push-banner ok";
      banner.textContent = "Push notifications are enabled on this device.";
      return;
    }
    banner.className = "push-banner";
    banner.innerHTML = "";
    const label = document.createElement("span");
    label.textContent = "Get notified here when a new PR needs review.";
    const btn = document.createElement("button");
    btn.className = "push-btn";
    btn.textContent = "Enable Notifications";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Requesting…";
      try {
        const perm = await Notification.requestPermission();
        if (perm !== "granted") throw new Error("permission " + perm);
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        });
        await api("/admin/api/push-subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(sub),
        });
        banner.className = "push-banner ok";
        banner.textContent = "Push notifications are enabled on this device.";
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "Enable Notifications";
        label.textContent = "Couldn't enable notifications: " + err.message;
      }
    });
    banner.appendChild(label);
    banner.appendChild(btn);
  }

  function card(pr) {
    const el = document.createElement("div");
    el.className = "pr-card";
    el.innerHTML = \`
      <div class="pr-head">
        <h2>\${escapeHtml(pr.title)}</h2>
        <span class="pr-meta">#\${pr.number} · <a href="\${pr.url}" target="_blank" rel="noopener noreferrer">view on GitHub</a></span>
      </div>
      \${pr.factCheck
        ? \`<div class="fact-check">\${escapeHtml(pr.factCheck)}</div>\`
        : \`<p class="fact-check none">No fact-check comment found.</p>\`}
      <div class="actions">
        <button class="merge" data-action="merge">Merge</button>
        <button class="close" data-action="close">Close</button>
      </div>
      <div class="status"></div>
    \`;
    el.querySelector('[data-action="merge"]').addEventListener("click", () => act(pr.number, "merge", el));
    el.querySelector('[data-action="close"]').addEventListener("click", () => act(pr.number, "close", el));
    return el;
  }

  async function act(number, action, el) {
    const statusEl = el.querySelector(".status");
    const buttons = el.querySelectorAll("button");
    buttons.forEach(b => (b.disabled = true));
    statusEl.textContent = action === "merge" ? "Merging…" : "Closing…";
    statusEl.className = "status";
    try {
      await api(\`/admin/api/prs/\${number}/\${action}\`, { method: "POST" });
      statusEl.textContent = action === "merge" ? "Merged." : "Closed.";
      statusEl.className = "status ok";
      setTimeout(() => el.remove(), 900);
    } catch (err) {
      statusEl.textContent = "Failed: " + err.message;
      statusEl.className = "status err";
      buttons.forEach(b => (b.disabled = false));
    }
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }

  function renderBreakList(title, rows, keyField, labelFn) {
    if (!rows.length) return "";
    const items = rows
      .map(r => \`<li><span>\${escapeHtml(labelFn(r))}</span><span>\${r.n}</span></li>\`)
      .join("");
    return \`<div class="break-list"><h3>\${escapeHtml(title)}</h3><ol>\${items}</ol></div>\`;
  }

  async function loadAnalytics() {
    const el = document.getElementById("analyticsSummary");
    try {
      const summary = await api("/admin/api/analytics/summary?days=7");
      if (!summary.total) {
        el.innerHTML = '<p class="empty">No pageviews logged yet.</p>';
        return;
      }
      el.innerHTML = \`
        <div class="stat-grid">
          <div class="stat-tile"><span class="stat-num">\${summary.total}</span><span class="stat-label">Pageviews</span></div>
          <div class="stat-tile"><span class="stat-num">\${summary.uniqueVisitors}</span><span class="stat-label">Unique visitors</span></div>
        </div>
        <div class="break-lists">
          \${renderBreakList("Top pages", summary.topPaths, "path", r => r.path)}
          \${renderBreakList("Top referrers", summary.topReferrers, "referrer", r => r.referrer)}
        </div>
      \`;
    } catch (err) {
      el.innerHTML = '<p class="status err">Failed to load: ' + escapeHtml(err.message) + "</p>";
    }
  }

  function errorCard(e) {
    const el = document.createElement("div");
    el.className = "error-card";
    el.innerHTML = \`
      <div class="error-head">
        <span class="error-msg">\${escapeHtml(e.message)}</span>
        <span class="error-time">\${escapeHtml(e.recorded_at)}</span>
      </div>
      \${e.context ? \`<div class="error-time">\${escapeHtml(e.context)}</div>\` : ""}
      \${e.stack ? \`<div class="error-stack">\${escapeHtml(e.stack)}</div>\` : ""}
    \`;
    return el;
  }

  async function loadErrors() {
    const el = document.getElementById("errorList");
    try {
      const errors = await api("/admin/api/errors");
      el.innerHTML = "";
      if (!errors.length) {
        el.innerHTML = '<p class="empty">No errors logged. Good sign.</p>';
        return;
      }
      errors.forEach(e => el.appendChild(errorCard(e)));
    } catch (err) {
      el.innerHTML = '<p class="status err">Failed to load: ' + escapeHtml(err.message) + "</p>";
    }
  }

  // dataId (e.g. "the-dark-knight-2008") doubles as a best-effort site slug
  // once the trailing "-YYYY" is stripped — matches the exact same
  // transform draft-lib.js's pickEntryKey() and build-seo-pages.js's
  // filmSlug() round-trip to, so this lines up with the real static page
  // URL without this service needing any access to the widget's FILMS data.
  function reviewFilmUrl(dataId) {
    return "https://themoviekernel.com/film/" + dataId.replace(/-\\d{4}$/, "") + "/";
  }

  function reviewCard(r) {
    const el = document.createElement("div");
    el.className = "review-card";
    el.innerHTML = \`
      <span class="review-rating">\${r.rating != null ? r.rating : "—"}</span>
      <div class="review-body">
        <div class="review-head">
          <span class="review-film"><a href="\${reviewFilmUrl(r.dataId)}" target="_blank" rel="noopener noreferrer">\${escapeHtml(r.dataId)}</a></span>
          <span class="review-time">\${escapeHtml(r.recordedAt)}</span>
        </div>
        \${r.comment
          ? \`<p class="review-comment">\${escapeHtml(r.comment)}</p>\`
          : '<p class="review-comment none">No comment left</p>'}
      </div>
    \`;
    return el;
  }

  async function loadRecentReviews() {
    const el = document.getElementById("reviewList");
    try {
      const reviews = await api("/admin/api/recent-reviews");
      el.innerHTML = "";
      if (!reviews.length) {
        el.innerHTML = '<p class="empty">No reviews submitted yet.</p>';
        return;
      }
      reviews.forEach(r => el.appendChild(reviewCard(r)));
    } catch (err) {
      el.innerHTML = '<p class="status err">Failed to load: ' + escapeHtml(err.message) + "</p>";
    }
  }

  function redditCard(o) {
    const el = document.createElement("div");
    el.className = "reddit-card";
    el.innerHTML = \`
      <div class="reddit-head">
        <h3>\${escapeHtml(o.post_title)}</h3>
        <span class="reddit-meta">r/\${escapeHtml(o.subreddit)} · <a href="\${o.post_url}" target="_blank" rel="noopener noreferrer">view thread</a></span>
      </div>
      <div class="reddit-film">Matched film: \${escapeHtml(o.film_name)}</div>
      <div class="reddit-reply">\${escapeHtml(o.drafted_reply)}</div>
      <div class="actions">
        <button class="merge" data-action="copy">Copy reply</button>
        <button class="merge" data-action="posted">Mark posted</button>
        <button class="close" data-action="dismiss">Dismiss</button>
      </div>
      <div class="status"></div>
    \`;
    const statusEl = el.querySelector(".status");
    el.querySelector('[data-action="copy"]').addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(o.drafted_reply);
        statusEl.textContent = "Copied.";
        statusEl.className = "status ok";
      } catch (err) {
        statusEl.textContent = "Copy failed: " + err.message;
        statusEl.className = "status err";
      }
    });
    el.querySelector('[data-action="posted"]').addEventListener("click", () => redditAct(o.id, "mark-posted", el));
    el.querySelector('[data-action="dismiss"]').addEventListener("click", () => redditAct(o.id, "dismiss", el));
    return el;
  }

  async function redditAct(id, action, el) {
    const statusEl = el.querySelector(".status");
    const buttons = el.querySelectorAll("button");
    buttons.forEach(b => (b.disabled = true));
    try {
      await api(\`/admin/api/reddit-opportunities/\${id}/\${action}\`, { method: "POST" });
      statusEl.textContent = action === "dismiss" ? "Dismissed." : "Marked posted.";
      statusEl.className = "status ok";
      setTimeout(() => el.remove(), 700);
    } catch (err) {
      statusEl.textContent = "Failed: " + err.message;
      statusEl.className = "status err";
      buttons.forEach(b => (b.disabled = false));
    }
  }

  async function loadReddit() {
    const el = document.getElementById("redditList");
    try {
      const opportunities = await api("/admin/api/reddit-opportunities?status=new");
      el.innerHTML = "";
      if (!opportunities.length) {
        el.innerHTML = '<p class="empty">No open opportunities right now.</p>';
        return;
      }
      opportunities.forEach(o => el.appendChild(redditCard(o)));
    } catch (err) {
      el.innerHTML = '<p class="status err">Failed to load: ' + escapeHtml(err.message) + "</p>";
    }
  }

  initPush().catch(err => console.error("Push setup failed:", err));
  loadAnalytics();
  loadErrors();
  loadReddit();
  loadRecentReviews();

  (async () => {
    try {
      const prs = await api("/admin/api/prs");
      listEl.innerHTML = "";
      if (!prs.length) {
        listEl.innerHTML = '<p class="empty">No open PRs right now.</p>';
        return;
      }
      prs.forEach(pr => listEl.appendChild(card(pr)));
    } catch (err) {
      listEl.innerHTML = '<p class="status err">Failed to load: ' + escapeHtml(err.message) + "</p>";
    }
  })();
</script>
</body>
</html>`;
}

module.exports = {
  requireAdminToken,
  requireNotifyToken,
  requireIngestToken,
  requireRedditToken,
  listOpenPRs,
  mergePR,
  closePR,
  adminPageHtml,
  adminManifestJson,
  SERVICE_WORKER_JS,
};
