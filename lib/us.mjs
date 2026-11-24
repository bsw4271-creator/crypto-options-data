// Pure functions for the US stock part of the OS market pulse (OS ADR-047 stage 5). No network, no clock:
// callers pass both. Sources: Cboe public delayed option chains, Finnhub free earnings data, Tiingo free daily closes.
import { maxPain, atmIv } from './options.mjs';

export const US_SCHEMA = 'crypto-options-data/us-bundle@1';
export const FIXED = ['SPY', 'QQQ'];
export const BIO = ['GMAB', 'MDGL', 'VIR', 'IMVT', 'XENE', 'LQDA', 'PEPG', 'RZLT', 'DERM'];
export const EARNINGS_KEEP = 10;
export const EARNINGS_CANDIDATES = 20;
export const SYMBOL = /^[A-Z]{1,5}$/;

const DAY = 86_400_000;
const num = (v) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const round = (n, d = 2) => (n === null || n === undefined ? null : Math.round(n * 10 ** d) / 10 ** d);
const ratio = (a, b) => (b > 0 ? a / b : null);

/** UTC offset of New York on a calendar date, in hours (-4 in summer time, -5 otherwise). */
export function nyOffset(date) {
  const at = new Date(date + 'T12:00:00Z');
  const ny = new Date(at.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const utc = new Date(at.toLocaleString('en-US', { timeZone: 'UTC' }));
  return Math.round((ny - utc) / 3_600_000);
}

/** US equity options stop trading at 16:00 New York time on the expiry date. */
export const closeUtc = (date) => Date.parse(date + 'T16:00:00Z') - nyOffset(date) * 3_600_000;

/** "SPY261127C00600000" → { expiryDate, strike, type }; null for other roots (adjusted "SPY1…") or bad names. */
export function parseOcc(name, root) {
  const m = /^([A-Z]+)(\d{6})([CP])(\d{8})$/.exec(String(name));
  if (!m || m[1] !== root) return null;
  const expiryDate = `20${m[2].slice(0, 2)}-${m[2].slice(2, 4)}-${m[2].slice(4, 6)}`;
  const strike = Number(m[4]) / 1000;
  if (Number.isNaN(Date.parse(expiryDate)) || !(strike > 0)) return null;
  return { expiryDate, strike, type: m[3] === 'C' ? 'call' : 'put' };
}

/** Cboe delayed_quotes/options/<SYMBOL>.json → { spot, iv30, chain } with options still alive at `now`. */
export function readCboe(body, symbol, now) {
  const d = body?.data;
  if (!d || !Array.isArray(d.options)) throw new Error('MALFORMED_CBOE');
  const spot = num(d.current_price) ?? num(d.close);
  if (!(spot > 0)) throw new Error('NO_SPOT');
  const chain = [];
  for (const o of d.options) {
    const p = parseOcc(o?.option, symbol);
    if (!p) continue;
    const expiry = closeUtc(p.expiryDate);
    if (expiry <= now) continue;
    const iv = num(o.iv);
    const bid = num(o.bid);
    const ask = num(o.ask);
    chain.push({
      ...p,
      expiry,
      oi: num(o.open_interest) ?? 0,
      volume: num(o.volume) ?? 0,
      // Cboe gives IV as a decimal (0.23); the shared helpers use percent like Deribit's mark_iv.
      markIv: iv !== null && iv > 0 ? iv * 100 : null,
      mid: bid !== null && ask !== null && bid >= 0 && ask > 0 && ask >= bid ? (bid + ask) / 2 : null,
      underlying: spot,
    });
  }
  if (!chain.length) throw new Error('EMPTY_CHAIN');
  return { spot, iv30: num(d.iv30), chain };
}

const byExpiry = (chain) => {
  const map = new Map();
  for (const o of chain) {
    if (!map.has(o.expiryDate)) map.set(o.expiryDate, []);
    map.get(o.expiryDate).push(o);
  }
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
};

/** ATM straddle (call mid + put mid at the strike nearest spot) as % of spot: the move the options price in. */
export function straddlePct(options, spot) {
  const strikes = [...new Set(options.map((o) => o.strike))];
  if (!strikes.length || !(spot > 0)) return null;
  const k = strikes.reduce((a, b) => (Math.abs(b - spot) < Math.abs(a - spot) ? b : a));
  const call = options.find((o) => o.strike === k && o.type === 'call')?.mid;
  const put = options.find((o) => o.strike === k && o.type === 'put')?.mid;
  return call == null || put == null ? null : ((call + put) / spot) * 100;
}

/** One expiry: put/call, max pain, ATM IV, a one-standard-deviation move and the straddle-implied move. */
export function equityExpiry(date, options, spot, now) {
  const oi = (t) => options.filter((o) => o.type === t).reduce((s, o) => s + o.oi, 0);
  const iv = atmIv(options, spot);
  const days = (closeUtc(date) - now) / DAY;
  const move = iv === null ? null : (iv / 100) * Math.sqrt(Math.max(days, 0) / 365);
  return {
    expiry: date,
    days: round(days, 2),
    putCallOi: round(ratio(oi('put'), oi('call')), 3),
    maxPain: maxPain(options),
    atmIv: round(iv, 1),
    expectedMovePct: move === null ? null : round(move * 100, 2),
    straddlePct: round(straddlePct(options, spot), 2),
    rangeLow: move === null ? null : round(spot * (1 - move), 2),
    rangeHigh: move === null ? null : round(spot * (1 + move), 2),
  };
}

/** Whole-symbol summary. "This week" is the Friday expiry 1–8 days away (SPY/QQQ also list daily expiries). */
export function summarizeEquity({ spot, iv30, chain }, now, maxExpiries = 4) {
  const sum = (t, k) => chain.filter((o) => o.type === t).reduce((s, o) => s + o[k], 0);
  const groups = byExpiry(chain);
  const all = groups.map(([date, opts]) => equityExpiry(date, opts, spot, now));
  const isFriday = (date) => new Date(date + 'T00:00:00Z').getUTCDay() === 5;
  return {
    spot: round(spot, 2),
    iv30: round(iv30, 1),
    putCallOi: round(ratio(sum('put', 'oi'), sum('call', 'oi')), 3),
    putCallVolume: round(ratio(sum('put', 'volume'), sum('call', 'volume')), 3),
    totalOi: sum('put', 'oi') + sum('call', 'oi'),
    week: all.find((e) => isFriday(e.expiry) && e.days >= 1 && e.days <= 8) ?? null,
    expiries: all.slice(0, maxExpiries),
  };
}

/** First expiry that still includes the earnings reaction: after the date for "amc", from the date otherwise. */
export function earningsMove(chain, spot, date, hour) {
  const groups = byExpiry(chain);
  const hit = groups.find(([d]) => (hour === 'amc' ? d > date : d >= date));
  if (!hit) return null;
  const [expiry, opts] = hit;
  const oi = (t) => opts.filter((o) => o.type === t).reduce((s, o) => s + o.oi, 0);
  return {
    expiry,
    movePct: round(straddlePct(opts, spot), 2),
    atmIv: round(atmIv(opts, spot), 1),
    putCallOi: round(ratio(oi('put'), oi('call')), 3),
  };
}

/** Monday–Friday (New York calendar) of the week to show. Saturday and Sunday look at the coming week. */
export function earningsWeek(now) {
  const nyDate = new Date(new Date(now).toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = nyDate.getDay(); // 0 Sun … 6 Sat
  const toMonday = day === 0 ? 1 : day === 6 ? 2 : 1 - day;
  const monday = new Date(Date.UTC(nyDate.getFullYear(), nyDate.getMonth(), nyDate.getDate() + toMonday));
  const friday = new Date(monday.getTime() + 4 * DAY);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { from: iso(monday), to: iso(friday) };
}

/** Finnhub calendar/earnings → rows for plain US tickers, largest revenue estimate first. */
export function readEarningsCalendar(body) {
  const rows = body?.earningsCalendar;
  if (!Array.isArray(rows)) throw new Error('MALFORMED_CALENDAR');
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const symbol = typeof r?.symbol === 'string' ? r.symbol : '';
    if (!SYMBOL.test(symbol) || seen.has(symbol) || !/^\d{4}-\d{2}-\d{2}$/.test(r?.date ?? '')) continue;
    seen.add(symbol);
    out.push({
      symbol,
      date: r.date,
      hour: ['bmo', 'amc', 'dmh'].includes(r.hour) ? r.hour : null,
      epsEstimate: num(r.epsEstimate),
      epsActual: num(r.epsActual),
      revenueEstimate: num(r.revenueEstimate),
      revenueActual: num(r.revenueActual),
    });
  }
  return out.sort((a, b) => (b.revenueEstimate ?? -1) - (a.revenueEstimate ?? -1));
}

/** Finnhub stock/earnings (free: last four quarters) → how many beat the estimate. */
export function readSurprises(body) {
  if (!Array.isArray(body)) throw new Error('MALFORMED_SURPRISES');
  const q = body.filter((r) => num(r?.actual) !== null && num(r?.estimate) !== null).slice(0, 4);
  return { quarters: q.length, beats: q.filter((r) => num(r.actual) > num(r.estimate)).length };
}

/** Pick the watched names: candidates with option chains, most total open interest first. */
export function pickEarnings(candidates, keep = EARNINGS_KEEP) {
  return candidates
    .filter((c) => c.totalOi > 0)
    .sort((a, b) => b.totalOi - a.totalOi || (a.date < b.date ? -1 : 1))
    .slice(0, keep)
    .sort((a, b) => (a.date === b.date ? b.totalOi - a.totalOi : a.date < b.date ? -1 : 1));
}

/** Tiingo daily rows → [[date, adjClose]] ascending. */
export function readTiingo(body) {
  if (!Array.isArray(body)) throw new Error('MALFORMED_TIINGO');
  const rows = body
    .map((r) => [typeof r?.date === 'string' ? r.date.slice(0, 10) : '', num(r?.adjClose) ?? num(r?.close)])
    .filter(([d, v]) => /^\d{4}-\d{2}-\d{2}$/.test(d) && v !== null && v > 0)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  if (rows.length < 2) throw new Error('SHORT_SERIES');
  return rows;
}

/** Returns over 5, 21 and 63 trading days (about one week, month, quarter) in %. */
export function returns(rows) {
  const last = rows.at(-1)[1];
  const back = (n) => (rows.length > n ? round((last / rows[rows.length - 1 - n][1] - 1) * 100, 2) : null);
  return { asOf: rows.at(-1)[0], close: round(last, 2), r1w: back(5), r1m: back(21), r3m: back(63) };
}

/** XBI against SPY plus the biotech names ranked by one-month return. */
export function summarizeBio(series) {
  const xbi = series.XBI;
  const spy = series.SPY;
  if (!xbi || !spy) throw new Error('NO_BENCHMARK');
  const diff = (k) => (xbi[k] === null || spy[k] === null ? null : round(xbi[k] - spy[k], 2));
  const stocks = BIO.filter((s) => series[s])
    .map((s) => ({ symbol: s, ...series[s] }))
    .sort((a, b) => (b.r1m ?? -Infinity) - (a.r1m ?? -Infinity));
  return {
    asOf: xbi.asOf,
    xbi,
    spy,
    relative: { r1w: diff('r1w'), r1m: diff('r1m'), r3m: diff('r3m') },
    stocks,
  };
}
