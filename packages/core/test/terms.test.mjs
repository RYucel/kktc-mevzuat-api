import assert from "node:assert/strict";
import test from "node:test";
import { questionKeys, termKey } from "../.test-build/terms.js";

test("a question contains the key of a term in any order and with suffixes", () => {
  const key = termKey("mahkeme kararı olmadan gözaltı");
  assert.ok(questionKeys("Polis hangi durumlarda mahkeme kararı olmadan birini gözaltına alabilir?").includes(key));
});

test("keys match the Python side (crawler/kktc/terms.py)", () => {
  assert.equal(termKey("önceden planlayarak öldürme"), "oldu once plan");
  assert.equal(termKey("ve ile için"), "");
});
