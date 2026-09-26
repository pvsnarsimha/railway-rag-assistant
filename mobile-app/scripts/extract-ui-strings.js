// extract-ui-strings.js
// ---------------------
// Collects the fixed English text of every screen (JSX text, title /
// subtitle / label / placeholder / hint props, t("...") / tf("...") and
// Alert.alert strings) into src/i18n/uiStrings.json. When a language is
// chosen the app sends this whole list for translation at once, so screens
// that haven't been opened yet are already in that language.
//
//   node scripts/extract-ui-strings.js
//
// Uses the same number masking as LanguageContext (numbers -> {0}, {1}...).

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const files = [path.join(ROOT, "App.js")];
(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (/\.js$/.test(f)) files.push(p);
  }
})(path.join(ROOT, "src"));

function mask(s) {
  let n = 0;
  return s.replace(/\b(?:https?|wss?):\/\/\S+|\d+(?:[.:,/]\d+)*/g, () => `{${n++}}`);
}
function needsTranslation(s) {
  if (s.length >= 2000 || !/[A-Za-z]{2,}/.test(s) || /^[A-Z]{2,5}$/.test(s.trim())) return false;
  const letters = s.match(/\p{L}/gu) || [];
  return letters.filter((c) => c <= "ɏ").length / letters.length >= 0.5;
}
// Things that look like text but are code.
function looksLikeCode(s) {
  return /^[a-z][A-Za-z0-9]*$/.test(s) // identifiers / keys
    || /^[a-z]+(?:[-_][a-z0-9]+)+$/.test(s) // icon names, slugs
    || /^[\w.-]+\/[\w./-]*$/.test(s) // paths
    || /[{}<>=;]|=>|\bconst\b|\breturn\b/.test(s)
    || /^#[0-9a-f]{3,8}$/i.test(s);
}

const out = new Set();
function add(raw) {
  if (raw == null) return;
  const s = String(raw).replace(/\\n/g, "\n").replace(/\\(["'`])/g, "$1").replace(/\s+/g, " ").trim();
  if (!s || s.length < 2 || looksLikeCode(s)) return;
  const tpl = mask(s);
  if (needsTranslation(tpl)) out.add(tpl);
}

const STR = String.raw`"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'`;
const PROP = new RegExp(String.raw`\b(?:title|subtitle|label|placeholder|hint|emptyText|helperText|description|message|text|trainLabel)=(?:\{\s*)?(?:${STR})`, "g");
const CALL = new RegExp(String.raw`\b(?:t|tf|tStop|translate)\(\s*(?:${STR})`, "g");
const ALERT = new RegExp(String.raw`Alert\.alert\(\s*(?:${STR})(?:\s*,\s*(?:${STR}))?`, "g");
const TEXTOBJ = new RegExp(String.raw`\btext:\s*(?:${STR})`, "g");

for (const f of files) {
  if (/i18n[\\/]uiStrings/.test(f)) continue;
  // Comments aren't screen text.
  const src = fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[\s;])\/\/.*$/gm, "$1");
  if (!/i18n\/AutoText|useT\(/.test(src) && !/App\.js$/.test(f)) continue;
  // JSX text between tags: >Some text<  (skipping {expressions})
  const jsx = /<(Text|PrimaryButton)\b[^>]*>([^<]*)</g;
  let m;
  while ((m = jsx.exec(src))) {
    m[2].split(/\{[^}]*\}/).forEach((part) => { if (/[A-Za-z]{2,}/.test(part)) add(part); });
  }
  for (const re of [PROP, CALL, TEXTOBJ]) { re.lastIndex = 0; while ((m = re.exec(src))) add(m[1] ?? m[2]); }
  ALERT.lastIndex = 0;
  while ((m = ALERT.exec(src))) { add(m[1] ?? m[2]); add(m[3] ?? m[4]); }
}

const list = [...out].sort();
fs.writeFileSync(path.join(ROOT, "src/i18n/uiStrings.json"), "[\n" + list.map((s) => JSON.stringify(s)).join(",\n") + "\n]\n");
console.log(`${list.length} UI strings -> src/i18n/uiStrings.json`);
