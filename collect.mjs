// Collects BTC and ETH option data from Deribit's public API and writes data/os/options-v1.json for the OS.
// Public GETs only, no keys. A failed currency keeps its previous block and is listed in run.failed.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { SCHEMA, readChain, ivRank, summarizeCurrency } from './lib/options.mjs';

const API = 'https://www.deribit.com/api/v2/public';
const OUT = new URL('./data/os/options-v1.json', import.meta.url);
const CURRENCIES = ['BTC', 'ETH'];

async function get(path) {
  const res = await fetch(`${API}/${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP_${res.status}`);
  const body = await res.json();
  if (body?.error) throw new Error(`DERIBIT_${body.error.code ?? 'ERROR'}`);
  return body.result;
}

async function collect(currency, now) {
  const [book, index, dvol] = await Promise.all([
    get(`get_book_summary_by_currency?currency=${currency}&kind=option`),
    get(`get_index_price?index_name=${currency.toLowerCase()}_usd`),
    get(`get_volatility_index_data?currency=${currency}&resolution=1D&start_timestamp=${now - 366 * 86_400_000}&end_timestamp=${now}`),
  ]);
  const spot = Number(index?.index_price);
  if (!(spot > 0)) throw new Error('MALFORMED_INDEX');
  return summarizeCurrency({ chain: readChain(book, now), spot, dvol: ivRank(dvol?.data), now });
}

const now = Date.now();
let previous = null;
try {
  previous = JSON.parse(readFileSync(OUT, 'utf8'));
} catch {}
const out = { schema: SCHEMA, source: 'Deribit public API', run: { runAt: new Date(now).toISOString(), failed: [] }, assets: {} };
for (const c of CURRENCIES) {
  try {
    out.assets[c] = { ...(await collect(c, now)), updatedAt: out.run.runAt };
  } catch (e) {
    out.run.failed.push({ asset: c, error: e instanceof Error ? e.message : 'UNAVAILABLE' });
    if (previous?.assets?.[c]) out.assets[c] = previous.assets[c];
  }
}
mkdirSync(new URL('./data/os/', import.meta.url), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
console.log(`options: ${Object.keys(out.assets).join(', ') || 'none'}; failed: ${out.run.failed.map((f) => `${f.asset} ${f.error}`).join(', ') || 'none'}`);
if (out.run.failed.length === CURRENCIES.length && !previous) process.exitCode = 1;
