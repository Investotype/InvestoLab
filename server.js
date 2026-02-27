const express = require('express');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const DAY_MS = 24 * 60 * 60 * 1000;
const YEAR_MS = 365.25 * DAY_MS;
const FEE_RATE = 0.001; // 0.10% per trade
const SAVINGS_APY = 0.03;
const OPTION_DAILY_DECAY = 0.0006;
const MARKET_FETCH_BACKFILL_DAYS = 7;
const MARKET_FETCH_FORWARD_DAYS = 3;

app.use(express.json());
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use(express.static(path.join(__dirname, 'public')));

const sessions = new Map();
const fxHistoryCache = new Map();
const symbolIntelCache = new Map();
const ALPHA_VANTAGE_API_KEY = String(process.env.ALPHA_VANTAGE_API_KEY || '').trim();
const NEWSAPI_API_KEY = String(process.env.NEWSAPI_API_KEY || '').trim();

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase();
}

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLikelyTicker(input) {
  const raw = String(input || '').trim();
  if (!raw) return false;
  if (/\s/.test(raw)) return false;
  if (/[a-z]/.test(raw)) return false;

  const symbol = normalizeSymbol(raw);
  if (!/^[A-Z0-9^][A-Z0-9.^=\/-]{0,24}$/.test(symbol)) return false;

  // Avoid treating long words like "APPLE" as direct ticker input.
  if (
    symbol.length > 5 &&
    !symbol.includes('.') &&
    !symbol.includes('-') &&
    !symbol.includes('^') &&
    !symbol.includes('=') &&
    !symbol.includes('/')
  ) {
    return false;
  }

  return true;
}

function levenshtein(a, b) {
  const s = normalizeText(a);
  const t = normalizeText(b);
  if (!s) return t.length;
  if (!t) return s.length;

  const dp = Array.from({ length: s.length + 1 }, () => new Array(t.length + 1).fill(0));
  for (let i = 0; i <= s.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= t.length; j += 1) dp[0][j] = j;

  for (let i = 1; i <= s.length; i += 1) {
    for (let j = 1; j <= t.length; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }

  return dp[s.length][t.length];
}

function createCalendarHistory(startDate, endDate, dailyGrowth = 0) {
  const history = [];
  let price = 1;
  let current = startDate;

  while (current <= endDate) {
    history.push({ date: current, close: price, adjClose: price });
    price *= 1 + dailyGrowth;
    current = toIsoDate(new Date(current + 'T00:00:00Z').getTime() + DAY_MS);
  }

  return history;
}

function createTransformedHistory(baseHistory, transformReturnFn) {
  if (!baseHistory.length) return [];

  const transformed = [{ date: baseHistory[0].date, close: 1, adjClose: 1 }];
  let price = 1;

  for (let i = 1; i < baseHistory.length; i += 1) {
    const prev = baseHistory[i - 1].adjClose;
    const next = baseHistory[i].adjClose;
    const baseReturn = prev > 0 ? next / prev - 1 : 0;
    const transformedReturn = transformReturnFn(baseReturn);

    price *= 1 + transformedReturn;
    if (price < 0.0001) price = 0.0001;
    transformed.push({ date: baseHistory[i].date, close: price, adjClose: price });
  }

  return transformed;
}

function parseAssetToken(rawToken) {
  const token = normalizeSymbol(rawToken);
  if (!token) throw new Error('Asset token cannot be empty.');

  if (token === 'CASH') {
    return { id: 'CASH', type: 'cash', label: 'Cash (0% return)' };
  }

  if (token === 'SAVINGS') {
    return { id: 'SAVINGS', type: 'savings', label: `Savings (${(SAVINGS_APY * 100).toFixed(1)}% APY)` };
  }

  if (token.startsWith('BOND:')) {
    const parts = token.split(':');
    if (parts.length !== 2 || !parts[1]) {
      throw new Error('Invalid bond format. Use BOND:TICKER (example: BOND:TLT).');
    }
    return { id: token, type: 'bond', baseSymbol: parts[1], label: `Bond ETF ${parts[1]}` };
  }

  if (token.startsWith('LEVERAGE:')) {
    const parts = token.split(':');
    const multiplier = Number(parts[2]);
    if (parts.length !== 3 || !parts[1] || !Number.isFinite(multiplier)) {
      throw new Error('Invalid leverage format. Use LEVERAGE:TICKER:MULTIPLIER (example: LEVERAGE:SPY:2).');
    }
    if (multiplier <= 1 || multiplier > 5) {
      throw new Error('Leverage multiplier must be > 1 and <= 5.');
    }
    return {
      id: token,
      type: 'leverage',
      baseSymbol: parts[1],
      multiplier,
      label: `${multiplier}x Leverage on ${parts[1]}`
    };
  }

  if (token.startsWith('CALL:')) {
    const parts = token.split(':');
    const multiplier = Number(parts[2]);
    if (parts.length !== 3 || !parts[1] || !Number.isFinite(multiplier)) {
      throw new Error('Invalid option format. Use CALL:TICKER:MULTIPLIER (example: CALL:AAPL:3).');
    }
    if (multiplier <= 1 || multiplier > 8) {
      throw new Error('Option multiplier must be > 1 and <= 8.');
    }
    return {
      id: token,
      type: 'option',
      baseSymbol: parts[1],
      multiplier,
      label: `Call-like ${parts[1]} x${multiplier}`
    };
  }

  if (!/^[A-Z0-9^][A-Z0-9.^=\/-]{0,24}$/.test(token)) {
    throw new Error(`Invalid market ticker token: ${token}`);
  }

  return { id: token, type: 'market', baseSymbol: token, label: token };
}

function toIsoDate(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function isValidDateString(dateString) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) return false;
  const d = new Date(dateString + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && toIsoDate(d) === dateString;
}

function addMonths(dateString, months) {
  const d = new Date(dateString + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + months);
  return toIsoDate(d);
}

function createSchedule(startDate, endDate, frequency) {
  const dates = [];
  let current = startDate;
  const increment = frequency === 'daily' ? 1 : frequency === 'weekly' ? 7 : null;

  while (current <= endDate) {
    dates.push(current);
    if (frequency === 'daily' || frequency === 'weekly') {
      const d = new Date(current + 'T00:00:00Z');
      current = toIsoDate(d.getTime() + increment * DAY_MS);
    } else {
      current = addMonths(current, 1);
    }
  }

  return dates;
}

async function fetchYahooHistoryRaw(symbol, startDate, endDate) {
  const safeSymbol = encodeURIComponent(normalizeSymbol(symbol));
  const startTs =
    Math.floor(new Date(startDate + 'T00:00:00Z').getTime() / 1000) - MARKET_FETCH_BACKFILL_DAYS * 86400;
  const endTs =
    Math.floor(new Date(endDate + 'T23:59:59Z').getTime() / 1000) + MARKET_FETCH_FORWARD_DAYS * 86400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${safeSymbol}?interval=1d&period1=${startTs}&period2=${endTs}&events=div,splits&includeAdjustedClose=true`;

  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 investment-simulator' }
  });

  if (!response.ok) {
    throw new Error(`Yahoo request failed (${response.status}) for ${symbol}`);
  }

  const json = await response.json();
  const result = json?.chart?.result?.[0];
  const err = json?.chart?.error;

  if (err) {
    throw new Error(`Yahoo error for ${symbol}: ${err.description || 'unknown error'}`);
  }
  if (!result || !Array.isArray(result.timestamp)) {
    throw new Error(`No historical data for ${symbol}`);
  }

  const closes = result?.indicators?.quote?.[0]?.close || [];
  const adjusted = result?.indicators?.adjclose?.[0]?.adjclose || [];
  const dividendByDate = {};
  const dividendEvents = result?.events?.dividends || {};
  for (const evt of Object.values(dividendEvents)) {
    const ts = Number(evt?.date);
    const amt = Number(evt?.amount);
    if (!Number.isFinite(ts) || !Number.isFinite(amt)) continue;
    const d = toIsoDate(ts * 1000);
    dividendByDate[d] = (dividendByDate[d] || 0) + amt;
  }

  const history = [];
  for (let i = 0; i < result.timestamp.length; i += 1) {
    const ts = result.timestamp[i];
    const close = closes[i];
    const adjClose = adjusted[i] ?? close;
    if (close == null || adjClose == null) continue;

    history.push({
      date: toIsoDate(ts * 1000),
      close,
      adjClose,
      dividend: Number(dividendByDate[toIsoDate(ts * 1000)] || 0)
    });
  }

  if (history.length === 0) {
    throw new Error(`No valid close prices for ${symbol}`);
  }

  return {
    history: history.sort((a, b) => (a.date < b.date ? -1 : 1)),
    currency: String(result?.meta?.currency || 'USD').toUpperCase()
  };
}

async function getFxHistoryToUsd(currency, startDate, endDate) {
  const cur = String(currency || '').toUpperCase();
  if (!cur || cur === 'USD') return null;

  const cacheKey = `${cur}|${startDate}|${endDate}`;
  if (fxHistoryCache.has(cacheKey)) return fxHistoryCache.get(cacheKey);

  const load = (async () => {
    const direct = `${cur}USD=X`;
    try {
      const directRaw = await fetchYahooHistoryRaw(direct, startDate, endDate);
      if (Array.isArray(directRaw.history) && directRaw.history.length) {
        return { mode: 'direct', history: directRaw.history };
      }
    } catch (_error) {
      // Try inverse below.
    }

    const inverse = `USD${cur}=X`;
    const invRaw = await fetchYahooHistoryRaw(inverse, startDate, endDate);
    if (!Array.isArray(invRaw.history) || !invRaw.history.length) {
      throw new Error(`No FX history for ${cur}/USD`);
    }
    return { mode: 'inverse', history: invRaw.history };
  })();

  fxHistoryCache.set(cacheKey, load);
  return load;
}

async function fetchYahooHistory(symbol, startDate, endDate) {
  const raw = await fetchYahooHistoryRaw(symbol, startDate, endDate);
  const history = raw.history;
  const currency = String(raw.currency || 'USD').toUpperCase();
  if (currency === 'USD') return history;

  let fx = null;
  try {
    fx = await getFxHistoryToUsd(currency, startDate, endDate);
  } catch (_error) {
    throw new Error(`Unable to convert ${symbol} from ${currency} to USD (missing FX data).`);
  }
  if (!fx?.history?.length) {
    throw new Error(`Unable to convert ${symbol} from ${currency} to USD (empty FX history).`);
  }

  const converted = history.map((row) => {
    const p = getPriceOnOrBefore(fx.history, row.date, 'adjClose') || getPriceOnOrAfter(fx.history, row.date, 'adjClose');
    const fxRateRaw = Number(p?.price || 0);
    if (!(fxRateRaw > 0)) {
      throw new Error(`Missing FX rate for ${currency}->USD on ${row.date}`);
    }

    // direct: CURUSD=X is USD per 1 CUR, inverse: USDCUR=X is CUR per 1 USD.
    const fxRate = fx.mode === 'inverse' ? 1 / fxRateRaw : fxRateRaw;
    if (!(fxRate > 0)) {
      throw new Error(`Invalid FX rate for ${currency}->USD on ${row.date}`);
    }
    return {
      ...row,
      close: Number(row.close || 0) * fxRate,
      adjClose: Number(row.adjClose || 0) * fxRate
    };
  });

  return converted;
}

async function searchYahooSymbols(query) {
  const q = String(query || '').trim();
  if (!q) return [];

  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=15&newsCount=0`;
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 investment-simulator' } });
  if (!response.ok) throw new Error(`Symbol search failed (${response.status})`);

  const json = await response.json();
  const quotes = Array.isArray(json?.quotes) ? json.quotes : [];

  return quotes
    .filter((x) => x?.symbol)
    .map((x) => ({
      symbol: normalizeSymbol(x.symbol),
      shortname: x.shortname || '',
      longname: x.longname || '',
      logoUrl: x.logoUrl || x.logourl || '',
      quoteType: x.quoteType || '',
      exchange: x.exchDisp || x.exchange || ''
    }));
}

function getSymbolIntelCache(key, ttlMs) {
  const row = symbolIntelCache.get(key);
  if (!row) return null;
  if (Date.now() - Number(row.ts || 0) > ttlMs) return null;
  return row.value;
}

function setSymbolIntelCache(key, value) {
  symbolIntelCache.set(key, { ts: Date.now(), value });
}

async function fetchAlphaVantageJson(params) {
  if (!ALPHA_VANTAGE_API_KEY) {
    throw new Error('ALPHA_VANTAGE_API_KEY is required for valuation endpoints.');
  }
  const query = new URLSearchParams({ ...params, apikey: ALPHA_VANTAGE_API_KEY });
  const url = `https://www.alphavantage.co/query?${query.toString()}`;
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 investment-simulator' } });
  if (!response.ok) throw new Error(`Alpha Vantage request failed (${response.status}).`);
  const json = await response.json();
  const note = String(json?.Note || '').trim();
  const info = String(json?.Information || '').trim();
  const err = String(json?.['Error Message'] || '').trim();
  if (err) throw new Error(`Alpha Vantage error: ${err}`);
  if (note) throw new Error('Alpha Vantage rate limit reached. Please retry shortly.');
  if (info && info.toLowerCase().includes('invalid api call')) {
    throw new Error(`Alpha Vantage invalid call: ${info}`);
  }
  return json;
}

async function searchAlphaVantageSymbols(query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const cacheKey = `av:search:${q.toLowerCase()}`;
  const cached = getSymbolIntelCache(cacheKey, 10 * 60 * 1000);
  if (cached) return cached;

  const json = await fetchAlphaVantageJson({
    function: 'SYMBOL_SEARCH',
    keywords: q
  });

  const matches = Array.isArray(json?.bestMatches) ? json.bestMatches : [];
  const out = matches
    .map((m) => ({
      symbol: normalizeSymbol(m?.['1. symbol']),
      shortname: String(m?.['2. name'] || '').trim(),
      longname: String(m?.['2. name'] || '').trim(),
      exchange: String(m?.['4. region'] || '').trim(),
      quoteType: String(m?.['3. type'] || '').trim(),
      currency: String(m?.['8. currency'] || '').trim(),
      matchScore: Number(m?.['9. matchScore'] || 0)
    }))
    .filter((x) => x.symbol);

  out.sort((a, b) => {
    const score = (Number(b.matchScore || 0) - Number(a.matchScore || 0));
    if (Math.abs(score) > 1e-9) return score;
    return a.symbol.localeCompare(b.symbol);
  });
  const sliced = out.slice(0, 8);
  setSymbolIntelCache(cacheKey, sliced);
  return sliced;
}

async function fetchAlphaVantageDailyAdjusted(symbol) {
  const sym = normalizeSymbol(symbol);
  if (!sym) throw new Error('symbol is required');
  const cacheKey = `av:daily:${sym}`;
  const cached = getSymbolIntelCache(cacheKey, 20 * 60 * 1000);
  if (cached) return cached;

  const json = await fetchAlphaVantageJson({
    function: 'TIME_SERIES_DAILY_ADJUSTED',
    symbol: sym,
    outputsize: 'full'
  });

  const series = json?.['Time Series (Daily)'];
  if (!series || typeof series !== 'object') {
    throw new Error(`No daily series returned for ${sym} from Alpha Vantage.`);
  }

  const history = Object.entries(series)
    .map(([date, row]) => ({
      date,
      close: Number(row?.['4. close'] || 0),
      adjClose: Number(row?.['5. adjusted close'] || row?.['4. close'] || 0)
    }))
    .filter((x) => isValidDateString(x.date) && x.close > 0 && x.adjClose > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (!history.length) throw new Error(`Empty daily history for ${sym} from Alpha Vantage.`);
  setSymbolIntelCache(cacheKey, history);
  return history;
}

function alphaToIsoDateTime(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  // alpha format: YYYYMMDDThhmmss
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T/);
  if (!m) return '';
  return `${m[1]}-${m[2]}-${m[3]}`;
}

async function fetchAlphaVantageNewsSentiment(symbol, limit = 20) {
  const sym = normalizeSymbol(symbol);
  if (!sym) return [];
  const cacheKey = `av:news:${sym}`;
  const cached = getSymbolIntelCache(cacheKey, 20 * 60 * 1000);
  if (cached) return cached;

  const json = await fetchAlphaVantageJson({
    function: 'NEWS_SENTIMENT',
    tickers: sym,
    limit: String(Math.max(5, Math.min(50, Number(limit || 20))))
  });

  const feed = Array.isArray(json?.feed) ? json.feed : [];
  const out = feed
    .map((item) => {
      const tickerSent = Array.isArray(item?.ticker_sentiment)
        ? item.ticker_sentiment.find((x) => normalizeSymbol(x?.ticker) === sym)
        : null;
      const rawScore = Number(tickerSent?.ticker_sentiment_score ?? item?.overall_sentiment_score ?? NaN);
      const normalized = Number.isFinite(rawScore) ? clamp(rawScore, -1, 1) : null;
      return {
        title: String(item?.title || '').trim(),
        publisher: String(item?.source || '').trim(),
        date: alphaToIsoDateTime(item?.time_published),
        sentimentScore: normalized
      };
    })
    .filter((x) => x.title);

  setSymbolIntelCache(cacheKey, out);
  return out;
}

async function fetchNewsApiHeadlines(symbol, asOfDate, maxItems = 12) {
  const sym = normalizeSymbol(symbol);
  if (!sym || !NEWSAPI_API_KEY) return [];
  const key = `newsapi:${sym}:${asOfDate}`;
  const cached = getSymbolIntelCache(key, 20 * 60 * 1000);
  if (cached) return cached;

  const toDate = isValidDateString(asOfDate) ? asOfDate : toIsoDate(Date.now());
  const fromDate = toIsoDate(new Date(toDate + 'T00:00:00Z').getTime() - 14 * DAY_MS);
  const params = new URLSearchParams({
    q: sym,
    language: 'en',
    sortBy: 'publishedAt',
    pageSize: String(Math.max(5, Math.min(40, Number(maxItems || 12)))),
    from: fromDate,
    to: toDate,
    apiKey: NEWSAPI_API_KEY
  });
  const url = `https://newsapi.org/v2/everything?${params.toString()}`;
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 investment-simulator' } });
  if (!response.ok) return [];
  const json = await response.json();
  const list = Array.isArray(json?.articles) ? json.articles : [];
  const out = list
    .map((a) => ({
      title: String(a?.title || '').trim(),
      publisher: String(a?.source?.name || '').trim(),
      date: String(a?.publishedAt || '').slice(0, 10)
    }))
    .filter((x) => x.title);
  setSymbolIntelCache(key, out);
  return out;
}

async function fetchYahooEarningsDate(symbol) {
  const sym = normalizeSymbol(symbol);
  if (!sym) return null;
  const cacheKey = `earnings:${sym}`;
  const cached = getSymbolIntelCache(cacheKey, 12 * 60 * 60 * 1000);
  if (cached !== null) return cached;

  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=calendarEvents`;
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 investment-simulator' } });
  if (!response.ok) {
    setSymbolIntelCache(cacheKey, null);
    return null;
  }
  const json = await response.json();
  const arr = json?.quoteSummary?.result?.[0]?.calendarEvents?.earnings?.earningsDate;
  const first = Array.isArray(arr) ? arr[0] : null;
  const ts = Number(first?.raw);
  const iso = Number.isFinite(ts) ? toIsoDate(ts * 1000) : null;
  setSymbolIntelCache(cacheKey, iso);
  return iso;
}

async function fetchYahooNewsHeadlines(symbol, maxItems = 3) {
  const sym = normalizeSymbol(symbol);
  if (!sym) return [];
  const cacheKey = `news:${sym}`;
  const cached = getSymbolIntelCache(cacheKey, 30 * 60 * 1000);
  if (cached !== null) return cached;

  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(sym)}&quotesCount=0&newsCount=8`;
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 investment-simulator' } });
  if (!response.ok) {
    setSymbolIntelCache(cacheKey, []);
    return [];
  }
  const json = await response.json();
  const news = Array.isArray(json?.news) ? json.news : [];
  const headlines = news
    .map((n) => ({
      title: String(n?.title || '').trim(),
      publisher: String(n?.publisher || '').trim(),
      date: Number.isFinite(Number(n?.providerPublishTime))
        ? toIsoDate(Number(n.providerPublishTime) * 1000)
        : ''
    }))
    .filter((x) => x.title)
    .slice(0, Math.max(1, Math.min(5, Number(maxItems || 3))));
  setSymbolIntelCache(cacheKey, headlines);
  return headlines;
}

function scoreMatch(query, quote, preferBond = false) {
  const q = normalizeText(query);
  const symbol = normalizeText(quote.symbol);
  const shortname = normalizeText(quote.shortname);
  const longname = normalizeText(quote.longname);
  const combined = `${symbol} ${shortname} ${longname}`.trim();

  let score = 0;
  if (symbol === q) score += 1200;
  if (symbol.startsWith(q)) score += 500;
  if (shortname.startsWith(q) || longname.startsWith(q)) score += 340;
  if (combined.includes(q)) score += 220;
  score -= levenshtein(q, symbol) * 10;

  const qWords = q.split(' ').filter(Boolean);
  const longWords = longname.split(' ').filter(Boolean);
  const shortWords = shortname.split(' ').filter(Boolean);
  const corpSuffixes = new Set(['inc', 'corp', 'corporation', 'co', 'company', 'plc', 'ltd', 'limited']);

  if (qWords.length === 1) {
    if (longWords[0] === qWords[0]) {
      score += corpSuffixes.has(longWords[1]) ? 130 : 25;
    }
    if (shortWords[0] === qWords[0]) {
      score += corpSuffixes.has(shortWords[1]) ? 110 : 20;
    }
  }

  const preferredTypes = new Set(['EQUITY', 'ETF', 'MUTUALFUND', 'INDEX', 'CRYPTOCURRENCY', 'CURRENCY', 'FUTURE']);
  if (preferredTypes.has(String(quote.quoteType || '').toUpperCase())) {
    score += 30;
  }

  const nameForBondCheck = `${shortname} ${longname}`.toLowerCase();
  if (preferBond) {
    if (nameForBondCheck.includes('bond') || nameForBondCheck.includes('treasury') || nameForBondCheck.includes('fixed income')) {
      score += 140;
    }
  }

  return score;
}

async function resolveSymbolFromName(query, options = {}) {
  const preferBond = !!options.preferBond;
  const quotes = await searchYahooSymbols(query);
  if (!quotes.length) {
    throw new Error(`No matching investment found for "${query}".`);
  }

  const ranked = quotes
    .map((q) => ({ ...q, _score: scoreMatch(query, q, preferBond) }))
    .sort((a, b) => b._score - a._score);

  return {
    best: ranked[0],
    matches: ranked.slice(0, 5).map((r) => ({
      symbol: r.symbol,
      shortname: r.shortname,
      longname: r.longname,
      logoUrl: r.logoUrl,
      exchange: r.exchange,
      quoteType: r.quoteType
    }))
  };
}

async function lookupDisplayNameBySymbol(symbol) {
  const sym = normalizeSymbol(symbol);
  if (!sym) return '';
  try {
    const quotes = await searchYahooSymbols(sym);
    const exact = quotes.find((q) => normalizeSymbol(q.symbol) === sym) || quotes[0];
    return String(exact?.longname || exact?.shortname || '').trim();
  } catch (_error) {
    return '';
  }
}

async function enrichAssetMeta(rawMeta) {
  const meta = { ...rawMeta };
  const lookupSymbol = normalizeSymbol(meta.baseSymbol || meta.id || '');

  if (meta.type === 'cash' || meta.type === 'savings') {
    meta.symbol = meta.id;
    meta.displayName = meta.label;
    meta.logoUrl = '';
    return meta;
  }

  meta.symbol = lookupSymbol;
  meta.displayName = meta.label || lookupSymbol;
  meta.logoUrl = '';

  if (!lookupSymbol) return meta;

  try {
    const quotes = await searchYahooSymbols(lookupSymbol);
    const exact = quotes.find((q) => q.symbol === lookupSymbol) || quotes[0];
    if (!exact) return meta;

    const name = exact.longname || exact.shortname || lookupSymbol;
    meta.logoUrl = exact.logoUrl || '';

    if (meta.type === 'market' || meta.type === 'bond') {
      meta.displayName = name;
      meta.label = name;
      return meta;
    }

    meta.displayName = `${meta.label} (${name})`;
  } catch (_error) {
    // Keep fallback metadata when lookup fails.
  }

  return meta;
}

async function fetchAssetHistory(assetToken, startDate, endDate) {
  const parsedMeta = parseAssetToken(assetToken);
  const meta = await enrichAssetMeta(parsedMeta);

  if (meta.type === 'cash') {
    return { meta, history: createCalendarHistory(startDate, endDate, 0) };
  }

  if (meta.type === 'savings') {
    const daily = (1 + SAVINGS_APY) ** (1 / 365) - 1;
    return { meta, history: createCalendarHistory(startDate, endDate, daily) };
  }

  if (meta.type === 'leverage') {
    const baseHistory = await fetchYahooHistory(meta.baseSymbol, startDate, endDate);
    const history = createTransformedHistory(baseHistory, (r) => {
      const leveraged = r * meta.multiplier;
      return Math.max(-0.95, leveraged);
    });
    return { meta, history };
  }

  if (meta.type === 'option') {
    const baseHistory = await fetchYahooHistory(meta.baseSymbol, startDate, endDate);
    const history = createTransformedHistory(baseHistory, (r) => {
      const optionLike = r * meta.multiplier - OPTION_DAILY_DECAY;
      return Math.max(-0.95, Math.min(3, optionLike));
    });
    return { meta, history };
  }

  const history = await fetchYahooHistory(meta.baseSymbol, startDate, endDate);
  return { meta, history };
}

async function validateAssetTokenExists(assetToken) {
  const meta = parseAssetToken(assetToken);
  if (meta.type === 'cash' || meta.type === 'savings') {
    return { meta, ok: true };
  }

  const endDate = toIsoDate(Date.now());
  const startDate = toIsoDate(Date.now() - 90 * DAY_MS);

  // For derived assets, validate by checking base symbol has recent history.
  const baseSymbol = meta.baseSymbol || meta.id;
  await fetchYahooHistory(baseSymbol, startDate, endDate);
  return { meta, ok: true };
}

async function getAssetTokenPriceAtDate(assetToken, targetDate) {
  const token = normalizeSymbol(assetToken);
  if (!token) throw new Error('token is required');
  if (!isValidDateString(targetDate)) throw new Error('date must be YYYY-MM-DD');

  const endMs = new Date(targetDate + 'T00:00:00Z').getTime();
  const startDate = toIsoDate(endMs - 365 * DAY_MS);
  const endDate = toIsoDate(endMs + 2 * DAY_MS);
  const { meta, history } = await fetchAssetHistory(token, startDate, endDate);
  const before = getPriceOnOrBefore(history, targetDate, 'close');
  const after = getPriceOnOrAfter(history, targetDate, 'close');
  const chosen = before || after;
  if (!chosen || !Number.isFinite(chosen.price) || chosen.price <= 0) {
    throw new Error(`No valid price found for ${token} near ${targetDate}`);
  }

  return { meta, date: chosen.date, price: chosen.price };
}

function getPriceOnOrAfter(history, date, field = 'adjClose') {
  for (const row of history) {
    if (row.date >= date) {
      return { date: row.date, price: row[field] };
    }
  }
  return null;
}

function getPriceOnOrBefore(history, date, field = 'adjClose') {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].date <= date) {
      return { date: history[i].date, price: history[i][field] };
    }
  }
  return null;
}

