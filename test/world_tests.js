'use strict';
// Statistical tests of the price simulator (src/world.js). Seeded, so they are reproducible. Run: node test/world_tests.js
const assert = require('assert');
const World = require('../src/world');

const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);
const SEEDS = {
  big:   { mint: 'BIG',   symbol: 'BIG', liquidity: 900000, price: 0.5,     marketCap: 80e6,   createdAt: NOW - 90 * 86400e3, change: { m5: 0.3, h1: 1.2, h6: -2, h24: 4 },     volume: { m5: 20000, h1: 250000, h6: 1.4e6, h24: 5e6 },     buys24: 8000, sells24: 7500 },
  mid:   { mint: 'MID',   symbol: 'MID', liquidity: 120000, price: 0.004,   marketCap: 4e6,    createdAt: NOW - 10 * 86400e3, change: { m5: 2, h1: 8, h6: -12, h24: 35 },       volume: { m5: 9000, h1: 90000, h6: 500000, h24: 1.5e6 },   buys24: 4000, sells24: 3800 },
  thin:  { mint: 'THIN',  symbol: 'NEW', liquidity: 12000,  price: 0.00002, marketCap: 20000,  createdAt: NOW - 3 * 3600e3,   change: { m5: 12, h1: 60, h6: 180, h24: 180 },    volume: { m5: 4000, h1: 30000, h6: 60000, h24: 60000 },   buys24: 900, sells24: 700 },
  dump:  { mint: 'DUMP',  symbol: 'DMP', liquidity: 30000,  price: 0.0003,  marketCap: 300000, createdAt: NOW - 2 * 86400e3,  change: { m5: -4, h1: -25, h6: -55, h24: -70 },   volume: { m5: 2000, h1: 20000, h6: 90000, h24: 200000 },   buys24: 1500, sells24: 2600 }
};
Object.keys(SEEDS).forEach(function (k) { SEEDS[k].pair = 'P' + SEEDS[k].mint; });

function mkWorld(seed) { const w = World.create({ rng: World.mulberry32(seed) }); Object.keys(SEEDS).forEach(function (k) { w.add(SEEDS[k], NOW); }); return w; }
// Runs the world for `hours`, sampling every minute. Returns per-token arrays of log prices.
function run(w, hours) {
  const lnp = {}; Object.keys(SEEDS).forEach(function (k) { lnp[k] = []; });
  let t = NOW;
  for (let i = 0; i < hours * 3600; i++) {
    t += 1000; w.step(t);
    if (i % 60 === 59) Object.keys(SEEDS).forEach(function (k) { lnp[k].push(Math.log(w.snapshot(SEEDS[k].mint).price)); });
  }
  return lnp;
}
function returns(a) { return a.slice(1).map(function (x, i) { return x - a[i]; }); }
function mean(a) { return a.reduce(function (s, x) { return s + x; }, 0) / a.length; }
function sd(a) { const m = mean(a); return Math.sqrt(mean(a.map(function (x) { return (x - m) * (x - m); }))); }
function kurtosis(a) { const m = mean(a), v = mean(a.map(function (x) { return (x - m) * (x - m); })); return mean(a.map(function (x) { return Math.pow(x - m, 4); })) / (v * v); }

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

test('history passes through the real 5m / 1h / 6h / 24h moves', function () {
  const w = mkWorld(1);
  Object.keys(SEEDS).forEach(function (k) {
    const s = w.snapshot(SEEDS[k].mint);
    ['m5', 'h1', 'h6', 'h24'].forEach(function (p) {
      const real = SEEDS[k].change[p];
      if (p === 'm5' || p === 'h1') assert.ok(Math.abs(s.change[p] - real) < Math.max(6, Math.abs(real) * 0.35), k + ' ' + p + ': sim ' + s.change[p].toFixed(1) + ' vs real ' + real);
      else assert.ok(Math.abs(s.change[p] - real) < Math.max(4, Math.abs(real) * 0.1), k + ' ' + p + ': sim ' + s.change[p].toFixed(1) + ' vs real ' + real);
    });
    near(s.price, SEEDS[k].price, SEEDS[k].price * 1e-9);
  });
});

