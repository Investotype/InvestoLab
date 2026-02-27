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

Set your backend URL on the page before app scripts run:
```html
<script>
  window.INVESTOLAB_API_BASE = "https://your-backend-domain.com";
</script>
```

Alternative (browser console):
```js
localStorage.setItem('INVESTOLAB_API_BASE', 'https://your-backend-domain.com');
```

Then refresh the page.  
Without API base setup, GitHub Pages will return a JSON error for API calls instead of crashing with `Unexpected token '<'`.

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


