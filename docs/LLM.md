# LLM'ler için kullanım

Bu API, bir LLM'in KKTC mevzuatını **uydurmadan** araması, okuması, atıf yapması ve son
değişiklikleri izlemesi için tasarlandı. Her JSON yanıtında `_meta.hint`, `_meta.docs` ve
`_meta.disclaimer` alanları bulunur; model bu alanlar üzerinden kendini yönlendirebilir.

## Tek satırlık sistem istemi

```text
KKTC mevzuatı sorularında önce https://<alan-adı>/llms.txt adresini oku.
Arama için GET /v1/search?q=..., tam metin için GET /v1/documents/{id}?format=markdown,
tek madde için GET /v1/documents/{id}/articles/{ref} kullan.
Yasa ve tüzüklerde önce source=gov olan birleştirilmiş metni ara; yoksa mahkemeler
kaynağındaki birleştirilmiş metni kullan ve consolidated_through alanına bak.
Atıf için sonuçtaki citation alanını aynen kullan; mahkeme veya esas/karar numarası uydurma.
Yanıtlarında belgenin title, number, date ve source_url alanlarını ver.
Bir maddenin yakın zamanda değişip değişmediğini merak ediyorsan /v1/documents/{id}/changes kullan.
Metinde olmayan hüküm uydurma; text_status=metadata ise tam metin olmadığını söyle.
Bağlayıcı metin için resmî kaynağa (source_url) yönlendir.
```

## Önerilen akış

1. **Ara**
   ```http
   GET /v1/search?q=mal%20paylaşımı&type=yasa&prefer=mevzuat&limit=5
   ```
   Sonuçlardaki `id`, `matched_ref`, `matched_part`, `matched_text`, `matched_url`, `snippet`,
   `citation`, `text_status`, `consolidated_through` ve `score` alanlarını incele. `score`
   büyük olan daha iyidir. Varsayılan `mode=auto` önce tüm sözcükleri arar; sonuç yoksa
   `any`'ye düşer ve `relaxed=true` döner. Hukuk sorularında `prefer=mevzuat` kullan;
   `ictihat` için `prefer=ictihat` veya `type=karar` kullan.
   `source=gov` filtresi yalnızca resmî sitedeki metinlere daraltır; Gelir Vergisi, KDV ve
   Sosyal Sigortalar gibi yalnızca `mahkemeler` kataloğunda bulunan yasalar bu filtreyle
   görünmez. Önce filtresiz ara, sonra `consolidated_through` dolu olan sonucu tercih et.
   Sonuç yoksa eş anlamlıları ve daha kısa kökleri dene (`nafaka`, `nafakasının`,
   `iştirak nafakası`, `tedbir nafakası`).

2. **Tam metni al**
   ```http
   GET /v1/documents/yasa-1-1998?format=markdown
   ```
   Markdown çıktısı başlık, künye, hazır atıf, kaynak bağlantısı ve tam metni içerir. Uzun
   yasalar için doğrudan maddeye gitmek daha verimlidir.

3. **Maddeyi al**
   ```http
   GET /v1/documents/yasa-1-1998/articles/4
   ```
   `ref`: `4`, `Madde 4`, `m. 4`, `30A`. Uzun maddeler `parts` dizisinde döner; `text`
   alanı birleştirilmiş metindir.

4. **Atıf yap**
   ```text
   Kaynak: 1/1998 Sayılı Aile (Evlenme ve Boşanma) Yasası, Madde 4
   https://mevzuat.gov.ct.tr/Portals/48/1-1998%20Aile...
   ```
   Arama sonucundaki veya belge künyesindeki `citation` alanını **aynen** kullan. Mahkeme
   kararlarında biçim `Mahkeme, E. esas, D. karar, tarih` şeklindedir.

5. **Değişiklik gerekiyorsa geçmişe bak**
   ```http
   GET /v1/documents/yasa-1-1998/changes?format=markdown
   ```
   Bu uç, takip başladığından beri kaydedilen sürümleri ve değişen maddelerin eski/yeni
   metnini verir. Güncel olup olmadığını sorduğun bir maddede bunu kullan.

## Hızlı alıntı: `GET /v1/answer`

```http
GET /v1/answer?q=mal%20paylaşımında%20eşlere%20düşen%20en%20az%20oran&format=markdown
```

