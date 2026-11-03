# KKTC Mevzuat API

Kuzey Kıbrıs Türk Cumhuriyeti'nin **yürürlükteki yasaları, tüzükleri, anayasa metinleri ve
mahkeme kararları** için anahtarsız, salt-okunur ve LLM-dostu bir arama API'si.

**Canlı API:** <https://kktc-mevzuat-api.stevevaius.workers.dev><br>
**LLM rehberi:** <https://kktc-mevzuat-api.stevevaius.workers.dev/llms.txt>

- Türkçe diakritikten bağımsız tam metin arama (SQLite FTS5, `ı/i`, `ş/s`, `ğ/g`, `ü/u`, `ö/o`, `ç/c`)
- Madde bazlı erişim: `GET /v1/documents/yasa-1-1998/articles/4`
- Her sonuçta hazır atıf (`citation`): mahkeme, E./D. numarası ve tarih LLM'in uydurmadığı künyeden gelir
- Haftalık sürüm takibi: `GET /v1/changes` ve `GET /v1/documents/{id}/changes`
  (madde bazlı eski/yeni metin, yeşil/kırmızı görüntüleyici: `/degisiklikler`)
- LLM'ler için Markdown çıktısı, `llms.txt`, OpenAPI 3.1 ve MCP araçları
- İki çalışma ortamı: **Cloudflare Workers + D1** (birincil) ve **Node 22 + node:sqlite**
  (Google Cloud Run / herhangi bir konteyner)
- Resmî kaynaklardan otomatik derleme; her belgede `source_url` ve `pdf_url`

> **Hukuki not:** Metinler otomatik olarak PDF/DOC dosyalarından çıkarılır. Bağlayıcı ve resmî
> metin her zaman kaynak kurumun yayımladığı belgedir. Yanıtlarınızda `source_url` bağlantısını
> verin; yürürlük ve değişiklikler için güncel Resmî Gazete'yi kontrol edin.

## Veri kaynakları

| Kaynak | Kullanım |
| --- | --- |
| <https://mevzuat.gov.ct.tr> | Merkezi Mevzuat Dairesi; birleştirilmiş/güncel yasa, tüzük ve anayasa PDF'leri (öncelikli metin) |
| <https://mevzuat.mahkemeler.net> | Mahkemeler Mevzuat Bilgi Sistemi; geniş katalog, yasa/tüzük dosyaları ve mahkeme kararları |

Aynı belge iki kaynakta bulunduğunda **tür + numara** eşleşmesiyle birleştirilir; resmî
birleştirilmiş metin (`gov`) tercih edilir, diğer kaynak `sources` alanında saklanır. Arama
sonuçlarında `gov` belgeleri üst sıralara taşınır; yasa/tüzük sorularında `source=gov` filtresi
güncel metne daraltır. Mahkeme kararları yalnızca `mahkemeler` kaynağındadır.

## Mimari

```
mevzuat.gov.ct.tr ─┐
                   ├─ crawler (Python) ─► data/kktc.db (SQLite + FTS5) ─┬─► Cloudflare D1 ─► Worker (Hono)
mevzuat.mahkemeler ┘                                                   └─► node:sqlite  ─► Node/Cloud Run (Hono)
                                                                              │
                                                                    ortak @kktc/core
                                                          REST · Markdown · OpenAPI · llms.txt · MCP
```

- `crawler/kktc/` — katalog kazıma, PDF/DOC metin çıkarma, Türkçe katlama, madde bazlı parçalama,
  SQLite/FTS5 kurma ve D1 SQL dışa aktarma.
- `packages/core/` — ortak Tipli iş mantığı: SQL, snippet, Markdown, OpenAPI, `llms.txt`, MCP.
- `apps/worker/` — Cloudflare Worker + D1 sürümü.
- `apps/node/` — Node 22 `node:sqlite` sürümü; Docker/Cloud Run için.

## Hızlı başlangıç

Gereksinimler: Python 3.12+, Node 22.5+.

```bash
# 1) Python bağımlılıkları
python -m pip install -r crawler/requirements.txt

# 2) Katalogları indir (yaklaşık 11.000 kayıt)
cd crawler
python -m kktc crawl

# 3) Resmî birleştirilmiş metinleri indir (gov PDF'leri)
python -m kktc fetch-text --source gov

# 4) SQLite + FTS5 veritabanını kur ve D1 SQL dosyalarını üret
python -m kktc build

# 5) Node API'sini çalıştır
cd ..
npm install
npm run dev:node
# http://localhost:8787/llms.txt
```

