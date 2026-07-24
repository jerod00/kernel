require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// Runs right after draft-onboard.js opens its PR, using the exact list of
// films it just drafted (no re-parsing the diff). Posts a fact-check
// comment on that PR — never blocks or auto-merges anything, just gives
// the human reviewer a head start.
//
// Two distinct kinds of check, on purpose (same philosophy as
// draft-onboard.js's insight-writing: never ask the model to verify
// arithmetic or facts it can't independently check):
//   1. Structural/numeric checks in plain code — re-verifies the TMDb
//      match independently (catches the "same-titled different film"
//      class of bug this codebase has hit before), range-checks scores
//      and dollar figures, surfaces onboard-film.js's own mismatch flags.
//   2. A prose-consistency pass via Claude — checks only whether the
//      AI-drafted insight text actually matches the numbers it was given,
//      not whether the numbers themselves are correct (that's TMDb/OMDb's
//      job, already covered by check 1).
//
// Usage: DRAFTED_JSON='[...]' PR_NUMBER=123 node review-draft-pr.js

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TMDB_ACCESS_TOKEN = process.env.TMDB_ACCESS_TOKEN;
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001"; // same model draft-onboard.js already uses
const DRAFTS_DIR = path.join(__dirname, "drafts");

const draftedArg = process.env.DRAFTED_JSON;
const prNumber = process.env.PR_NUMBER;
if (!draftedArg || !prNumber) {
  console.error("Usage: set DRAFTED_JSON and PR_NUMBER env vars, then run node review-draft-pr.js");
  process.exit(1);
}
const drafted = JSON.parse(draftedArg);
if (!drafted.length) {
  console.log("Nothing drafted this run — nothing to review.");
  process.exit(0);
}

async function tmdb(pathName) {
  const res = await fetch(`https://api.themoviedb.org/3${pathName}`, {
    headers: { Authorization: `Bearer ${TMDB_ACCESS_TOKEN}` },
  });
  if (!res.ok) throw new Error(`TMDb ${pathName} failed: ${res.status}`);
  return res.json();
}

async function callAnthropic(system, userPrompt, maxTokens) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API responded ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = data.content && data.content[0] && data.content[0].text;
  if (!text) throw new Error("Anthropic API returned no text");
  return text.trim();
}

async function structuralChecks(entry, draft) {
  const flags = [];

  try {
    const search = await tmdb(`/search/movie?query=${encodeURIComponent(entry.title)}&year=${entry.year}`);
    const match = search.results && search.results[0];
    if (!match) {
      flags.push(`No TMDb match found on re-search for "${entry.title}" (${entry.year}) — draft may be stale or mistitled.`);
    } else {
      const matchYear = (match.release_date || "").slice(0, 4);
      if (String(matchYear) !== String(entry.year)) {
        flags.push(`Re-search year mismatch: draft says ${entry.year}, TMDb's top result for "${entry.title}" is ${matchYear || "unknown"}.`);
      }
    }
  } catch (err) {
    flags.push(`Could not re-verify TMDb match: ${err.message}`);
  }

  if (draft.critic && draft.critic.score != null && (draft.critic.score < 0 || draft.critic.score > 100)) {
    flags.push(`critic.score ${draft.critic.score} is outside the valid 0-100 range.`);
  }
  if (draft.econ && draft.econ.budget != null && draft.econ.budget < 0) {
    flags.push(`econ.budget is negative (${draft.econ.budget}).`);
  }
  if (draft.econ && draft.econ.boxOfficeWorldwide != null && draft.econ.boxOfficeWorldwide < 0) {
    flags.push(`econ.boxOfficeWorldwide is negative (${draft.econ.boxOfficeWorldwide}).`);
  }
  if (draft.mismatches && draft.mismatches.length) {
    flags.push(...draft.mismatches.map(m => `onboard-film.js flagged: ${m}`));
  }
  if (!draft.poster) flags.push(`No poster path — TMDb had none for this title.`);
  if (!draft.genres || !draft.genres.length) flags.push(`No genres returned from TMDb.`);

  return flags;
}

(async () => {
  const sections = [];
  for (const entry of drafted) {
    const draftPath = path.join(DRAFTS_DIR, `${entry.dataId}.json`);
    if (!fs.existsSync(draftPath)) {
      sections.push(`### ${entry.title} (${entry.year})\n- ⚠️ Draft file not found at \`drafts/${entry.dataId}.json\` — can't verify.`);
      continue;
    }
    const draft = JSON.parse(fs.readFileSync(draftPath, "utf8"));
    const flags = await structuralChecks(entry, draft);

    let proseCheck = "n/a (no drafted prose)";
    if (draft.insight || draft.directorInsight || draft.actorInsight) {
      const prompt = `Here is a film's data and AI-drafted prose written about it. Check ONLY whether the prose is factually consistent with the given numbers (must not contradict them, invent numbers not given, or get a comparison direction backwards) — do not fact-check the numbers themselves, those come directly from TMDb/OMDb.

Data: ${JSON.stringify({ name: draft.name, year: draft.year, critic: draft.critic, econ: draft.econ }, null, 2)}
Director stats used: ${JSON.stringify(draft.director ? draft.director.films : null)}
insight: ${JSON.stringify(draft.insight)}
directorInsight: ${JSON.stringify(draft.directorInsight)}
actorInsight: ${JSON.stringify(draft.actorInsight)}

Reply with either "OK — prose matches the given data." or a short, specific description of the contradiction found.`;
      try {
        proseCheck = await callAnthropic(
          "You are a terse fact-checker. Only flag genuine contradictions between prose and the numbers given to you — do not nitpick style or phrasing.",
          prompt,
          300
        );
      } catch (err) {
        proseCheck = `Could not run prose check: ${err.message}`;
      }
    }

    const flagsText = flags.length ? flags.map(f => `- ⚠️ ${f}`).join("\n") : "- No structural issues found.";
    sections.push(`### ${entry.title} (${entry.year}) — \`FILMS.${entry.key}\`\n${flagsText}\n- **Prose check:** ${proseCheck}`);
  }

  const body = `## Automated fact-check

Structural checks (independent TMDb re-verification, range checks, onboard-film.js's own mismatch flags) plus a prose-consistency pass on the AI-drafted insight text. This does **not** replace the manual Tier 2 research (Metacritic spread, marketing spend, weekly gross) still needed before merging.

${sections.join("\n\n")}`;

  fs.writeFileSync("review-body.tmp.md", body);
  execFileSync("gh", ["pr", "comment", String(prNumber), "--body-file", "review-body.tmp.md"], { stdio: "inherit" });
  fs.unlinkSync("review-body.tmp.md");
  console.log(`Posted fact-check comment on PR #${prNumber}`);
})().catch(err => {
  console.error("Failed:", err.message);
  process.exit(1);
});
