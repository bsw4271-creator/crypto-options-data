// Pure functions for the US stock part of the OS market pulse (OS ADR-047 stage 5). No network, no clock:
// callers pass both. Sources: Finnhub free earnings data, Tiingo free daily closes. Option data is not collected
// here: this repository is public and the option source (Marketdata.app, personal licence) forbids redistribution,
// so the OS fetches option chains itself, behind Cloudflare Access.

export const US_SCHEMA = 'crypto-options-data/us-bundle@1';
export const BIO = ['GMAB', 'MDGL', 'VIR', 'IMVT', 'XENE', 'LQDA', 'PEPG', 'RZLT', 'DERM'];
export const EARNINGS_KEEP = 10;
export const SYMBOL = /^[A-Z]{1,5}$/;

const DAY = 86_400_000;
const num = (v) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const round = (n, d = 2) => (n === null || n === undefined ? null : Math.round(n * 10 ** d) / 10 ** d);

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

/** The watched names: the largest revenue estimates of the week (the calendar is already sorted that way). */
export const topEarnings = (calendar, keep = EARNINGS_KEEP) => calendar.slice(0, keep);

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
