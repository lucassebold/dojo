'use strict';
// Real market data from DexScreener (free). The practice market uses it only as the starting point and as a slow
// "anchor" for the simulated prices: names, icons, liquidity, size and the real moves of each token.
const http = require('./http');

const DEX = 'https://api.dexscreener.com';
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
  return Object.keys(best).map(function (k) { return toSnapshot(best[k]); }).filter(function (s) { return s.price > 0; });
}

exports.stats = { calls: 0 };

// { mint: realSnapshot } for the mints that exist (30 per call).
exports.snapshots = async function (mints) {
  const out = {}; let failed = null, ok = 0;
  for (let i = 0; i < mints.length; i += 30) {
    try {
      exports.stats.calls++;
      bestPairs(await http.getJson(DEX + '/tokens/v1/solana/' + mints.slice(i, i + 30).join(','))).forEach(function (s) { out[s.mint] = s; });
      ok++;
    } catch (e) { failed = e; }
  }
  if (failed && !ok && mints.length) throw failed;
  return out;
};

const searchCache = {};
exports.search = async function (q) {
  const key = q.toLowerCase(), hit = searchCache[key];
  if (hit && Date.now() - hit.t < 20000) return hit.v;
  let list;
  try {
    exports.stats.calls++;
    const r = await http.getJson(DEX + '/latest/dex/search?q=' + encodeURIComponent(q));
    list = bestPairs(r.pairs).sort(function (a, b) { return b.liquidity - a.liquidity; }).slice(0, 12);
  } catch (e) { if (hit) return hit.v; throw e; }
  searchCache[key] = { t: Date.now(), v: list };
  if (Object.keys(searchCache).length > 500) Object.keys(searchCache).forEach(function (k) { delete searchCache[k]; });
  return list;
};

// Mints worth having in the practice market: boosted and newly profiled Solana tokens.
const SOURCES = ['/token-boosts/top/v1', '/token-boosts/latest/v1', '/token-profiles/latest/v1'];
exports.discover = async function () {
  const mints = [];
  const lists = await Promise.all(SOURCES.map(function (p) { exports.stats.calls++; return http.getJson(DEX + p).catch(function () { return null; }); }));
  if (!lists.some(Boolean)) throw new Error('No data');
  lists.forEach(function (l) {
    (l || []).forEach(function (b) { if (b && b.chainId === 'solana' && exports.isMint(b.tokenAddress) && mints.indexOf(b.tokenAddress) < 0) mints.push(b.tokenAddress); });
  });
  return mints;
};
