import assert from "node:assert/strict";
import test from "node:test";
import { parseQuestions } from "../src/questions.ts";

test("questions: letter labels go to their article, references to the text are dropped", () => {
  const out = parseQuestions(
    [
      "A: Kiracı kirayı geç öderse ev sahibi onu çıkarabilir mi?",
      "A: Bu madde neyi düzenler?",
      "B) Mahkeme kararı olmadan gözaltı ne kadar sürebilir?",
      "C: Madde 5'e göre ceza nedir?",
      "B: kısa?",
      "çöp satır",
      "A: Kiracı kirayı geç öderse ev sahibi onu çıkarabilir mi?",
    ].join("\n"),
    3,
  );
  assert.deepEqual(out, [
    ["Kiracı kirayı geç öderse ev sahibi onu çıkarabilir mi?"],
    ["Mahkeme kararı olmadan gözaltı ne kadar sürebilir?"],
    [],
  ]);
});

test("questions: article numbers as labels are assigned by order, blank lines split equal numbers", () => {
  const out = parseQuestions(
    [
      "15: Ölüm cezası hangi durumlarda verilebilir mi acaba?",
      "15: İdam cezası kaldırıldı mı, hâlâ uygulanıyor mu?",
      "",
      "12: Mal bildirimleri kimin dosyasında tutulur?",
      "",
      "12: Cezaevi görevlisi disiplin cezası alırsa ne olur?",
      "13: Belediye sokak lambalarını yakmak zorunda mı?",
    ].join("\n"),
    4,
  );
  assert.equal(out[0].length, 2);
  assert.deepEqual(out[1], ["Mal bildirimleri kimin dosyasında tutulur?"]);
  assert.deepEqual(out[2], ["Cezaevi görevlisi disiplin cezası alırsa ne olur?"]);
  assert.deepEqual(out[3], ["Belediye sokak lambalarını yakmak zorunda mı?"]);
});
