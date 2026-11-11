import test from "node:test";
import assert from "node:assert/strict";
import { findStatutes, resetTitleCache, statuteCatalog } from "../.test-build/titles.js";

const rows = [
  { id: "yasa-fasil-154", title: "BÖLÜM 154 CEZA YASASI", type: "yasa", source: "gov", number: "Fasıl 154", text_status: "full", display: "Ceza Yasası (Fasıl 154)" },
  { id: "yasa-22-1992", title: "İş Yasası", type: "yasa", source: "mahkemeler", number: "22/1992", text_status: "full", display: "İş Yasası (22/1992)" },
  { id: "yasa-44-2007", title: "Basın İş Yasası", type: "yasa", source: "mahkemeler", number: "44/2007", text_status: "full", display: "Basın İş Yasası (44/2007)" },
  { id: "yasa-1-1998", title: "1/1998 SAYILI AİLE (EVLENME VE BOŞANMA) YASASI", type: "yasa", source: "gov", number: "1/1998", text_status: "full", display: "Aile (Evlenme ve Boşanma) Yasası (1/1998)" },
  { id: "yasa-9-2020", title: "İş (Değişiklik) Yasası", type: "yasa", source: "mahkemeler", number: "9/2020", text_status: "full", display: "" },
  { id: "tuzuk-x", title: "Örnek Tüzüğü", type: "tuzuk", source: "mahkemeler", number: null, text_status: "metadata", display: "" },
];
const store = { all: async () => rows };

test("findStatutes by name, common name and number; amendments left out", async () => {
  resetTitleCache();
  assert.equal((await findStatutes(store, "Ceza Kanunu"))[0].id, "yasa-fasil-154");
  assert.equal((await findStatutes(store, "Aile Yasası"))[0].id, "yasa-1-1998");
  assert.equal((await findStatutes(store, "22/1992"))[0].id, "yasa-22-1992");
  const is = await findStatutes(store, "İş Yasası");
  assert.equal(is[0].id, "yasa-22-1992");
  assert.ok(!is.some((h) => h.id === "yasa-9-2020"));
});

test("catalog lists statutes with text, sorted by readable name", async () => {
  resetTitleCache();
  const { total, items } = await statuteCatalog(store, "yasa");
  assert.equal(total, 4);
  assert.deepEqual(items.map((i) => i.id), ["yasa-1-1998", "yasa-44-2007", "yasa-fasil-154", "yasa-22-1992"]);
});