Tek komutla güncelleme:

```bash
cd crawler
python -m kktc update            # crawl + yalnızca gov metinleri + build + export
python -m kktc update --full-text  # mahkemeler yasa/tüzük PDF'lerini de indir (yavaş)
python -m kktc stats             # kapsam raporu
```

> `mevzuat.gov.ct.tr` eksik TLS zinciri kullandığı için crawler yalnızca bu genel alan adında
> `verify=False` kullanır. Kurumsal bir CA demetiyle doğrulamayı açabilirsiniz.

### Mahkemeler kararları

Kararların tam metni katalog yanıtında gelir; ek indirme gerekmez:

```bash
cd crawler
python -m kktc crawl --source mahkemeler --only karar
python -m kktc build
```

Yasa/tüzük PDF'lerinin tamamını indirmek isterseniz:

```bash
python -m kktc fetch-text --type yasa --source mahkemeler
# 2015 öncesi tüzük PDF'leri taranmış görüntüdür; yalnızca güncel olanları indirin:
python -m kktc fetch-text --type tuzuk --source mahkemeler --min-year 2015
```

Eski `.doc` dosyaları için `soffice` (LibreOffice) veya `catdoc` kuruluysa metin çıkarılır;
kurulu değilse belge künye + resmî dosya bağlantısıyla indekslenir (`text_status=metadata`).
2015 öncesi taranmış PDF'ler OCR gerektirir; varsayılan olarak künye + bağlantı ile indekslenir.

## API

Canlı API örnekleri:

```bash
BASE=https://kktc-mevzuat-api.stevevaius.workers.dev
curl "$BASE/v1/search?q=nafaka&limit=5"
curl "$BASE/v1/documents/yasa-1-1998?format=markdown"
curl "$BASE/v1/documents/yasa-1-1998/articles/4"
curl "$BASE/v1/recent?type=karar&limit=10"
curl "$BASE/v1/changes?since=2026-11-01"
curl "$BASE/v1/documents/yasa-1-1998/changes?format=markdown"
curl "$BASE/v1/stats"
```

Yerel geliştirmede adres `http://localhost:8787` olur.

| Uç | Açıklama |
| --- | --- |
| `GET /v1/search` | `q` zorunlu; `mode=all\|any\|phrase`, `type`, `year`, `source`, `court`, `limit` (1–50), `offset` |
| `GET /v1/documents/{id}` | Künye + tam metin; `format=json\|markdown\|text`, `include_chunks=1` |
| `GET /v1/documents/{id}/articles` | Madde referansları |
| `GET /v1/documents/{id}/articles/{ref}` | Tek madde (`12`, `Madde 12`, `30A`) |
| `GET /v1/recent` | En yeni belgeler; `type`, `limit` (1–100) |
| `GET /v1/changes` | Saptanan mevzuat değişiklikleri; `since` (YYYY-AA-GG), `type`, `limit` (1–200) |
| `GET /v1/documents/{id}/changes` | Belgenin sürümleri ve madde bazlı farkları; `version`, `format=json\|markdown\|html` |
| `GET /degisiklikler` | İnsan için değişiklik akışı (yeşil = eklendi, kırmızı = kaldırıldı) |
| `GET /degisiklikler/{id}` | Belgenin madde bazlı fark görüntüleyicisi |
| `GET /v1/stats` | Kapsam, tür/yıl/kaynak dağılımı, tam metin durumu, mahkemeler |
| `GET /llms.txt` | LLM kullanım talimatları (her yanıtta `_meta.docs` ile bağlantılı) |
| `GET /openapi.json` | OpenAPI 3.1 |
| `POST /mcp` | MCP Streamable HTTP (JSON-RPC 2.0) |

Her JSON yanıtında şu alan bulunur:

```json
"_meta": {
  "api": "KKTC Mevzuat API",
  "docs": "https://.../llms.txt",
  "hint": "Arama: GET /v1/search?q=nafaka. Tam metin: GET /v1/documents/{id}?format=markdown...",
  "disclaimer": "Metinler resmî kaynaklardan otomatik derlenmiştir..."
}
```

