"""Adapters for the two official KKTC sources.

* mevzuat.gov.ct.tr - Merkezi Mevzuat Dairesi, consolidated/current PDFs.
* mevzuat.mahkemeler.net - Mahkemeler Mevzuat Bilgi Sistemi, catalogue,
  full text of many laws and all published court decisions.
"""

from __future__ import annotations

import html
import json
import logging
import re
import time
import urllib.parse
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Iterable, Optional

from .config import (
    CATALOG_DIR,
    GOV_BASE,
    GOV_CATEGORIES,
    MAHKEMELER_BASE,
    RAW_DIR,
    TEXT_DIR,
)
from .http import HttpClient, MahkemelerClient
from .textproc import (
    clean_pdf_pages,
    clean_text,
    extract_number,
    extract_year,
    make_doc_id,
    normalize_title,
    slugify,
)

log = logging.getLogger(__name__)

GOV_CATEGORY_URLS = {
    "ANAYASA": "/MEVZUAT/ANAYASA",
    "YASALAR": "/MEVZUAT/YASALAR",
    "TÜZÜKLER": "/MEVZUAT/TÜZÜKLER",
    "YÖNETMELİKLER": "/MEVZUAT/YÖNETMELİKLER",
    "EMİRNAMELER": "/MEVZUAT/EMİRNAMELER",
    "KARARNAMELER": "/MEVZUAT/KARARNAMELER",
    "ULUSLARARASI-ANDLAŞMALAR": "/MEVZUAT/ULUSLARARASI-ANDLAŞMALAR",
}

# Categories that currently contain documents. Keeping the full mapping means
# new categories are picked up automatically when the site adds them.
ACTIVE_GOV_CATEGORIES = ("ANAYASA", "YASALAR", "TÜZÜKLER")


class _AnchorParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.anchors: list[tuple[str, str]] = []
        self._href: Optional[str] = None
        self._buf: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, Optional[str]]]) -> None:
        if tag.lower() == "a":
            self._href = dict(attrs).get("href")
            self._buf = []

    def handle_data(self, data: str) -> None:
        if self._href is not None:
            self._buf.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "a" and self._href is not None:
            text = " ".join("".join(self._buf).split())
            self.anchors.append((self._href, text))
            self._href = None
            self._buf = []


def _parse_anchors(page: str) -> list[tuple[str, str]]:
    parser = _AnchorParser()
    parser.feed(page)
    return parser.anchors


def _is_document_link(href: str) -> bool:
    path = urllib.parse.urlparse(href).path.lower()
    return path.endswith((".pdf", ".doc", ".docx", ".rtf"))


def _clean_title(text: str) -> str:
    text = html.unescape(text)
    text = re.sub(r"\s+", " ", text).strip(" -–—|")
    return text


def _source_date_from_filename(url: str) -> Optional[str]:
    name = urllib.parse.unquote(urllib.parse.urlparse(url).path.rsplit("/", 1)[-1])
    # e.g. "25-1993 YURTTASLIK YASASI 13_10_2026.pdf"
    matches = re.findall(r"(?<!\d)(\d{1,2})[_-](\d{1,2})[_-](\d{4}|\d{2})(?!\d)", name)
    for day, month, year in reversed(matches):
        year_int = int(year) + (2000 if len(year) == 2 else 0)
        try:
            if 1 <= int(day) <= 31 and 1 <= int(month) <= 12 and 1950 <= year_int <= 2100:
                return f"{year_int:04d}-{int(month):02d}-{int(day):02d}"
        except ValueError:
            continue
    return None


