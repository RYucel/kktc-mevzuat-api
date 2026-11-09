"""Command line entry point: ``python -m kktc ...``."""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from pathlib import Path
from typing import Any

from .build import build_database, export_d1, load_d1_state, read_stats
from .history import copy_history_into, record_versions
from .textproc import parse_consolidation
from .config import DATA_DIR, DB_PATH, DIST_DIR, HISTORY_PATH, MAHKEMELER_BASE, GOV_BASE, GOV_TIMEOUT, ensure_dirs
from .http import FetchError, HttpClient, MahkemelerClient
from .sources import (
    ACTIVE_GOV_CATEGORIES,
    _read_text_cache,
    attach_texts,
    crawl_gov,
    crawl_mahkemeler_karar,
    crawl_mahkemeler_tuzuk,
    crawl_mahkemeler_yasa,
    fetch_text_for,
    load_catalog,
    merge_documents,
    save_catalog,
)

log = logging.getLogger("kktc")


def _setup_logging(verbose: bool = False) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )


def _catalogs() -> list[list[dict[str, Any]]]:
    return [
        load_catalog("gov"),
        load_catalog("mahkemeler_yasa"),
        load_catalog("mahkemeler_tuzuk"),
        load_catalog("mahkemeler_karar"),
    ]


def cmd_crawl(args: argparse.Namespace) -> None:
    ensure_dirs()
    sources = args.source
    if sources in ("all", "gov"):
        client = HttpClient(GOV_BASE, verify=False, timeout=GOV_TIMEOUT)
        try:
            save_catalog("gov", crawl_gov(client))
        except FetchError as exc:
            # A build without gov documents would reset D1 to a partial corpus, so
            # only a previous catalog (restored from the CI cache) may stand in
            previous = load_catalog("gov")
            if not previous:
                raise
            log.warning("gov site unavailable (%s); keeping the previous catalog of %d documents", exc, len(previous))
    if sources in ("all", "mahkemeler"):
        client = MahkemelerClient(MAHKEMELER_BASE)
        if args.only in ("all", "yasa"):
            save_catalog("mahkemeler_yasa", crawl_mahkemeler_yasa(client))
        if args.only in ("all", "tuzuk"):
            save_catalog("mahkemeler_tuzuk", crawl_mahkemeler_tuzuk(client))
        if args.only in ("all", "karar"):
            save_catalog("mahkemeler_karar", crawl_mahkemeler_karar(client))


def _extension(url: str) -> str:
    path = url.split("?", 1)[0].rsplit("/", 1)[-1]
    return path.rsplit(".", 1)[-1].lower() if "." in path else ""


def cmd_fetch_text(args: argparse.Namespace) -> None:
    ensure_dirs()
    docs = merge_documents(_catalogs())
    types = set(args.type.split(",")) if args.type else None
    extensions = {e.strip().lower().lstrip(".") for e in args.ext.split(",") if e.strip()} if getattr(args, "ext", "") else None
    gov_client = HttpClient(GOV_BASE, verify=False, timeout=GOV_TIMEOUT)
    mah_client = MahkemelerClient(MAHKEMELER_BASE)
    done = 0
    checked = 0
    for doc in docs:
        if types and doc.get("type") not in types:
            continue
        if args.source and doc.get("source") != args.source:
            continue
        if args.min_year and (not doc.get("year") or doc["year"] < args.min_year):
            continue
        if extensions and _extension(doc.get("pdf_url") or doc.get("source_url") or "") not in extensions:
            continue
        if doc.get("content") and len(doc["content"]) > 500:
            continue
        url = doc.get("pdf_url") or doc.get("source_url")
        if not url:
            continue
        if args.after and checked < args.after:
            checked += 1
            continue
        if args.limit and done >= args.limit:
            break
        checked += 1
        client = gov_client if "gov.ct.tr" in url else mah_client
        payload = fetch_text_for(
            doc,
            client,
            force=args.force,
            revalidate=getattr(args, "revalidate", False),
            retry_errors=getattr(args, "retry_errors", False),
        )
        if payload.get("text"):
            done += 1
            log.info(
                "[%d] %s <- %s (%s, %d chars)",
                done,
                doc.get("_id"),
                payload.get("method"),
                payload.get("status"),
                len(payload["text"]),
            )
    log.info("fetched text for %d documents", done)


