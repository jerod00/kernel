require("dotenv").config();
const { ingest, verifyChain } = require("./db");

// Mirrors the FILMS dataset currently hardcoded in the Kernel Score widget.
// Running this against a fresh kernel.db is how that data gets "logged in
// as it comes in" — each fact below becomes its own immutable, HMAC-chained
// row. Re-running this script against an existing DB does NOT overwrite
// anything; it appends a new row per fact, so getLatest() reflects this run
// while getHistory() still shows every prior one.

const FILMS = {
  "joker-2019": {
    critic: { score: 59, ci: "± 4", label: "Mixed", spreadPositive: 55, spreadMixed: 27, spreadNegative: 18, reviewCount: 60 },
    econ: { budget: 55, marketing: 120, boxOfficeWorldwide: 1063.6, domesticTotal: 335.478 },
    weeklyGross: [96.202337, 55.861403, 29.251840, 19.248035, 13.500116, 9.221303, 5.338389, 2.746029, 1.950478, 1.011191, 0.472341, 0.141192, 0.132310, 0.128484, 0.059333, 0.348048, 0.113282, 0.129439, 0.122527, 0.075553, 0.039972, 0.024004],
    director: { name: "todd-phillips", films: { "old-school-2003": 54, "starsky-hutch-2004": 55, "the-hangover-2009": 73, "war-dogs-2016": 57, "joker-2019": 59, "joker-folie-a-deux-2024": 46 } },
    actor: { name: "joaquin-phoenix", films: { "parenthood-1989": 82, "to-die-for-1995": 86, "gladiator-2000": 67, "quills-2000": 70, "the-yards-2000": 58, "signs-2002": 59, "hotel-rwanda-2004": 79, "walk-the-line-2005": 72, "we-own-the-night-2007": 59, "two-lovers-2008": 74, "the-master-2012": 86, "her-2013": 91, "the-immigrant-2013": 77, "inherent-vice-2014": 81, "you-were-never-really-here-2017": 84, "dont-worry-he-wont-get-far-on-foot-2018": 67, "the-sisters-brothers-2018": 78, "joker-2019": 59, "cmon-cmon-2021": 82 } },
  },
  "mother-2017": {
    critic: { score: 76, ci: "± 3", label: "Generally Positive", spreadPositive: 71, spreadMixed: 27, spreadNegative: 2, reviewCount: 51 },
    econ: { budget: 30, marketing: null, boxOfficeWorldwide: 44.5, domesticTotal: 17.800 },
    weeklyGross: [7.534673, 2.651540, 1.247218, 0.763744, 0.286400],
    director: { name: "darren-aronofsky", films: { "pi-1998": 72, "requiem-for-a-dream-2000": 71, "the-fountain-2006": 51, "the-wrestler-2008": 80, "black-swan-2010": 79, "noah-2014": 68, "mother-2017": 76, "the-whale-2022": 60, "caught-stealing-2025": 65 } },
    actor: { name: "jennifer-lawrence", films: { "the-burning-plain-2008": 45, "winters-bone-2010": 90, "x-men-first-class-2011": 65, "like-crazy-2011": 68, "the-beaver-2011": 60, "the-hunger-games-2012": 68, "silver-linings-playbook-2012": 81, "house-at-the-end-of-the-street-2012": 31, "american-hustle-2013": 90, "the-hunger-games-catching-fire-2013": 76, "x-men-days-of-future-past-2014": 75, "the-hunger-games-mockingjay-part-1-2014": 64, "serena-2014": 36, "the-hunger-games-mockingjay-part-2-2015": 65, "joy-2015": 56, "x-men-apocalypse-2016": 52, "passengers-2016": 41, "mother-2017": 76, "red-sparrow-2018": 53, "x-men-dark-phoenix-2019": 43, "dont-look-up-2021": 49, "causeway-2022": 66, "no-hard-feelings-2023": 59, "die-my-love-2025": 72 } },
  },
  "the-last-jedi-2017": {
    critic: { score: 84, ci: "± 2", label: "Widely Acclaimed", spreadPositive: 93, spreadMixed: 7, spreadNegative: 0, reviewCount: 56 },
    econ: { budget: 262, marketing: 190, boxOfficeWorldwide: 1322.6, domesticTotal: 620.181 },
    weeklyGross: [220.009584, 71.565498, 52.520140, 23.728944, 11.854481, 6.555435, 4.254001, 2.338242, 1.397413, 0.617698, 0.352838, 0.252689, 0.265513, 0.174756, 0.102020, 0.066989, 0.033544, 0.005845],
    director: { name: "rian-johnson", films: { "brick-2005": 72, "the-brothers-bloom-2009": 55, "looper-2012": 84, "the-last-jedi-2017": 84, "knives-out-2019": 82, "glass-onion-2022": 81 } },
    actor: { name: "daisy-ridley", films: { "star-wars-the-force-awakens-2015": 80, "murder-on-the-orient-express-2017": 52, "the-last-jedi-2017": 84, "ophelia-2018": 60, "star-wars-the-rise-of-skywalker-2019": 53, "chaos-walking-2021": 38, "young-woman-and-the-sea-2024": 62 } },
  },
};

const SOURCES = {
  critic: "Metacritic (weighted critic average)",
  budget: "Box Office Mojo / The Numbers / Wikipedia",
  marketing: "Trade press estimate (Forbes)",
  boxOfficeWorldwide: "Box Office Mojo",
  domesticTotal: "Box Office Mojo",
  weeklyGross: "Box Office Mojo (weekend breakdown)",
  filmography: "Metacritic (person page)",
};

let count = 0;

for (const [filmId, data] of Object.entries(FILMS)) {
  for (const [field, value] of Object.entries(data.critic)) {
    ingest({ entityType: "film", entityId: filmId, field: `critic_${field}`, value, source: SOURCES.critic });
    count++;
  }
  for (const [field, value] of Object.entries(data.econ)) {
    if (value === null) continue; // undisclosed — nothing to log, don't fabricate a zero
    const source = field === "marketing" ? SOURCES.marketing : field === "budget" ? SOURCES.budget : SOURCES[field] || SOURCES.critic;
    ingest({ entityType: "film", entityId: filmId, field: `econ_${field}`, value, source });
    count++;
  }
  data.weeklyGross.forEach((gross, i) => {
    ingest({ entityType: "film_weekend_gross", entityId: `${filmId}:week${i + 1}`, field: "gross_millions_usd", value: gross, source: SOURCES.weeklyGross });
    count++;
  });
  for (const [creditedFilm, score] of Object.entries(data.director.films)) {
    ingest({ entityType: "director_filmography", entityId: data.director.name, field: creditedFilm, value: score, source: SOURCES.filmography });
    count++;
  }
  for (const [creditedFilm, score] of Object.entries(data.actor.films)) {
    ingest({ entityType: "actor_filmography", entityId: data.actor.name, field: creditedFilm, value: score, source: SOURCES.filmography });
    count++;
  }
}

console.log(`Seeded ${count} facts.`);
console.log(verifyChain());
