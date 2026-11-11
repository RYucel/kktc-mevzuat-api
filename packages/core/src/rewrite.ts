/**
 * Query rewriting with an LLM: a citizen's question ("internetten aldığım
 * ürünü iade edebilir miyim?") in the vocabulary of the statutes ("mesafeli
 * sözleşme", "cayma hakkı") plus the names of the statutes that may answer
 * it. The LLM never writes the answer: its terms and statute names only feed
 * the search (a concept channel and canonical-statute rows), and the answer
 * stays a verbatim quote.
 */

import { foldTr } from "./text.js";

export interface QueryRewrite {
  /** Legal terms and phrases (at most 8). */
  terms: string[];
  /** Statute names the LLM thinks answer the question (at most 3). */
  laws: string[];
  /** Served from the rewrite cache (no LLM call). */
  cached?: boolean;
}

/** The daily LLM budget is used up; the search runs without the rewrite. */
export class RewriteLimitError extends Error {
  constructor(message = "LLM daily limit reached") {
    super(message);
    this.name = "RewriteLimitError";
  }
}

export interface QueryRewriter {
  rewrite(question: string, options?: { model?: "20b" | "120b"; prompt?: RewritePrompt }): Promise<QueryRewrite>;
}

const PROMPT_V1 = [
  "Sen Kuzey Kıbrıs Türk Cumhuriyeti (KKTC) mevzuatında arama yapan bir hukuk asistanısın.",
  "Kullanıcının sorusunu cevaplamayacaksın; yalnızca aramayı iyileştireceksin.",
  "1) terms: Sorunun konusunu yasalarda geçen hukuki terimlerle anlatan 3-8 kısa Türkçe terim veya ifade",
  "   (ör. günlük dildeki 'işten atılmak' için 'hizmet akdinin feshi', 'bildirimsiz fesih').",
  "2) laws: Bu soruyu cevaplayabilecek KKTC yasalarının (veya tüzüklerinin) olası adları, en çok 3, en olasısı önce.",
  "   Emin değilsen genel yasa adını yaz (ör. 'Ceza Yasası', 'İş Yasası'). Uydurma numara yazma.",
  'Yalnızca şu biçimde JSON döndür: {"terms": ["..."], "laws": ["..."]}',
].join("\n");

/**
 * v2 (11 Nov 2026): gpt-oss-20b answered v1 with Turkish-Republic names
 * ("KDV Kanunu", "Devlet Memurları Kanunu"), invented ones and even
 * Azerbaijani; most resolved to unrelated statutes. v2 states how KKTC names
 * statutes, forbids other countries' codes and prefers no name to a guess.
 * Example names are deliberately not from the eval set.
 */
const PROMPT_V2 = [
  "Sen Kuzey Kıbrıs Türk Cumhuriyeti (KKTC) mevzuatında arama yapan bir hukuk asistanısın.",
  "Kullanıcının sorusunu cevaplamayacaksın; yalnızca aramayı iyileştireceksin. Yalnızca Türkçe yaz.",
  "1) terms: Sorunun konusunu yasa metinlerinde geçebilecek hukuki terimlerle anlatan 3-8 kısa Türkçe terim veya ifade",
  "   (ör. günlük dildeki 'işten atılmak' için 'hizmet akdinin feshi', 'bildirimsiz fesih').",
  "2) laws: Bu soruyu düzenleyen KKTC yasalarının kısa adları, en çok 2, en olasısı önce.",
  "   KKTC'de yasaların adı '... Yasası', tüzüklerin adı '... Tüzüğü' biçimindedir; 'Kanun', 'Kanunu', 'Yönetmelik', 'Kodeks' kullanılmaz.",
  "   Türkiye Cumhuriyeti'nin veya başka bir ülkenin kanunlarını yazma. Yasa numarası yazma.",
  "   Adı konuyu söyleyen 2-4 kelimeyle yaz (ör. 'Orman Yasası', 'Ticari Sicil Yasası', 'Hayvan Sağlığı Yasası').",
  "   Emin değilsen laws boş liste olsun: yanlış bir ad, boş listeden daha kötüdür.",
  'Yalnızca şu biçimde JSON döndür: {"terms": ["..."], "laws": ["..."]}',
].join("\n");

export type RewritePrompt = "v1" | "v2";
export const REWRITE_PROMPTS: Record<RewritePrompt, string> = { v1: PROMPT_V1, v2: PROMPT_V2 };
export const DEFAULT_REWRITE_PROMPT: RewritePrompt = "v1";
/** The default prompt (kept for callers that predate versions). */
export const REWRITE_INSTRUCTIONS = REWRITE_PROMPTS[DEFAULT_REWRITE_PROMPT];

