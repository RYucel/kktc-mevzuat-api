"""Configuration and shared paths for the KKTC mevzuat crawler."""

from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = Path(os.getenv("KKTC_DATA_DIR", ROOT / "data"))
CATALOG_DIR = DATA_DIR / "catalog"
RAW_DIR = DATA_DIR / "raw"
TEXT_DIR = DATA_DIR / "text"
DIST_DIR = ROOT / "dist"
DB_PATH = Path(os.getenv("KKTC_DB_PATH", DATA_DIR / "kktc.db"))

GOV_BASE = "https://mevzuat.gov.ct.tr"
MAHKEMELER_BASE = "https://mevzuat.mahkemeler.net"

# A realistic browser UA is required: the mahkemeler.net edge rejects
# obviously automated user agents. We still identify ourselves politely
# through the From / X-Client headers and keep the crawl rate low.
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)
CONTACT = os.getenv("KKTC_CONTACT", "https://github.com/kktc-mevzuat/kktc-mevzuat-api")

REQUEST_DELAY = float(os.getenv("KKTC_REQUEST_DELAY", "1.0"))
TIMEOUT = float(os.getenv("KKTC_TIMEOUT", "90"))
MAX_RETRIES = int(os.getenv("KKTC_MAX_RETRIES", "3"))

# Public "login without registration" guest account published by the site's
# own login page (ozeljs/yonetimgiris.js). Override with your own account if
# the guest account is disabled.
GUEST_USER = os.getenv("KKTC_GUEST_USER", "z")
GUEST_PASS = os.getenv("KKTC_GUEST_PASS", "1")

GOV_CATEGORIES = {
    "ANAYASA": "anayasa",
    "YASALAR": "yasa",
    "TÜZÜKLER": "tuzuk",
    "YÖNETMELİKLER": "yonetmelik",
    "EMİRNAMELER": "emirname",
    "KARARNAMELER": "kararname",
    "ULUSLARARASI-ANDLAŞMALAR": "andlasma",
}

TYPE_LABELS = {
    "anayasa": "Anayasa",
    "yasa": "Yasa",
    "tuzuk": "Tüzük",
    "yonetmelik": "Yönetmelik",
    "emirname": "Emirname",
    "kararname": "Kararname",
    "andlasma": "Uluslararası Andlaşma",
    "karar": "Mahkeme Kararı",
}


def ensure_dirs() -> None:
    for path in (DATA_DIR, CATALOG_DIR, RAW_DIR, TEXT_DIR, DIST_DIR):
        path.mkdir(parents=True, exist_ok=True)
