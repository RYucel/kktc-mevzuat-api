import { foldTr } from "./text.js";
import type { Store } from "./types.js";

const LEGISLATION = ["yasa", "tuzuk", "anayasa", "yonetmelik", "emirname", "kararname", "andlasma"];
const TTL_MS = 10 * 60 * 1000;

export interface StatuteTitle {
  id: string;
  title: string;
  type: string;
  source: string;
  /** Readable name from the build (crawler/kktc/cards.py); empty for older builds. */
  display?: string;
  number?: string | null;
  text_status?: string;
}

let cache: { at: number; titles: StatuteTitle[]; superseded: Set<string> } | null = null;

async function load(store: Store) {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache;
  const rows = await store.all(
    `SELECT id, title, type, source, number, text_status, json_extract(extra_json, '$.display_title') AS display FROM documents WHERE type IN (${LEGISLATION.map(() => "?").join(",")})`,
    LEGISLATION,
  );
  const titles = rows.map((row) => ({
    id: String(row.id),
    title: String(row.title ?? ""),
    type: String(row.type ?? ""),
    source: String(row.source ?? ""),
    display: row.display ? String(row.display) : "",
    number: row.number ? String(row.number) : null,
    text_status: String(row.text_status ?? ""),
  }));
  cache = { at: now, titles, superseded: supersededCopies(titles) };
  return cache;
}

/** Titles of all statutes, cached per isolate for ten minutes (one small D1 read). */
export async function legislationTitles(store: Store): Promise<{ id: string; title: string }[]> {
  return (await load(store)).titles;
}

/** Statutes whose consolidated copy from mevzuat.gov.ct.tr is also in the database. */
export async function supersededStatutes(store: Store): Promise<Set<string>> {
  return (await load(store)).superseded;
}

