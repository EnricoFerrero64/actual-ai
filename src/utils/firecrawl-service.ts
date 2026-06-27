export default class FirecrawlService {
  private readonly baseUrl: string;

  private readonly apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  public async scrape(url: string): Promise<string> {
    const endpoint = `${this.baseUrl}/v1/scrape`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url, formats: ['markdown'] }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new Error(`Firecrawl returned HTTP ${response.status}`);
    }

    const data = await response.json() as { data?: { markdown?: string } };
    const text = data.data?.markdown ?? '';
    // Cap at 800 chars to keep prompt compact
    return text.substring(0, 800);
  }
}
