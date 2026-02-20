import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, ReferenceLine,
} from 'recharts';
import {
  TrendingUp, TrendingDown, Clock, ChevronLeft, ChevronRight,
  Radio, ChevronDown, ChevronUp, Download, RefreshCw,
} from 'lucide-react';
import { MarketDataPoint } from '../types';
import { dbService } from '../services/db';

interface CoinDetailProps {
  symbol: string;
  data: MarketDataPoint[];
}

const ONE_MINUTE = 60 * 1000;
const LOAD_BUFFER = 10 * 60 * 1000;
const HISTORICAL_FETCH_LIMIT = 180;

// Chart interval options - each shows ~60 data points
const CHART_INTERVALS = [
  { label: '1 min', value: 1 * 60 * 1000, window: 1 * 60 * 60 * 1000 },   // 1 min → 1 hr
  { label: '5 min', value: 5 * 60 * 1000, window: 5 * 60 * 60 * 1000 },   // 5 min → 5 hr
  { label: '15 min', value: 15 * 60 * 1000, window: 15 * 60 * 60 * 1000 }, // 15 min → 15 hr
  { label: '30 min', value: 30 * 60 * 1000, window: 30 * 60 * 60 * 1000 }, // 30 min → 30 hr
  { label: '1 hour', value: 60 * 60 * 1000, window: 60 * 60 * 60 * 1000 }, // 1 hr → 60 hr (2.5 days)
];

// Snapshot table interval options
const PERIOD_OPTIONS = [
  { label: '1 Hour', value: 1 * 60 * 60 * 1000 },
  { label: '6 Hours', value: 6 * 60 * 60 * 1000 },
  { label: '12 Hours', value: 12 * 60 * 60 * 1000 },
  { label: '24 Hours', value: 24 * 60 * 60 * 1000 },
  { label: '48 Hours', value: 48 * 60 * 60 * 1000 },
];

const INTERVAL_OPTIONS = [
  { label: '5 min', value: 5 * 60 * 1000 },
  { label: '10 min', value: 10 * 60 * 1000 },
  { label: '15 min', value: 15 * 60 * 1000 },
  { label: '30 min', value: 30 * 60 * 1000 },
  { label: '1 hour', value: 60 * 60 * 1000 },
];

interface SnapshotRow {
  timestamp: number;
  openInterest: number;
  fundingRate: number;
  oiChange?: number;
  frChange?: number;
}

