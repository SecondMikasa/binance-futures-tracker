import React, { useState, useEffect, useRef } from 'react';
import { LayoutDashboard, Plus, Activity, Trash2, Search, Database, ExternalLink } from 'lucide-react';
import { CoinDetail } from './components/CoinDetail';
import { AddCoinModal } from './components/AddCoinModal';
import { dbService } from './services/db';
import { MarketDataPoint } from './types';
import { REFRESH_INTERVAL_MS } from './constants';

const App: React.FC = () => {
  const [trackedCoins, setTrackedCoins] = useState<string[]>([]);
  const [selectedCoin, setSelectedCoin] = useState<string | null>(null);
  const [marketData, setMarketData] = useState<Record<string, MarketDataPoint[]>>({});
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  // Load coins from DB on startup
  useEffect(() => {
    const init = async () => {
      try {
        const storedCoins = await dbService.getCoins();
        const symbols = storedCoins.map(c => c.symbol);
        setTrackedCoins(symbols);
        
        // If coins exist, select the first one
        if (symbols.length > 0 && !selectedCoin) {
          setSelectedCoin(symbols[0]);
        }

        // Load initial history for all coins
        const history: Record<string, MarketDataPoint[]> = {};
        for (const sym of symbols) {
          const data = await dbService.getMarketData(sym);
          history[sym] = data;
        }
        setMarketData(history);
      } catch (err) {
        console.error("Failed to initialize DB:", err);
      }
    };
    init();
  }, []);

  // Background Fetch Loop
  useEffect(() => {
    // Function to run a fetch cycle for all tracked coins
    const runFetchCycle = async () => {
      if (trackedCoins.length === 0) return;

      console.log(`Starting background fetch for ${trackedCoins.length} coins...`);
      
      // Fetch sequentially to avoid overwhelming the proxy
      for (const symbol of trackedCoins) {
        try {
          const point = await dbService.fetchAndStore(symbol);
          if (point) {
            // update local state with whatever the server returned
            setMarketData(prev => {
              const currentHistory = prev[symbol] || [];
              const newHistory = [...currentHistory, point].sort((a,b) => a.timestamp - b.timestamp).slice(-100);
              return {
                ...prev,
                [symbol]: newHistory
              };
            });
          }
        } catch (e) {
          console.error(`Error fetching background data for ${symbol}`, e);
        }
        
        // Small delay between requests
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    };

    // Run immediately once
    if (trackedCoins.length > 0) {
      runFetchCycle();
    }

    // Set interval
    const intervalId = setInterval(runFetchCycle, REFRESH_INTERVAL_MS);

    return () => clearInterval(intervalId);
  }, [trackedCoins]); // Re-create interval if coin list changes

  const addCoin = async (symbol: string) => {
    if (!trackedCoins.includes(symbol)) {
      await dbService.addCoin(symbol);
      setTrackedCoins([...trackedCoins, symbol]);
      if (!selectedCoin) setSelectedCoin(symbol);
      // Fetch initial data immediately through the server helper
      const point = await dbService.fetchAndStore(symbol);
      if (point) {
        setMarketData(prev => ({ ...prev, [symbol]: [point] }));
      }
    }
  };

  const removeCoin = async (symbol: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await dbService.removeCoin(symbol);
    const newCoins = trackedCoins.filter(c => c !== symbol);
    setTrackedCoins(newCoins);
    
    // Cleanup state
    const newData = { ...marketData };
    delete newData[symbol];
    setMarketData(newData);

    // Update selection if we removed the selected coin
    if (selectedCoin === symbol) {
      setSelectedCoin(newCoins.length > 0 ? newCoins[0] : null);
    }
  };

  return (
    <div className="flex h-screen bg-slate-950 text-slate-200 overflow-hidden font-sans">
      
      {/* Sidebar - Added overflow-hidden to fix blurred content issue when width is 0 */}
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
                  <span className={`text-xs ${marketData[symbol].slice(-1)[0].fundingRate > 0 ? 'text-green-500' : 'text-red-500'}`}>
                    FR: {(marketData[symbol].slice(-1)[0].fundingRate * 100).toFixed(4)}%
                  </span>
                )}
              </div>
              <button
                onClick={(e) => removeCoin(symbol, e)}
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
        {/* Top Header */}
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
                {selectedCoin ? selectedCoin : 'Dashboard'}
              </h2>
              {selectedCoin && (
                <a 
                  href={`https://www.binance.com/en/futures/${selectedCoin}`} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 px-3 py-1 bg-[#1E2026] hover:bg-[#2B2F36] text-[#FCD535] hover:text-[#FCD535] rounded-full border border-slate-700/50 transition-all text-xs font-medium group"
                  title="View on Binance Futures"
                >
                  <span>Open Chart</span>
                  <ExternalLink size={12} className="opacity-70 group-hover:translate-x-0.5 transition-transform" />
                </a>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3">
             <div className="px-3 py-1 bg-slate-800 rounded-full border border-slate-700 text-xs text-slate-400 flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
                Live Sync
             </div>
          </div>
        </header>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto p-6 bg-slate-950">
          {selectedCoin ? (
            marketData[selectedCoin] && marketData[selectedCoin].length > 0 ? (
              <CoinDetail 
                symbol={selectedCoin} 
                data={marketData[selectedCoin]} 
              />
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-slate-500 space-y-4">
                <div className="animate-spin text-blue-500">
                  <Activity size={32} />
                </div>
                <p>Fetching initial data for {selectedCoin}...</p>
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

      {/* Modals */}
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