function getNearestPrice(history, date, field = 'adjClose') {
  return getPriceOnOrBefore(history, date, field) || getPriceOnOrAfter(history, date, field);
}

function computeDividendCashBetween(session, fromDateExclusive, toDateInclusive, holdingsOverride = null) {
  if (!session || !fromDateExclusive || !toDateInclusive || fromDateExclusive >= toDateInclusive) return 0;
  const holdings = holdingsOverride || session.holdings || {};
  let total = 0;

  for (const symbol of session.symbols || []) {
    const qty = Number(holdings?.[symbol] || 0);
    if (!(qty > 0)) continue;
    const history = session.histories?.[symbol] || [];
    for (const row of history) {
      if (row.date <= fromDateExclusive || row.date > toDateInclusive) continue;
      const div = Number(row.dividend || 0);
      if (div > 0) total += qty * div;
    }
  }

  return total;
}

function settleDividendsThrough(session, date) {
  if (!session || !date) return 0;
  const from = session.dividendAccruedThrough || session.startDate;
  if (!from || date <= from) {
    session.dividendAccruedThrough = from || date;
    return 0;
  }

  const cash = computeDividendCashBetween(session, from, date);
  if (cash > 0) {
    session.cash += cash;
    session.totalDividendsReceived = Number(session.totalDividendsReceived || 0) + cash;
  }
  session.dividendAccruedThrough = date;
  return cash;
}

function getHistoryReturn(history, fromDate, toDate, field = 'close') {
  const rows = Array.isArray(history) ? history : [];
  if (!rows.length) return null;
  const toPoint = getPriceOnOrBefore(rows, toDate, field);
  const fromPoint = getPriceOnOrBefore(rows, fromDate, field) || getPriceOnOrAfter(rows, fromDate, field);
  if (!toPoint || !fromPoint) return null;
  const start = Number(fromPoint.price || 0);
  const end = Number(toPoint.price || 0);
  if (!(start > 0) || !(end > 0)) return null;
  return end / start - 1;
}

function getDailyReturnAtDate(history, date, field = 'close') {
  const rows = Array.isArray(history) ? history : [];
  if (!rows.length) return null;
  let idx = -1;
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].date <= date) idx = i;
    else break;
  }
  if (idx <= 0) return null;
  const prev = Number(rows[idx - 1]?.[field] || 0);
  const curr = Number(rows[idx]?.[field] || 0);
  if (!(prev > 0) || !(curr > 0)) return null;
  return curr / prev - 1;
}

function getLatestDividendInfo(history, date) {
  const rows = Array.isArray(history) ? history : [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row.date > date) continue;
    const div = Number(row.dividend || 0);
    if (div > 0) return { date: row.date, amount: div };
  }
  return null;
}

function calculateMaxDrawdown(values) {
  let peak = -Infinity;
  let maxDd = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = (peak - v) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd;
}

function stdDev(nums) {
  if (!nums.length) return 0;
  const mean = nums.reduce((s, v) => s + v, 0) / nums.length;
  const variance = nums.reduce((s, v) => s + (v - mean) ** 2, 0) / nums.length;
  return Math.sqrt(variance);
}

function calcAnnualizedVolFromSeries(values) {
  if (values.length < 2) return 0;
  const returns = [];
  for (let i = 1; i < values.length; i += 1) {
    if (values[i - 1] <= 0) continue;
    returns.push(values[i] / values[i - 1] - 1);
  }
  return stdDev(returns) * Math.sqrt(252);
}

function calcCagr(startValue, endValue, startDate, endDate) {
  const years = (new Date(endDate + 'T00:00:00Z') - new Date(startDate + 'T00:00:00Z')) / YEAR_MS;
  if (years <= 0 || startValue <= 0 || endValue <= 0) return 0;
  return (endValue / startValue) ** (1 / years) - 1;
}

function validateWeights(rawWeights, symbols) {
  const weights = {};
  let sum = 0;

  for (const symbol of symbols) {
    const w = Number(rawWeights?.[symbol] ?? 0);
    if (!Number.isFinite(w) || w < 0 || w > 1) {
      throw new Error(`Invalid weight for ${symbol}. Use a value between 0 and 1.`);
    }
    weights[symbol] = w;
    sum += w;
  }

  if (sum > 1.000001) {
    throw new Error('Total weights cannot exceed 1.0');
  }

  return weights;
}

function validateDollars(rawDollars, symbols, portfolioValue) {
  const dollars = {};
  let sum = 0;
  const tolerance = getTargetValueTolerance(symbols?.length || 0);

  for (const symbol of symbols) {
    const v = Number(rawDollars?.[symbol] ?? 0);
    if (!Number.isFinite(v) || v < 0) {
      throw new Error(`Invalid dollar target for ${symbol}. Use a value >= 0.`);
    }
    dollars[symbol] = v;
    sum += v;
  }

  if (sum > portfolioValue + tolerance) {
    throw new Error('Total dollar targets cannot exceed current portfolio value.');
  }

  return dollars;
}

