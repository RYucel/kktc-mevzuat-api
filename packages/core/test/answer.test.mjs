// Pure parts of /v1/answer: confidence labels and the law-before-regulation rule.
import test from "node:test";
import assert from "node:assert/strict";
import { asksRegulation, capRegulation, lawsBeforeRegulations, rerankConfidence } from "../.test-build/operations.js";

test("rerankConfidence: none at or above top is low", () => {
  assert.equal(rerankConfidence(0.9, 0.9), "low");
  assert.equal(rerankConfidence(0.4, 0.5), "low");
});

test("rerankConfidence thresholds", () => {
  assert.equal(rerankConfidence(0.7, 0), "high");
  assert.equal(rerankConfidence(0.69, 0), "medium");
  assert.equal(rerankConfidence(0.35, 0), "medium");
  assert.equal(rerankConfidence(0.34, 0), "low");
});

test("a regulation quoted for a general question is at most medium", () => {
  assert.equal(capRegulation("high", true), "medium");
  assert.equal(capRegulation("medium", true), "medium");
  assert.equal(capRegulation("low", true), "low");
  assert.equal(capRegulation("high", false), "high");
});

test("asksRegulation: tüzük / yönetmelik / usul ve esas, any case", () => {
  assert.equal(asksRegulation("Vardiya tüzüğü ne diyor?"), true);
  assert.equal(asksRegulation("TÜZÜK"), true);
  assert.equal(asksRegulation("Yönetmelikte izin süresi"), true);
  assert.equal(asksRegulation("Kiralama usul ve esasları"), true);
  assert.equal(asksRegulation("Bir haftada en fazla kaç saat çalıştırılabilirim?"), false);
});

test("lawsBeforeRegulations keeps each group's order (9 Nov regression: shift regulation over İş Yasası)", () => {
  const c = (id, type) => ({ id, result: { type } });
  const out = lawsBeforeRegulations([c("t1", "tuzuk"), c("y1", "yasa"), c("t2", "tuzuk"), c("a1", "anayasa"), c("y2", "yasa")]);
  assert.deepEqual(out.map((x) => x.id), ["y1", "a1", "y2", "t1", "t2"]);
});

import { capConfidence, rewriteDisagrees } from "../.test-build/operations.js";

test("any cap lowers high to medium only", () => {
  assert.equal(capConfidence("high", ["rewrite_disagrees"]), "medium");
  assert.equal(capConfidence("high", []), "high");
  assert.equal(capConfidence("low", ["regulation"]), "low");
});

test("rewriteDisagrees: only when the rewrite resolved statutes and the answer is from none (10 Nov: KDV -> KDV İadesi)", () => {
  const info = (documents, error) => ({ terms: [], laws: [], documents, ...(error ? { error } : {}) });
  assert.equal(rewriteDisagrees(info(["yasa-47-1992"]), "yasa-31-1996"), true);
  assert.equal(rewriteDisagrees(info(["yasa-47-1992", "yasa-31-1996"]), "yasa-31-1996"), false);
  assert.equal(rewriteDisagrees(info([]), "yasa-31-1996"), false);
  assert.equal(rewriteDisagrees(info(["yasa-47-1992"], "unavailable"), "yasa-31-1996"), false);
  assert.equal(rewriteDisagrees(undefined, "yasa-31-1996"), false);
});

import { asksDefinition, isBoilerplate } from "../.test-build/operations.js";

test("preamble, short title and definitions are boilerplate", () => {
  assert.equal(isBoilerplate("Başlangıç", "KAT MÜLKİYETİ VE KAT İRTİFAKI TÜZÜĞÜ ..."), true);
  assert.equal(isBoilerplate("Madde 2", "Tefsir 2. Bu Yasada metin başka türlü gerektirmedikçe; “Bakan” ..."), true);
  assert.equal(isBoilerplate("Madde 2", "Genel Kurallar Tefsir 2. Bu Tüzükte ..."), true);
  assert.equal(isBoilerplate("Madde 1", "Kısa İsim 1. Bu Yasa, İş Yasası olarak isimlendirilir."), true);
  assert.equal(isBoilerplate("Madde 11", "Deneme Süresi 11. Hizmet akitlerinde, deneme süresi en çok üç aydır."), false);
});

test("definition questions keep the definitions article", () => {
  assert.equal(asksDefinition("Kat malikleri kurulu ne demek?"), true);
  assert.equal(asksDefinition("İşçi kime denir?"), true);
  assert.equal(asksDefinition("Kat malikleri yılda kaç kez toplanır?"), false);
});

import { foreignJurisdiction } from "../.test-build/operations.js";

test("questions about another country's law", () => {
  for (const q of [
    "Türkiye'de bedelli askerlik ücreti ne kadar?",
    "Almanya'da oturma izni nasıl alınır?",
    "ABD'de yeşil kart nasıl alınır?",
    "İngiltere'de boşanma davası kaç ay sürer?",
    "Güney Kıbrıs'ta şirket nasıl kurulur?",
    "Avrupa Birliği'nde veri koruma kuralları",
  ]) assert.equal(foreignJurisdiction(q), true, q);
  for (const q of [
    "KKTC'de evlenmek için en az kaç yaşında olmak gerekir?",
    "Türkiye'den gelen işçi çalışma izni alır mı?",
    "Türkiye vatandaşı KKTC'de ev alabilir mi?",
    "Bir haftada en fazla kaç saat çalıştırılabilirim?",
    "Almanya'da yaşayan bir KKTC yurttaşı askerlik yapmak zorunda mı?",
    "Kıbrıs'ta kira artışı nasıl yapılır?",
  ]) assert.equal(foreignJurisdiction(q), false, q);
});

import { assertQueryLength, MAX_QUERY_CHARS } from "../.test-build/operations.js";

test("questions over the length cap are rejected with 400", () => {
  assert.doesNotThrow(() => assertQueryLength("x".repeat(MAX_QUERY_CHARS)));
  assert.throws(() => assertQueryLength("x".repeat(MAX_QUERY_CHARS + 1)), (e) => e.status === 400 && e.code === "query_too_long");
});
