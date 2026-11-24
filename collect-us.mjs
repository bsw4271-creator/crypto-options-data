// US stock part of the OS market pulse (OS ADR-047 stage 5): option chain summaries for SPY and QQQ, this week's
// most-watched earnings with the move the options price in, and US biotech against the market.
// Keys come only from Actions secrets (FINNHUB_API_KEY, TIINGO_API_KEY), go only in request headers, and never
// reach the output or the log. A failed part keeps its previous block and is listed in run.failed.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import {
  US_SCHEMA, FIXED, BIO, EARNINGS_CANDIDATES, readCboe, summarizeEquity, earningsMove, earningsWeek,
  readEarningsCalendar, readSurprises, pickEarnings, readTiingo, returns, summarizeBio,
} from './lib/us.mjs';

const OUT = new URL('./data/os/us-v1.json', import.meta.url);
const FINNHUB = process.env.FINNHUB_API_KEY || '';
const TIINGO = process.env.TIINGO_API_KEY || '';

// Keyed providers never get redirects (the key would follow). Cboe takes no key, so one redirect inside cboe.com
// is allowed, and the final host is checked.
async function getJson(url, headers = {}, { follow = false } = {}) {
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'crypto-options-data', ...headers },
    redirect: follow ? 'follow' : 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (follow && !new URL(res.url).hostname.endsWith('.cboe.com')) throw new Error('REDIRECT_OFF_HOST');
  if (!res.ok) throw new Error(`HTTP_${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new Error('NOT_JSON');
  }
}
const cboe = (s) => getJson(`https://cdn.cboe.com/api/global/delayed_quotes/options/${s}.json`, {}, { follow: true });
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
  source: 'Cboe delayed quotes (15 min), Finnhub free, Tiingo free',
  run: { runAt, failed: [] },
  options: {},
  earnings: previous?.earnings ?? null,
  bio: previous?.bio ?? null,
};
const fail = (part, symbol, e) => out.run.failed.push({ part, symbol, error: code(e) });

// 1. Fixed option summaries.
for (const s of FIXED) {
  try {
    out.options[s] = { ...summarizeEquity(readCboe(await cboe(s), s, now), now), updatedAt: runAt };
  } catch (e) {
    fail('options', s, e);
    if (previous?.options?.[s]) out.options[s] = previous.options[s];
  }
}

// 2. This week's earnings: Finnhub calendar → largest revenue estimates → Cboe open interest → top names.
try {
  if (!FINNHUB) throw new Error('NO_FINNHUB_KEY');
  const week = earningsWeek(now);
  const calendar = readEarningsCalendar(await finnhub(`calendar/earnings?from=${week.from}&to=${week.to}`));
  const candidates = [];
  for (const row of calendar.slice(0, EARNINGS_CANDIDATES)) {
    try {
      const q = readCboe(await cboe(row.symbol), row.symbol, now);
      const totalOi = q.chain.reduce((sum, o) => sum + o.oi, 0);
      candidates.push({ ...row, spot: Math.round(q.spot * 100) / 100, totalOi, option: earningsMove(q.chain, q.spot, row.date, row.hour) });
    } catch (e) {
      // No listed options or Cboe refused: the name is simply not ranked.
      if (!/EMPTY_CHAIN|HTTP_404|HTTP_403/.test(code(e))) fail('earnings-options', row.symbol, e);
    }
  }
  const picked = pickEarnings(candidates);
  for (const p of picked) {
    try {
      Object.assign(p, readSurprises(await finnhub(`stock/earnings?symbol=${p.symbol}`)));
    } catch (e) {
      Object.assign(p, { quarters: 0, beats: 0 });
      fail('earnings-surprises', p.symbol, e);
    }
  }
  if (!picked.length) throw new Error(calendar.length ? 'NO_OPTION_CHAINS' : 'NO_EARNINGS_THIS_WEEK');
  out.earnings = { week, updatedAt: runAt, items: picked };
} catch (e) {
  fail('earnings', null, e);
}

// 3. Biotech: Tiingo daily closes, once per New York trading day is plenty (shared free quota).
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
  `us: options ${Object.keys(out.options).join(', ') || 'none'}; earnings ${out.earnings?.items?.length ?? 0}; ` +
    `bio ${out.bio?.stocks?.length ?? 0}; failed: ${out.run.failed.map((f) => `${f.part}:${f.symbol ?? '-'} ${f.error}`).join(', ') || 'none'}`,
);
if (!Object.keys(out.options).length && !out.earnings && !out.bio) process.exitCode = 1;