export const CoinDetail: React.FC<CoinDetailProps> = ({ symbol, data }) => {
  const [viewOffset, setViewOffset] = useState(0);
  const [historicalData, setHistoricalData] = useState<MarketDataPoint[]>([]);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [earliestFetched, setEarliestFetched] = useState<number | null>(null);
  
  // Chart interval selector
  const [selectedChartInterval, setSelectedChartInterval] = useState(CHART_INTERVALS[0]); // Default: 1 min
  
  // Snapshot table state
  const [isTableOpen, setIsTableOpen] = useState(false);
  const [selectedPeriod, setSelectedPeriod] = useState(PERIOD_OPTIONS[0].value);
  const [selectedInterval, setSelectedInterval] = useState(INTERVAL_OPTIONS[1].value);
  const [snapshots, setSnapshots] = useState<SnapshotRow[]>([]);
  const [isGeneratingSnapshots, setIsGeneratingSnapshots] = useState(false);

  useEffect(() => {
    setViewOffset(0);
    setHistoricalData([]);
    setIsLoadingMore(false);
    setHasMore(true);
    setEarliestFetched(null);
    setSnapshots([]);
    setIsGeneratingSnapshots(false);
  }, [symbol]);

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

  const now = Date.now();
  const viewEnd = now - viewOffset;
  const viewStart = viewEnd - selectedChartInterval.window;

  // Sample data at the selected interval
  const displayData = useMemo(() => {
    const filtered = allData.filter(d => d.timestamp >= viewStart && d.timestamp <= viewEnd);
    
    // If interval is 1 minute, return raw data
    if (selectedChartInterval.value === ONE_MINUTE) {
      return filtered;
    }
    
    // Otherwise, sample at the selected interval
    const sampled: MarketDataPoint[] = [];
    const intervalMs = selectedChartInterval.value;
    
    // Create time buckets
    const buckets = new Map<number, MarketDataPoint[]>();
    for (const point of filtered) {
      const bucketKey = Math.floor(point.timestamp / intervalMs) * intervalMs;
      if (!buckets.has(bucketKey)) {
        buckets.set(bucketKey, []);
      }
      buckets.get(bucketKey)!.push(point);
    }
    
    // Average each bucket
    for (const [bucketTime, points] of buckets.entries()) {
      const avg = {
        timestamp: bucketTime,
        openInterest: points.reduce((sum, p) => sum + p.openInterest, 0) / points.length,
        fundingRate: points.reduce((sum, p) => sum + p.fundingRate, 0) / points.length,
        price: points.reduce((sum, p) => sum + p.price, 0) / points.length,
      };
      sampled.push(avg);
    }
    
    return sampled.sort((a, b) => a.timestamp - b.timestamp);
  }, [allData, viewStart, viewEnd, selectedChartInterval]);

  const isLive = viewOffset < 30_000;

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
    const timeDelta = (pixelDelta / chartWidth) * selectedChartInterval.window;
    const newOffset = Math.max(0, dragState.current.startOffset - timeDelta);
    setViewOffset(newOffset);
  }, [selectedChartInterval.window]);

  const onDragEnd = useCallback(() => {
    dragState.current = null;
  }, []);

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

  const handleTouchStart = (e: React.TouchEvent) => onDragStart(e.touches[0].clientX);
  const handleTouchMove = (e: React.TouchEvent) => onDragMove(e.touches[0].clientX);
  const handleTouchEnd = () => onDragEnd();

  const snapToLive = () => setViewOffset(0);

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

  const generateSnapshots = useCallback(async () => {
    setIsGeneratingSnapshots(true);
    try {
      const endTime = Date.now();
      const startTime = endTime - selectedPeriod;

      const earliestAvailable = allData[0]?.timestamp ?? endTime;
      let dataToUse = allData;

      if (earliestAvailable > startTime) {
        console.log(`[Snapshots] Fetching missing data from ${new Date(startTime)} to ${new Date(endTime)}`);
        const rangeData = await dbService.getMarketDataRange(symbol, startTime, endTime);
        
        const combined = [...rangeData, ...allData];
        const seen = new Set<number>();
        dataToUse = combined
          .filter(d => {
            if (seen.has(d.timestamp)) return false;
            seen.add(d.timestamp);
            return true;
          })
          .sort((a, b) => a.timestamp - b.timestamp);

        setHistoricalData(prev => {
          const merged = [...rangeData, ...prev];
          const s = new Set<number>();
          return merged
            .filter(d => {
              if (s.has(d.timestamp)) return false;
              s.add(d.timestamp);
              return true;
            })
            .sort((a, b) => a.timestamp - b.timestamp);
        });
      }

      const periodData = dataToUse.filter(d => d.timestamp >= startTime && d.timestamp <= endTime);
      
      if (periodData.length === 0) {
        setSnapshots([]);
        return;
      }

      const slots: number[] = [];
      for (let t = startTime; t <= endTime; t += selectedInterval) {
        slots.push(t);
      }

      const rows: SnapshotRow[] = slots.map(slotTime => {
        const closest = periodData.reduce((prev, curr) =>
          Math.abs(curr.timestamp - slotTime) < Math.abs(prev.timestamp - slotTime) ? curr : prev
        );
        return {
          timestamp: slotTime,
          openInterest: closest.openInterest,
          fundingRate: closest.fundingRate,
        };
      });

      for (let i = 1; i < rows.length; i++) {
        rows[i].oiChange = rows[i].openInterest - rows[i - 1].openInterest;
        rows[i].frChange = rows[i].fundingRate - rows[i - 1].fundingRate;
      }

      setSnapshots(rows);
    } catch (err) {
      console.error('[Snapshots] Generation failed:', err);
      alert('Failed to generate snapshots. Check console for details.');
    } finally {
      setIsGeneratingSnapshots(false);
    }
  }, [allData, selectedPeriod, selectedInterval, symbol]);

  const exportCSV = () => {
    if (snapshots.length === 0) return;
    const header = 'Timestamp,Date & Time,Open Interest,OI Change,Funding Rate (%),FR Change (%)';
    const rows = snapshots.map(s => {
      const dt = new Date(s.timestamp).toLocaleString();
      const oi = s.openInterest.toFixed(2);
      const oiChg = s.oiChange !== undefined ? s.oiChange.toFixed(2) : '-';
      const fr = (s.fundingRate * 100).toFixed(6);
      const frChg = s.frChange !== undefined ? (s.frChange * 100).toFixed(6) : '-';
      return `${s.timestamp},"${dt}",${oi},${oiChg},${fr},${frChg}`;
    });
    const csv = [header, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${symbol}_snapshots_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

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

  // Pan step is 1/4 of the window
  const panStep = selectedChartInterval.window / 4;
  const panStepLabel = selectedChartInterval.window < 4 * 60 * 60 * 1000 
    ? `${Math.round(panStep / 60000)} min` 
    : `${Math.round(panStep / 3600000)} hr`;

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
          {isLoadingMore && <span className="text-xs text-gray-500 animate-pulse">Loading older data…</span>}
          {!hasMore && !isLive && <span className="text-xs text-gray-600">No more history</span>}
        </div>
        <span className="text-xs text-gray-500 flex items-center gap-1">
          <Clock size={11} />
          {formatTime(viewStart)} – {formatTime(viewEnd)}
        </span>
      </div>

      {/* Metric Cards */}
      <div className="grid grid-cols-3 gap-3">
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
        <div className="bg-gray-900 rounded-xl p-3 border border-gray-800">
          <p className="text-xs text-gray-500 mb-1">Open Interest</p>
          <p className="text-base font-semibold font-mono text-white">{formatOI(current.openInterest)}</p>
          <p className="text-xs text-gray-600 mt-0.5">Coins</p>
        </div>
        <div className="bg-gray-900 rounded-xl p-3 border border-gray-800">
          <p className="text-xs text-gray-500 mb-1">Funding Rate</p>
          <p className={`text-base font-semibold font-mono ${current.fundingRate > 0 ? 'text-green-400' : 'text-red-400'}`}>
            {(current.fundingRate * 100).toFixed(6)}%
          </p>
          <p className="text-xs text-gray-600 mt-0.5">Predicted</p>
        </div>
      </div>

      {/* Chart Interval Selector */}
      <div className="flex items-center justify-between gap-3 bg-gray-900 rounded-xl p-3 border border-gray-800">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">Chart Interval:</span>
          <div className="flex gap-1">
            {CHART_INTERVALS.map(interval => (
              <button
                key={interval.value}
                onClick={() => setSelectedChartInterval(interval)}
                className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
                  selectedChartInterval.value === interval.value
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-300'
                }`}
              >
                {interval.label}
              </button>
            ))}
          </div>
        </div>
        <span className="text-xs text-gray-600">
          Window: {selectedChartInterval.window / 3600000}h · ~{displayData.length} points
        </span>
      </div>

      <p className="text-xs text-gray-600 text-center select-none">
        ← Drag to pan through history · {selectedChartInterval.window / 3600000}h window
      </p>

      {/* Charts */}
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

        <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
          <p className="text-xs text-gray-500 mb-3 font-medium">Open Interest Trend</p>
          {displayData.length === 0 ? (
            <div className="h-[160px] flex items-center justify-center text-gray-600 text-sm">No data in this window</div>
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
                <XAxis dataKey="timestamp" tickFormatter={formatTime} tick={{ fill: '#6b7280', fontSize: 10 }} axisLine={false} tickLine={false} minTickGap={50} />
                <YAxis tickFormatter={formatOI} tick={{ fill: '#6b7280', fontSize: 10 }} axisLine={false} tickLine={false} domain={getDomain('openInterest')} width={55} />
                <Tooltip content={<CustomTooltip />} cursor={{ stroke: '#3b82f6', strokeWidth: 1, strokeDasharray: '4 4' }} />
                <Area type="monotone" dataKey="openInterest" stroke="#3b82f6" strokeWidth={1.5} fill="url(#oiGradChart)" dot={false} isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
          <p className="text-xs text-gray-500 mb-3 font-medium">Funding Rate Trend</p>
          {displayData.length === 0 ? (
            <div className="h-[160px] flex items-center justify-center text-gray-600 text-sm">No data in this window</div>
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
                <XAxis dataKey="timestamp" tickFormatter={formatTime} tick={{ fill: '#6b7280', fontSize: 10 }} axisLine={false} tickLine={false} minTickGap={50} />
                <YAxis tickFormatter={(v) => (v * 100).toFixed(4) + '%'} tick={{ fill: '#6b7280', fontSize: 10 }} axisLine={false} tickLine={false} domain={getDomain('fundingRate')} width={72} />
                <ReferenceLine y={0} stroke="#374151" strokeDasharray="3 3" />
                <Tooltip content={<CustomTooltip />} cursor={{ stroke: '#f59e0b', strokeWidth: 1, strokeDasharray: '4 4' }} />
                <Area type="monotone" dataKey="fundingRate" stroke="#f59e0b" strokeWidth={1.5} fill="url(#frGradChart)" dot={false} isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Pan controls */}
      <div className="flex justify-between items-center px-1">
        <button
          disabled={!hasMore || isLoadingMore}
          onClick={() => setViewOffset(v => v + panStep)}
          className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <ChevronLeft size={14} /> {panStepLabel} back
        </button>
        <button
          disabled={isLive}
          onClick={() => setViewOffset(v => Math.max(0, v - panStep))}
          className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          {panStepLabel} forward <ChevronRight size={14} />
        </button>
      </div>

      {/* Snapshot Table Section */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
        <button onClick={() => setIsTableOpen(!isTableOpen)} className="w-full flex items-center justify-between p-4 hover:bg-gray-800/50 transition-colors">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-white">Interval Snapshots</span>
            {snapshots.length > 0 && <span className="text-xs text-gray-500">({snapshots.length} rows)</span>}
          </div>
          {isTableOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </button>

        {isTableOpen && (
          <div className="border-t border-gray-800 p-4 space-y-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex-1 min-w-[140px]">
                <label className="text-xs text-gray-500 mb-1 block">Period</label>
                <select value={selectedPeriod} onChange={e => setSelectedPeriod(Number(e.target.value))} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-600">
                  {PERIOD_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                </select>
              </div>
              <div className="flex-1 min-w-[140px]">
                <label className="text-xs text-gray-500 mb-1 block">Interval</label>
                <select value={selectedInterval} onChange={e => setSelectedInterval(Number(e.target.value))} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-600">
                  {INTERVAL_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                </select>
              </div>
              <button
                onClick={generateSnapshots}
                disabled={isGeneratingSnapshots}
                className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 disabled:cursor-not-allowed text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
              >
                <RefreshCw size={14} className={isGeneratingSnapshots ? 'animate-spin' : ''} />
                {isGeneratingSnapshots ? 'Loading...' : 'Generate'}
              </button>
              {snapshots.length > 0 && (
                <button onClick={exportCSV} className="flex items-center gap-2 bg-gray-700 hover:bg-gray-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
                  <Download size={14} /> CSV
                </button>
              )}
            </div>

            {snapshots.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-800">
                      <th className="text-left py-2 px-3 text-gray-500 font-medium">Time</th>
                      <th className="text-right py-2 px-3 text-gray-500 font-medium">Open Interest</th>
                      <th className="text-right py-2 px-3 text-gray-500 font-medium">OI Δ</th>
                      <th className="text-right py-2 px-3 text-gray-500 font-medium">Funding Rate</th>
                      <th className="text-right py-2 px-3 text-gray-500 font-medium">FR Δ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshots.map((row, idx) => (
                      <tr key={idx} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                        <td className="py-2 px-3 text-gray-400 font-mono text-xs">
                          {new Date(row.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}
                        </td>
                        <td className="py-2 px-3 text-right font-mono text-white">{formatOI(row.openInterest)}</td>
                        <td className={`py-2 px-3 text-right font-mono text-xs ${
                          row.oiChange === undefined ? 'text-gray-600' : row.oiChange > 0 ? 'text-green-400' : row.oiChange < 0 ? 'text-red-400' : 'text-gray-500'
                        }`}>
                          {row.oiChange === undefined ? '—' : row.oiChange > 0 ? `+${formatOI(row.oiChange)}` : formatOI(row.oiChange)}
                        </td>
                        <td className={`py-2 px-3 text-right font-mono ${row.fundingRate > 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {(row.fundingRate * 100).toFixed(6)}%
                        </td>
                        <td className={`py-2 px-3 text-right font-mono text-xs ${
                          row.frChange === undefined ? 'text-gray-600' : row.frChange > 0 ? 'text-green-400' : row.frChange < 0 ? 'text-red-400' : 'text-gray-500'
                        }`}>
                          {row.frChange === undefined ? '—' : row.frChange > 0 ? `+${(row.frChange * 100).toFixed(6)}%` : `${(row.frChange * 100).toFixed(6)}%`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-center py-8 text-gray-600 text-sm">Click "Generate" to create interval snapshots</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};