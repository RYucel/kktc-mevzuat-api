import test from "node:test";
import assert from "node:assert/strict";
import { buildSearchSql } from "../.test-build/sql.js";

const params = (o = {}) => ({ q: "x", mode: "all", limit: 5, offset: 0, ...o });

test("statute_first ranks regulations at half weight", () => {
  assert.match(buildSearchSql("x", params({ statute_first: true })).sql, /d\.type = 'tuzuk' THEN 0\.5/);
  assert.doesNotMatch(buildSearchSql("x", params()).sql, /d\.type = 'tuzuk' THEN 0\.5/);
});

test("skip_amendments ranks amendment instruments at a tenth", () => {
  assert.match(buildSearchSql("x", params({ skip_amendments: true })).sql, /title_norm LIKE '%degisiklik%' THEN 0\.1/);
  assert.doesNotMatch(buildSearchSql("x", params()).sql, /degisiklik/);
});