/** "Mal ve Hizmetlerin Etiket, Tarife ve Fiyat Listeleri Tüzüğü" -> "mal ve hizmetlerin etiket tarife ve fiyat listeleri tuzugu". */
export function titleKey(title: string): string {
  return foldTr(title)
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^\p{L}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Amendment instruments ("... (Değişiklik) Tüzüğü"): their text only says which
 * articles of another statute change, so they never answer a question.
 */
export function isAmendment(title: string): boolean {
  return /degisiklik/.test(foldTr(title));
}

/**
 * mahkemeler.net copies of a statute whose consolidated text from
 * mevzuat.gov.ct.tr we also hold (same type and title). The mahkemeler copy is
 * the text as first published, without later amendments, and its article
 * numbers can differ: on 2026-11-10 "tuzuk-869 Madde 4" was quoted for the
 * consolidated regulation's Madde 9.
 */
export function supersededCopies(titles: StatuteTitle[]): Set<string> {
  const official = new Set(titles.filter((t) => t.source === "gov").map((t) => `${t.type}|${titleKey(t.title)}`));
  return new Set(
    titles
      .filter((t) => t.source !== "gov" && !isAmendment(t.title) && official.has(`${t.type}|${titleKey(t.title)}`))
      .map((t) => t.id),
  );
}

/**
 * Common names that are not in the titles (checked against each title).
 * Kept small and general: what people call these statutes, not eval wording.
 */
export const STATUTE_ALIASES: Record<string, string[]> = {
  "yasa-fasil-154": ["Ceza Yasası", "Ceza Kanunu", "Fasıl 154"],
  "yasa-fasil-155": ["Ceza Muhakemeleri Usulü Yasası", "CMUY", "Fasıl 155"],
  "yasa-fasil-6": ["Hukuk Muhakemeleri Usulü Yasası", "HMUY", "Fasıl 6"],
  "yasa-fasil-148": ["Haksız Fiiller Yasası", "Fasıl 148"],
  "yasa-fasil-149": ["Sözleşmeler Yasası", "Fasıl 149"],
  "yasa-fasil-113": ["Şirketler Yasası", "Fasıl 113"],
  "yasa-fasil-195": ["Miras Yasası", "Vasiyetnameler ve Veraset Yasası", "Fasıl 195"],
  "yasa-1-1998": ["Aile Yasası", "Evlenme ve Boşanma Yasası", "Aile Hukuku"],
  "yasa-22-1992": ["İş Yasası", "İş Kanunu"],
  "yasa-40-2003": ["Tüketici Yasası", "Tüketicinin Korunması Yasası"],
  "yasa-89-2007": ["Kişisel Veriler Yasası", "KVKK"],
  "yasa-17-1981": ["Kira Yasası"],
  "yasa-24-1982": ["Gelir Vergisi Yasası"],
  "yasa-47-1992": ["KDV Yasası", "Katma Değer Vergisi Yasası"],
  "yasa-16-1976": ["Sosyal Sigortalar Yasası"],
  "yasa-73-2007": ["Sosyal Güvenlik Yasası"],
  "yasa-7-1979": ["Kamu Görevlileri Yasası", "Memurlar Yasası"],
  "yasa-35-2010": ["Kat Mülkiyeti Yasası"],
  "yasa-43-1991": ["Ceza Puanı Yasası", "Trafik Cezaları Yasası"],
  "yasa-8-2013": ["Hayvan Refahı Yasası", "Hayvan Hakları Yasası"],
  "anayasa-kktc-anayasasi": ["Anayasa", "KKTC Anayasası"],
};

function nameWords(text: string): string[] {
  return foldTr(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2 && !["yasasi", "yasa", "tuzugu", "tuzuk", "kanunu", "kanun", "ve", "ile", "sayili", "kktc"].includes(w));
}

export interface StatuteHit {
  id: string;
  name: string;
  title: string;
  type: string;
  text_status: string;
}

/** Statutes whose name, readable name or common name matches (yasa_bul / GET /v1/statutes). */
export async function findStatutes(store: Store, name: string, limit = 10): Promise<StatuteHit[]> {
  const { titles, superseded } = await load(store);
  const words = nameWords(name);
  const number = name.match(/\b(\d{1,4})\s*\/\s*(\d{4})\b/);
  if (!words.length && !number) return [];
  const scored: { t: StatuteTitle; score: number }[] = [];
  for (const t of titles) {
    if (superseded.has(t.id) || isAmendment(t.title)) continue;
    if (number && t.number === `${Number(number[1])}/${number[2]}`) {
      scored.push({ t, score: 100 });
      continue;
    }
    let best = 0;
    for (const candidate of [t.title, t.display ?? "", ...(STATUTE_ALIASES[t.id] ?? [])]) {
      if (!candidate) continue;
      const cw = nameWords(candidate);
      const found = words.filter((w) => cw.some((c) => c.startsWith(w.slice(0, Math.min(5, w.length))))).length;
      if (!found) continue;
      const score = found / words.length - 0.02 * Math.max(0, cw.length - found) + (t.text_status === "metadata" ? -0.2 : 0);
      best = Math.max(best, score);
    }
    if (best >= 0.5) scored.push({ t, score: best });
  }
  return scored
    .sort((a, b) => b.score - a.score || (a.t.display || a.t.title).length - (b.t.display || b.t.title).length)
    .slice(0, limit)
    .map(({ t }) => ({ id: t.id, name: t.display || t.title, title: t.title, type: t.type, text_status: t.text_status ?? "" }));
}

/** Statutes with text, without amendments and superseded copies, by name (katalog / GET /v1/statutes). */
export async function statuteCatalog(store: Store, type?: string, page = 1, pageSize = 200): Promise<{ total: number; items: StatuteHit[] }> {
  const { titles, superseded } = await load(store);
  const all = titles
    .filter((t) => (!type || t.type === type) && t.text_status !== "metadata" && !superseded.has(t.id) && !isAmendment(t.title))
    .map((t) => ({ id: t.id, name: t.display || t.title, title: t.title, type: t.type, text_status: t.text_status ?? "" }))
    .sort((a, b) => a.name.localeCompare(b.name, "tr"));
  return { total: all.length, items: all.slice((page - 1) * pageSize, page * pageSize) };
}

/** Test hook. */
export function resetTitleCache(): void {
  cache = null;
}
