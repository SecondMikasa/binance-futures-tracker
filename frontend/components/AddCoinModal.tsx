import React, { useState } from 'react';
import { X, Search, Plus, Globe } from 'lucide-react';
import { POPULAR_COINS } from '../constants';

interface AddCoinModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (symbol: string) => void;
  trackedSymbols: string[];
}

export const AddCoinModal: React.FC<AddCoinModalProps> = ({ isOpen, onClose, onAdd, trackedSymbols }) => {
  const [search, setSearch] = useState('');

  if (!isOpen) return null;

  const normalizedSearch = search.toUpperCase().trim();

  const availableCoins = POPULAR_COINS.filter(
    coin => !trackedSymbols.includes(coin) && coin.includes(normalizedSearch)
  );

  const isExactMatch = availableCoins.includes(normalizedSearch);
  const isAlreadyTracked = trackedSymbols.includes(normalizedSearch);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="bg-slate-800 border border-slate-700 w-full max-w-md rounded-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between p-4 border-b border-slate-700 bg-slate-900/50">
          <h2 className="text-lg font-semibold text-white">Track New Coin</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors">
            <X size={20} />
          </button>
        </div>
        
        <div className="p-4">
          <div className="relative mb-4">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
            <input
              type="text"
              placeholder="Search or enter symbol (e.g. MOODENGUSDT)"
              className="w-full bg-slate-900 border border-slate-700 rounded-lg py-2 pl-10 pr-4 text-sm text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 uppercase placeholder:normal-case"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
            />
          </div>

          <div className="max-h-[300px] overflow-y-auto space-y-2 custom-scrollbar">
            {/* Custom Add Button */}
            {normalizedSearch.length > 0 && !isExactMatch && !isAlreadyTracked && (
               <button
                  onClick={() => {
                    onAdd(normalizedSearch);
                    onClose();
                    setSearch('');
                  }}
                  className="w-full flex items-center justify-between p-3 rounded-lg bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/50 transition-all group"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-blue-500/20 flex items-center justify-center text-blue-400">
                        <Globe size={16} />
                    </div>
                    <div className="text-left">
                        <span className="block font-bold text-blue-400 text-sm">Add "{normalizedSearch}"</span>
                        <span className="block text-xs text-blue-300/60">Custom Symbol</span>
                    </div>
                  </div>
                  <Plus size={18} className="text-blue-400" />
                </button>
            )}

            {/* Predefined List */}
            {availableCoins.map(coin => (
              <button
                key={coin}
                onClick={() => {
                  onAdd(coin);
                  onClose();
                  setSearch('');
                }}
                className="w-full flex items-center justify-between p-3 rounded-lg bg-slate-700/30 hover:bg-slate-700 transition-colors group"
              >
                <div className="flex items-center gap-3">
                     <div className="w-8 h-8 rounded-full bg-slate-600/50 flex items-center justify-center text-slate-400 font-bold text-[10px]">
                        {coin.substring(0, 3)}
                     </div>
                     <span className="font-medium text-slate-200">{coin}</span>
                </div>
                <Plus size={18} className="text-blue-400 opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>
            ))}

            {/* Empty State */}
            {normalizedSearch.length === 0 && availableCoins.length === 0 && (
              <div className="text-center py-8 text-slate-500 text-sm">
                Start typing to search or add a custom coin.
              </div>
            )}
            
            {/* Already Tracked Message */}
            {isAlreadyTracked && (
                <div className="text-center py-4 text-slate-500 text-sm italic">
                    {normalizedSearch} is already on your list.
                </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};