from __future__ import annotations

import argparse

import pytest

from kktc import cli
from kktc.http import FetchError, HttpClient


def _crawl_gov_only(monkeypatch, tmp_path, crawl):
    saved = {}
    monkeypatch.setattr(cli, "ensure_dirs", lambda: None)
    monkeypatch.setattr(cli, "crawl_gov", crawl)
    monkeypatch.setattr(cli, "save_catalog", lambda name, docs: saved.setdefault(name, docs))
    return saved


def test_unreachable_gov_site_keeps_the_previous_catalog(monkeypatch, tmp_path):
    def down(client):
        raise FetchError("Could not fetch https://mevzuat.gov.ct.tr/MEVZUAT/ANAYASA: Read timed out")

    saved = _crawl_gov_only(monkeypatch, tmp_path, down)
    monkeypatch.setattr(cli, "load_catalog", lambda name: [{"title": "ANAYASA"}] if name == "gov" else [])
    cli.cmd_crawl(argparse.Namespace(source="gov", only="all"))
    assert saved == {}  # the previous gov.json is left as it is


def test_unreachable_gov_site_without_a_previous_catalog_fails(monkeypatch, tmp_path):
    # Building without gov documents would reset D1 and publish a partial corpus
    def down(client):
        raise FetchError("Read timed out")

    _crawl_gov_only(monkeypatch, tmp_path, down)
    monkeypatch.setattr(cli, "load_catalog", lambda name: [])
    with pytest.raises(FetchError):
        cli.cmd_crawl(argparse.Namespace(source="gov", only="all"))


def test_gov_client_waits_longer_than_the_default(monkeypatch):
    seen = {}

    def crawl(client):
        seen["timeout"] = client.timeout
        return [{"title": "ANAYASA"}]

    _crawl_gov_only(monkeypatch, None, crawl)
    cli.cmd_crawl(argparse.Namespace(source="gov", only="all"))
    assert seen["timeout"] >= 240
    assert HttpClient("https://example.org").timeout < seen["timeout"]
