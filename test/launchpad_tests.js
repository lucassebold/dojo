'use strict';
// Tests of the simulated launches behind the Pulse page (src/launchpad.js). Seeded, so reproducible. Run: node test/launchpad_tests.js
const assert = require('assert');
const World = require('../src/world');
const Launchpad = require('../src/launchpad');

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
function mk(seed, rate, extra) {
  const world = World.create({ rng: World.mulberry32(seed) });
  const lp = Launchpad.create(Object.assign({ world: world, rng: World.mulberry32(seed + 1000), rate: rate }, extra || {}));
  let t = NOW;
  const run = function (seconds) { for (let i = 0; i < seconds; i++) { t += 1000; lp.tick(t); world.step(t); } };
  return { world: world, lp: lp, run: run, now: function () { return t; } };
}
const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

test('a launch is a tradeable token: valid address, small start, enough liquidity, its own chart from second zero', function () {
  const m = mk(1, 0); const mint = m.lp.spawn(NOW); m.world.step(NOW + 1000);
  const s = m.world.snapshot(mint);
  assert.ok(/^[1-9A-HJ-NP-Za-km-z]{44}$/.test(mint) && mint.slice(-4) === 'pump', 'pump-style address');
  assert.ok(s.marketCap > 3500 && s.marketCap < 6500 && s.liquidity >= 1500 && s.meta.launch && !s.meta.migrated && s.meta.progress < Launchpad.FINAL_FROM);
  m.run(90);
  const bars = m.world.bars(mint, '1m', 300), sec = m.world.bars(mint, '1s', 300);
  assert.ok(bars.length <= 3, 'no invented past: ' + bars.length + ' candles after 90 s');
  assert.ok(sec.length >= 60 && sec.length <= 100, '1s candles since birth: ' + sec.length);
});

test('launches follow their own path: most fizzle out, a few graduate and migrate', function () {
  const m = mk(2, 0.5, { maxLive: 100000 }), recs = [], orig = m.lp.spawn;
  m.lp.spawn = function (now) { const mint = orig(now); recs.push(m.lp.live[mint]); return mint; };   // keep every record, even after cleanup
  m.run(3 * 3600);
  const n = recs.length, share = function (f) { return recs.filter(f).length / n; };
  assert.ok(n > 4000, 'launches born ' + n);
  assert.ok(Math.abs(share(function (r) { return r.type === 'dud'; }) - 0.55) < 0.05, 'duds ~55%');
  assert.ok(Math.abs(share(function (r) { return r.type === 'graduate'; }) - 0.08) < 0.03, 'graduates ~8%');
  const mig = share(function (r) { return r.migrated; });
  assert.ok(mig >= 0.05 && mig <= 0.25, 'about the graduate share migrated: ' + (mig * 100).toFixed(1) + '%');
  const migRecs = recs.filter(function (r) { return r.migrated; });
  assert.ok(migRecs.filter(function (r) { return r.type === 'graduate'; }).length > migRecs.length * 0.5, 'most migrations are graduates');
  assert.ok(migRecs.filter(function (r) { return r.type === 'dud'; }).length < migRecs.length * 0.05, 'a dud almost never migrates');
});

test('migration happens when the market cap crosses the line: dex changes and progress is full', function () {
  const m = mk(3, 0.5, { maxLive: 400 }); m.run(2 * 3600);
  const migrated = m.lp.serialize().filter(function (r) { return r.migrated; });
  assert.ok(migrated.length > 0, 'something migrated');
  migrated.forEach(function (r) {
    const s = m.world.snapshot(r.mint);
    assert.strictEqual(s.dex, 'pumpswap'); assert.strictEqual(s.meta.progress, 1); assert.ok(s.meta.migratedAt >= r.born);
    assert.ok(r.migMc >= Launchpad.MIGRATE_MC, 'crossed ' + r.migMc);
  });
});

