import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CATEGORIES } from "../.test-build/categories.js";
import { categoryDocuments, categoryCounts, documentCategories, resetTitleCache, statuteCatalog } from "../.test-build/titles.js";
import { capConfidence } from "../.test-build/operations.js";

test("the category list matches categories/categories.json", () => {
  const file = JSON.parse(readFileSync(new URL("../../../categories/categories.json", import.meta.url), "utf8"));
  assert.deepEqual(CATEGORIES.map((c) => ({ ...c })), file);
});

test("categories come from extra_json and filter the catalog", async () => {
  resetTitleCache();
  const rows = [
    { id: "yasa-22-1992", title: "İş Yasası", type: "yasa", source: "gov", text_status: "full", categories: '["is-sosyal-guvenlik"]' },
    { id: "yasa-fasil-154", title: "Ceza Yasası", type: "yasa", source: "gov", text_status: "full", categories: '["ceza"]' },
    { id: "tuzuk-is", title: "İş Tüzüğü", type: "tuzuk", source: "gov", text_status: "full", parent: "yasa-22-1992", categories: '["is-sosyal-guvenlik"]' },
    { id: "yasa-old", title: "Eski Yasa", type: "yasa", source: "gov", text_status: "full" },
  ];
  const store = { all: async () => rows, first: async () => null };
  assert.deepEqual([...(await categoryDocuments(store, "is-sosyal-guvenlik"))].sort(), ["tuzuk-is", "yasa-22-1992"]);
  assert.deepEqual(await documentCategories(store, "yasa-fasil-154"), ["ceza"]);
  assert.deepEqual(await documentCategories(store, "yasa-old"), []);
  const catalog = await statuteCatalog(store, undefined, 1, 200, "ceza");
  assert.deepEqual(catalog.items.map((i) => i.id), ["yasa-fasil-154"]);
  assert.deepEqual((await categoryCounts(store)).get("is-sosyal-guvenlik"), { yasa: 1, tuzuk: 1 });
  resetTitleCache();
});

test("outside_category caps high like any other cap", () => {
  assert.equal(capConfidence("high", ["outside_category"]), "medium");
  assert.equal(capConfidence("low", ["outside_category"]), "low");
});

test("GET /v1/categories lists the categories; an unknown category is a 400", async () => {
  const { createApp } = await import("../.test-build/app.js");
  resetTitleCache();
  const rows = [{ id: "yasa-fasil-154", title: "Ceza Yasası", type: "yasa", source: "gov", text_status: "full", categories: '["ceza"]' }];
  const store = { all: async () => rows, first: async () => null, run: async () => ({}) };
  const app = createApp({ store });
  const list = await (await app.request("/v1/categories")).json();
  assert.equal(list.categories.length, CATEGORIES.length);
  assert.deepEqual(list.categories.find((c) => c.id === "ceza").statutes, { yasa: 1 });
  const one = await (await app.request("/v1/categories?document_id=yasa-fasil-154")).json();
  assert.deepEqual(one.categories, ["ceza"]);
  const bad = await app.request("/v1/answer?q=nafaka&category=uzay");
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error?.code ?? "invalid_category", "invalid_category");
  resetTitleCache();
});
