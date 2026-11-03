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

// FTS5 splits "2/3" into "2" and "3", so a query for 2/3 used to match article
// number 23. Fractions are indexed and queried as one token (f2of3). The
// denominator whitelist keeps law numbers (24/1982) and dates (13/10/2026)
// untouched.
const FRACTION_RE = /(?<![\d/])(\d{1,2})\s*\/\s*(\d{1,2})(?![\d/])/g;
const FRACTION_DENOMINATORS = new Set([2, 3, 4, 5, 6, 8, 10, 12, 16, 20]);

function fractionToken(match: string, numerator: string, denominator: string): string {
  const n = Number(numerator);
  const d = Number(denominator);
  return n > 0 && n < d && FRACTION_DENOMINATORS.has(d) ? `f${n}of${d}` : match;
}

/** Fold and expand common legal fraction wording before tokenisation. */
export function normalizeQuery(query: string): string {
  const expanded = foldTr(query)
    .replace(/\bucte\s+iki\b/g, " 2/3 ")
    .replace(/\bucte\s+bir\b/g, " 1/3 ")
    .replace(/\byari\b/g, " 1/2 ");
  return expanded.replace(FRACTION_RE, (match, numerator, denominator) =>
    fractionToken(match, numerator, denominator),
  );
}

/** Split a user query into folded word tokens (quoted phrases preserved). */
export function queryTokens(query: string): string[] {
  const normalized = normalizeQuery(query);
  const tokens: string[] = [];
  const phraseRe = /"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = phraseRe.exec(normalized)) !== null) {
    const folded = match[1].replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (folded) tokens.push(folded);
  }
  const rest = normalized.replace(phraseRe, " ").split(/\s+/);
  for (const raw of rest) {
    const numeric = /^(\d{1,4})\s*[/-]\s*(\d{2,4})$/.exec(raw.trim());
    if (numeric) {
      tokens.push(`${numeric[1]} ${numeric[2]}`);
      continue;
    }
    const folded = raw.replace(/[^\p{L}\p{N}]+/gu, "");
    if (folded.length >= 2) tokens.push(folded);
  }
  return tokens;
}

function escapeFtsTerm(term: string): string {
  return term.replace(/"/g, '""');
}

/** Searchable variants for snippets/highlights: f2of3 -> 2/3, "24 1982" -> 24/1982. */
function termVariants(term: string): string[] {
  const fraction = /^f(\d+)of(\d+)$/.exec(term);
  if (fraction) return [`${fraction[1]}/${fraction[2]}`];
  const pair = /^(\d{1,4}) (\d{2,4})$/.exec(term);
  if (pair) return [term, `${pair[1]}/${pair[2]}`, `${pair[1]}-${pair[2]}`];
  return [term];
}

/**
 * Needles for snippet/highlight matching. Turkish suffixes are not stemmed by
 * FTS (it uses prefixes), so a query for "paylaşımında" should still find
 * "paylaşımı"; try progressively shorter stems, longest first.
 */
function termNeedles(term: string): string[] {
  const variants = termVariants(term);
  if (variants.some((variant) => variant.includes(" "))) return variants;
  const needles = new Set(variants);
  for (const variant of variants) {
    if (/^f\d+of\d+$/.test(term)) continue;
    for (let cut = 1; cut <= 5; cut += 1) {
      if (variant.length - cut >= 4) needles.add(variant.slice(0, variant.length - cut));
    }
  }
  return [...needles].sort((a, b) => b.length - a.length);
}

/** Build a safe FTS5 MATCH expression from a free-text query. */
export function buildMatch(query: string, mode: "all" | "any" | "phrase" = "all"): string {
  const normalized = normalizeQuery(query).trim();
  if (!normalized) return "";

  if (mode === "phrase") {
    const folded = normalized.replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim();
    return folded ? `"${escapeFtsTerm(folded)}"` : "";
  }

  const parts: string[] = [];
  const phraseRe = /"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = phraseRe.exec(normalized)) !== null) {
    const folded = match[1].replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim();
    if (folded) parts.push(`"${escapeFtsTerm(folded)}"`);
  }

  const rest = normalized.replace(phraseRe, " ").split(/\s+/);
  for (const raw of rest) {
    // FTS5 splits "24/1982" and "1122-2024" into two tokens; keep the pair
    // together as a phrase so law/case numbers do not become "241982".
    const numeric = /^(\d{1,4})\s*[/-]\s*(\d{2,4})$/.exec(raw.trim());
    if (numeric) {
      parts.push(`"${numeric[1]} ${numeric[2]}"`);
      continue;
    }
    const folded = raw.replace(/[^\p{L}\p{N}]+/gu, "");
    if (folded.length < 2) continue;
    const isFraction = /^f\d+of\d+$/.test(folded);
    parts.push(isFraction || folded.length < 3 ? escapeFtsTerm(folded) : `${escapeFtsTerm(folded)}*`);
  }

  if (!parts.length) return "";
  return parts.join(mode === "any" ? " OR " : " AND ");
}