/** Pulls {terms, laws} out of the model's text; null if it is not usable. */
export function parseRewrite(text: string): QueryRewrite | null {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return null;
  let data: unknown;
  try {
    data = JSON.parse(match[0]);
  } catch {
    return null;
  }
  const list = (value: unknown, max: number) =>
    (Array.isArray(value) ? value : [])
      .filter((v): v is string => typeof v === "string")
      // Letters, digits and spaces only: the terms go into FTS expressions.
      .map((v) => v.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim())
      .filter((v) => v.length >= 2 && v.length <= 80)
      .slice(0, max);
  const result = { terms: list((data as { terms?: unknown }).terms, 8), laws: list((data as { laws?: unknown }).laws, 3) };
  return result.terms.length || result.laws.length ? result : null;
}

const GENERIC = new Set([
  "yasa", "yasasi", "yasalari", "tuzuk", "tuzugu", "sayili", "ve", "ile", "bolum", "fasil",
  "kktc", "kuzey", "kibris", "turk", "cumhuriyeti", "hakkinda", "iliskin", "kanun", "kanunu",
]);

/** Common abbreviations in questions and LLM names (general, not eval-specific). */
const ABBREVIATIONS: [RegExp, string][] = [
  [/\bkdv\b/g, "katma deger vergisi"],
  [/\bcmuy\b/g, "ceza muhakemeleri usulu"],
  [/\bhmuy\b/g, "hukuk muhakemeleri usulu"],
];

function expand(folded: string): string {
  return ABBREVIATIONS.reduce((text, [re, full]) => text.replace(re, full), folded);
}

function words(text: string): string[] {
  return expand(foldTr(text))
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2 && !GENERIC.has(w) && !/^\d+$/.test(w));
}

const isRegulation = (folded: string) => /\btuzu/.test(folded);

/**
 * Statute ids for the LLM's names, matched on word-prefixes of the titles:
 * "Tüketicinin Korunması Yasası" finds "Tüketicileri Koruma Yasası", and one
 * wrong word is tolerated in longer names.
 * A law outranks a regulation (tüzük) unless the name says tüzük; amendment
 * laws only when the name asks for one; shorter titles win ties.
 */
export function resolveLawsDetailed(
  titles: { id: string; title: string }[],
  names: string[],
  perName = 1,
): { id: string; strong: boolean }[] {
  const out: { id: string; strong: boolean }[] = [];
  for (const name of names) {
    const nameWords = words(name);
    const stems = nameWords.map((w) => w.slice(0, Math.min(4, w.length)));
    if (!stems.length) continue;
    const foldedName = foldTr(name);
    const wantsAmendment = /degisiklik/.test(foldedName);
    const wantsRegulation = isRegulation(foldedName);
    const best: { id: string; score: number; len: number; strong: boolean }[] = [];
    for (const { id, title } of titles) {
      const folded = foldTr(title);
      if (!wantsAmendment && /degisiklik/.test(folded)) continue;
      const titleWords = words(title);
      const found = stems.filter((stem) => titleWords.some((w) => w.startsWith(stem))).length;
      // The name's first word (its subject: "Hayvan", "Kira") must be there.
      if (!titleWords.some((w) => w.startsWith(stems[0]))) continue;
      // One wrong word only in names of three or more words: in two-word names
      // it matched unrelated laws ("Karayolları Trafik" -> "Karasuları").
      const needed = stems.length >= 3 ? stems.length - 1 : stems.length;
      if (found < needed || titleWords.length > stems.length + 4) continue;
      const exact = nameWords.filter((w) => titleWords.includes(w)).length;
      // The document type decides, not only the title: a mahkemeler regulation
      // is titled "Katma Değer Vergisi Yasası" (tuzuk-201-2020) and tied with
      // the law itself (11 Nov 2026).
      const regulation = isRegulation(folded) || id.startsWith("tuzuk-");
      const kind = regulation === wantsRegulation ? 0.5 : 0;
      // Strong: every word of the name is in the title and the title adds at
      // most two words ("Kira (Denetim) Yasası" for "Kira Yasası"). One-word
      // overlaps ("Hayvan Koruma Kanunu" -> "Abone ve Tüketici Hakları") are weak.
      const strong = found === stems.length && titleWords.length <= stems.length + 2;
      best.push({ id, score: found + 0.3 * exact + kind - 0.1 * Math.max(0, titleWords.length - found), len: folded.length, strong });
    }
    best.sort((a, b) => b.score - a.score || a.len - b.len);
    for (const hit of best.slice(0, perName)) if (!out.some((o) => o.id === hit.id)) out.push({ id: hit.id, strong: hit.strong });
  }
  return out;
}

export function resolveLaws(titles: { id: string; title: string }[], names: string[], perName = 1): string[] {
  return resolveLawsDetailed(titles, names, perName).map((hit) => hit.id);
}