- En iyi 1–5 pasajı **birebir** alıntılar; `answer_type=extractive`.
- Her alıntıda `citation`, `source_url`, `url`, `text_status`, `source`, `consolidated_through`,
  `excerpt`, `probability` ve `score` bulunur.
  - `source`: `gov` (mevzuat.gov.ct.tr, birleştirilmiş güncel metin) veya `mahkemeler`.
  - `consolidated_through`: metnin içerdiği son değişiklik; `null` ise kaynak belirtmiyor, metin
    sonraki değişikliklerden önceki hâl olabilir. Resmî Gazete'den kontrol edin.
  - `excerpt: true`: alıntı uzun bir maddenin bir bölümüdür; maddenin tamamı `url`'dedir.
- `confidence`: `high`, `medium`, `low`. Doğal dil sorularında Clef olasılığından gelir. `high` ayrıca
  şunları ister: cevap genel bir soruya tüzükten gelmemeli, LLM'in adlandırdığı yasalardan biri olmalı
  (adlandırdıysa) ve kaynak metin eksik olmamalı. Soru başka bir ülkenin hukukunu soruyorsa `low`.
  Düşürme nedenleri `confidence_caps` alanındadır.
- **`low` ise alıntıyı cevap olarak sunmayın.** Alıntıyı değiştirmeden aktarın; atfı `citation`
  alanından alın, yasa veya madde numarası uydurmayın.
- Değişiklik yasa/tüzükleri, başlangıç hükümleri ve tefsir maddeleri cevap olarak alıntılanmaz
  (soru bunları sormadıkça).
- **Üretken değildir**; hukuki yorum yapmaz, metni yeniden yazmaz.
- MCP’de `sor` aracı aynı davranışı verir.
- **Yasayı biliyorsanız verin.** `yasa_bul` (MCP) veya `GET /v1/statutes?name=Ceza Yasası` yasanın id'sini
  verir; `sor`'a `belge`, `/v1/answer`'a `document_id` olarak geçin. Ölçümde (11 Kasım) yasa doğru verildiğinde
  doğru madde ilk sırada %83 (verilmediğinde %69). `katalog` / `GET /v1/statutes?type=yasa&page=1` metni olan
  yasaların listesini verir.

## Arama ipuçları

- Varsayılan `mode=auto` önce tüm sözcükleri arar; sonuç yoksa `any`'ye düşer. Tek sözcüklü
  aramalar en iyi geri çağırmayı verir.
- `prefer=mevzuat` yasa/tüzük/anayasayı, `prefer=ictihat` kararları öne çıkarır; `type` filtresi
  kesin daraltma yapar.
- Sorgu bir hukuk kavramına denk gelirse (`mal paylaşımı`, `nafaka`, `kıdem tazminatı`, `KDV`…)
  API o kavramın kanonik yasasını öne çıkarır; yanıtta `concepts` ve `primary_documents` görünür.
- `2/3`, `1/3`, `üçte iki` gibi oranlar tek token olarak aranır; `2/3` artık `23` ile karışmaz.
- `min_score` ham BM25 skorudur; sorgular arasında karşılaştırmayın, yalnızca aynı sorguda gürültü
  elemek için kullanın.
- `exact_count=1` pahalı `COUNT(DISTINCT)` sorgusunu çalıştırır; varsayılan yalnızca getirilen
  pencereyi sayar ve D1 okuma kotasını korur.
- `mode=any` eş anlamlıları tek istekte denemek için uygundur:
  `q="nafaka yoksulluk iştirak"&mode=any`.
- Tam ifade için tırnak veya `mode=phrase`: `q="mal paylaşımı"`.
- 3+ harfli sözcüklerde önek araması otomatik: `nafaka` → `nafaka*` (nafakasının, nafakaya...).
- Türkçe diakritikler önemsizdir: `soguk` = `soğuk`; `ı/i`, `ş/s`, `ğ/g`, `ü/u`, `ö/o`, `ç/c` eşlenir.
- `type` filtresi: `yasa`, `tuzuk`, `karar`, `anayasa`, `yonetmelik`, `emirname`,
  `kararname`, `andlasma`.
- Karar ararken `court` ve `year` filtreleri gürültüyü azaltır:
  `?q=kira&type=karar&court=Yüksek Mahkeme&year=2024`.
- Sonuçlar sayfalanır: `limit` en fazla 50, `offset` en fazla 1000. `next` alanı hazır URL verir.

## Yanıt alanları