test('candles are valid: sorted, one per minute, high/low contain open/close, nothing NaN', function () {
  const w = mkWorld(2); run(w, 3);
  Object.keys(SEEDS).forEach(function (k) {
    const bars = w.bars(SEEDS[k].mint, '1m', 300);
    assert.strictEqual(bars.length, 300);
    bars.forEach(function (c, i) {
      assert.ok([c.open, c.high, c.low, c.close, c.volume].every(isFinite) && c.low > 0 && c.volume >= 0, k + ' bad candle ' + JSON.stringify(c));
      assert.ok(c.high >= Math.max(c.open, c.close) - 1e-15 && c.low <= Math.min(c.open, c.close) + 1e-15, k + ' high/low do not contain the body');
      if (i) assert.strictEqual(c.time - bars[i - 1].time, 60);
    });
  });
});

test('bigger periods are built from the 1-minute candles (open, high, low, close, volume)', function () {
  const w = mkWorld(3); run(w, 2);
  const m1 = w.bars('MID', '1m', 300), m5 = w.bars('MID', '5m', 300);
  const grp = m1.filter(function (c) { return c.time >= m5[m5.length - 2].time && c.time < m5[m5.length - 2].time + 300; });
  assert.strictEqual(grp.length, 5);
  const b = m5[m5.length - 2];
  near(b.open, grp[0].open, 1e-15); near(b.close, grp[4].close, 1e-15);
  near(b.high, Math.max.apply(null, grp.map(function (c) { return c.high; })), 1e-15);
  near(b.low, Math.min.apply(null, grp.map(function (c) { return c.low; })), 1e-15);
  near(b.volume, grp.reduce(function (s, c) { return s + c.volume; }, 0), 1e-6);
});

test('volatility follows liquidity and age: thin and new pools are much wilder than big old ones', function () {
  const w = mkWorld(4), lnp = run(w, 12), s = {};
  Object.keys(SEEDS).forEach(function (k) { s[k] = sd(returns(lnp[k])); });
  assert.ok(s.thin > s.mid * 1.8 && s.mid > s.big * 1.8, 'sd per minute: big ' + s.big.toFixed(4) + ' mid ' + s.mid.toFixed(4) + ' thin ' + s.thin.toFixed(4));
  assert.ok(s.big > 0.001 && s.big < 0.012, 'a liquid token moves tenths of a percent per minute, got ' + s.big);
  assert.ok(s.thin > 0.012 && s.thin < 0.09, 'a thin new token moves a few percent per minute, got ' + s.thin);
});

test('returns have fat tails (pumps, dumps, jumps), like real memecoins', function () {
  const w = mkWorld(5), lnp = run(w, 24);
  ['big', 'mid', 'thin', 'dump'].forEach(function (k) { const kt = kurtosis(returns(lnp[k])); assert.ok(kt > 4, k + ' kurtosis ' + kt.toFixed(1) + ' should be well above the normal 3'); });
});

test('prices follow the real price and stay in a sane band, never negative or NaN', function () {
  const w = mkWorld(6), lnp = run(w, 24);
  Object.keys(SEEDS).forEach(function (k) {
    const ratio = lnp[k].map(function (x) { return Math.exp(x) / SEEDS[k].price; });
    assert.ok(ratio.every(function (r) { return isFinite(r) && r > 0; }));
    const lo = Math.min.apply(null, ratio), hi = Math.max.apply(null, ratio);
    const bound = k === 'big' ? [0.8, 1.25] : k === 'mid' ? [0.6, 1.6] : [0.15, 6];
    assert.ok(lo > bound[0] && hi < bound[1], k + ' wandered to ' + lo.toFixed(2) + 'x - ' + hi.toFixed(2) + 'x of the real price');
  });
});

test('volume rises with the size of the moves and stays near the real level', function () {
  const w = mkWorld(7); run(w, 6);
  const bars = w.bars('MID', '1m', 300), rets = bars.map(function (c) { return Math.abs(Math.log(c.close / c.open)); }), vols = bars.map(function (c) { return c.volume; });
  const mr = mean(rets), mv = mean(vols);
  const cov = mean(rets.map(function (r, i) { return (r - mr) * (vols[i] - mv); })), corr = cov / (sd(rets) * sd(vols));
  assert.ok(corr > 0.2, '|return| and volume should correlate, got ' + corr.toFixed(2));
  const h1 = w.snapshot('MID').volume.h1;
  assert.ok(h1 > SEEDS.mid.volume.h1 * 0.3 && h1 < SEEDS.mid.volume.h1 * 3, 'simulated 1h volume ' + Math.round(h1) + ' vs real ' + SEEDS.mid.volume.h1);
});

