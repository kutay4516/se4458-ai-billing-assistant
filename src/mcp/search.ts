export interface SearchChunk {
  id: string;
  text: string;
  score: number;
}

export function searchBillingPolicy(policyText: string, query: string): SearchChunk[] {
  const terms = query.toLowerCase().split(/\W+/).filter((term) => term.length > 2);
  const chunks = policyText
    .split("\n## ")
    .map((chunk, index) => ({ id: `chunk-${index + 1}`, text: index === 0 ? chunk : `## ${chunk}` }));

  return chunks
    .map((chunk) => ({
      ...chunk,
      score: terms.reduce((sum, term) => sum + (chunk.text.toLowerCase().includes(term) ? 1 : 0), 0),
    }))
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => b.score - a.score);
}
