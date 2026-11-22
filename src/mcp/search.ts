export interface SearchChunk {
  id: string;
  text: string;
  terms: string[];
}

/** Split and index policy sections once when the MCP server starts. */
export function indexBillingPolicy(policyText: string): SearchChunk[] {
  return policyText
    .split(/(?=^## )/m)
    .map((text, index) => {
      const heading = text.match(/^##\s+(.+)$/m)?.[1]?.trim() ?? `Section ${index + 1}`;
      const id = heading.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      return {
        id: id || `section-${index + 1}`,
        text: text.trim(),
        terms: [...new Set(text.toLowerCase().split(/\W+/).filter((term) => term.length > 2))],
      };
    });
}

export function searchIndexedBillingPolicy(index: SearchChunk[], query: string): Array<SearchChunk & { score: number }> {
  const terms = query.toLowerCase().split(/\W+/).filter((term) => term.length > 2);
  return index
    .map((chunk) => ({ ...chunk, score: terms.reduce((sum, term) => sum + (chunk.terms.includes(term) ? 1 : 0), 0) }))
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => b.score - a.score);
}

// Convenience function for small unit tests; the MCP server uses a startup index.
export function searchBillingPolicy(policyText: string, query: string): Array<SearchChunk & { score: number }> {
  return searchIndexedBillingPolicy(indexBillingPolicy(policyText), query);
}
