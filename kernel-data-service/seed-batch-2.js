require("dotenv").config();
const { ingest, verifyChain } = require("./db");

// Second ingestion batch — 8 additional films researched to broaden the
// dataset (needed for the viewers-vs-score "hidden gems" analysis and a less
// tiny legs-average sample). Appends to the same HMAC-chained log as
// seed.js; does not touch or depend on it.

const FILMS = {
  "everything-everywhere-all-at-once-2022": {
    critic: { score: 81, ci: null, label: "Universal Acclaim", spreadPositive: 89, spreadMixed: 11, spreadNegative: 0, reviewCount: 55 },
    econ: { budget: 25, marketing: null, boxOfficeWorldwide: 143.4, domesticTotal: 72 },
    weeklyGross: null,
  },
  "pig-2021": {
    critic: { score: 82, ci: null, label: "Universal Acclaim", spreadPositive: 87, spreadMixed: 13, spreadNegative: 0, reviewCount: 39 },
    econ: { budget: 3, marketing: null, boxOfficeWorldwide: 4.6, domesticTotal: 3.8 },
    weeklyGross: null,
  },
  "sound-of-metal-2019": {
    critic: { score: 82, ci: null, label: "Universal Acclaim", spreadPositive: 95, spreadMixed: 5, spreadNegative: 0, reviewCount: 37 },
    econ: { budget: 5.4, marketing: null, boxOfficeWorldwide: 0.51652, domesticTotal: null },
    weeklyGross: null,
  },
  "the-whale-2022": {
    critic: { score: 60, ci: null, label: "Mixed or Average", spreadPositive: 46, spreadMixed: 40, spreadNegative: 14, reviewCount: 57 },
    econ: { budget: 3, marketing: null, boxOfficeWorldwide: 57.6, domesticTotal: 17.46 },
    weeklyGross: null,
    // director_filmography for darren-aronofsky (including this film, score 60) was already logged in seed.js
  },
  "barbie-2023": {
    critic: { score: 80, ci: null, label: "Generally Favorable", spreadPositive: 91, spreadMixed: 7, spreadNegative: 1, reviewCount: 67 },
    econ: { budget: 145, marketing: 150, boxOfficeWorldwide: 1447.138, domesticTotal: 636.238 },
    weeklyGross: [162.022044, 93.011602, 53.008647, 33.833294, 21.030328, 15.104145, 10.214874, 5.701914, 3.821767, 3.201442, 1.424571, 0.781687, 0.475664, 0.253324, 0.090077, 0.085176, 0.058136, 0.020379, 0.013625, 0.007712, 0.003754, 0.006094, 0.001178, 0.001960, 0.002385, 0.002972, 0.002020],
  },
  "cats-2019": {
    critic: { score: 32, ci: null, label: "Generally Unfavorable", spreadPositive: 12, spreadMixed: 45, spreadNegative: 43, reviewCount: 51 },
    econ: { budget: 95, marketing: 115, boxOfficeWorldwide: 77.3, domesticTotal: 27.167 },
    weeklyGross: [6.619870, 4.821760, 2.630135, 0.559260, 0.143680, 0.104785, 0.070405, 0.044530],
  },
  "morbius-2022": {
    critic: { score: 35, ci: null, label: "Generally Unfavorable", spreadPositive: 13, spreadMixed: 45, spreadNegative: 42, reviewCount: 55 },
    econ: { budget: 75, marketing: 50, boxOfficeWorldwide: 167.5, domesticTotal: 73.866 },
    weeklyGross: [39.005895, 10.201332, 4.730148, 2.307137, 1.513341, 0.630040, 0.305809, 0.183065, 0.029802, 0.310665, 0.053052, 0.005695],
  },
  "joker-folie-a-deux-2024": {
    critic: { score: 46, ci: null, label: "Mixed or Average", spreadPositive: 33, spreadMixed: 42, spreadNegative: 25, reviewCount: 64 },
    econ: { budget: 200, marketing: 100, boxOfficeWorldwide: 207.5, domesticTotal: 58.3 },
    weeklyGross: [37.678467, 7.002654, 2.146800, 0.584496, 0.140958, 0.025002],
    // director_filmography for todd-phillips (including this film, score 46) was already logged in seed.js
  },
};

const SOURCES = {
  critic: "Metacritic (weighted critic average)",
  budget: "Box Office Mojo / The Numbers / trade press",
  marketing: "Trade press estimate",
  boxOfficeWorldwide: "Box Office Mojo",
  domesticTotal: "Box Office Mojo",
  weeklyGross: "Box Office Mojo (weekend breakdown)",
  filmography: "Metacritic (person page)",
};

let count = 0;

for (const [filmId, data] of Object.entries(FILMS)) {
  for (const [field, value] of Object.entries(data.critic)) {
    if (value === null) continue;
    ingest({ entityType: "film", entityId: filmId, field: `critic_${field}`, value, source: SOURCES.critic });
    count++;
  }
  for (const [field, value] of Object.entries(data.econ)) {
    if (value === null) continue;
    const source = field === "marketing" ? SOURCES.marketing : field === "budget" ? SOURCES.budget : SOURCES[field] || SOURCES.critic;
    ingest({ entityType: "film", entityId: filmId, field: `econ_${field}`, value, source });
    count++;
  }
  if (data.weeklyGross) {
    data.weeklyGross.forEach((gross, i) => {
      ingest({ entityType: "film_weekend_gross", entityId: `${filmId}:week${i + 1}`, field: "gross_millions_usd", value: gross, source: SOURCES.weeklyGross });
      count++;
    });
  }
}

console.log(`Seeded ${count} additional facts.`);
console.log(verifyChain());
