"""Command line entry point: ``python -m kktc ...``."""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from pathlib import Path
from typing import Any

from .build import build_database, export_d1, read_stats
from .config import DB_PATH, DIST_DIR, MAHKEMELER_BASE, GOV_BASE, ensure_dirs
from .http import HttpClient, MahkemelerClient
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
        client = HttpClient(GOV_BASE, verify=False)
        docs = crawl_gov(client)
        save_catalog("gov", docs)
    if sources in ("all", "mahkemeler"):
        client = MahkemelerClient(MAHKEMELER_BASE)
        if args.only in ("all", "yasa"):
            save_catalog("mahkemeler_yasa", crawl_mahkemeler_yasa(client))
        if args.only in ("all", "tuzuk"):
            save_catalog("mahkemeler_tuzuk", crawl_mahkemeler_tuzuk(client))
        if args.only in ("all", "karar"):
            save_catalog("mahkemeler_karar", crawl_mahkemeler_karar(client))


def cmd_fetch_text(args: argparse.Namespace) -> None:
    ensure_dirs()
    docs = merge_documents(_catalogs())
    types = set(args.type.split(",")) if args.type else None
    gov_client = HttpClient(GOV_BASE, verify=False)
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
        payload = fetch_text_for(doc, client, force=args.force)
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
    return docs


def cmd_build(args: argparse.Namespace) -> None:
    ensure_dirs()
    docs = _merged_with_text()
    if not docs:
        raise SystemExit("No catalog data found. Run `python -m kktc crawl` first.")
    stats = build_database(docs, Path(args.db))
    print(json.dumps(stats, ensure_ascii=False, indent=2))
    if not args.no_export:
        export_d1(Path(args.db), Path(args.out))


def cmd_update(args: argparse.Namespace) -> None:
    ensure_dirs()
    crawl_args = argparse.Namespace(source="all", only="all")
    cmd_crawl(crawl_args)
    if not args.no_text:
        text_args = argparse.Namespace(
            type=None, source=None, limit=args.text_limit, after=0, force=False, min_year=0
        )
        cmd_fetch_text(text_args)
    build_args = argparse.Namespace(db=str(DB_PATH), out=str(DIST_DIR / "d1"), no_export=args.no_export)
    cmd_build(build_args)


def cmd_stats(args: argparse.Namespace) -> None:
    db = Path(args.db)
    if not db.exists():
        raise SystemExit(f"Database not found: {db}")
    print(json.dumps(read_stats(db), ensure_ascii=False, indent=2))


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
    text.set_defaults(func=cmd_fetch_text)

    build = sub.add_parser("build", help="build the SQLite FTS database")
    build.add_argument("--db", default=str(DB_PATH))
    build.add_argument("--out", default=str(DIST_DIR / "d1"))
    build.add_argument("--no-export", action="store_true")
    build.set_defaults(func=cmd_build)

    export = sub.add_parser("export", help="export the database as D1 SQL files")
    export.add_argument("--db", default=str(DB_PATH))
    export.add_argument("--out", default=str(DIST_DIR / "d1"))
    export.set_defaults(func=lambda a: export_d1(Path(a.db), Path(a.out)))

    update = sub.add_parser("update", help="crawl, fetch text, build and export")
    update.add_argument("--text-limit", type=int, default=0)
    update.add_argument("--no-text", action="store_true")
    update.add_argument("--no-export", action="store_true")
    update.set_defaults(func=cmd_update)

    stats = sub.add_parser("stats", help="show index statistics")
    stats.add_argument("--db", default=str(DB_PATH))
    stats.set_defaults(func=cmd_stats)

    args = parser.parse_args(argv)
    _setup_logging(args.verbose)
    args.func(args)


if __name__ == "__main__":
    main()
