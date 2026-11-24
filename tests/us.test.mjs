import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nyOffset, closeUtc, parseOcc, readCboe, straddlePct, summarizeEquity, earningsMove, earningsWeek,
  readEarningsCalendar, readSurprises, pickEarnings, readTiingo, returns, summarizeBio, BIO,
} from '../lib/us.mjs';

const NOW = Date.parse('2026-11-24T15:00:00Z'); // Tuesday 10:00 in New York
const opt = (option, oi, iv, bid, ask, volume = 1) => ({ option, open_interest: oi, iv, bid, ask, volume });
const body = (options, price = 100) => ({ timestamp: 'x', data: { symbol: 'ABC', current_price: price, iv30: 31.2, options } });

test('New York close: 16:00 local, summer and winter time', () => {
  assert.equal(nyOffset('2026-11-27'), -5);
  assert.equal(nyOffset('2026-07-17'), -4);
  assert.equal(new Date(closeUtc('2026-11-27')).toISOString(), '2026-11-27T21:00:00.000Z');
  assert.equal(new Date(closeUtc('2026-07-17')).toISOString(), '2026-07-17T20:00:00.000Z');
});

test('OCC names: root must match, strike in thousandths', () => {
  assert.deepEqual(parseOcc('SPY261127C00600500', 'SPY'), { expiryDate: '2026-11-27', strike: 600.5, type: 'call' });
  assert.equal(parseOcc('SPY1261127C00600000', 'SPY'), null, 'adjusted roots are left out');
  assert.equal(parseOcc('QQQ261127P00500000', 'SPY'), null);
  assert.equal(parseOcc('garbage', 'SPY'), null);
});

test('Cboe chain: expired dropped, IV to percent, mid only from a sane quote', () => {
  const q = readCboe(
    body([
      opt('ABC261127C00100000', 10, 0.5, 2, 2.4),
      opt('ABC261120C00100000', 10, 0.5, 2, 2.4),
      opt('ABC261127P00100000', 20, 0.52, 0, 0),
      opt('ABC261127P00095000', 5, 0, 1, 0.5),
    ]),
    'ABC',
    NOW,
  );
  assert.equal(q.spot, 100);
  assert.equal(q.chain.length, 3);
  assert.equal(q.chain[0].markIv, 50);
  assert.equal(q.chain[0].mid, 2.2);
  assert.equal(q.chain[1].mid, null, 'zero ask is no quote');
  assert.equal(q.chain[2].markIv, null);
  assert.equal(q.chain[2].mid, null, 'ask below bid is no quote');
  assert.throws(() => readCboe({ data: { current_price: 1, options: [] } }, 'ABC', NOW), /EMPTY_CHAIN/);
  assert.throws(() => readCboe({}, 'ABC', NOW), /MALFORMED_CBOE/);
  assert.throws(() => readCboe(body([], 0), 'ABC', NOW), /NO_SPOT/);
});

test('equity summary: Friday weekly, put/call, straddle and max pain', () => {
  const q = readCboe(
    body([
      opt('ABC261125C00100000', 1, 0.4, 1, 1.2), // Wednesday daily, not "this week"
      opt('ABC261125P00100000', 1, 0.4, 1, 1.2),
      opt('ABC261127C00100000', 10, 0.5, 2, 2.4),
      opt('ABC261127P00100000', 20, 0.5, 1.6, 2),
      opt('ABC261127C00110000', 30, 0.6, 0.2, 0.3),
    ]),
    'ABC',
    NOW,
  );
  const s = summarizeEquity(q, NOW);
  assert.equal(s.iv30, 31.2);
  assert.equal(s.week.expiry, '2026-11-27');
  assert.equal(s.week.putCallOi, 0.5, '20 puts / 40 calls');
  assert.equal(s.week.straddlePct, 4, '(2.2 + 1.8) / 100');
  assert.equal(s.week.maxPain, 100);
  assert.equal(s.week.atmIv, 50);
  assert.equal(s.expiries[0].expiry, '2026-11-25');
  assert.equal(straddlePct([], 100), null);
});

test('earnings move: after-close reports need the next expiry', () => {
  const { chain, spot } = readCboe(
    body([
      opt('ABC261125C00100000', 1, 0.4, 1, 1.2),
      opt('ABC261125P00100000', 1, 0.4, 1, 1.2),
      opt('ABC261127C00100000', 1, 0.8, 3, 3.4),
      opt('ABC261127P00100000', 3, 0.8, 2.8, 3.2),
    ]),
    'ABC',
    NOW,
  );
  assert.equal(earningsMove(chain, spot, '2026-11-25', 'bmo').expiry, '2026-11-25');
  const amc = earningsMove(chain, spot, '2026-11-25', 'amc');
  assert.equal(amc.expiry, '2026-11-27');
  assert.equal(amc.movePct, 6.2);
  assert.equal(amc.putCallOi, 3);
  assert.equal(earningsMove(chain, spot, '2026-12-01', 'amc'), null);
});

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

test('surprises and picking by open interest', () => {
  assert.deepEqual(
    readSurprises([{ actual: 2, estimate: 1 }, { actual: 1, estimate: 1 }, { actual: null, estimate: 1 }, { actual: 3, estimate: 2 }]),
    { quarters: 3, beats: 2 },
  );
  assert.throws(() => readSurprises({}), /MALFORMED_SURPRISES/);
  const picked = pickEarnings(
    [
      { symbol: 'A', date: '2026-11-26', totalOi: 50 },
      { symbol: 'B', date: '2026-11-24', totalOi: 10 },
      { symbol: 'C', date: '2026-11-24', totalOi: 90 },
      { symbol: 'D', date: '2026-11-25', totalOi: 0 },
    ],
    2,
  );
  assert.deepEqual(picked.map((p) => p.symbol), ['C', 'A'], 'top two by open interest, then by date');
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
