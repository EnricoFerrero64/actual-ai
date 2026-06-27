import { SearchEnrichmentServiceI, SearchResult } from '../types';
import SearxngService from './searxng-service';
import FirecrawlService from './firecrawl-service';

// If all snippets are shorter than this, try Firecrawl on the first URL
const SNIPPET_THRESHOLD = 60;

export default class SearchEnrichmentService implements SearchEnrichmentServiceI {
  private readonly searxng?: SearxngService;

  private readonly firecrawl?: FirecrawlService;

  constructor(searxng?: SearxngService, firecrawl?: FirecrawlService) {
    this.searxng = searxng;
    this.firecrawl = firecrawl;
  }

  public isAvailable(): boolean {
    return !!this.searxng;
  }

  public async enrich(merchantName: string): Promise<string> {
    if (!this.searxng) return '';

    const query = `${merchantName} merchant business type`;
    let results: SearchResult[] = [];

    try {
      console.log(`[SearchEnrichment] Searching for: "${merchantName}"`);
      results = await this.searxng.search(query);
    } catch (err) {
      console.warn(`[SearchEnrichment] SearXNG failed for "${merchantName}":`, err);
      return '';
    }

    if (!results.length) {
      return 'No search results found for this merchant.';
    }

    const avgSnippetLength = results.reduce((sum, r) => sum + r.snippet.length, 0) / results.length;
    if (this.firecrawl && avgSnippetLength < SNIPPET_THRESHOLD && results[0]?.link) {
      try {
        console.log(`[SearchEnrichment] Snippets short (avg ${avgSnippetLength}), trying Firecrawl on: ${results[0].link}`);
        const scraped = await this.firecrawl.scrape(results[0].link);
        if (scraped) {
          const rest = results.slice(1)
            .map((r, i) => `[${i + 2}] ${r.title}\n${r.snippet.substring(0, 200)}\nURL: ${r.link}`)
            .join('\n\n');
          return `WEB SEARCH RESULTS:\n[1] ${results[0].title}\n${scraped}\nURL: ${results[0].link}`
            + (rest ? `\n\n${rest}` : '');
        }
      } catch (err) {
        console.warn('[SearchEnrichment] Firecrawl scrape failed, using SearXNG snippets:', err);
      }
    }

    return this.searxng.formatResults(results);
  }
}