Arama sonuçları ve belge künyeleri ayrıca hazır bir `citation` alanı taşır. LLM'lerin mahkeme,
esas/karar numarası ve tarihi kendileri birleştirmesi yerine bu alanı aynen kullanması gerekir:

```json
{
  "citation": "Yargıtay Aile, E. 1/2012, D. 21183, 07.03.2014"
}
```

### Arama davranışı

- Varsayılan `mode=all`: tüm sözcükler (VE). `any`: herhangi biri (VEYA). `phrase`: tam ifade.
- Tırnaklı ifade: `q="mal paylaşımı"`.
- 3+ harfli sözcüklerde otomatik önek araması (`nafaka` → `nafaka*`).
- Sonuçlar belge bazında tekilleştirilir; `score` büyük olan daha iyidir.
- `matched_ref` eşleşmenin hangi maddede olduğunu gösterir; `snippet` Türkçe özgün metinden üretilir.
- `citation` hazır atıftır; `source=gov` filtreleri güncel birleştirilmiş metne daraltır.

### Belge kimlikleri

| Tür | Örnek |
| --- | --- |
| Yasa | `yasa-1-1998`, `yasa-fasil-57` |
| Tüzük | `tuzuk-12-2020` |
| Anayasa | `anayasa-kktc-anayasasi` |
| Karar | `karar-e-5-1990-17712` |

## LLM kullanımı

LLM'e vereceğiniz tek satır:

> "KKTC mevzuatı için `https://<alan-adı>/llms.txt` adresini oku ve API'yi kullan."

`llms.txt`; arama → tam metin → madde → atıf akışını, parametreleri, MCP yapılandırmasını ve
doğruluk uyarılarını içerir. Ayrıntılı istem örnekleri: [`docs/LLM.md`](docs/LLM.md).

MCP istemcisi yapılandırması:

```json
{
  "mcpServers": {
    "kktc-mevzuat": {
      "type": "http",
      "url": "https://<alan-adı>/mcp"
    }
  }
}
```

Araçlar:

| Araç | Kullanım |
| --- | --- |
| `search_mevzuat` | Mevzuatta ve kararlarda arama; `query`, `type`, `year`, `source`, `court`, `mode`, `limit`, `offset` |
| `ictihat_ara` | Yalnız mahkeme kararlarında arama; `ifade`, `mahkeme`, `yil`, `mod`, `adet`, `sayfa` |
| `karar_getir` | Kararın künyesi, hazır atfı ve tam metni; `id` |
| `list_courts` | Mahkemeler, karar sayıları ve yıl aralıkları |
| `son_degisiklikler` | Saptanan son mevzuat değişiklikleri; `since`, `type`, `limit` |
| `degisiklikleri_getir` | Belgenin sürüm geçmişi ve madde farkları; `id`, `version` |
| `get_document` | Belge künyesi + tam metin; `id`, `format` |
| `get_article` | Tek madde; `id`, `ref` |
| `list_document_articles` | Madde referansları; `id` |
| `list_recent` | En yeni belgeler; `type`, `limit` |
| `get_stats` | Kapsam istatistikleri |

## Dağıtım

### Cloudflare Workers + D1

```bash
# D1 veritabanı oluştur ve kimliği wrangler.toml'a yaz
npx wrangler d1 create kktc-mevzuat

# Şemayı yükle
npx wrangler d1 execute kktc-mevzuat --remote --yes --file=dist/d1/001-schema.sql

# Veriyi import-order.txt sırasıyla yükle
Get-Content dist/d1/import-order.txt | ForEach-Object {
  if ($_ -match '^\s*#' -or $_ -eq '') { return }
  npx wrangler d1 execute kktc-mevzuat --remote --yes --file="dist/d1/$_"
}

# Worker'ı yayımla
npm run deploy:worker
```

`import-order.txt` içindeki `002-reset.sql` mevcut veriyi siler; yeni bir veritabanında
zararsızdır. Ayrıntılar, doğrulama sorguları ve PowerShell/Bash döngüleri:
[`docs/DEPLOY.md`](docs/DEPLOY.md).

### Google Cloud Run

