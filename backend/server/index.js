import express from 'express';
import cors from 'cors';
import compression from 'compression';
import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import { setDefaultResultOrder } from 'dns';
import { HttpsProxyAgent } from 'https-proxy-agent';

// Force Node.js to prefer IPv4 when resolving hostnames.
setDefaultResultOrder('ipv4first');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.resolve(__dirname, '../.env.local') });
dotenv.config({ path: path.resolve(__dirname, '../.env') });

if (!process.env.DATABASE_URL) {
  console.error(
    'DATABASE_URL is not set.\n' +
    ' • Local dev: create backend/.env.local with DATABASE_URL=postgres://...\n' +
    ' • Deployed:  set DATABASE_URL as an environment variable in your platform dashboard.'
  );
  process.exit(1);
}

// ── Proxy rotation ───────────────────────────────────────────────────────────

// Format from Webshare: host:port:user:pass
const RAW_PROXIES = [
  '31.59.20.176:6754:ichvsliv:s1dat7zt5etk',
  '23.95.150.145:6114:ichvsliv:s1dat7zt5etk',
  '198.23.239.134:6540:ichvsliv:s1dat7zt5etk',
  '45.38.107.97:6014:ichvsliv:s1dat7zt5etk',
  '107.172.163.27:6543:ichvsliv:s1dat7zt5etk',
  '198.105.121.200:6462:ichvsliv:s1dat7zt5etk',
  '216.10.27.159:6837:ichvsliv:s1dat7zt5etk',
  '142.111.67.146:5611:ichvsliv:s1dat7zt5etk',
  '191.96.254.138:6185:ichvsliv:s1dat7zt5etk',
  '31.58.9.4:6077:ichvsliv:s1dat7zt5etk',
];

const PROXY_AGENTS = RAW_PROXIES.map(raw => {
  const [host, port, user, pass] = raw.split(':');
  const url = `http://${user}:${pass}@${host}:${port}`;
  return new HttpsProxyAgent(url);
});

let proxyIndex = 0;

function getNextProxy() {
  const agent = PROXY_AGENTS[proxyIndex];
  proxyIndex = (proxyIndex + 1) % PROXY_AGENTS.length;
  return agent;
}

console.log(`Loaded ${PROXY_AGENTS.length} proxies for rotation.`);

// ── Database ─────────────────────────────────────────────────────────────────

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
});

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
  console.log('Database schema ready.');
}

// ── Shared helpers ───────────────────────────────────────────────────────────

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

// ── Binance helper with proxy rotation ───────────────────────────────────────

const BINANCE_API = 'https://fapi.binance.com';

async function fetchBinanceData(symbol) {
  const encoded = encodeURIComponent(symbol);

  // Try each proxy up to 3 times before giving up
  const maxAttempts = Math.min(3, PROXY_AGENTS.length);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const agent = getNextProxy();

    try {
      const [priceRes, oiRes, fundRes] = await Promise.all([
        fetch(`${BINANCE_API}/fapi/v1/ticker/price?symbol=${encoded}`, { agent }),
        fetch(`${BINANCE_API}/fapi/v1/openInterest?symbol=${encoded}`, { agent }),
        fetch(`${BINANCE_API}/fapi/v1/premiumIndex?symbol=${encoded}`, { agent }),
      ]);

      if (!priceRes.ok || !oiRes.ok || !fundRes.ok) {
        const statuses = `price:${priceRes.status}, oi:${oiRes.status}, fund:${fundRes.status}`;
        console.warn(`[${symbol}] Proxy attempt ${attempt + 1} failed (${statuses}), trying next proxy...`);
        continue; // try next proxy
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
    } catch (err) {
      console.warn(`[${symbol}] Proxy attempt ${attempt + 1} error: ${err.message}, trying next proxy...`);
    }
  }

  throw new Error(`All proxy attempts failed for ${symbol}`);
}

// ── App ──────────────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(compression());
app.use(express.json());

// ── Health ───────────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => res.json({ ok: true }));

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
         ORDER BY timestamp DESC
         LIMIT $3`,
        [symbol, before, limit]
      );
      rows = result.rows.reverse();
    } else {
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

// ── Periodic fetch job ───────────────────────────────────────────────────────

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

async function runFetchCycle() {
  try {
    const { rows } = await pool.query('SELECT symbol FROM coins');
    console.log(`Fetch cycle started for ${rows.length} coins...`);

    // Sequential to avoid connection/proxy burst
    for (const { symbol } of rows) {
      try {
        const point = await fetchBinanceData(symbol);
        await storePoint(symbol, point);
        console.log(`✓ ${symbol} — price: ${point.price}`);
      } catch (e) {
        console.error(`Failed to fetch/store data for ${symbol}:`, e?.message ?? e);
      }
    }

    const cutoff = Date.now() - RETENTION_MS;
    const { rowCount } = await pool.query(
      'DELETE FROM market_data WHERE timestamp < $1',
      [cutoff]
    );
    if (rowCount > 0) console.log(`Pruned ${rowCount} old market_data rows`);

    console.log('Fetch cycle complete.');
  } catch (e) {
    console.error('Fetch cycle error:', e?.message ?? e);
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────

initSchema()
  .then(() => {
    setTimeout(() => {
      runFetchCycle();
      setInterval(runFetchCycle, 60 * 1000);
    }, 5 * 1000);

    const port = process.env.PORT || 4000;
    app.listen(port, () => {
      console.log(`Server listening on port ${port}`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize database schema — server will NOT start.', err.message ?? err);
    process.exit(1);
  });