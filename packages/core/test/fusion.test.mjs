import assert from "node:assert/strict";
import test from "node:test";
import { reciprocalRankFusion } from "../.test-build/semantic.js";

test("rank fusion: equal weights by default, a channel weight moves its order up", () => {
  const lexical = ["a", "b"];
  const vector = ["b", "a"];
  const plain = reciprocalRankFusion([lexical, vector]);
  assert.equal(plain.get("a"), plain.get("b"));
  const weighted = reciprocalRankFusion([lexical, vector], 60, [1, 2]);
  assert.ok(weighted.get("b") > weighted.get("a"));
  assert.equal(weighted.get("a"), 1 / 61 + 2 / 62);
});
