import assert from "node:assert/strict";
import test from "node:test";
import { clefNeurons, rerankInput } from "../.test-build/rerank.js";

test("clefNeurons: a usual 10-candidate call is a few neurons", () => {
  const text = "Kim ki önceden tasarlayarak bir başkasının ölümüne neden olursa ".repeat(8);
  const input = rerankInput("Taammüden adam öldürmenin cezası nedir?", Array.from({ length: 10 }, (_, i) => ({ label: `Ceza Yasası, Madde ${i + 1}`, text })));
  const n = clefNeurons(input);
  assert.ok(n > 3 && n < 10, `got ${n}`);
});

test("clefNeurons grows with the request", () => {
  const small = clefNeurons(rerankInput("soru", [{ label: "a", text: "x" }, { label: "b", text: "y" }]));
  const large = clefNeurons(rerankInput("soru", [{ label: "a", text: "x".repeat(400) }, { label: "b", text: "y".repeat(400) }]));
  assert.ok(large > small);
});

test("tocLabel: heading before the article number, or the first words", async () => {
  const { tocLabel } = await import("../.test-build/operations.js");
  assert.equal(tocLabel("Madde 203", "Taammüden Katil 203. Kim ki önceden tasarlayarak"), "Madde 203: Taammüden Katil");
  assert.equal(tocLabel("Madde 5", "Hizmet Akdinin Fes-hinde Bildirim 5.(1) İşveren"), "Madde 5: Hizmet Akdinin Feshinde Bildirim");
  assert.match(tocLabel("Madde 7", "7. (1) Bu Yasa kuralları uyarınca kurulan Kurul"), /^Madde 7: 7\. \(1\) Bu Yasa/);
});

test("parseAsk reads noul answers in the shapes seen", async () => {
  const { parseAsk, askInput } = await import("../.test-build/rerank.js");
  assert.deepEqual(parseAsk({ answers: { answers: { type: "noul", noul: 0.9 }, refers: { probability: 0.2 } } }, ["answers", "refers"]), { answers: 0.9, refers: 0.2 });
  assert.deepEqual(parseAsk({ answers: { answers: { probabilities: { yes: 0.3, no: 0.7 } } } }, ["answers"]), { answers: 0.3 });
  assert.equal(parseAsk({}, ["answers"]), null);
  const input = askInput({ soru: "s" }, { answers: "q?" });
  assert.equal(input.questions.answers.type, "noul");
});

test("sourceLine: name, article, currency, source", async () => {
  const { sourceLine } = await import("../.test-build/operations.js");
  assert.equal(
    sourceLine("İş Yasası (22/1992)", "Madde 43", { source: "gov", consolidated_through: "25/2026", text_status: "full" }),
    "İş Yasası (22/1992) m.43, 25/2026 sayılı değişikliğe kadar birleştirilmiş metin, mevzuat.gov.ct.tr",
  );
  assert.equal(
    sourceLine("Ceza Yasası (Fasıl 154)", "Madde 14 (2/3)", { source: "mahkemeler", consolidated_through: null, text_status: "partial" }),
    "Ceza Yasası (Fasıl 154) m.14, güncelliği kaynakta belirtilmemiş metin, kısmi metin, mevzuat.mahkemeler.net",
  );
});
