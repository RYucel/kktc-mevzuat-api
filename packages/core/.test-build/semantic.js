/**
 * Semantic (embedding) retrieval for legislation articles.
 *
 * One vector per article ("Madde 12", parts joined), embedded with
 * Qwen3-Embedding-0.6B on Workers AI and truncated to SEMANTIC_DIMS with
 * Matryoshka (MRL): the first k dimensions of a Qwen3 embedding are a valid
 * k-dimensional embedding once re-normalised. 192 dimensions keep ~22k
 * articles inside the Vectorize free tier (5M stored dimensions).
 *
 * The runtime supplies the actual embedding/vector calls (Cloudflare bindings
 * in the Worker). Without them, search stays lexical.
 */
export const SEMANTIC_MODEL = "@cf/qwen/qwen3-embedding-0.6b";
export const SEMANTIC_DIMS = 192;
/** Qwen3 embeddings take a task instruction on the query side only. */
export const QUERY_INSTRUCTION = "Given a legal question in Turkish, retrieve the statute article from Northern Cyprus legislation that answers it";
export function queryText(question) {
    return `Instruct: ${QUERY_INSTRUCTION}\nQuery:${question.trim()}`;
}
/** First ``dims`` components, L2-normalised (MRL truncation). */
export function truncateEmbedding(vector, dims = SEMANTIC_DIMS) {
    if (vector.length < dims) {
        throw new Error(`Embedding has ${vector.length} dimensions, expected at least ${dims}.`);
    }
    const head = vector.slice(0, dims);
    const norm = Math.sqrt(head.reduce((sum, value) => sum + value * value, 0)) || 1;
    return head.map((value) => value / norm);
}
/**
 * Whether a query should go to the vector index. Law/case numbers, article
 * references and quoted phrases are exact lookups that BM25 already answers.
 */
export function wantsSemantic(query, mode) {
    if (mode === "phrase")
        return false;
    const trimmed = query.trim();
    if (trimmed.includes('"'))
        return false;
    if (/^(?:madde\s*)?\d{1,4}\s*[/-]?\s*\d{0,4}[a-z]?$/i.test(trimmed))
        return false;
    if (/^(?:e|d|k)\.?\s*\d{1,5}\s*\/\s*\d{2,4}$/i.test(trimmed))
        return false;
    return trimmed.split(/\s+/).filter(Boolean).length >= 2;
}
/** Reciprocal rank fusion of ranked id lists. */
export function reciprocalRankFusion(lists, k = 60) {
    const scores = new Map();
    for (const list of lists) {
        list.forEach((id, index) => {
            scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
        });
    }
    return scores;
}
