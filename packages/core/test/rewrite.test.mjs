// The LLM rewrite only feeds the search; its output must be sanitized and
// its statute names must resolve to the right documents.
import test from "node:test";
import assert from "node:assert/strict";
import { parseRewrite, resolveLaws } from "../.test-build/rewrite.js";

test("parseRewrite finds the JSON in surrounding text and strips FTS syntax", () => {
  const r = parseRewrite('Tamam: {"terms": ["hizmet akdinin feshi", "bildirim* \\"süresi\\"", "x"], "laws": ["İş Yasası"]} bitti');
  assert.deepEqual(r, { terms: ["hizmet akdinin feshi", "bildirim süresi"], laws: ["İş Yasası"] });
});

test("parseRewrite rejects unusable output", () => {
  assert.equal(parseRewrite("cevap yok"), null);
  assert.equal(parseRewrite("{bozuk json"), null);
  assert.equal(parseRewrite('{"terms": [], "laws": []}'), null);
});

test("parseRewrite caps terms at 8 and laws at 3", () => {
  const r = parseRewrite(JSON.stringify({ terms: Array.from({ length: 12 }, (_, i) => `terim ${i}`), laws: ["A Yasası", "B Yasası", "C Yasası", "D Yasası"] }));
  assert.equal(r.terms.length, 8);
  assert.equal(r.laws.length, 3);
});

const titles = [
  { id: "yasa-22-1992", title: "İş Yasası" },
  { id: "yasa-22-1992-deg", title: "İş (Değişiklik) Yasası" },
  { id: "tuzuk-is", title: "İş Tüzüğü" },
  { id: "yasa-40-2003", title: "Tüketicinin Korunması Yasası" },
  { id: "yasa-43-1991", title: "Karayolları Trafik Yasası" },
  { id: "yasa-karasulari", title: "Karasuları Yasası" },
];

test("resolveLaws prefers the law over its regulation and skips amendments", () => {
  assert.deepEqual(resolveLaws(titles, ["İş Yasası"]), ["yasa-22-1992"]);
});

test("resolveLaws picks the regulation when the name says tüzük", () => {
  assert.deepEqual(resolveLaws(titles, ["İş Tüzüğü"]), ["tuzuk-is"]);
});

test("resolveLaws returns an amendment only when asked", () => {
  assert.deepEqual(resolveLaws(titles, ["İş Değişiklik Yasası"]), ["yasa-22-1992-deg"]);
});

test("resolveLaws matches word prefixes ('Tüketicileri Koruma' -> 'Tüketicinin Korunması')", () => {
  assert.deepEqual(resolveLaws(titles, ["Tüketicileri Koruma Yasası"]), ["yasa-40-2003"]);
});

test("resolveLaws: a two-word name needs both words (no 'Karasuları' for 'Karayolları Trafik')", () => {
  assert.deepEqual(resolveLaws(titles, ["Karayolları Trafik Yasası"]), ["yasa-43-1991"]);
  assert.deepEqual(resolveLaws(titles, ["Karayolları Deniz Yasası"]), []);
});

import { resolveLawsDetailed, REWRITE_PROMPTS } from "../.test-build/rewrite.js";

const more = [
  ...titles,
  { id: "yasa-17-1981", title: "Kira (Denetim) Yasası" },
  { id: "yasa-47-1992", title: "Katma Değer Vergisi Yasası" },
  { id: "yasa-31-1996", title: "Katma Değer Vergisi İadesi Yasası" },
];

test("strong: every word of the name in a title that adds at most two words", () => {
  assert.deepEqual(resolveLawsDetailed(more, ["Kira Yasası"]), [{ id: "yasa-17-1981", strong: true }]);
  assert.deepEqual(resolveLawsDetailed(more, ["İş Kanunu"]), [{ id: "yasa-22-1992", strong: true }]);
});

test("KDV expands to katma değer vergisi and picks the main law", () => {
  assert.deepEqual(resolveLawsDetailed(more, ["KDV Yasası"]), [{ id: "yasa-47-1992", strong: true }]);
});

test("three-word names with one missing word resolve weakly", () => {
  const r = resolveLawsDetailed(more, ["Tüketicileri Koruma Hakları Yasası"]);
  assert.deepEqual(r, [{ id: "yasa-40-2003", strong: false }]);
});

test("v2 prompt tells the model how KKTC names statutes", () => {
  assert.match(REWRITE_PROMPTS.v2, /'Kanun'/);
  assert.match(REWRITE_PROMPTS.v2, /boş liste/);
  assert.equal(REWRITE_PROMPTS.v1.includes("Kanun'"), false);
});
