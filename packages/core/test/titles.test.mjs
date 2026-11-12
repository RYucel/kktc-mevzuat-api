import test from "node:test";
import assert from "node:assert/strict";
import { isAmendment, supersededCopies, titleKey } from "../.test-build/titles.js";

test("titleKey ignores case, punctuation and parentheses", () => {
  assert.equal(titleKey("Mal ve Hizmetlerin Etiket, Tarife ve Fiyat Listeleri Tüzüğü"), titleKey("MAL VE HİZMETLERİN ETİKET TARİFE VE FİYAT LİSTELERİ TÜZÜĞÜ"));
});

test("isAmendment", () => {
  assert.equal(isAmendment("Kapalı Mevsimde Doğada Köpek Gezdirme (Değişiklik) Tüzüğü"), true);
  assert.equal(isAmendment("KAT MÜLKİYETİ VE KAT İRTİFAKI TÜZÜĞÜ"), false);
});

test("a mahkemeler copy is superseded by the gov copy of the same statute (10 Nov: tuzuk-869)", () => {
  const titles = [
    { id: "tuzuk-mal-ve-hizmetlerin", title: "MAL VE HİZMETLERİN ETİKET, TARİFE VE FİYAT LİSTELERİ TÜZÜĞÜ", type: "tuzuk", source: "gov" },
    { id: "tuzuk-869", title: "Mal ve Hizmetlerin Etiket Tarife ve Fiyat Listeleri Tüzüğü", type: "tuzuk", source: "mahkemeler" },
    { id: "tuzuk-954-2024", title: "Mal ve Hizmetlerin Etiket Tarife ve Fiyat Listeleri (Değişiklik) Tüzüğü", type: "tuzuk", source: "mahkemeler" },
    { id: "tuzuk-other", title: "Başka Bir Tüzük", type: "tuzuk", source: "mahkemeler" },
    { id: "yasa-x", title: "Mal ve Hizmetlerin Etiket Tarife ve Fiyat Listeleri Tüzüğü", type: "yasa", source: "mahkemeler" },
  ];
  assert.deepEqual([...supersededCopies(titles)], ["tuzuk-869"]);
});

test("regulationsOf and parentLaw use the parent_law of the build", async () => {
  const { regulationsOf, parentLaw, resetTitleCache } = await import("../.test-build/titles.js");
  resetTitleCache?.();
  const rows = [
    { id: "yasa-fasil-352", title: "BÖLÜM 352 ÇOCUKLAR YASASI", type: "yasa", source: "gov", display: "Çocuklar Yasası (Fasıl 352)", text_status: "full" },
    { id: "tuzuk-koruyucu-aile-tuzugu", title: "Koruyucu Aile Tüzüğü", type: "tuzuk", source: "gov", text_status: "full", parent: "yasa-fasil-352" },
    { id: "tuzuk-x-degisiklik", title: "Koruyucu Aile (Değişiklik) Tüzüğü", type: "tuzuk", source: "gov", text_status: "full", parent: "yasa-fasil-352" },
  ];
  const store = { all: async () => rows, first: async () => null };
  const regs = await regulationsOf(store, "yasa-fasil-352");
  assert.deepEqual(regs.map((r) => r.id), ["tuzuk-koruyucu-aile-tuzugu"]);
  assert.deepEqual(await parentLaw(store, "tuzuk-koruyucu-aile-tuzugu"), { id: "yasa-fasil-352", title: "Çocuklar Yasası (Fasıl 352)" });
  resetTitleCache?.();
});