def crawl_gov(client: Optional[HttpClient] = None, *, categories: Iterable[str] = ACTIVE_GOV_CATEGORIES) -> list[dict[str, Any]]:
    client = client or HttpClient(GOV_BASE, verify=False)
    docs: list[dict[str, Any]] = []
    for category in categories:
        url = GOV_BASE + urllib.parse.quote(GOV_CATEGORY_URLS[category])
        log.info("gov: %s", url)
        page = client.get(url).text
        by_href: dict[str, str] = {}
        for href, label in _parse_anchors(page):
            if not href or not _is_document_link(href):
                continue
            absolute = urllib.parse.urljoin(url, href)
            label = _clean_title(label)
            # The DNN pages sometimes split a title across two anchors that
            # point at the same file. Keep the longest label.
            if len(label) > len(by_href.get(absolute, "")):
                by_href[absolute] = label
        for absolute, title in by_href.items():
            doc_type = GOV_CATEGORIES[category]
            number = extract_number(title)
            docs.append(
                {
                    "type": doc_type,
                    "title": title,
                    "number": number,
                    "year": extract_year(title, number),
                    "date": None,
                    "language": "tr",
                    "source": "gov",
                    "source_url": absolute,
                    "pdf_url": absolute,
                    "content": "",
                    "extra": {
                        "category": category,
                        "source_updated": _source_date_from_filename(absolute),
                    },
                }
            )
        log.info("gov: %s -> %d documents", category, len(by_href))
    dedup: dict[str, dict[str, Any]] = {}
    for doc in docs:
        dedup.setdefault(doc["pdf_url"], doc)
    return list(dedup.values())


def _mahkemeler_abs(link: str) -> str:
    if not link:
        return ""
    return urllib.parse.urljoin(MAHKEMELER_BASE + "/", link)


def crawl_mahkemeler_yasa(client: MahkemelerClient) -> list[dict[str, Any]]:
    docs: list[dict[str, Any]] = []
    start = 0
    total = None
    while total is None or start < total:
        payload = client.grid(
            "/MEVZUAT/Yasa/LoadDataForGrid",
            {
                "start": start,
                "length": 500,
                "Numara": "",
                "YasaAd": "",
                "YasaMetin": "",
                "YasaTurPkey": "",
            },
        )
        total = int(payload.get("recordsTotal") or 0)
        rows = payload.get("data") or []
        if not rows:
            break
        for row in rows:
            title = _clean_title(row.get("YasaAd") or "")
            number = (row.get("Numara") or "").strip() or extract_number(title)
            language = "en" if (row.get("DilAd") or "").lower().startswith("ingiliz") else "tr"
            content = clean_text(row.get("YasaMetin") or "")
            docs.append(
                {
                    "type": "yasa",
                    "title": title,
                    "number": number or None,
                    "year": extract_year(title, number),
                    "date": None,
                    "language": language,
                    "source": "mahkemeler",
                    "source_url": f"{MAHKEMELER_BASE}/MEVZUAT/Yasa/Duzenle?YasaPkey={row.get('Pkey')}",
                    "pdf_url": _mahkemeler_abs(row.get("DownloadLink") or ""),
                    "content": content,
                    "extra": {
                        "pkey": row.get("Pkey"),
                        "dosya": row.get("DosyaAd"),
                        "yasa_turu": row.get("YasaTurPkey"),
                    },
                }
            )
        log.info("mahkemeler yasa: %d/%s", min(start + len(rows), total), total)
        start += len(rows)
        time.sleep(0.2)
    return docs


def crawl_mahkemeler_tuzuk(client: MahkemelerClient) -> list[dict[str, Any]]:
    docs: list[dict[str, Any]] = []
    start = 0
    total = None
    while total is None or start < total:
        payload = client.grid(
            "/MEVZUAT/Enstruman/LoadDataForGrid",
            {
                "start": start,
                "length": 500,
                "TurPkey": "",
                "UstSayi": "",
                "AltSayi": "",
                "Ad": "",
                "Yasa": "",
                "AmmeEnstrumanNo": "",
                "AmmeEnstrumanTur": "",
            },
        )
        total = int(payload.get("recordsTotal") or 0)
        rows = payload.get("data") or []
        if not rows:
            break
        for row in rows:
            title = _clean_title(row.get("Ad") or "")
            number = (row.get("AmmeEnstrumanNo") or "").strip() or extract_number(title)
            date = (row.get("ResmiGazeteTarih") or "")[:10] or None
            docs.append(
                {
                    "type": "tuzuk" if (row.get("TurGorunumAd") or "Tüzük").lower().startswith("tüz") else (row.get("TurGorunumAd") or "tuzuk").lower(),
                    "title": title,
                    "number": number or None,
                    "year": row.get("Yil") or extract_year(title, number),
                    "date": date,
                    "language": "tr",
                    "source": "mahkemeler",
                    "source_url": f"{MAHKEMELER_BASE}/MEVZUAT/Enstruman/Duzenle?EnstrumanPkey={row.get('Pkey')}",
                    "pdf_url": _mahkemeler_abs(row.get("DownloadLink") or ""),
                    "content": "",
                    "extra": {
                        "pkey": row.get("Pkey"),
                        "dosya": row.get("DosyaAd"),
                        "tur": row.get("AmmeEnstrumanTur"),
                        "yasa": row.get("Yasa"),
                        "ust_sayi": row.get("UstSayi"),
                        "alt_sayi": row.get("AltSayi"),
                    },
                }
            )
        log.info("mahkemeler tuzuk: %d/%s", min(start + len(rows), total), total)
        start += len(rows)
        time.sleep(0.2)
    return docs