test('the 5m / 1h / 6h / 24h changes in the snapshot agree with the chart candles', function () {
  const w = mkWorld(8); run(w, 8);
  const s = w.snapshot('DUMP'), m1 = w.bars('DUMP', '1m', 300);
  const p60 = m1[m1.length - 1 - 60].open;
  near(s.change.h1, (s.price / p60 - 1) * 100, 1e-6);
});

test('same seed, same market; different seed, different market', function () {
  const a = mkWorld(9), b = mkWorld(9), c = mkWorld(10);
  const ra = run(a, 1), rb = run(b, 1), rc = run(c, 1);
  assert.deepStrictEqual(ra.mid, rb.mid);
  assert.notDeepStrictEqual(ra.mid, rc.mid);
});

test('catching up after a long pause does not stall or explode', function () {
  const w = mkWorld(11), before = w.snapshot('MID').price;
  w.step(NOW + 3 * 3600 * 1000);          // 3 hours in one call: it catches up at most 5 minutes
  const s = w.snapshot('MID');
  assert.ok(isFinite(s.price) && s.price > before * 0.5 && s.price < before * 2);
  assert.ok(w.bars('MID', '1m', 300).every(function (c, i, a) { return !i || c.time - a[i - 1].time === 60; }), 'no gaps in the candles');
});

test('1s / 15s / 30s candles exist from the start, are valid and stay inside their 1-minute candle', function () {
  const w = mkWorld(12); run(w, 1);
  ['big', 'mid', 'thin', 'dump'].forEach(function (k) {
    const mint = SEEDS[k].mint, m1 = w.bars(mint, '1m', 300);
    ['1s', '15s', '30s'].forEach(function (res) {
      const bars = w.bars(mint, res, 300), step = { '1s': 1, '15s': 15, '30s': 30 }[res];
      assert.ok(bars.length >= (res === '1s' ? 250 : 20), k + ' ' + res + ' has ' + bars.length + ' candles');
      bars.forEach(function (c, i) {
        assert.ok([c.open, c.high, c.low, c.close, c.volume].every(isFinite) && c.low > 0 && c.high >= Math.max(c.open, c.close) - 1e-15 && c.low <= Math.min(c.open, c.close) + 1e-15, k + ' ' + res + ' bad candle');
        if (i) assert.ok(c.time > bars[i - 1].time && (c.time - bars[i - 1].time) % step === 0);
      });
    });
    // a 15 s candle in the middle of the hour sits inside the 1-minute candle that contains it
    const s15 = w.bars(mint, '15s', 300), c = s15[s15.length - 30], parent = m1.filter(function (b) { return b.time <= c.time && c.time < b.time + 60; })[0];
    assert.ok(parent && c.high <= parent.high * 1.0000001 && c.low >= parent.low * 0.9999999, k + ' 15s candle escapes its minute');
  });
});

test('5-minute flow (volume, buys, sells) and the all-time high are consistent', function () {
  const w = mkWorld(13); run(w, 2);
  ['big', 'mid', 'thin', 'dump'].forEach(function (k) {
    const s = w.snapshot(SEEDS[k].mint), f = s.flow5m;
    assert.ok(f.vol > 0 && f.buys > 0 && f.sells > 0, k + ' has no flow');
    near(f.buyVol + f.sellVol, f.vol, f.vol * 1e-9 + 1e-9);
    assert.ok(Math.abs(f.vol / s.volume.m5 - 1) < 0.2, k + ' 5m flow volume ' + f.vol + ' vs 5m candle volume ' + s.volume.m5);
    assert.ok(s.ath >= s.marketCap * (1 - 1e-12), k + ' ATH below the current market cap');
  });
});

function near(a, b, eps) { assert.ok(Math.abs(a - b) <= eps, a + ' != ' + b); }

let failed = 0;
for (const t of tests) {
  try { t.fn(); console.log('ok   ' + t.name); } catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.message || e)); }
}
console.log(failed ? '\n' + failed + ' failed' : '\n' + tests.length + ' simulator tests passed');
process.exit(failed ? 1 : 0);
