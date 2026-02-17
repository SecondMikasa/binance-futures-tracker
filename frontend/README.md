<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Binance Futures Tracker

A lightweight React/Vite dashboard that monitors Binance futures **open interest** and **funding rate** for selected symbols.  Previously the app persisted data in browser IndexedDB, but it now stores all historic values in a PostgreSQL database hosted on Neon.  This allows the history to survive page reloads and device restarts; when you open the website you'll see the complete timeline for each coin.

The repository contains both the frontend (created with Vite) and a minimal Express-based backend that exposes a small REST API.  The backend writes to Neon/Postgres and reads back stored market data.  You can run them locally during development or deploy the backend to any Node‑capable environment.

## Architecture Overview

- **frontend/**: React components under `src/` and services in `services/`.
- **backend/**: simple Express server in `server/index.js` plus schema initialization.
- **database**: Neon Postgres instance; connection via `DATABASE_URL` env var.

## Getting Started (local development)

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Configure environment variables**

   - Copy `.env.example` to `.env` and set `DATABASE_URL` to the connection string provided by Neon (or any Postgres instance).
   - Optionally set `PORT` for the backend (default `4000`).
   - During development the Vite server is configured to proxy `/api` requests to `http://localhost:4000`, so you generally do **not** need to set `VITE_API_BASE`.
     If you're running the frontend and backend on different hosts you can still override it by adding a `.env` or `.env.local` file with:
     ```
     VITE_API_BASE=http://localhost:4000
     ```

3. **Start the backend**

   ```bash
   npm run dev:server   # uses nodemon for automatic restarts
   # or
   npm run start:server # simple node invocation
   ```

   The first run will create the necessary tables (`coins` and `market_data`) automatically.

4. **Start the frontend**

   ```bash
   npm run dev
   ```

   Open `http://localhost:5173` (or whatever port Vite reports).  Add coins, and the history will be persisted in Postgres.

5. **Running in production**

   - Build the frontend with `npm run build` and serve the static assets with any web server.
   - Deploy `server/index.js` to a Node‑enabled host (Heroku, Vercel, etc.) with the same `DATABASE_URL` environment variable.
   - You can configure `VITE_API_BASE` in the frontend to point at the deployed backend.

## Notes

- All numeric values coming from the database are converted to `number` types on the server before being sent to the client, so the UI code does not need to parse strings.
- The backend automatically cleans up market data when a coin is deleted (via `ON DELETE CASCADE`).
- A background polling task runs on the server every minute, reading the list of tracked symbols and fetching the latest price, open interest and funding rate directly from Binance.  This ensures history is recorded **even if the front-end is offline or the website is closed**; when the UI is opened later you will see the complete timeline.  The cycle is now defensive—if the coin row were ever missing the server will re‑create it automatically before inserting data.
- The frontend can also request the server to fetch a fresh data point for a given coin via `POST /api/market-data/fetch`, which is used by the client’s background loop.  This keeps all Binance API logic on the server side.  The server now logs detailed error messages (and returns them in the response body) so you can diagnose 500 errors (e.g. network/time‑out issues or database constraints) by inspecting the server console or the JSON payload returned to the browser.

---

Feel free to customize the database schema, add authentication, or extend the API as needed!