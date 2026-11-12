// End-to-end smoke test against a running API (Node or Worker).
//   npm run smoke
//   BASE=https://api.example.com npm run smoke
const base = (process.env.BASE ?? "http://localhost:8787").replace(/\/$/, "");
// Our own jobs send the admin token, so the Worker's per-client rate limit
// (30 requests a minute) does not apply to them.
if (process.env.ADMIN_TOKEN) {
  const plainFetch = globalThis.fetch;
  globalThis.fetch = (url, init = {}) =>
    plainFetch(url, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${process.env.ADMIN_TOKEN}` } });
}
let failures = 0;

function check(name, condition, extra = "") {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name} ${extra}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

async function json(path) {
  const res = await fetch(base + path);
  const body = await res.json();
  return { res, body };
}

// On a day the D1 free-tier read quota is used up, every D1 query answers
// 503 d1_quota_exceeded until 00:00 UTC. That says nothing about the code
// being deployed, so the smoke test reports it and stops without failing.
// Cache-busting query: /v1/stats is edge-cached and would hide the quota.
const probe = await json(`/v1/search?q=nafaka&limit=1&_probe=${Date.now()}`);
if (probe.res.status === 503 && probe.body?.error?.code === "d1_quota_exceeded") {
  console.log(`::warning::D1 günlük okuma kotası dolu (${probe.body.error.retry_at ?? "00:00 UTC"}'e kadar); smoke testi atlandı.`);
  process.exit(0);
}

const health = await json("/health");
check("health", health.res.ok && health.body.status === "ok");

const stats = await json("/v1/stats");
check("stats document count", stats.body.stats.document_count > 10000);

const search = await json("/v1/search?q=nafaka&limit=3");
check("search status", search.res.ok);
check("search count", search.body.results.length === 3);
check("search total", search.body.total_documents > 0);
check("search meta", search.body._meta.docs.endsWith("/llms.txt"));
check("search snippet", search.body.results.every((r) => r.snippet.length > 0));
check("search citation", search.body.results.every((r) => typeof r.citation === "string" && r.citation.length > 0));
check("search text status", search.body.results.every((r) => typeof r.text_status === "string"));
check("search highlights", search.body.results.every((r) => Array.isArray(r.highlights)));
check("search candidate count", typeof search.body.candidate_documents === "number");
check("search exact count flag", search.body.exact_count === false);
check("search relaxed flag", typeof search.body.relaxed === "boolean");
check("search groups", search.body.groups && Array.isArray(search.body.groups.mevzuat));
check("search concepts", Array.isArray(search.body.concepts));
check("search primary documents", typeof search.body.primary_documents === "number");
check("search next", typeof search.body.next === "string");
check("search ranking", ["lexical", "hybrid"].includes(search.body.ranking));
check("search semantic info", typeof search.body.semantic?.available === "boolean");

const conceptSearch = await json("/v1/search?q=nafaka&limit=5");
check("concept detected", conceptSearch.body.concepts.some((concept) => concept.id === "nafaka"));
check("concept primary", conceptSearch.body.primary_documents > 0);
check("concept statute first", conceptSearch.body.results[0]?.id === "yasa-1-1998");

// An answer quotes a provision, never a law's title or a text-less record.
const taxAnswer = await json(`/v1/answer?q=${encodeURIComponent("gelir vergisinden istisna edilen gelirler")}`);
check("answer status", taxAnswer.res.ok);
check(
  "answer quotes articles",
  taxAnswer.body.quotes.length > 0 &&
    taxAnswer.body.quotes.every((quote) => quote.ref?.startsWith("Madde") && quote.text_status !== "metadata"),
  JSON.stringify(taxAnswer.body.quotes.map((quote) => [quote.citation, quote.ref])),
);
check("answer coverage", taxAnswer.body.quotes.every((quote) => typeof quote.coverage?.found === "number"));

// Fractions in words match both forms: "üçte iki" (Anayasa) and "2/3".
const twoThirds = await json(`/v1/search?q=${encodeURIComponent("üçte iki")}&limit=3`);
check("word fraction", twoThirds.res.ok && twoThirds.body.relaxed === false && twoThirds.body.results.length > 0);

const kdvSearch = await json("/v1/search?q=KDV&limit=3");
check("concept KDV", kdvSearch.body.results[0]?.id === "yasa-47-1992");

const natural = await json(
  "/v1/search?q=mal%20payla%C5%9F%C4%B1m%C4%B1nda%20e%C5%9Flere%20d%C3%BC%C5%9Fen%20en%20az%20oran&prefer=mevzuat&type=yasa&limit=5",
);
check("auto fallback", natural.body.mode === "auto" && natural.body.relaxed === true);
check("auto candidates", natural.body.candidate_documents > 0);

const answer = await json(
  "/v1/answer?q=mal%20payla%C5%9F%C4%B1m%C4%B1nda%20e%C5%9Flere%20d%C3%BC%C5%9Fen%20en%20az%20oran&limit=2",
);
check("answer status", answer.res.ok);
check("answer extractive", answer.body.answer_type === "extractive");
check("answer quote", answer.body.quotes.length > 0);
check("answer article", answer.body.quotes[0]?.ref === "Madde 26");
check("answer text", typeof answer.body.answer === "string" && answer.body.answer.includes("2/3"));
check("answer citation", typeof answer.body.quotes[0]?.citation === "string");
check("answer disclaimer", answer.body.disclaimer.includes("alıntı"));
const answerMarkdown = await fetch(base + "/v1/answer?q=nafaka&format=markdown");
check("answer markdown", answerMarkdown.ok && (await answerMarkdown.text()).includes("Kaynak"));

const fraction = await json(
  "/v1/search?q=mal%20payla%C5%9F%C4%B1m%C4%B1%202%2F3&prefer=mevzuat&type=yasa&limit=5",
);
const fractionLaw = fraction.body.results.find((r) => r.id === "yasa-1-1998");
check("fraction law found", Boolean(fractionLaw));
check("fraction article", fractionLaw?.matched_ref === "Madde 26");
check("fraction article url", typeof fractionLaw?.matched_url === "string");
check("fraction article text", typeof fractionLaw?.matched_text === "string" && fractionLaw.matched_text.includes("2/3"));

const lawSearch = await json("/v1/search?q=nafaka&type=yasa&limit=3");
check("search type filter", lawSearch.body.results.every((r) => r.type === "yasa"));
check("search law found", lawSearch.body.total_documents > 0);

const govSearch = await json("/v1/search?q=nafaka&type=yasa&source=gov&limit=5");
check("search source filter", govSearch.body.results.every((r) => r.source === "gov"));
check("search gov consolidated", govSearch.body.total_documents > 0);

const ceza = await json("/v1/documents/yasa-fasil-154/articles/1");
check("ceza article 1 status", ceza.res.ok);
check("ceza article 1 body", ceza.body.text.includes("Kısa İsim 1."));
check("ceza toc stripped", !ceza.body.text.includes("MADDE DİZİNİ"));

const doc = await fetch(base + "/v1/documents/yasa-1-1998?format=markdown");
const docText = await doc.text();
check("document markdown status", doc.ok);
check("document markdown title", docText.startsWith("# 1/1998"));
check("document markdown citation", docText.includes("**Atıf:**"));
check("document markdown body", docText.includes("Kısa İsim 1."));

const article4 = await json("/v1/documents/yasa-1-1998/articles/4");
check("article 4 status", article4.res.ok);
check("article 4 ref", article4.body.ref === "Madde 4");
check("article 4 text", article4.body.text.includes("Nişanlanma 4."));
check("article 4 heading fix", !article4.body.text.includes("Evlenme Sözünü Tutmamak"));

const article5 = await json("/v1/documents/yasa-1-1998/articles/5");
check("article 5 heading", article5.body.text.startsWith("Evlenme Sözünü Tutmamak"));

const articles = await json("/v1/documents/yasa-1-1998/articles");
check("article list", articles.body.articles.includes("Madde 4"));

const missingArticle = await json("/v1/documents/yasa-1-1998/articles/999");
check("article 404", missingArticle.res.status === 404);

const missingDoc = await json("/v1/documents/yok-boyle-bir-belge");
check("document 404", missingDoc.res.status === 404);

const recent = await json("/v1/recent?type=karar&limit=5");
check("recent count", recent.body.results.length === 5);
check("recent type", recent.body.results.every((r) => r.type === "karar"));
check("recent dates", recent.body.results.every((r) => r.date));
check("recent citation", recent.body.results.every((r) => typeof r.citation === "string" && r.citation.length > 0));

const changes = await json("/v1/changes?limit=5");
check("changes status", changes.res.ok);
check("changes list", Array.isArray(changes.body.results));
check("changes meta", changes.body._meta.docs.endsWith("/llms.txt"));

const docChanges = await json("/v1/documents/yasa-1-1998/changes");
check("document changes status", docChanges.res.ok);
check("document changes versions", Array.isArray(docChanges.body.versions));
check("document changes list", Array.isArray(docChanges.body.changes));
check("document changes citation", typeof docChanges.body.document.citation === "string");

const changesMd = await fetch(base + "/v1/documents/yasa-1-1998/changes?format=markdown");
const changesMdText = await changesMd.text();
check("changes markdown status", changesMd.ok);
check("changes markdown title", changesMdText.includes("değişiklik geçmişi"));

const viewer = await fetch(base + "/degisiklikler");
const viewerText = await viewer.text();
check("changes viewer status", viewer.ok);
check("changes viewer title", viewerText.includes("Mevzuat değişiklikleri"));

const llms = await fetch(base + "/llms.txt");
const llmsText = await llms.text();
check("llms status", llms.ok);
check("llms base", llmsText.includes(base));
check(
  "llms endpoints",
  llmsText.includes("/v1/search") &&
    llmsText.includes("/v1/changes") &&
    llmsText.includes("ictihat_ara") &&
    llmsText.includes("/mcp"),
);

const openapi = await json("/openapi.json");
check("openapi version", openapi.body.openapi === "3.1.0");
check(
  "openapi paths",
  !!openapi.body.paths["/v1/search"] &&
    !!openapi.body.paths["/v1/answer"] &&
    !!openapi.body.paths["/v1/changes"] &&
    !!openapi.body.paths["/v1/documents/{id}/changes"],
);

async function mcp(payload) {
  const res = await fetch(base + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(payload),
  });
  return { res, body: res.status === 202 ? null : await res.json() };
}

const init = await mcp({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } },
});
check("mcp initialize", init.res.ok && init.body.result.serverInfo.name === "kktc-mevzuat");

