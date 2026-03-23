import { pool, fetchBinanceData } from './index.js';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export default async function handler(req, res) {
  // Vercel automatically adds this header when CRON_SECRET env var is set.
  // Blocks anyone from hitting /api/cron manually with a plain browser request.
  const auth = req.headers.authorization;
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { rows } = await pool.query('SELECT symbol FROM coins');

    const results = await Promise.allSettled(
      rows.map(async ({ symbol }) => {
        const point = await fetchBinanceData(symbol);
        await pool.query(
          `INSERT INTO market_data(symbol, timestamp, open_interest, funding_rate, price)
           VALUES($1,$2,$3,$4,$5)
           ON CONFLICT (symbol, timestamp) DO NOTHING`,
          [symbol, point.timestamp, point.openInterest, point.fundingRate, point.price]
        );
        return symbol;
      })
    );

    const succeeded = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    const failed = results
      .filter(r => r.status === 'rejected')
      .map((r, i) => ({ symbol: rows[i]?.symbol, reason: r.reason?.message }));

    if (failed.length > 0) {
      console.error('Cron fetch failures:', failed);
    }

    // Prune data older than 7 days
    const cutoff = Date.now() - RETENTION_MS;
    const { rowCount } = await pool.query(
      'DELETE FROM market_data WHERE timestamp < $1',
      [cutoff]
    );
    if (rowCount > 0) console.log(`Pruned ${rowCount} old rows`);

    return res.json({ ok: true, updated: succeeded, failed });
  } catch (err) {
    console.error('Cron error:', err);
    return res.status(500).json({ error: err?.message ?? 'internal server error' });
  }
}