def _content_for(doc: dict[str, Any]) -> str:
    content = doc.get("content") or ""
    if content:
        return content
    url = doc.get("pdf_url") or doc.get("source_url") or ""
    if not url:
        return ""
    cached = _read_text_cache(url)
    if cached and cached.get("text"):
        doc.setdefault("extra", {})["extraction"] = {
            "status": cached.get("status"),
            "method": cached.get("method"),
            "bytes": cached.get("bytes"),
        }
        return cached["text"]
    return ""


def _merged_with_text() -> list[dict[str, Any]]:
    docs = merge_documents(_catalogs())
    for doc in docs:
        text = _content_for(doc)
        if text:
            doc["content"] = text
            if doc.get("type") != "karar":
                consolidation = parse_consolidation(text)
                if consolidation:
                    doc.setdefault("extra", {})["consolidation"] = consolidation
    return docs


def cmd_build(args: argparse.Namespace) -> None:
    ensure_dirs()
    docs = _merged_with_text()
    if not docs:
        raise SystemExit("No catalog data found. Run `python -m kktc crawl` first.")
    history_path = Path(getattr(args, "history", "") or HISTORY_PATH)
    history = None
    if not getattr(args, "no_history", False):
        history = record_versions(docs, history_path)
    stats = build_database(docs, Path(args.db))
    stats["history"] = copy_history_into(Path(args.db), history_path)
    if history:
        stats["history"]["this_run"] = history
    print(json.dumps(stats, ensure_ascii=False, indent=2))
    if not args.no_export:
        export_d1(Path(args.db), Path(args.out), load_d1_state(getattr(args, "d1_state", None)))


def cmd_update(args: argparse.Namespace) -> None:
    ensure_dirs()
    crawl_args = argparse.Namespace(source="all", only="all")
    cmd_crawl(crawl_args)
    if not args.no_text:
        text_args = argparse.Namespace(
            type=None,
            # Default refresh is gov-only: mevzuat.gov.ct.tr carries the
            # consolidated, currently in-force texts. Mahkemeler PDFs are
            # archived/scanned and take hours, so they are opt-in.
            source="mahkemeler" if args.full_text else "gov",
            limit=args.text_limit,
            after=0,
            force=False,
            min_year=0,
            revalidate=not args.full_text,
        )
        cmd_fetch_text(text_args)
        # Laws found only on mevzuat.mahkemeler.net (consolidated Word files).
        cmd_fetch_text(
            argparse.Namespace(
                type="yasa",
                source="mahkemeler",
                ext="doc,docx,rtf",
                limit=args.text_limit,
                after=0,
                force=False,
                min_year=0,
                revalidate=True,
            )
        )
    build_args = argparse.Namespace(db=str(DB_PATH), out=str(DIST_DIR / "d1"), no_export=args.no_export, history=str(HISTORY_PATH), no_history=False, d1_state=None)
    cmd_build(build_args)


def cmd_stats(args: argparse.Namespace) -> None:
    db = Path(args.db)
    if not db.exists():
        raise SystemExit(f"Database not found: {db}")
    print(json.dumps(read_stats(db), ensure_ascii=False, indent=2))


