from __future__ import annotations

from pathlib import Path

import pytest

from kktc import sources
from kktc.sources import fetch_text_for, validators_changed

URL = "https://mevzuat.gov.ct.tr/YASALAR/1-2024 MALI YASA.pdf"


class FakeResponse:
    def __init__(self, content: bytes, headers: dict[str, str]):
        self.content = content
        self.headers = headers


class FakeServer:
    """Serves one file; counts GETs so tests can tell download from cache."""

    def __init__(self, content: bytes, headers: dict[str, str]):
        self.content = content
        self.headers = headers
        self.gets = 0
        self.heads = 0

    def get(self, url: str, **kwargs):
        self.gets += 1
        return FakeResponse(self.content, self.headers)

    def request(self, method: str, url: str, **kwargs):
        assert method == "HEAD"
        self.heads += 1
        return FakeResponse(b"", self.headers)


@pytest.fixture(autouse=True)
def isolated_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sources, "TEXT_DIR", tmp_path / "text")
    monkeypatch.setattr(
        sources,
        "extract_document_text",
        lambda url, data: {"status": "full", "method": "fake", "text": data.decode("utf-8")},
    )


def test_validators_changed_prefers_strongest() -> None:
    assert validators_changed({"etag": "a", "content-length": "1"}, {"etag": "b", "content-length": "1"})
    assert not validators_changed({"etag": "a", "content-length": "1"}, {"etag": "a", "content-length": "2"})
    assert validators_changed({"content-length": "1"}, {"content-length": "2"})
    assert not validators_changed({"etag": "a"}, {"last-modified": "x"})


def test_same_name_new_content_is_downloaded_again() -> None:
    doc = {"pdf_url": URL}
    server = FakeServer(b"eski metin", {"etag": '"v1"', "content-length": "10"})
    assert fetch_text_for(doc, server)["text"] == "eski metin"

    # Unchanged on the server: HEAD only, cached text returned.
    assert fetch_text_for(doc, server, revalidate=True)["text"] == "eski metin"
    assert (server.gets, server.heads) == (1, 1)

    # Replaced under the same name.
    server.content, server.headers = b"yeni metin", {"etag": '"v2"', "content-length": "10"}
    assert fetch_text_for(doc, server, revalidate=True)["text"] == "yeni metin"
    assert server.gets == 2

    # Without --revalidate the cache is trusted as before.
    server.content, server.headers = b"daha yeni", {"etag": '"v3"'}
    assert fetch_text_for(doc, server)["text"] == "yeni metin"


def test_old_cache_entries_get_validators_without_download() -> None:
    doc = {"pdf_url": URL}
    sources._write_text_cache(URL, {"status": "full", "method": "pypdf", "text": "eski metin"})
    server = FakeServer(b"ayni", {"last-modified": "Mon, 02 Nov 2026 10:00:00 GMT"})
    assert fetch_text_for(doc, server, revalidate=True)["text"] == "eski metin"
    assert server.gets == 0
    assert sources._read_text_cache(URL)["validators"] == {"last-modified": "Mon, 02 Nov 2026 10:00:00 GMT"}
