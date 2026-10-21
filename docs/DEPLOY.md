# Dağıtım

İki hedef vardır:

1. **Cloudflare Workers + D1** — birincil, küresel, ücretsiz katmanla başlanabilir.
2. **Google Cloud Run** — SQLite dosyasını konteyner içinde taşır; D1 kotasına takılmak istemeyenler için.

Her iki hedef de aynı `@kktc/core` kodunu ve aynı SQLite şemasını kullanır.

---

## 0) Veriyi hazırla

```bash
python -m pip install -r crawler/requirements.txt
cd crawler

python -m kktc crawl
python -m kktc fetch-text --source gov
# İsteğe bağlı: mahkemeler yasa/tüzük PDF'leri
# python -m kktc fetch-text --type yasa --source mahkemeler
# python -m kktc fetch-text --type tuzuk --source mahkemeler --min-year 2015

python -m kktc build
python -m kktc stats
```

Çıktılar:

- `data/kktc.db` — SQLite + FTS5 veritabanı
- `dist/d1/001-schema.sql` — D1 şeması
- `dist/d1/002-reset.sql` — tabloları boşaltır
- `dist/d1/010-documents-*.sql` — belge künyeleri
- `dist/d1/020-chunks-*.sql` — metin parçaları
- `dist/d1/030-fts-*.sql` — FTS5 içeriği
- `dist/d1/090-meta.sql` — istatistikler
- `dist/d1/import-order.txt` — önerilen sıra

> Dosya adlarındaki `-001`, `-002` parçaları 40 MB'lık bölümlerdir. Tek bir SQL ifadesi
> 100 KB'ı aşmaz; metin parçaları en fazla ~2,4 KB'dir.

---

## 1) Cloudflare Workers + D1

### 1.1 D1 veritabanı oluştur

```bash
npx wrangler login
npx wrangler d1 create kktc-mevzuat
```

Çıktıdaki `database_id` değerini `apps/worker/wrangler.toml` içine yazın:

```toml
[[d1_databases]]
binding = "DB"
database_name = "kktc-mevzuat"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

### 1.2 Şemayı yükle

```bash
npx wrangler d1 execute kktc-mevzuat --remote --yes --file=dist/d1/001-schema.sql
```

### 1.3 Veriyi sırayla yükle

`import-order.txt` sırasını izleyin. Bash:

```bash
while read -r file; do
  case "$file" in \#*|"") continue ;; esac
  echo "-> $file"
  npx wrangler d1 execute kktc-mevzuat --remote --yes --file="dist/d1/$file" || exit 1
done < dist/d1/import-order.txt
```

PowerShell:

```powershell
Get-Content dist/d1/import-order.txt | ForEach-Object {
  if ($_ -match '^\s*#' -or $_ -eq '') { return }
  Write-Host "-> $_"
  npx wrangler d1 execute kktc-mevzuat --remote --yes --file="dist/d1/$_"
  if ($LASTEXITCODE -ne 0) { throw "Import failed: $_" }
}
```

Sıra önemlidir: önce `documents`, sonra `chunks`, en son `chunks_fts`. FTS tablosu `chunks.id`
değerlerini `rowid` olarak kullanır.

### 1.4 Doğrula

```bash
npx wrangler d1 execute kktc-mevzuat --remote --command \
  "SELECT type, COUNT(*) AS n FROM documents GROUP BY type ORDER BY n DESC"
npx wrangler d1 execute kktc-mevzuat --remote --command \
  "SELECT COUNT(*) AS chunks FROM chunks"
```

### 1.5 Worker'ı yayımla

```bash
npm install
npm run deploy:worker
```

`wrangler.toml` içindeki `workers_dev = true` sayesinde `https://kktc-mevzuat-api.<hesap>.workers.dev`
adresinde yayınlanır.

Özel alan adı:

```bash
npx wrangler domains add api.ornek.com --config apps/worker/wrangler.toml
```

### 1.6 Yerel D1 ile deneme

```bash
cd apps/worker
npx wrangler d1 execute kktc-mevzuat --local --file=../../dist/d1/001-schema.sql
npx wrangler dev
```

### D1 notları

- D1'de FTS5 ve `bm25()` desteklenir; şema `tokenize='unicode61 remove_diacritics 2'` kullanır.
- Tek SQL ifadesi sınırı 100 KB'dır. Bu proje hiçbir zaman uzun `content` blobu yazmaz;
  metin parçaları ayrı satırlardadır.
- Ücretsiz katmanda günlük yazma/okuma ve CPU sınırları vardır. Arama başına 1000 satıra kadar
  okuma yapılabilir; yoğun kullanımda Workers Paid planına geçin veya `limit` değerini düşürün.
- Veri güncellemesi için önce `002-reset.sql`, sonra tüm dosyalar yeniden yüklenebilir. Daha hızlı
  ve kesintisiz yöntem: yeni bir D1 veritabanına yükleyip `database_id` değiştirerek geçiş yapmak.

