/**
 * Ready-to-quote citations ("atıf") built from structured metadata, so an LLM
 * never has to compose case numbers or law numbers from memory.
 */

function trDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : iso;
}

function pair(no: unknown, year: unknown): string | null {
  if (no === null || no === undefined || no === "") return null;
  if (year === null || year === undefined || year === "") return String(no);
  return `${no}/${year}`;
}

export interface CitationInput {
  type: string;
  title: string;
  number: string | null;
  year: number | null;
  date: string | null;
  court: string | null;
  extra: unknown;
}

/**
 * Court decision: "<Mahkeme>, E. 12/2019, D. 5/2021, 14.03.2021".
 * E./D. mirror the catalog's Enumara/Yile and Dnumara/Yild fields, same labels
 * as the crawler's `number` field.
 * Other documents: "<başlık> (<sayı>/<yıl> sayılı)" when a number exists.
 */
export function buildCitation(doc: CitationInput): string {
  if (doc.type === "karar") {
    const extra = (doc.extra && typeof doc.extra === "object" ? doc.extra : {}) as Record<string, unknown>;
    const parts: string[] = [doc.court?.trim() || "Mahkeme Kararı"];
    const esas = pair(extra.enumara, extra.yile);
    const karar = pair(extra.dnumara, extra.yild);
    if (esas) parts.push(`E. ${esas}`);
    if (karar) parts.push(`D. ${karar}`);
    if (!esas && !karar && doc.number) parts.push(doc.number);
    const date = trDate(doc.date);
    if (date) parts.push(date);
    return parts.join(", ");
  }
  const title = doc.title.trim();
  if (doc.number && !title.includes(String(doc.number))) {
    return doc.year && !String(doc.number).includes("/")
      ? `${title} (${doc.number}/${doc.year} sayılı)`
      : `${title} (${doc.number})`;
  }
  return title;
}
