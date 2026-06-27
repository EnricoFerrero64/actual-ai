import { SearchEnrichmentServiceI, SearchResult } from '../types';
import SearxngService from './searxng-service';
import FirecrawlService from './firecrawl-service';

interface EnrichedResult extends SearchResult {
  pageContent?: string;
}

export default class SearchEnrichmentService implements SearchEnrichmentServiceI {
  private readonly searxng?: SearxngService;

  private readonly firecrawl?: FirecrawlService;

  // How many of the top search results to actually scrape with Firecrawl
  private readonly maxScrapePages: number;

  constructor(searxng?: SearxngService, firecrawl?: FirecrawlService, maxScrapePages = 1) {
    this.searxng = searxng;
    this.firecrawl = firecrawl;
    this.maxScrapePages = Math.max(1, maxScrapePages);
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

    // SearXNG is the finder (URLs + thin meta snippets); Firecrawl is the reader
    // (actual page content). They are complementary: when Firecrawl is configured
    // we scrape the top result(s) to read what the page really says, and keep the
    // remaining SearXNG snippets as extra context.
    if (this.firecrawl) {
      const enriched = await this.scrapeTopResults(results);
      const hasPageContent = enriched.some((r) => r.pageContent);
      if (hasPageContent) {
        return SearchEnrichmentService.format(enriched);
      }
      // All scrapes failed → fall through to snippet-only output
    }

    return this.searxng.formatResults(results);
  }

  private async scrapeTopResults(results: SearchResult[]): Promise<EnrichedResult[]> {
    const toScrape = Math.min(this.maxScrapePages, results.length);
    return Promise.all(
      results.map(async (result, index): Promise<EnrichedResult> => {
        if (index >= toScrape || !result.link || !this.firecrawl) {
          return result;
        }
        try {
          console.log(`[SearchEnrichment] Firecrawl reading: ${result.link}`);
          const pageContent = await this.firecrawl.scrape(result.link);
          return { ...result, pageContent: pageContent || undefined };
        } catch (err) {
          console.warn(`[SearchEnrichment] Firecrawl scrape failed for ${result.link}:`, err);
          return result;
        }
      }),
    );
  }

  private static format(results: EnrichedResult[]): string {
    const blocks = results.map((r, i) => {
      const body = r.pageContent
        ? r.pageContent
        : r.snippet.substring(0, 250);
      return `[${i + 1}] ${r.title}\n${body}\nURL: ${r.link}`;
    });
    return `WEB SEARCH RESULTS:\n${blocks.join('\n\n')}`;
  }
}
