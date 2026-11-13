"""Subject categories for statutes (OPUS-GOREVLER-4 item 19).

Laws and the constitution are assigned by hand in categories/statutes.jsonl
(from their titles; the question sets are never read). Regulations take the
categories of the law they are made under (parent_law); a regulation
without a known parent, and any statute missing from the file, is assigned
from title keywords below, else "diger".
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Iterable

FALLBACK = "diger"

_FOLD = str.maketrans("çğıöşüâîû", "cgiosuaiu")


def fold(text: str) -> str:
    return text.replace("I", "ı").replace("İ", "i").lower().translate(_FOLD)


# Title keywords (folded, word-start anchored). Used only where the file and
# the parent law say nothing.
TITLE_RULES: list[tuple[str, str]] = [
    ("aile", r"\baile|\bevlen|\bbosan|\bnafaka|\bcocuk(lar)?\b|\bcocuklar|\bevlat|\bvelayet|\bnesep|\bevlilik disi|\bkoruyucu aile|\bkadin|\bsiddet"),
    ("ceza", r"\bceza\b|\bceza yasasi|\bcezaevi|\bsartli tahliye|\buyusturucu|\bsilah|\bpatlayici|\bterör|\bteror|\bsuc gelir|\baklanma|\bsabika|\bceza muhakeme|\bbilisim suc|\bozel hayat|\bkumar|\bsans oyun|\bpolis|\binfaz"),
    ("is-sosyal-guvenlik", r"\bis yasasi|\bisci|\bisveren|\bis yasasi|\bisci|\bcalisma (yasa|\bizin|\bsaat|\bkosul)|\bcalisanlar|\bsendika|\btoplu is|\basgari ucret|\bsosyal sigorta|\bsosyal guvenlik|\bihtiyat sandigi|\bemeklilik|\bis sagligi|\bissizlik|\bmesleki egitim|\bciraklik|\bisgucu"),
    ("vergi", r"\bvergi|\bkatma deger|\bgelir vergisi|\bkurumlar|\bharc|\bpul\b|\bgumruk|\bresim|\bstopaj|\btesvik"),
    ("ticaret-sirketler", r"\bsirket|\bticaret|\bticari|\bkooperatif|\bbanka|\bsigorta hizmet|\bsigorta\b|\biflas|\bmarka|\bpatent|\brekabet|\bborsa|\bsermaye piyasa|\bfinans|\bkredi|\bodalar|\bodasi|\bkambiyo|\bpara ve|\byatirim|\bserbest liman|\bsanayi|\besnaf|\bzanaat|\bturizm|\botel|\bkumarhane"),
    ("tasinmaz-kira", r"\btasinmaz|\bkira|\bkat mulkiyet|\btapu|\bkadastro|\bimar|\barazi|\barsa|\bkonut|\biskan|\besdegerlik|\bmulkiyet|\binsaat|\byapi\b|\byapi insaat|\bbina|\bemlak"),
    ("tuketici", r"\btuketici|\bmal ve hizmet|\bfiyat|\betiket|\breklam|\bgida|\bkozmetik|\burun guvenligi|\btutun"),
    ("idare-kamu-gorevlileri", r"\bkamu gorevli|\bkamu hizmet|\bpersonel|\bdaire(si)?\b|\bkurulus, gorev|\bkurulus gorev|\bbakanlik|\bbelediye|\byerel yonetim|\bust kademe|\bidare|\bvakif|\bvakiflar|\bkamu mali|\bihale|\bdenetleme|\bombudsman|\bbilgi edinme|\biyi idare|\bdevlet|\bmuhtar|\bkaymakam|\bcumhurbaskanligi|\bmeclis"),
    ("trafik-ulasim", r"\btrafik|\bmotorlu arac|\bsurucu|\behliyet|\byol\b|\byollar|\btasimacilik|\bulastirma|\bliman|\bhavacilik|\bhava|\bgemi|\bdeniz|\btaksi|\botobus"),
    ("saglik", r"\bsagli[kg]|\bhastane|\btabip|\bdoktor|\bhekim|\beczaci|\bilac|\bbulasici|\bkan\b|\borgan\b|\borgan nakli|\bdoku\b|\bdokular|\btibbi|\bhemsire|\bdis hekim|\bpsikolog|\bveteriner"),
    ("egitim", r"\begitim|\bogretim|\buniversite|\bokul|\bogretmen|\bakademi|\bburs|\byuksek ogrenim|\bogrenci"),
    ("cevre-tarim-hayvan", r"\bcevre|\btarim|\bhayvan|\borman|\bav\b|\bavlanma|\bbal(ik|\bikci)|\bsu\b|\bsular|\bzeytin|\bbitki|\btohum|\borganik|\bveteriner|\bkimyasal|\batik|\benerji|\bmaden|\bziraat|\bsulama|\bmeralar|\bhayvanlar"),
    ("yabancilar-yurttaslik", r"\byabanci|\byurttas|\bmuhaceret|\bikamet|\bvize|\bpasaport|\bnufus|\bkimlik|\bseyahat"),
    ("yargilama-icra", r"\bmahkeme|\byargi|\bhukuk muhakeme|\bicra|\bavukat|\bnoter|\btasdik|\bhakem|\btahkim|\badli|\byargitay|\bsavci|\bbaro|\bdelil|\bsahadet|\bkefalet|\btebligat"),
    ("secim-siyaset", r"\bsecim|\bhalkoylama|\bsiyasal parti|\bsiyasi parti|\bmilletvekil|\banayasa|\bbayrak|\bmarsi|\bdernek|\bbasin|\byayin|\bradyo|\btelevizyon"),
]
_COMPILED = [(c, re.compile(rx)) for c, rx in TITLE_RULES]


def title_categories(title: str) -> list[str]:
    folded = fold(title)
    return [c for c, rx in _COMPILED if rx.search(folded)]


def load_categories(directory: Path) -> tuple[set[str], dict[str, list[str]]]:
    """Known category ids and the hand-made statute assignments."""
    directory = Path(directory)
    ids: set[str] = set()
    assigned: dict[str, list[str]] = {}
    index = directory / "categories.json"
    if index.exists():
        ids = {item["id"] for item in json.loads(index.read_text(encoding="utf-8"))}
    statutes = directory / "statutes.jsonl"
    if statutes.exists():
        for line in statutes.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            cats = [c for c in row.get("categories") or [] if not ids or c in ids]
            if cats:
                assigned[row["doc"]] = cats
    return ids, assigned


def assign(
    doc_id: str,
    doc_type: str,
    title: str,
    parent: str | None,
    assigned: dict[str, list[str]],
    aliases: Iterable[str] = (),
) -> tuple[list[str], str]:
    """Categories for one statute and where they came from (file/parent/title/fallback)."""
    for key in (doc_id, *aliases):
        if key in assigned:
            return assigned[key], "file"
    if doc_type == "tuzuk" and parent and parent in assigned:
        return assigned[parent], "parent"
    found = title_categories(title)
    if found:
        return found, "title"
    return [FALLBACK], "fallback"
