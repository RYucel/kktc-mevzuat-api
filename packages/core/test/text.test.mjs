// Text helpers that decide what Clef reads and what the user is shown.
import test from "node:test";
import assert from "node:assert/strict";
import { clefPassage, foldTr, makeSnippet, stemCoverage } from "../.test-build/text.js";

const filler = (n) => Array.from({ length: n }, (_, i) => `kelime${i}`).join(" ");

test("foldTr folds Turkish letters", () => {
  assert.equal(foldTr("Şirketler İşçi Ğüöç"), "sirketler isci guoc");
});

test("clefPassage returns short articles unchanged", () => {
  assert.equal(clefPassage("Madde 1. Kısa metin.", "kısa"), "Madde 1. Kısa metin.");
});

test("clefPassage keeps the heading and shows the window with the question's words", () => {
  const text = `Madde 26. Mal paylaşımı. ${filler(80)} Eşlerden her biri katkı payı alacağı hakkına sahiptir. ${filler(40)}`;
  const out = clefPassage(text, "eşlerin katkı payı alacağı");
  assert.ok(out.startsWith("Madde 26. Mal paylaşımı."), out);
  assert.ok(out.includes("katkı payı alacağı"), out);
  assert.ok(out.length <= 430, String(out.length));
});

test("clefPassage keeps the fraction in rate questions (PR #38 regression)", () => {
  const text = `Madde 26. Mal paylaşımı. ${filler(80)} Eşin payı malın 2/3'ünden fazla olamaz. ${filler(40)}`;
  assert.ok(clefPassage(text, "mal paylaşımında eşlere düşen en az oran").includes("2/3"));
});

test("makeSnippet shows the fraction for 'en az oran' questions", () => {
  const text = `${filler(100)} pay 2/3'ünden fazla olamaz ${filler(100)}`;
  const out = makeSnippet(text, "eşlere düşen en az oran nedir");
  assert.ok(out.includes("2/3"), out);
  assert.ok(out.startsWith("…") && out.endsWith("…"));
});

test("makeSnippet returns short text whole", () => {
  assert.equal(makeSnippet("  kısa   metin ", "metin"), "kısa metin");
});

test("stemCoverage counts the question's stems found in the passage", () => {
  const c = stemCoverage("İşçi yıllık ücretli izin hakkına sahiptir", "yıllık izin kaç gün");
  assert.ok(c.found >= 2 && c.total >= c.found, JSON.stringify(c));
});
