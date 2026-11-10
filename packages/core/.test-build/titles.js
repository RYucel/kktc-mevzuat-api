const LEGISLATION = ["yasa", "tuzuk", "anayasa", "yonetmelik", "emirname", "kararname", "andlasma"];
const TTL_MS = 10 * 60 * 1000;
let cache = null;
/** Titles of all statutes, cached per isolate for ten minutes (one small D1 read). */
export async function legislationTitles(store) {
    const now = Date.now();
    if (cache && now - cache.at < TTL_MS)
        return cache.titles;
    const rows = await store.all(`SELECT id, title FROM documents WHERE type IN (${LEGISLATION.map(() => "?").join(",")})`, LEGISLATION);
    cache = { at: now, titles: rows.map((row) => ({ id: String(row.id), title: String(row.title ?? "") })) };
    return cache.titles;
}
