const crypto = require("node:crypto");

// A small admin panel for reviewing/merging/closing the PRs the daily
// catalog-review pipeline opens — reachable from a link in the daily email,
// gated by a long random shared secret (ADMIN_TOKEN) rather than a login
// flow, per the "secret link token" choice made for this project. Merging
// through here is a real `git merge` via GitHub's own API (not a shortcut
// that bypasses anything) — it pushes to main exactly like clicking
// "Merge" on github.com would, which in turn triggers the existing
// gh-pages auto-deploy workflow.

const GITHUB_REPO = "jerod00/kernel";
const GITHUB_API = "https://api.github.com";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const GITHUB_ADMIN_TOKEN = process.env.GITHUB_ADMIN_TOKEN;

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

function adminPageHtml() {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kernel — Admin</title>
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
</style>
</head>
<body>
<div class="doc">
  <h1>Kernel — Admin</h1>
  <p class="sub">Open pull requests from the daily catalog-review pipeline. Merging here pushes to <code>main</code> exactly like the GitHub "Merge" button — nothing skipped.</p>
  <div id="list" class="loading">Loading open PRs…</div>
</div>
<script>
  const token = new URLSearchParams(location.search).get("token") || "";
  const listEl = document.getElementById("list");

  async function api(path, opts) {
    const res = await fetch(path + (path.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token), opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");
    return data;
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

module.exports = { requireAdminToken, listOpenPRs, mergePR, closePR, adminPageHtml };
