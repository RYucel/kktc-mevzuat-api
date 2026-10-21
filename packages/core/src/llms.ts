import { DOC_TYPES, TYPE_LABELS } from "./types.js";

function num(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function typeTable(stats: Record<string, unknown>): string {
  const byType = stats.by_type;
  if (!Array.isArray(byType) || !byType.length) return "- (istatistik henüz yok)";
  return byType
    .map((entry) => {
      const row = entry as Record<string, unknown>;
      const key = String(row.type);
      return `- ${TYPE_LABELS[key] ?? key} (\`${key}\`): ${num(row.documents)} belge, ${num(row.full_text)} tam metin`;
    })
    .join("\n");
}

function sourceCoverage(stats: Record<string, unknown>): string {
  const rows = stats.by_source;
  if (!Array.isArray(rows)) return "";
  const gov = rows.find((entry) => (entry as Record<string, unknown>).source === "gov") as
    | Record<string, unknown>
    | undefined;
  if (!gov) return "";
  return `- Güncel birleştirilmiş metin (\`gov\`): ${num(gov.documents)} belge, ${num(gov.full_text)} tam metin`;
}

export function llmsText(origin: string, stats: Record<string, unknown>): string {
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
   Sonuçlardaki \`snippet\`, \`matched_ref\` ve \`id\` alanlarını okuyun.
2. **Tam metni alın.** \`/v1/documents/{id}?format=markdown\` ile belgenin tam metnini alın.
3. **Tek maddeye gidin.** \`/v1/documents/{id}/articles/12\` (veya \`30A\`) ile ilgili maddeyi alın.
4. **Atıf yapın.** Yanıtınızda belgenin \`title\`, \`number\`, \`date\` ve \`source_url\` alanlarını belirtin.
5. **Emin değilseniz arayın.** Metinde olmayan bir hüküm uydurmayın; \`text_status\` değeri
   \`metadata\` ise tam metin indekslenmemiştir, yalnızca künye ve resmî PDF bağlantısı vardır.

Her JSON yanıtında \`_meta.hint\` ve \`_meta.docs\` alanları bu talimatlara geri bağlantı verir.

## Kapsam

- Toplam belge: **${documents}**
- Metin parçası (chunk): **${chunks}**
- İndekslenen karakter: **${chars}**

${typeTable(stats)}
${sourceCoverage(stats)}

Kaynaklar:
- https://mevzuat.gov.ct.tr — Merkezi Mevzuat Dairesi, birleştirilmiş/güncel metinler (öncelikli)
- https://mevzuat.mahkemeler.net — Mahkemeler Mevzuat Bilgi Sistemi, katalog ve mahkeme kararları

## Kaynak önceliği

- **Yasa ve tüzük sorularında \`source=gov\` metnini esas alın.** Bu kaynak yürürlükteki
  değişikliklerin işlendiği birleştirilmiş resmî metindir.
- Aynı belge iki kaynakta bulunuyorsa \`gov\` sürümü kullanılır; \`sources\` alanı diğer kaydı gösterir.
- \`mahkemeler\` kaynağındaki yasa/tüzük dosyaları arşiv ve karşılaştırma içindir; bazıları eski
  veya taranmış olabilir. **Mahkeme kararları yalnızca \`mahkemeler\` kaynağındadır.**
- Arama, \`gov\` sonuçlarını otomatik olarak üst sıralara taşır. Emin değilseniz \`source=gov\`
  filtresini açıkça ekleyin.

## Uçlar

### 1) Arama — \`GET /v1/search\`

Parametreler:
- \`q\` (zorunlu): arama sözcükleri. Türkçe karakterler ve büyük/küçük harf farkı önemsizdir.
- \`mode\`: \`all\` (varsayılan, tüm sözcükler), \`any\` (herhangi biri), \`phrase\` (tam ifade).
- \`type\`: ${DOC_TYPES.map((type) => `\`${type}\``).join(", ")}.
- \`year\`: 4 haneli yıl (ör. 1998).
- \`source\`: \`gov\` (güncel birleştirilmiş metin; yasa/tüzükte tercih edin) veya \`mahkemeler\`.
- \`court\`: mahkeme adı (ör. \`Yüksek Mahkeme\`).
- \`limit\`: 1–50 (varsayılan 10).
- \`offset\`: 0–1000 (varsayılan 0).

Örnekler:
\`\`\`bash
curl "${origin}/v1/search?q=nafaka"
curl "${origin}/v1/search?q=nafaka&type=yasa&source=gov"
curl "${origin}/v1/search?q=%22mal%20payla%C5%9F%C4%B1m%C4%B1%22&type=yasa"
curl "${origin}/v1/search?q=kira%20tazminat&type=karar&year=2024&limit=5"
curl "${origin}/v1/search?q=kefalet&mode=any&limit=20&offset=20"
\`\`\`

Yanıt (kısaltılmış):
\`\`\`json
{
  "query": "nafaka",
  "count": 1,
  "total_documents": 37,
  "has_more": true,
  "next": "${origin}/v1/search?q=nafaka&limit=10&offset=10",
  "results": [{
    "id": "yasa-1-1998",
    "title": "1/1998 SAYILI AİLE (EVLENME VE BOŞANMA) YASASI",
    "number": "1/1998",
    "matched_ref": "Madde 4",
    "snippet": "…",
    "score": 1.234,
    "url": "${origin}/v1/documents/yasa-1-1998"
  }]
}
\`\`\`

\`score\` büyük olan daha iyidir. \`total_documents\` filtrelere uyan belge sayısıdır.

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

## Belge kimlikleri (\`id\`)

- Yasalar: \`yasa-1-1998\`, \`yasa-fasil-57\`
- Tüzükler: \`tuzuk-...\` (numara varsa \`tuzuk-12-2020\`)
- Anayasa: \`anayasa-kktc-anayasasi\`
- Kararlar: \`karar-e-5-1990-17712\` (esas numarası + kayıt anahtarı)

Kimlikler kararlıdır; arama sonuçlarındaki \`id\` değerini doğrudan kullanın.

## Arama sözdizimi

- Varsayılan \`all\`: tüm sözcükler aranır (VE).
- \`mode=any\`: sözcüklerden herhangi biri (VEYA).
- \`mode=phrase\`: sözcükler bitişik bir ifade olarak aranır.
- Tırnak içinde ifade: \`q="mal paylaşımı"\`.
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
- \`search_mevzuat\` — \`{ query, type?, year?, mode?, limit?, offset? }\`
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
curl "${origin}/v1/stats"
\`\`\`
`;
}
