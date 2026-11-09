'use strict';
// Practice market. Tokens (names, icons, liquidity, size, real 5m/1h/6h/24h moves) are REAL, seeded from DexScreener.
// PRICES ARE SIMULATED here, once per second, so charts and numbers never freeze and never depend on a rate-limited API.
//
// How a price moves (log price, 1 s steps):
//   - a slow pull toward the real price (the "anchor"), so the simulation follows the real trend of each token
//   - its own slow wander around that price (an Ornstein-Uhlenbeck offset, about an hour long)
//   - noise whose size comes from the token: small pools and new pairs are much more volatile than big old ones
//   - volatility clustering: calm / normal / frenzy regimes; a frenzy is a pump or a dump with a drift, often followed by a retrace
//   - rare jumps with a heavy (Pareto) tail, slightly biased to the downside in thin pools
// Volume rises with the size of the moves, buys/sells follow the direction, liquidity moves with the price like an AMM pool.
// History for the chart (24 h) is generated as a Brownian bridge through the real 5m/1h/6h/24h price points.
// Nothing here is financial data: it is made for practice.

const SQRT60 = Math.sqrt(60);
const MAX_CANDLES = 4320;            // 3 days of 1-minute candles
const HISTORY_MIN = 1440;            // 24 h of history on a new token
const ANCHOR_PULL = 1 / 600;         // per second
const WANDER_TAU = 3600;             // seconds
const REGIME_VOL = [0.55, 1, 2.8];   // calm, normal, frenzy
const REGIME_VOLUME = [0.6, 1, 8];
const SUB_RES = { '1s': 1, '15s': 15, '30s': 30 };   // built from the per-second ticks
const MAX_TICKS = 3600;              // 1 hour of 1-second ticks per token
const RES_SEC = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, 'D': 86400 };

function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
function num(x) { const n = Number(x); return isFinite(n) ? n : 0; }

exports.mulberry32 = function (seed) {
  let a = seed >>> 0;
  return function () { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
};
function gauss(rng) { let u = 0; while (u === 0) u = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng()); }
function poisson(rng, n) {
  if (n <= 0) return 0;
  if (n >= 8) return Math.max(0, Math.round(n + gauss(rng) * Math.sqrt(n)));
  const L = Math.exp(-n); let k = 0, p = 1;
  do { k++; p *= rng(); } while (p > L);
  return k - 1;
}

// Volatility per minute (std of the log return). Thin pools and young pairs are wild; the real recent moves nudge it.
function minuteVol(real, ageH) {
  const liq = Math.max(real.liquidity, 500), c = real.change || {};
  const prior = 0.004 + 0.03 * 10000 / (liq + 10000);
  const r5 = Math.abs(Math.log(1 + clamp(num(c.m5), -95, 1000) / 100)) / Math.sqrt(5);
  const r60 = Math.abs(Math.log(1 + clamp(num(c.h1), -95, 1000) / 100)) / SQRT60;
  let s = clamp(0.5 * prior + 0.25 * r5 + 0.25 * r60, 0.5 * prior, Math.min(3 * prior, 0.02));
  if (ageH < 1) s *= 1.3;
  return Math.min(s, 0.025);
}

function volRate(real, m, liq) {   // real volume per minute, m minutes ago
  const v = real.volume || {};
  let r = m < 5 ? num(v.m5) / 5 : m < 60 ? (num(v.h1) - num(v.m5)) / 55 : m < 360 ? (num(v.h6) - num(v.h1)) / 300 : (num(v.h24) - num(v.h6)) / 1080;
  r = Math.max(r, num(v.h24) / 1440 * 0.1);
  return r > 0 ? r : Math.max(liq * 2e-5, 0.01);
}