def cmd_vectors(args: argparse.Namespace) -> None:
    import os

    from . import vectors

    if args.action == "export":
        stats = vectors.export_units(Path(args.db), Path(args.units))
        print(json.dumps(stats, ensure_ascii=False, indent=2))
        return
    if args.action == "admin-token":
        api_token = os.environ.get("CLOUDFLARE_API_TOKEN", "")
        if not api_token:
            raise SystemExit("CLOUDFLARE_API_TOKEN is not set")
        print(vectors.admin_token(api_token))
        return
    token = os.environ.get("VECTOR_ADMIN_TOKEN") or (
        vectors.admin_token(os.environ["CLOUDFLARE_API_TOKEN"]) if os.environ.get("CLOUDFLARE_API_TOKEN") else ""
    )
    if not token or not args.base:
        raise SystemExit("--base and VECTOR_ADMIN_TOKEN (or CLOUDFLARE_API_TOKEN) are required")
    manifest_path = Path(args.manifest)
    manifest = vectors.load_manifest(manifest_path)
    summary = vectors.sync(
        vectors.load_units(Path(args.units)),
        manifest,
        vectors.http_poster(args.base, token),
        budget_tokens=args.budget_tokens,
        save=lambda m: vectors.save_manifest(manifest_path, m),
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        prog="kktc",
        description="KKTC mevzuat crawler and search index builder",
    )
    parser.add_argument("-v", "--verbose", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)

    crawl = sub.add_parser("crawl", help="download catalog metadata")
    crawl.add_argument("--source", choices=["all", "gov", "mahkemeler"], default="all")
    crawl.add_argument("--only", choices=["all", "yasa", "tuzuk", "karar"], default="all")
    crawl.set_defaults(func=cmd_crawl)

    text = sub.add_parser("fetch-text", help="download and extract PDF/DOC text")
    text.add_argument("--limit", type=int, default=0)
    text.add_argument("--after", type=int, default=0)
    text.add_argument("--type", default="")
    text.add_argument("--source", default="")
    text.add_argument(
        "--min-year",
        type=int,
        default=0,
        help="only fetch documents from this year onwards (older PDFs are often scans)",
    )
    text.add_argument("--force", action="store_true")
    text.add_argument("--ext", default="", help="only these file types, e.g. doc,docx,rtf")
    text.add_argument(
        "--revalidate",
        action="store_true",
        help="download cached files again and re-extract those whose bytes changed (same name, new content)",
    )
    text.add_argument(
        "--retry-errors",
        action="store_true",
        help="try again files whose earlier download failed (cached error other than HTTP 404)",
    )
    text.set_defaults(func=cmd_fetch_text)

    build = sub.add_parser("build", help="build the SQLite FTS database")
    build.add_argument("--db", default=str(DB_PATH))
    build.add_argument("--out", default=str(DIST_DIR / "d1"))
    build.add_argument("--no-export", action="store_true")
    build.add_argument("--d1-state", default=None, help="d1-state.json from the last successful D1 import; export only what changed since (missing/old = full import)")
    build.add_argument("--history", default=str(HISTORY_PATH), help="persistent version history database")
    build.add_argument(
        "--no-history",
        action="store_true",
        help="do not record new versions (existing history is still copied into the index)",
    )
    build.set_defaults(func=cmd_build)

    export = sub.add_parser("export", help="export the database as D1 SQL files")
    export.add_argument("--db", default=str(DB_PATH))
    export.add_argument("--out", default=str(DIST_DIR / "d1"))
    export.add_argument("--d1-state", default=None, help="d1-state.json from the last successful D1 import; export only what changed since (missing/old = full import)")
    export.set_defaults(func=lambda a: export_d1(Path(a.db), Path(a.out), load_d1_state(a.d1_state)))

    update = sub.add_parser("update", help="crawl, fetch text, build and export")
    update.add_argument("--text-limit", type=int, default=0)
    update.add_argument(
        "--full-text",
        action="store_true",
        help="also fetch mahkemeler yasa/tuzuk PDFs (slow; gov is the default)",
    )
    update.add_argument("--no-text", action="store_true")
    update.add_argument("--no-export", action="store_true")
    update.set_defaults(func=cmd_update)

    vec = sub.add_parser("vectors", help="semantic index: export units / sync to the Worker")
    vec.add_argument("action", choices=["export", "sync", "admin-token"])
    vec.add_argument("--db", default=str(DB_PATH))
    vec.add_argument("--units", default=str(DATA_DIR / "vector-units.jsonl.gz"))
    vec.add_argument("--manifest", default=str(DATA_DIR / "vectors.json"))
    vec.add_argument("--base", default="", help="Worker URL, e.g. https://kktc-mevzuat-api.example.workers.dev")
    vec.add_argument(
        "--budget-tokens",
        type=int,
        default=7_000_000,
        help="max input tokens to embed this run (Workers AI free tier: ~9M/day)",
    )
    vec.set_defaults(func=cmd_vectors)

    stats = sub.add_parser("stats", help="show index statistics")
    stats.add_argument("--db", default=str(DB_PATH))
    stats.set_defaults(func=cmd_stats)

    args = parser.parse_args(argv)
    _setup_logging(args.verbose)
    args.func(args)


if __name__ == "__main__":
    main()
