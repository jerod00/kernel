#!/usr/bin/env node
// Runs after every push to main (see .github/workflows/rebase-open-prs.yml).
//
// Every automated PR that touches widget/index.html (draft-onboard.js,
// historical-backfill.js, backfill-top200.js) inserts new FILMS entries at
// the exact same anchor point — just before the object's closing brace —
// via insertEntriesAndWrite(). Two such PRs opened around the same time are
// fine independently, but the moment EITHER of them merges, every OTHER
// still-open one becomes stale and starts failing to merge with a conflict,
// even though the actual films being added never overlap. This happened
// for real, repeatedly, in one session: PR #8 vs #9, then #10 vs #11/#12.
//
// Rather than requiring a human (or an AI assistant) to manually extract
// and reapply each stale PR's real content by hand every time this occurs,
// this keeps every open PR continuously mergeable automatically: for each
// PR currently reported as CONFLICTING, it extracts that PR's own actual
// content and reapplies it cleanly onto the latest main, force-pushing the
// result back onto the SAME branch. The PR itself is untouched — same
// number, same title, same review thread, same fact-check comment — only
// its underlying commit changes to stay conflict-free. Nothing here ever
// merges anything; a human still has to click Merge.
//
// Usage: node scripts/rebase-open-prs.js
// Requires: gh CLI authenticated (GH_TOKEN), run from the repo root.

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const vm = require("node:vm");

const REPO = "jerod00/kernel";
const WIDGET_PATH = "widget/index.html";
const MAX_MERGEABLE_POLL_ATTEMPTS = 5;

function sh(cmd) {
  return execSync(cmd, { encoding: "utf8" }).trim();
}

function ghJson(args) {
  return JSON.parse(sh(`gh ${args}`));
}

// Only the FIRST diff hunk is ever reapplied. A well-behaved automated PR
// against this file should always produce exactly one hunk (a pure
// insertion at the FILMS closing brace) — a second hunk showing up means
// something unrelated rode along (this happened once, by accident, when a
// manual edit collided with a running backfill script sharing the same
// working directory) and must not be silently replayed twice if it already
// exists on main independently.
function extractFirstHunkAdditions(diffText) {
  const lines = diffText.split("\n");
  const added = [];
  let hunkCount = 0;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      hunkCount++;
      if (hunkCount > 1) break;
      continue;
    }
    if (hunkCount !== 1) continue;
    if (line.startsWith("+")) added.push(line.slice(1));
  }
  return { addedText: added.join("\n"), hunkCount };
}

function reapply(mainHtml, addedText) {
  const usesCRLF = mainHtml.includes("\r\n");
  const closingMatch = mainHtml.match(/\r?\n {2}\};\r?\n/);
  if (!closingMatch) throw new Error("Could not find the FILMS object's closing brace in main's widget/index.html");
  const newline = usesCRLF ? "\r\n" : "\n";
  const insertText = usesCRLF ? addedText.replace(/\n/g, "\r\n") : addedText;
  const newHtml = mainHtml.slice(0, closingMatch.index) + newline + insertText + mainHtml.slice(closingMatch.index);
  const scriptMatch = newHtml.match(/<script>([\s\S]*?)<\/script>/);
  if (!scriptMatch) throw new Error("Could not find <script> block — refusing to write");
  new vm.Script(scriptMatch[1], { filename: "rebase-check.js" }); // throws SyntaxError on bad JS, never executes it
  return newHtml;
}

async function processPr(pr) {
  console.log(`\n=== PR #${pr.number}: ${pr.title} ===`);

  let mergeable;
  for (let attempt = 0; attempt < MAX_MERGEABLE_POLL_ATTEMPTS; attempt++) {
    mergeable = ghJson(`pr view ${pr.number} --repo ${REPO} --json mergeable`).mergeable;
    if (mergeable !== "UNKNOWN") break;
    console.log("  mergeable state still computing, waiting...");
    sh("sleep 3");
  }

  if (mergeable !== "CONFLICTING") {
    console.log(`  mergeable=${mergeable} — no action needed.`);
    return;
  }

  sh(`git fetch origin ${pr.headRefName} --quiet`);
  const diffText = sh(`git diff origin/main...origin/${pr.headRefName} -- ${WIDGET_PATH}`);
  if (!diffText) {
    console.log("  No diff to widget/index.html found — conflict must be elsewhere. Skipping, needs manual attention.");
    return;
  }

  const { addedText, hunkCount } = extractFirstHunkAdditions(diffText);
  if (hunkCount > 1) {
    console.warn(`  WARNING: found ${hunkCount} diff hunks — only reapplying the first. The rest may be unrelated changes already present on main, or may need manual attention.`);
  }
  if (!addedText) {
    console.log("  First hunk had no pure additions — skipping, needs manual attention.");
    return;
  }

  const mainHtml = sh(`git show origin/main:${WIDGET_PATH}`);
  let newHtml;
  try {
    newHtml = reapply(mainHtml, addedText);
  } catch (err) {
    console.error(`  Failed to reapply cleanly: ${err.message} — skipping, needs manual attention.`);
    return;
  }

  const tmpBranch = `rebase-tmp-${pr.number}-${Date.now()}`;
  sh(`git checkout -B ${tmpBranch} origin/main --quiet`);
  fs.writeFileSync(WIDGET_PATH, newHtml);
  sh(`git add ${WIDGET_PATH}`);
  sh(`git commit -m "Auto-rebase onto latest main (resolves a conflict from a since-merged PR)" --quiet`);
  sh(`git push origin ${tmpBranch}:${pr.headRefName} --force`);
  sh(`git checkout main --quiet`);
  sh(`git branch -D ${tmpBranch} --quiet`);
  console.log(`  Rebased and force-pushed PR #${pr.number}.`);
}

(async () => {
  sh(`git config user.name "kernel-bot"`);
  sh(`git config user.email "actions@github.com"`);
  sh(`git fetch origin main --quiet`);

  const openPrs = ghJson(`pr list --repo ${REPO} --state open --json number,headRefName,title`);
  if (!openPrs.length) {
    console.log("No open PRs — nothing to check.");
    return;
  }

  for (const pr of openPrs) {
    await processPr(pr);
  }
})().catch(err => {
  console.error("Failed:", err.message);
  process.exit(1);
});