function validateUnits(rawUnits, symbols) {
  const units = {};
  for (const symbol of symbols) {
    const v = Number(rawUnits?.[symbol] ?? 0);
    if (!Number.isFinite(v) || v < 0) {
      throw new Error(`Invalid unit target for ${symbol}. Use a value >= 0.`);
    }
    units[symbol] = v;
  }
  return units;
}

function validateTargetMode(mode) {
  if (!['weight', 'dollars', 'units'].includes(mode)) {
    throw new Error(`Invalid target mode: ${mode}. Use weight, dollars, or units.`);
  }
}

function getTargetValueTolerance(symbolCount = 0, totalValue = 0) {
  // Slack to absorb floating precision/rounding drift.  The previous
  // implementation only scaled with the number of symbols which meant
  // large portfolios could still trigger a "exceeds" error when tiny
  // rounding mismatches (e.g. weight→dollars conversions) pushed the
  // sum above the cap by a few cents.  That annoyed users who had made
  // no intention to change the portfolio and were effectively told they
  // needed to "sell" to rebalance.
  //
  // We now also include a small relative component based on the total
  // value and grow the tolerance appropriately.  A minimum floor still
  // exists for extremely small portfolios.
  const base = Math.max(0.05, Number(symbolCount || 0) * 0.02);
  const relative = Math.abs(Number(totalValue) || 0) * 0.001; // 0.1%
  return Math.max(base, relative);
}

function roundToCents(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function buildTargetValues(session, total, prices, body) {
  const planningBudgetCap = total + Math.max(0, -Number(session.cash || 0));
  // include portfolio total when computing tolerance so large accounts
  // get an appropriately relaxed threshold
  const budgetTolerance = getTargetValueTolerance(session.symbols?.length || 0, planningBudgetCap);
  if (body?.targets && typeof body.targets === 'object') {
    const targetValues = {};
    const requestedInputs = {};
    const perAssetModes = {};
    let totalTargetValue = 0;

    for (const symbol of session.symbols) {
      const entry = body.targets[symbol] || {};
      const mode = String(entry.mode || 'weight').toLowerCase();
      const value = Number(entry.value ?? 0);

      validateTargetMode(mode);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`Invalid target value for ${symbol}. Use a value >= 0.`);
      }

      let targetValue = 0;
      if (mode === 'weight') {
        if (value > 1) {
          throw new Error(`Weight target for ${symbol} must be <= 1.`);
        }
        targetValue = total * value;
      } else if (mode === 'dollars') {
        targetValue = value;
      } else {
        targetValue = value * prices[symbol].price;
      }

      requestedInputs[symbol] = value;
      perAssetModes[symbol] = mode;
      targetValues[symbol] = targetValue;
      totalTargetValue += targetValue;
    }

    const roundedCap = roundToCents(planningBudgetCap);
    let roundedTargetTotal = roundToCents(totalTargetValue);
    if (roundedTargetTotal > roundedCap) {
      // Never hard-fail mixed target submissions for budget overshoot.
      // Price drift and stale UI state (especially on first rebalance)
      // can produce an accidental overage even when the user made no
      // intentional changes. Normalize proportionally instead.
      const scale = roundedCap > 0 ? roundedCap / roundedTargetTotal : 0;
      for (const symbol of session.symbols) {
        const scaled = Math.max(0, Number(targetValues[symbol] || 0) * scale);
        targetValues[symbol] = scaled;
      }
      roundedTargetTotal = roundedCap;
    } else if (roundedTargetTotal > roundedCap - budgetTolerance) {
      // Treat tiny near-cap drift as exactly at cap.
      roundedTargetTotal = Math.min(roundedTargetTotal, roundedCap);
    }
    totalTargetValue = roundedTargetTotal;

    return {
      allocationMode: 'mixed',
      perAssetModes,
      requestedInputs,
      targetValues,
      budgetUsed: totalTargetValue
    };
  }

  if (body?.weights && typeof body.weights === 'object') {
    const weights = validateWeights(body.weights, session.symbols);
    const targetValues = {};
    const perAssetModes = {};
    for (const symbol of session.symbols) {
      targetValues[symbol] = total * weights[symbol];
      perAssetModes[symbol] = 'weight';
    }
    const budgetUsed = Object.values(targetValues).reduce((s, v) => s + v, 0);
    return { allocationMode: 'weight', perAssetModes, requestedInputs: weights, targetValues, budgetUsed };
  }

  if (body?.dollars && typeof body.dollars === 'object') {
    const dollars = validateDollars(body.dollars, session.symbols, planningBudgetCap);
    const perAssetModes = Object.fromEntries(session.symbols.map((symbol) => [symbol, 'dollars']));
    const budgetUsed = Object.values(dollars).reduce((s, v) => s + v, 0);
    return { allocationMode: 'dollars', perAssetModes, requestedInputs: dollars, targetValues: dollars, budgetUsed };
  }

  if (body?.units && typeof body.units === 'object') {
    const units = validateUnits(body.units, session.symbols);
    const targetValues = {};
    for (const symbol of session.symbols) {
      targetValues[symbol] = units[symbol] * prices[symbol].price;
    }

    const sum = Object.values(targetValues).reduce((s, v) => s + v, 0);
    if (sum > planningBudgetCap + budgetTolerance) {
      throw new Error('Total units implied value cannot exceed current portfolio value.');
    }
    const perAssetModes = Object.fromEntries(session.symbols.map((symbol) => [symbol, 'units']));
    return { allocationMode: 'units', perAssetModes, requestedInputs: units, targetValues, budgetUsed: sum };
  }

  throw new Error('Provide target data using targets (per asset), or weights/dollars/units.');
}

function getPortfolioValueAtDate(session, date) {
  const accruedThrough = session.dividendAccruedThrough || session.startDate;
  const pendingDividends = computeDividendCashBetween(session, accruedThrough, date);
  let total = session.cash + pendingDividends;
  const prices = {};

  for (const symbol of session.symbols) {
    const history = session.histories[symbol] || [];
    const p = getPriceOnOrAfter(history, date, 'close') || getPriceOnOrBefore(history, date, 'close');
    if (!p) throw new Error(`No price found for ${symbol} near ${date}`);
    prices[symbol] = p;
    total += session.holdings[symbol] * p.price;
  }

  return { total, prices, pendingDividends };
}

function buildPreviewInsights(session, previewDate, previewData) {
  const preview = previewData || getPortfolioValueAtDate(session, previewDate);
  const lastSnapshot = session.snapshots.length ? session.snapshots[session.snapshots.length - 1] : null;
  const sinceDate = lastSnapshot ? lastSnapshot.date : session.startDate;
  const referenceValue = lastSnapshot ? lastSnapshot.value : session.initialCash;
  const periodReturn = referenceValue > 0 ? preview.total / referenceValue - 1 : 0;

  const holdings = session.symbols
    .map((symbol) => {
      const price = preview.prices[symbol]?.price || 0;
      const quantity = session.holdings[symbol] || 0;
      const costBasis = session.costBasis?.[symbol] || 0;
      const avgBuyPrice = quantity > 0 ? costBasis / quantity : 0;
      const firstBuyPrice = session.firstBuyPrice?.[symbol] || 0;
      const realizedProfit = session.realizedProfit?.[symbol] || 0;
      const value = quantity * price;
      const weight = preview.total > 0 ? value / preview.total : 0;
      return { symbol, quantity, price, value, weight, avgBuyPrice, firstBuyPrice, realizedProfit, closed: false };
    })
    .concat(
      Object.entries(session.closedPositions || {}).map(([symbol, p]) => ({
        symbol,
        quantity: 0,
        price: 0,
        value: 0,
        weight: 0,
        avgBuyPrice: 0,
        firstBuyPrice: Number(p?.firstBuyPrice || 0),
        realizedProfit: Number(p?.realizedProfit || 0),
        closed: true
      }))
    )
    .sort((a, b) => b.value - a.value);

  return {
    date: previewDate,
    sinceDate,
    referenceValue,
    portfolioValue: preview.total,
    periodReturn,
    cash: session.cash,
    holdings
  };
}

function uniqueSortedDates(dates) {
  return [...new Set(dates.filter(Boolean))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function classifyInvestor(metrics) {
  const {
    avgConcentration,
    avgTurnover,
    avgCashRatio,
    annualizedVol,
    maxDrawdown,
    tradeActivity = 0,
    turnoverStd = 0,
    avgTopWeight = 0,
    feeIntensity = 0,
    decisionDrift = 0,
    directionFlipRate = 0
  } = metrics;
  const clamp01 = (n) => Math.max(0, Math.min(1, Number(n || 0)));
  const logisticPct = (raw, mid, steep = 9.5) => {
    const x = Number(raw || 0);
    const p = 1 / (1 + Math.exp(-steep * (x - mid)));
    return Math.max(0, Math.min(100, Math.round(p * 100)));
  };

  const riskRaw =
    annualizedVol * 0.36 +
    maxDrawdown * 0.28 +
    avgConcentration * 0.16 +
    clamp01(avgTopWeight) * 0.12 +
    clamp01(feeIntensity * 12) * 0.06 +
    clamp01(tradeActivity) * 0.1 +
    (1 - clamp01(avgCashRatio)) * 0.07;
  const controlRaw =
    avgTurnover * 0.42 +
    avgConcentration * 0.16 +
    clamp01(avgTopWeight) * 0.16 +
    clamp01(tradeActivity) * 0.2 +
    clamp01(turnoverStd * 1.8) * 0.04 +
    clamp01(decisionDrift * 2.2) * 0.02;
  const reactRaw =
    avgTurnover * 0.34 +
    maxDrawdown * 0.3 +
    annualizedVol * 0.16 +
    clamp01(turnoverStd * 1.9) * 0.14 +
    clamp01(feeIntensity * 12) * 0.04 +
    clamp01(directionFlipRate) * 0.06;

  const aggressivePct = logisticPct(riskRaw, 0.23, 10.5);
  const internalPct = logisticPct(controlRaw, 0.24, 9.5);
  const emotionalPct = logisticPct(reactRaw, 0.22, 10.5);

  const riskAxis = aggressivePct >= 50 ? 'A' : 'C'; // Aggressive / Conservative
  const controlAxis = internalPct >= 50 ? 'I' : 'E'; // Internal(active) / External(passive)
  const emotionAxis = emotionalPct >= 50 ? 'E' : 'R'; // Emotional / Rational
  const code = `${riskAxis}-${controlAxis}-${emotionAxis}`;

  const cube = {
    'A-I-R': {
      type: 'The Quant',
      recommendation:
        'Keep your edge process-driven: use written rules, risk budgets, and periodic model validation to avoid overconfidence.'
    },
    'A-I-E': {
      type: 'Active Conviction Investor',
      recommendation:
        'Strong initiative, but add emotional guardrails: pre-commit exits, cap concentration, and use cooldown windows after big swings.'
    },
    'A-E-R': {
      type: 'Tactical Trend Analyst',
      recommendation:
        'You adapt quickly and stay analytical. Anchor with a core allocation so tactical moves do not dominate long-term outcomes.'
    },
    'A-E-E': {
      type: 'Aggressive Reactive Trader',
      recommendation:
        'High upside mindset with high emotional risk. Enforce strict position sizing, loss limits, and profit-taking rules.'
    },
    'C-I-R': {
      type: 'Conservative Researcher',
      recommendation:
        'Your discipline is a strength. Avoid excessive caution by defining clear conditions for gradually adding risk when trends improve.'
    },
    'C-I-E': {
      type: 'Defensive Active Allocator',
      recommendation:
        'You care about safety but can react to stress. Use automation and preset allocations to reduce decision pressure.'
    },
    'C-E-R': {
      type: 'Passive Rational Allocator',
      recommendation:
        'Excellent long-term temperament. Keep low-cost diversified exposure and rebalance on schedule, not headlines.'
    },
    'C-E-E': {
      type: 'Passive Emotional Allocator',
      recommendation:
        'Simplicity and emotional protection matter most. Prefer hands-off index structures and avoid frequent discretionary trading.'
    }
  };

  const picked = cube[code] || cube['C-E-R'];
  return {
    code,
    type: picked.type,
    axes: {
      risk: riskAxis === 'A' ? 'Aggressive' : 'Conservative',
      control: controlAxis === 'I' ? 'Internal/Active' : 'External/Passive',
      reactivity: emotionAxis === 'R' ? 'Rational' : 'Emotional'
    },
    axisScores: {
      riskAggressive: aggressivePct,
      riskConservative: 100 - aggressivePct,
      controlInternal: internalPct,
      controlExternal: 100 - internalPct,
      reactivityEmotional: emotionalPct,
      reactivityRational: 100 - emotionalPct
    },
    recommendation: picked.recommendation
  };
}

function removeAssetFromSession(session, symbol) {
  const realized = Number(session.realizedProfit?.[symbol] || 0);
  const firstBuy = Number(session.firstBuyPrice?.[symbol] || 0);
  if (!session.closedPositions) session.closedPositions = {};
  session.closedPositions[symbol] = { symbol, firstBuyPrice: firstBuy, realizedProfit: realized };
  session.symbols = session.symbols.filter((s) => s !== symbol);
  delete session.holdings[symbol];
  delete session.costBasis[symbol];
  delete session.firstBuyPrice[symbol];
  delete session.realizedProfit[symbol];
}

function buildDailyTimeline(session, endDate) {
  const startDate = session.startDate;
  const end = endDate && endDate >= startDate ? endDate : session.endDate;
  const timeline = [];
  const eventsByDate = new Map();

  for (const decision of session.decisions || []) {
    if (!decision?.date || decision.date > end) continue;
    const holdings = {};
    for (const symbol of Object.keys(decision.requestedTargets || {})) {
      const history = session.histories[symbol];
      if (!history) continue;
      const p = getNearestPrice(history, decision.date, 'close');
      const px = p?.price || 0;
      holdings[symbol] = px > 0 ? Number(decision.requestedTargets[symbol] || 0) / px : 0;
    }
    eventsByDate.set(decision.date, { cash: Number(decision.cash || 0), holdings });
  }

  const holdingsState = {};
  let cashState = Number(session.initialCash || 0);
  let currentDate = startDate;
  while (currentDate <= end) {
    const event = eventsByDate.get(currentDate);
    if (event) {
      cashState = Number(event.cash || 0);
      for (const [sym, qty] of Object.entries(event.holdings || {})) {
        holdingsState[sym] = Number(qty || 0);
      }
    }

    let value = cashState;
    for (const [sym, qty] of Object.entries(holdingsState)) {
      if (!(qty > 0)) continue;
      const history = session.histories[sym];
      if (!history) continue;
      const p = getPriceOnOrBefore(history, currentDate, 'close');
      if (!p) continue;
      value += qty * p.price;
    }

    timeline.push({ date: currentDate, value });
    const d = new Date(currentDate + 'T00:00:00Z');
    currentDate = toIsoDate(d.getTime() + DAY_MS);
  }

  return timeline;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value || 0)));
}

function computeTrailingReturn(history, endDate, lookbackDays) {
  const safeLookback = Math.max(5, Number(lookbackDays || 30));
  const end = getPriceOnOrBefore(history, endDate, 'adjClose') || getPriceOnOrAfter(history, endDate, 'adjClose');
  if (!end || !(end.price > 0)) return null;
  const lookbackDate = toIsoDate(new Date(endDate + 'T00:00:00Z').getTime() - safeLookback * DAY_MS);
  const start =
    getPriceOnOrBefore(history, lookbackDate, 'adjClose') || getPriceOnOrAfter(history, lookbackDate, 'adjClose');
  if (!start || !(start.price > 0)) return null;
  return end.price / start.price - 1;
}

function buildDailyReturns(history, endDate, maxPoints = 252) {
  const rows = (Array.isArray(history) ? history : []).filter((row) => row.date <= endDate);
  if (rows.length < 3) return [];
  const startIdx = Math.max(1, rows.length - Math.max(5, Number(maxPoints || 252)));
  const out = [];
  for (let i = startIdx; i < rows.length; i += 1) {
    const prev = Number(rows[i - 1]?.adjClose || 0);
    const curr = Number(rows[i]?.adjClose || 0);
    if (!(prev > 0) || !(curr > 0)) continue;
    out.push({ date: rows[i].date, ret: curr / prev - 1 });
  }
  return out;
}

function computeAnnualizedVolatilityFromHistory(history, endDate, maxPoints = 126) {
  const daily = buildDailyReturns(history, endDate, maxPoints).map((x) => x.ret);
  if (daily.length < 5) return null;
  return stdDev(daily) * Math.sqrt(252);
}

