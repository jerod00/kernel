// Mirrors Metacritic's own published band definitions for movies — confirmed
// against every currently-onboarded film's actual score/label pairing before
// relying on it (e.g. 88->"Universal Acclaim", 77->"Generally Favorable",
// 54->"Mixed or Average", 32->"Generally Unfavorable").
function scoreLabel(score) {
  if (score >= 81) return "Universal Acclaim";
  if (score >= 61) return "Generally Favorable";
  if (score >= 40) return "Mixed or Average";
  if (score >= 20) return "Generally Unfavorable";
  return "Overwhelming Dislike";
}

module.exports = { scoreLabel };
