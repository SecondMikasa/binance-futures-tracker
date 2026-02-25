import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  LayoutDashboard, Plus, Activity, Trash2, Search, Database,
  ExternalLink, WifiOff, X, Settings, FolderPlus, Edit2, GripVertical,
} from 'lucide-react';
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors,
  DragEndEvent, DragOverlay, DragStartEvent,
} from '@dnd-kit/core';
import {
  arrayMove, SortableContext, sortableKeyboardCoordinates,
  verticalListSortingStrategy, useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { CoinDetail } from './components/CoinDetail';
import { AddCoinModal } from './components/AddCoinModal';
import { dbService } from './services/db';
import { MarketDataPoint } from './types';
import { REFRESH_INTERVAL_MS } from './constants';

const MAX_POINTS_IN_MEMORY = 120;
const BACKOFF_STEPS_MS = [5_000, 15_000, 30_000, 60_000];

type SortOption = 'alpha' | 'fr-high' | 'fr-low' | 'recent' | 'manual';

interface CoinGroup {
  id: string;
  name: string;
  color: string;
  coinSymbols: string[];
  order: number;
}

const DEFAULT_COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#14b8a6', '#f97316', '#06b6d4', '#84cc16',
];

const STORAGE_KEY = 'binance-tracker-groups';
const DEFAULT_GROUP_ID = '__default__';