def crawl_mahkemeler_karar(client: MahkemelerClient) -> list[dict[str, Any]]:
    docs: list[dict[str, Any]] = []
    start = 0
    total = None
    seen: set[int] = set()
    while total is None or start < total:
        payload = client.grid(
            "/MEVZUAT/Karar/LoadDataForGrid",
            {
                "start": start,
                "length": 500,
                "AnaTurPkey": "",
                "TurPkey": "",
                "Yild": "",
                "Yile": "",
                "Dnumara": "",
                "Enumara": "",
                "Taraflar": "",
                "Konu": "",
                "YasaMadde": "",
                "Ozet": "",
                "KararMetin": "",
                "Siralama": "",
            },
        )
        total = int(payload.get("recordsTotal") or 0)
        rows = payload.get("data") or []
        if not rows:
            break
        for row in rows:
            pkey = row.get("Pkey")
            if pkey in seen:
                continue
            seen.add(int(pkey))
            date = (row.get("Tarih") or "")[:10] or None
            court = _clean_title(row.get("TurGorunumAd") or "")
            docs.append(
                {
                    "type": "karar",
                    "title": _decision_title(row, court),
                    "number": _decision_number(row),
                    "year": row.get("Yile") or (int(date[:4]) if date else None),
                    "date": date,
                    "language": "tr",
                    "source": "mahkemeler",
                    "source_url": f"{MAHKEMELER_BASE}/MEVZUAT/Karar/Duzenle?KararPkey={pkey}",
                    "pdf_url": _mahkemeler_abs(row.get("DownloadLink") or ""),
                    "content": clean_text(row.get("KararMetin") or ""),
                    "court": court or None,
                    "parties": _clean_title(row.get("Taraflar") or "") or None,
                    "subject": _clean_title(row.get("Konu") or "") or None,
                    "summary": _clean_title(row.get("Ozet") or "") or None,
                    "extra": {
                        "pkey": pkey,
                        "dosya": row.get("DosyaAd"),
                        "yasa_madde": _clean_title(row.get("YasaMadde") or "") or None,
                        "tur_eski": row.get("TurEski"),
                        "eklenme": (row.get("EklenmeTarih") or "")[:10] or None,
                        "enumara": row.get("Enumara"),
                        "yile": row.get("Yile"),
                        "dnumara": row.get("Dnumara"),
                        "yild": row.get("Yild"),
                    },
                }
            )
        log.info("mahkemeler karar: %d/%s", min(start + len(rows), total), total)
        start += len(rows)
        time.sleep(0.2)
    return docs


def _decision_number(row: dict[str, Any]) -> Optional[str]:
    en, yil = row.get("Enumara"), row.get("Yile")
    dn, dy = row.get("Dnumara"), row.get("Yild")
    if en and yil:
        return f"E.{en}/{yil}"
    if dn and dy:
        return f"D.{dn}/{dy}"
    return None


def _decision_title(row: dict[str, Any], court: str) -> str:
    parties = _clean_title(row.get("Taraflar") or "")
    number = _decision_number(row)
    subject = _clean_title(row.get("Konu") or "")
    bits = [court or "Mahkeme Kararı"]
    if number:
        bits.append(number)
    if parties:
        bits.append(parties)
    title = " - ".join(bits)
    if subject:
        title += f" ({subject})"
    return title[:300]


def save_catalog(name: str, docs: list[dict[str, Any]]) -> Path:
    path = CATALOG_DIR / f"{name}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "saved_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "count": len(docs),
        "documents": docs,
    }
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    log.info("wrote %s (%d documents)", path, len(docs))
    return path