| Alan | Anlam |
| --- | --- |
| `id` | Belge kimliği; sonraki isteklerde kullanın |
| `title`, `number`, `year`, `date` | Künye; atıf için |
| `citation` | Hazır atıf; **aynen kullanın**, kendiniz birleştirmeyin |
| `source_url`, `pdf_url` | Resmî kaynak ve PDF |
| `source` | `gov` (resmî birleştirilmiş metin) veya `mahkemeler` (katalog, birleştirilmiş Word metinleri ve kararlar) |
| `consolidated_through` | Metnin içerdiği son değişiklik (`25/2026` gibi); boşsa birleştirme bilgisi yoktur |
| `text_status` | `full`, `partial`, `metadata`; arama sonucunda da döner |
| `concepts` | Sorguda tanınan hukuk kavramları (`mal paylaşımı`, `nafaka`, `KDV`…) |
| `concept_expanded` | Kavram terimleriyle ek arama yapıldıysa `true` |
| `primary_documents` | Kavramın kanonik yasalarından gelen belge sayısı |
| `matched_ref` | Eşleşmenin bulunduğu madde, parçasız (`Madde 26`) |
| `matched_part` | Parçalı maddede FTS eşleşmesinin bölümü (`3/7` gibi) |
| `matched_text` | Eşleşen maddenin tam metni (yasa/tüzük; 8.000 karaktere kadar) |
| `matched_text_truncated` | `matched_text` kısaltıldıysa `true` |
| `matched_url` | Eşleşen maddeye doğrudan bağlantı |
| `snippet` | Türkçe özgün metinden pencere |
| `highlights` | Snippet içindeki eşleşmelerin `start`/`end` offsetleri |
| `score` | Alaka; büyük daha iyi |

`text_status=metadata` ise belge yalnızca künye ve PDF bağlantısıyla indekslenmiştir. Model bunu
açıkça söylemeli, metin varmış gibi davranmamalıdır.

## Değişiklikler ve sürüm geçmişi

Güncel birleştirilmiş metinler (`source=gov` ve `mahkemeler` kaynağındaki Word yasaları) her
hafta önceki sürümle karşılaştırılır. Metin değişmişse yeni sürüm saklanır; fark madde madde
(eklenen / kaldırılan / değişen) ve değişen maddenin içinde kelime bazında kaydedilir.

- `GET /v1/changes?since=YYYY-AA-GG&type=yasa&limit=50`
  Belge başına sürüm geçişlerini listeler. Yanıttaki `tracking_since` takibin başladığı tarihtir.
- `GET /v1/documents/{id}/changes?format=markdown`
  Belgenin sürümlerini ve her değişen maddenin `old_text` / `new_text` metnini verir.
  `version=3` ile yalnızca o sürüme geçiş filtrelenir. `format=html` yeşil/kırmızı görünüm verir.
- İnsanlar için: `GET /degisiklikler` ve `GET /degisiklikler/{id}`.

Önemli sınırlar:

- **Takip ilk kayıt tarihinden başlar.** Öncesindeki değişiklikler bilinmez; `tracking_since`
  değerini yanıtta belirtin.
- `detected_at`, değişikliğin kaynakta **görüldüğü** çalıştırmadır; yürürlük tarihi değildir.
  Yürürlük için Resmî Gazete'ye bakılmalıdır.
- Bir çalıştırmada kaynağı alınamayan belge değişiklik sayılmaz. Önceki metnin %40'ından kısa
  çıkan metinler bozuk çıkarım kabul edilip atlanır.

Örnek:

```bash
curl "$BASE/v1/changes?since=2026-11-01"
curl "$BASE/v1/documents/yasa-1-1998/changes?format=markdown"
```

## MCP ile araç çağrısı

```json
{
  "mcpServers": {
    "kktc-mevzuat": { "type": "http", "url": "https://<alan-adı>/mcp" }
  }
}
```

Araçlar ve tipik argümanlar:

| Araç | Argümanlar | Kullanım |
| --- | --- | --- |
| `sor` | `soru`, `type?`, `prefer?`, `adet?` | Birebir alıntı + atıf; üretken değil |
| `search_mevzuat` | `query`, `type?`, `year?`, `source?`, `court?`, `mode?`, `prefer?`, `min_score?`, `limit?`, `offset?` | Mevzuat + karar araması (varsayılan `prefer=mevzuat`) |
| `ictihat_ara` | `ifade`, `mahkeme?`, `yil?`, `mod?`, `adet?`, `sayfa?` | Yalnız mahkeme kararları; sonuçlarda `citation` |
| `karar_getir` | `id` | Kararın künyesi, atfı ve tam metni (Markdown) |
| `list_courts` | — | Mahkemeler, karar sayıları, yıl aralığı |
| `son_degisiklikler` | `since?`, `type?`, `limit?` | Saptanan son madde değişiklikleri |
| `degisiklikleri_getir` | `id`, `version?` | Belgenin sürüm geçmişi ve madde farkları |
| `get_document` | `id`, `format?` | Belge künyesi + tam metin |
| `get_article` | `id`, `ref` | Tek madde |
| `list_document_articles` | `id` | Madde referansları |
| `list_recent` | `type?`, `limit?` | En yeni belgeler |
| `get_stats` | — | Kapsam istatistikleri |