---

## 2) Google Cloud Run

Konteyner, `data/kktc.db` dosyasını imaja gömer; çalışma anında `node:sqlite` salt-okunur açar.

### 2.1 Yerel Docker

```bash
docker build -t kktc-mevzuat-api .
docker run --rm -p 8787:8787 kktc-mevzuat-api
```

`http://localhost:8787/health` ve `/llms.txt` adreslerini kontrol edin.

### 2.2 Cloud Run'a dağıt

```bash
gcloud auth login
gcloud config set project <PROJE_ID>

gcloud run deploy kktc-mevzuat-api \
  --source . \
  --region europe-west1 \
  --allow-unauthenticated \
  --memory 1Gi \
  --cpu 1 \
  --concurrency 40 \
  --port 8080
```

İlk dağıtımda Cloud Build imajı oluşturur. `data/kktc.db` imaja dahil edilir.

### 2.3 Güncelleme

```bash
cd crawler && python -m kktc update && cd ..
docker build -t kktc-mevzuat-api .
gcloud run deploy kktc-mevzuat-api --source . --region europe-west1
```

Cloud Run yeni revizyonu sağlık kontrolünden sonra trafiğe alır.

### Notlar

- `node:sqlite` Node 22.5+ ile gelir; imaj `node:22-slim` kullanır. Deneysel uyarıyı
  `NODE_NO_WARNINGS=1` ile susturabilirsiniz (işlevi etkilemez).
- SQLite dosyası salt-okunur açılır; birden çok örnek aynı dosyayı güvenle okuyabilir.
- Veritabanı büyüdükçe bellek ve soğuk başlangıç süresi artar. 1 GiB bellek çoğu sürüm için yeterlidir.
- Kalıcı disk gerekmez; veri imajın içindedir.

---

## 3) GitHub Actions

### 3.1 CI

`.github/workflows/ci.yml` her push/PR'da tip kontrolü ve Node derlemesi yapar; kimlik bilgisi gerekmez.

### 3.2 Haftalık veri yenileme + D1 + Worker

`.github/workflows/data.yml`:

1. Python crawler'ı çalıştırır (`crawl`, `fetch-text --source gov`, `build`).
2. `data/text` önbelleğini Actions cache ile saklar; sonraki haftalarda yalnızca yeni belgeler indirilir.
3. D1'e şema + veriyi yükler.
4. Worker'ı yayımlar.

Gereken repository secret'ları:

| Secret | Açıklama |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | D1 Edit + Workers Scripts Edit yetkili token |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare hesap kimliği |
| `CLOUDFLARE_D1_DATABASE_ID` | D1 veritabanı UUID'si |

`wrangler.toml` içindeki `database_id` sabit kalabilir; workflow `sed` ile secret'tan yazar.

> İlk çalıştırma tam kazıma yapar (~10–20 dk gov, mahkemeler yasa/tüzük dahilse saatler sürebilir).
> `timeout-minutes: 360` sınırına dikkat edin. Yalnızca gov metinleriyle başlamak en hızlı yoldur.

### 3.3 Manuel dağıtım

Actions sekmesinden `Refresh data` → `Run workflow`. `full_text=true` girdisi mahkemeler
yasa/tüzük PDF'lerini de indirir.

---

## 4) Maliyet ve sınırlar

| Bileşen | Ücretsiz katman | Not |
| --- | --- | --- |
| Workers | 100.000 istek/gün | CPU süresi sınırlı; ağır aramalarda Paid önerilir |
| D1 | 5 GB depolama, 5M satır okuma/gün | Bu veri kümesi birkaç yüz MB |
| Cloud Run | Aylık ücretsiz kota | Trafik yoksa sıfıra ölçeklenir |
| GitHub Actions | Public repo ücretsiz | Özel repoda dakika kotası |

## 5) Sorun giderme

| Belirti | Çözüm |
| --- | --- |
| `no such module: fts5` | D1 kullanın veya Node 22.5+ ile çalıştırın; eski SQLite FTS5 içermez |
| D1 `statement too large` | `dist/d1` dosyalarını daha küçük bölümlere ayırın (`SqlFileWriter.max_bytes`) |
| D1 import yavaş | Dosyaları paralel değil sırayla yükleyin; `--yes` ekleyin; büyük veri için yeni DB'ye geçiş yapın |
| Worker 1102 / CPU limiti | `limit` düşürün, Workers Paid'e geçin veya Cloud Run kullanın |
| `mevzuat.gov.ct.tr` TLS hatası | Crawler bu alan adında `verify=False` kullanır; kurumsal CA ekleyin |
| `.doc` metni yok | `soffice` veya `catdoc` kurun; yoksa belge `metadata` olarak indekslenir |
| Boş arama sonucu | `mode=any` deneyin, Türkçe kökleri kısaltın, `type` filtresini kaldırın |
| `document_not_found` | `id` değerini arama sonucundan kopyalayın; kimlikler slug biçimindedir |
