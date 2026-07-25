// Cheap, local heuristics for the one public write path (POST /api/ingest,
// audience_review comments) — no external API/account needed. Not trying to
// catch everything a determined human spammer could write, just the
// automated/promotional patterns that actually show up: links, promo
// phrases, and keyboard-mash filler. A real review can't match any of these
// without going out of its way to.

const URL_RE = /https?:\/\/|www\.\S+\.\w{2,}|\S+\.(com|net|org|io|xyz|top|club|shop|tk|biz)\b/i;
const REPEATED_CHAR_RE = /(.)\1{7,}/; // e.g. "aaaaaaaa" or "!!!!!!!!"
const HAS_LETTER_RE = /[a-z]/i;

const SPAM_PHRASES = [
  "buy now", "click here", "free money", "make money fast", "work from home",
  "work at home", "crypto giveaway", "nft giveaway", "follow me", "follow us",
  "check out my", "subscribe to my channel", "dm me", "whatsapp me",
  "telegram me", "contact me on", "visit my site", "earn $", "guaranteed profit",
  "weight loss", "male enhancement", "casino bonus", "bet now",
];

function looksLikeSpam(comment) {
  if (!comment) return false;
  const text = comment.trim();
  if (!text) return false;
  if (URL_RE.test(text)) return "contains a link";
  if (REPEATED_CHAR_RE.test(text)) return "repeated-character filler";
  if (HAS_LETTER_RE.test(text)) {
    const lower = text.toLowerCase();
    const phrase = SPAM_PHRASES.find(p => lower.includes(p));
    if (phrase) return `matches a known spam phrase ("${phrase}")`;
  } else {
    // No letters at all in non-empty text — pure symbol/number noise.
    return "no readable text";
  }
  return false;
}

module.exports = { looksLikeSpam };
