// End-to-end smoke test against a running API (Node or Worker).
//   npm run smoke
//   BASE=https://api.example.com npm run smoke
const base = (process.env.BASE ?? "http://localhost:8787").replace(/\/$/, "");
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
check("search next", typeof search.body.next === "string");

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

const llms = await fetch(base + "/llms.txt");
const llmsText = await llms.text();
check("llms status", llms.ok);
check("llms base", llmsText.includes(base));
check("llms endpoints", llmsText.includes("/v1/search") && llmsText.includes("/mcp"));

const openapi = await json("/openapi.json");
check("openapi version", openapi.body.openapi === "3.1.0");
check("openapi paths", !!openapi.body.paths["/v1/search"]);

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
check("mcp tools", tools.body.result.tools.length === 6);

const call = await mcp({
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: { name: "search_mevzuat", arguments: { query: "nafaka", type: "yasa", limit: 5 } },
});
check("mcp search tool", call.body.result.content[0].text.includes("yasa-1-1998"));

console.log(failures === 0 ? "\nAll smoke tests passed." : `\n${failures} smoke test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
