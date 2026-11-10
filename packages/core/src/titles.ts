import { foldTr } from "./text.js";
import type { Store } from "./types.js";

const LEGISLATION = ["yasa", "tuzuk", "anayasa", "yonetmelik", "emirname", "kararname", "andlasma"];
const TTL_MS = 10 * 60 * 1000;

export interface StatuteTitle {
  id: string;
  title: string;
  type: string;
  source: string;
}

let cache: { at: number; titles: StatuteTitle[]; superseded: Set<string> } | null = null;

async function load(store: Store) {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache;
  const rows = await store.all(
    `SELECT id, title, type, source FROM documents WHERE type IN (${LEGISLATION.map(() => "?").join(",")})`,
    LEGISLATION,
  );
  const titles = rows.map((row) => ({
    id: String(row.id),
    title: String(row.title ?? ""),
    type: String(row.type ?? ""),
    source: String(row.source ?? ""),
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
