'use strict';
// Free public market data behind shared caches. Every player reads the same cached copy, so the
// number of upstream calls depends on how many TOKENS are in play, not on how many people are online.
//   DexScreener  -> prices, liquidity, volume (batched, 30 mints per call)
//   GeckoTerminal -> candles (strict free limit: calls are queued and cached)
// If an upstream call fails we serve the last good copy instead of an error.
const http = require('./http');

const DEX = 'https://api.dexscreener.com';
const GECKO = 'https://api.geckoterminal.com/api/v2/networks/solana';
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
exports.isMint = function (s) { return typeof s === 'string' && MINT_RE.test(s); };

function num(x) { const n = Number(x); return isFinite(n) ? n : 0; }

function toSnapshot(p) {
  const tx = p.txns || {}, v = p.volume || {}, c = p.priceChange || {};
  return {
    mint: p.baseToken.address, symbol: (p.baseToken.symbol || '?').trim().slice(0, 14), name: (p.baseToken.name || '').trim().slice(0, 40),
    pair: p.pairAddress, dex: p.dexId, price: num(p.priceUsd), liquidity: num(p.liquidity && p.liquidity.usd), marketCap: num(p.marketCap || p.fdv),
    change: { m5: num(c.m5), h1: num(c.h1), h6: num(c.h6), h24: num(c.h24) },
    volume: { m5: num(v.m5), h1: num(v.h1), h6: num(v.h6), h24: num(v.h24) },
    buys24: num(tx.h24 && tx.h24.buys), sells24: num(tx.h24 && tx.h24.sells),
    createdAt: p.pairCreatedAt || 0, icon: (p.info && p.info.imageUrl) || null, t: Date.now()
  };
}

// For each mint keep the pair with the most liquidity.
function bestPairs(pairs) {
  const best = {};
  (pairs || []).forEach(function (p) {
    if (!p || p.chainId !== 'solana' || !p.baseToken) return;
    const k = p.baseToken.address, liq = num(p.liquidity && p.liquidity.usd);
    if (!best[k] || liq > num(best[k].liquidity && best[k].liquidity.usd)) best[k] = p;
  });
  return Object.keys(best).map(function (k) { return toSnapshot(best[k]); });
}

// ---- prices ----
const priceCache = {};
const stats = { dexCalls: 0, geckoCalls: 0, priceHits: 0 };
exports.stats = stats;

function prune() {
  const keys = Object.keys(priceCache);
  if (keys.length < 3000) return;
  const cut = Date.now() - 3600000;
  keys.forEach(function (k) { if (priceCache[k].t < cut) delete priceCache[k]; });
}

// maxAgeMs: how old a cached price may be. Returns { mint: snapshot } for the mints that exist.
exports.prices = async function (mints, maxAgeMs) {
  const out = {}, need = [], now = Date.now();
  mints.forEach(function (m) {
    const c = priceCache[m];
    if (c && now - c.t <= maxAgeMs) { out[m] = c; stats.priceHits++; } else if (exports.isMint(m)) need.push(m);
  });
  let failed = null;
  for (let i = 0; i < need.length; i += 30) {
    const chunk = need.slice(i, i + 30);
    try {
      stats.dexCalls++;
      const pairs = await http.getJson(DEX + '/tokens/v1/solana/' + chunk.join(','));
      bestPairs(pairs).forEach(function (s) { priceCache[s.mint] = s; });
    } catch (e) { failed = e; }
  }
  need.forEach(function (m) { if (priceCache[m]) out[m] = priceCache[m]; });
  if (failed && need.length && !need.some(function (m) { return out[m]; })) throw failed;
  prune();
  return out;
};

exports.search = (function () {
  const cache = {};
  return async function (q) {
    const key = q.toLowerCase();
    const hit = cache[key];
    if (hit && Date.now() - hit.t < 20000) return hit.v;
    let list;
    try {
      stats.dexCalls++;
      const r = await http.getJson(DEX + '/latest/dex/search?q=' + encodeURIComponent(q));
      list = bestPairs(r.pairs).sort(function (a, b) { return b.liquidity - a.liquidity; }).slice(0, 12);
    } catch (e) { if (hit) return hit.v; throw e; }
    list.forEach(function (s) { priceCache[s.mint] = s; });
    cache[key] = { t: Date.now(), v: list };
    if (Object.keys(cache).length > 500) { Object.keys(cache).forEach(function (k) { delete cache[k]; }); }
    return list;
  };
})();

let trendCache = { t: 0, list: [] };
exports.trending = async function () {
  if (Date.now() - trendCache.t < 60000) return trendCache.list;
  try {
    stats.dexCalls++;
    const boosts = await http.getJson(DEX + '/token-boosts/top/v1');
    const mints = [];
    boosts.forEach(function (b) { if (b.chainId === 'solana' && exports.isMint(b.tokenAddress) && mints.indexOf(b.tokenAddress) < 0) mints.push(b.tokenAddress); });
    const snaps = await exports.prices(mints.slice(0, 30), 0);
    const list = mints.map(function (m) { return snaps[m]; }).filter(function (s) { return s && s.liquidity >= 1000; }).slice(0, 24);
    trendCache = { t: Date.now(), list: list };
  } catch (e) { if (!trendCache.list.length) throw e; trendCache.t = Date.now() - 45000; } // serve the old list, retry in 15 s
  return trendCache.list;
};

// ---- candles ----
const RES = { '1m': ['minute', 1, 30000], '5m': ['minute', 5, 60000], '15m': ['minute', 15, 90000], '1h': ['hour', 1, 120000], '4h': ['hour', 4, 180000], 'D': ['day', 1, 300000] };
const candleCache = {};
let gate = Promise.resolve();
const GECKO_SPACING_MS = Number(process.env.GECKO_SPACING_MS) || 2300;

// All GeckoTerminal calls go through one queue with a minimum gap between them.
function gated(fn) {
  const run = gate.then(fn);
  gate = run.catch(function () {}).then(function () { return new Promise(function (r) { setTimeout(r, GECKO_SPACING_MS); }); });
  return run;
}

exports.candles = async function (pair, res) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pair)) throw new Error('Invalid pair');
  const r = RES[res] || RES['15m'];
  const key = pair + ':' + res, hit = candleCache[key];
  if (hit && Date.now() - hit.t < r[2]) return hit.v;
  if (hit && hit.pending) return hit.pending;
  const job = gated(async function () {
    stats.geckoCalls++;
    const j = await http.getJson(GECKO + '/pools/' + pair + '/ohlcv/' + r[0] + '?aggregate=' + r[1] + '&limit=300');
    const list = (j.data && j.data.attributes && j.data.attributes.ohlcv_list) || [];
    return list.map(function (c) { return { time: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] }; })
      .sort(function (a, b) { return a.time - b.time; });
  }).then(function (v) {
    candleCache[key] = { t: Date.now(), v: v };
    if (Object.keys(candleCache).length > 400) { Object.keys(candleCache).forEach(function (k) { if (Date.now() - candleCache[k].t > 600000) delete candleCache[k]; }); }
    return v;
  }).catch(function (e) {
    if (hit && hit.v) { candleCache[key] = { t: Date.now() - r[2] + 15000, v: hit.v }; return hit.v; } // stale copy, retry in 15 s
    delete candleCache[key];
    throw new Error(/429/.test(e.message) ? 'Chart data is busy right now. Try again in a few seconds.' : e.message);
  });
  candleCache[key] = { t: 0, v: hit ? hit.v : null, pending: job };
  return job;
};
