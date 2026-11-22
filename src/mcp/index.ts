/**
 * Full-text index over the Mobile Provider Billing Guide.
 *
 * Indexing approach (built ONCE at server start, never per question):
 *  1. Parse the markdown into sections by heading (H1-H4), keeping the heading path as the section reference.
 *  2. Split long sections into chunks of at most MAX_CHUNK_CHARS on paragraph/list-block boundaries.
 *  3. Tokenise (lowercase, stop-word removal, light stemming, small synonym expansion at query time) and
 *     build an inverted index scored with Okapi BM25. Heading tokens are indexed with extra weight.
 */
export const MAX_CHUNK_CHARS = 900;

export interface GuideChunk {
  id: string;
  /** Heading path, e.g. "Extra Charges > Internet". */
  section: string;
  headings: string[];
  /** Numeric section id taken from the heading, e.g. "3.2" ("" when the heading is not numbered). */
  sectionId: string;
  /** Title of the most specific heading without its number, e.g. "Additional internet blocks". */
  heading: string;
  text: string;
}

export interface SearchHit {
  /** Citation string the agent shows to the user, e.g. "Mobile_Provider_Billing_Guide.md § Extra Charges". */
  reference: string;
  chunkId: string;
  /** Heading path, e.g. "Internet pricing > 3.2 Additional internet blocks". */
  section: string;
  /** Section number, e.g. "3.2". */
  sectionId: string;
  /** Most specific heading title, e.g. "Additional internet blocks". */
  heading: string;
  /** Document ID declared in the guide (e.g. MOB-BILLING-2026-01), empty if the guide has none. */
  documentId: string;
  score: number;
  excerpt: string;
}

const STOPWORDS = new Set(("a an and are as at be by for from has have how i if in is it its me my of on or our that the their them this to was were what when where which who will with you your do does can could should would about any there than then").split(" "));

const SYNONYMS: Record<string, string[]> = {
  extra: ["additional", "overage", "excess", "beyond", "exceed"],
  additional: ["extra", "overage"],
  cost: ["price", "charge", "fee", "rate"],
  price: ["cost", "charge", "fee", "rate"],
  pricing: ["price", "cost", "charge"],
  fee: ["charge", "cost"],
  expensive: ["price", "charge", "higher"],
  higher: ["increase", "extra", "charge"],
  internet: ["data", "gb", "mb"],
  data: ["internet", "gb", "mb"],
  minutes: ["phone", "call", "voice"],
  call: ["phone", "minutes", "voice"],
  bill: ["invoice", "statement"],
  invoice: ["bill", "statement"],
  late: ["overdue", "delay", "past", "due"],
  overdue: ["late", "past", "due"],
  dispute: ["objection", "complaint", "challenge", "incorrect"],
  complaint: ["dispute", "objection"],
  partial: ["installment", "part", "portion"],
  cycle: ["period", "month", "billing"],
  installment: ["partial", "part"],
};

/** Domain normalisation: pay / paid / paying / payment(s) are one concept for billing questions. */
const PAY_FORMS = new Set(["pay", "pays", "paid", "paying", "payment", "payments"]);

export function stem(token: string): string {
  if (PAY_FORMS.has(token)) return "pay";
  if (token.length > 4 && token.endsWith("ies")) return token.slice(0, -3) + "y";
  if (token.length > 5 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("es") && /(s|x|z|ch|sh)es$/.test(token)) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/(\d),(\d)/g, "$1$2")
    .split(/[^a-z0-9$]+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t))
    .map(stem);
}