def load_catalog(name: str) -> list[dict[str, Any]]:
    path = CATALOG_DIR / f"{name}.json"
    if not path.exists():
        return []
    payload = json.loads(path.read_text(encoding="utf-8"))
    return payload.get("documents", [])


def _text_cache_path(url: str) -> Path:
    import hashlib

    return TEXT_DIR / f"{hashlib.sha1(url.encode('utf-8')).hexdigest()}.json"


def _read_text_cache(url: str) -> Optional[dict[str, Any]]:
    path = _text_cache_path(url)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None


def _write_text_cache(url: str, payload: dict[str, Any]) -> None:
    path = _text_cache_path(url)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def extract_document_text(url: str, data: bytes) -> dict[str, Any]:
    """Extract text from PDF/DOCX/DOC bytes. Returns a cache payload."""
    lower = urllib.parse.urlparse(url).path.lower()
    if lower.endswith(".pdf") or data[:4] == b"%PDF":
        try:
            import io

            from pypdf import PdfReader

            reader = PdfReader(io.BytesIO(data))
            pages = [(page.extract_text() or "") for page in reader.pages]
            text = clean_pdf_pages(pages)
            return {
                "status": "full" if len(text) >= 300 else "scanned",
                "method": "pypdf",
                "pages": len(pages),
                "text": text,
            }
        except Exception as exc:  # pragma: no cover - depends on PDFs
            return {"status": "error", "method": "pypdf", "error": str(exc), "text": ""}
    if lower.endswith(".docx"):
        try:
            import io

            import docx

            document = docx.Document(io.BytesIO(data))
            text = clean_text("\n\n".join(p.text for p in document.paragraphs))
            return {"status": "full" if text else "empty", "method": "python-docx", "text": text}
        except Exception as exc:  # pragma: no cover
            return {"status": "error", "method": "python-docx", "error": str(exc), "text": ""}
    if lower.endswith(".doc") or lower.endswith(".rtf"):
        return _extract_legacy_doc(url, data)
    return {"status": "unsupported", "method": None, "text": ""}


def _extract_legacy_doc(url: str, data: bytes) -> dict[str, Any]:
    """Best-effort extraction for old .doc files.

    LibreOffice (soffice) or catdoc is used when available. Neither is a
    Python dependency, so the crawler still works without them: such
    documents are indexed by metadata and linked to the official file.
    """
    import shutil
    import subprocess
    import tempfile
    from pathlib import Path as _Path

    suffix = ".doc" if url.lower().split("?")[0].endswith(".doc") else ".rtf"
    with tempfile.TemporaryDirectory() as tmp:
        src = _Path(tmp) / f"input{suffix}"
        src.write_bytes(data)
        if shutil.which("soffice") or shutil.which("libreoffice"):
            binary = shutil.which("soffice") or shutil.which("libreoffice")
            try:
                subprocess.run(
                    [binary, "--headless", "--convert-to", "txt:Text", "--outdir", tmp, str(src)],
                    check=True,
                    capture_output=True,
                    timeout=120,
                )
                out = _Path(tmp) / "input.txt"
                if out.exists():
                    text = clean_text(out.read_text(encoding="utf-8", errors="ignore"))
                    return {"status": "full" if text else "empty", "method": "soffice", "text": text}
            except Exception as exc:  # pragma: no cover
                log.debug("soffice failed for %s: %s", url, exc)
        if shutil.which("catdoc"):
            try:
                result = subprocess.run(
                    ["catdoc", "-w", str(src)],
                    check=True,
                    capture_output=True,
                    timeout=120,
                )
                text = clean_text(result.stdout.decode("utf-8", errors="ignore"))
                return {"status": "full" if text else "empty", "method": "catdoc", "text": text}
            except Exception as exc:  # pragma: no cover
                log.debug("catdoc failed for %s: %s", url, exc)
    return {"status": "unsupported", "method": None, "text": ""}


