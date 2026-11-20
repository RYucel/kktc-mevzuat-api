"""Train the query adapter: a 192x192 linear map on query embeddings.

Pairs come from the synthetic citizen questions (questions.jsonl.gz, made
from article text only, never from the eval sets): each question should land
on its own article's stored vector. The article vectors are not changed.

Data (cached in data/adapter-cache, kept on the "history" release):
  articles.npz   stored article vectors, fetched via /admin/vectors/get
  queries.npz    question embeddings as searched, via /admin/embed-queries

Training: in-batch softmax (InfoNCE) with temperature TAU, Adam, a penalty
keeping W near the identity; 10% of articles held out (by key hash). The
report compares article recall@10 over all article vectors for held-out
questions with and without the adapter.

Env: BASE, ADMIN_TOKEN. Output: data/adapter.json ({w, metrics}).
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "crawler"))
from kktc import vectors  # noqa: E402

BASE = os.environ.get("BASE", "https://kktc-mevzuat-api.stevevaius.workers.dev")
TOKEN = os.environ.get("ADMIN_TOKEN", "")
DATA = Path("data")
CACHE = DATA / "adapter-cache"
DIMS = 192
TAU = float(os.environ.get("TAU", "0.05"))
EPOCHS = int(os.environ.get("EPOCHS", "6"))
BATCH = 512
LR = float(os.environ.get("LR", "0.002"))
REG = float(os.environ.get("REG", "0.01"))


def post(path: str, body: dict, attempts: int = 4) -> dict:
    data = json.dumps(body).encode()
    for attempt in range(attempts):
        req = urllib.request.Request(
            BASE + path, data=data, method="POST",
            # Cloudflare answers Python-urllib's default user agent with 1010 (blocked signature).
            headers={"authorization": f"Bearer {TOKEN}", "content-type": "application/json", "user-agent": "kktc-mevzuat-adapter/1.0"},
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode()[:200]
            if exc.code in (400, 401, 429) or attempt == attempts - 1:
                raise RuntimeError(f"{path}: HTTP {exc.code} {detail}") from exc
        except (urllib.error.URLError, TimeoutError) as exc:
            if attempt == attempts - 1:
                raise RuntimeError(f"{path}: {exc}") from exc
        time.sleep(2 * (attempt + 1))
    raise RuntimeError("unreachable")


def load_npz(path: Path) -> dict[str, np.ndarray]:
    if not path.exists():
        return {}
    z = np.load(path, allow_pickle=False)
    return {k: v for k, v in zip(z["keys"].tolist(), z["vectors"])}


def save_npz(path: Path, table: dict[str, np.ndarray]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    keys = list(table)
    np.savez_compressed(path, keys=np.array(keys), vectors=np.stack([table[k] for k in keys]).astype(np.float32))


def fetch(table: dict[str, np.ndarray], wanted: list[str], size: int, call, path: Path, workers: int) -> None:
    missing = [k for k in wanted if k not in table]
    print(f"{path.name}: {len(wanted) - len(missing)} cached, {len(missing)} to fetch", flush=True)
    groups = [missing[i : i + size] for i in range(0, len(missing), size)]
    done = 0
    with ThreadPoolExecutor(workers) as pool:
        for got in pool.map(call, groups):
            table.update(got)
            done += 1
            if done % 100 == 0:
                save_npz(path, table)
                print(f"  {done}/{len(groups)} calls", flush=True)
    save_npz(path, table)


def recall_at(q: np.ndarray, targets: np.ndarray, articles: np.ndarray, k: int = 10) -> float:
    hits = 0
    for i in range(0, len(q), 1024):
        s = q[i : i + 1024] @ articles.T
        top = np.argpartition(-s, k, axis=1)[:, :k]
        hits += int((top == targets[i : i + 1024, None]).any(axis=1).sum())
    return hits / max(1, len(q))


def normalise(m: np.ndarray) -> np.ndarray:
    return m / np.maximum(np.linalg.norm(m, axis=1, keepdims=True), 1e-9)


def main() -> None:
    units = vectors.load_units(DATA / "vector-units.jsonl.gz")
    asked = vectors.load_questions(DATA / "questions.jsonl.gz")
    pairs: list[tuple[str, str, str]] = []  # (unit id, question, article key)
    for u in units:
        text = u["text"].split(vectors.QUESTIONS_SUFFIX)[0]
        if "\n" not in text:
            continue
        key = vectors.question_key(u["doc_id"], u["ref"], text.split("\n", 1)[1])
        for q in asked.get(key, []):
            pairs.append((u["id"], q, key))
    print(f"units {len(units)}, pairs {len(pairs)}", flush=True)

    art_path, q_path = CACHE / "articles.npz", CACHE / "queries.npz"
    articles = load_npz(art_path)
    fetch(
        articles, [u["id"] for u in units], 20,
        lambda ids: {v["id"]: np.array(v["values"], dtype=np.float32) for v in post("/admin/vectors/get", {"ids": ids})["vectors"]},
        art_path, 8,
    )
    qkey = lambda q: hashlib.sha1(q.encode()).hexdigest()  # noqa: E731
    queries = load_npz(q_path)
    texts = {qkey(q): q for _, q, _ in pairs}

    def embed(keys: list[str]) -> dict[str, np.ndarray]:
        out = post("/admin/embed-queries", {"texts": [texts[k] for k in keys]})["vectors"]
        return {k: np.array(v, dtype=np.float32) for k, v in zip(keys, out)}

    fetch(queries, list(texts), 64, embed, q_path, 4)

    ids = [u["id"] for u in units if u["id"] in articles]
    index = {i: n for n, i in enumerate(ids)}
    A = normalise(np.stack([articles[i] for i in ids]))
    rows = [(index[uid], qkey(q), akey) for uid, q, akey in pairs if uid in index and qkey(q) in queries]
    held = lambda akey: int(akey[:4], 16) % 10 == 0  # noqa: E731
    train = [r for r in rows if not held(r[2])]
    val = [r for r in rows if held(r[2])]
    Qt = normalise(np.stack([queries[k] for _, k, _ in train]))
    Tt = np.array([a for a, _, _ in train])
    Qv = normalise(np.stack([queries[k] for _, k, _ in val]))
    Tv = np.array([a for a, _, _ in val])
    print(f"train {len(train)}, held-out {len(val)} questions", flush=True)

    base = {"val_r10": recall_at(Qv, Tv, A), "train_r10": recall_at(Qt[:5000], Tt[:5000], A)}
    print("identity:", base, flush=True)

    rng = np.random.default_rng(7)
    W = np.eye(DIMS, dtype=np.float32)
    m = np.zeros_like(W)
    v = np.zeros_like(W)
    step = 0
    best = (base["val_r10"], W.copy(), 0)
    for epoch in range(1, EPOCHS + 1):
        order = rng.permutation(len(Qt))
        for i in range(0, len(order), BATCH):
            b = order[i : i + BATCH]
            q, a = Qt[b], A[Tt[b]]
            z = q @ W.T  # adapted queries (not normalised: the scale is learnt with TAU)
            s = (z @ a.T) / TAU
            s -= s.max(axis=1, keepdims=True)
            p = np.exp(s)
            p /= p.sum(axis=1, keepdims=True)
            g = (p - np.eye(len(b), dtype=np.float32)) / (TAU * len(b))  # dL/dS
            grad = (g @ a).T @ q + REG * (W - np.eye(DIMS, dtype=np.float32))
            step += 1
            m = 0.9 * m + 0.1 * grad
            v = 0.999 * v + 0.001 * grad * grad
            W -= LR * (m / (1 - 0.9**step)) / (np.sqrt(v / (1 - 0.999**step)) + 1e-8)
        val_r = recall_at(normalise(Qv @ W.T), Tv, A)
        print(f"epoch {epoch}: held-out r@10 {val_r:.4f}", flush=True)
        if val_r > best[0]:
            best = (val_r, W.copy(), epoch)

    val_r, W, epoch = best
    metrics = {
        "pairs": len(rows),
        "train": len(train),
        "held_out": len(val),
        "identity_val_r10": round(base["val_r10"], 4),
        "adapter_val_r10": round(val_r, 4),
        "adapter_train_r10": round(recall_at(normalise(Qt[:5000] @ W.T), Tt[:5000], A), 4),
        "best_epoch": epoch,
        "tau": TAU,
        "lr": LR,
        "reg": REG,
    }
    print(json.dumps(metrics, indent=2), flush=True)
    out = {"version": time.strftime("%Y-%m-%d"), "dims": DIMS, "metrics": metrics,
           "w": [[round(float(x), 5) for x in row] for row in W] if epoch else None}
    (DATA / "adapter.json").write_text(json.dumps(out), encoding="utf-8")


if __name__ == "__main__":
    main()
