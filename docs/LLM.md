# LLM'ler için kullanım

Bu API, bir LLM'in KKTC mevzuatını **uydurmadan** araması, okuması ve atıf yapması için tasarlandı.
Her JSON yanıtında `_meta.hint`, `_meta.docs` ve `_meta.disclaimer` alanları bulunur; model bu
alanlar üzerinden kendini yönlendirebilir.

## Tek satırlık sistem istemi

```text
KKTC mevzuatı sorularında önce https://<alan-adı>/llms.txt adresini oku.
Arama için GET /v1/search?q=..., tam metin için GET /v1/documents/{id}?format=markdown,
tek madde için GET /v1/documents/{id}/articles/{ref} kullan.
Yasa ve tüzüklerde source=gov olan birleştirilmiş güncel metni tercih et; mahkemeler kaydı arşivdir.
Yanıtlarında belgenin title, number, date ve source_url alanlarını ver.
Metinde olmayan hüküm uydurma; text_status=metadata ise tam metin olmadığını söyle.
Bağlayıcı metin için resmî kaynağa (source_url) yönlendir.
```

## Önerilen akış

1. **Ara**
   ```http
   GET /v1/search?q=nafaka&type=yasa&source=gov&limit=5
   ```
   Yasa ve tüzüklerde `source=gov` filtresi güncel birleştirilmiş metne daraltır. Sonuçlardaki
   `id`, `matched_ref`, `snippet` ve `score` alanlarını incele. `score` büyük olan daha iyidir.
   Sonuç yoksa filtreyi kaldır; eş anlamlıları ve daha kısa kökleri dene
   (`nafaka`, `nafakasının`, `iştirak nafakası`, `tedbir nafakası`).

2. **Tam metni al**
   ```http
   GET /v1/documents/yasa-1-1998?format=markdown
   ```
   Markdown çıktısı başlık, künye, kaynak bağlantısı ve tam metni içerir. Uzun yasalar için
   doğrudan maddeye gitmek daha verimlidir.

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

## Arama ipuçları

- Varsayılan `mode=all` tüm sözcükleri arar. Tek sözcüklü aramalar en iyi geri çağırmayı verir.
- `mode=any` eş anlamlıları tek istekte denemek için uygundur:
  `q="nafaka yoksulluk iştirak"&mode=any`.
- Tam ifade için tırnak veya `mode=phrase`: `q="mal paylaşımı"`.
- 3+ harfli sözcüklerde önek araması otomatik: `nafaka` → `nafaka*` (nafakasının, nafakaya...).
- Türkçe diakritikler önemsizdir: `soguk` = `soğuk`, `hukuk` = `hukük` değil ama `ı/i` eşlenir.
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
| `source_url`, `pdf_url` | Resmî kaynak ve PDF |
| `source` | `gov` (birleştirilmiş güncel metin; yasa/tüzükte tercih edin) veya `mahkemeler` |
| `text_status` | `full`, `partial`, `metadata` |
| `matched_ref` | Eşleşmenin bulunduğu madde (varsa) |
| `snippet` | Türkçe özgün metinden pencere |
| `score` | Alaka; büyük daha iyi |

`text_status=metadata` ise belge yalnızca künye ve PDF bağlantısıyla indekslenmiştir. Model bunu
açıkça söylemeli, metin varmış gibi davranmamalıdır.

## MCP ile araç çağrısı

```json
{
  "mcpServers": {
    "kktc-mevzuat": { "type": "http", "url": "https://<alan-adı>/mcp" }
  }
}
```

Araçlar ve tipik argümanlar:

```json
{ "name": "search_mevzuat", "arguments": { "query": "iştirak nafakası", "type": "yasa", "limit": 5 } }
{ "name": "get_document", "arguments": { "id": "yasa-1-1998", "format": "markdown" } }
{ "name": "get_article", "arguments": { "id": "yasa-1-1998", "ref": "4" } }
{ "name": "list_document_articles", "arguments": { "id": "yasa-1-1998" } }
{ "name": "list_recent", "arguments": { "type": "karar", "limit": 10 } }
{ "name": "get_stats", "arguments": {} }
```

MCP yanıtları `content[0].text` içinde JSON veya Markdown olarak döner; JSON sonuçlarda ayrıca
`structuredContent` bulunur.

## İstem örnekleri

**Hukuki araştırma**

```text
KKTC'de boşanma davasında mal paylaşımı nasıl düzenleniyor?
Önce /v1/search?q="mal paylaşımı"&type=yasa ile ara, ilgili yasanın tam metnini al,
maddeleri numaralarıyla aktar ve her hüküm için source_url ver.
Metinde olmayan yorum ekleme; emin olmadığın noktayı belirt.
```

**Karar özeti**

```text
Son 5 yılda kira tazminatına ilişkin Yüksek Mahkeme kararlarını bul.
/v1/search?q=kira tazminat&type=karar&court=Yüksek Mahkeme&year=2024 kullan.
Her karar için esas numarası, tarih, taraflar ve sonucu özetle; karar metninden alıntı yap.
```

**Madde karşılaştırma**

```text
1/1998 sayılı Yasa'nın 4. ve 5. maddelerini getir (/articles/4 ve /articles/5).
İki maddeyi yan yana karşılaştır; değişiklik tarihlerini belge künyesinden aktar.
```

## Doğruluk kontrol listesi

- [ ] Her hüküm için `id`, madde numarası ve `source_url` verildi mi?
- [ ] `text_status=metadata` olan belgeler için "tam metin yok" denildi mi?
- [ ] Birden çok kaynak çelişiyorsa `source=gov` olan (birleştirilmiş resmî metin) tercih edildi mi?
- [ ] Karar tarihi ve esas numarası doğru mu?
- [ ] Cevap, "resmî/bağlayıcı metin için kaynağa bakın" uyarısını içeriyor mu?

## Önbellekleme ve yük

- API anahtarı yoktur; makul kullanım beklenir.
- Aynı belgeyi tekrar tekrar çekmek yerine oturum içinde önbelleğe alın.
- Toplu kazıma (binlerce istek) yapmayın; veri kümesini kendiniz barındırmak için depoyu kullanın.
- `llms.txt` 5 dakika önbelleğe alınabilir (`cache-control: public, max-age=300`).