def fetch_text_for(
    doc: dict[str, Any],
    client: HttpClient,
    *,
    force: bool = False,
    max_bytes: int = 80 * 1024 * 1024,
) -> dict[str, Any]:
    url = doc.get("pdf_url") or doc.get("source_url") or ""
    if not url:
        return {"status": "metadata", "method": None, "text": ""}
    if not force:
        cached = _read_text_cache(url)
        if cached is not None:
            return cached
    try:
        response = client.get(url)
        if len(response.content) > max_bytes:
            payload = {"status": "too_large", "method": None, "text": "", "bytes": len(response.content)}
        else:
            payload = extract_document_text(url, response.content)
            payload["bytes"] = len(response.content)
        _write_text_cache(url, payload)
        return payload
    except Exception as exc:  # pragma: no cover - network failures
        log.warning("text extraction failed for %s: %s", url, exc)
        payload = {"status": "error", "method": None, "error": str(exc), "text": ""}
        _write_text_cache(url, payload)
        return payload


def merge_documents(catalogs: Iterable[list[dict[str, Any]]]) -> list[dict[str, Any]]:
    """Merge documents from different sources, preferring official consolidated text.

    A document is considered the same when its type and number match (for
    example ``yasa`` + ``1/1998``). The government copy wins for title, text
    and primary URL; mahkemeler metadata is kept in ``sources``.
    """
    merged: dict[str, dict[str, Any]] = {}
    for docs in catalogs:
        for doc in docs:
            doc = dict(doc)
            doc["type"] = doc.get("type") or "yasa"
            number = doc.get("number")
            pkey = (doc.get("extra") or {}).get("pkey")
            if doc["type"] == "karar":
                # Court decisions frequently share a case number; the row key is
                # the only stable identity.
                base_id = (
                    f"karar-{slugify(str(number), max_len=24)}-{pkey}"
                    if number and pkey
                    else (f"karar-{pkey}" if pkey else make_doc_id("karar", None, doc.get("title", "")))
                )
            else:
                base_id = make_doc_id(
                    doc["type"],
                    number,
                    doc.get("title", ""),
                    fallback=str(pkey or ""),
                )
            if doc.get("language") == "en" and not base_id.endswith("-en"):
                base_id += "-en"
            existing = merged.get(base_id)
            if existing is None:
                doc["_id"] = base_id
                doc["sources"] = [_source_ref(doc)]
                merged[base_id] = doc
                continue
            # Same document from the other source.
            existing.setdefault("sources", []).append(_source_ref(doc))
            for key in ("court", "parties", "subject", "summary", "date", "year", "number"):
                if not existing.get(key) and doc.get(key):
                    existing[key] = doc[key]
            existing.setdefault("extra", {})
            for key, value in (doc.get("extra") or {}).items():
                existing["extra"].setdefault(key, value)
            if doc.get("source") == "gov":
                # Government consolidated text is authoritative.
                existing["title"] = doc.get("title") or existing.get("title")
                existing["source"] = "gov"
                existing["source_url"] = doc.get("source_url") or existing.get("source_url")
                existing["pdf_url"] = doc.get("pdf_url") or existing.get("pdf_url")
                if doc.get("content"):
                    existing["content"] = doc["content"]
                existing["extra"].update({k: v for k, v in (doc.get("extra") or {}).items() if v})
            elif not existing.get("content") and doc.get("content"):
                existing["content"] = doc["content"]
            existing["_id"] = base_id
    return list(merged.values())


def _source_ref(doc: dict[str, Any]) -> dict[str, Any]:
    return {
        "source": doc.get("source"),
        "url": doc.get("source_url"),
        "pdf_url": doc.get("pdf_url"),
        "pkey": (doc.get("extra") or {}).get("pkey"),
    }


def attach_texts(
    docs: list[dict[str, Any]],
    client: HttpClient,
    *,
    limit: int = 0,
    types: Optional[set[str]] = None,
    force: bool = False,
) -> int:
    """Download and cache text for documents that only have a file URL."""
    done = 0
    for doc in docs:
        if limit and done >= limit:
            break
        if types and doc.get("type") not in types:
            continue
        if doc.get("content") and len(doc["content"]) > 500:
            continue
        if not doc.get("pdf_url"):
            continue
        payload = fetch_text_for(doc, client, force=force)
        if payload.get("text"):
            doc["content"] = payload["text"]
            doc.setdefault("extra", {})["extraction"] = {
                "status": payload.get("status"),
                "method": payload.get("method"),
                "bytes": payload.get("bytes"),
            }
            done += 1
            log.info("text %s (%s, %d chars)", doc.get("_id"), payload.get("status"), len(payload["text"]))
    return done
