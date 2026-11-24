// Pure option-chain math for the OS options widget (OS ADR-046 stage 3). No network, no clock: callers pass both.
// Deribit public data: book summaries per instrument and the DVOL implied-volatility index.

export const SCHEMA = 'crypto-options-data/os-bundle@1';
const DAY = 86_400_000;
const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
const num = (v) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const round = (n, d = 2) => (n === null ? null : Math.round(n * 10 ** d) / 10 ** d);

/** "BTC-27DEC26-100000-C" → { currency, expiry (08:00 UTC ms), expiryDate, strike, type }; null if not an option. */
export function parseInstrument(name) {
  const m = /^([A-Z]+)-(\d{1,2})([A-Z]{3})(\d{2})-(\d+(?:d\d+)?)-([CP])$/.exec(String(name));
  if (!m || !(m[3] in MONTHS)) return null;
  const expiry = Date.UTC(2000 + Number(m[4]), MONTHS[m[3]], Number(m[2]), 8);
  const strike = Number(m[5].replace('d', '.'));
  if (!Number.isFinite(expiry) || !(strike > 0)) return null;
  return { currency: m[1], expiry, expiryDate: new Date(expiry).toISOString().slice(0, 10), strike, type: m[6] === 'C' ? 'call' : 'put' };
}

/** Rows of public/get_book_summary_by_currency?kind=option → options still alive at `now`. */
export function readChain(result, now) {
  if (!Array.isArray(result)) throw new Error('MALFORMED_BOOK_SUMMARY');
  const out = [];
  for (const r of result) {
    const inst = parseInstrument(r?.instrument_name);
    if (!inst || inst.expiry <= now) continue;
    out.push({
      ...inst,
      oi: num(r.open_interest) ?? 0,
      volume: num(r.volume) ?? 0,
      markIv: num(r.mark_iv),
      underlying: num(r.underlying_price),
    });
  }
  if (!out.length) throw new Error('EMPTY_CHAIN');
  return out;
}

/** Strike where option holders would be paid the least at expiry (calls + puts, open interest weighted). */
export function maxPain(options) {
  const strikes = [...new Set(options.map((o) => o.strike))].sort((a, b) => a - b);
  let best = null;
  for (const s of strikes) {
    let pain = 0;
    for (const o of options) pain += o.oi * (o.type === 'call' ? Math.max(0, s - o.strike) : Math.max(0, o.strike - s));
    if (best === null || pain < best.pain) best = { strike: s, pain };
  }
  return best?.strike ?? null;
}

/** ATM implied volatility (%) for one expiry: mean mark IV of the call and put at the strike nearest the forward. */
export function atmIv(options, forward) {
  if (!(forward > 0)) return null;
  const strikes = [...new Set(options.map((o) => o.strike))];
  if (!strikes.length) return null;
  const k = strikes.reduce((a, b) => (Math.abs(b - forward) < Math.abs(a - forward) ? b : a));
  const ivs = options.filter((o) => o.strike === k && o.markIv !== null && o.markIv > 0).map((o) => o.markIv);
  return ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : null;
}

const ratio = (puts, calls) => (calls > 0 ? puts / calls : null);

/** One expiry's summary. Expected move = spot × ATM IV × √(days/365), a one-standard-deviation range. */
export function summarizeExpiry(options, spot, now) {
  const { expiry, expiryDate } = options[0];
  const calls = options.filter((o) => o.type === 'call');
  const puts = options.filter((o) => o.type === 'put');
  const oiCalls = calls.reduce((s, o) => s + o.oi, 0);
  const oiPuts = puts.reduce((s, o) => s + o.oi, 0);
  const forwards = options.map((o) => o.underlying).filter((u) => u !== null && u > 0);
  const forward = forwards.length ? forwards.reduce((a, b) => a + b, 0) / forwards.length : spot;
  const iv = atmIv(options, forward);
  const days = (expiry - now) / DAY;
  const move = iv === null ? null : (iv / 100) * Math.sqrt(days / 365);
  return {
    expiry: expiryDate,
    days: round(days, 2),
    oiCalls: round(oiCalls),
    oiPuts: round(oiPuts),
    putCallOi: round(ratio(oiPuts, oiCalls), 3),
    maxPain: maxPain(options),
    atmIv: round(iv, 1),
    expectedMovePct: move === null ? null : round(move * 100, 2),
    rangeLow: move === null ? null : round(spot * (1 - move), 0),
    rangeHigh: move === null ? null : round(spot * (1 + move), 0),
  };
}

/** DVOL daily candles [[ts, open, high, low, close]] → current, 1-year IV rank and percentile. */
export function ivRank(data) {
  if (!Array.isArray(data)) throw new Error('MALFORMED_DVOL');
  const closes = data
    .map((c) => ({ t: num(c?.[0]), v: num(c?.[4]) }))
    .filter((c) => c.t !== null && c.v !== null && c.v > 0)
    .sort((a, b) => a.t - b.t);
  if (closes.length < 30) throw new Error('SHORT_DVOL');
  const cur = closes.at(-1);
  const values = closes.map((c) => c.v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  return {
    current: round(cur.v, 1),
    asOf: new Date(cur.t).toISOString().slice(0, 10),
    min: round(min, 1),
    max: round(max, 1),
    days: closes.length,
    rank: max > min ? round(((cur.v - min) / (max - min)) * 100, 0) : null,
    percentile: round((values.filter((v) => v < cur.v).length / values.length) * 100, 0),
  };
}

/** Whole-currency summary: overall put/call, the next expiries, this week's expiry and the largest one. */
export function summarizeCurrency({ chain, spot, dvol, now, maxExpiries = 6 }) {
  const byExpiry = new Map();
  for (const o of chain) {
    if (!byExpiry.has(o.expiry)) byExpiry.set(o.expiry, []);
    byExpiry.get(o.expiry).push(o);
  }
  const all = [...byExpiry.keys()].sort((a, b) => a - b).map((e) => summarizeExpiry(byExpiry.get(e), spot, now));
  const sum = (type, key) => chain.filter((o) => o.type === type).reduce((s, o) => s + o[key], 0);
  // "This week": the weekly (Friday) expiry at least one day away. Deribit also lists daily expiries; using the
  // next daily one would show a one-day move as the week's range.
  const isFriday = (date) => new Date(date + 'T00:00:00Z').getUTCDay() === 5;
  const week = all.find((e) => isFriday(e.expiry) && e.days >= 1 && e.days <= 8) ?? null;
  const largest = all.reduce((a, b) => (b.oiCalls + b.oiPuts > a.oiCalls + a.oiPuts ? b : a), all[0]);
  return {
    spot: round(spot, 2),
    putCallOi: round(ratio(sum('put', 'oi'), sum('call', 'oi')), 3),
    putCallVolume24h: round(ratio(sum('put', 'volume'), sum('call', 'volume')), 3),
    totalOi: round(sum('put', 'oi') + sum('call', 'oi')),
    iv: dvol,
    week,
    largest,
    expiries: all.slice(0, maxExpiries),
  };
}
