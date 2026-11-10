// Citations are built from metadata so nobody composes law or case numbers by hand.
import test from "node:test";
import assert from "node:assert/strict";
import { buildCitation } from "../.test-build/citation.js";

const doc = (o) => ({ type: "yasa", title: "", number: null, year: null, date: null, court: null, extra: null, ...o });

test("law with number and year", () => {
  assert.equal(buildCitation(doc({ title: "İş Yasası", number: "22", year: 1992 })), "İş Yasası (22/1992 sayılı)");
});

test("number already in the title is not repeated", () => {
  assert.equal(buildCitation(doc({ title: "Fasıl 154 Ceza Yasası", number: "154" })), "Fasıl 154 Ceza Yasası");
});

test("number that already carries the year", () => {
  assert.equal(buildCitation(doc({ title: "Kira Yasası", number: "17/1981", year: 1981 })), "Kira Yasası (17/1981)");
});

test("court decision: court, E., D., date", () => {
  const c = buildCitation(doc({ type: "karar", title: "x", court: "Yargıtay/Hukuk", date: "2021-03-14", extra: { enumara: 12, yile: 2019, dnumara: 5, yild: 2021 } }));
  assert.equal(c, "Yargıtay/Hukuk, E. 12/2019, D. 5/2021, 14.03.2021");
});
