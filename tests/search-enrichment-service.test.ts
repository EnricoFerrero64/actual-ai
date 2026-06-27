import SearchEnrichmentService from '../src/utils/search-enrichment-service';
import SearxngService from '../src/utils/searxng-service';
import FirecrawlService from '../src/utils/firecrawl-service';
import { SearchResult } from '../src/types';

function makeResults(snippetLen: number, link = 'https://example.com'): SearchResult[] {
  return [
    { title: 'Example Merchant', snippet: 'x'.repeat(snippetLen), link },
    { title: 'Second', snippet: 'y'.repeat(snippetLen), link: 'https://second.com' },
  ];
}

describe('SearchEnrichmentService', () => {
  it('reports unavailable and returns empty when no SearXNG is configured', async () => {
    const svc = new SearchEnrichmentService(undefined, undefined);
    expect(svc.isAvailable()).toBe(false);
    expect(await svc.enrich('Whatever')).toBe('');
  });

  it('returns formatted SearXNG results when snippets are rich enough', async () => {
    const searxng = new SearxngService('http://searxng');
    const searchSpy = jest.spyOn(searxng, 'search').mockResolvedValue(makeResults(200));
    const svc = new SearchEnrichmentService(searxng, undefined);

    const out = await svc.enrich('Leroy Merlin');

    expect(svc.isAvailable()).toBe(true);
    expect(searchSpy).toHaveBeenCalledWith('Leroy Merlin merchant business type');
    expect(out).toContain('WEB SEARCH RESULTS');
    expect(out).toContain('Example Merchant');
  });

  it('returns a no-results message when SearXNG yields nothing', async () => {
    const searxng = new SearxngService('http://searxng');
    jest.spyOn(searxng, 'search').mockResolvedValue([]);
    const svc = new SearchEnrichmentService(searxng, undefined);

    expect(await svc.enrich('Unknown')).toBe('No search results found for this merchant.');
  });

  it('swallows SearXNG errors and returns empty (never throws)', async () => {
    const searxng = new SearxngService('http://searxng');
    jest.spyOn(searxng, 'search').mockRejectedValue(new Error('network down'));
    const svc = new SearchEnrichmentService(searxng, undefined);

    expect(await svc.enrich('Boom')).toBe('');
  });

  it('falls back to Firecrawl when snippets are too thin', async () => {
    const searxng = new SearxngService('http://searxng');
    jest.spyOn(searxng, 'search').mockResolvedValue(makeResults(10));
    const firecrawl = new FirecrawlService('http://firecrawl', '');
    const scrapeSpy = jest.spyOn(firecrawl, 'scrape').mockResolvedValue('Detailed scraped page about the merchant');
    const svc = new SearchEnrichmentService(searxng, firecrawl);

    const out = await svc.enrich('Cryptic Shop');

    expect(scrapeSpy).toHaveBeenCalledWith('https://example.com');
    expect(out).toContain('Detailed scraped page about the merchant');
  });

  it('uses SearXNG snippets if Firecrawl scraping fails', async () => {
    const searxng = new SearxngService('http://searxng');
    jest.spyOn(searxng, 'search').mockResolvedValue(makeResults(10));
    const firecrawl = new FirecrawlService('http://firecrawl', '');
    jest.spyOn(firecrawl, 'scrape').mockRejectedValue(new Error('scrape failed'));
    const svc = new SearchEnrichmentService(searxng, firecrawl);

    const out = await svc.enrich('Cryptic Shop');

    expect(out).toContain('WEB SEARCH RESULTS');
  });
});
