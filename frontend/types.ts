export interface MarketDataPoint {
  timestamp: number;
  openInterest: number;
  fundingRate: number;
  price: number;
}

export interface CoinConfig {
  symbol: string; // e.g., 'BTCUSDT'
  isActive: boolean;
}

export interface BinanceTickerPrice {
  symbol: string;
  price: string;
  time: number;
}

export interface BinanceOpenInterest {
  symbol: string;
  openInterest: string;
  time: number;
}

export interface BinancePremiumIndex {
  symbol: string;
  lastFundingRate: string;
  time: number;
}

export enum TimeFrame {
  ONE_MINUTE = '1m',
}

export interface AIAnalysisResult {
  sentiment: 'bullish' | 'bearish' | 'neutral';
  summary: string;
  riskLevel: 'low' | 'medium' | 'high';
}