function computeMaxDrawdownFromHistory(history, endDate, lookbackDays = 252) {
  const cutoff = toIsoDate(
    new Date(endDate + 'T00:00:00Z').getTime() - Math.max(30, Number(lookbackDays || 252)) * DAY_MS
  );
  const rows = (Array.isArray(history) ? history : []).filter((row) => row.date >= cutoff && row.date <= endDate);
  if (!rows.length) return null;
  const values = rows.map((row) => Number(row.adjClose || 0)).filter((v) => v > 0);
  if (values.length < 3) return null;
  return calculateMaxDrawdown(values);
}

const POSITIVE_SIGNAL_WORDS = [
  'beat',
  'beats',
  'growth',
  'surge',
  'upside',
  'upgrade',
  'buy',
  'bullish',
  'outperform',
  'record',
  'strong',
  'profit',
  'profits',
  'momentum',
  'expansion',
  'rebound',
  'optimistic',
  'partnership'
];

const NEGATIVE_SIGNAL_WORDS = [
  'miss',
  'misses',
  'downgrade',
  'sell',
  'bearish',
  'lawsuit',
  'probe',
  'fraud',
  'decline',
  'drop',
  'fall',
  'weak',
  'cut',
  'cuts',
  'warning',
  'risk',
  'bankruptcy',
  'volatile',
  'investigation',
  'layoff'
];

const SOCIAL_SOURCE_HINTS = [
  'reddit',
  'stocktwits',
  'twitter',
  'x.com',
  'fool',
  'benzinga',
  'seeking alpha',
  'zacks',
  'investorplace'
];

function scoreHeadlineText(text) {
  const clean = normalizeText(text);
  if (!clean) return 0;

  let score = 0;
  for (const word of POSITIVE_SIGNAL_WORDS) {
    if (clean.includes(word)) score += 1;
  }
  for (const word of NEGATIVE_SIGNAL_WORDS) {
    if (clean.includes(word)) score -= 1;
  }
  return clamp(score / 4, -1, 1);
}

function isSocialLikePublisher(publisher, title) {
  const merged = `${String(publisher || '').toLowerCase()} ${String(title || '').toLowerCase()}`;
  return SOCIAL_SOURCE_HINTS.some((hint) => merged.includes(hint));
}

function analyzeNewsAndSocialSignals(headlines) {
  const list = Array.isArray(headlines) ? headlines : [];
  if (!list.length) {
    return {
      newsSentiment: 0,
      socialSentiment: 0,
      confidence: 0,
      socialCoverageRatio: 0,
      breakdown: []
    };
  }

  const scored = list.map((h) => {
    const score = Number.isFinite(Number(h?.sentimentScore))
      ? clamp(Number(h.sentimentScore), -1, 1)
      : scoreHeadlineText(h.title);
    const socialLike = isSocialLikePublisher(h.publisher, h.title);
    return {
      title: h.title,
      publisher: h.publisher,
      date: h.date,
      score,
      socialLike
    };
  });

  const avgAll = scored.reduce((s, x) => s + x.score, 0) / scored.length;
  const social = scored.filter((x) => x.socialLike);
  const socialAvg = social.length ? social.reduce((s, x) => s + x.score, 0) / social.length : avgAll * 0.6;

  return {
    newsSentiment: clamp(avgAll, -1, 1),
    socialSentiment: clamp(socialAvg, -1, 1),
    confidence: clamp(scored.length / 6, 0.15, 1),
    socialCoverageRatio: scored.length ? social.length / scored.length : 0,
    breakdown: scored
  };
}

function labelForValuationScore(score) {
  if (score >= 70) return 'Attractive';
  if (score >= 45) return 'Watchlist';
  return 'Cautious';
}

function buildTradeRecommendation(payload) {
  const composite = Number(payload?.compositeScore || 0);
  const quant = Number(payload?.quantScore || 0);
  const news = Number(payload?.newsSentiment || 0);
  const social = Number(payload?.socialSentiment || 0);
  const vol = Number(payload?.annualizedVolatility || 0);
  const drawdown = Number(payload?.maxDrawdown1Y || 0);
  const momentum90 = Number(payload?.return90 || 0);

  let action = 'HOLD';
  if (composite >= 68 && quant >= 50 && news >= -0.05 && momentum90 >= -0.08) action = 'BUY';
  if (composite <= 40 || (news < -0.2 && quant < 48) || (drawdown > 0.45 && momentum90 < -0.12)) action = 'SELL';

  const strength = Math.abs(composite - 55) / 45;
  const confidence = clamp(0.35 + strength * 0.45 + Math.abs(news + social) * 0.1, 0.35, 0.95);

  const rationale = [
    `Composite valuation score is ${composite.toFixed(0)}/100 with quant ${quant.toFixed(0)}.`,
    `Sentiment blend is news ${(news * 100).toFixed(0)} and social ${(social * 100).toFixed(0)}.`,
    `Risk context: volatility ${(vol * 100).toFixed(1)}%, max drawdown ${(drawdown * 100).toFixed(1)}%.`
  ];

  return {
    action,
    confidence,
    rationale
  };
}

function getInvestorTypeByAxisCode(code) {
  const cube = {
    'A-I-R': 'The Quant',
    'A-I-E': 'Active Conviction Investor',
    'A-E-R': 'Tactical Trend Analyst',
    'A-E-E': 'Aggressive Reactive Trader',
    'C-I-R': 'Conservative Researcher',
    'C-I-E': 'Defensive Active Allocator',
    'C-E-R': 'Passive Rational Allocator',
    'C-E-E': 'Passive Emotional Allocator'
  };
  return cube[code] || 'Passive Rational Allocator';
}

function buildBuyerFitProfile(payload) {
  const ret90 = Number(payload?.return90 || 0);
  const vol = Number(payload?.annualizedVolatility || 0);
  const drawdown = Number(payload?.maxDrawdown1Y || 0);
  const quant = Number(payload?.quantScore || 0);
  const news = Number(payload?.newsSentiment || 0);
  const social = Number(payload?.socialSentiment || 0);
  const confidence = Number(payload?.sentimentConfidence || 0);
  const recommendation = String(payload?.recommendation || 'HOLD').toUpperCase();

  let aggressive = clamp(45 + ret90 * 140 + vol * 45 - drawdown * 38, 0, 100);
  if (recommendation === 'BUY') aggressive = clamp(aggressive + 8, 0, 100);
  if (recommendation === 'SELL') aggressive = clamp(aggressive - 8, 0, 100);

  const internal = clamp(40 + Math.abs(quant - 50) * 0.7 + confidence * 18 + Math.abs(news - social) * 12, 0, 100);
  const emotional = clamp(30 + Math.abs(news + social) * 40 + vol * 35 - confidence * 12, 0, 100);

  const riskAxis = aggressive >= 50 ? 'A' : 'C';
  const controlAxis = internal >= 50 ? 'I' : 'E';
  const reactivityAxis = emotional >= 50 ? 'E' : 'R';
  const code = `${riskAxis}-${controlAxis}-${reactivityAxis}`;

  return {
    code,
    type: getInvestorTypeByAxisCode(code),
    axes: {
      risk: riskAxis === 'A' ? 'Aggressive' : 'Conservative',
      control: controlAxis === 'I' ? 'Internal/Active' : 'External/Passive',
      reactivity: reactivityAxis === 'E' ? 'Emotional' : 'Rational'
    },
    axisScores: {
      riskAggressive: aggressive,
      controlInternal: internal,
      reactivityEmotional: emotional
    },
    why: [
      `Risk fit: ${riskAxis === 'A' ? 'aggressive' : 'conservative'} profile implied by 3M return ${(ret90 * 100).toFixed(1)}%, volatility ${(vol * 100).toFixed(1)}%, drawdown ${(drawdown * 100).toFixed(1)}%.`,
      `Control fit: ${controlAxis === 'I' ? 'internal/active' : 'external/passive'} style implied by model conviction and sentiment consistency.`,
      `Reactivity fit: ${reactivityAxis === 'E' ? 'emotional' : 'rational'} response implied by sentiment intensity versus confidence.`
    ]
  };
}

function buildValuationSummaryLines(payload) {
  const lines = [];
  const score = Number(payload?.score || 0);
  const q = Number(payload?.quant || 0);
  const n = Number(payload?.news || 0);
  const s = Number(payload?.social || 0);
  const vol = Number(payload?.vol || 0);
  const r3 = Number(payload?.r3 || 0);

  lines.push(
    `Composite score ${score.toFixed(0)}/100 (${labelForValuationScore(score)}): quant ${q.toFixed(
      0
    )}, news ${(n * 100).toFixed(0)}, social ${(s * 100).toFixed(0)}.`
  );
  lines.push(
    `Market signal shows ${r3 >= 0 ? 'positive' : 'negative'} 3-month momentum (${(r3 * 100).toFixed(
      1
    )}%) with annualized volatility near ${(vol * 100).toFixed(1)}%.`
  );
  lines.push(
    'Use this as a decision aid, then validate with your risk profile and portfolio concentration limits before acting.'
  );

  return lines;
}

async function resolveInvestmentInput(rawInput) {
  const query = String(rawInput || '').trim();
  if (!query) throw new Error('query is required');

  if (isLikelyTicker(query)) {
    const symbol = normalizeSymbol(query);
    const displayName = (await lookupDisplayNameBySymbol(symbol)) || symbol;
    return { symbol, displayName, resolvedFrom: 'ticker' };
  }

  if (ALPHA_VANTAGE_API_KEY) {
    const officialMatches = await searchAlphaVantageSymbols(query);
    const best = officialMatches[0] || null;
    if (!best?.symbol) throw new Error(`No matching symbol found for "${query}".`);
    const symbol = normalizeSymbol(best.symbol);
    const displayName = String(best.longname || best.shortname || symbol).trim();
    return { symbol, displayName, resolvedFrom: 'alpha_vantage_search' };
  }

  const resolved = await resolveSymbolFromName(query, { preferBond: false });
  const best = resolved?.best || {};
  const symbol = normalizeSymbol(best.symbol);
  if (!symbol) throw new Error(`No matching symbol found for "${query}".`);
  const displayName = String(best.longname || best.shortname || symbol).trim();
  return { symbol, displayName, resolvedFrom: 'yahoo_fallback_search' };
}

async function buildSingleInvestmentValuation(input, options = {}) {
  const asOfDate = isValidDateString(options.asOfDate) ? options.asOfDate : toIsoDate(Date.now());
  const resolved = await resolveInvestmentInput(input);
  const useOfficial = !!ALPHA_VANTAGE_API_KEY;
  const history = useOfficial
    ? await fetchAlphaVantageDailyAdjusted(resolved.symbol)
    : await fetchYahooHistory(
        resolved.symbol,
        toIsoDate(new Date(asOfDate + 'T00:00:00Z').getTime() - 500 * DAY_MS),
        asOfDate
      );
  const pricePoint = getPriceOnOrBefore(history, asOfDate, 'close') || getPriceOnOrAfter(history, asOfDate, 'close');
  if (!pricePoint || !(pricePoint.price > 0)) {
    throw new Error(`No price data available for ${resolved.symbol} near ${asOfDate}.`);
  }

  const ret1m = computeTrailingReturn(history, asOfDate, 30);
  const ret3m = computeTrailingReturn(history, asOfDate, 90);
  const ret1y = computeTrailingReturn(history, asOfDate, 252);
  const vol = computeAnnualizedVolatilityFromHistory(history, asOfDate, 126) || 0;
  const drawdown = computeMaxDrawdownFromHistory(history, asOfDate, 252) || 0;
  const [headlinesNewsApi, headlinesAlpha, headlinesYahooFallback, earningsDateFallback] = await Promise.all([
    fetchNewsApiHeadlines(resolved.symbol, asOfDate, 12),
    useOfficial ? fetchAlphaVantageNewsSentiment(resolved.symbol, 20) : Promise.resolve([]),
    useOfficial ? Promise.resolve([]) : fetchYahooNewsHeadlines(resolved.symbol, 8),
    useOfficial ? Promise.resolve(null) : fetchYahooEarningsDate(resolved.symbol)
  ]);
  const mergedHeadlines = [...headlinesNewsApi, ...headlinesAlpha]
    .concat(headlinesYahooFallback || [])
    .filter((x) => x?.title)
    .slice(0, 20);

  const signals = analyzeNewsAndSocialSignals(mergedHeadlines);
  const momentumBoost = (ret1m || 0) * 40 + (ret3m || 0) * 120 + (ret1y || 0) * 80;
  const riskPenalty = clamp(vol / 0.6, 0, 1) * 20 + clamp(drawdown / 0.55, 0, 1) * 15;
  const quantScore = clamp(50 + momentumBoost - riskPenalty, 0, 100);
  const newsScore = (signals.newsSentiment + 1) * 50;
  const socialScore = (signals.socialSentiment + 1) * 50;
  const compositeScore = clamp(quantScore * 0.6 + newsScore * 0.25 + socialScore * 0.15, 0, 100);
  const recommendation = buildTradeRecommendation({
    compositeScore,
    quantScore,
    newsSentiment: signals.newsSentiment,
    socialSentiment: signals.socialSentiment,
    annualizedVolatility: vol,
    maxDrawdown1Y: drawdown,
    return90: ret3m
  });
  const buyerFit = buildBuyerFitProfile({
    return90: ret3m,
    annualizedVolatility: vol,
    maxDrawdown1Y: drawdown,
    quantScore,
    newsSentiment: signals.newsSentiment,
    socialSentiment: signals.socialSentiment,
    sentimentConfidence: signals.confidence,
    recommendation: recommendation.action
  });

  const summary3 = buildValuationSummaryLines({
    score: compositeScore,
    quant: quantScore,
    news: signals.newsSentiment,
    social: signals.socialSentiment,
    vol,
    r3: ret3m || 0
  });
  const sixMonthStart = toIsoDate(new Date(asOfDate + 'T00:00:00Z').getTime() - 183 * DAY_MS);
  const threeYearStart = toIsoDate(new Date(asOfDate + 'T00:00:00Z').getTime() - 1095 * DAY_MS);
  const priceHistory = (Array.isArray(history) ? history : [])
    .filter((row) => row && row.date >= threeYearStart && row.date <= asOfDate)
    .map((row) => ({
      date: row.date,
      close: Number(row.close || 0)
    }))
    .filter((row) => row.close > 0);
  const priceHistory6M = (Array.isArray(history) ? history : [])
    .filter((row) => row && row.date >= sixMonthStart && row.date <= asOfDate)
    .map((row) => ({
      date: row.date,
      close: Number(row.close || 0)
    }))
    .filter((row) => row.close > 0);

  return {
    symbol: resolved.symbol,
    displayName: resolved.displayName || resolved.symbol,
    resolvedFrom: resolved.resolvedFrom,
    asOfDate,
    market: {
      price: Number(pricePoint.price || 0),
      priceDate: pricePoint.date,
      trailingReturns: {
        d30: ret1m,
        d90: ret3m,
        d252: ret1y
      },
      priceHistory,
      priceHistory6M,
      annualizedVolatility: vol,
      maxDrawdown1Y: drawdown
    },
    signals: {
      newsSentiment: signals.newsSentiment,
      socialSentiment: signals.socialSentiment,
      sentimentConfidence: signals.confidence,
      socialCoverageRatio: signals.socialCoverageRatio,
      earningsDate: earningsDateFallback,
      headlines: mergedHeadlines.slice(0, 8),
      source: useOfficial ? (NEWSAPI_API_KEY ? 'NewsAPI + Alpha Vantage' : 'Alpha Vantage') : 'Yahoo fallback'
    },
    valuation: {
      quantScore,
      compositeScore,
      label: labelForValuationScore(compositeScore),
      summary3,
      recommendation,
      buyerFit
    }
  };
}

function inferRiskLevelByVol(annualizedVolatility) {
  const v = Number(annualizedVolatility || 0);
  if (v < 0.14) return 'Low';
  if (v < 0.25) return 'Moderate';
  if (v < 0.38) return 'High';
  return 'Very High';
}

