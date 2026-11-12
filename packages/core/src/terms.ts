/**
 * Term dictionary lookup (OPUS-GOREVLER-4 G; built by crawler/kktc/terms.py).
 * A term's key is the sorted, unique first-four-letter stems of its content
 * words; the question gives every combination of up to four of its stems, so
 * word order and suffixes do not matter. One indexed D1 query per request.
 */
import { foldTr } from "./text.js";
import type { Store } from "./types.js";

const STOPWORDS = new Set([
  "nedir", "nelerdir", "nasil", "hangi", "hangisi", "kadar", "ne", "en", "az", "cok", "fazla",
  "mi", "mu", "midir", "mudur", "var", "yok", "icin", "ile", "ve", "veya", "olan", "olarak",
  "gibi", "kim", "kimdir", "nerede", "zaman", "ise", "bir", "bu", "su", "da", "de", "ki",
]);
const STEM = 4;
const MAX_STEMS = 10;
const MAX_TERM_WORDS = 4;
/** Articles taken from the dictionary per question. */
export const TERM_HITS = 6;

export function termStems(text: string): string[] {
  const out: string[] = [];
  for (const word of foldTr(text).split(/[^a-z0-9]+/)) {
    if (word.length < 3 || STOPWORDS.has(word) || /^\d+$/.test(word)) continue;
    const stem = word.slice(0, STEM);
    if (!out.includes(stem)) out.push(stem);
  }
  return out;
}

export function termKey(term: string): string {
  return [...termStems(term)].sort().join(" ");
}

/** Every key a term in the question could have (combinations of up to four stems). */
export function questionKeys(question: string): string[] {
  const stems = termStems(question).slice(0, MAX_STEMS).sort();
  const keys: string[] = [];
  const walk = (start: number, chosen: string[]) => {
    if (chosen.length) keys.push(chosen.join(" "));
    if (chosen.length === MAX_TERM_WORDS) return;
    for (let i = start; i < stems.length; i++) walk(i + 1, [...chosen, stems[i]]);
  };
  walk(0, []);
  return keys;
}

export interface TermHit {
  term: string;
  doc_id: string;
  ref: string;
  status: string;
  /** Stems the term shares with the question (longer terms are more specific). */
  words: number;
}

/** Dictionary terms found in the question, most specific first, one per article. */
export async function findTerms(store: Store, question: string): Promise<TermHit[]> {
  const keys = questionKeys(question);
  if (!keys.length) return [];
  const rows = [];
  for (let i = 0; i < keys.length; i += 90) {
    const part = keys.slice(i, i + 90);
    try {
      rows.push(
        ...(await store.all(
          `SELECT key, term, doc_id, ref, status FROM terms WHERE key IN (${part.map(() => "?").join(",")})`,
          part,
        )),
      );
    } catch {
      return []; // no terms table yet
    }
  }
  const hits = rows
    .map((row) => ({
      term: String(row.term),
      doc_id: String(row.doc_id),
      ref: String(row.ref),
      status: String(row.status),
      words: String(row.key).split(" ").length,
    }))
    .sort((a, b) => b.words - a.words || (a.status === "avukat" ? -1 : 0) - (b.status === "avukat" ? -1 : 0));
  const seen = new Set<string>();
  return hits.filter((h) => {
    const k = `${h.doc_id}\u0000${h.ref}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
