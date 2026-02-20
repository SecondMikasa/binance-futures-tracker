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
    throw new Error(`Failed to parse JSON from ${path}: ${e}. Body: ${text}`);
  }
}

export const dbService = {
  /** Lightweight connectivity check — called once before any per-coin requests. */
  async healthCheck(): Promise<void> {
    await request<{ ok: boolean }>('/api/health');
  },

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

  async getMarketData(symbol: string, limit = 100, before?: number) {
    let url = `/api/market-data?symbol=${encodeURIComponent(symbol)}&limit=${limit}`;
    if (before !== undefined) url += `&before=${before}`;
    return request<MarketDataPoint[]>(url);
  },
  
  async getMarketDataRange(symbol: string, start: number, end: number) {
    const url = `/api/market-data/range?symbol=${encodeURIComponent(symbol)}&start=${start}&end=${end}`;
    return request<MarketDataPoint[]>(url);
  },
};