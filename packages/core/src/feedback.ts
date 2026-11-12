import { ApiError } from "./operations.js";
import type { FeedbackEntry, Store } from "./types.js";

/** Hash of the normalized question; the question text is never stored. */
export async function questionHash(question: string): Promise<string> {
  const normalized = question.toLocaleLowerCase("tr").replace(/\s+/g, " ").trim().replace(/[\s?.!,;:]+$/u, "");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Validates and records a verdict (OPUS-GOREVLER-4 item 14). */
export async function recordFeedback(
  store: Store,
  input: { soru?: unknown; document_id?: unknown; ref?: unknown; verdict?: unknown },
): Promise<{ ok: true }> {
  if (!store.feedback) throw new ApiError(501, "feedback_unavailable", "Geri bildirim bu sunucuda kapalı.");
  const soru = typeof input.soru === "string" ? input.soru.trim() : "";
  const documentId = typeof input.document_id === "string" ? input.document_id : "";
  const ref = typeof input.ref === "string" && input.ref.length <= 40 ? input.ref : null;
  const verdict = input.verdict === "dogru" || input.verdict === "doğru" ? "dogru" : input.verdict === "yanlis" || input.verdict === "yanlış" ? "yanlis" : null;
  if (!soru || soru.length > 500) throw new ApiError(400, "invalid_question", "soru 1-500 karakter olmalıdır.");
  if (!/^[a-z0-9][a-z0-9-]{1,120}$/.test(documentId)) throw new ApiError(400, "invalid_document_id", "document_id geçerli bir belge kimliği olmalıdır.");
  if (!verdict) throw new ApiError(400, "invalid_verdict", "verdict 'dogru' veya 'yanlis' olmalıdır.");
  const entry: FeedbackEntry = { q_hash: await questionHash(soru), document_id: documentId, ref, verdict };
  if (!(await store.feedback(entry))) throw new ApiError(429, "feedback_limit", "Günlük geri bildirim sınırı doldu.");
  return { ok: true };
}
