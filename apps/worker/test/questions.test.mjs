import assert from "node:assert/strict";
import test from "node:test";
import { parseQuestions } from "../src/questions.ts";

test("questions: numbered lines go to their article, references to the text are dropped", () => {
  const out = parseQuestions(
    [
      "1: Kiracı kirayı geç öderse ev sahibi onu çıkarabilir mi?",
      "1: Bu madde neyi düzenler?",
      "2) Mahkeme kararı olmadan gözaltı ne kadar sürebilir?",
      "3: Madde 5'e göre ceza nedir?",
      "2: kısa?",
      "çöp satır",
      "1: Kiracı kirayı geç öderse ev sahibi onu çıkarabilir mi?",
    ].join("\n"),
    3,
  );
  assert.deepEqual(out, [
    ["Kiracı kirayı geç öderse ev sahibi onu çıkarabilir mi?"],
    ["Mahkeme kararı olmadan gözaltı ne kadar sürebilir?"],
    [],
  ]);
});