exports.create = function (opts) {
  opts = opts || {};
  const rng = opts.rng || Math.random;
  const tokens = {};            // mint -> token
  const byPair = {};            // pair -> mint
  let lastStep = 0;
  const w = { tokens: tokens };

  function applyReal(t, real, nowMs) {
    const price = num(real.price);
    if (!(price > 0)) return false;
    t.real = { price: price, liquidity: num(real.liquidity), marketCap: num(real.marketCap), change: real.change || {}, volume: real.volume || {}, buys24: num(real.buys24), sells24: num(real.sells24) };
    if (t.real.marketCap > 0) t.supply = t.real.marketCap / price; else if (!t.supply) t.supply = 1e9;
    t.ageH = t.createdAt ? (nowMs - t.createdAt) / 3600000 : 999;
    const liq = t.real.liquidity;
    t.sigmaMin = minuteVol(t.real, t.ageH);
    t.sx = Math.min(0.25, 8 * t.sigmaMin) / Math.sqrt(WANDER_TAU / 2);
    t.jumpRate = (1 / 1500) * (1 + (t.ageH < 6 ? 1 : 0) + (liq < 20000 ? 1 : 0));
    t.downBias = liq < 20000 ? 0.58 : 0.5;
    t.vps = Math.max(num(t.real.volume.h1) / 3600, num(t.real.volume.h24) / 86400, liq * 1e-6);
    t.baseBuys = t.real.buys24; t.baseSells = t.real.sells24; t.simBuys = 0; t.simSells = 0;
    return true;
  }

  // 24 h of 1-minute candles through the real 5m / 1h / 6h / 24h price points (a Brownian bridge), ending at the real price now.
  function backfill(t, nowMs) {
    const real = t.real, P = real.price, c = real.change;
    const ageMin = t.createdAt ? Math.floor((nowMs - t.createdAt) / 60000) : HISTORY_MIN;
    const span = clamp(ageMin, 2, HISTORY_MIN);
    const at = function (chg) { const f = 1 + num(chg) / 100; return f > 0.02 ? P / f : null; };
    const pts = [[0, P]];
    [[5, c.m5], [60, c.h1], [360, c.h6]].forEach(function (a) { if (a[0] < span) { const p = at(a[1]); if (p) pts.push([a[0], p]); } });
    pts.push([span, at(c.h24) || P]);
    const lnp = pts.map(function (p) { return [p[0], Math.log(p[1])]; }).sort(function (a, b) { return b[0] - a[0]; });   // oldest first
    const ln = new Array(span + 1);
    ln[lnp[0][0]] = lnp[0][1];
    let reg = 1;
    for (let s = 0; s < lnp.length - 1; s++) {
      const ma = lnp[s][0], la = lnp[s][1], mb = lnp[s + 1][0], lb = lnp[s + 1][1], n = ma - mb;
      if (n <= 0) continue;
      const inc = []; let sum = 0;
      for (let i = 0; i < n; i++) {
        const r = rng();
        if (reg === 1) { if (r < 0.03) reg = 2; else if (r < 0.2) reg = 0; } else if (reg === 0) { if (r < 0.35) reg = 1; } else if (r < 0.4) reg = 1;
        let z = gauss(rng) * t.sigmaMin * REGIME_VOL[reg];
        if (rng() < t.jumpRate * 60) z += (rng() < t.downBias ? -1 : 1) * Math.min(12, 1.5 * Math.pow(1 - rng(), -1 / 2.2)) * t.sigmaMin;
        inc.push(z); sum += z;
      }
      let cum = 0;
      for (let i = 1; i <= n; i++) { cum += inc[i - 1]; ln[ma - i] = la + cum + (lb - la - sum) * (i / n); }
    }
    const nowMin = Math.floor(nowMs / 60000), candles = [];
    for (let m = span; m >= 0; m--) {
      const o = Math.exp(m === span ? ln[span] : ln[m + 1]), cl = Math.exp(ln[m]);
      const ret = Math.abs(Math.log(cl / o)), wick = t.sigmaMin * 0.3;
      const vol = volRate(real, m, real.liquidity) * Math.exp(0.6 * gauss(rng) - 0.18) * (1 + 2 * Math.min(5, ret / t.sigmaMin)) / 2.6;
      candles.push({
        time: (nowMin - m) * 60, open: o, close: cl,
        high: Math.max(o, cl) * Math.exp(Math.abs(gauss(rng)) * wick), low: Math.min(o, cl) * Math.exp(-Math.abs(gauss(rng)) * wick), volume: vol
      });
    }
    t.candles = candles;
    t.lnP = ln[0];
  }

  w.add = function (seed, nowMs) {
    nowMs = nowMs || Date.now();
    const old = tokens[seed.mint];
    if (old) { applyReal(old, seed, nowMs); return old; }
    const t = {
      mint: seed.mint, symbol: seed.symbol, name: seed.name, icon: seed.icon || null, pair: seed.pair, dex: seed.dex || '', createdAt: seed.createdAt || 0,
      x: 0, lf: 1, regime: 1, drift: 0, retraceLeft: 0, frenzyDir: 1, lastBuys: 0, lastSells: 0, addedAt: nowMs, viewedAt: nowMs, snap: null
    };
    if (!applyReal(t, seed, nowMs)) return null;
    backfill(t, nowMs);
    t.athP = t.candles.reduce(function (m, c) { return c.high > m ? c.high : m; }, 0);
    seedTicks(t, nowMs);
    tokens[t.mint] = t; byPair[t.pair] = t.mint;
    if (!lastStep) lastStep = nowMs;
    t.snap = snapshotOf(t, nowMs);
    return t;
  };
  w.setReal = function (mint, real, nowMs) { const t = tokens[mint]; return t ? applyReal(t, real, nowMs || Date.now()) : false; };
  w.has = function (mint) { return !!tokens[mint]; };
  w.get = function (mint) { return tokens[mint] || null; };
  w.mintOfPair = function (pair) { return byPair[pair] || null; };
  w.touch = function (mint, nowMs) { if (tokens[mint]) tokens[mint].viewedAt = nowMs || Date.now(); };
  w.size = function () { return Object.keys(tokens).length; };
  w.mints = function () { return Object.keys(tokens); };
  w.remove = function (mint) { const t = tokens[mint]; if (t) { delete byPair[t.pair]; delete tokens[mint]; } };

  // The last ~10 minutes at 1-second resolution, drawn inside each 1-minute candle (a bridge from its open to its close that
  // touches its high and low), so the 1s / 15s / 30s charts have history from the first second.
  function seedTicks(t, nowMs) {
    const nowSec = Math.floor(nowMs / 1000), tk = { T: [], P: [], V: [], B: [], S: [] }, n = t.candles.length;
    for (let i = Math.max(0, n - 11); i < n; i++) {
      const c = t.candles[i], last = i === n - 1, secs = last ? Math.max(1, nowSec - c.time + 1) : 60;
      const o = Math.log(c.open), cl = last ? t.lnP : Math.log(c.close), lo = Math.log(c.low), hi = Math.log(c.high);
      const sdv = Math.max(hi - lo, 1e-9) / (2 * Math.sqrt(secs)), iHi = Math.floor(rng() * secs), iLo = Math.floor(rng() * secs);
      const w = new Array(secs); let acc = 0;
      for (let k = 0; k < secs; k++) { acc += gauss(rng); w[k] = acc; }
      for (let k = 0; k < secs; k++) {
        const f = secs > 1 ? k / (secs - 1) : 1;
        let x = clamp(o + (cl - o) * f + sdv * (w[k] - f * w[secs - 1]), lo, hi);
        if (k === iHi) x = hi; if (k === iLo) x = lo;
        if (k === 0) x = o; if (k === secs - 1) x = cl;
        const v = c.volume / 60 * Math.exp(0.5 * gauss(rng) - 0.125), trades = poisson(rng, v / clamp(t.real.liquidity * 0.003, 15, 400));
        const b = Math.round(trades * clamp(0.5 + 0.1 * gauss(rng), 0.3, 0.7));
        tk.T.push(c.time + k); tk.P.push(Math.exp(x)); tk.V.push(v); tk.B.push(b); tk.S.push(trades - b);
      }
    }
    t.ticks = tk;
  }
  function pushTick(t, sec, price, v, b, s) {
    const tk = t.ticks, i = tk.T.length - 1;
    if (i >= 0 && sec <= tk.T[i]) { tk.P[i] = price; tk.V[i] += v; tk.B[i] += b; tk.S[i] += s; return; }
    tk.T.push(sec); tk.P.push(price); tk.V.push(v); tk.B.push(b); tk.S.push(s);
    if (tk.T.length > MAX_TICKS + 200) { const cut = tk.T.length - MAX_TICKS; tk.T.splice(0, cut); tk.P.splice(0, cut); tk.V.splice(0, cut); tk.B.splice(0, cut); tk.S.splice(0, cut); }
  }
  function subBars(t, step, limit) {
    const tk = t.ticks, out = [];
    let cur = null;
    for (let i = 0; i < tk.T.length; i++) {
      const bt = Math.floor(tk.T[i] / step) * step, p = tk.P[i];
      if (!cur || cur.time !== bt) { const o = cur ? cur.close : (i ? tk.P[i - 1] : p); cur = { time: bt, open: o, high: Math.max(o, p), low: Math.min(o, p), close: p, volume: tk.V[i] }; out.push(cur); }
      else { if (p > cur.high) cur.high = p; if (p < cur.low) cur.low = p; cur.close = p; cur.volume += tk.V[i]; }
    }
    return out.slice(-limit);
  }

  function roll(t, sec) {    // keep one candle per minute, no gaps
    const mt = Math.floor(sec / 60) * 60;
    let last = t.candles[t.candles.length - 1];
    while (last.time < mt) { const p = last.close; last = { time: last.time + 60, open: p, high: p, low: p, close: p, volume: 0 }; t.candles.push(last); }
    if (t.candles.length > MAX_CANDLES) t.candles.splice(0, t.candles.length - MAX_CANDLES);
    return last;
  }

  function stepToken(t, ms) {
    const sig = t.sigmaMin / SQRT60, real = t.real, m5 = num(real.change.m5);
    // regime
    const r = rng();
    if (t.regime === 1) {
      const pF = (1 / 3000) * (t.ageH < 6 ? 2 : 1) * (Math.abs(m5) > 20 ? 2 : 1);
      if (r < pF) {
        t.regime = 2; t.frenzyDir = rng() < clamp(0.5 + 0.004 * m5, 0.3, 0.75) ? 1 : -1; t.drift = t.frenzyDir * sig * (0.2 + 0.4 * rng()); t.retraceLeft = 0;
      } else if (r < pF + 1 / 200) t.regime = 0;
    } else if (t.regime === 0) { if (r < 1 / 150) t.regime = 1; }
    else if (r < 1 / 75) {
      t.regime = 1; t.drift = 0;
      if (rng() < 0.6) { t.retraceLeft = 60 + Math.floor(rng() * 90); t.drift = -t.frenzyDir * 0.3 * sig; }   // pumps and dumps give some back
    }
    if (t.regime !== 2 && t.retraceLeft > 0 && --t.retraceLeft === 0) t.drift = 0;

    const lnReal = Math.log(real.price);
    let d = ANCHOR_PULL * (lnReal + t.x - t.lnP) + t.drift + sig * REGIME_VOL[t.regime] * gauss(rng);
    if (rng() < t.jumpRate) d += (rng() < t.downBias ? -1 : 1) * Math.min(12, 1.5 * Math.pow(1 - rng(), -1 / 2.2)) * t.sigmaMin;
    t.lnP = clamp(t.lnP + d, lnReal - 3, lnReal + 3);
    t.x += -t.x / WANDER_TAU + t.sx * gauss(rng);
    t.lf = clamp(t.lf + (1 - t.lf) / 1800 + 0.0008 * gauss(rng), 0.7, 1.3);

    const price = Math.exp(t.lnP), c = roll(t, ms / 1000);
    c.close = price; if (price > c.high) c.high = price; if (price < c.low) c.low = price;
    const act = 1 + 1.5 * Math.min(6, Math.abs(d) / sig);
    const v = t.vps * REGIME_VOLUME[t.regime] * Math.exp(0.5 * gauss(rng) - 0.125) * act / 2.2;
    c.volume += v;
    const liq = real.liquidity * Math.sqrt(price / real.price) * t.lf;
    const trades = poisson(rng, v / clamp(liq * 0.003, 15, 400)), share = 0.5 + 0.15 * clamp(d / (2 * sig), -1, 1);
    const b = Math.round(trades * share);
    t.simBuys += b; t.simSells += trades - b;
    if (price > t.athP) t.athP = price;
    pushTick(t, Math.floor(ms / 1000), price, v, b, trades - b);
  }

  function snapshotOf(t, nowMs) {
    const n = t.candles.length, price = Math.exp(t.lnP);
    const ref = function (m) { return t.candles[Math.max(0, n - 1 - m)].open; };
    const chg = function (m) { const p0 = ref(m); return p0 > 0 ? (price / p0 - 1) * 100 : 0; };
    const sumV = function (m) { let s = 0; for (let i = Math.max(0, n - m); i < n; i++) s += t.candles[i].volume; return s; };
    const tk = t.ticks, from = Math.max(0, tk.T.length - 300), flow = { vol: 0, buys: 0, sells: 0, buyVol: 0, sellVol: 0 };
    for (let i = from; i < tk.T.length; i++) {
      const tr = tk.B[i] + tk.S[i], share = tr ? tk.B[i] / tr : 0.5;
      flow.vol += tk.V[i]; flow.buys += tk.B[i]; flow.sells += tk.S[i]; flow.buyVol += tk.V[i] * share; flow.sellVol += tk.V[i] * (1 - share);
    }
    t.lastBuys = Math.max(t.lastBuys, t.baseBuys + t.simBuys); t.lastSells = Math.max(t.lastSells, t.baseSells + t.simSells);
    return {
      mint: t.mint, symbol: t.symbol, name: t.name, pair: t.pair, dex: t.dex, price: price,
      liquidity: t.real.liquidity * Math.sqrt(price / t.real.price) * t.lf, marketCap: price * t.supply,
      change: { m5: chg(5), h1: chg(60), h6: chg(360), h24: chg(1440) },
      volume: { m5: flow.vol, h1: sumV(60), h6: sumV(360), h24: sumV(1440) },   // 5m comes from the exact last 300 s of ticks
      buys24: t.lastBuys, sells24: t.lastSells, createdAt: t.createdAt, icon: t.icon, t: nowMs, sim: true,
      supply: t.supply, ath: Math.max(t.athP, price) * t.supply, flow5m: flow
    };
  }

  // Advance every token to nowMs in 1-second steps (at most 5 minutes of catch-up), then refresh the snapshots once.
  w.step = function (nowMs) {
    if (!lastStep) { lastStep = nowMs; return; }
    let n = Math.floor((nowMs - lastStep) / 1000);
    if (n <= 0) return;
    if (n > 300) { lastStep = nowMs - 300000; n = 300; }
    const list = Object.keys(tokens).map(function (k) { return tokens[k]; });
    for (let i = 1; i <= n; i++) { const ms = lastStep + i * 1000; for (let j = 0; j < list.length; j++) stepToken(list[j], ms); }
    lastStep += n * 1000;
    for (let j = 0; j < list.length; j++) list[j].snap = snapshotOf(list[j], nowMs);
  };

  w.snapshot = function (mint) { const t = tokens[mint]; return t ? t.snap : null; };
  w.list = function () { return Object.keys(tokens).map(function (k) { return tokens[k].snap; }); };

  // Candles for a period, built from the 1-minute candles (the last one is still forming).
  w.bars = function (mint, res, limit) {
    const t = tokens[mint]; if (!t) return null;
    if (SUB_RES[res]) return subBars(t, SUB_RES[res], clamp(Math.floor(num(limit)) || 300, 1, 300));
    const step = RES_SEC[res] || RES_SEC['15m'], out = [];
    let cur = null;
    for (let i = 0; i < t.candles.length; i++) {
      const c = t.candles[i], bt = Math.floor(c.time / step) * step;
      if (!cur || cur.time !== bt) { cur = { time: bt, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }; out.push(cur); }
      else { if (c.high > cur.high) cur.high = c.high; if (c.low < cur.low) cur.low = c.low; cur.close = c.close; cur.volume += c.volume; }
    }
    return out.slice(-clamp(Math.floor(num(limit)) || 300, 1, 300));
  };

  return w;
};
