import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, ReferenceLine,
} from 'recharts';
import { TrendingUp, TrendingDown, Clock, ChevronLeft, ChevronRight, Radio } from 'lucide-react';
import { MarketDataPoint } from '../types';
import { dbService } from '../services/db';

interface CoinDetailProps {
  symbol: string;
  data: MarketDataPoint[]; // live streaming data (last N points from parent)
}

const ONE_HOUR = 60 * 60 * 1000;
const LOAD_BUFFER = 10 * 60 * 1000; // fetch more when within 10 min of edge
const HISTORICAL_FETCH_LIMIT = 180; // ~3 hrs of 1-min data per fetch

export const CoinDetail: React.FC<CoinDetailProps> = ({ symbol, data }) => {
  // viewOffset: how many ms back from "now" the right edge of the window is.
  // 0 = live (right edge is current time), positive = panned back.
  const [viewOffset, setViewOffset] = useState(0);

  // Historical data fetched on demand (older than what the parent provides)
  const [historicalData, setHistoricalData] = useState<MarketDataPoint[]>([]);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [earliestFetched, setEarliestFetched] = useState<number | null>(null);

  // Reset everything when switching coins
  useEffect(() => {
    setViewOffset(0);
    setHistoricalData([]);
    setIsLoadingMore(false);
    setHasMore(true);
    setEarliestFetched(null);
  }, [symbol]);

  // ─── Merge live data + historical data ───────────────────────────────────
  const allData = useMemo(() => {
    const combined = [...historicalData, ...data];
    const seen = new Set<number>();
    return combined
      .filter(d => {
        if (seen.has(d.timestamp)) return false;
        seen.add(d.timestamp);
        return true;
      })
      .sort((a, b) => a.timestamp - b.timestamp);
  }, [data, historicalData]);

  // ─── View window ─────────────────────────────────────────────────────────
  const now = Date.now();
  const viewEnd = now - viewOffset;
  const viewStart = viewEnd - ONE_HOUR;

  const displayData = useMemo(
    () => allData.filter(d => d.timestamp >= viewStart && d.timestamp <= viewEnd),
    [allData, viewStart, viewEnd]
  );

  const isLive = viewOffset < 30_000; // within 30 s of now = "live"

  // ─── Lazy-load historical data when near the left edge ───────────────────
  const loadMore = useCallback(async () => {
    if (isLoadingMore || !hasMore) return;
    const before = earliestFetched ?? allData[0]?.timestamp ?? Date.now();
    setIsLoadingMore(true);
    try {
      const moreData = await dbService.getMarketData(symbol, HISTORICAL_FETCH_LIMIT, before);
      if (!moreData || moreData.length === 0) {
        setHasMore(false);
      } else {
        const sorted = [...moreData].sort((a, b) => a.timestamp - b.timestamp);
        setHistoricalData(prev => {
          // prepend, deduplicate
          const combined = [...sorted, ...prev];
          const seen = new Set<number>();
          return combined.filter(d => {
            if (seen.has(d.timestamp)) return false;
            seen.add(d.timestamp);
            return true;
          }).sort((a, b) => a.timestamp - b.timestamp);
        });
        setEarliestFetched(sorted[0].timestamp);
      }
    } catch (err) {
      console.error('[CoinDetail] loadMore failed:', err);
    } finally {
      setIsLoadingMore(false);
    }
  }, [isLoadingMore, hasMore, earliestFetched, allData, symbol]);

  useEffect(() => {
    if (!allData.length || !hasMore) return;
    const earliestAvailable = allData[0].timestamp;
    if (viewStart < earliestAvailable + LOAD_BUFFER) {
      loadMore();
    }
  }, [viewStart, allData, hasMore, loadMore]);

  // ─── Pan / drag handling ──────────────────────────────────────────────────
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const dragState = useRef<{ startX: number; startOffset: number } | null>(null);

  const onDragStart = useCallback((clientX: number) => {
    dragState.current = { startX: clientX, startOffset: viewOffset };
  }, [viewOffset]);

  const onDragMove = useCallback((clientX: number) => {
    if (!dragState.current || !chartContainerRef.current) return;
    const chartWidth = chartContainerRef.current.offsetWidth;
    if (chartWidth === 0) return;
    const pixelDelta = clientX - dragState.current.startX;
    // dragging right (+pixelDelta) → pan back in time (offset increases)
    const timeDelta = (pixelDelta / chartWidth) * ONE_HOUR;
    const newOffset = Math.max(0, dragState.current.startOffset - timeDelta);
    setViewOffset(newOffset);
  }, []);

  const onDragEnd = useCallback(() => {
    dragState.current = null;
  }, []);

  // Mouse events
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    onDragStart(e.clientX);
    window.addEventListener('mousemove', handleWindowMouseMove);
    window.addEventListener('mouseup', handleWindowMouseUp);
  };
  const handleWindowMouseMove = useCallback((e: MouseEvent) => onDragMove(e.clientX), [onDragMove]);
  const handleWindowMouseUp = useCallback(() => {
    onDragEnd();
    window.removeEventListener('mousemove', handleWindowMouseMove);
    window.removeEventListener('mouseup', handleWindowMouseUp);
  }, [onDragEnd, handleWindowMouseMove]);

  // Touch events
  const handleTouchStart = (e: React.TouchEvent) => {
    onDragStart(e.touches[0].clientX);
  };
  const handleTouchMove = (e: React.TouchEvent) => {
    onDragMove(e.touches[0].clientX);
  };
  const handleTouchEnd = () => onDragEnd();

  // Snap back to live
  const snapToLive = () => setViewOffset(0);

  // ─── Helpers ─────────────────────────────────────────────────────────────
  const formatTime = (ts: number) =>
    new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

  const formatOI = (val: number) => {
    if (val >= 1_000_000) return (val / 1_000_000).toFixed(3) + 'M';
    if (val >= 1_000) return (val / 1_000).toFixed(3) + 'K';
    return val.toFixed(0);
  };

  const getDomain = (key: keyof MarketDataPoint) => {
    if (!displayData.length) return ['dataMin', 'dataMax'];
    const vals = displayData.map(d => d[key] as number);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    if (min === max) return [min * 0.9999, max * 1.0001];
    return ['dataMin', 'dataMax'];
  };

  const CustomTooltip = ({ active, payload }: any) => {
    if (!active || !payload?.length) return null;
    const d = payload[0].payload as MarketDataPoint;
    return (
      <div className="bg-gray-900/95 border border-gray-700 rounded-lg p-3 shadow-xl backdrop-blur text-xs">
        <p className="text-gray-400 mb-2 flex items-center gap-1">
          <Clock size={10} /> {formatTime(d.timestamp)}
        </p>
        {payload.map((p: any) => (
          <div key={p.name} className="flex justify-between gap-4">
            <span className="text-gray-500">
              {p.name === 'openInterest' ? 'Open Interest' : 'Funding Rate'}
            </span>
            <span style={{ color: p.color }} className="font-mono">
              {p.name === 'openInterest'
                ? formatOI(p.value)
                : (p.value * 100).toFixed(6) + '%'}
            </span>
          </div>
        ))}
      </div>
    );
  };

  // ─── Current values ───────────────────────────────────────────────────────
  const current = data[data.length - 1];
  const previous = data.length > 1 ? data[data.length - 2] : null;
  const priceChange = current && previous ? current.price - previous.price : 0;
  const isPriceUp = priceChange >= 0;

  if (!current) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-500 text-sm">
        <Clock size={16} className="mr-2 animate-spin" />
        Waiting for initial data…
      </div>
    );
  }

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">

      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {isLive ? (
            <span className="flex items-center gap-1.5 text-xs text-green-400 font-medium">
              <Radio size={11} className="animate-pulse" /> LIVE
            </span>
          ) : (
            <button
              onClick={snapToLive}
              className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 transition-colors border border-blue-800 hover:border-blue-600 rounded-full px-2 py-0.5"
            >
              <Radio size={11} /> Back to Live
            </button>
          )}
          {isLoadingMore && (
            <span className="text-xs text-gray-500 animate-pulse">Loading older data…</span>
          )}
          {!hasMore && !isLive && (
            <span className="text-xs text-gray-600">No more history</span>
          )}
        </div>
        <span className="text-xs text-gray-500 flex items-center gap-1">
          <Clock size={11} />
          {formatTime(viewStart)} – {formatTime(viewEnd)}
        </span>
      </div>

      {/* Metric Cards */}
      <div className="grid grid-cols-3 gap-3">
        {/* Price */}
        <div className="bg-gray-900 rounded-xl p-3 border border-gray-800">
          <p className="text-xs text-gray-500 mb-1">Price</p>
          <p className="text-base font-semibold font-mono text-white">
            ${current.price.toLocaleString(undefined, { minimumFractionDigits: 2 })}
          </p>
          <p className={`text-xs flex items-center gap-0.5 mt-0.5 ${isPriceUp ? 'text-green-400' : 'text-red-400'}`}>
            {isPriceUp ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
            {Math.abs(priceChange).toFixed(2)}
          </p>
        </div>

        {/* OI */}
        <div className="bg-gray-900 rounded-xl p-3 border border-gray-800">
          <p className="text-xs text-gray-500 mb-1">Open Interest</p>
          <p className="text-base font-semibold font-mono text-white">{formatOI(current.openInterest)}</p>
          <p className="text-xs text-gray-600 mt-0.5">Coins</p>
        </div>

        {/* Funding */}
        <div className="bg-gray-900 rounded-xl p-3 border border-gray-800">
          <p className="text-xs text-gray-500 mb-1">Funding Rate</p>
          <p className={`text-base font-semibold font-mono ${current.fundingRate > 0 ? 'text-green-400' : 'text-red-400'}`}>
            {(current.fundingRate * 100).toFixed(6)}%
          </p>
          <p className="text-xs text-gray-600 mt-0.5">Predicted</p>
        </div>
      </div>

      {/* Pan hint */}
      <p className="text-xs text-gray-600 text-center select-none">
        ← Drag to pan through history · 1-hour window
      </p>

      {/* Charts — wrapped in draggable container */}
      <div
        ref={chartContainerRef}
        className="space-y-4 select-none"
        style={{ cursor: dragState.current ? 'grabbing' : 'grab' }}
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <svg width="0" height="0">
          <defs>
            <linearGradient id="oiGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.25} />
              <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="frGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.25} />
              <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
            </linearGradient>
          </defs>
        </svg>

        {/* Open Interest */}
        <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
          <p className="text-xs text-gray-500 mb-3 font-medium">Open Interest Trend</p>
          {displayData.length === 0 ? (
            <div className="h-[160px] flex items-center justify-center text-gray-600 text-sm">
              No data in this window
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={160}>
              <AreaChart data={displayData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="oiGradChart" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                <XAxis
                  dataKey="timestamp"
                  tickFormatter={formatTime}
                  tick={{ fill: '#6b7280', fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  minTickGap={50}
                />
                <YAxis
                  tickFormatter={formatOI}
                  tick={{ fill: '#6b7280', fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  domain={getDomain('openInterest')}
                  width={55}
                />
                <Tooltip
                  content={<CustomTooltip />}
                  cursor={{ stroke: '#3b82f6', strokeWidth: 1, strokeDasharray: '4 4' }}
                />
                <Area
                  type="monotone"
                  dataKey="openInterest"
                  stroke="#3b82f6"
                  strokeWidth={1.5}
                  fill="url(#oiGradChart)"
                  dot={false}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Funding Rate */}
        <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
          <p className="text-xs text-gray-500 mb-3 font-medium">Funding Rate Trend</p>
          {displayData.length === 0 ? (
            <div className="h-[160px] flex items-center justify-center text-gray-600 text-sm">
              No data in this window
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={160}>
              <AreaChart data={displayData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="frGradChart" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                <XAxis
                  dataKey="timestamp"
                  tickFormatter={formatTime}
                  tick={{ fill: '#6b7280', fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  minTickGap={50}
                />
                <YAxis
                  tickFormatter={(v) => (v * 100).toFixed(4) + '%'}
                  tick={{ fill: '#6b7280', fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  domain={getDomain('fundingRate')}
                  width={72}
                />
                <ReferenceLine y={0} stroke="#374151" strokeDasharray="3 3" />
                <Tooltip
                  content={<CustomTooltip />}
                  cursor={{ stroke: '#f59e0b', strokeWidth: 1, strokeDasharray: '4 4' }}
                />
                <Area
                  type="monotone"
                  dataKey="fundingRate"
                  stroke="#f59e0b"
                  strokeWidth={1.5}
                  fill="url(#frGradChart)"
                  dot={false}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Pan controls (optional buttons for accessibility) */}
      <div className="flex justify-between items-center px-1">
        <button
          disabled={!hasMore || isLoadingMore}
          onClick={() => setViewOffset(v => v + ONE_HOUR / 4)}
          className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <ChevronLeft size={14} /> 15 min back
        </button>
        <button
          disabled={isLive}
          onClick={() => setViewOffset(v => Math.max(0, v - ONE_HOUR / 4))}
          className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          15 min forward <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
};