import React, { useState, useEffect } from 'react';
import { 
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, 
  CartesianGrid, ReferenceLine, Brush 
} from 'recharts';
import { TrendingUp, TrendingDown, Clock } from 'lucide-react';
import { MarketDataPoint } from '../types';

interface CoinDetailProps {
  symbol: string;
  data: MarketDataPoint[];
}

export const CoinDetail: React.FC<CoinDetailProps> = ({ symbol, data }) => {
  const [brushRange, setBrushRange] = useState<{startIndex: number, endIndex: number} | null>(null);

  // Reset brush when switching coins
  useEffect(() => {
    setBrushRange(null);
  }, [symbol]);

  const current = data[data.length - 1];
  const previous = data.length > 1 ? data[data.length - 2] : null;

  // Calculate changes
  const priceChange = current && previous ? current.price - previous.price : 0;
  const isPriceUp = priceChange >= 0;

  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  };

  // Dynamic formatting for Open Interest to ensure changes are visible
  const formatOI = (val: number) => {
    if (val >= 1000000) return (val / 1000000).toFixed(3) + 'M';
    if (val >= 1000) return (val / 1000).toFixed(3) + 'K';
    return val.toFixed(0);
  };

  // Dynamic domain calculation to prevent flat lines when variance is very small
  const getDomain = (dataKey: keyof MarketDataPoint) => {
    const values = data.map(d => d[dataKey]);
    const min = Math.min(...values);
    const max = Math.max(...values);
    
    // If values are identical, add a tiny buffer to create a range
    if (min === max) {
      return [min * 0.9999, max * 1.0001]; 
    }
    return ['dataMin', 'dataMax'];
  };

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      const d = payload[0].payload as MarketDataPoint;
      return (
        <div className="bg-slate-900/90 backdrop-blur-md border border-slate-700 p-3 rounded-lg shadow-2xl text-xs z-50 ring-1 ring-white/10">
          <p className="text-slate-400 mb-2 font-medium border-b border-slate-800 pb-1 flex justify-between">
            <span>{formatTime(d.timestamp)}</span>
            <span className="text-slate-500 font-mono text-[10px] ml-4">Vol: Live</span>
          </p>
          <div className="space-y-2">
             {payload.map((p: any) => (
               <div key={p.name} className="flex justify-between items-center gap-8">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full" style={{ backgroundColor: p.color }}></div>
                    <span className="text-slate-300 capitalize font-medium">
                        {p.name === 'openInterest' ? 'Open Interest' : 'Funding Rate'}
                    </span>
                  </div>
                  <span className="font-mono font-bold text-sm tracking-tight" style={{ color: p.color }}>
                    {p.name === 'openInterest' 
                      ? formatOI(p.value)
                      : (p.value * 100).toFixed(6) + '%'
                    }
                  </span>
               </div>
             ))}
          </div>
        </div>
      );
    }
    return null;
  };

  if (!current) {
    return (
      <div className="h-full flex items-center justify-center text-slate-500">
        <div className="text-center">
          <Clock className="w-12 h-12 mx-auto mb-3 opacity-50 animate-pulse" />
          <p>Waiting for initial data update...</p>
        </div>
      </div>
    );
  }

  // Slice data for the top chart to match the brush selection on the bottom chart
  const activeData = brushRange ? data.slice(brushRange.startIndex, brushRange.endIndex + 1) : data;

  return (
    <div className="flex flex-col space-y-4 pb-8">
      
      {/* Top Controls: Last Updated */}
      <div className="flex justify-between items-center pb-2 flex-shrink-0">
         <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
            <span className="text-slate-400 text-sm font-medium">Last updated: {formatTime(current.timestamp)}</span>
         </div>
      </div>

      {/* Metric Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 flex-shrink-0">
        {/* Price Card */}
        <div className="bg-slate-800/50 backdrop-blur-sm p-4 rounded-xl border border-slate-700/50 hover:border-slate-600 transition-colors group">
            <span className="text-slate-400 text-xs font-medium uppercase tracking-wider group-hover:text-slate-300 transition-colors">Price</span>
            <div className="flex items-end gap-2 mt-1">
                <span className="text-2xl font-mono font-bold text-white tracking-tight">
                    ${current.price.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </span>
                <span className={`flex items-center text-sm font-medium mb-1 px-1.5 py-0.5 rounded ${isPriceUp ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>
                    {isPriceUp ? <TrendingUp size={12} className="mr-1"/> : <TrendingDown size={12} className="mr-1"/>}
                    {Math.abs(priceChange).toFixed(2)}
                </span>
            </div>
        </div>

        {/* OI Card */}
        <div className="bg-slate-800/50 backdrop-blur-sm p-4 rounded-xl border border-slate-700/50 hover:border-blue-500/30 transition-colors group">
            <span className="text-blue-400 text-xs font-medium uppercase tracking-wider group-hover:text-blue-300 transition-colors">Open Interest</span>
            <div className="flex items-end gap-2 mt-1">
                <span className="text-2xl font-mono font-bold text-white tracking-tight">
                    {formatOI(current.openInterest)}
                </span>
                <span className="text-slate-500 text-xs mb-1">Coins</span>
            </div>
        </div>

        {/* Funding Card */}
        <div className="bg-slate-800/50 backdrop-blur-sm p-4 rounded-xl border border-slate-700/50 hover:border-amber-500/30 transition-colors group">
            <span className="text-amber-400 text-xs font-medium uppercase tracking-wider group-hover:text-amber-300 transition-colors">Funding Rate</span>
            <div className="flex items-end gap-2 mt-1">
                <span className={`text-2xl font-mono font-bold tracking-tight ${current.fundingRate > 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {(current.fundingRate * 100).toFixed(6)}%
                </span>
                <span className="text-slate-500 text-xs mb-1">Predicted</span>
            </div>
        </div>
      </div>

      {/* Graph Area */}
      <div className="bg-slate-800/50 backdrop-blur-sm rounded-xl border border-slate-700/50 p-4 shadow-inner">
        
        {/* Common Gradients */}
        <div className="h-0 w-0 overflow-hidden">
            <svg>
                <defs>
                    <linearGradient id="colorOi" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.4}/>
                        <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                    </linearGradient>
                    <linearGradient id="colorFr" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.4}/>
                        <stop offset="95%" stopColor="#f59e0b" stopOpacity={0}/>
                    </linearGradient>
                </defs>
            </svg>
        </div>

        {/* Graph 1: Open Interest - Fixed Height */}
        <div className="h-[320px] w-full flex flex-col mb-6">
            <div className="flex items-center justify-between px-2 mb-2 shrink-0">
                <h4 className="text-sm font-semibold text-blue-400 flex items-center gap-2">
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
                    </span>
                    Open Interest Trend
                </h4>
            </div>
            <div className="flex-1 w-full min-h-0">
                <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={activeData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }} syncId="coinGraph">
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                        <XAxis dataKey="timestamp" hide={true} />
                        <YAxis 
                          orientation="right" 
                          stroke="#475569" 
                          fontSize={10} 
                          tickFormatter={formatOI}
                          axisLine={false}
                          tickLine={false}
                          domain={['dataMin', 'dataMax']} 
                          width={60}
                        />
                        <Tooltip content={<CustomTooltip />} cursor={{ stroke: '#3b82f6', strokeWidth: 1, strokeDasharray: '4 4' }} />
                        <Area 
                          type="monotone" 
                          dataKey="openInterest" 
                          stroke="#3b82f6" 
                          strokeWidth={2}
                          fillOpacity={1} 
                          fill="url(#colorOi)" 
                          isAnimationActive={true}
                        />
                    </AreaChart>
                </ResponsiveContainer>
            </div>
        </div>

        {/* Graph 2: Funding Rate - Fixed Height */}
        <div className="h-[320px] w-full flex flex-col border-t border-slate-700/50 pt-6 relative">
            <div className="flex items-center justify-between px-2 mb-2 shrink-0">
                 <h4 className="text-sm font-semibold text-amber-400 flex items-center gap-2">
                    <span className="w-2 h-2 bg-amber-500 rounded-full shadow-[0_0_8px_rgba(245,158,11,0.6)]"></span>
                    Funding Rate Trend
                </h4>
            </div>
            <div className="flex-1 w-full min-h-0">
                <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }} syncId="coinGraph">
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                        <ReferenceLine y={0} stroke="#475569" strokeDasharray="3 3" />
                        <XAxis 
                          dataKey="timestamp" 
                          tickFormatter={formatTime}
                          stroke="#475569"
                          fontSize={10}
                          tickLine={false}
                          axisLine={false}
                          minTickGap={50}
                        />
                        <YAxis 
                          orientation="right" 
                          stroke="#475569" 
                          fontSize={10}
                          tickFormatter={(val) => (val * 100).toFixed(6) + '%'} 
                          axisLine={false}
                          tickLine={false}
                          domain={getDomain('fundingRate')}
                          width={60}
                        />
                        <Tooltip content={<CustomTooltip />} cursor={{ stroke: '#f59e0b', strokeWidth: 1, strokeDasharray: '4 4' }} />
                        <Area 
                          type="monotone" 
                          dataKey="fundingRate" 
                          stroke="#f59e0b" 
                          strokeWidth={2}
                          fillOpacity={1} 
                          fill="url(#colorFr)"
                          isAnimationActive={true}
                        />
                        <Brush 
                            dataKey="timestamp" 
                            height={30} 
                            stroke="#475569" 
                            fill="#0f172a" 
                            tickFormatter={formatTime}
                            onChange={(e: any) => setBrushRange(e)}
                            alwaysShowText={false}
                            className="text-[10px]"
                        />
                    </AreaChart>
                </ResponsiveContainer>
            </div>
        </div>

      </div>
    </div>
  );
};