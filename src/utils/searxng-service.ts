import { SearchResult } from '../types';

export default class SearxngService {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  public async search(query: string): Promise<SearchResult[]> {
    const url = `${this.baseUrl}/search?q=${encodeURIComponent(query)}&format=json&language=fr-FR&categories=general`;

    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`SearXNG returned HTTP ${response.status}`);
    }

    const data = await response.json() as {
      results?: Array<{ title?: string; content?: string; url?: string }>;
    };

    return (data.results ?? []).slice(0, 5).map((r) => ({
      title: r.title ?? '',
      snippet: r.content ?? '',
      link: r.url ?? '',
    }));
  }

  public formatResults(results: SearchResult[]): string {
    if (!results.length) return 'No search results found for this merchant.';
    return 'WEB SEARCH RESULTS:\n'
      + results
        .map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet.substring(0, 250)}\nURL: ${r.link}`)
        .join('\n\n');
  }
}
