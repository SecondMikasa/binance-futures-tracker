import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  LayoutDashboard, Plus, Activity, Trash2,
  Search, Database, ExternalLink, WifiOff, Wifi,
} from 'lucide-react';
import { CoinDetail } from './components/CoinDetail';
import { AddCoinModal } from './components/AddCoinModal';
import { dbService } from './services/db';
import { MarketDataPoint } from './types';
import { REFRESH_INTERVAL_MS } from './constants';

// How many recent points to keep in memory per coin (1 point/min × 60 min × 2 = 2 hrs buffer)
const MAX_POINTS_IN_MEMORY = 120;

// Backoff config for when the backend is unreachable
const BACKOFF_STEPS_MS = [5_000, 15_000, 30_000, 60_000]; // caps at 60 s

const App: React.FC = () => {
  const [trackedCoins, setTrackedCoins] = useState<string[]>([]);
  const [selectedCoin, setSelectedCoin] = useState<string | null>(null);
  const [marketData, setMarketData] = useState<Record<string, MarketDataPoint[]>>({});
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  // Connection state
  const [isConnected, setIsConnected] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const intervalRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backoffIndexRef = useRef(0);
  const trackedCoinsRef = useRef<string[]>([]);

  // Keep ref in sync so the poll loop always sees current coins without re-creating the interval
  useEffect(() => {
    trackedCoinsRef.current = trackedCoins;
  }, [trackedCoins]);

  // ── Initialise: load coins + recent history from the backend ───────────────
  useEffect(() => {
    const init = async () => {
      try {
        const storedCoins = await dbService.getCoins();
        const symbols = storedCoins.map(c => c.symbol);
        setTrackedCoins(symbols);
        if (symbols.length > 0) setSelectedCoin(symbols[0]);

        const history: Record<string, MarketDataPoint[]> = {};
        await Promise.all(
          symbols.map(async sym => {
            try {
              history[sym] = await dbService.getMarketData(sym, MAX_POINTS_IN_MEMORY);
            } catch {
              history[sym] = [];
            }
          })
        );
        setMarketData(history);
        setIsConnected(true);
      } catch (err) {
        console.error('Failed to initialise:', err);
        setIsConnected(false);
      }
    };
    init();
  }, []);

  // ── Poll loop: frontend only READS the latest point for each coin ──────────
  //
  //  The backend's own setInterval already hits Binance every 60 s and stores
  //  the result. We just ask "what's the newest row for this coin?" and merge
  //  it into local state. No fetchAndStore, no Binance calls from the browser.
  //
  const poll = useCallback(async () => {
    const coins = trackedCoinsRef.current;
    if (coins.length === 0) return;

    try {
      // Fetch only the single most-recent point per coin (limit=1)
      const updates = await Promise.all(
        coins.map(async sym => {
          const points = await dbService.getMarketData(sym, 1);
          return { sym, point: points[0] ?? null };
        })
      );

      setMarketData(prev => {
        const next = { ...prev };
        for (const { sym, point } of updates) {
          if (!point) continue;
          const existing = next[sym] ?? [];
          // Only append if this timestamp is actually new
          const alreadyHave = existing.some(p => p.timestamp === point.timestamp);
          if (!alreadyHave) {
            next[sym] = [...existing, point]
              .sort((a, b) => a.timestamp - b.timestamp)
              .slice(-MAX_POINTS_IN_MEMORY);
          }
        }
        return next;
      });

      setIsConnected(true);
      setLastUpdated(new Date());
      backoffIndexRef.current = 0; // reset backoff on success

      // Schedule next poll at normal interval
      intervalRef.current = setTimeout(poll, REFRESH_INTERVAL_MS);
    } catch (err) {
      console.error('Poll failed:', err);
      setIsConnected(false);

      // Exponential backoff — don't hammer a down server
      const delay = BACKOFF_STEPS_MS[
        Math.min(backoffIndexRef.current, BACKOFF_STEPS_MS.length - 1)
      ];
      backoffIndexRef.current = Math.min(
        backoffIndexRef.current + 1,
        BACKOFF_STEPS_MS.length - 1
      );
      console.warn(`Retrying in ${delay / 1000}s…`);
      intervalRef.current = setTimeout(poll, delay);
    }
  }, []);

  // Start polling once on mount
  useEffect(() => {
    intervalRef.current = setTimeout(poll, REFRESH_INTERVAL_MS);
    return () => {
      if (intervalRef.current) clearTimeout(intervalRef.current);
    };
  }, [poll]);

  // ── Add / remove coins ────────────────────────────────────────────────────
  const addCoin = async (symbol: string) => {
    if (trackedCoins.includes(symbol)) return;
    await dbService.addCoin(symbol);
    setTrackedCoins(prev => [...prev, symbol]);
    if (!selectedCoin) setSelectedCoin(symbol);

    // Fetch whatever history the backend already has for this coin
    try {
      const history = await dbService.getMarketData(symbol, MAX_POINTS_IN_MEMORY);
      setMarketData(prev => ({ ...prev, [symbol]: history }));
    } catch {
      setMarketData(prev => ({ ...prev, [symbol]: [] }));
    }
  };

  const removeCoin = async (symbol: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await dbService.removeCoin(symbol);
    const next = trackedCoins.filter(c => c !== symbol);
    setTrackedCoins(next);
    setMarketData(prev => {
      const n = { ...prev };
      delete n[symbol];
      return n;
    });
    if (selectedCoin === symbol) setSelectedCoin(next[0] ?? null);
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-screen bg-slate-950 text-slate-200 overflow-hidden font-sans">

      {/* Sidebar */}
      <aside className={`${isSidebarOpen ? 'w-64' : 'w-0'} flex-shrink-0 bg-slate-900 border-r border-slate-800 transition-all duration-300 flex flex-col overflow-hidden`}>
        <div className="p-4 border-b border-slate-800 flex items-center gap-2 whitespace-nowrap">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center text-white shadow-lg shadow-blue-500/20 flex-shrink-0">
            <Activity size={18} strokeWidth={2.5} />
          </div>
          <span className="font-bold text-lg tracking-tight">Binance Tracker</span>
        </div>

        <div className="p-4">
          <button
            onClick={() => setIsModalOpen(true)}
            className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 text-white px-4 py-2.5 rounded-lg text-sm font-medium transition-all shadow-md hover:shadow-blue-500/20 active:scale-95 whitespace-nowrap"
          >
            <Plus size={16} />
            Track New Coin
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-2 space-y-1">
          {trackedCoins.length === 0 && (
            <div className="text-center py-8 px-4 text-slate-500 text-sm whitespace-nowrap">
              <Database className="w-8 h-8 mx-auto mb-2 opacity-30" />
              No coins added yet.
            </div>
          )}
          {trackedCoins.map(symbol => (
            <div
              key={symbol}
              onClick={() => setSelectedCoin(symbol)}
              className={`group flex items-center justify-between p-3 rounded-lg cursor-pointer transition-colors whitespace-nowrap ${
                selectedCoin === symbol
                  ? 'bg-slate-800 text-white border border-slate-700'
                  : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-200'
              }`}
            >
              <div className="flex flex-col overflow-hidden">
                <span className="font-medium text-sm truncate">{symbol}</span>
                {marketData[symbol]?.length > 0 && (
                  <span className={`text-xs ${
                    marketData[symbol].at(-1)!.fundingRate > 0 ? 'text-green-500' : 'text-red-500'
                  }`}>
                    FR: {(marketData[symbol].at(-1)!.fundingRate * 100).toFixed(4)}%
                  </span>
                )}
              </div>
              <button
                onClick={e => removeCoin(symbol, e)}
                className="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-red-500/20 hover:text-red-400 rounded-md transition-all flex-shrink-0"
                title="Remove coin"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col h-full overflow-hidden relative">

        {/* Header */}
        <header className="h-16 border-b border-slate-800 bg-slate-900/50 backdrop-blur-sm flex items-center justify-between px-6 flex-shrink-0 z-10">
          <div className="flex items-center gap-4">
            <button
              onClick={() => setIsSidebarOpen(!isSidebarOpen)}
              className="p-2 hover:bg-slate-800 rounded-lg text-slate-400 transition-colors"
            >
              <LayoutDashboard size={20} />
            </button>
            <div className="flex items-center gap-3">
              <h2 className="text-xl font-semibold text-white">
                {selectedCoin ?? 'Dashboard'}
              </h2>
              {selectedCoin && (
                <a
                  href={`https://www.binance.com/en/futures/${selectedCoin}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 px-3 py-1 bg-[#1E2026] hover:bg-[#2B2F36] text-[#FCD535] rounded-full border border-slate-700/50 transition-all text-xs font-medium group"
                >
                  <span>Open Chart</span>
                  <ExternalLink size={12} className="opacity-70 group-hover:translate-x-0.5 transition-transform" />
                </a>
              )}
            </div>
          </div>

          {/* Connection status pill */}
          <div className="flex items-center gap-3">
            {isConnected ? (
              <div className="px-3 py-1 bg-slate-800 rounded-full border border-slate-700 text-xs text-slate-400 flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                {lastUpdated
                  ? `Updated ${lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}`
                  : 'Live Sync'}
              </div>
            ) : (
              <div className="px-3 py-1 bg-red-950/60 rounded-full border border-red-800/50 text-xs text-red-400 flex items-center gap-2">
                <WifiOff size={12} />
                Backend unreachable — retrying…
              </div>
            )}
          </div>
        </header>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 bg-slate-950">
          {selectedCoin ? (
            marketData[selectedCoin]?.length > 0 ? (
              <CoinDetail symbol={selectedCoin} data={marketData[selectedCoin]} />
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-slate-500 space-y-4">
                {isConnected ? (
                  <>
                    <div className="animate-spin text-blue-500">
                      <Activity size={32} />
                    </div>
                    <p>Waiting for first data point for {selectedCoin}…</p>
                    <p className="text-xs text-slate-600">Backend fetches every 60 s</p>
                  </>
                ) : (
                  <>
                    <WifiOff size={32} className="text-red-500 opacity-50" />
                    <p>Cannot reach the backend server.</p>
                    <p className="text-xs text-slate-600">Make sure the server is running on port 4000.</p>
                  </>
                )}
              </div>
            )
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-slate-500 space-y-4 opacity-50">
              <Search size={48} strokeWidth={1} />
              <p className="text-lg">Select a coin from the sidebar to view details</p>
            </div>
          )}
        </div>
      </main>

      <AddCoinModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onAdd={addCoin}
        trackedSymbols={trackedCoins}
      />
    </div>
  );
};

export default App;