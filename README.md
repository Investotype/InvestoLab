# InvestoLab

Interactive educational web app for (with InvestoType as a core feature):
- portfolio simulation on historical market data
- investor personality quiz
- investor type analysis with a three-axis model
- investment and portfolio valuation using quant + news + social signals

## Quick Start

1. Install dependencies
```bash
npm install
```

2. Start server
```bash
npm start
```

3. Open in browser
`http://localhost:3000`

## Main Pages

- `/` Home
- `/news.html` News (investment of the day)
- `/investotype.html` InvestoType Hub (simulation + quiz + type guide)
- `/valuation-lab.html` Valuation Lab Hub (investment valuation + portfolio builder)
- `/valuation.html` Investment Valuation
- `/portfolio-builder.html` Portfolio Builder
- `/simulator.html` Investment Simulation
- `/quiz.html` Investor Quiz (20 questions)
- `/investor-types.html` Investor Type Guide

## Tech Stack

- Node.js (CommonJS)
- Express
- Static frontend: HTML/CSS/vanilla JavaScript

## Project Structure

- `server.js` Express server + simulation + valuation APIs
- `public/` frontend pages/scripts/styles
- `package.json` scripts + dependencies

## Supported Asset Token Formats

- Market ticker: `AAPL`, `SPY`, `QQQ`, `BTC-USD`
- Bond ETF wrapper: `BOND:TLT`
- Cash: `CASH`
- Savings model: `SAVINGS`
- Leverage model: `LEVERAGE:SPY:2`
- Option-like model: `CALL:AAPL:3`

## Notes

- Uses Yahoo Finance chart endpoints for historical prices.
- Valuation endpoints prefer official APIs (Alpha Vantage + NewsAPI.org) when keys are configured, and fall back to Yahoo-based data otherwise.
- `CALL:*` and `LEVERAGE:*` are simplified educational models.
- This project is for educational use and is not financial advice.

## GitHub Pages + API Setup

If you host only the frontend on GitHub Pages, you still need a backend API host for `/api/*` routes.

Set your backend URL once in:
- `public/config.js`
- `GithubFolder/public/config.js`

Example:
```js
window.INVESTOLAB_API_BASE = window.INVESTOLAB_API_BASE || "https://your-backend-domain.com";
```

Then refresh the page.  
Without API base setup, GitHub Pages will return a JSON error for API calls instead of crashing with `Unexpected token '<'`.

## GitHub Pages Without Live Backend (Static Data Mode)

For News pages, this repo supports static JSON fallback on GitHub Pages:
- `/api/news/market` -> `/data/news-market.json`
- `/api/news/tailored` -> `/data/news-tailored.json`
- `/api/news/investment-of-day?period=*` -> `/data/news-investment-*.json`

How it updates:
- GitHub Action: `.github/workflows/refresh-static-news-data.yml`
- Script: `scripts/refresh-static-news-data.js`
- Output: `public/data/*.json` and `GithubFolder/public/data/*.json`

Optional (for live pulls in the Action):
- Add GitHub secret `STATIC_DATA_SOURCE_URL` (example: `https://investolab.onrender.com`)
- Run workflow manually or wait for schedule (every 6 hours)

## Public API Mode (No Backend)

If `INVESTOLAB_API_BASE` is not set, the frontend now handles many `/api/*` routes directly using public market endpoints (Yahoo Finance) for:
- symbol resolve (`/api/valuation/resolve`, `/api/assets/resolve`)
- spot price (`/api/assets/price`)
- investment valuation (`/api/valuation/investment`)
- portfolio valuation (`/api/valuation/portfolio`)
- InvestoType AI draft (`/api/investotype/portfolio`)
- news pages (`/api/news/*`)
- simulation flows (`/api/simulations/*`, including start/rebalance/trade/timeline/projection/finish/replay/briefing/search`)

This lets GitHub Pages run core valuation/news/investotype flows without deploying your own backend.

## Deploy Backend On Render

This repo includes `render.yaml` for one-click backend deploy.

1. Push this repository to GitHub.
2. In Render, choose **New +** -> **Blueprint**.
3. Select this GitHub repo and deploy.
4. Render will create `investolab-api` and expose a URL like:
   - `https://investolab-api.onrender.com`
5. Verify backend health:
   - `https://investolab-api.onrender.com/api/health`
6. Put that URL into both config files:
   - `public/config.js`
   - `GithubFolder/public/config.js`
7. Commit and push, then hard refresh GitHub Pages.

Optional API keys in Render environment variables:
- `ALPHA_VANTAGE_API_KEY`
- `NEWSAPI_API_KEY`

## Public GitHub Checklist

- Keep `node_modules/` out of version control (`.gitignore` included).
- Do not commit `.env` or secrets.
- Commit `package-lock.json` for reproducible installs.
- Include `README.md` and `LICENSE`.

## Publish To GitHub Now (Public)

1. Install Git (if not installed), then run:
```bash
git init
git add .
git commit -m "Initial public release"
```

2. Create a new **Public** repository on GitHub, then connect and push:
```bash
git branch -M main
git remote add origin https://github.com/<your-username>/<repo-name>.git
git push -u origin main
```

3. Before pushing, ensure these are not tracked:
- `.env`
- `node_modules/`
- local IDE folders (`.vscode/`, `.idea/`)