/** Splits "3.2 Additional internet blocks" / "2. Phone call pricing" into its number and title. */
export function parseHeading(title: string | undefined): { sectionId: string; heading: string } {
  const m = /^(\d+(?:\.\d+)*)\.?\s+(.*)$/.exec(title ?? "");
  return m ? { sectionId: m[1]!, heading: m[2]! } : { sectionId: "", heading: title ?? "" };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function splitLongText(text: string): string[] {
  if (text.length <= MAX_CHUNK_CHARS) return [text];
  const blocks = text.split(/\n{2,}|\n(?=[-*] )/);
  const out: string[] = [];
  let current = "";
  for (const block of blocks) {
    if (current && (current + "\n" + block).length > MAX_CHUNK_CHARS) {
      out.push(current);
      current = block;
    } else {
      current = current ? `${current}\n${block}` : block;
    }
  }
  if (current) out.push(current);
  return out.flatMap((part) => {
    if (part.length <= MAX_CHUNK_CHARS * 1.5) return [part];
    const pieces: string[] = [];
    for (let i = 0; i < part.length; i += MAX_CHUNK_CHARS) pieces.push(part.slice(i, i + MAX_CHUNK_CHARS));
    return pieces;
  });
}

export function chunkMarkdown(markdown: string): GuideChunk[] {
  const lines = markdown.replace(/\r\n/g, "\n").replace(/<!--[\s\S]*?-->/g, "").split("\n");
  const stack: Array<{ level: number; title: string }> = [];
  const sections: Array<{ headings: string[]; body: string[] }> = [];
  let current: { headings: string[]; body: string[] } = { headings: [], body: [] };
  sections.push(current);

  for (const line of lines) {
    const heading = /^(#{1,4})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, title: heading[2]! });
      current = { headings: stack.map((s) => s.title), body: [] };
      sections.push(current);
    } else {
      current.body.push(line);
    }
  }

  const chunks: GuideChunk[] = [];
  const seen = new Map<string, number>();
  for (const section of sections) {
    const body = section.body.join("\n").trim();
    if (!body) continue;
    const parts = splitLongText(body);
    parts.forEach((part, index) => {
      const base = slug(section.headings.join("-")) || "preamble";
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      const suffix = parts.length > 1 ? `-p${index + 1}` : "";
      chunks.push({
        id: n > 1 ? `${base}${suffix}-${n}` : `${base}${suffix}`,
        section: section.headings.length ? section.headings.join(" > ") : "Introduction",
        headings: section.headings,
        ...parseHeading(section.headings[section.headings.length - 1]),
        text: part.trim(),
      });
    });
  }
  return chunks;
}

const K1 = 1.2;
const B = 0.75;
const HEADING_WEIGHT = 3;
const MIN_RELATIVE_SCORE = 0.25;

export class BillingGuideIndex {
  readonly chunks: GuideChunk[];
  readonly builtAt = new Date().toISOString();
  /** "Document ID" line of the guide, e.g. MOB-BILLING-2026-01. */
  readonly documentId: string;
  private readonly postings = new Map<string, Map<number, number>>();
  private readonly lengths: number[] = [];
  private readonly avgLength: number;

  constructor(markdown: string, readonly source = "Mobile_Provider_Billing_Guide.md") {
    this.chunks = chunkMarkdown(markdown);
    this.documentId = /\*{0,2}Document ID:?\*{0,2}:?\s*([A-Za-z0-9._-]+)/i.exec(markdown)?.[1] ?? "";
    this.chunks.forEach((chunk, docId) => {
      const tokens = tokenize(chunk.text);
      const headingTokens = tokenize(chunk.headings.join(" "));
      const counts = new Map<string, number>();
      for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
      for (const t of headingTokens) counts.set(t, (counts.get(t) ?? 0) + HEADING_WEIGHT);
      let length = 0;
      for (const [term, tf] of counts) {
        length += tf;
        if (!this.postings.has(term)) this.postings.set(term, new Map());
        this.postings.get(term)!.set(docId, tf);
      }
      this.lengths.push(length);
    });
    this.avgLength = this.lengths.reduce((a, b) => a + b, 0) / Math.max(1, this.lengths.length);
  }

  get stats() {
    return { source: this.source, documentId: this.documentId, chunks: this.chunks.length, terms: this.postings.size, builtAt: this.builtAt };
  }

  search(query: string, limit = 3): SearchHit[] {
    const base = tokenize(query);
    const weights = new Map<string, number>();
    for (const term of base) weights.set(term, 1);
    for (const term of base) {
      for (const synonym of SYNONYMS[term] ?? []) {
        const s = stem(synonym);
        if (!weights.has(s)) weights.set(s, 0.4);
      }
    }

    const n = this.chunks.length;
    const scores = new Map<number, number>();
    for (const [term, weight] of weights) {
      const posting = this.postings.get(term);
      if (!posting) continue;
      const idf = Math.log(1 + (n - posting.size + 0.5) / (posting.size + 0.5));
      for (const [docId, tf] of posting) {
        const norm = tf * (K1 + 1) / (tf + K1 * (1 - B + B * (this.lengths[docId]! / this.avgLength)));
        scores.set(docId, (scores.get(docId) ?? 0) + weight * idf * norm);
      }
    }

    const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
    const best = ranked[0]?.[1] ?? 0;
    return ranked
      .filter(([, score]) => score >= best * MIN_RELATIVE_SCORE) // drop incidental matches
      .slice(0, limit)
      .map(([docId, score]) => {
        const chunk = this.chunks[docId]!;
        return {
          reference: `${this.source} § ${chunk.section}`,
          chunkId: chunk.id,
          section: chunk.section,
          sectionId: chunk.sectionId,
          heading: chunk.heading,
          documentId: this.documentId,
          score: Math.round(score * 1000) / 1000,
          excerpt: chunk.text,
        };
      });
  }
}
