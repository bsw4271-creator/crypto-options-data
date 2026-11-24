import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInstrument, readChain, maxPain, atmIv, summarizeExpiry, ivRank, summarizeCurrency } from '../lib/options.mjs';

const NOW = Date.parse('2026-11-24T04:00:00Z'); // Tuesday
const row = (name, oi, iv, und = 90000, volume = 1) => ({ instrument_name: name, open_interest: oi, mark_iv: iv, underlying_price: und, volume });

test('instrument names: expiry at 08:00 UTC, strikes with d decimals, non-options rejected', () => {
  assert.deepEqual(parseInstrument('BTC-27NOV26-90000-C'), {
    currency: 'BTC', expiry: Date.parse('2026-11-27T08:00:00Z'), expiryDate: '2026-11-27', strike: 90000, type: 'call',
  });
  assert.equal(parseInstrument('XRP_USDC-5DEC26-2d5-P'), null, 'underscore currencies are out of scope');
  assert.equal(parseInstrument('ETH-5DEC26-3000-P').expiryDate, '2026-12-05');
  assert.equal(parseInstrument('BTC-PERPETUAL'), null);
  assert.equal(parseInstrument('BTC-27XXX26-1-C'), null);
});

test('chain: expired and unreadable rows dropped; empty or malformed chains throw', () => {
  const chain = readChain([row('BTC-24NOV26-90000-C', 5, 40), row('BTC-23NOV26-90000-C', 5, 40), { instrument_name: 'x' }], NOW);
  assert.deepEqual(chain.map((o) => o.expiryDate), ['2026-11-24']);
  assert.throws(() => readChain([row('BTC-20NOV26-1-C', 1, 1)], NOW), /EMPTY_CHAIN/);
  assert.throws(() => readChain({}, NOW), /MALFORMED_BOOK_SUMMARY/);
});

test('max pain is the strike minimising payout to holders', () => {
  const chain = readChain(
    [
      row('BTC-27NOV26-80000-P', 100, 50),
      row('BTC-27NOV26-90000-C', 10, 45),
      row('BTC-27NOV26-90000-P', 10, 45),
      row('BTC-27NOV26-100000-C', 100, 50),
    ],
    NOW,
  );
  // at 80k: calls pay 0, puts pay 10×10k = 100k; at 90k: puts 0, calls 0 → 0; at 100k: calls 10×10k = 100k
  assert.equal(maxPain(chain), 90000);
});

test('ATM IV uses the strike nearest the forward; expected move scales with √days', () => {
  const chain = readChain(
    [row('BTC-1DEC26-85000-C', 1, 60, 91000), row('BTC-1DEC26-90000-C', 1, 50, 91000), row('BTC-1DEC26-90000-P', 1, 54, 91000)],
    NOW,
  );
  assert.equal(atmIv(chain, 91000), 52);
  const e = summarizeExpiry(chain, 90000, NOW);
  assert.equal(e.expiry, '2026-12-01');
  assert.equal(e.days, 7.17);
  const move = 0.52 * Math.sqrt(7.1666667 / 365);
  assert.equal(e.expectedMovePct, Math.round(move * 10000) / 100);
  assert.equal(e.rangeLow, Math.round(90000 * (1 - move)));
  assert.equal(e.putCallOi, 0.5, 'two calls, one put');
});

test('IV rank and percentile over a year of DVOL closes', () => {
  const data = Array.from({ length: 365 }, (_, i) => [NOW - (365 - i) * 86400000, 0, 0, 0, 40 + (i % 41)]);
  data.push([NOW, 0, 0, 0, 50]);
  const r = ivRank(data);
  assert.equal(r.min, 40);
  assert.equal(r.max, 80);
  assert.equal(r.current, 50);
  assert.equal(r.rank, 25);
  assert.ok(r.percentile > 20 && r.percentile < 30);
  assert.throws(() => ivRank(data.slice(0, 10)), /SHORT_DVOL/);
  assert.throws(() => ivRank(null), /MALFORMED_DVOL/);
});

test('currency summary: overall ratios, this-week expiry skips same-day, largest open interest', () => {
  const chain = readChain(
    [
      row('BTC-24NOV26-90000-C', 50, 40), // expires today 08:00 → still alive at 04:00, but under a day
      row('BTC-24NOV26-90000-P', 50, 40),
      row('BTC-27NOV26-90000-C', 20, 45, 90000, 4),
      row('BTC-27NOV26-90000-P', 30, 47, 90000, 6),
      row('BTC-25DEC26-90000-C', 400, 50),
      row('BTC-25DEC26-90000-P', 200, 50),
    ],
    NOW,
  );
  const s = summarizeCurrency({ chain, spot: 90000, dvol: null, now: NOW });
  assert.equal(s.week.expiry, '2026-11-27');
  assert.equal(s.largest.expiry, '2026-12-25');
  assert.equal(s.putCallOi, Math.round((280 / 470) * 1000) / 1000);
  assert.equal(s.expiries.length, 3);
  assert.equal(s.totalOi, 750);
});