test('pulse columns partition the launches by stage, newest first', function () {
  const m = mk(4, 0.5, { maxLive: 400 }); m.run(3600);
  const snaps = m.world.list(), p = Launchpad.pulse(snaps, 30);
  assert.ok(p.newPairs.length > 5);
  p.newPairs.forEach(function (c, i) { assert.ok(!c.migrated && c.progress < Launchpad.FINAL_FROM && c.fake); if (i) assert.ok(p.newPairs[i - 1].createdAt >= c.createdAt, 'new pairs: newest first'); });
  p.finalStretch.forEach(function (c, i) { assert.ok(!c.migrated && c.progress >= Launchpad.FINAL_FROM); if (i) assert.ok(p.finalStretch[i - 1].progress >= c.progress, 'final stretch: closest to migrating first'); });
  p.migrated.forEach(function (c, i) { assert.ok(c.migrated); if (i) assert.ok(p.migrated[i - 1].migratedAt >= c.migratedAt, 'migrated: latest first'); });
  // real tokens keep their share of the migrated column even when many simulated launches graduated
  for (let i = 0; i < 40; i++) m.world.add({ mint: 'Q' + String(i).padStart(2, '0') + 'R'.repeat(41), pair: 'S' + String(i).padStart(2, '0') + 'P'.repeat(41), symbol: 'RT' + i, name: 'Real ' + i, liquidity: 90000, price: 0.01, marketCap: 1e7, createdAt: NOW - 86400e3 - i * 1000, change: { m5: 0, h1: 0, h6: 0, h24: 0 }, volume: { m5: 1, h1: 10, h6: 50, h24: 200 }, buys24: 80, sells24: 70 }, m.now());
  m.world.step(m.now() + 1000);
  const mixed = Launchpad.pulse(m.world.list(), 30);
  assert.strictEqual(mixed.migrated.length, 30);
  assert.ok(mixed.migrated.filter(function (c) { return !c.fake; }).length >= 10, 'at least 10 real tokens in the migrated column');
  assert.ok(mixed.migrated.filter(function (c) { return c.fake; }).length >= 5, 'and simulated graduates too');
  const all = p.newPairs.concat(p.finalStretch, p.migrated).map(function (c) { return c.mint; });
  assert.strictEqual(new Set(all).size, all.length, 'a token is in one column only');
});

test('real tokens only appear in the migrated column, with stable made-up wallet stats', function () {
  const m = mk(5, 0);
  m.world.add({ mint: 'R'.repeat(43) + '1', pair: 'P'.repeat(43) + '1', symbol: 'REAL', name: 'Real token', liquidity: 90000, price: 0.01, marketCap: 1e7, createdAt: NOW - 86400e3, change: { m5: 1, h1: 2, h6: 3, h24: 4 }, volume: { m5: 100, h1: 1000, h6: 5000, h24: 20000 }, buys24: 800, sells24: 700 }, NOW);
  m.world.step(NOW + 1000);
  const a = Launchpad.pulse(m.world.list()), b = Launchpad.pulse(m.world.list());
  assert.strictEqual(a.newPairs.length + a.finalStretch.length, 0);
  assert.strictEqual(a.migrated.length, 1); assert.strictEqual(a.migrated[0].fake, false);
  assert.deepStrictEqual(a.migrated[0].top10, b.migrated[0].top10, 'stats do not jitter between reads');
});

test('holder stats evolve sensibly: holders grow, top-10 share falls, snipers and dev fade', function () {
  const m = mk(6, 0); const mint = m.lp.spawn(NOW); m.world.step(NOW + 1000);
  const first = JSON.parse(JSON.stringify(m.world.snapshot(mint).meta));
  m.run(1800);
  const last = m.world.snapshot(mint).meta;
  assert.ok(last.holders > first.holders + 2, 'holders ' + first.holders + ' -> ' + last.holders);
  assert.ok(last.top10 < first.top10, 'top 10 ' + first.top10.toFixed(0) + '% -> ' + last.top10.toFixed(0) + '%');
  assert.ok(last.snipers <= first.snipers + 1e-9 && last.insiders <= first.insiders + 1e-9);
  [last.top10, last.dev, last.snipers, last.insiders, last.bundlers].forEach(function (v) { assert.ok(isFinite(v) && v >= 0 && v <= 100); });
});

test('dead launches are cleaned up, but never one that somebody holds', function () {
  const held = {};
  const m = mk(7, 0, { pinned: function () { return held; } });
  const a = m.lp.spawn(NOW), b = m.lp.spawn(NOW);
  held[b] = 1;
  m.run(2500);                                      // past the 40-minute life of a launch that never migrated
  assert.ok(!m.world.has(a) || m.lp.live[a].migrated, 'an unheld launch that went nowhere is removed');
  assert.ok(m.world.has(b), 'a held one stays');
});

test('the number of live launches is capped', function () {
  const m = mk(8, 2, { maxLive: 30 }); m.run(600);
  assert.ok(m.lp.count() <= 33, 'alive ' + m.lp.count());
});

test('a launch can be traded and charted like any token (price, liquidity, impact)', function () {
  const sim = require('../src/sim');
  const m = mk(9, 0); const mint = m.lp.spawn(NOW); m.run(30);
  const s = m.world.snapshot(mint), a = sim.newAccount('t', 0);
  const q = sim.quote(a, s, 'buy', { usd: 100 });
  assert.ok(q.ok && q.impactPct > 1 && q.impactPct < 60, 'a $100 buy in a ~$5K launch has real impact: ' + q.impactPct);
  sim.apply(a, s, q, NOW);
  assert.ok(sim.summary(a, { [mint]: s }).positions.length === 1);
});

(async function () {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log('ok   ' + t.name); } catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.message || e)); }
  }
  console.log(failed ? '\n' + failed + ' failed' : '\n' + tests.length + ' launchpad tests passed');
  process.exit(failed ? 1 : 0);
})();