Örnek çağrılar:

```json
{ "name": "sor", "arguments": { "soru": "mal paylaşımında eşlere düşen en az oran", "type": "yasa", "adet": 3 } }
{ "name": "search_mevzuat", "arguments": { "query": "iştirak nafakası", "type": "yasa", "source": "gov", "limit": 5 } }
{ "name": "ictihat_ara", "arguments": { "ifade": "nafaka", "mahkeme": "Yargıtay", "adet": 5 } }
{ "name": "karar_getir", "arguments": { "id": "karar-e-1-2012-21183" } }
{ "name": "get_document", "arguments": { "id": "yasa-1-1998", "format": "markdown" } }
{ "name": "get_article", "arguments": { "id": "yasa-1-1998", "ref": "30" } }
{ "name": "son_degisiklikler", "arguments": { "since": "2026-11-01", "type": "yasa", "limit": 20 } }
{ "name": "degisiklikleri_getir", "arguments": { "id": "yasa-1-1998" } }
```

MCP yanıtları `content[0].text` içinde JSON veya Markdown olarak döner; JSON sonuçlarda
ayrıca `structuredContent` bulunur.

## İstem örnekleri

**Hukuki araştırma**

```text
KKTC'de boşanma davasında mal paylaşımı nasıl düzenleniyor?
Önce /v1/search?q="mal paylaşımı"&type=yasa&source=gov ile ara, ilgili yasanın tam metnini al,
maddeleri numaralarıyla aktar ve her hüküm için citation ile source_url ver.
Metinde olmayan yorum ekleme; emin olmadığın noktayı belirt.
```

**Karar özeti**

```text
Son 5 yılda kira tazminatına ilişkin Yüksek Mahkeme kararlarını bul.
/v1/search?q=kira tazminat&type=karar&court=Yüksek Mahkeme&year=2024 kullan.
Her karar için citation alanını aynen aktar; esas numarası, tarih, taraflar ve sonucu özetle.
```

**Madde karşılaştırma**

```text
1/1998 sayılı Yasa'nın 4. ve 5. maddelerini getir (/articles/4 ve /articles/5).
İki maddeyi yan yana karşılaştır; değişiklik tarihlerini belge künyesinden aktar.
```

**Değişiklik kontrolü**

```text
1/1998 sayılı Aile Yasası'nın 30. maddesi son dönemde değişti mi?
Önce /v1/documents/yasa-1-1998/changes?format=markdown ile sürüm geçmişini kontrol et.
Varsa eski ve yeni metni karşılaştır; yoksa "takip başlangıcından beri değişiklik yok" de ve
takip başlangıç tarihini belirt. Saptanma tarihinin yürürlük tarihi olmadığını ekle.
```

## Doğruluk kontrol listesi

- [ ] Her hüküm için `id`, madde numarası ve `source_url` verildi mi?
- [ ] `citation` alanı aynen kullanıldı mı; mahkeme/esas/karar numarası uydurulmadı mı?
- [ ] `text_status=metadata` olan belgeler için "tam metin yok" denildi mi?
- [ ] Birden çok kaynak çelişiyorsa `source=gov` olan (birleştirilmiş resmî metin), yoksa
      `consolidated_through` dolu `mahkemeler` metni tercih edildi mi?
- [ ] Karar tarihi ve esas numarası doğru mu?
- [ ] Değişiklik iddiası varsa `tracking_since` ve `detected_at` tarihleri doğru aktarıldı mı?
- [ ] Cevap, "resmî/bağlayıcı metin için kaynağa bakın" uyarısını içeriyor mu?

## Önbellekleme ve yük

- API anahtarı yoktur; makul kullanım beklenir.
- Aynı belgeyi tekrar tekrar çekmek yerine oturum içinde önbelleğe alın.
- Toplu kazıma (binlerce istek) yapmayın; veri kümesini kendiniz barındırmak için depoyu kullanın.
- `llms.txt` 5 dakika önbelleğe alınabilir (`cache-control: public, max-age=300`).