const App: React.FC = () => {
  const [trackedCoins, setTrackedCoins] = useState<string[]>([]);
  const [selectedCoin, setSelectedCoin] = useState<string | null>(null);
  const [marketData, setMarketData] = useState<Record<string, MarketDataPoint[]>>({});
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isConnected, setIsConnected] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  // Search & sort
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortOption>('manual');

  // Groups
  const [groups, setGroups] = useState<CoinGroup[]>([]);
  const [isGroupModalOpen, setIsGroupModalOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<CoinGroup | null>(null);

  // Drag state
  const [activeId, setActiveId] = useState<string | null>(null);

  const intervalRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backoffIndexRef = useRef(0);
  const trackedCoinsRef = useRef<string[]>([]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  useEffect(() => {
    trackedCoinsRef.current = trackedCoins;
  }, [trackedCoins]);

  // Load groups from localStorage
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        setGroups(parsed);
      } catch {
        console.error('Failed to parse stored groups');
      }
    }
  }, []);

  // Save groups to localStorage
  useEffect(() => {
    if (groups.length > 0) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(groups));
    }
  }, [groups]);

  // Initialize default group when coins are first loaded
  useEffect(() => {
    if (trackedCoins.length > 0 && groups.length === 0) {
      const defaultGroup: CoinGroup = {
        id: DEFAULT_GROUP_ID,
        name: 'All Coins',
        color: DEFAULT_COLORS[0],
        coinSymbols: [...trackedCoins],
        order: 0,
      };
      setGroups([defaultGroup]);
    }
  }, [trackedCoins, groups.length]);

  // Ensure all coins are in at least one group
  useEffect(() => {
    if (trackedCoins.length === 0 || groups.length === 0) return;

    const allGroupedCoins = new Set<string>();
    groups.forEach(g => g.coinSymbols.forEach(s => allGroupedCoins.add(s)));

    const ungroupedCoins = trackedCoins.filter(c => !allGroupedCoins.has(c));
    if (ungroupedCoins.length > 0) {
      const defaultGroup = groups.find(g => g.id === DEFAULT_GROUP_ID);
      if (defaultGroup) {
        setGroups(prev => prev.map(g =>
          g.id === DEFAULT_GROUP_ID
            ? { ...g, coinSymbols: [...g.coinSymbols, ...ungroupedCoins] }
            : g
        ));
      }
    }
  }, [trackedCoins, groups]);

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

  const poll = useCallback(async () => {
    const coins = trackedCoinsRef.current;
    try {
      await dbService.healthCheck();
      if (coins.length === 0) {
        intervalRef.current = setTimeout(poll, REFRESH_INTERVAL_MS);
        return;
      }
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
      backoffIndexRef.current = 0;
      intervalRef.current = setTimeout(poll, REFRESH_INTERVAL_MS);
    } catch {
      const delay = BACKOFF_STEPS_MS[Math.min(backoffIndexRef.current, BACKOFF_STEPS_MS.length - 1)];
      backoffIndexRef.current = Math.min(backoffIndexRef.current + 1, BACKOFF_STEPS_MS.length - 1);
      console.warn(`[poll] Backend unreachable — retrying in ${delay / 1000}s`);
      setIsConnected(false);
      intervalRef.current = setTimeout(poll, delay);
    }
  }, []);

  useEffect(() => {
    intervalRef.current = setTimeout(poll, REFRESH_INTERVAL_MS);
    return () => { if (intervalRef.current) clearTimeout(intervalRef.current); };
  }, [poll]);

  const addCoin = async (symbol: string) => {
    if (trackedCoins.includes(symbol)) return;
    await dbService.addCoin(symbol);
    setTrackedCoins(prev => [...prev, symbol]);
    if (!selectedCoin) setSelectedCoin(symbol);

    // Add to default group
    setGroups(prev => prev.map(g =>
      g.id === DEFAULT_GROUP_ID
        ? { ...g, coinSymbols: [...g.coinSymbols, symbol] }
        : g
    ));

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
    setMarketData(prev => { const n = { ...prev }; delete n[symbol]; return n; });
    if (selectedCoin === symbol) setSelectedCoin(next[0] ?? null);

    // Remove from all groups
    setGroups(prev => prev.map(g => ({
      ...g,
      coinSymbols: g.coinSymbols.filter(c => c !== symbol),
    })));
  };

  // Group management
  const createGroup = (name: string, color: string) => {
    const newGroup: CoinGroup = {
      id: `group_${Date.now()}`,
      name,
      color,
      coinSymbols: [],
      order: groups.length,
    };
    setGroups(prev => [...prev, newGroup]);
  };

  const updateGroup = (groupId: string, updates: Partial<CoinGroup>) => {
    setGroups(prev => prev.map(g => g.id === groupId ? { ...g, ...updates } : g));
  };

  const deleteGroup = (groupId: string) => {
    if (groupId === DEFAULT_GROUP_ID) return; // Can't delete default
    setGroups(prev => prev.filter(g => g.id !== groupId));
  };

  // Drag handlers
  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);

    if (!over) return;

    const activeId = active.id as string;
    const overId = over.id as string;

    // Check if dragging between groups
    if (overId.startsWith('group_') || overId === DEFAULT_GROUP_ID) {
      const coinSymbol = activeId;
      const targetGroupId = overId;

      setGroups(prev => prev.map(g => {
        if (g.id === targetGroupId && !g.coinSymbols.includes(coinSymbol)) {
          return { ...g, coinSymbols: [...g.coinSymbols, coinSymbol] };
        }
        return g;
      }));
      return;
    }

    // Reordering within a group
    const sourceGroup = groups.find(g => g.coinSymbols.includes(activeId));
    if (!sourceGroup) return;

    const oldIndex = sourceGroup.coinSymbols.indexOf(activeId);
    const newIndex = sourceGroup.coinSymbols.indexOf(overId);

    if (oldIndex !== newIndex) {
      setGroups(prev => prev.map(g =>
        g.id === sourceGroup.id
          ? { ...g, coinSymbols: arrayMove(g.coinSymbols, oldIndex, newIndex) }
          : g
      ));
    }
  };

  // Sort coins within each group
  const sortCoinsInGroup = (coins: string[]) => {
    if (sortBy === 'manual') return coins;

    return [...coins].sort((a, b) => {
      switch (sortBy) {
        case 'alpha':
          return a.localeCompare(b);
        case 'fr-high': {
          const frA = marketData[a]?.at(-1)?.fundingRate ?? 0;
          const frB = marketData[b]?.at(-1)?.fundingRate ?? 0;
          return frB - frA;
        }
        case 'fr-low': {
          const frA = marketData[a]?.at(-1)?.fundingRate ?? 0;
          const frB = marketData[b]?.at(-1)?.fundingRate ?? 0;
          return frA - frB;
        }
        case 'recent':
        default:
          return 0;
      }
    });
  };

  // Filter and prepare groups for display
  const displayGroups = useMemo(() => {
    return groups
      .map(group => {
        let coins = group.coinSymbols.filter(sym => trackedCoins.includes(sym));

        if (searchQuery.trim()) {
          const query = searchQuery.toLowerCase();
          coins = coins.filter(sym => sym.toLowerCase().includes(query));
        }

        coins = sortCoinsInGroup(coins);

        return { ...group, coinSymbols: coins };
      })
      .filter(g => g.coinSymbols.length > 0)
      .sort((a, b) => a.order - b.order);
  }, [groups, trackedCoins, searchQuery, sortBy, marketData]);

  // Draggable coin component
  interface DraggableCoinProps {
    symbol: string;
    groupId: string;
  }
  
  const DraggableCoin: React.FC<DraggableCoinProps> = ({ symbol, groupId }) => {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
      id: symbol,
      data: { groupId },
    });

    const style = {
      transform: CSS.Transform.toString(transform),
      transition,
      opacity: isDragging ? 0.5 : 1,
    };

    return (
      <div
        ref={setNodeRef}
        style={style}
        onClick={() => setSelectedCoin(symbol)}
        className={`group flex items-center justify-between p-3 rounded-lg cursor-pointer transition-colors ${
          selectedCoin === symbol
            ? 'bg-slate-800 text-white border border-slate-700'
            : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-200'
        }`}
      >
        <div className="flex items-center gap-2 flex-1 overflow-hidden">
          <div {...attributes} {...listeners} className="cursor-grab active:cursor-grabbing text-slate-600 hover:text-slate-400">
            <GripVertical size={14} />
          </div>
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
        </div>
        <button
          onClick={e => removeCoin(symbol, e)}
          className="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-red-500/20 hover:text-red-400 rounded-md transition-all flex-shrink-0"
        >
          <Trash2 size={14} />
        </button>
      </div>
    );
  };

  // Droppable group component
  interface DroppableGroupProps {
    group: CoinGroup;
  }
  
  const DroppableGroup: React.FC<DroppableGroupProps> = ({ group }) => {
    const { setNodeRef } = useSortable({ id: group.id });

    return (
      <div ref={setNodeRef} className="mb-4">
        <div className="flex items-center justify-between px-3 py-2 mb-1">
          <div className="flex items-center gap-2">
            <div
              className="w-3 h-3 rounded-full"
              style={{ backgroundColor: group.color }}
            />
            <span className="text-xs font-medium text-slate-400">
              {group.name} ({group.coinSymbols.length})
            </span>
          </div>
          {group.id !== DEFAULT_GROUP_ID && (
            <button
              onClick={() => {
                setEditingGroup(group);
                setIsGroupModalOpen(true);
              }}
              className="text-slate-600 hover:text-slate-400 transition-colors"
            >
              <Edit2 size={12} />
            </button>
          )}
        </div>
        <SortableContext items={group.coinSymbols} strategy={verticalListSortingStrategy}>
          <div className="space-y-1">
            {group.coinSymbols.map(symbol => (
              <DraggableCoin key={symbol} symbol={symbol} groupId={group.id} />
            ))}
          </div>
        </SortableContext>
      </div>
    );
  };

  return (
    <div className="flex h-screen bg-slate-950 text-slate-200 overflow-hidden font-sans">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <aside className={`${isSidebarOpen ? 'w-64' : 'w-0'} flex-shrink-0 bg-slate-900 border-r border-slate-800 transition-all duration-300 flex flex-col overflow-hidden`}>
          <div className="p-4 border-b border-slate-800 flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center text-white shadow-lg shadow-blue-500/20 flex-shrink-0">
              <Activity size={18} strokeWidth={2.5} />
            </div>
            <span className="font-bold text-lg tracking-tight">Binance Tracker</span>
          </div>

          <div className="p-4 space-y-2">
            <button
              onClick={() => setIsModalOpen(true)}
              className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 text-white px-4 py-2.5 rounded-lg text-sm font-medium transition-all"
            >
              <Plus size={16} /> Track New Coin
            </button>
            <button
              onClick={() => {
                setEditingGroup(null);
                setIsGroupModalOpen(true);
              }}
              className="w-full flex items-center justify-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 px-4 py-2 rounded-lg text-sm font-medium transition-all"
            >
              <FolderPlus size={16} /> New Group
            </button>
          </div>

          {trackedCoins.length > 0 && (
            <div className="px-4 pb-3 space-y-2 border-b border-slate-800">
              <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                <input
                  type="text"
                  placeholder="Search coins..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-9 pr-8 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-600"
                />
                {searchQuery && (
                  <button onClick={() => setSearchQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300">
                    <X size={14} />
                  </button>
                )}
              </div>
              <select
                value={sortBy}
                onChange={e => setSortBy(e.target.value as SortOption)}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-blue-600"
              >
                <option value="manual">Manual Order</option>
                <option value="recent">Recent</option>
                <option value="alpha">A → Z</option>
                <option value="fr-high">FR High → Low</option>
                <option value="fr-low">FR Low → High</option>
              </select>
            </div>
          )}

          <div className="flex-1 overflow-y-auto px-2 py-2">
            {trackedCoins.length === 0 ? (
              <div className="text-center py-8 px-4 text-slate-500 text-sm">
                <Database className="w-8 h-8 mx-auto mb-2 opacity-30" />
                No coins added yet.
              </div>
            ) : displayGroups.length === 0 ? (
              <div className="text-center py-8 text-slate-500 text-sm">
                No coins match your search
              </div>
            ) : (
              displayGroups.map(group => <DroppableGroup key={group.id} group={group} />)
            )}
          </div>
        </aside>

        <DragOverlay>
          {activeId ? (
            <div className="bg-slate-800 border border-slate-700 rounded-lg p-3 shadow-xl">
              <span className="font-medium text-sm text-white">{activeId}</span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      <main className="flex-1 flex flex-col h-full overflow-hidden relative">
        <header className="h-16 border-b border-slate-800 bg-slate-900/50 backdrop-blur-sm flex items-center justify-between px-6 flex-shrink-0 z-10">
          <div className="flex items-center gap-4">
            <button onClick={() => setIsSidebarOpen(!isSidebarOpen)} className="p-2 hover:bg-slate-800 rounded-lg text-slate-400 transition-colors">
              <LayoutDashboard size={20} />
            </button>
            <div className="flex items-center gap-3">
              <h2 className="text-xl font-semibold text-white">{selectedCoin ?? 'Dashboard'}</h2>
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
          <div>
            {isConnected ? (
              <div className="px-3 py-1 bg-slate-800 rounded-full border border-slate-700 text-xs text-slate-400 flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                {lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}` : 'Live Sync'}
              </div>
            ) : (
              <div className="px-3 py-1 bg-red-950/60 rounded-full border border-red-800/50 text-xs text-red-400 flex items-center gap-2">
                <WifiOff size={12} /> Backend unreachable — retrying…
              </div>
            )}
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-6 bg-slate-950">
          {selectedCoin ? (
            marketData[selectedCoin]?.length > 0 ? (
              <CoinDetail symbol={selectedCoin} data={marketData[selectedCoin]} />
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-slate-500 space-y-4">
                {isConnected ? (
                  <>
                    <div className="animate-spin text-blue-500"><Activity size={32} /></div>
                    <p>Waiting for first data point for {selectedCoin}…</p>
                    <p className="text-xs text-slate-600">Backend fetches Binance every 60 seconds</p>
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

      <AddCoinModal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} onAdd={addCoin} trackedSymbols={trackedCoins} />
      <GroupModal
        isOpen={isGroupModalOpen}
        onClose={() => {
          setIsGroupModalOpen(false);
          setEditingGroup(null);
        }}
        editingGroup={editingGroup}
        onCreate={createGroup}
        onUpdate={updateGroup}
        onDelete={deleteGroup}
      />
    </div>
  );
};

// Group management modal
const GroupModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  editingGroup: CoinGroup | null;
  onCreate: (name: string, color: string) => void;
  onUpdate: (id: string, updates: Partial<CoinGroup>) => void;
  onDelete: (id: string) => void;
}> = ({ isOpen, onClose, editingGroup, onCreate, onUpdate, onDelete }) => {
  const [name, setName] = useState('');
  const [color, setColor] = useState(DEFAULT_COLORS[0]);

  useEffect(() => {
    if (editingGroup) {
      setName(editingGroup.name);
      setColor(editingGroup.color);
    } else {
      setName('');
      setColor(DEFAULT_COLORS[Math.floor(Math.random() * DEFAULT_COLORS.length)]);
    }
  }, [editingGroup, isOpen]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    if (editingGroup) {
      onUpdate(editingGroup.id, { name: name.trim(), color });
    } else {
      onCreate(name.trim(), color);
    }
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900 rounded-xl border border-slate-800 w-full max-w-md p-6">
        <h3 className="text-lg font-semibold text-white mb-4">
          {editingGroup ? 'Edit Group' : 'Create New Group'}
        </h3>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-xs text-slate-500 mb-2 block">Group Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g., High Volume, Favorites, DeFi"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-600"
              autoFocus
            />
          </div>
          <div>
            <label className="text-xs text-slate-500 mb-2 block">Color</label>
            <div className="flex gap-2 flex-wrap">
              {DEFAULT_COLORS.map(c => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  className={`w-8 h-8 rounded-lg transition-all ${
                    color === c ? 'ring-2 ring-white ring-offset-2 ring-offset-slate-900' : ''
                  }`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>
          <div className="flex gap-2 pt-2">
            {editingGroup && editingGroup.id !== DEFAULT_GROUP_ID && (
              <button
                type="button"
                onClick={() => {
                  if (confirm(`Delete group "${editingGroup.name}"? Coins will move to "All Coins".`)) {
                    onDelete(editingGroup.id);
                    onClose();
                  }
                }}
                className="flex-1 bg-red-600 hover:bg-red-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
              >
                Delete Group
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex-1 bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            >
              {editingGroup ? 'Save' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default App;