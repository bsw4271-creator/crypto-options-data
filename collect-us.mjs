// US stock part of the OS market pulse (OS ADR-047 stage 5): this week's biggest earnings (Finnhub) and US biotech
// against the market (Tiingo). No option data: this repository is public, and the option source the OS uses
// (Marketdata.app, personal licence) forbids redistribution, so the OS fetches option chains itself.
// Keys come only from Actions secrets (FINNHUB_API_KEY, TIINGO_API_KEY), go only in request headers, and never
// reach the output or the log. A failed part keeps its previous block and is listed in run.failed.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import {
  US_SCHEMA, BIO, earningsWeek, readEarningsCalendar, readSurprises, topEarnings, readTiingo, returns, summarizeBio,
} from './lib/us.mjs';

const OUT = new URL('./data/os/us-v1.json', import.meta.url);
const FINNHUB = process.env.FINNHUB_API_KEY || '';
const TIINGO = process.env.TIINGO_API_KEY || '';

// Keyed providers never get redirects (the key would follow).
async function getJson(url, headers = {}) {
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'crypto-options-data', ...headers },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP_${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new Error('NOT_JSON');
  }
}
const finnhub = (path) => getJson(`https://finnhub.io/api/v1/${path}`, { 'X-Finnhub-Token': FINNHUB });
const tiingo = (s, since) =>
  getJson(`https://api.tiingo.com/tiingo/daily/${s.toLowerCase()}/prices?startDate=${since}`, {
    Authorization: `Token ${TIINGO}`,
  });
// Node's fetch reports every network failure as "fetch failed"; the cause code (ENOTFOUND, ECONNRESET, ...) says why.
const code = (e) => {
  const base = e instanceof Error ? e.message : 'UNAVAILABLE';
  const cause = e instanceof Error && e.cause && typeof e.cause === 'object' ? String(e.cause.code ?? e.cause.name ?? '') : '';
  return `${base}${cause ? ':' + cause : ''}`.replace(/[^A-Z0-9_:]/gi, '_').slice(0, 60);
};

const now = Date.now();
const runAt = new Date(now).toISOString();
let previous = null;
try {
  previous = JSON.parse(readFileSync(OUT, 'utf8'));
} catch {}
const out = {
  schema: US_SCHEMA,
  source: 'Finnhub free, Tiingo free',
  run: { runAt, failed: [] },
  earnings: previous?.earnings ?? null,
  bio: previous?.bio ?? null,
};
const fail = (part, symbol, e) => out.run.failed.push({ part, symbol, error: code(e) });

// 1. This week's earnings: Finnhub calendar → largest revenue estimates → last four quarters' beats.
try {
  if (!FINNHUB) throw new Error('NO_FINNHUB_KEY');
  const week = earningsWeek(now);
  const picked = topEarnings(readEarningsCalendar(await finnhub(`calendar/earnings?from=${week.from}&to=${week.to}`)));
  for (const p of picked) {
    try {
      Object.assign(p, readSurprises(await finnhub(`stock/earnings?symbol=${p.symbol}`)));
    } catch (e) {
      Object.assign(p, { quarters: 0, beats: 0 });
      fail('earnings-surprises', p.symbol, e);
    }
  }
  if (!picked.length) throw new Error('NO_EARNINGS_THIS_WEEK');
  out.earnings = { week, updatedAt: runAt, items: picked };
} catch (e) {
  fail('earnings', null, e);
}

// 2. Biotech: Tiingo daily closes, once per New York trading day is plenty (shared free quota).
const bioFresh = previous?.bio?.updatedAt?.slice(0, 10) === runAt.slice(0, 10);
if (!bioFresh) {
  try {
    if (!TIINGO) throw new Error('NO_TIINGO_KEY');
    const since = new Date(now - 130 * 86_400_000).toISOString().slice(0, 10);
    const series = {};
    for (const s of ['XBI', 'SPY', ...BIO]) {
      try {
        series[s] = returns(readTiingo(await tiingo(s, since)));
      } catch (e) {
        fail('bio', s, e);
      }
    }
    out.bio = { ...summarizeBio(series), updatedAt: runAt };
  } catch (e) {
    fail('bio', null, e);
  }
}

mkdirSync(new URL('./data/os/', import.meta.url), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
console.log(
  `us: earnings ${out.earnings?.items?.length ?? 0}; ` +
    `bio ${out.bio?.stocks?.length ?? 0}; failed: ${out.run.failed.map((f) => `${f.part}:${f.symbol ?? '-'} ${f.error}`).join(', ') || 'none'}`,
);
if (!out.earnings && !out.bio) process.exitCode = 1;
