import express from 'express';
import cors from 'cors';
import compression from 'compression';
import pg from 'pg';
import dotenv from 'dotenv';
import { setDefaultResultOrder } from 'dns';

setDefaultResultOrder('ipv4first');
dotenv.config();

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
  max: 5,
});

let schemaReady = false;

async function ensureSchema() {
  if (schemaReady) return;
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
  schemaReady = true;
}

function toPoint(r) {
  return {
    timestamp: Number(r.timestamp),
    openInterest: parseFloat(r.open_interest),
    fundingRate: parseFloat(r.funding_rate),
    price: parseFloat(r.price),
  };
}

function toPointWithSymbol(r) {
  return {
    symbol: r.symbol,
    timestamp: Number(r.timestamp),
    openInterest: parseFloat(r.open_interest),
    fundingRate: parseFloat(r.funding_rate),
    price: parseFloat(r.price),
  };
}

async function storePoint(symbol, point) {
  await pool.query(
    `INSERT INTO market_data(symbol, timestamp, open_interest, funding_rate, price)
     VALUES($1,$2,$3,$4,$5)
     ON CONFLICT (symbol, timestamp) DO NOTHING`,
    [symbol, point.timestamp, point.openInterest, point.fundingRate, point.price]
  );
}

const BINANCE_API = 'https://fapi.binance.com';

export async function fetchBinanceData(symbol) {
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
    priceRes.json(), oiRes.json(), fundRes.json(),
  ]);
  return {
    timestamp: Date.now(),
    price: parseFloat(priceData.price),
    openInterest: parseFloat(oiData.openInterest),
    fundingRate: parseFloat(fundData.lastFundingRate),
  };
}

export { pool, storePoint };

const app = express();
app.use(cors());
app.use(compression());
app.use(express.json());

// Schema init middleware — runs once per cold start, then is a no-op
app.use(async (_req, res, next) => {
  try {
    await ensureSchema();
    next();
  } catch (err) {
    console.error('Schema init failed:', err);
    res.status(503).json({ error: 'Database not ready' });
  }
});

// ── Health ────────────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ── Coins ─────────────────────────────────────────────────────────────────────

app.get('/api/coins', async (_req, res) => {
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

// ── Market data ───────────────────────────────────────────────────────────────

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

app.get('/api/market-data/latest-batch', async (req, res) => {
  const raw = req.query.symbols;
  if (!raw || typeof raw !== 'string') {
    return res.status(400).json({ error: 'symbols query param required' });
  }
  const symbols = raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (symbols.length === 0) return res.json([]);
  try {
    const result = await pool.query(
      `SELECT DISTINCT ON (symbol)
         symbol, timestamp, open_interest, funding_rate, price
       FROM market_data
       WHERE symbol = ANY($1)
       ORDER BY symbol, timestamp DESC`,
      [symbols]
    );
    res.json(result.rows.map(toPointWithSymbol));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  }
});

app.get('/api/market-data', async (req, res) => {
  const symbol = req.query.symbol;
  const limit = Math.min(parseInt(String(req.query.limit)) || 100, 500);
  const before = req.query.before ? parseInt(String(req.query.before)) : null;

  if (!symbol || typeof symbol !== 'string') {
    return res.status(400).json({ error: 'symbol query param required' });
  }
  try {
    let rows;
    if (before != null) {
      const result = await pool.query(
        `SELECT timestamp, open_interest, funding_rate, price
         FROM market_data
         WHERE symbol = $1 AND timestamp < $2
         ORDER BY timestamp DESC LIMIT $3`,
        [symbol, before, limit]
      );
      rows = result.rows.reverse();
    } else {
      const result = await pool.query(
        `SELECT timestamp, open_interest, funding_rate, price
         FROM market_data
         WHERE symbol = $1
         ORDER BY timestamp DESC LIMIT $2`,
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

app.get('/api/market-data/range', async (req, res) => {
  const symbol = req.query.symbol;
  const start = req.query.start ? parseInt(String(req.query.start)) : null;
  const end = req.query.end ? parseInt(String(req.query.end)) : null;

  if (!symbol || typeof symbol !== 'string') {
    return res.status(400).json({ error: 'symbol query param required' });
  }
  if (start == null || end == null) {
    return res.status(400).json({ error: 'start and end timestamps required' });
  }
  if (start >= end) {
    return res.status(400).json({ error: 'start must be less than end' });
  }
  try {
    const result = await pool.query(
      `SELECT timestamp, open_interest, funding_rate, price
       FROM market_data
       WHERE symbol = $1 AND timestamp >= $2 AND timestamp <= $3
       ORDER BY timestamp ASC`,
      [symbol, start, end]
    );
    res.json(result.rows.map(toPoint));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  }
});

export default app;