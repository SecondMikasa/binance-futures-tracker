import express from 'express';
import cors from 'cors';
import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── Schema ───────────────────────────────────────────────────────────────────

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coins (
      symbol TEXT PRIMARY KEY,
      added_at TIMESTAMP WITH TIME ZONE DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS market_data (
      id SERIAL PRIMARY KEY,
      symbol TEXT REFERENCES coins(symbol) ON DELETE CASCADE,
      timestamp BIGINT NOT NULL,
      open_interest NUMERIC NOT NULL,
      funding_rate NUMERIC NOT NULL,
      price NUMERIC NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_market_symbol_timestamp ON market_data(symbol, timestamp);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_market_symbol_timestamp ON market_data(symbol, timestamp);
  `);
}

initSchema().catch(err => {
  console.error('Failed to initialize database schema', err);
  process.exit(1); // no point running without a schema
});

// ── Shared helpers ───────────────────────────────────────────────────────────

/** Map a DB row → frontend-friendly MarketDataPoint */
function toPoint(r) {
  return {
    timestamp: Number(r.timestamp),
    openInterest: parseFloat(r.open_interest),
    fundingRate: parseFloat(r.funding_rate),
    price: parseFloat(r.price),
  };
}

/** Upsert a single MarketDataPoint into the DB */
async function storePoint(symbol, point) {
  await pool.query(
    `INSERT INTO market_data(symbol, timestamp, open_interest, funding_rate, price)
     VALUES($1,$2,$3,$4,$5)
     ON CONFLICT (symbol, timestamp) DO NOTHING`,
    [symbol, point.timestamp, point.openInterest, point.fundingRate, point.price]
  );
}

// ── Binance helper ───────────────────────────────────────────────────────────

const BINANCE_API = 'https://fapi.binance.com';

async function fetchBinanceData(symbol) {
  const encoded = encodeURIComponent(symbol);
  const [priceRes, oiRes, fundRes] = await Promise.all([
    fetch(`${BINANCE_API}/fapi/v1/ticker/price?symbol=${encoded}`),
    fetch(`${BINANCE_API}/fapi/v1/openInterest?symbol=${encoded}`),
    fetch(`${BINANCE_API}/fapi/v1/premiumIndex?symbol=${encoded}`),
  ]);
  if (!priceRes.ok || !oiRes.ok || !fundRes.ok) {
    throw new Error(
      `Binance request failed — price:${priceRes.status}, oi:${oiRes.status}, fund:${fundRes.status}`
    );
  }
  const [priceData, oiData, fundData] = await Promise.all([
    priceRes.json(),
    oiRes.json(),
    fundRes.json(),
  ]);
  return {
    timestamp: Date.now(),
    price: parseFloat(priceData.price),
    openInterest: parseFloat(oiData.openInterest),
    fundingRate: parseFloat(fundData.lastFundingRate),
  };
}

// ── App ──────────────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

// ── Coins ────────────────────────────────────────────────────────────────────

app.get('/api/coins', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT symbol, added_at FROM coins ORDER BY added_at');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  }
});

app.post('/api/coins', async (req, res) => {
  const { symbol } = req.body;
  if (!symbol || typeof symbol !== 'string') {
    return res.status(400).json({ error: 'symbol is required' });
  }
  try {
    await pool.query(
      'INSERT INTO coins(symbol) VALUES($1) ON CONFLICT DO NOTHING',
      [symbol.toUpperCase()]
    );
    res.status(201).json({ symbol });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  }
});

app.delete('/api/coins/:symbol', async (req, res) => {
  const { symbol } = req.params;
  try {
    await pool.query('DELETE FROM coins WHERE symbol = $1', [symbol]);
    res.json({ symbol });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  }
});

// ── Market data ──────────────────────────────────────────────────────────────

app.post('/api/market-data', async (req, res) => {
  const { symbol, timestamp, openInterest, fundingRate, price } = req.body;
  if (!symbol || timestamp == null || openInterest == null || fundingRate == null || price == null) {
    return res.status(400).json({ error: 'missing fields' });
  }
  try {
    await storePoint(symbol, { timestamp, openInterest, fundingRate, price });
    res.status(201).json({ symbol, timestamp });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  }
});

app.post('/api/market-data/fetch', async (req, res) => {
  const { symbol } = req.body;
  if (!symbol || typeof symbol !== 'string') {
    return res.status(400).json({ error: 'symbol is required' });
  }
  try {
    const point = await fetchBinanceData(symbol);
    await storePoint(symbol, point);
    res.json(point);
  } catch (err) {
    console.error('fetch endpoint error', err);
    res.status(500).json({ error: err?.message ?? 'internal server error' });
  }
});

/**
 * GET /api/market-data?symbol=BTCUSDT&limit=100&before=<unix_ms>
 *
 * Returns up to `limit` points (max 500) in ascending timestamp order.
 * When `before` is supplied, only rows with timestamp < before are returned —
 * this is what powers the pan-back lazy-load in the frontend.
 */
app.get('/api/market-data', async (req, res) => {
  const symbol = req.query.symbol;
  const limit = Math.min(parseInt(String(req.query.limit)) || 100, 500); // cap at 500
  const before = req.query.before ? parseInt(String(req.query.before)) : null;

  if (!symbol || typeof symbol !== 'string') {
    return res.status(400).json({ error: 'symbol query param required' });
  }

  try {
    let rows;

    if (before != null) {
      // Paginating backwards: fetch the N rows immediately before `before`,
      // using DESC so LIMIT cuts at the correct end, then flip to ASC for the client.
      const result = await pool.query(
        `SELECT timestamp, open_interest, funding_rate, price
         FROM market_data
         WHERE symbol = $1 AND timestamp < $2
         ORDER BY timestamp DESC
         LIMIT $3`,
        [symbol, before, limit]
      );
      rows = result.rows.reverse(); // back to ascending order
    } else {
      // Default: most recent N rows, ascending
      const result = await pool.query(
        `SELECT timestamp, open_interest, funding_rate, price
         FROM market_data
         WHERE symbol = $1
         ORDER BY timestamp DESC
         LIMIT $2`,
        [symbol, limit]
      );
      rows = result.rows.reverse();
    }

    res.json(rows.map(toPoint));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  }
});

// ── Periodic fetch job ───────────────────────────────────────────────────────

// How long to keep market data. 7 days is plenty for a chart tool.
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

async function runFetchCycle() {
  try {
    const { rows } = await pool.query('SELECT symbol FROM coins');

    await Promise.all(
      rows.map(async ({ symbol }) => {
        try {
          const point = await fetchBinanceData(symbol);
          await storePoint(symbol, point);
        } catch (e) {
          console.error(`Failed to fetch/store data for ${symbol}:`, e?.message ?? e);
        }
      })
    );

    // Prune data older than RETENTION_MS so the DB doesn't grow forever
    const cutoff = Date.now() - RETENTION_MS;
    const { rowCount } = await pool.query(
      'DELETE FROM market_data WHERE timestamp < $1',
      [cutoff]
    );
    if (rowCount > 0) {
      console.log(`Pruned ${rowCount} old market_data rows`);
    }
  } catch (e) {
    console.error('Fetch cycle error:', e?.message ?? e);
  }
}

// Start 5 s after launch, then every 60 s
setTimeout(() => {
  runFetchCycle();
  setInterval(runFetchCycle, 60 * 1000);
}, 5 * 1000);

// ── Start ────────────────────────────────────────────────────────────────────

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});