const notified = await fetch(base + "/mcp", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
});
check("mcp notification", notified.status === 202);

const tools = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" });
const toolNames = tools.body.result.tools.map((tool) => tool.name);
check(
  "mcp tools",
  [
    "sor",
    "search_mevzuat",
    "ictihat_ara",
    "karar_getir",
    "list_courts",
    "son_degisiklikler",
    "degisiklikleri_getir",
    "get_document",
    "get_article",
    "list_document_articles",
    "list_recent",
    "get_stats",
  ].every((name) => toolNames.includes(name)),
  toolNames.join(","),
);

const call = await mcp({
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: { name: "search_mevzuat", arguments: { query: "nafaka", type: "yasa", limit: 5 } },
});
check("mcp search tool", call.body.result.content[0].text.includes("yasa-1-1998"));

const answerCall = await mcp({
  jsonrpc: "2.0",
  id: 31,
  method: "tools/call",
  params: { name: "sor", arguments: { soru: "nafaka", adet: 1 } },
});
check("mcp sor tool", answerCall.body.result.content[0].text.includes("extractive"));

const caseCall = await mcp({
  jsonrpc: "2.0",
  id: 4,
  method: "tools/call",
  params: { name: "ictihat_ara", arguments: { ifade: "nafaka", adet: 1 } },
});
check("mcp ictihat tool", caseCall.body.result.content[0].text.includes("karar-"));
check("mcp ictihat citation", caseCall.body.result.content[0].text.includes("citation"));

const recentChanges = await mcp({
  jsonrpc: "2.0",
  id: 5,
  method: "tools/call",
  params: { name: "son_degisiklikler", arguments: { limit: 5 } },
});
check("mcp changes tool", recentChanges.body.result.content[0].text.includes("tracking_since"));

const historyCall = await mcp({
  jsonrpc: "2.0",
  id: 6,
  method: "tools/call",
  params: { name: "degisiklikleri_getir", arguments: { id: "yasa-1-1998" } },
});
check("mcp document history tool", historyCall.body.result.content[0].text.includes("değişiklik geçmişi"));

console.log(failures === 0 ? "\nAll smoke tests passed." : `\n${failures} smoke test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
