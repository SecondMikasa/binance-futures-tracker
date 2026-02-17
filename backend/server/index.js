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
});

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
  if (!symbol) {
    return res.status(400).json({ error: 'symbol is required' });
  }
  try {
    await pool.query('INSERT INTO coins(symbol) VALUES($1) ON CONFLICT DO NOTHING', [symbol]);
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
    await pool.query(
      `INSERT INTO market_data(symbol, timestamp, open_interest, funding_rate, price)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT (symbol, timestamp) DO NOTHING`,
      [symbol, timestamp, openInterest, fundingRate, price]
    );
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
    if (!point) throw new Error('fetchBinanceData returned null');
    await pool.query(
      `INSERT INTO market_data(symbol, timestamp, open_interest, funding_rate, price)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT (symbol, timestamp) DO NOTHING`,
      [symbol, point.timestamp, point.openInterest, point.fundingRate, point.price]
    );
    res.json(point);
  } catch (err) {
    console.error('fetch endpoint error', err);
    const message = err?.message ?? 'internal server error';
    res.status(500).json({ error: message, stack: err?.stack });
  }
});

app.get('/api/market-data', async (req, res) => {
  const symbol = req.query.symbol;
  const limit = parseInt(String(req.query.limit)) || 100;
  if (!symbol || typeof symbol !== 'string') {
    return res.status(400).json({ error: 'symbol query param required' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT timestamp, open_interest, funding_rate, price
       FROM market_data
       WHERE symbol = $1
       ORDER BY timestamp ASC
       LIMIT $2`,
      [symbol, limit]
    );
    const typed = rows.map(r => ({
      timestamp: Number(r.timestamp),
      openInterest: parseFloat(r.open_interest),
      fundingRate: parseFloat(r.funding_rate),
      price: parseFloat(r.price),
    }));
    res.json(typed);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  }
});

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
    const details = `price:${priceRes.status}, oi:${oiRes.status}, fund:${fundRes.status}`;
    throw new Error(`binance request failed (${details})`);
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

// ── Periodic fetch job ───────────────────────────────────────────────────────

async function runFetchCycle() {
  try {
    const { rows } = await pool.query('SELECT symbol FROM coins');
    for (const row of rows) {
      try {
        const point = await fetchBinanceData(row.symbol);
        await pool.query('INSERT INTO coins(symbol) VALUES($1) ON CONFLICT DO NOTHING', [row.symbol]);
        await pool.query(
          `INSERT INTO market_data(symbol, timestamp, open_interest, funding_rate, price)
           VALUES($1,$2,$3,$4,$5)
           ON CONFLICT (symbol, timestamp) DO NOTHING`,
          [row.symbol, point.timestamp, point.openInterest, point.fundingRate, point.price]
        );
      } catch (e) {
        console.error(`failed to fetch/store data for ${row.symbol}:`, e?.message ?? e);
      }
    }
  } catch (e) {
    console.error('fetch cycle error', e?.message ?? e);
  }
}

// start 5 s after launch, then every 60 s
setTimeout(() => {
  runFetchCycle();
  setInterval(runFetchCycle, 60 * 1000);
}, 5 * 1000);

// ── Start ────────────────────────────────────────────────────────────────────

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`server listening on port ${port}`);
});