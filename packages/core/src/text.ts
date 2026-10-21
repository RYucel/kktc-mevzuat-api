/** Turkish folding and snippet helpers.
 *
 * The crawl pipeline stores a folded copy of every chunk in FTS5. Folding is
 * one character in, one character out, so offsets in the folded text map
 * exactly onto the original Turkish text. The API uses that to render clean
 * snippets without asking SQLite to cut the text.
 */

const FOLD: Record<string, string> = {
  ı: "i",
  İ: "i",
  I: "i",
  ş: "s",
  Ş: "s",
  ğ: "g",
  Ğ: "g",
  ü: "u",
  Ü: "u",
  ö: "o",
  Ö: "o",
  ç: "c",
  Ç: "c",
  â: "a",
  Â: "a",
  î: "i",
  Î: "i",
  û: "u",
  Û: "u",
  "’": "'",
  "‘": "'",
  "“": '"',
  "”": '"',
  "–": "-",
  "—": "-",
  "\u00a0": " ",
  "\u2007": " ",
  "\u202f": " ",
};

const FOLD_RE = new RegExp(`[${Object.keys(FOLD).join("")}]`, "g");

/** Case/diacritic-insensitive folding that preserves string length. */
export function foldTr(text: string): string {
  return text.replace(FOLD_RE, (ch) => FOLD[ch] ?? ch).toLowerCase();
}

/** Split a user query into folded word tokens (quoted phrases preserved). */
export function queryTokens(query: string): string[] {
  const tokens: string[] = [];
  const phraseRe = /"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = phraseRe.exec(query)) !== null) {
    const folded = foldTr(match[1]).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (folded) tokens.push(folded);
  }
  const rest = query.replace(phraseRe, " ").split(/\s+/);
  for (const raw of rest) {
    const folded = foldTr(raw).replace(/[^\p{L}\p{N}]+/gu, "");
    if (folded.length >= 2) tokens.push(folded);
  }
  return tokens;
}

function escapeFtsTerm(term: string): string {
  return term.replace(/"/g, '""');
}

/** Build a safe FTS5 MATCH expression from a free-text query. */
export function buildMatch(query: string, mode: "all" | "any" | "phrase" = "all"): string {
  const trimmed = query.trim();
  if (!trimmed) return "";

  if (mode === "phrase") {
    const folded = foldTr(trimmed).replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim();
    return folded ? `"${escapeFtsTerm(folded)}"` : "";
  }

  const parts: string[] = [];
  const phraseRe = /"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = phraseRe.exec(trimmed)) !== null) {
    const folded = foldTr(match[1]).replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim();
    if (folded) parts.push(`"${escapeFtsTerm(folded)}"`);
  }

  const rest = trimmed.replace(phraseRe, " ").split(/\s+/);
  for (const raw of rest) {
    const folded = foldTr(raw).replace(/[^\p{L}\p{N}]+/gu, "");
    if (folded.length < 2) continue;
    parts.push(folded.length >= 3 ? `${escapeFtsTerm(folded)}*` : escapeFtsTerm(folded));
  }

  if (!parts.length) return "";
  return parts.join(mode === "any" ? " OR " : " AND ");
}

function isWordChar(ch: string | undefined): boolean {
  return !!ch && /[\p{L}\p{N}]/u.test(ch);
}

/** Cut a readable window around the first matching term, preserving Turkish. */
export function makeSnippet(text: string, query: string, width = 320): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  if (clean.length <= width) return clean;

  const folded = foldTr(clean);
  const terms = queryTokens(query)
    .map((token) => token.split(" ")[0])
    .filter((token) => token.length >= 2);
  let hit = -1;
  for (const term of terms) {
    const idx = folded.indexOf(term);
    if (idx >= 0 && (hit < 0 || idx < hit)) hit = idx;
  }

  let start: number;
  if (hit < 0) {
    start = 0;
  } else {
    start = Math.max(0, hit - Math.floor(width * 0.28));
    // Do not start in the middle of a word.
    while (start > 0 && isWordChar(clean[start - 1]) && isWordChar(clean[start])) start -= 1;
  }
  let end = Math.min(clean.length, start + width);
  while (end < clean.length && isWordChar(clean[end]) && isWordChar(clean[end - 1])) end += 1;
  if (end - start < width && start > 0) {
    start = Math.max(0, end - width);
    while (start > 0 && isWordChar(clean[start - 1]) && isWordChar(clean[start])) start -= 1;
  }

  const slice = clean.slice(start, end).trim();
  return `${start > 0 ? "…" : ""}${slice}${end < clean.length ? "…" : ""}`;
}

/** Normalise a user-supplied article reference: "12", "Madde 12", "m. 30A". */
export function normalizeArticleRef(ref: string): string | null {
  const match = /^\s*(?:madde|m\.?)?\s*(\d{1,4})\s*([A-Za-z])?\s*$/.exec(ref);
  if (!match) return null;
  return `Madde ${Number(match[1])}${match[2] ? match[2].toUpperCase() : ""}`;
}

/** Base reference for a chunk that may be a split part: "Madde 12 (2/3)". */
export function baseArticleRef(ref: string | null): string | null {
  if (!ref) return null;
  const match = /^Madde\s+\d+[A-Z]?/.exec(ref);
  return match ? match[0] : null;
}

export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.lastIndexOf(" ", limit);
  return `${text.slice(0, cut > limit * 0.6 ? cut : limit).trimEnd()}…`;
}
