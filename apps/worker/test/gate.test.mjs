import test from "node:test";
import assert from "node:assert/strict";
import { fallbackLimit, MinuteWindow, passGate, resetGateCache } from "../src/gate.ts";

const broken = { idFromName: () => "x", get: () => ({ fetch: async () => { throw new Error("DO down"); } }) };

test("when the Durable Object is unreachable, each isolate counts at a quarter of the limit", async () => {
  resetGateCache();
  const now = Date.UTC(2026, 10, 11, 7, 0, 5);
  const limit = 50;
  const results = [];
  for (let i = 0; i < 20; i++) results.push(await passGate(broken, limit, now));
  assert.equal(fallbackLimit(limit), 12);
  assert.equal(results.filter((r) => r.allowed).length, 12);
  assert.ok(results.at(-1).retryAfter > 0);
});

test("the fallback never drops below 5 a minute", () => {
  assert.equal(fallbackLimit(8), 5);
});

test("without a gate binding everything passes (Node and tests)", async () => {
  resetGateCache();
  assert.equal((await passGate(undefined, 1)).allowed, true);
});

test("MinuteWindow resets each minute", () => {
  const w = new MinuteWindow();
  const t = Date.UTC(2026, 10, 11, 7, 0, 0);
  assert.equal(w.take(1, t).allowed, true);
  assert.equal(w.take(1, t + 1000).allowed, false);
  assert.equal(w.take(1, t + 61_000).allowed, true);
});
