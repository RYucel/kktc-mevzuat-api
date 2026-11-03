from __future__ import annotations

from pathlib import Path

import pytest

from kktc import sources
from kktc.sources import fetch_text_for

URL = "https://mevzuat.gov.ct.tr/Portals/48/ATESLI SILAHLAR YASASI.pdf"


class FakeResponse:
    def __init__(self, content: bytes):
        self.content = content
        self.headers: dict[str, str] = {}


class FakeServer:
    """Serves one file; counts downloads and extractions."""

    def __init__(self, content: bytes):
        self.content = content
        self.gets = 0

    def get(self, url: str, **kwargs):
        self.gets += 1
        return FakeResponse(self.content)


@pytest.fixture()
def extractions(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> list[bytes]:
    seen: list[bytes] = []

    def fake_extract(url: str, data: bytes) -> dict:
        seen.append(data)
        return {"status": "full", "method": "fake", "text": data.decode("utf-8")}

    monkeypatch.setattr(sources, "TEXT_DIR", tmp_path / "text")
    monkeypatch.setattr(sources, "extract_document_text", fake_extract)
    return seen


def test_same_name_new_content_is_extracted_again(extractions: list[bytes]) -> None:
    doc = {"pdf_url": URL}
    server = FakeServer(b"eski metin")
    assert fetch_text_for(doc, server)["text"] == "eski metin"

    # Same bytes: downloaded and compared, but not extracted again.
    assert fetch_text_for(doc, server, revalidate=True)["text"] == "eski metin"
    assert server.gets == 2 and len(extractions) == 1

    # Replaced under the same name.
    server.content = b"yeni metin"
    assert fetch_text_for(doc, server, revalidate=True)["text"] == "yeni metin"
    assert len(extractions) == 2
    assert sources._read_text_cache(URL)["text"] == "yeni metin"

    # Without --revalidate the cache is trusted as before.
    server.content = b"daha yeni"
    assert fetch_text_for(doc, server)["text"] == "yeni metin"
    assert server.gets == 3


def test_old_cache_entries_get_a_fingerprint_without_reextraction(extractions: list[bytes]) -> None:
    doc = {"pdf_url": URL}
    sources._write_text_cache(URL, {"status": "full", "method": "pypdf", "text": "eski metin"})
    server = FakeServer(b"dosya baytlari")
    assert fetch_text_for(doc, server, revalidate=True)["text"] == "eski metin"
    assert extractions == []
    assert sources._read_text_cache(URL)["sha256"]

    # From the next run on, a change is detected.
    server.content = b"degismis dosya"
    assert fetch_text_for(doc, server, revalidate=True)["text"] == "degismis dosya"


def test_failed_download_keeps_cached_text(extractions: list[bytes]) -> None:
    doc = {"pdf_url": URL}
    server = FakeServer(b"eski metin")
    fetch_text_for(doc, server)

    class Down:
        def get(self, url: str, **kwargs):
            raise RuntimeError("timeout")

    assert fetch_text_for(doc, Down(), revalidate=True)["text"] == "eski metin"


def test_failed_downloads_are_retried_on_revalidation(extractions: list[bytes]) -> None:
    doc = {"pdf_url": URL}
    sources._write_text_cache(URL, {"status": "error", "method": None, "error": "HTTP 503", "text": ""})
    server = FakeServer(b"simdi var")
    # A normal run trusts the cache, including the error.
    assert fetch_text_for(doc, server)["status"] == "error"
    # A revalidation run tries again.
    assert fetch_text_for(doc, server, revalidate=True)["text"] == "simdi var"