function isWordChar(ch: string | undefined): boolean {
  return !!ch && /[\p{L}\p{N}]/u.test(ch);
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let index = 0;
  while ((index = text.indexOf(needle, index)) >= 0) {
    count += 1;
    index += needle.length;
  }
  return count;
}

function bestHit(
  folded: string,
  terms: string[],
): { index: number; length: number; count: number } | null {
  let best: { index: number; length: number; count: number } | null = null;
  for (const term of terms) {
    for (const needle of termNeedles(term)) {
      const index = folded.indexOf(needle);
      if (index < 0) continue;
      const candidate = { index, length: needle.length, count: countOccurrences(folded, needle) };
      // Rarest term first: "2/3" is more useful than the ubiquitous "mal".
      if (
        !best ||
        candidate.count < best.count ||
        (candidate.count === best.count && candidate.length > best.length) ||
        (candidate.count === best.count && candidate.length === best.length && candidate.index < best.index)
      ) {
        best = candidate;
      }
      break;
    }
  }
  return best;
}

/** Cut a readable window around the most specific matching term, not the first. */
export function makeSnippet(text: string, query: string, width = 320): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  if (clean.length <= width) return clean;

  const folded = foldTr(clean);
  const terms = queryTokens(query).filter((token) => token.length >= 2);
  let hit = bestHit(folded, terms);

  // "en az oran", "ne kadar", "yüzde" questions usually target a numeric cap
  // such as "2/3'ünden fazla olamaz"; show that sentence instead of a common
  // word like "mal".
  if (/\b(oran|en az|en cok|en fazla|ne kadar|yuzde)\b/.test(normalizeQuery(query))) {
    const fraction = /(?<![\d/])\d{1,3}\s*\/\s*\d{1,3}(?![\d/])/.exec(folded);
    if (fraction?.index !== undefined) {
      hit = { index: fraction.index, length: fraction[0].length, count: 1 };
    }
  }

  let start: number;
  if (!hit) {
    start = 0;
  } else {
    start = Math.max(0, hit.index - Math.floor(width * 0.28));
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

export interface TextHighlight {
  start: number;
  end: number;
}

/** Character offsets of query terms inside a snippet/title (for UI marking). */
export function makeHighlights(text: string, query: string, max = 8): TextHighlight[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const folded = foldTr(clean);
  const spans: TextHighlight[] = [];
  for (const term of queryTokens(query)) {
    if (term.length < 3 && !/^f\d+of\d+$/.test(term)) continue;
    for (const needle of termNeedles(term)) {
      const index = folded.indexOf(needle);
      if (index < 0) continue;
      spans.push({ start: index, end: index + needle.length });
      break;
    }
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: TextHighlight[] = [];
  for (const span of spans) {
    const previous = merged[merged.length - 1];
    if (previous && span.start <= previous.end) {
      previous.end = Math.max(previous.end, span.end);
      continue;
    }
    merged.push({ ...span });
    if (merged.length >= max) break;
  }
  return merged;
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
