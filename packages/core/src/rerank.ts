/**
 * Answer reranking with Cloudflare Clef (a fast decision model).
 *
 * Measured on 2026-11-04 (scripts/eval-clef.mjs, 71 questions, top 10 hybrid
 * candidates): for natural-language questions Clef-flash choosing among the
 * candidates in one call put the right statute first in 63% of cases against
 * 40% for hybrid ranking, and its probability was a far more honest
 * confidence. For short keyword queries it made ranking worse (100% -> 72%),
 * so it is used only for questions (see wantsRerank). Per-candidate yes/no
 * scoring and the 27B model were both worse than one Clef-flash choice call.
 *
 * The request below is the measured configuration; change it only together
 * with a new measurement.
 */

import { wantsSemantic } from "./semantic.js";

export const RERANK_MODEL = "clef-flash";
/** Candidates sent to Clef (the measured setting). */
export const RERANK_CANDIDATES = 10;
/**
 * Articles per document offered to Clef. Measured 2026-11-05 on 35
 * natural-language questions (scripts/eval-answer.mjs, live /v1/answer):
 *   passages=1: right article first 20.0%, in top 5 22.9%, "high" right 7/17
 *   passages=2: 45.7%, 45.7%, 13/19
 *   passages=3: 45.7%, 51.4%, 15/18 (all six "low" answers were wrong)
 * Right statute first stayed at 60% for all three; 3 costs ~0.2 s more.
 */
export const ANSWER_PASSAGES = 3;
const PASSAGE_CHARS = 420;

/** The runtime's daily Clef budget is used up; answers fall back to search order. */
export class RerankLimitError extends Error {
  constructor(message = "Clef daily limit reached") {
    super(message);
    this.name = "RerankLimitError";
  }
}

export interface RerankCandidate {
  label: string;
  text: string;
}

export interface RerankResult {
  model: string;
  /** Probability that each candidate is the passage that answers. */
  probabilities: number[];
  /** Probability that none of them answers. */
  none: number;
}

export interface RerankOptions {
  /** The choice question (default: which passage answers). */
  instructions?: string;
  /** Characters of each candidate's text shown (default PASSAGE_CHARS). */
  chars?: number;
  /** The "none" option's wording. */
  none?: string;
}

export interface Reranker {
  rerank(question: string, candidates: RerankCandidate[], options?: RerankOptions): Promise<RerankResult>;
}

/** Statute choice over statute cards (OPUS-GOREVLER-3 item 3). */
export const LAW_PICK_OPTIONS: RerankOptions = {
  instructions: "Bu soruyu hangi yasa ya da tüzük düzenler? Adına ve konu özetine göre en uygun olanı seç.",
  chars: 600,
  none: "Hiçbiri bu konuyu düzenlemiyor",
};

/** Runs one decision-model request (Workers AI binding in the Worker). */
export type DecideFn = (model: string, input: Record<string, unknown>) => Promise<unknown>;

const QUESTION_WORD =
  /(?:^|\s)(?:m[ıiuü](?:d[ıiuü]r|y[ıiuü]m|y[ıiuü]z|s[ıiuü]n(?:[ıiuü]z)?)?|nas[ıi]l|neden|ni[çc]in|hangi\w*|kim\w*|ka[çc]\w*|ne|nedir|nelerdir|nereye|nerede)(?=\s|$|[?.,])/i;

/**
 * Natural-language questions only. Keyword lookups ("nafaka", "kıdem
 * tazminatı") are already answered well by the canonical-statute ranking,
 * and Clef measurably hurt them.
 */
export function wantsRerank(query: string, mode?: string): boolean {
  if (!wantsSemantic(query, mode)) return false;
  const text = query.trim();
  const words = text.split(/\s+/).filter(Boolean).length;
  return words >= 4 || text.endsWith("?") || QUESTION_WORD.test(text.toLocaleLowerCase("tr"));
}

export function rerankInput(question: string, candidates: RerankCandidate[], options: RerankOptions = {}): Record<string, unknown> {
  const ids = candidates.map((_, i) => `c${i + 1}`);
  const criteria: Record<string, string> = Object.fromEntries(candidates.map((c, i) => [ids[i], c.label]));
  criteria.none = options.none ?? "Hiçbiri soruyu cevaplamıyor";
  const chars = options.chars ?? PASSAGE_CHARS;
  return {
    state: {
      soru: question.trim(),
      adaylar: candidates.map((c, i) => ({ id: ids[i], madde: c.label, metin: c.text.replace(/\s+/g, " ").trim().slice(0, chars) })),
    },
    questions: {
      pick: {
        type: "choice",
        instructions: options.instructions ?? "Bu adaylardan hangisi soruyu doğrudan cevaplayan yasa maddesidir?",
        criteria,
      },
    },
  };
}

/** Clef-flash price on Workers AI: neurons per million tokens. */
export const CLEF_NEURONS_PER_MTOK = 3455;
/** Tokens of the choice answer (one choice and its probabilities). */
const ANSWER_TOKENS = 40;

/** Estimated neurons of one Clef call: request characters / 3 as tokens, plus the answer. */
export function clefNeurons(input: Record<string, unknown>): number {
  const tokens = JSON.stringify(input).length / 3 + ANSWER_TOKENS;
  return (tokens * CLEF_NEURONS_PER_MTOK) / 1_000_000;
}

/** Workers AI shape: { answers: { pick: { type: "choice", choice, probabilities: { c1: 0.1, ..., none } } } }. */
export function parseRerank(output: unknown, count: number, model = RERANK_MODEL): RerankResult | null {
  const pick = (output as { answers?: { pick?: { probabilities?: Record<string, unknown> } } } | null)?.answers?.pick;
  const probs = pick?.probabilities;
  if (!probs || typeof probs !== "object") return null;
  const probabilities: number[] = [];
  for (let i = 1; i <= count; i++) {
    const value = Number(probs[`c${i}`] ?? 0);
    probabilities.push(Number.isFinite(value) ? value : 0);
  }
  const none = Number(probs.none ?? 0);
  if (probabilities.every((p) => p === 0) && !none) return null;
  return { model, probabilities, none: Number.isFinite(none) ? none : 0 };
}

export function clefReranker(decide: DecideFn, model = RERANK_MODEL): Reranker {
  return {
    async rerank(question, candidates, options) {
      const output = await decide(model, { model, ...rerankInput(question, candidates, options) });
      const result = parseRerank(output, candidates.length, model);
      if (!result) throw new Error("Clef yanıtı çözümlenemedi.");
      return result;
    },
  };
}
