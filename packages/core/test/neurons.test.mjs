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
