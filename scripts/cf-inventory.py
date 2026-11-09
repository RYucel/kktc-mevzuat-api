"""Cloudflare account inventory and last-30-day usage, for the Workers Paid decision.

  CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... python3 scripts/cf-inventory.py

Lists Workers, Pages projects, D1 databases, KV, R2 and Vectorize, and (when
the token may read account analytics) requests per Worker, D1 rows read and
written per database and Workers AI neurons for the last 30 days, compared
with the free and paid allowances. Prints Markdown (also to
GITHUB_STEP_SUMMARY). No ids or secrets are printed, only resource names.
Standard library only.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import sys
import urllib.error
import urllib.request

TOKEN = os.environ["CLOUDFLARE_API_TOKEN"]
ACCOUNT = os.environ["CLOUDFLARE_ACCOUNT_ID"]
API = "https://api.cloudflare.com/client/v4"


def call(path: str, body: dict | None = None) -> dict:
    request = urllib.request.Request(
        API + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        method="POST" if body is not None else "GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        return {"success": False, "errors": [{"message": f"HTTP {error.code}"}]}


def listing(path: str) -> tuple[list, str | None]:
    data = call(f"/accounts/{ACCOUNT}{path}")
    if not data.get("success", False) and data.get("errors"):
        return [], data["errors"][0].get("message", "error")
    result = data.get("result")
    if isinstance(result, dict):
        result = result.get("buckets") or result.get("indexes") or result.get("items") or []
    return result or [], None


def mb(size: float | int | None) -> str:
    return f"{(size or 0) / 1_000_000:.0f} MB"


out: list[str] = ["## Cloudflare hesap envanteri", ""]
now = dt.datetime.now(dt.timezone.utc)
since = now - dt.timedelta(days=30)
out.append(f"Son 30 gün: {since:%Y-%m-%d} – {now:%Y-%m-%d} (UTC)")

# --- resources ----------------------------------------------------------------
workers, err_w = listing("/workers/scripts")
pages, err_p = listing("/pages/projects")
d1, err_d = listing("/d1/database?per_page=100")
kv, err_k = listing("/storage/kv/namespaces?per_page=100")
r2, err_r = listing("/r2/buckets")
vec, err_v = listing("/vectorize/v2/indexes")

out += ["", "### Kaynaklar", "", "| Tür | Adet | İsimler |", "|---|---|---|"]
def row(kind: str, items: list, name_key: str, err: str | None) -> None:
    names = ", ".join(sorted(str(i.get(name_key) or i.get("name") or i.get("id") or "?") for i in items)) or "–"
    out.append(f"| {kind} | {len(items) if err is None else '?'} | {names if err is None else 'okunamadı: ' + err} |")
row("Worker", workers, "id", err_w)
row("Pages projesi", pages, "name", err_p)
row("D1 veritabanı", d1, "name", err_d)
row("KV", kv, "title", err_k)
row("R2", r2, "name", err_r)
row("Vectorize", vec, "name", err_v)

if d1:
    out += ["", "| D1 veritabanı | Boyut | Tablo |", "|---|---|---|"]
    for db in sorted(d1, key=lambda d: -(d.get("file_size") or 0)):
        out.append(f"| {db.get('name')} | {mb(db.get('file_size'))} | {db.get('num_tables', '?')} |")
    out.append("")
    out.append("Ücretsiz: veritabanı başına 500 MB, hesapta 5 GB. Ücretli: veritabanı başına 10 GB.")

if pages:
    out += ["", "| Pages projesi | Functions (sunucu kodu) |", "|---|---|"]
    for p in pages:
        # Projects with a functions/ directory run Worker code on requests.
        functions = "var" if (p.get("latest_deployment") or {}).get("uses_functions") else "yok/bilinmiyor"
        out.append(f"| {p.get('name')} | {functions} |")

# --- usage (GraphQL analytics) ----------------------------------------------------
query = """
query($account: String!, $since: Time!, $until: Time!, $sinceDate: Date!, $untilDate: Date!) {
  viewer { accounts(filter: {accountTag: $account}) {
    workers: workersInvocationsAdaptive(limit: 100, filter: {datetime_geq: $since, datetime_leq: $until}) {
      sum { requests errors subrequests } dimensions { scriptName }
    }
    d1: d1AnalyticsAdaptiveGroups(limit: 100, filter: {date_geq: $sinceDate, date_leq: $untilDate}) {
      sum { readQueries writeQueries rowsRead rowsWritten } dimensions { databaseId }
    }
    ai: aiInferenceAdaptiveGroups(limit: 100, filter: {datetime_geq: $since, datetime_leq: $until}) {
      sum { totalNeurons } dimensions { modelId }
    }
  } }
}"""
variables = {
    "account": ACCOUNT,
    "since": since.strftime("%Y-%m-%dT%H:%M:%SZ"),
    "until": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
    "sinceDate": since.strftime("%Y-%m-%d"),
    "untilDate": now.strftime("%Y-%m-%d"),
}
gql = call("/graphql", {"query": query, "variables": variables})
accounts = (((gql.get("data") or {}).get("viewer") or {}).get("accounts") or [{}])
usage = accounts[0] if accounts else {}
if gql.get("errors"):
    out += ["", f"> Kullanım verisinin bir kısmı okunamadı (token'ın 'Account Analytics: Read' izni olmayabilir): "
            + "; ".join(str(e.get("message"))[:120] for e in gql["errors"][:3])]

def group(rows: list, key: str) -> dict:
    merged: dict = {}
    for r in rows or []:
        name = (r.get("dimensions") or {}).get(key) or "?"
        acc = merged.setdefault(name, {})
        for k, v in (r.get("sum") or {}).items():
            acc[k] = acc.get(k, 0) + (v or 0)
    return merged

w = group(usage.get("workers"), "scriptName")
if w:
    total = sum(v.get("requests", 0) for v in w.values())
    out += ["", "### Worker istekleri (30 gün)", "", "| Worker | İstek | Hata | Alt istek |", "|---|---|---|---|"]
    for name, v in sorted(w.items(), key=lambda kv: -kv[1].get("requests", 0)):
        out.append(f"| {name} | {v.get('requests', 0):,} | {v.get('errors', 0):,} | {v.get('subrequests', 0):,} |")
    out.append(f"| **toplam** | **{total:,}** | | |")
    out.append("")
    out.append("Ücretsiz: günde 100 bin istek. Ücretli: ayda 10 milyon dahil, sonra milyon başına 0,30 $.")

names = {db.get("uuid"): db.get("name") for db in d1}
d = group(usage.get("d1"), "databaseId")
if d:
    out += ["", "### D1 kullanımı (30 gün)", "", "| Veritabanı | Okunan satır | Yazılan satır | Okuma sorgusu | Yazma sorgusu |", "|---|---|---|---|---|"]
    tr = tw = 0
    for dbid, v in sorted(d.items(), key=lambda kv: -kv[1].get("rowsRead", 0)):
        tr += v.get("rowsRead", 0); tw += v.get("rowsWritten", 0)
        out.append(f"| {names.get(dbid, 'bilinmeyen')} | {v.get('rowsRead', 0):,} | {v.get('rowsWritten', 0):,} | {v.get('readQueries', 0):,} | {v.get('writeQueries', 0):,} |")
    out.append(f"| **toplam** | **{tr:,}** | **{tw:,}** | | |")
    out.append("")
    out.append("Ücretsiz: günde 5 milyon okuma, 100 bin yazma. Ücretli: ayda 25 milyar okuma ve 50 milyon yazma dahil; "
               "aşım milyon okuma başına 0,001 $, milyon yazma başına 1 $.")

a = group(usage.get("ai"), "modelId")
if a:
    out += ["", "### Workers AI (30 gün)", "", "| Model | Neuron |", "|---|---|"]
    for model, v in sorted(a.items(), key=lambda kv: -kv[1].get("totalNeurons", 0)):
        out.append(f"| {model} | {v.get('totalNeurons', 0):,.0f} |")
    out.append("")
    out.append("Her iki planda günde 10.000 neuron ücretsiz; ücretli planda aşım 1.000 neuron başına 0,011 $.")

text = "\n".join(out)
print(text)
summary = os.environ.get("GITHUB_STEP_SUMMARY")
if summary:
    with open(summary, "a", encoding="utf-8") as handle:
        handle.write(text + "\n")
sys.exit(0)
