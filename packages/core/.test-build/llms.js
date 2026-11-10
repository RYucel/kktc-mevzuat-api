import { DOC_TYPES, TYPE_LABELS } from "./types.js";
function num(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}
function typeTable(stats) {
    const byType = stats.by_type;
    if (!Array.isArray(byType) || !byType.length)
        return "- (istatistik henüz yok)";
    return byType
        .map((entry) => {
        const row = entry;
        const key = String(row.type);
        return `- ${TYPE_LABELS[key] ?? key} (\`${key}\`): ${num(row.documents)} belge, ${num(row.full_text)} tam metin`;
    })
        .join("\n");
}
function sourceCoverage(stats) {
    const rows = stats.by_source;
    if (!Array.isArray(rows))
        return "";
    const gov = rows.find((entry) => entry.source === "gov");
    if (!gov)
        return "";
    return `- Güncel birleştirilmiş metin (\`gov\`): ${num(gov.documents)} belge, ${num(gov.full_text)} tam metin`;
}
export function llmsText(origin, stats) {
    const documents = num(stats.document_count);
    const chunks = num(stats.chunk_count);
    const chars = num(stats.chars);
    return `# KKTC Mevzuat API

> Kuzey Kıbrıs Türk Cumhuriyeti (KKTC) yürürlükteki yasaları, tüzükleri, anayasa metinleri
> ve mahkeme kararları için anahtarsız, salt-okunur arama API'si. Türkçe tam metin arama,
> madde bazlı erişim, Markdown çıktısı ve MCP araçları sunar.

Base URL: ${origin}
LLM talimatları: ${origin}/llms.txt
OpenAPI: ${origin}/openapi.json
MCP: ${origin}/mcp (Streamable HTTP, POST)

## Bu API'yi nasıl kullanmalıyım?

1. **Önce arayın.** Konuyla ilgili belgeleri bulmak için \`/v1/search?q=...\` kullanın.
   Varsayılan \`mode=auto\` önce tüm sözcükleri arar; sonuç yoksa \`any\`'ye düşer ve
   \`relaxed=true\` döner. Hukuk sorularında \`prefer=mevzuat\` kullanın. Sonuçlardaki
   \`snippet\`, \`matched_ref\`, \`matched_text\`, \`matched_url\`, \`text_status\` ve \`id\`
   alanlarını okuyun. \`matched_text\` eşleşen maddenin tam metnidir; \`matched_url\`
   doğrudan o maddeye gider.
1b. **Hızlı alıntı.** \`/v1/answer?q=...&format=markdown\` en iyi pasajı birebir alıntılar,
   \`citation\` ve \`source_url\` ile döndürür. Üretken değildir; hukuki yorum yapmaz.
2. **Tam metni alın.** \`/v1/documents/{id}?format=markdown\` ile belgenin tam metnini alın.
3. **Tek maddeye gidin.** \`/v1/documents/{id}/articles/12\` (veya \`30A\`) ile ilgili maddeyi alın.
4. **Atıf yapın.** Her sonuçtaki hazır \`citation\` alanını aynen kullanın (ör. mahkeme, E./D. no, tarih);
   künyeyi kendiniz oluşturmayın. Yanına \`source_url\` bağlantısını ekleyin.
   Yasa/tüzüklerde \`consolidated_through\` metnin hangi değişikliğe kadar birleştirildiğini
   gösterir (ör. \`25/2026\`); güncellik sorulduğunda bunu belirtin. Boşsa metin ya hiç değiştirilmemiştir
   ya da başlığında değişiklik listesi yoktur.
5. **Emin değilseniz arayın.** Metinde olmayan bir hüküm uydurmayın; \`text_status\` değeri
   \`metadata\` ise tam metin indekslenmemiştir, yalnızca künye ve resmî PDF bağlantısı vardır.

### Hukuk sorusu akışı

"Doğal dille" sorulan sorularda (\`mal paylaşımında eşlere düşen en az oran\` gibi):

1. \`/v1/search?q=...&prefer=mevzuat&type=yasa\` ile başlayın. \`mode=auto\` zaten gevşetir.
2. \`matched_text\` varsa onu okuyun; yoksa \`matched_url\` veya \`/articles/{ref}\` ile maddeyi alın.
3. Metinde **birebir yazmayan** ama matematiksel olarak çıkan sonuçları açıkça "çıkarım" olarak belirtin.
   Örnek: "bir tarafa düşen pay 2/3'ten fazla olamaz" hükmü, diğer tarafın **en az 1/3** alması anlamına gelir;
   ancak mahkemenin hakkaniyet takdirini ortadan kaldırmaz.
4. Cevabı \`citation\` + \`matched_url\` / \`source_url\` ile verin; hangi maddeye dayandığını söyleyin.
5. \`text_status=metadata\` ise tam metin olmadığını açıkça söyleyin; uydurmayın.

Her JSON yanıtında \`_meta.hint\` ve \`_meta.docs\` alanları bu talimatlara geri bağlantı verir.

## Kapsam

- Toplam belge: **${documents}**
- Metin parçası (chunk): **${chunks}**
- İndekslenen karakter: **${chars}**

${typeTable(stats)}
${sourceCoverage(stats)}

Kaynaklar:
- https://mevzuat.gov.ct.tr — Merkezi Mevzuat Dairesi, birleştirilmiş/güncel metinler (öncelikli)
- https://mevzuat.mahkemeler.net — Mahkemeler Mevzuat Bilgi Sistemi; çok daha geniş yasa kataloğu
  (birleştirilmiş metinler) ve mahkeme kararları

## Kaynak önceliği

- Her iki kaynak da birleştirilmiş metin yayımlar ("… sayılı Değişiklik Yasaları ile değiştirilmiş
  ve birleştirilmiş şekliyle"). Aynı yasa iki kaynakta da varsa \`gov\` sürümü kullanılır;
  \`sources\` alanı diğer kaydı gösterir.
- \`gov\` yalnızca yasaların küçük bir kısmını taşır. Gelir Vergisi, Katma Değer Vergisi ve Sosyal
  Sigortalar gibi birçok yasa **yalnızca \`mahkemeler\` kaynağındadır**; bu yüzden \`source=gov\`
  filtresini yalnızca gerektiğinde kullanın.
- Güncellik için \`consolidated_through\` alanına bakın (metnin içerdiği son değişiklik).
- \`mahkemeler\` kaynağındaki eski PDF'lerin bir kısmı taranmış görüntüdür; \`text_status=metadata\`
  ise tam metin yoktur, yalnızca künye ve dosya bağlantısı vardır.
- **Mahkeme kararları yalnızca \`mahkemeler\` kaynağındadır.**
- Arama, \`gov\` ve yasa/tüzük/anayasa sonuçlarını hafifçe üst sıralara taşır; \`prefer=mevzuat\`
  bu avantajı belirginleştirir.

## Uçlar

### 1) Arama — \`GET /v1/search\`

Parametreler:
- \`q\` (zorunlu): arama sözcükleri. Türkçe karakterler ve büyük/küçük harf farkı önemsizdir.
- \`mode\`: \`auto\` (varsayılan; önce tüm sözcükler, sonuç yoksa herhangi biri), \`all\`, \`any\`, \`phrase\`.
- \`type\`: ${DOC_TYPES.map((type) => `\`${type}\``).join(", ")}.
- \`year\`: 4 haneli yıl (ör. 1998).
- \`source\`: \`gov\` veya \`mahkemeler\` (ikisi de birleştirilmiş metin; birçok yasa yalnızca \`mahkemeler\`'dedir).
- \`court\`: mahkeme adı içinde geçen ifade (ör. \`Yargıtay\`); \`GET /v1/stats\` → \`courts\` listesinde tüm adlar var.
- \`prefer\`: \`mevzuat\` (yasa/tüzük/anayasa önce) veya \`ictihat\` (kararlar önce).
- \`min_score\`: bu skorun altındaki sonuçları eler (varsayılan 0). Ham BM25 skorudur;
  sorgular arasında karşılaştırmayın.
- \`semantic\`: \`0\` anlamsal (vektör) sıralamayı kapatır. Varsayılan açıktır; doğal dilde
  sorulan mevzuat sorularında sonuçlar BM25 ile vektör benzerliğinin birleşimiyle (RRF) sıralanır
  (\`ranking: "hybrid"\`). Tek kelimelik aramalar, numaralar, tırnaklı ifadeler ve kararlar
  anahtar kelimeyle aranır. Karma sıralamada \`score\` RRF ölçeğindedir (en fazla ~100;
  kanonik yasalar 120).
- \`exact_count\`: \`1\` ise pahalı \`COUNT(DISTINCT)\` çalışır; varsayılan \`0\` yalnızca getirilen
  pencereyi sayar (D1 okuma kotasını korur).
- \`limit\`: 1–50 (varsayılan 10).
- \`offset\`: 0–1000 (varsayılan 0).

Kesirler tek token olarak aranır: \`2/3\`, \`üçte iki\` ve \`1/3\` gibi ifadeler doğru maddeyi bulur;
\`2/3\` artık \`23\` ile karışmaz. Yanıtta \`candidate_documents\` (aday), \`relevant_documents\`
(eşiği geçen), \`relaxed\`, \`groups\` ve \`highlights\` alanları bulunur.

Sorgu bir hukuk kavramına denk gelirse (\`mal paylaşımı\`, \`nafaka\`, \`kıdem tazminatı\`,
\`KDV\`, \`tutuklama\`...) API o kavramın **kanonik yasasını** öne çıkarır ve yanıtta
\`concepts\` ile \`primary_documents\` döner. Doğal dil sorularında kavram terimleriyle ek arama
da yapılır; \`concept_expanded=true\` bunu gösterir.

Örnekler:
\`\`\`bash
curl "${origin}/v1/search?q=nafaka"
curl "${origin}/v1/search?q=nafaka&type=yasa&source=gov"
curl "${origin}/v1/search?q=%22mal%20payla%C5%9F%C4%B1m%C4%B1%22&type=yasa"
curl "${origin}/v1/search?q=mal%20payla%C5%9F%C4%B1m%C4%B1&prefer=mevzuat&type=yasa"
curl "${origin}/v1/search?q=mal%20payla%C5%9F%C4%B1m%C4%B1%202%2F3&prefer=mevzuat"
curl "${origin}/v1/search?q=kira%20tazminat&type=karar&year=2024&limit=5"
curl "${origin}/v1/search?q=kefalet&mode=any&limit=20&offset=20"
\`\`\`

Yanıt (kısaltılmış):
\`\`\`json
{
  "query": "nafaka",
  "mode": "auto",
  "effective_mode": "all",
  "relaxed": false,
  "concepts": [{ "id": "nafaka", "label": "Nafaka" }],
  "concept_expanded": false,
  "concept_documents": 0,
  "primary_documents": 1,
  "count": 1,
  "candidate_documents": 37,
  "exact_count": false,
  "relevant_documents": 20,
  "total_documents": 37,
  "min_score": 0,
  "has_more": true,
  "next": "${origin}/v1/search?q=nafaka&limit=10&offset=10",
  "groups": { "mevzuat": [], "ictihat": [] },
  "results": [{
    "id": "yasa-1-1998",
    "title": "1/1998 SAYILI AİLE (EVLENME VE BOŞANMA) YASASI",
    "number": "1/1998",
    "citation": "1/1998 SAYILI AİLE (EVLENME VE BOŞANMA) YASASI",
    "text_status": "full",
    "matched_ref": "Madde 26",
    "matched_part": "1/7",
    "matched_url": "${origin}/v1/documents/yasa-1-1998/articles/26",
    "matched_text": "26. Mahkeme … 2/3'ünden fazla olamaz.",
    "snippet": "…",
    "highlights": [{ "start": 12, "end": 15 }],
    "score": 1.234,
    "url": "${origin}/v1/documents/yasa-1-1998"
  }]
}
\`\`\`

\`score\` büyük olan daha iyidir. \`candidate_documents\` getirilen penceredeki aday belge sayısıdır
(\`exact_count=1\` ise FTS toplamı); \`total_documents\` geriye dönük uyumluluk için aynı değeri
taşır. \`relevant_documents\` getirilen pencere içinde \`min_score\` eşiğini geçen belge sayısıdır.

### 1b) Alıntı yanıtı — \`GET /v1/answer\`

Parametreler: \`q\` (zorunlu), \`type?\`, \`prefer?\`, \`mode?\`, \`limit\` (1–5), \`rerank=0?\`, \`format=json|markdown\`.

\`\`\`bash
curl "${origin}/v1/answer?q=mal%20payla%C5%9F%C4%B1m%C4%B1nda%20e%C5%9Flere%20d%C3%BC%C5%9Fen%20en%20az%20oran&format=markdown"
\`\`\`

Yanıt \`answer\`, \`quotes\`, \`citations\`, \`confidence\` ve \`disclaimer\` içerir. \`answer_type\`
her zaman \`extractive\`dır: metin birebir alıntılanır, yeniden yazılmaz.

Doğal dil sorularında (ör. "İşveren maaşımdan kesinti yapabilir mi?") ilk 10 aday Cloudflare
Clef ile yeniden sıralanır; \`quotes[].probability\` ve \`rerank.top_probability\` pasajın soruyu
cevaplama olasılığıdır ve \`confidence\` buradan gelir. \`confidence: low\` ise alıntıyı cevap
saymayın, \`/v1/search\` ile daha geniş arayın. Kısa anahtar kelime aramaları yeniden sıralanmaz. Günlük Clef
sınırı dolarsa \`rerank.error: "daily_limit"\` döner ve sıralama aramadan gelir.

İstemci başına dakikada yaklaşık 30 istek sınırı vardır; aşılırsa \`429 rate_limited\` ve
\`retry-after: 60\` döner. Aynı soruyu tekrarlamak yerine yanıtı saklayın. Ayrıca hizmetin toplam bir
dakika sınırı vardır; aşılırsa \`503 busy\` ve \`retry-after\` saniyesi döner.

### 2) Belge — \`GET /v1/documents/{id}\`

- \`format=json\` (varsayılan): künye + \`content\` (tam metin) + \`_meta\`.
- \`format=markdown\` veya \`md\`: LLM'e doğrudan verilebilir Markdown.
- \`format=text\`: yalnızca düz metin.
- \`include_chunks=1\`: madde/paragraf parçalarını da döndürür.

Örnek:
\`\`\`bash
curl "${origin}/v1/documents/yasa-1-1998?format=markdown"
\`\`\`

### 3) Madde — \`GET /v1/documents/{id}/articles/{ref}\`

\`ref\` şu biçimlerde olabilir: \`12\`, \`Madde 12\`, \`m. 12\`, \`30A\`.
Uzun maddeler birden çok parçaya bölünmüşse \`parts\` dizisinde döner.

\`\`\`bash
curl "${origin}/v1/documents/yasa-1-1998/articles/4?format=markdown"
curl "${origin}/v1/documents/yasa-1-1998/articles/30A"
\`\`\`

Madde listesi: \`GET /v1/documents/{id}/articles\`

### 4) Yeni belgeler — \`GET /v1/recent\`

- \`type\`: isteğe bağlı tür filtresi.
- \`limit\`: 1–100 (varsayılan 20).

\`\`\`bash
curl "${origin}/v1/recent?type=karar&limit=10"
curl "${origin}/v1/recent?type=yasa&limit=20"
\`\`\`

### 5) İstatistik — \`GET /v1/stats\`

Belge sayıları, türler, yıllar, kaynaklar, tam metin durumu ve her türün en yeni tarihi.

### 6) Değişiklikler — \`GET /v1/changes\` ve \`GET /v1/documents/{id}/changes\`

Birleştirilmiş yasa ve tüzük metinleri (\`gov\`; orada olmayanlar için \`mahkemeler\`) her hafta önceki sürümle karşılaştırılır;
değişen, eklenen ve kaldırılan maddeler kaydedilir. **Takip ilk kayıt tarihinden başlar**
(\`tracking_since\`); öncesindeki değişiklikler bilinmez. Saptanma tarihi, değişikliğin
kaynakta görüldüğü haftadır, yürürlük tarihi değildir.

- \`/v1/changes\`: \`since\` (YYYY-AA-GG), \`type\`, \`limit\` (1–200). Belge başına sürüm geçişi listesi.
- \`/v1/documents/{id}/changes\`: sürümler ve her değişen maddenin \`old_text\` / \`new_text\` metni;
  \`format=markdown\` LLM'e uygundur, \`format=html\` yeşil/kırmızı görünüm verir. \`version\` ile tek geçiş.
- İnsanlar için görüntüleyici: \`${origin}/degisiklikler\`.

\`\`\`bash
curl "${origin}/v1/changes?since=2026-11-01"
curl "${origin}/v1/documents/yasa-1-1998/changes?format=markdown"
\`\`\`

## Belge kimlikleri (\`id\`)

- Yasalar: \`yasa-1-1998\`, \`yasa-fasil-57\`
- Tüzükler: \`tuzuk-...\` (numara varsa \`tuzuk-12-2020\`)
- Anayasa: \`anayasa-kktc-anayasasi\`
- Kararlar: \`karar-e-5-1990-17712\` (esas numarası + kayıt anahtarı)

Kimlikler kararlıdır; arama sonuçlarındaki \`id\` değerini doğrudan kullanın.

## Arama sözdizimi

- Varsayılan \`auto\`: önce tüm sözcükler (VE); sonuç yoksa herhangi biri (VEYA) ve \`relaxed=true\`.
- \`mode=all\`, \`mode=any\`, \`mode=phrase\` açıkça seçilebilir.
- \`prefer=mevzuat\` yasa/tüzük/anayasayı, \`prefer=ictihat\` kararları öne çıkarır.
- Tırnak içinde ifade: \`q="mal paylaşımı"\`. \`2/3\`, \`1/3\`, \`üçte iki\` tek token olarak aranır.
- 3+ harfli sözcüklerde otomatik önek araması yapılır (\`nafaka\` → \`nafaka*\`).
- Noktalama ve Türkçe diakritikler normalize edilir (ı/i, ş/s, ğ/g, ü/u, ö/o, ç/c).

## MCP (Model Context Protocol)

Sunucu: \`${origin}/mcp\` — Streamable HTTP, \`POST\` JSON-RPC 2.0.

\`\`\`json
{
  "mcpServers": {
    "kktc-mevzuat": {
      "type": "http",
      "url": "${origin}/mcp"
    }
  }
}
\`\`\`

Araçlar:
- \`sor\` — \`{ soru, type?, prefer?, adet? }\` — birebir alıntı + atıf (üretken değil)
- \`search_mevzuat\` — \`{ query, type?, year?, source?, court?, mode?, prefer?, min_score?, limit?, offset? }\`
- \`ictihat_ara\` — \`{ ifade, mahkeme?, yil?, mod?, adet?, sayfa? }\` — yalnız mahkeme kararları; sonuçlarda hazır \`citation\`
- \`karar_getir\` — \`{ id }\` — kararın künyesi, atfı ve tam metni (Markdown)
- \`list_courts\` — \`{}\` — mahkemeler, karar sayıları, yıl aralığı
- \`son_degisiklikler\` — \`{ since?, type?, limit? }\` — mevzuatta saptanan son madde değişiklikleri
- \`degisiklikleri_getir\` — \`{ id, version? }\` — bir belgenin sürüm geçmişi, maddelerin önceki/yeni metni
- \`get_document\` — \`{ id, format? }\`
- \`get_article\` — \`{ id, ref }\`
- \`list_document_articles\` — \`{ id }\`
- \`list_recent\` — \`{ type?, limit? }\`
- \`get_stats\` — \`{}\`

## Sınırlamalar ve doğruluk

- Metinler otomatik PDF/DOC çıkarımıyla üretilir; OCR gerektiren taranmış belgelerde
  \`text_status\` \`partial\` veya \`metadata\` olabilir.
- \`text_status=metadata\` ise tam metin yoktur; yalnızca künye ve \`pdf_url\` vardır.
- Birleştirilmiş metinlerde madde numaraları atlayabilir (yürürlükten kaldırılan maddeler).
- **Bağlayıcı metin resmî kaynaktır.** Yanıtlarınızda \`source_url\` bağlantısını verin ve
  gerektiğinde "resmî metin için kaynağa bakın" uyarısını ekleyin.
- API anahtarı gerekmez. Lütfen ölçülü kullanın, sonuçları önbelleğe alın ve toplu
  kazıma (bulk scraping) yapmayın.

## Hızlı curl özeti

\`\`\`bash
curl "${origin}/v1/search?q=nafaka&limit=5"
curl "${origin}/v1/documents/yasa-1-1998?format=markdown"
curl "${origin}/v1/documents/yasa-1-1998/articles/4"
curl "${origin}/v1/recent?type=karar&limit=5"
curl "${origin}/v1/changes?since=2026-11-01"
curl "${origin}/v1/documents/yasa-1-1998/changes?format=markdown"
curl "${origin}/v1/stats"
\`\`\`
`;
}
