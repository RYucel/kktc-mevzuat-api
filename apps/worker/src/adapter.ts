/**
 * Query adapter (OPUS-GOREVLER-5, after item 6): a 192x192 linear map applied
 * to the query embedding before the article-index lookup, trained offline on
 * the synthetic (question, article) pairs (scripts/train_adapter.py). The
 * article vectors stay as they are; only the query moves.
 *
 * Admin endpoints feed the training job:
 *   POST /admin/embed-queries {texts}  -> query embeddings (192 dims, as searched)
 *   POST /admin/vectors/get   {ids}    -> stored article vectors
 */
import { queryText, truncateEmbedding } from "@kktc/core";

export const ADAPTER_DIMS = 192;

/** y = W x, L2-normalised (cosine index: only the direction matters). */
export function applyAdapter(vector: number[], w: number[][]): number[] {
  const out = new Array<number>(w.length).fill(0);
  for (let i = 0; i < w.length; i++) {
    const row = w[i];
    let s = 0;
    for (let j = 0; j < row.length; j++) s += row[j] * vector[j];
    out[i] = s;
  }
  const norm = Math.sqrt(out.reduce((a, v) => a + v * v, 0)) || 1;
  return out.map((v) => v / norm);
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

const round = (v: number[]) => v.map((x) => Math.round(x * 1e5) / 1e5);

export async function handleEmbedQueries(
  request: Request,
  embedFull: (texts: string[]) => Promise<number[][]>,
  allow: () => Promise<boolean>,
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { texts?: unknown } | null;
  const texts = Array.isArray(body?.texts) ? body!.texts.filter((t): t is string => typeof t === "string" && !!t.trim()) : [];
  if (!texts.length || texts.length > 64) return json({ error: "invalid_texts", message: "texts: 1-64" }, 400);
  if (!(await allow())) return json({ error: "limit", message: "daily embed limit reached" }, 429);
  try {
    const full = await embedFull(texts.map((t) => queryText(t.slice(0, 1000))));
    return json({ vectors: full.map((v) => round(truncateEmbedding(v, ADAPTER_DIMS))) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: "model_error", message: message.slice(0, 300) }, /quota|neuron|limit|429/i.test(message) ? 429 : 502);
  }
}

export async function handleVectorGet(request: Request, index: Vectorize | undefined): Promise<Response> {
  if (!index) return json({ error: "vectors_unavailable" }, 501);
  const body = (await request.json().catch(() => null)) as { ids?: unknown } | null;
  const ids = Array.isArray(body?.ids) ? body!.ids.filter((t): t is string => typeof t === "string") : [];
  if (!ids.length || ids.length > 20) return json({ error: "invalid_ids", message: "ids: 1-20" }, 400);
  const found = await index.getByIds(ids);
  return json({ vectors: found.map((v) => ({ id: v.id, values: round(Array.from(v.values as ArrayLike<number>)) })) });
}
