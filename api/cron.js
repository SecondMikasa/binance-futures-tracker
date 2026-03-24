import { pool, fetchBinanceDataBatch } from './index.js';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export default async function handler(req, res) {
  const auth = req.headers.authorization;
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { rows } = await pool.query('SELECT symbol FROM coins');
    if (rows.length === 0) {
      return res.json({ ok: true, message: 'no coins tracked' });
    }

    const symbols = rows.map(r => r.symbol);

    // 2 + N Binance requests instead of N×3
    const dataMap = await fetchBinanceDataBatch(symbols);

    if (dataMap.size === 0) {
      return res.status(500).json({ error: 'no data returned from Binance' });
    }

    // Single multi-row INSERT — one DB round-trip for all coins
    const valueClauses = [];
    const params = [];
    let idx = 1;
    for (const [symbol, point] of dataMap) {
      valueClauses.push(`($${idx++},$${idx++},$${idx++},$${idx++},$${idx++})`);
      params.push(symbol, point.timestamp, point.openInterest, point.fundingRate, point.price);
    }

    await pool.query(
      `INSERT INTO market_data(symbol, timestamp, open_interest, funding_rate, price)
       VALUES ${valueClauses.join(',')}
       ON CONFLICT (symbol, timestamp) DO NOTHING`,
      params
    );

    // Prune old rows only at the top of the hour.
    // Vercel functions are stateless so we can't use an in-memory timestamp;
    // checking the clock minute is a cheap stateless equivalent.
    let pruned = 0;
    if (new Date().getMinutes() === 0) {
      const cutoff = Date.now() - RETENTION_MS;
      const { rowCount } = await pool.query(
        'DELETE FROM market_data WHERE timestamp < $1',
        [cutoff]
      );
      pruned = rowCount ?? 0;
      if (pruned > 0) console.log(`[cron] pruned ${pruned} old rows`);
    }

    // Report which symbols succeeded vs failed
    const succeeded = [...dataMap.keys()];
    const failed = symbols
      .map(s => s.toUpperCase())
      .filter(s => !dataMap.has(s));

    return res.json({ ok: true, updated: succeeded, failed, pruned });
  } catch (err) {
    console.error('[cron] error:', err);
    return res.status(500).json({ error: err?.message ?? 'internal server error' });
  }
}