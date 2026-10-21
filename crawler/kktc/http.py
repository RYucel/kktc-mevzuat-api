"""Small, polite HTTP client used by both source adapters."""

from __future__ import annotations

import logging
import random
import threading
import time
from typing import Any, Optional

import requests
import urllib3

from .config import (
    CONTACT,
    GUEST_PASS,
    GUEST_USER,
    MAX_RETRIES,
    REQUEST_DELAY,
    TIMEOUT,
    USER_AGENT,
)

log = logging.getLogger(__name__)

# The government site is served with an incomplete TLS chain (the
# intermediate certificate is not sent). Browsers repair this via AIA, Python
# does not, so we fall back to an unverified connection *for that public,
# read-only host only*. No credentials are ever sent there.
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)


class FetchError(RuntimeError):
    pass


class HttpClient:
    def __init__(self, base_url: str, *, verify: bool = True, delay: float = REQUEST_DELAY):
        self.base_url = base_url.rstrip("/")
        self.verify = verify
        self.delay = delay
        self.session = requests.Session()
        self.session.headers.update(
            {
                "User-Agent": USER_AGENT,
                "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.6",
                "From": CONTACT,
                "X-Client": "kktc-mevzuat-api/1.0 (open data indexer)",
            }
        )
        self._lock = threading.Lock()
        self._last_request = 0.0

    def _throttle(self) -> None:
        with self._lock:
            wait = self.delay - (time.monotonic() - self._last_request)
            if wait > 0:
                time.sleep(wait)
            self._last_request = time.monotonic()

    def request(self, method: str, url: str, **kwargs: Any) -> requests.Response:
        if not url.startswith("http"):
            url = f"{self.base_url}/{url.lstrip('/')}"
        kwargs.setdefault("timeout", TIMEOUT)
        kwargs.setdefault("verify", self.verify)
        last_error: Optional[Exception] = None
        for attempt in range(MAX_RETRIES + 1):
            self._throttle()
            try:
                response = self.session.request(method, url, **kwargs)
            except requests.RequestException as exc:  # network / TLS
                last_error = exc
            else:
                if response.status_code in (429, 500, 502, 503, 504):
                    last_error = FetchError(f"HTTP {response.status_code} for {url}")
                elif response.status_code >= 400:
                    raise FetchError(f"HTTP {response.status_code} for {url}")
                else:
                    return response
            if attempt < MAX_RETRIES:
                backoff = min(30.0, (2**attempt) + random.random())
                log.warning("%s - retrying in %.1fs", last_error, backoff)
                time.sleep(backoff)
        raise FetchError(f"Could not fetch {url}: {last_error}")

    def get(self, url: str, **kwargs: Any) -> requests.Response:
        return self.request("GET", url, **kwargs)

    def post(self, url: str, **kwargs: Any) -> requests.Response:
        return self.request("POST", url, **kwargs)


class MahkemelerClient(HttpClient):
    """Session-aware client for the login-gated KKTC Mahkemeler system.

    The public site exposes a "Kayıt Olmadan Giriş" (login without
    registration) button. It simply posts the guest credentials to
    /Yonetimgiris/loginControl; we reproduce that flow.
    """

    def __init__(self, base_url: str):
        super().__init__(base_url, verify=True)
        self._logged_in = False

    def login(self, *, force: bool = False) -> None:
        if self._logged_in and not force:
            return
        # A GET on an index page must happen first: it creates the ASP.NET
        # session cookie that the login endpoint then binds to.
        self.get("/MEVZUAT/Yasa/index")
        response = self.post(
            "/Yonetimgiris/loginControl",
            data={
                "kullaniciad": GUEST_USER,
                "kullanicisifre": GUEST_PASS,
                "kod": "",
                "remember": "false",
            },
            headers={"X-Requested-With": "XMLHttpRequest"},
        )
        try:
            payload = response.json()
        except ValueError as exc:
            raise FetchError("Guest login did not return JSON (site changed?)") from exc
        if payload.get("durum") != "Kaydedildi":
            raise FetchError(f"Guest login rejected: {payload}")
        self._logged_in = True
        log.info("mahkemeler.net guest session established")

    def grid(self, path: str, data: dict[str, Any], *, retry_login: bool = True) -> dict[str, Any]:
        self.login()
        payload = {
            "draw": 1,
            "start": 0,
            "length": 500,
            "NeyeGore": "arama",
            "order[0][column]": "0",
            "order[0][dir]": "asc",
            "search[value]": "",
        }
        payload.update(data)
        response = self.post(
            path,
            data=payload,
            headers={"X-Requested-With": "XMLHttpRequest", "Accept": "application/json"},
        )
        content_type = response.headers.get("content-type", "")
        if "json" not in content_type and retry_login:
            log.warning("Session expired, logging in again")
            self.login(force=True)
            return self.grid(path, data, retry_login=False)
        try:
            return response.json()
        except ValueError as exc:
            raise FetchError(f"Grid endpoint {path} returned non-JSON") from exc
