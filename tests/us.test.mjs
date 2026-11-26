import test from 'node:test';
import assert from 'node:assert/strict';
import {
  earningsWeek, readEarningsCalendar, readSurprises, topEarnings, readTiingo, returns, summarizeBio, BIO,
} from '../lib/us.mjs';

const NOW = Date.parse('2026-11-24T15:00:00Z'); // Tuesday 10:00 in New York

test('earnings week: weekdays show this week, weekends the coming one', () => {
  assert.deepEqual(earningsWeek(NOW), { from: '2026-11-23', to: '2026-11-27' });
  assert.deepEqual(earningsWeek(Date.parse('2026-11-28T15:00:00Z')), { from: '2026-11-30', to: '2026-12-04' });
  assert.deepEqual(earningsWeek(Date.parse('2026-11-30T03:00:00Z')), { from: '2026-11-30', to: '2026-12-04' }, 'Sunday night in New York');
});

test('earnings calendar: plain tickers, one row each, biggest revenue first', () => {
  const rows = readEarningsCalendar({
    earningsCalendar: [
      { symbol: 'SMALL', date: '2026-11-24', hour: 'amc', revenueEstimate: 1e6, epsEstimate: 0.1 },
      { symbol: 'BRK.B', date: '2026-11-24', hour: 'bmo', revenueEstimate: 9e10 },
      { symbol: 'BIG', date: '2026-11-25', hour: 'xyz', revenueEstimate: 5e10, epsEstimate: '1.25' },
      { symbol: 'BIG', date: '2026-11-25', hour: 'bmo', revenueEstimate: 5e10 },
      { symbol: 'NOREV', date: '2026-11-26', hour: 'bmo' },
      { symbol: 'BAD', date: 'soon' },
    ],
  });
  assert.deepEqual(rows.map((r) => r.symbol), ['BIG', 'SMALL', 'NOREV']);
  assert.equal(rows[0].hour, null);
  assert.equal(rows[0].epsEstimate, 1.25);
  assert.throws(() => readEarningsCalendar({}), /MALFORMED_CALENDAR/);
});

test('surprises and the biggest names', () => {
  assert.deepEqual(
    readSurprises([{ actual: 2, estimate: 1 }, { actual: 1, estimate: 1 }, { actual: null, estimate: 1 }, { actual: 3, estimate: 2 }]),
    { quarters: 3, beats: 2 },
  );
  assert.throws(() => readSurprises({}), /MALFORMED_SURPRISES/);
  assert.deepEqual(topEarnings([{ symbol: 'A' }, { symbol: 'B' }, { symbol: 'C' }], 2).map((p) => p.symbol), ['A', 'B']);
});

test('Tiingo returns and biotech against the market', () => {
  const day = (i) => new Date(Date.UTC(2026, 6, 1) + i * 86400000).toISOString();
  const series = (start, step) => Array.from({ length: 70 }, (_, i) => ({ date: day(i), adjClose: start + i * step }));
  const xbi = returns(readTiingo(series(100, 1)));
  assert.equal(xbi.close, 169);
  assert.equal(xbi.r1w, Math.round((169 / 164 - 1) * 10000) / 100);
  assert.equal(returns(readTiingo(series(100, 1).slice(0, 10))).r1m, null);
  assert.throws(() => readTiingo([{ date: day(0), adjClose: 1 }]), /SHORT_SERIES/);
  assert.throws(() => readTiingo({}), /MALFORMED_TIINGO/);
  const spy = returns(readTiingo(series(100, 0.5)));
  const bio = summarizeBio({ XBI: xbi, SPY: spy, [BIO[0]]: { ...spy, r1m: -3 }, [BIO[1]]: { ...xbi, r1m: 12 } });
  assert.equal(bio.relative.r1w, Math.round((xbi.r1w - spy.r1w) * 100) / 100);
  assert.deepEqual(bio.stocks.map((s) => s.symbol), [BIO[1], BIO[0]]);
  assert.throws(() => summarizeBio({ XBI: xbi }), /NO_BENCHMARK/);
});