```bash
docker build -t kktc-mevzuat-api .
docker run --rm -p 8787:8787 -v "$PWD/data:/app/data:ro" kktc-mevzuat-api

gcloud run deploy kktc-mevzuat-api \
  --source . \
  --region europe-west1 \
  --allow-unauthenticated \
  --memory 512Mi
```

Konteyner görüntüsü, derleme sırasında `data/kktc.db` dosyasını içerir. Veriyi güncellemek için
yeni imaj oluşturup yeniden dağıtın.

## Testler

```bash
# Python metin işleme testleri (Türkçe katlama, TOC temizleme, madde ayırma)
cd crawler && python -m pytest tests -q && cd ..

# Tip kontrolü ve Node derlemesi
npm run typecheck
npm run build

# Çalışan API'ye karşı uçtan uca test
npm run smoke
```

## GitHub Actions

- `.github/workflows/ci.yml` — tip kontrolü ve derleme.
- `.github/workflows/data.yml` — haftalık kazıma, D1'e aktarım ve Worker dağıtımı
  (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_D1_DATABASE_ID` secret'ları gerekir).

## Sürüm geçmişi

Her build, güncel birleştirilmiş metinleri (`source=gov`) `data/history.db` içindeki son sürümle karşılaştırır. Metin değişmişse yeni sürüm saklanır; fark madde madde (eklenen / kaldırılan / değişen) ve değişen maddelerin içinde kelime bazında kaydedilir.

- Takip ilk build ile başlar; o çalıştırma yalnızca başlangıç sürümünü (baseline) kaydeder. Öncesindeki değişiklikler bilinmez.
- Bir çalıştırmada kaynağı alınamayan belgeler değişiklik sayılmaz; öncekinin %40'ından kısa çıkan metinler bozuk çıkarım kabul edilip atlanır.
- `history.db` build'ler arasında korunması gereken tek durumdur. GitHub Actions'ta `history` adlı release'in eki olarak saklanır (`history-prev.db` bir önceki kopyadır). Yerelde `data/history.db` dosyasını silmeyin.
- `python -m kktc build --no-history` yeni sürüm kaydetmeden derler.
- Saptanma tarihi değişikliğin kaynakta görüldüğü haftadır, yürürlük tarihi değildir.
- mevzuat.gov.ct.tr dosyalarının çoğunun adında tarih yoktur (Ekim 2026: 324 dosyanın 275'i), yani değişiklik aynı adla gelebilir. Bu yüzden `fetch-text --revalidate` her hafta tüm dosyaları (~150 MB) yeniden indirir ve SHA-256 parmak izini karşılaştırır; yalnızca içeriği değişen dosyanın metni yeniden çıkarılır. Haftalık iş akışı bunu kullanır.

Değişiklikleri programatik olarak okuyun:

```bash
curl "$BASE/v1/changes?since=2026-11-01"
curl "$BASE/v1/documents/yasa-1-1998/changes?format=markdown"
```

`/v1/changes` yanıtındaki `tracking_since` takibin başladığı tarihtir; `detected_at` ise değişikliğin
kaynakta görüldüğü çalıştırmadır. İnsan görünümü için <https://kktc-mevzuat-api.stevevaius.workers.dev/degisiklikler>
adresini açın.

## Sınırlamalar

- Taranmış (OCR gerektiren) PDF'lerde metin eksik olabilir; `text_status` alanına bakın.
  2015 öncesi mahkemeler tüzükleri ve İngilizce eski yasalar genellikle taranmıştır; bunlar künye
  ve resmî PDF bağlantısıyla indekslenir. Güncel metinler için `mevzuat.gov.ct.tr` birleştirilmiş
  sürümleri önceliklidir.
- Birleştirilmiş metinlerde yürürlükten kaldırılan maddeler numara atlamasına yol açabilir.
- Mahkemeler kataloğunda aynı karar birden çok kez bulunabilir; kayıt anahtarı (`pkey`) tekilliği sağlar.
- API yalnızca okuma amaçlıdır; yazma veya kullanıcı verisi tutmaz.
- Kaynak sitelerin kullanım koşullarına ve robots kurallarına saygı gösterin; crawler 1 saniye
  gecikme ve açık bir iletişim başlığı kullanır.

## Lisans

Kod MIT lisanslıdır. Kazınan metinler ilgili resmî kurumların yayımladığı belgelere aittir;
kaynak ve atıf bilgisi her yanıtta verilir.