function buildPortfolioGuidance(profile, volatility, diversification, topHolding) {
  const investorType = String(profile || 'balanced').toLowerCase();
  const recs = [];

  if (investorType === 'conservative' && volatility > 0.18) {
    recs.push('Portfolio risk is above conservative range. Consider reducing high-volatility exposure and adding defensive assets.');
  }
  if (investorType === 'aggressive' && volatility < 0.14) {
    recs.push('Risk is currently low for an aggressive style. You may be under-utilizing risk budget.');
  }
  if (diversification < 45) {
    recs.push('Diversification is weak. Spread exposure across more uncorrelated assets to reduce concentration risk.');
  }
  if (topHolding && topHolding.weight > 0.4) {
    recs.push(`${topHolding.symbol} is concentrated at ${(topHolding.weight * 100).toFixed(1)}%. Set a max position rule.`);
  }
  if (!recs.length) {
    recs.push('Portfolio structure is balanced for the selected profile. Keep monitoring news and sentiment drift.');
  }
  return recs;
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, now: new Date().toISOString() });
});

app.post('/api/assets/validate', async (req, res) => {
  try {
    const token = normalizeSymbol(req.body?.token);
    if (!token) return res.status(400).json({ error: 'token is required' });

    const result = await validateAssetTokenExists(token);
    res.json({
      ok: true,
      asset: {
        id: result.meta.id,
        type: result.meta.type,
        label: result.meta.label
      }
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/assets/price', async (req, res) => {
  try {
    const token = normalizeSymbol(req.body?.token);
    const date = String(req.body?.date || toIsoDate(Date.now()));
    if (!token) return res.status(400).json({ error: 'token is required' });
    if (!isValidDateString(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });

    const result = await getAssetTokenPriceAtDate(token, date);
    res.json({
      ok: true,
      asset: {
        id: result.meta.id,
        type: result.meta.type,
        label: result.meta.label
      },
      date: result.date,
      price: Number(result.price || 0)
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/assets/resolve', async (req, res) => {
  try {
    const query = String(req.body?.query || '').trim();
    const preferBond = !!req.body?.preferBond;
    if (!query) return res.status(400).json({ error: 'query is required' });

    if (isLikelyTicker(query)) {
      return res.json({
        ok: true,
        best: {
          symbol: normalizeSymbol(query),
          shortname: '',
          longname: '',
          logoUrl: '',
          exchange: '',
          quoteType: ''
        },
        matches: []
      });
    }

    const result = await resolveSymbolFromName(query, { preferBond });
    res.json({
      ok: true,
      best: {
        symbol: result.best.symbol,
        shortname: result.best.shortname,
        longname: result.best.longname,
        logoUrl: result.best.logoUrl || '',
        exchange: result.best.exchange,
        quoteType: result.best.quoteType
      },
      matches: result.matches
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/valuation/investment', async (req, res) => {
  try {
    const query = String(req.body?.query || '').trim();
    const asOfDate = String(req.body?.asOfDate || '').trim();
    if (!query) return res.status(400).json({ error: 'query is required' });

    const valuation = await buildSingleInvestmentValuation(query, { asOfDate });
    res.json({
      ok: true,
      investment: valuation
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/valuation/resolve', async (req, res) => {
  try {
    const query = String(req.body?.query || '').trim();
    if (!query) return res.status(400).json({ error: 'query is required' });

    if (isLikelyTicker(query)) {
      return res.json({
        ok: true,
        best: {
          symbol: normalizeSymbol(query),
          shortname: '',
          longname: '',
          exchange: '',
          quoteType: ''
        },
        matches: []
      });
    }

    if (ALPHA_VANTAGE_API_KEY) {
      const matches = await searchAlphaVantageSymbols(query);
      const best = matches[0] || null;
      if (!best?.symbol) return res.status(400).json({ error: `No matching symbol found for "${query}".` });

      return res.json({
        ok: true,
        best: {
          symbol: best.symbol,
          shortname: best.shortname || '',
          longname: best.longname || '',
          exchange: best.exchange || '',
          quoteType: best.quoteType || ''
        },
        matches: matches.map((m) => ({
          symbol: m.symbol,
          shortname: m.shortname || '',
          longname: m.longname || '',
          exchange: m.exchange || '',
          quoteType: m.quoteType || ''
        }))
      });
    }

    const fallback = await resolveSymbolFromName(query, { preferBond: false });
    return res.json({
      ok: true,
      best: {
        symbol: fallback.best.symbol,
        shortname: fallback.best.shortname,
        longname: fallback.best.longname,
        exchange: fallback.best.exchange,
        quoteType: fallback.best.quoteType
      },
      matches: fallback.matches
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/valuation/portfolio', async (req, res) => {
  try {
    const profile = String(req.body?.profile || 'balanced').trim().toLowerCase();
    const asOfDate = isValidDateString(req.body?.asOfDate) ? String(req.body.asOfDate) : toIsoDate(Date.now());
    const rawHoldings = Array.isArray(req.body?.holdings) ? req.body.holdings : [];
    if (!rawHoldings.length) return res.status(400).json({ error: 'holdings are required' });

    const parsed = rawHoldings
      .map((row) => ({
        query: String(row?.query || row?.symbol || '').trim(),
        mode: String(row?.mode || 'dollars').toLowerCase(),
        value: Number(row?.value ?? row?.amount ?? row?.dollars ?? row?.units ?? 0)
      }))
      .filter((row) => row.query);

    if (!parsed.length) return res.status(400).json({ error: 'Provide at least one valid holding query/symbol.' });
    if (parsed.length > 12) return res.status(400).json({ error: 'Use up to 12 holdings per request.' });

    const perAsset = [];
    for (const row of parsed) {
      if (!['dollars', 'units'].includes(row.mode)) {
        throw new Error(`Invalid mode "${row.mode}". Use dollars or units.`);
      }
      if (!Number.isFinite(row.value) || row.value <= 0) {
        throw new Error(`Invalid value for "${row.query}". Use a positive number.`);
      }

      const valuation = await buildSingleInvestmentValuation(row.query, { asOfDate });
      const price = Number(valuation?.market?.price || 0);
      if (!(price > 0)) throw new Error(`Unable to derive market price for ${valuation.symbol}.`);

      const units = row.mode === 'units' ? row.value : row.value / price;
      const marketValue = units * price;
      perAsset.push({
        input: row.query,
        symbol: valuation.symbol,
        displayName: valuation.displayName,
        mode: row.mode,
        valueInput: row.value,
        units,
        marketValue,
        price,
        valuation
      });
    }

    const totalValue = perAsset.reduce((s, a) => s + Number(a.marketValue || 0), 0);
    if (!(totalValue > 0)) return res.status(400).json({ error: 'Portfolio total value must be greater than 0.' });

    const assets = perAsset.map((a) => {
      const weight = a.marketValue / totalValue;
      return {
        symbol: a.symbol,
        displayName: a.displayName,
        price: a.price,
        units: a.units,
        marketValue: a.marketValue,
        weight,
        trailingReturns: a.valuation.market.trailingReturns,
        annualizedVolatility: a.valuation.market.annualizedVolatility,
        sentiment: {
          news: a.valuation.signals.newsSentiment,
          social: a.valuation.signals.socialSentiment,
          confidence: a.valuation.signals.sentimentConfidence
        },
        compositeScore: a.valuation.valuation.compositeScore,
        label: a.valuation.valuation.label,
        recommendation: a.valuation.valuation.recommendation,
        summary3: a.valuation.valuation.summary3
      };
    });

    const hhi = assets.reduce((s, a) => s + a.weight ** 2, 0);
    const n = assets.length;
    const diversificationScore =
      n > 1 ? clamp(((1 - hhi) / (1 - 1 / n)) * 100, 0, 100) : 0;

    const portfolioDailyByDate = new Map();
    for (const asset of perAsset) {
      const weight = asset.marketValue / totalValue;
      const officialHistory = ALPHA_VANTAGE_API_KEY
        ? await fetchAlphaVantageDailyAdjusted(asset.symbol)
        : await fetchYahooHistory(
            asset.symbol,
            toIsoDate(new Date(asOfDate + 'T00:00:00Z').getTime() - 220 * DAY_MS),
            asOfDate
          );
      const returns = buildDailyReturns(
        officialHistory,
        asOfDate,
        120
      );
      for (const point of returns) {
        const row = portfolioDailyByDate.get(point.date) || { weightedSum: 0, weightSum: 0 };
        row.weightedSum += point.ret * weight;
        row.weightSum += weight;
        portfolioDailyByDate.set(point.date, row);
      }
    }

    const portfolioDaily = [...portfolioDailyByDate.values()]
      .filter((x) => x.weightSum > 0)
      .map((x) => x.weightedSum / x.weightSum);
    const portfolioVol = portfolioDaily.length >= 5 ? stdDev(portfolioDaily) * Math.sqrt(252) : 0;
    const weightedScore = assets.reduce((s, a) => s + a.compositeScore * a.weight, 0);
    const weightedNews = assets.reduce((s, a) => s + a.sentiment.news * a.weight, 0);
    const weightedSocial = assets.reduce((s, a) => s + a.sentiment.social * a.weight, 0);
    const concentrationPenalty = clamp((hhi - 0.2) * 120, 0, 18);
    const portfolioComposite = clamp(weightedScore - concentrationPenalty, 0, 100);
    const buyWeight = assets.reduce((s, a) => s + (a.recommendation?.action === 'BUY' ? a.weight : 0), 0);
    const sellWeight = assets.reduce((s, a) => s + (a.recommendation?.action === 'SELL' ? a.weight : 0), 0);

    const topHolding = [...assets].sort((a, b) => b.weight - a.weight)[0] || null;
    const guidance = buildPortfolioGuidance(profile, portfolioVol, diversificationScore, topHolding);
    if (sellWeight > 0.45) {
      guidance.unshift(
        `More than ${(sellWeight * 100).toFixed(1)}% of portfolio weight is currently flagged SELL by the model.`
      );
    } else if (buyWeight > 0.55) {
      guidance.unshift(
        `${(buyWeight * 100).toFixed(1)}% of portfolio weight is currently flagged BUY by the model.`
      );
    }

    res.json({
      ok: true,
      asOfDate,
      profile,
      portfolio: {
        totalValue,
        assetCount: assets.length,
        annualizedVolatility: portfolioVol,
        riskLevel: inferRiskLevelByVol(portfolioVol),
        diversificationScore,
        valuationScore: portfolioComposite,
        valuationLabel: labelForValuationScore(portfolioComposite),
        weightedNewsSentiment: weightedNews,
        weightedSocialSentiment: weightedSocial
      },
      assets,
      guidance
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

const MARKET_NEWS_SYMBOLS = ['SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'TLT', 'GLD'];
const TAILORED_NEWS_PROFILES = {
  the_quant: {
    key: 'the_quant',
    label: 'The Quant',
    symbols: ['QQQ', 'NVDA', 'MSFT', 'AVGO', 'AMD', 'SMH']
  },
  active_conviction_investor: {
    key: 'active_conviction_investor',
    label: 'Active Conviction Investor',
    symbols: ['TSLA', 'NVDA', 'META', 'AMZN', 'PLTR', 'SOXL']
  },
  tactical_trend_analyst: {
    key: 'tactical_trend_analyst',
    label: 'Tactical Trend Analyst',
    symbols: ['QQQ', 'SPY', 'XLF', 'XLE', 'GLD', 'IWM']
  },
  aggressive_reactive_trader: {
    key: 'aggressive_reactive_trader',
    label: 'Aggressive Reactive Trader',
    symbols: ['TSLA', 'COIN', 'MSTR', 'SOXL', 'TQQQ', 'BTC-USD']
  },
  conservative_researcher: {
    key: 'conservative_researcher',
    label: 'Conservative Researcher',
    symbols: ['JNJ', 'PG', 'KO', 'XOM', 'JPM', 'VIG']
  },
  defensive_active_allocator: {
    key: 'defensive_active_allocator',
    label: 'Defensive Active Allocator',
    symbols: ['VTI', 'SCHD', 'BND', 'TIP', 'XLV', 'XLP']
  },
  passive_rational_allocator: {
    key: 'passive_rational_allocator',
    label: 'Passive Rational Allocator',
    symbols: ['VTI', 'VOO', 'VXUS', 'BND', 'SCHD', 'VNQ']
  },
  passive_emotional_allocator: {
    key: 'passive_emotional_allocator',
    label: 'Passive Emotional Allocator',
    symbols: ['VTI', 'BND', 'AGG', 'SCHD', 'XLU', 'SHV']
  }
};

const AXIS_CODE_TO_PROFILE_KEY = {
  'A-I-R': 'the_quant',
  'A-I-E': 'active_conviction_investor',
  'A-E-R': 'tactical_trend_analyst',
  'A-E-E': 'aggressive_reactive_trader',
  'C-I-R': 'conservative_researcher',
  'C-I-E': 'defensive_active_allocator',
  'C-E-R': 'passive_rational_allocator',
  'C-E-E': 'passive_emotional_allocator'
};

const PROFILE_DEFAULT_AXIS_SCORES = {
  the_quant: { riskAggressive: 74, controlInternal: 76, reactivityEmotional: 30 },
  active_conviction_investor: { riskAggressive: 82, controlInternal: 74, reactivityEmotional: 72 },
  tactical_trend_analyst: { riskAggressive: 78, controlInternal: 36, reactivityEmotional: 32 },
  aggressive_reactive_trader: { riskAggressive: 86, controlInternal: 34, reactivityEmotional: 78 },
  conservative_researcher: { riskAggressive: 26, controlInternal: 74, reactivityEmotional: 26 },
  defensive_active_allocator: { riskAggressive: 28, controlInternal: 72, reactivityEmotional: 74 },
  passive_rational_allocator: { riskAggressive: 24, controlInternal: 30, reactivityEmotional: 24 },
  passive_emotional_allocator: { riskAggressive: 22, controlInternal: 28, reactivityEmotional: 72 }
};

function normalizeInvestorTypeKey(rawType) {
  const raw = String(rawType || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!raw) return 'passive_rational_allocator';
  return TAILORED_NEWS_PROFILES[raw] ? raw : 'passive_rational_allocator';
}

function resolveInvestorTypeKey(rawType) {
  const normalized = String(rawType || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!normalized) return null;
  if (TAILORED_NEWS_PROFILES[normalized]) return normalized;
  for (const [key, profile] of Object.entries(TAILORED_NEWS_PROFILES)) {
    const label = String(profile?.label || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (label === normalized) return key;
  }
  return null;
}

function finalizePctList(rows) {
  const clean = rows
    .map((row) => ({
      ...row,
      weight: Math.max(0, Number(row?.weight || 0))
    }))
    .filter((row) => row.weight > 0.01);
  const rounded = clean.map((row) => ({ ...row, weight: Math.round(row.weight * 10) / 10 }));
  const total = rounded.reduce((sum, row) => sum + row.weight, 0);
  const diff = Math.round((100 - total) * 10) / 10;
  if (rounded.length && Math.abs(diff) > 0.01) {
    let maxIdx = 0;
    for (let i = 1; i < rounded.length; i += 1) {
      if (rounded[i].weight > rounded[maxIdx].weight) maxIdx = i;
    }
    rounded[maxIdx].weight = Math.max(0, Math.round((rounded[maxIdx].weight + diff) * 10) / 10);
  }
  return rounded;
}

function buildInvestoTypePortfolioDraft({ typeKey, axisScores }) {
  const profile = TAILORED_NEWS_PROFILES[typeKey] || TAILORED_NEWS_PROFILES.passive_rational_allocator;
  const risk = clamp(Number(axisScores?.riskAggressive || 50), 0, 100);
  const control = clamp(Number(axisScores?.controlInternal || 50), 0, 100);
  const emotional = clamp(Number(axisScores?.reactivityEmotional || 50), 0, 100);
  const rational = 100 - emotional;

  const usEquity = clamp(24 + risk * 0.5 + control * 0.06 - emotional * 0.05, 18, 78);
  const intlEquity = clamp(7 + (100 - risk) * 0.08 + rational * 0.05, 6, 22);
  const alternatives = clamp(2 + risk * 0.09 + emotional * 0.03, 2, 16);
  const cash = clamp(2 + (100 - risk) * 0.12 + emotional * 0.06 + (100 - control) * 0.03, 2, 22);
  const bonds = Math.max(6, 100 - usEquity - intlEquity - alternatives - cash);

  const allocation = finalizePctList([
    { bucket: 'US Equity', weight: usEquity },
    { bucket: 'International Equity', weight: intlEquity },
    { bucket: 'Bonds', weight: bonds },
    { bucket: 'Alternatives', weight: alternatives },
    { bucket: 'Cash', weight: cash }
  ]);

  const basket = [];
  const symbols = Array.isArray(profile.symbols) ? profile.symbols : [];
  const first = symbols[0] || 'SPY';
  const second = symbols[1] || 'QQQ';
  const third = symbols[2] || 'VTI';
  const altSymbol = risk >= 65 ? 'BTC-USD' : 'GLD';
  const bondSymbol = risk >= 60 ? 'BND' : 'AGG';
  const cashSymbol = 'SHV';

  const usRow = allocation.find((x) => x.bucket === 'US Equity');
  const intlRow = allocation.find((x) => x.bucket === 'International Equity');
  const bondsRow = allocation.find((x) => x.bucket === 'Bonds');
  const altRow = allocation.find((x) => x.bucket === 'Alternatives');
  const cashRow = allocation.find((x) => x.bucket === 'Cash');

  const usWeight = Number(usRow?.weight || 0);
  const usSplitA = usWeight * 0.46;
  const usSplitB = usWeight * 0.32;
  const usSplitC = Math.max(0, usWeight - usSplitA - usSplitB);

  basket.push({ symbol: first, role: 'US Core', weight: usSplitA });
  basket.push({ symbol: second, role: 'US Growth/Tactical', weight: usSplitB });
  basket.push({ symbol: third, role: 'US Satellite', weight: usSplitC });
  basket.push({ symbol: 'VXUS', role: 'International Diversifier', weight: Number(intlRow?.weight || 0) });
  basket.push({ symbol: bondSymbol, role: 'Bond Buffer', weight: Number(bondsRow?.weight || 0) });
  basket.push({ symbol: altSymbol, role: 'Alternative Hedge', weight: Number(altRow?.weight || 0) });
  basket.push({ symbol: cashSymbol, role: 'Liquidity Reserve', weight: Number(cashRow?.weight || 0) });

  const tickerMix = finalizePctList(basket);
  const riskStyle = risk >= 50 ? 'aggressive' : 'conservative';
  const controlStyle = control >= 50 ? 'active-control' : 'system-led';
  const reactStyle = emotional >= 50 ? 'emotion-sensitive' : 'process-stable';
  const withArticle = (word) => (/^[aeiou]/i.test(String(word)) ? `an ${word}` : `a ${word}`);
  const rationale = [
    `Risk axis (${risk.toFixed(0)}%) implies ${withArticle(riskStyle)} allocation stance.`,
    `Control axis (${control.toFixed(0)}%) favors ${withArticle(controlStyle)} construction.`,
    `Reactivity axis (${emotional.toFixed(0)}%) indicates ${withArticle(reactStyle)} behavior profile.`,
    'This AI draft is a starting portfolio template, not investment advice. Rebalance monthly and keep single-position limits in place.'
  ];

  return {
    profile,
    axisScores: {
      riskAggressive: Math.round(risk * 10) / 10,
      controlInternal: Math.round(control * 10) / 10,
      reactivityEmotional: Math.round(emotional * 10) / 10
    },
    allocation,
    tickerMix,
    rationale
  };
}

app.post('/api/investotype/portfolio', (req, res) => {
  try {
    const rawType = req.body?.investorType;
    const bodyAxis = req.body?.axisScores || {};
    const riskRaw = Number(bodyAxis?.riskAggressive);
    const controlRaw = Number(bodyAxis?.controlInternal);
    const reactRaw = Number(bodyAxis?.reactivityEmotional);
    const hasAxisInput = Number.isFinite(riskRaw) || Number.isFinite(controlRaw) || Number.isFinite(reactRaw);

    let typeKey = resolveInvestorTypeKey(rawType);
    let axisScores;

    if (hasAxisInput) {
      axisScores = {
        riskAggressive: clamp(Number.isFinite(riskRaw) ? riskRaw : 50, 0, 100),
        controlInternal: clamp(Number.isFinite(controlRaw) ? controlRaw : 50, 0, 100),
        reactivityEmotional: clamp(Number.isFinite(reactRaw) ? reactRaw : 50, 0, 100)
      };
      const code =
        (axisScores.riskAggressive >= 50 ? 'A' : 'C') +
        '-' +
        (axisScores.controlInternal >= 50 ? 'I' : 'E') +
        '-' +
        (axisScores.reactivityEmotional >= 50 ? 'E' : 'R');
      typeKey = AXIS_CODE_TO_PROFILE_KEY[code] || typeKey || 'passive_rational_allocator';
    } else {
      typeKey = typeKey || 'passive_rational_allocator';
      axisScores = PROFILE_DEFAULT_AXIS_SCORES[typeKey] || PROFILE_DEFAULT_AXIS_SCORES.passive_rational_allocator;
    }

    const draft = buildInvestoTypePortfolioDraft({ typeKey, axisScores });
    const code =
      (draft.axisScores.riskAggressive >= 50 ? 'A' : 'C') +
      '-' +
      (draft.axisScores.controlInternal >= 50 ? 'I' : 'E') +
      '-' +
      (draft.axisScores.reactivityEmotional >= 50 ? 'E' : 'R');

    res.json({
      ok: true,
      generatedAt: toIsoDate(Date.now()),
      profile: {
        key: typeKey,
        label: draft.profile.label,
        axisCode: code
      },
      axisScores: draft.axisScores,
      allocation: draft.allocation,
      tickerMix: draft.tickerMix,
      rationale: draft.rationale
    });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Failed to build portfolio draft.' });
  }
});

function dedupeHeadlines(headlines, maxItems = 16) {
  const seen = new Set();
  const out = [];
  for (const row of Array.isArray(headlines) ? headlines : []) {
    const title = String(row?.title || '').trim();
    if (!title) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
    if (out.length >= maxItems) break;
  }
  return out;
}

async function fetchHeadlinesForSymbols(symbols, asOfDate, maxPerSymbol = 4) {
  const list = [...new Set((Array.isArray(symbols) ? symbols : []).map(normalizeSymbol).filter(Boolean))];
  const rowsNested = await Promise.all(
    list.map(async (symbol) => {
      const newsApiRows = await fetchNewsApiHeadlines(symbol, asOfDate, maxPerSymbol + 2);
      const yahooRows = await fetchYahooNewsHeadlines(symbol, Math.max(2, maxPerSymbol));
      const merged = dedupeHeadlines([...newsApiRows, ...yahooRows], maxPerSymbol);
      return merged.map((x) => ({ ...x, symbol }));
    })
  );
  return dedupeHeadlines(
    rowsNested.flat().sort((a, b) => String(b?.date || '').localeCompare(String(a?.date || ''))),
    40
  );
}

app.get('/api/news/market', async (req, res) => {
  try {
    const reqDate = String(req.query?.date || '').trim();
    const asOfDate = isValidDateString(reqDate) ? reqDate : toIsoDate(Date.now());
    const headlines = await fetchHeadlinesForSymbols(MARKET_NEWS_SYMBOLS, asOfDate, 3);
    const signals = analyzeNewsAndSocialSignals(headlines);

    res.json({
      ok: true,
      asOfDate,
      title: 'Market News',
      universe: MARKET_NEWS_SYMBOLS,
      sentiment: {
        news: signals.newsSentiment,
        social: signals.socialSentiment,
        confidence: signals.confidence
      },
      headlines: headlines.slice(0, 18)
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/news/tailored', async (req, res) => {
  try {
    const reqDate = String(req.query?.date || '').trim();
    const asOfDate = isValidDateString(reqDate) ? reqDate : toIsoDate(Date.now());
    const typeKey = normalizeInvestorTypeKey(req.query?.type);
    const profile = TAILORED_NEWS_PROFILES[typeKey];
    const headlines = await fetchHeadlinesForSymbols(profile.symbols, asOfDate, 3);
    const signals = analyzeNewsAndSocialSignals(headlines);

    res.json({
      ok: true,
      asOfDate,
      type: profile.key,
      profile: profile.label,
      watchlist: profile.symbols,
      sentiment: {
        news: signals.newsSentiment,
        social: signals.socialSentiment,
        confidence: signals.confidence
      },
      headlines: headlines.slice(0, 18)
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/news/investment-of-day', async (req, res) => {
  try {
    const reqDate = String(req.query?.date || '').trim();
    const asOfDate = isValidDateString(reqDate) ? reqDate : toIsoDate(Date.now());
    const periodRaw = String(req.query?.period || 'day').trim().toLowerCase();
    const period = ['day', 'week', 'month', 'year'].includes(periodRaw) ? periodRaw : 'day';
    const watchlist = [
      'AAPL',
      'MSFT',
      'NVDA',
      'GOOGL',
      'AMZN',
      'META',
      'TSLA',
      'JPM',
      'XOM',
      'UNH',
      'AVGO',
      'SPY',
      'QQQ'
    ];

    const d = new Date(asOfDate + 'T00:00:00Z');
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    const week = Math.floor((day - 1) / 7) + 1;
    const periodBucket =
      period === 'year'
        ? year
        : period === 'month'
        ? year * 100 + month
        : period === 'week'
        ? year * 100 + month * 10 + week
        : Math.floor(d.getTime() / DAY_MS);

    const periodIndex = ((Number(periodBucket) % watchlist.length) + watchlist.length) % watchlist.length;
    const symbol = watchlist[periodIndex];
    const investment = await buildSingleInvestmentValuation(symbol, { asOfDate });

    const alternatives = [1, 2].map((offset) => watchlist[(periodIndex + offset) % watchlist.length]);
    res.json({
      ok: true,
      asOfDate,
      period,
      title: `Investment Of The ${period.charAt(0).toUpperCase() + period.slice(1)}`,
      symbol,
      investment,
      alternatives
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/simulations/start', async (req, res) => {
  try {
    const startDate = req.body?.startDate;
    const endDate = req.body?.endDate;
    const frequency = req.body?.frequency;
    const initialCash = Number(req.body?.initialCash);
    const assets = Array.isArray(req.body?.assets)
      ? req.body.assets.map(normalizeSymbol).filter(Boolean)
      : Array.isArray(req.body?.symbols)
      ? req.body.symbols.map(normalizeSymbol).filter(Boolean)
      : [];
    const benchmarkSymbolsRaw = Array.isArray(req.body?.benchmarkSymbols)
      ? req.body.benchmarkSymbols
      : typeof req.body?.benchmarkSymbols === 'string'
      ? req.body.benchmarkSymbols.split(',')
      : [];
    const benchmarkSymbols = [...new Set(benchmarkSymbolsRaw.map(normalizeSymbol).filter(Boolean))];

    if (!isValidDateString(startDate)) return res.status(400).json({ error: 'startDate must be YYYY-MM-DD' });
    if (!isValidDateString(endDate)) return res.status(400).json({ error: 'endDate must be YYYY-MM-DD' });
    if (startDate >= endDate) return res.status(400).json({ error: 'endDate must be after startDate' });
    if (!['daily', 'weekly', 'monthly'].includes(frequency)) return res.status(400).json({ error: 'frequency must be daily, weekly, or monthly' });
    if (!Number.isFinite(initialCash) || initialCash <= 0) return res.status(400).json({ error: 'initialCash must be > 0' });
    if (assets.length === 0) return res.status(400).json({ error: 'Provide at least one investment asset.' });

    const parsedAssets = assets.map((token) => parseAssetToken(token));
    const uniqueAssetMap = new Map(parsedAssets.map((asset) => [asset.id, asset]));
    const uniqueAssets = [...uniqueAssetMap.values()];
    const uniqueSymbols = uniqueAssets.map((asset) => asset.id);

    const histories = {};
    const assetMeta = {};
    await Promise.all(
      uniqueSymbols.map(async (assetId) => {
        const result = await fetchAssetHistory(assetId, startDate, endDate);
        histories[assetId] = result.history;
        assetMeta[assetId] = result.meta;
      })
    );

    const schedule = createSchedule(startDate, endDate, frequency);
    if (schedule.length === 0) return res.status(400).json({ error: 'Could not create schedule.' });

    const id = crypto.randomUUID();
    const holdings = Object.fromEntries(uniqueSymbols.map((s) => [s, 0]));
    const costBasis = Object.fromEntries(uniqueSymbols.map((s) => [s, 0]));
    const firstBuyPrice = Object.fromEntries(uniqueSymbols.map((s) => [s, 0]));
    const realizedProfit = Object.fromEntries(uniqueSymbols.map((s) => [s, 0]));

    const session = {
      id,
      startDate,
      endDate,
      frequency,
      initialCash,
      cash: initialCash,
      symbols: uniqueSymbols,
      benchmarkSymbols,
      assetMeta,
      holdings,
      costBasis,
      firstBuyPrice,
      realizedProfit,
      closedPositions: {},
      histories,
      schedule,
      stepIndex: 0,
      feesPaid: 0,
      totalDividendsReceived: 0,
      dividendAccruedThrough: startDate,
      snapshots: [],
      decisions: [],
      turnoverSeries: [],
      concentrationSeries: [],
      cashRatioSeries: [],
      completed: false
    };

    sessions.set(id, session);

    const firstDate = schedule[0];
    const firstPreview = getPortfolioValueAtDate(session, firstDate);

    res.json({
      simulationId: id,
      startDate,
      endDate,
      frequency,
      symbols: uniqueSymbols,
      assets: uniqueSymbols.map((id) => ({ id, ...assetMeta[id] })),
      benchmarkSymbols,
      initialCash,
      nextRebalanceDate: firstDate,
      stepIndex: 0,
      totalSteps: schedule.length,
      preview: {
        date: firstDate,
        portfolioValue: firstPreview.total,
        prices: Object.fromEntries(Object.entries(firstPreview.prices).map(([k, v]) => [k, v.price]))
      },
      previewInsights: buildPreviewInsights(session, firstDate, firstPreview)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/simulations/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Simulation not found' });

  const nextDate = session.schedule[session.stepIndex] || null;
  const previewDate = nextDate || session.endDate;
  let preview = null;
  if (previewDate) {
    try {
      const p = getPortfolioValueAtDate(session, previewDate);
      preview = {
        date: previewDate,
        portfolioValue: p.total,
        prices: Object.fromEntries(Object.entries(p.prices).map(([k, v]) => [k, v.price]))
      };
    } catch (_error) {
      preview = null;
    }
  }

  res.json({
    simulationId: session.id,
    startDate: session.startDate,
    endDate: session.endDate,
    frequency: session.frequency,
    symbols: session.symbols,
    assets: session.symbols.map((id) => ({ id, ...session.assetMeta[id] })),
    benchmarkSymbols: session.benchmarkSymbols || [],
    stepIndex: session.stepIndex,
    totalSteps: session.schedule.length,
    nextRebalanceDate: nextDate,
    preview,
    previewInsights: preview
      ? buildPreviewInsights(session, preview.date, {
          total: preview.portfolioValue,
          prices: Object.fromEntries(Object.entries(preview.prices).map(([k, price]) => [k, { price }]))
        })
      : null,
    completed: session.completed,
    feesPaid: session.feesPaid,
    holdings: session.holdings,
    costBasis: session.costBasis,
    firstBuyPrice: session.firstBuyPrice,
    realizedProfit: session.realizedProfit,
    cash: session.cash,
    decisions: session.decisions.length
  });
});

app.get('/api/simulations/:id/market-briefing', async (req, res) => {
  try {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Simulation not found' });

    const reqDate = String(req.query?.date || '').trim();
    const reqSince = String(req.query?.sinceDate || '').trim();
    const defaultDate = session.schedule[session.stepIndex] || session.endDate;
    const date = isValidDateString(reqDate) ? reqDate : defaultDate;
    const sinceDate = isValidDateString(reqSince)
      ? reqSince
      : session.snapshots.length
      ? session.snapshots[session.snapshots.length - 1].date
      : session.startDate;
    const isHistoricalView = date < toIsoDate(Date.now() - 7 * DAY_MS);

    const preview = getPortfolioValueAtDate(session, date);

    const assets = await Promise.all(
      session.symbols.map(async (symbol) => {
        const history = session.histories[symbol] || [];
        const current = getPriceOnOrBefore(history, date, 'close') || getPriceOnOrAfter(history, date, 'close');
        const currentPrice = Number(current?.price || 0);
        const quantity = Number(session.holdings?.[symbol] || 0);
        const value = quantity * currentPrice;
        const weight = preview.total > 0 ? value / preview.total : 0;
        const periodReturn = getHistoryReturn(history, sinceDate, date, 'close');
        const dailyReturn = getDailyReturnAtDate(history, date, 'close');
        const latestDividend = getLatestDividendInfo(history, date);

        const meta = session.assetMeta?.[symbol] || {};
        const baseSymbol = normalizeSymbol(meta.baseSymbol || symbol);
        const isMarketLike = !['cash', 'savings'].includes(String(meta.type || '').toLowerCase());
        const [earningsDateRaw, headlinesRaw] = isMarketLike
          ? await Promise.all([fetchYahooEarningsDate(baseSymbol), fetchYahooNewsHeadlines(baseSymbol, 3)])
          : [null, []];
        const earningsDate = isHistoricalView ? null : earningsDateRaw;
        const headlines = (Array.isArray(headlinesRaw) ? headlinesRaw : [])
          .filter((h) => !h.date || h.date <= date)
          .slice(0, 3);

        return {
          symbol,
          baseSymbol,
          displayName: meta.displayName || meta.label || symbol,
          type: meta.type || 'market',
          price: currentPrice,
          quantity,
          value,
          weight,
          periodReturn,
          dailyReturn,
          earningsDate,
          latestDividend,
          headlines
        };
      })
    );

    res.json({
      simulationId: session.id,
      date,
      sinceDate,
      totalValue: preview.total,
      cash: session.cash,
      assets
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/simulations/:id/market-search', async (req, res) => {
  try {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Simulation not found' });

    const rawQuery = String(req.body?.query || '').trim();
    if (!rawQuery) return res.status(400).json({ error: 'query is required' });

    const reqDate = String(req.body?.date || '').trim();
    const reqSince = String(req.body?.sinceDate || '').trim();
    const defaultDate = session.schedule[session.stepIndex] || session.endDate;
    const date = isValidDateString(reqDate) ? reqDate : defaultDate;
    const sinceInput = isValidDateString(reqSince) ? reqSince : session.startDate;
    const sinceDate = sinceInput <= date ? sinceInput : session.startDate;
    const isHistoricalView = date < toIsoDate(Date.now() - 7 * DAY_MS);

    let resolvedSymbol = '';
    let resolvedName = '';
    if (isLikelyTicker(rawQuery)) {
      resolvedSymbol = normalizeSymbol(rawQuery);
    } else {
      const resolved = await resolveSymbolFromName(rawQuery, { preferBond: false });
      resolvedSymbol = normalizeSymbol(resolved?.best?.symbol || '');
      resolvedName = String(resolved?.best?.longname || resolved?.best?.shortname || '').trim();
    }
    if (!resolvedSymbol) {
      return res.status(400).json({ error: `No matching symbol found for "${rawQuery}".` });
    }

    const history = await fetchYahooHistory(resolvedSymbol, session.startDate, session.endDate);
    const current = getPriceOnOrBefore(history, date, 'close') || getPriceOnOrAfter(history, date, 'close');
    if (!current) {
      return res.status(400).json({ error: `No price found for ${resolvedSymbol} on or near ${date}.` });
    }

    const preview = getPortfolioValueAtDate(session, date);
    const heldSymbol = session.symbols.find((sym) => {
      if (sym === resolvedSymbol) return true;
      const meta = session.assetMeta?.[sym];
      const base = normalizeSymbol(meta?.baseSymbol || '');
      return base === resolvedSymbol;
    });
    const quantity = heldSymbol ? Number(session.holdings?.[heldSymbol] || 0) : 0;
    const value = quantity * Number(current.price || 0);
    const weight = preview.total > 0 ? value / preview.total : 0;

    const [earningsDateRaw, headlinesRaw] = await Promise.all([
      fetchYahooEarningsDate(resolvedSymbol),
      fetchYahooNewsHeadlines(resolvedSymbol, 6)
    ]);
    const earningsDate = isHistoricalView ? null : earningsDateRaw;
    const headlines = (Array.isArray(headlinesRaw) ? headlinesRaw : [])
      .filter((h) => !h.date || h.date <= date)
      .slice(0, 3);

    const heldMeta = heldSymbol ? session.assetMeta?.[heldSymbol] : null;
    const displayName = String(
      heldMeta?.displayName || heldMeta?.label || resolvedName || resolvedSymbol
    ).trim();

    res.json({
      simulationId: session.id,
      query: rawQuery,
      date,
      sinceDate,
      asset: {
        symbol: resolvedSymbol,
        displayName,
        inPortfolio: !!heldSymbol,
        portfolioSymbol: heldSymbol || null,
        price: Number(current.price || 0),
        quantity,
        value,
        weight,
        periodReturn: getHistoryReturn(history, sinceDate, date, 'close'),
        dailyReturn: getDailyReturnAtDate(history, date, 'close'),
        latestDividend: getLatestDividendInfo(history, date),
        earningsDate,
        headlines
      }
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/simulations/:id/assets', async (req, res) => {
  try {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Simulation not found' });
    if (session.completed) return res.status(400).json({ error: 'Simulation already completed.' });

    const token = normalizeSymbol(req.body?.token);
    if (!token) return res.status(400).json({ error: 'token is required' });

    const parsed = parseAssetToken(token);
    const symbol = parsed.id;
    if (session.symbols.includes(symbol)) {
      return res.json({
        simulationId: session.id,
        symbols: session.symbols,
        assets: session.symbols.map((id) => ({ id, ...session.assetMeta[id] })),
        alreadyExists: true
      });
    }

    const fetched = await fetchAssetHistory(symbol, session.startDate, session.endDate);
    session.symbols.push(symbol);
    session.assetMeta[symbol] = fetched.meta;
    session.histories[symbol] = fetched.history;
    session.holdings[symbol] = 0;
    session.costBasis[symbol] = 0;
    session.firstBuyPrice[symbol] = 0;
    session.realizedProfit[symbol] = Number(session.closedPositions?.[symbol]?.realizedProfit || 0);
    delete session.closedPositions?.[symbol];

    const nextDate = session.schedule[session.stepIndex] || null;
    let preview = null;
    if (nextDate) {
      const p = getPortfolioValueAtDate(session, nextDate);
      preview = {
        date: nextDate,
        portfolioValue: p.total,
        prices: Object.fromEntries(Object.entries(p.prices).map(([k, v]) => [k, v.price]))
      };
    }

    return res.json({
      simulationId: session.id,
      symbols: session.symbols,
      assets: session.symbols.map((id) => ({ id, ...session.assetMeta[id] })),
      preview,
      previewInsights: preview
        ? buildPreviewInsights(session, nextDate, {
            total: preview.portfolioValue,
            prices: Object.fromEntries(Object.entries(preview.prices).map(([k, price]) => [k, { price }]))
          })
        : null
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/simulations/:id/rebalance', (req, res) => {
  try {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Simulation not found' });
    if (session.completed) return res.status(400).json({ error: 'Simulation already completed.' });

    const date = session.schedule[session.stepIndex];
    if (!date) return res.status(400).json({ error: 'No remaining rebalance dates. Finish simulation.' });
    settleDividendsThrough(session, date);
    const feeRate = req.body?.skipFees ? 0 : FEE_RATE;

    const { total, prices } = getPortfolioValueAtDate(session, date);
    const { allocationMode, perAssetModes, requestedInputs, targetValues, budgetUsed } = buildTargetValues(
      session,
      total,
      prices,
      req.body
    );

    const preWeights = {};
    for (const symbol of session.symbols) {
      const value = session.holdings[symbol] * prices[symbol].price;
      const w = total > 0 ? value / total : 0;
      preWeights[symbol] = w;
    }

    const targetWeights = {};
    let turnover = 0;
    for (const symbol of session.symbols) {
      const w = total > 0 ? targetValues[symbol] / total : 0;
      targetWeights[symbol] = w;
      turnover += Math.abs((w || 0) - (preWeights[symbol] || 0));
    }
    turnover /= 2;

    let feeForThisRebalance = 0;
    const preHoldingsQty = Object.fromEntries(session.symbols.map((symbol) => [symbol, session.holdings[symbol] || 0]));
    const tradePlan = session.symbols.map((symbol) => {
      const price = prices[symbol].price;
      const currentQty = Number(session.holdings[symbol] || 0);
      const currentValue = currentQty * price;
      const targetValue = Number(targetValues[symbol] || 0);
      return {
        symbol,
        price,
        currentQty,
        currentValue,
        deltaRequested: targetValue - currentValue
      };
    });

    // Execute sells first so proceeds are available for buys.
    const sells = tradePlan.filter((x) => x.deltaRequested < -1e-9);
    for (const leg of sells) {
      const sellValue = Math.max(0, Math.min(leg.currentValue, Math.abs(leg.deltaRequested)));
      if (sellValue <= 1e-12) continue;
      const sellQty = sellValue / Math.max(leg.price, 1e-12);

      if (leg.currentQty > 0) {
        const ratio = Math.max(0, Math.min(1, sellQty / leg.currentQty));
        const prevBasis = Number(session.costBasis[leg.symbol] || 0);
        const soldBasis = Math.max(0, prevBasis * ratio);
        session.costBasis[leg.symbol] = Math.max(0, prevBasis - soldBasis);
        session.realizedProfit[leg.symbol] = Number(session.realizedProfit[leg.symbol] || 0) + sellValue - soldBasis;
      }

      const sellFee = sellValue * feeRate;
      session.holdings[leg.symbol] = Math.max(0, Number(session.holdings[leg.symbol] || 0) - sellQty);
      session.cash += sellValue - sellFee;
      feeForThisRebalance += sellFee;
    }

    // If requested buys (plus fees) exceed available cash, scale buys proportionally
    // so "no-change" plans do not force an immediate sell in the next period.
    const buys = tradePlan.filter((x) => x.deltaRequested > 1e-9);
    const requestedBuyCostWithFees = buys.reduce(
      (sum, leg) => sum + leg.deltaRequested * (1 + feeRate),
      0
    );
    const availableCashForBuys = Math.max(0, Number(session.cash || 0));
    const buyScale =
      requestedBuyCostWithFees > availableCashForBuys + 1e-9
        ? Math.max(0, availableCashForBuys / requestedBuyCostWithFees)
        : 1;

    for (const leg of buys) {
      const buyValue = Math.max(0, leg.deltaRequested * buyScale);
      if (buyValue <= 1e-12) continue;
      const buyQty = buyValue / Math.max(leg.price, 1e-12);
      if (
        (session.holdings[leg.symbol] || 0) <= 1e-10 &&
        buyQty > 1e-10 &&
        Number(session.firstBuyPrice?.[leg.symbol] || 0) <= 0
      ) {
        session.firstBuyPrice[leg.symbol] = leg.price;
      }
      const buyFee = buyValue * feeRate;
      session.holdings[leg.symbol] = Number(session.holdings[leg.symbol] || 0) + buyQty;
      session.costBasis[leg.symbol] = Number(session.costBasis[leg.symbol] || 0) + buyValue;
      session.cash -= buyValue + buyFee;
      feeForThisRebalance += buyFee;
    }

    for (const symbol of session.symbols) {
      if (session.holdings[symbol] <= 1e-10) {
        session.holdings[symbol] = 0;
        session.costBasis[symbol] = 0;
      }
    }

    if (Math.abs(session.cash) < 1e-8) session.cash = 0;
    session.feesPaid += feeForThisRebalance;

    const symbolsSoldOut = session.symbols.filter((symbol) => {
      const target = Number(targetValues[symbol] || 0);
      const qty = Number(session.holdings[symbol] || 0);
      const basis = Number(session.costBasis?.[symbol] || 0);
      return target <= 1e-6 && qty <= 1e-10 && basis <= 1e-6;
    });
    symbolsSoldOut.forEach((symbol) => removeAssetFromSession(session, symbol));

    const post = getPortfolioValueAtDate(session, date);
    const postTotal = post.total;

    const actualWeights = {};
    let hhi = 0;
    for (const symbol of session.symbols) {
      const w = postTotal > 0 ? (session.holdings[symbol] * post.prices[symbol].price) / postTotal : 0;
      actualWeights[symbol] = w;
      hhi += w ** 2;
    }

    const cashRatio = postTotal > 0 ? session.cash / postTotal : 0;

    session.turnoverSeries.push(turnover);
    session.concentrationSeries.push(hhi);
    session.cashRatioSeries.push(cashRatio);
    session.decisions.push({
      date,
      allocationMode,
      perAssetModes,
      requestedInputs,
      requestedTargets: targetValues,
      requestedWeights: targetWeights,
      actualWeights,
      portfolioValue: postTotal,
      cash: session.cash,
      turnover,
      fee: feeForThisRebalance
    });

    session.snapshots.push({ date, value: postTotal });
    session.stepIndex += 1;

    const nextDate = session.schedule[session.stepIndex] || null;
    let nextPreview = null;
    let nextPreviewInsights = null;
    if (nextDate) {
      try {
        const p = getPortfolioValueAtDate(session, nextDate);
        nextPreview = {
          date: nextDate,
          portfolioValue: p.total,
          prices: Object.fromEntries(Object.entries(p.prices).map(([k, v]) => [k, v.price]))
        };
        nextPreviewInsights = buildPreviewInsights(session, nextDate, {
          total: nextPreview.portfolioValue,
          prices: Object.fromEntries(Object.entries(nextPreview.prices).map(([k, price]) => [k, { price }]))
        });
      } catch (_error) {
        nextPreview = null;
        nextPreviewInsights = null;
      }
    } else {
      nextPreviewInsights = buildPreviewInsights(session, date, post);
    }

    res.json({
      date,
      timelinePoint: { date, value: postTotal },
      portfolioValue: postTotal,
      cash: session.cash,
      holdings: session.holdings,
      costBasis: session.costBasis,
      firstBuyPrice: session.firstBuyPrice,
      realizedProfit: session.realizedProfit,
      feesPaid: session.feesPaid,
      dividendsReceived: Number(session.totalDividendsReceived || 0),
      allocationMode,
      perAssetModes,
      requestedInputs,
      budgetUsed,
      budgetUsedRatio: total > 0 ? budgetUsed / total : 0,
      referencePortfolioValue: total,
      referencePrices: Object.fromEntries(Object.entries(prices).map(([k, v]) => [k, v.price])),
      turnover,
      concentrationHHI: hhi,
      stepIndex: session.stepIndex,
      totalSteps: session.schedule.length,
      nextRebalanceDate: nextDate,
      symbols: session.symbols,
      assets: session.symbols.map((id) => ({ id, ...session.assetMeta[id] })),
      nextPreview,
      nextPreviewInsights
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/simulations/:id/trade', (req, res) => {
  try {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Simulation not found' });
    if (session.completed) return res.status(400).json({ error: 'Simulation already completed.' });

    const date = session.schedule[session.stepIndex];
    if (!date) return res.status(400).json({ error: 'No active simulation date available.' });
    settleDividendsThrough(session, date);

    const sellSymbol = normalizeSymbol(req.body?.sellSymbol);
    const buySymbol = normalizeSymbol(req.body?.buySymbol);
    const sellAmount = Number(req.body?.sellAmount || 0);
    const buyAmount = Number(req.body?.buyAmount || 0);
    const sellUnits = Number(req.body?.sellUnits || 0);
    const buyUnits = Number(req.body?.buyUnits || 0);
    const sellMode = String(req.body?.sellMode || 'dollars').toLowerCase();
    const buyMode = String(req.body?.buyMode || 'dollars').toLowerCase();
    const liquidateAll = !!req.body?.liquidateAll;

    if (!session.symbols.includes(sellSymbol) || !session.symbols.includes(buySymbol)) {
      return res.status(400).json({ error: 'Sell/Buy symbols must be in your current portfolio asset list.' });
    }
    if (
      sellAmount < 0 ||
      buyAmount < 0 ||
      sellUnits < 0 ||
      buyUnits < 0 ||
      !Number.isFinite(sellAmount) ||
      !Number.isFinite(buyAmount) ||
      !Number.isFinite(sellUnits) ||
      !Number.isFinite(buyUnits)
    ) {
      return res.status(400).json({ error: 'Trade amounts must be valid positive numbers.' });
    }
    if (!['dollars', 'units'].includes(sellMode) || !['dollars', 'units'].includes(buyMode)) {
      return res.status(400).json({ error: 'sellMode and buyMode must be dollars or units.' });
    }

    const current = getPortfolioValueAtDate(session, date);
    const prices = current.prices;
    const preHoldingsQty = Object.fromEntries(session.symbols.map((symbol) => [symbol, Number(session.holdings[symbol] || 0)]));

    const sellPrice = prices[sellSymbol].price;
    const buyPrice = prices[buySymbol].price;
    const sellPositionQty = session.holdings[sellSymbol];
    const sellPositionValue = sellPositionQty * sellPrice;
    const requestedSellQty = liquidateAll ? sellPositionQty : sellMode === 'units' ? sellUnits : sellAmount / Math.max(sellPrice, 1e-12);
    const requestedSell = requestedSellQty * sellPrice;

    if (requestedSell > sellPositionValue + 1e-6) {
      return res.status(400).json({ error: 'Sell amount exceeds current position value.' });
    }

    let feeTotal = 0;

    if (requestedSell > 0) {
      const currentQty = session.holdings[sellSymbol];
      const sellQty = requestedSellQty;
      const sellFee = requestedSell * FEE_RATE;
      if (currentQty > 0) {
        const ratio = Math.max(0, Math.min(1, sellQty / currentQty));
        const prevBasis = Number(session.costBasis[sellSymbol] || 0);
        const soldBasis = Math.max(0, prevBasis * ratio);
        session.costBasis[sellSymbol] = Math.max(0, prevBasis - soldBasis);
        session.realizedProfit[sellSymbol] = Number(session.realizedProfit[sellSymbol] || 0) + requestedSell - soldBasis;
      }
      session.holdings[sellSymbol] -= sellQty;
      session.cash += requestedSell - sellFee;
      feeTotal += sellFee;
    }

    const requestedBuyQty = buyMode === 'units' ? buyUnits : buyAmount / Math.max(buyPrice, 1e-12);
    const requestedBuy = requestedBuyQty * buyPrice;

    if (requestedBuy > 0) {
      const buyFee = requestedBuy * FEE_RATE;
      const cost = requestedBuy + buyFee;
      if (cost > session.cash + 1e-6) {
        return res.status(400).json({ error: 'Not enough cash for this buy order after fees.' });
      }
      const buyQty = requestedBuyQty;
      if (
        (session.holdings[buySymbol] || 0) <= 1e-10 &&
        buyQty > 1e-10 &&
        Number(session.firstBuyPrice?.[buySymbol] || 0) <= 0
      ) {
        session.firstBuyPrice[buySymbol] = buyPrice;
      }
      session.holdings[buySymbol] += buyQty;
      session.costBasis[buySymbol] = (session.costBasis[buySymbol] || 0) + requestedBuy;
      session.cash -= cost;
      feeTotal += buyFee;
    }

    for (const symbol of session.symbols) {
      if (session.holdings[symbol] <= 1e-10) {
        session.holdings[symbol] = 0;
        session.costBasis[symbol] = 0;
      }
    }
    const soldOutSymbols = session.symbols.filter(
      (symbol) =>
        Number(preHoldingsQty[symbol] || 0) > 1e-10 &&
        Number(session.holdings[symbol] || 0) <= 1e-10 &&
        Number(session.costBasis[symbol] || 0) <= 1e-6
    );
    soldOutSymbols.forEach((symbol) => removeAssetFromSession(session, symbol));
    session.feesPaid += feeTotal;
    const post = getPortfolioValueAtDate(session, date);

    const nextDate = session.schedule[session.stepIndex] || null;
    let nextPreview = null;
    let nextPreviewInsights = null;
    if (nextDate) {
      const p = getPortfolioValueAtDate(session, nextDate);
      nextPreview = {
        date: nextDate,
        portfolioValue: p.total,
        prices: Object.fromEntries(Object.entries(p.prices).map(([k, v]) => [k, v.price]))
      };
      nextPreviewInsights = buildPreviewInsights(session, nextDate, p);
    }

    res.json({
      date,
      sellSymbol,
      buySymbol,
      liquidateAll,
      soldValue: requestedSell,
      soldUnits: requestedSellQty,
      boughtValue: requestedBuy,
      boughtUnits: requestedBuyQty,
      feeTotal,
      dividendsReceived: Number(session.totalDividendsReceived || 0),
      cash: session.cash,
      portfolioValue: post.total,
      holdings: session.holdings,
      costBasis: session.costBasis,
      firstBuyPrice: session.firstBuyPrice,
      realizedProfit: session.realizedProfit,
      symbols: session.symbols,
      assets: session.symbols.map((id) => ({ id, ...session.assetMeta[id] })),
      nextPreview,
      nextPreviewInsights
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/simulations/:id/timeline', async (req, res) => {
  try {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Simulation not found' });
    const defaultEnd = session.schedule[session.stepIndex] || session.endDate;
    const requestedEnd = String(req.query?.endDate || '').trim();
    const end = isValidDateString(requestedEnd) ? requestedEnd : defaultEnd;
    if (end < session.startDate) return res.status(400).json({ error: 'endDate is before simulation startDate' });
    const timeline = buildDailyTimeline(session, end);
    const benchmarkSymbols = (session.benchmarkSymbols && session.benchmarkSymbols.length ? session.benchmarkSymbols : []).slice(0, 8);
    if (!session.benchmarkHistories) session.benchmarkHistories = {};
    const benchmarkSeries = [];

    for (const symbol of benchmarkSymbols) {
      try {
        let history = session.benchmarkHistories[symbol];
        if (!Array.isArray(history) || history.length === 0) {
          history = await fetchYahooHistory(symbol, session.startDate, session.endDate);
          session.benchmarkHistories[symbol] = history;
        }
        const start = getNearestPrice(history, session.startDate, 'adjClose');
        if (!start || !(start.price > 0)) continue;
        const points = timeline
          .map((pt) => {
            const p = getPriceOnOrBefore(history, pt.date, 'adjClose');
            if (!p || !(p.price > 0)) return null;
            return { date: pt.date, value: session.initialCash * (p.price / start.price) };
          })
          .filter(Boolean);
        if (points.length >= 2) benchmarkSeries.push({ symbol, timeline: points });
      } catch (_error) {
        // Skip benchmark symbol if history is unavailable.
      }
    }
    res.json({
      simulationId: session.id,
      startDate: session.startDate,
      endDate: end,
      timeline,
      benchmarkSeries
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/simulations/:id/replay', (req, res) => {
  try {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Simulation not found' });

    const symbols = [...session.symbols];
    const allDates = new Set();
    symbols.forEach((symbol) => {
      const history = session.histories[symbol] || [];
      history.forEach((row) => {
        if (row.date >= session.startDate && row.date <= session.endDate) allDates.add(row.date);
      });
    });

    const dates = [...allDates].sort((a, b) => (a < b ? -1 : 1));
    const frames = [];
    const ptr = Object.fromEntries(symbols.map((s) => [s, 0]));

    for (const date of dates) {
      const prices = {};
      for (const symbol of symbols) {
        const history = session.histories[symbol] || [];
        let i = ptr[symbol] || 0;
        while (i + 1 < history.length && history[i + 1].date <= date) i += 1;
        ptr[symbol] = i;
        if (history[i] && history[i].date <= date) {
          prices[symbol] = Number(history[i].close || history[i].adjClose || 0);
        } else {
          prices[symbol] = 0;
        }
      }
      frames.push({ date, prices });
    }

    res.json({
      simulationId: session.id,
      startDate: session.startDate,
      endDate: session.endDate,
      symbols,
      frames
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/simulations/:id/projection', async (req, res) => {
  try {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Simulation not found' });

    const lastSnapshot = session.snapshots.length ? session.snapshots[session.snapshots.length - 1] : null;
    const currentDate = lastSnapshot ? lastSnapshot.date : session.startDate;
    const currentPoint = getPortfolioValueAtDate(session, currentDate);
    const currentValue = currentPoint.total;

    const remainingSchedule = session.schedule.filter((d) => d >= currentDate);
    const projectionDates = uniqueSortedDates([currentDate, ...remainingSchedule, session.endDate]);
    const projectedTimeline = projectionDates.map((date) => {
      const p = getPortfolioValueAtDate(session, date);
      return { date, value: p.total };
    });

    const projectedEndValue = projectedTimeline.length
      ? projectedTimeline[projectedTimeline.length - 1].value
      : currentValue;
    const projectedReturnToEnd = currentValue > 0 ? projectedEndValue / currentValue - 1 : 0;

    const benchmarkSymbols = (session.benchmarkSymbols && session.benchmarkSymbols.length ? session.benchmarkSymbols : []).slice(0, 8);
    const benchmarkProjection = [];

    for (const symbol of benchmarkSymbols) {
      try {
        const h = await fetchYahooHistory(symbol, currentDate, session.endDate);
        const start = getNearestPrice(h, currentDate, 'adjClose');
        if (!start) {
          benchmarkProjection.push({ symbol, ok: false, series: [], projectedReturnToEnd: null });
          continue;
        }

        const series = projectionDates.map((date) => {
          const p = getPriceOnOrBefore(h, date, 'adjClose');
          const value = p ? currentValue * (p.price / start.price) : null;
          return { date, value };
        }).filter((x) => x.value != null);

        const projectedEnd = series.length ? series[series.length - 1].value : null;
        const projectedReturn = projectedEnd != null && currentValue > 0 ? projectedEnd / currentValue - 1 : null;

        benchmarkProjection.push({
          symbol,
          ok: projectedReturn != null,
          projectedReturnToEnd: projectedReturn,
          series
        });
      } catch (error) {
        benchmarkProjection.push({ symbol, ok: false, projectedReturnToEnd: null, series: [], error: error.message });
      }
    }

    res.json({
      simulationId: session.id,
      currentDate,
      endDate: session.endDate,
      currentValue,
      projectedEndValue,
      projectedReturnToEnd,
      periodsRemaining: Math.max(0, projectionDates.length - 1),
      projectedTimeline,
      benchmarkProjection
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/simulations/:id/finish', async (req, res) => {
  try {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Simulation not found' });

    const finalDate = session.endDate;
    settleDividendsThrough(session, finalDate);
    const final = getPortfolioValueAtDate(session, finalDate);

    const finalValue = final.total;
    const totalReturn = finalValue / session.initialCash - 1;
    const cagr = calcCagr(session.initialCash, finalValue, session.startDate, session.endDate);

    const seriesValues = session.snapshots.map((s) => s.value).concat(finalValue);
    const maxDrawdown = calculateMaxDrawdown(seriesValues);
    const annualizedVol = calcAnnualizedVolFromSeries(seriesValues);

    const finalWeightsPreview = {};
    for (const symbol of session.symbols) {
      finalWeightsPreview[symbol] = finalValue > 0 ? (session.holdings[symbol] * final.prices[symbol].price) / finalValue : 0;
    }
    const finalConcentration = Object.values(finalWeightsPreview).reduce((s, w) => s + (w || 0) ** 2, 0);
    const tradeActivity = Math.min(1, Number(session.decisions?.length || 0) / Math.max(1, Number(session.schedule?.length || 1)));
    const topWeightsByDecision = (session.decisions || []).map((d) => {
      const vals = Object.values(d?.actualWeights || {}).map((v) => Number(v || 0));
      return vals.length ? Math.max(...vals) : 0;
    });
    const avgTopWeight = topWeightsByDecision.length
      ? topWeightsByDecision.reduce((s, v) => s + v, 0) / topWeightsByDecision.length
      : Object.values(finalWeightsPreview).reduce((m, v) => Math.max(m, Number(v || 0)), 0);
    const turnoverStd = session.turnoverSeries.length ? stdDev(session.turnoverSeries) : 0;
    const feeIntensity = session.decisions.length
      ? session.decisions.reduce((s, d) => s + Number(d?.fee || 0) / Math.max(1, Number(d?.portfolioValue || 1)), 0) /
        session.decisions.length
      : 0;
    let decisionDrift = 0;
    let decisionDriftCount = 0;
    let directionFlipRate = 0;
    let flipChecks = 0;
    if (session.decisions.length >= 2) {
      const symbolsUniverse = [...new Set(session.decisions.flatMap((d) => Object.keys(d?.actualWeights || {})))];
      const changesBySymbol = {};
      symbolsUniverse.forEach((s) => {
        changesBySymbol[s] = [];
      });
      for (let i = 1; i < session.decisions.length; i += 1) {
        const prev = session.decisions[i - 1]?.actualWeights || {};
        const curr = session.decisions[i]?.actualWeights || {};
        let stepAbs = 0;
        let stepN = 0;
        symbolsUniverse.forEach((sym) => {
          const delta = Number(curr[sym] || 0) - Number(prev[sym] || 0);
          stepAbs += Math.abs(delta);
          stepN += 1;
          changesBySymbol[sym].push(delta);
        });
        if (stepN > 0) {
          decisionDrift += stepAbs / stepN;
          decisionDriftCount += 1;
        }
      }
      symbolsUniverse.forEach((sym) => {
        const arr = changesBySymbol[sym];
        for (let i = 1; i < arr.length; i += 1) {
          const a = Number(arr[i - 1] || 0);
          const b = Number(arr[i] || 0);
          if (Math.abs(a) < 1e-4 || Math.abs(b) < 1e-4) continue;
          flipChecks += 1;
          if ((a > 0 && b < 0) || (a < 0 && b > 0)) directionFlipRate += 1;
        }
      });
    }
    decisionDrift = decisionDriftCount > 0 ? decisionDrift / decisionDriftCount : 0;
    directionFlipRate = flipChecks > 0 ? directionFlipRate / flipChecks : 0;

    const avgTurnover = session.turnoverSeries.length
      ? session.turnoverSeries.reduce((s, v) => s + v, 0) / session.turnoverSeries.length
      : Math.min(1, tradeActivity * 0.65);
    const avgConcentration = session.concentrationSeries.length
      ? session.concentrationSeries.reduce((s, v) => s + v, 0) / session.concentrationSeries.length
      : finalConcentration;
    const avgCashRatio = session.cashRatioSeries.length
      ? session.cashRatioSeries.reduce((s, v) => s + v, 0) / session.cashRatioSeries.length
      : session.cash / Math.max(finalValue, 1);

    const profile = classifyInvestor({
      avgConcentration,
      avgTurnover,
      avgCashRatio,
      annualizedVol: annualizedVol,
      maxDrawdown,
      tradeActivity,
      turnoverStd,
      avgTopWeight,
      feeIntensity,
      decisionDrift,
      directionFlipRate
    });

    const benchmarkSymbols = (session.benchmarkSymbols && session.benchmarkSymbols.length ? session.benchmarkSymbols : []).slice(0, 8);
    const benchmarkComparisons = [];
    const benchmarkSeries = [];
    for (const symbol of benchmarkSymbols) {
      try {
        const h = await fetchYahooHistory(symbol, session.startDate, session.endDate);
        const start = getNearestPrice(h, session.startDate, 'adjClose');
        const end = getPriceOnOrBefore(h, session.endDate, 'adjClose');
        const totalReturn = start && end ? end.price / start.price - 1 : null;
        benchmarkComparisons.push({ symbol, totalReturn, ok: totalReturn != null });

        if (start) {
          const seriesPoints = [];
          for (const point of session.snapshots.concat([{ date: session.endDate, value: finalValue }])) {
            const p = getPriceOnOrBefore(h, point.date, 'adjClose');
            if (!p) continue;
            const value = session.initialCash * (p.price / start.price);
            seriesPoints.push({ date: point.date, value });
          }
          benchmarkSeries.push({ symbol, points: seriesPoints });
        }
      } catch (error) {
        benchmarkComparisons.push({ symbol, totalReturn: null, ok: false, error: error.message });
      }
    }

    session.completed = true;

    const finalWeights = finalWeightsPreview;

    const timeline = session.snapshots.concat([{ date: session.endDate, value: finalValue }]);

    res.json({
      simulationId: session.id,
      startDate: session.startDate,
      endDate: session.endDate,
      finalValue,
      totalReturn,
      cagr,
      maxDrawdown,
      annualizedVolatility: annualizedVol,
      feesPaid: session.feesPaid,
      dividendsReceived: Number(session.totalDividendsReceived || 0),
      benchmark: benchmarkComparisons[0] || { symbol: 'SPY', totalReturn: null, ok: false },
      benchmarkComparisons,
      benchmarkSeries,
      finalWeights,
      timeline,
      behavior: {
        avgTurnover,
        avgConcentrationHHI: avgConcentration,
        avgCashRatio,
        rebalancesCompleted: session.decisions.length
      },
      investorProfile: profile,
      guidance: [
        'This simulator is educational and not financial advice.',
        'Repeat the simulation across different years to reduce period bias.',
        'Compare your behavior metrics against your risk tolerance survey.'
      ]
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Investment simulator running on http://localhost:${PORT}`);
});
