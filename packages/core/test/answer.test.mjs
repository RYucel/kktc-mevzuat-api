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
