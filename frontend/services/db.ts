import { MarketDataPoint } from '../types';

const API_BASE =
  (((import.meta as any).env || {}) as Record<string, unknown>).VITE_API_BASE as string || '';

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  try {
    return await res.json();
  } catch (e) {
    const text = await res.text();
    throw new Error(`Failed to parse JSON from ${path}: ${e}. Response body: ${text}`);
  }
}

export const dbService = {
  async addCoin(symbol: string) {
    return request('/api/coins', {
      method: 'POST',
      body: JSON.stringify({ symbol }),
    });
  },

  async removeCoin(symbol: string) {
    return request(`/api/coins/${encodeURIComponent(symbol)}`, {
      method: 'DELETE',
    });
  },

  async getCoins() {
    return request<{ symbol: string; added_at: string }[]>('/api/coins');
  },

  async addMarketData(symbol: string, data: MarketDataPoint) {
    return request('/api/market-data', {
      method: 'POST',
      body: JSON.stringify({
        symbol,
        timestamp: data.timestamp,
        openInterest: data.openInterest,
        fundingRate: data.fundingRate,
        price: data.price,
      }),
    });
  },

  async fetchAndStore(symbol: string) {
    return request<MarketDataPoint>('/api/market-data/fetch', {
      method: 'POST',
      body: JSON.stringify({ symbol }),
    });
  },

  /**
   * Fetch historical market data for a symbol.
   *
   * @param symbol  - Coin symbol
   * @param limit   - Max number of records to return (default 100)
   * @param before  - Optional Unix timestamp (ms). When provided, only returns
   *                  records with timestamp < before, enabling pagination for
   *                  pan-back lazy loading. Your API endpoint must support this
   *                  query param: GET /api/market-data?symbol=&limit=&before=
   */
  async getMarketData(symbol: string, limit = 100, before?: number) {
    let url = `/api/market-data?symbol=${encodeURIComponent(symbol)}&limit=${limit}`;
    if (before !== undefined) {
      url += `&before=${before}`;
    }
    return request<MarketDataPoint[]>(url);
  },
};