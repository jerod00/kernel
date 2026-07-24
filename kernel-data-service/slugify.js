// Shared with onboard-film.js and refresh-now-playing.js — both must compute
// the exact same dataId for a given TMDb title+year, since refresh-now-playing.js
// joins TMDb's now_playing results against FILMS entries by this value.

// Built from char codes (Unicode combining-diacritical-marks block,
// 0x0300-0x036f) instead of a literal, so no raw multi-byte characters sit
// in this file.
const COMBINING_MARK_LOW = String.fromCharCode(0x0300);
const COMBINING_MARK_HIGH = String.fromCharCode(0x036f);
const COMBINING_MARKS = new RegExp("[" + COMBINING_MARK_LOW + "-" + COMBINING_MARK_HIGH + "]", "g");

function slugify(title, year) {
  const ascii = title.normalize("NFD").replace(COMBINING_MARKS, ""); // decompose then strip accent marks (matches the existing dataset's convention)
  const base = ascii.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "");
  return year ? `${base}-${year}` : base;
}

module.exports = { slugify };
