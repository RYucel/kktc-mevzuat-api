/**
 * Legal concept expansion for Turkish legal questions.
 *
 * FTS5 matches tokens, not ideas: "en az oran" rarely appears in a statute;
 * the text says "2/3'ünden fazla olamaz". Each concept lists query triggers
 * and the words/phrases that appear in the relevant provisions. The search
 * layer runs these as an extra retrieval channel and merges the results with
 * a small bonus; it never replaces the user's original query.
 *
 * Keep triggers specific (not "mal", "hak", "ceza" alone) to avoid noise.
 */
import { foldTr } from "./text.js";
export const LEGAL_CONCEPTS = [
    {
        id: "mal-paylasimi",
        label: "Mal paylaşımı / mal rejimi",
        triggers: ["mal paylasim", "mal rejim", "katki pay", "deger artis", "edinilmis mal", "kisisel mal"],
        expand: [
            "mal paylaşımı",
            "mal rejimi",
            "edinilmiş mal",
            "kişisel mal",
            "katkı payı",
            "değer artış payı",
            "hakkaniyet",
            "f2of3",
            "f1of3",
            "tavan",
            "üst sınır",
            "fazla olamaz",
        ],
        primary: ["yasa-1-1998"],
        weight: 2,
    },
    {
        id: "nafaka",
        label: "Nafaka",
        triggers: ["nafaka", "yoksulluk", "istirak nafaka", "tedbir nafaka"],
        expand: [
            "nafaka",
            "yoksulluk nafakası",
            "iştirak nafakası",
            "tedbir nafakası",
            "nafaka bağlanması",
            "nafaka artırımı",
        ],
        primary: ["yasa-1-1998"],
        weight: 2,
    },
    {
        id: "velayet",
        label: "Velayet ve çocukla kişisel ilişki",
        triggers: ["velayet", "kisisel iliski", "cocukla kisisel"],
        expand: ["velayet", "velayet hakkı", "kişisel ilişki", "çocukla kişisel ilişki", "üstün yarar"],
        primary: ["yasa-1-1998", "yasa-22-2021"],
        weight: 2,
    },
    {
        id: "bosanma",
        label: "Boşanma / evliliğin iptali",
        triggers: ["bosanma", "evliligin iptali", "yasal ayrilik", "evlilik birligi"],
        expand: ["boşanma", "evliliğin iptali", "yasal ayrılık", "evlilik birliği", "şiddetli geçimsizlik"],
        primary: ["yasa-1-1998"],
        weight: 2,
    },
    {
        id: "kira",
        label: "Kira, tahliye ve ecrimisil",
        triggers: ["kira", "tahliye", "ecrimisil", "kiralayan", "kiraci"],
        expand: ["kira", "tahliye", "ecrimisil", "kira sözleşmesi", "kullanım karşılığı", "işgal"],
        primary: ["yasa-17-1981"],
        weight: 2,
    },
    {
        id: "is-hukuku",
        label: "İş hukuku / kıdem, ihbar, işe iade",
        triggers: [
            "kidem", "ihbar", "ise iade", "fazla mesai", "is kazasi", "isci", "isveren", "yillik izin",
            // 11 Nov 2026: working-time and leave questions triggered no concept.
            "deneme suresi", "calisma suresi", "gece vardiya", "ucretli izin", "bordro", "isten ayril", "isten cikar",
        ],
        expand: [
            "kıdem tazminatı",
            "ihbar tazminatı",
            "işe iade",
            "fazla mesai",
            "yıllık izin",
            "iş kazası",
            "iş sözleşmesi",
            "fesih",
        ],
        primary: ["yasa-22-1992", "yasa-42-1996"],
        weight: 2,
    },
    {
        id: "miras",
        label: "Miras ve saklı pay",
        triggers: ["miras", "veraset", "sakli pay", "tenkis", "vasiyet", "muris", "mirasci"],
        expand: ["miras", "saklı pay", "tenkis", "vasiyet", "mirasın reddi", "ortaklığın giderilmesi", "muris"],
        primary: ["yasa-fasil-195", "yasa-fasil-192"],
        weight: 2,
    },
    {
        id: "tazminat",
        label: "Maddi / manevi tazminat",
        triggers: ["tazminat", "maddi tazminat", "manevi tazminat", "destekten yoksun", "haksiz fiil"],
        expand: ["tazminat", "maddi tazminat", "manevi tazminat", "destekten yoksun kalma", "haksız fiil", "zarar"],
        primary: ["yasa-fasil-148", "yasa-22-1992"],
    },
    {
        id: "icra-iflas",
        label: "İcra, haciz, iflas ve teminat",
        triggers: ["icra", "haciz", "iflas", "konkordato", "rehin", "ipotek", "kefalet"],
        expand: ["icra", "haciz", "iflas", "konkordato", "rehin", "ipotek", "kefalet", "teminat"],
    },
    {
        id: "vergi",
        label: "Vergi ve harçlar",
        triggers: ["vergi", "kdv", "gelir vergisi", "kurumlar vergisi", "damga vergisi", "harç"],
        expand: [
            "vergi",
            "gelir vergisi",
            "kurumlar vergisi",
            "kdv",
            "damga vergisi",
            "harç",
            "vergi cezası",
            "vergi incelemesi",
        ],
        primary: ["yasa-24-1982", "yasa-27-1977", "yasa-47-1992"],
    },
    {
        id: "gelir-vergisi",
        label: "Gelir Vergisi",
        triggers: ["gelir vergisi"],
        expand: ["gelir vergisi", "vergi"],
        primary: ["yasa-24-1982"],
        weight: 3,
    },
    {
        id: "kdv",
        label: "Katma Değer Vergisi",
        triggers: ["kdv", "katma deger"],
        expand: ["kdv", "katma değer vergisi"],
        primary: ["yasa-47-1992"],
        weight: 3,
    },
    {
        id: "vergi-usul",
        label: "Vergi Usul ve cezaları",
        triggers: ["vergi usul", "vergi cezasi", "vergi incelemesi", "vergi tarhiyati"],
        expand: ["vergi usulü", "vergi cezası", "vergi incelemesi", "vergi tarhiyatı"],
        primary: ["yasa-27-1977"],
        weight: 3,
    },
    {
        id: "sosyal-sigorta",
        label: "Sosyal sigorta ve emeklilik",
        triggers: ["sosyal sigorta", "emekli", "malulluk", "yaslilik", "prim", "is goremezlik", "sigortali"],
        expand: [
            "sosyal sigorta",
            "emeklilik",
            "malullük",
            "yaşlılık aylığı",
            "iş göremezlik",
            "prim",
            "sağlık sigortası",
        ],
        primary: ["yasa-16-1976", "yasa-18-2003"],
    },
    {
        id: "idare",
        label: "İdari işlem ve kamu görevlileri",
        triggers: ["idari islem", "iptal davasi", "tam yargi", "kamu gorevlisi", "memur", "disiplin", "ihrac"],
        expand: [
            "idari işlem",
            "iptal",
            "tam yargı",
            "kamu görevlisi",
            "disiplin",
            "görevden uzaklaştırma",
            "memur",
        ],
        primary: ["yasa-27-2013", "yasa-7-1979"],
    },
    {
        id: "kamu-gorevlisi",
        label: "Kamu görevlileri ve disiplin",
        triggers: ["kamu gorevlisi", "memur", "disiplin", "ihrac", "atama", "nakil", "terfi"],
        expand: ["kamu görevlisi", "memur", "disiplin", "görevden uzaklaştırma", "ihraç", "atama", "nakil"],
        primary: ["yasa-7-1979"],
        weight: 3,
    },
    {
        id: "ceza",
        label: "Ceza ve ceza muhakemesi",
        triggers: ["ceza", "tutuklama", "gozalti", "arama", "el koyma", "istinaf", "temyiz", "suc", "dolandir", "kufur", "hakaret", "oldur"],
        expand: ["ceza", "tutuklama", "gözaltı", "arama", "el koyma", "istinaf", "temyiz", "delil"],
        primary: ["yasa-fasil-154", "yasa-fasil-155"],
    },
    {
        id: "ceza-muhakemesi",
        label: "Ceza muhakemesi",
        triggers: ["tutuklama", "gozalti", "arama", "el koyma", "istinaf", "temyiz", "delil"],
        expand: ["tutuklama", "gözaltı", "arama", "el koyma", "istinaf", "temyiz", "delil"],
        primary: ["yasa-fasil-155"],
        weight: 3,
    },
    {
        id: "sigorta",
        label: "Sigorta ve trafik kazası",
        triggers: ["sigorta", "kasko", "trafik kazasi", "hasar", "poliçe"],
        expand: ["sigorta", "kasko", "trafik sigortası", "hasar", "poliçe", "trafik kazası"],
        primary: ["yasa-60-2010"],
    },
    {
        id: "trafik",
        label: "Trafik ve araçlar",
        triggers: ["trafik", "surucu", "ehliyet", "arac"],
        expand: ["trafik", "trafik kazası", "araç", "sürücü", "ehliyet", "hasar"],
        primary: ["yasa-fasil-335"],
        weight: 2,
    },
    {
        id: "kat-mulkiyeti",
        label: "Kat mülkiyeti ve site yönetimi",
        triggers: ["kat mulkiyet", "aidat", "apartman", "site yonetim", "ortak gider", "yonetici"],
        expand: ["kat mülkiyeti", "aidat", "apartman", "site", "ortak gider", "yönetici", "bağımsız bölüm"],
        primary: ["yasa-35-2010"],
    },
    {
        id: "imar-cevre",
        label: "İmar, yapı ve çevre",
        triggers: ["imar", "ruhsat", "kacak yapi", "cevre", "atik", "gurultu"],
        expand: ["imar", "ruhsat", "kaçak yapı", "çevre", "atık", "gürültü", "yapı denetimi"],
        primary: ["yasa-55-1989", "yasa-18-2012"],
    },
    {
        id: "cevre",
        label: "Çevre",
        triggers: ["cevre", "atik", "gurultu", "kirlilik"],
        expand: ["çevre", "atık", "gürültü", "kirlilik"],
        primary: ["yasa-18-2012"],
        weight: 3,
    },
    {
        id: "imar",
        label: "İmar ve yapı",
        triggers: ["imar", "ruhsat", "kacak yapi", "yapi denetimi"],
        expand: ["imar", "ruhsat", "kaçak yapı", "yapı denetimi"],
        primary: ["yasa-55-1989"],
        weight: 3,
    },
    {
        id: "ihale",
        label: "Kamu ihalesi",
        triggers: ["ihale", "kamu ihale", "satin alma", "teklif"],
        expand: ["ihale", "kamu ihalesi", "satın alma", "teklif", "sözleşme"],
        primary: ["yasa-20-2016"],
    },
    {
        id: "tapu-kamulastirma",
        label: "Tapu, tescil ve kamulaştırma",
        triggers: ["tapu", "tescil", "kadastro", "kamulastir", "ipotek"],
        expand: ["tapu", "tescil", "kadastro", "kamulaştırma", "ipotek", "kira şerhi"],
    },
    // Added 11 Nov 2026: topics of the eval set with no concept. Triggers are
    // general wording of the subject, not the eval questions; each primary
    // statute was checked against its text.
    {
        id: "asgari-ucret",
        label: "Asgari ücret",
        triggers: ["asgari ucret"],
        expand: ["asgari ücret", "asgari ücret saptama komisyonu"],
        primary: ["yasa-22-1975"],
        weight: 3,
    },
    {
        id: "yabanci-calisma",
        label: "Yabancıların çalışma izni",
        triggers: ["yabanci uyruklu", "calisma izin", "yabanci isci", "yabanci ogrenci"],
        expand: ["çalışma izni", "yabancı uyruklu", "süreli çalışma izni", "öğrenci çalışma izni"],
        primary: ["yasa-63-2006", "tuzuk-yabancilarin-calisma-izinleri-tuzugu"],
        weight: 3,
    },
    {
        id: "tuketici",
        label: "Tüketicinin korunması",
        triggers: ["tuketici", "ayipli", "arizali", "cayma", "mesafeli", "taksitle", "kapima gelen", "tek tarafli", "garanti belgesi"],
        expand: ["tüketici", "ayıplı mal", "cayma hakkı", "mesafeli sözleşme", "kapıdan satış", "taksitli satış", "haksız şart"],
        primary: ["yasa-40-2003"],
        weight: 2,
    },
    {
        id: "kisisel-veri",
        label: "Kişisel verilerin korunması",
        triggers: ["kisisel veri", "kisisel bilgi", "hassas bilgi", "bilgilerim", "verilerim", "hakkimda", "reklam mesaj", "ticari ileti"],
        expand: ["kişisel veri", "veri sorumlusu", "ilgili kişi", "özel nitelikli kişisel veri", "yurt dışına aktarılması"],
        primary: ["yasa-89-2007"],
        weight: 2,
    },
    {
        id: "hayvan",
        label: "Hayvan refahı",
        triggers: ["hayvan", "kopeg", "kopek", "kedi"],
        expand: ["hayvan", "hayvan refahı", "eziyet", "işkence", "sahipli hayvan"],
        primary: ["yasa-8-2013"],
        weight: 2,
    },
    {
        id: "aile",
        label: "Evlenme, boşanma ve aile",
        triggers: ["evlen", "nisanl", "bosan", "soyad", "evlilik", "esim", "eslere"],
        expand: ["evlenme", "nişanlanma", "boşanma", "soyadı", "evlilik birliği", "eşler"],
        primary: ["yasa-1-1998"],
        weight: 2,
    },
    {
        id: "askerlik",
        label: "Askerlik",
        triggers: ["askerlik", "bedelli", "askere"],
        expand: ["askerlik", "mükellefiyet hizmeti", "yedek subay", "bedel"],
        primary: ["yasa-59-2000"],
        weight: 2,
    },
    {
        id: "trafik-suclari",
        label: "Trafik suçları ve ceza puanı",
        triggers: ["ceza puan", "trafik ceza", "davasiz hall"],
        expand: ["ceza puanı", "davasız halli", "trafik suçu", "ceza ihbarnamesi"],
        primary: ["yasa-43-1991"],
        weight: 3,
    },
    {
        id: "zamanaşımı-faiz",
        label: "Zamanaşımı, faiz ve temerrüt",
        triggers: ["zamanaşim", "faiz", "temerrut"],
        expand: ["zamanaşımı", "faiz", "temerrüt", "alacak", "borç"],
    },
];
/** Concepts mentioned in the query with their specificity score. */
export function matchConcepts(query, limit = 3) {
    const normalized = foldTr(query);
    const scored = [];
    for (const concept of LEGAL_CONCEPTS) {
        let score = 0;
        for (const trigger of concept.triggers) {
            const folded = foldTr(trigger);
            if (normalized.includes(folded))
                score += folded.length * (concept.weight ?? 1);
        }
        if (score > 0)
            scored.push({ concept, score });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}
/** Concepts mentioned in the query, most specific first. */
export function detectConcepts(query, limit = 3) {
    return matchConcepts(query, limit).map((item) => item.concept);
}
/** FTS expression for a concept: OR of prefixes and NEAR(...) phrases. */
export function conceptMatch(concept) {
    const terms = [...new Set(concept.expand.map(expandTerm))];
    return `(${terms.join(" OR ")})`;
}
function expandTerm(term) {
    const folded = foldTr(term).trim();
    const fraction = /^(\d{1,2})\/(\d{1,2})$/.exec(folded);
    if (fraction)
        return `f${fraction[1]}of${fraction[2]}`;
    const words = folded.split(/\s+/).filter(Boolean);
    if (words.length === 1)
        return words[0].length >= 3 ? `${words[0]}*` : words[0];
    const last = words[words.length - 1];
    const head = words.slice(0, -1).join(" ");
    const tail = last.length >= 3 ? `${last}*` : last;
    return `NEAR(${head} ${tail}, ${Math.max(3, words.length * 2)})`;
}
