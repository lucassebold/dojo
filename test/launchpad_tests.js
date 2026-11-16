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
  const waiting = m.lp.serialize().filter(function (r) { return !r.migrated; }).length;
  assert.ok(waiting <= 30 + 3, 'launches waiting to migrate: ' + waiting);
  assert.ok(m.lp.stats(m.now()).launched > 900, 'and new ones kept being born: ' + m.lp.stats(m.now()).launched);
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

test('cards carry a normalised sparkline, a hot flag and the launch counters', function () {
  const m = mk(10, 0.5, { maxLive: 1000 }); m.run(600);
  const pulse = Launchpad.pulse(m.world.list(), 30, { spark: function (mt) { return m.world.sparkline(mt, 24, 300); }, stats: m.lp.stats(m.now()) });
  const cards = pulse.newPairs.concat(pulse.finalStretch, pulse.migrated);
  assert.ok(cards.length > 10);
  cards.forEach(function (c) {
    const brandNew = c.createdAt > m.now() - 5000;     // a card born in the last seconds has too few points to draw a line yet
    assert.ok(Array.isArray(c.spark) && (c.spark.length === 24 || (brandNew && c.spark.length === 0)) && c.spark.every(function (v) { return Number.isInteger(v) && v >= 0 && v <= 99; }), 'sparkline 0..99, 24 points');
    assert.strictEqual(typeof c.hot, 'boolean');
  });
  assert.ok(pulse.stats.launched > 200 && pulse.stats.migrated >= 0 && pulse.stats.perMin > 15 && pulse.stats.perMin < 50, 'counters ' + JSON.stringify(pulse.stats));
  assert.ok(pulse.stats.migrated <= pulse.stats.launched);
});

test('HOT stays a standout: about 15% of the cards, all of them moving clearly more than the rest', function () {
  const m = mk(14, 0.6, { maxLive: 1000 }); m.run(3600);
  const p = Launchpad.pulse(m.world.list(), 30, {}), all = [].concat(p.newPairs, p.finalStretch, p.migrated);
  const hot = all.filter(function (c) { return c.hot; }), rest = all.filter(function (c) { return !c.hot; });
  assert.ok(all.length > 40);
  assert.ok(hot.length >= all.length * 0.08 && hot.length <= all.length * 0.25, 'hot share ' + hot.length + '/' + all.length);
  assert.ok(Math.min.apply(null, hot.map(function (c) { return c.change5m; })) >= Math.max.apply(null, rest.map(function (c) { return c.change5m; })) - 1e-9, 'every hot card moved at least as much as every other card');
  assert.ok(hot.every(function (c) { return c.change5m >= 10; }), 'and at least +10% in 5 minutes');
});

test('names look like a real launchpad: varied, short, mixed casing, and never a real person or brand', function () {
  const Names = require('../src/names'), rng = World.mulberry32(31), seen = {}, sample = [];
  for (let i = 0; i < 3000; i++) { const n = Names.generate(rng); seen[n.name + '|' + n.symbol] = 1; sample.push(n); }
  assert.ok(Object.keys(seen).length > 400, 'distinct name/ticker pairs: ' + Object.keys(seen).length);
  sample.forEach(function (n) {
    assert.ok(n.symbol.length >= 2 && n.symbol.length <= 10 && n.name.length >= 2 && n.name.length <= 28, 'sizes ' + n.symbol + ' / ' + n.name);
    assert.ok(/^[#A-Za-z0-9]+$/.test(n.symbol) && /^@[a-z0-9]+$/.test(n.handle), 'characters ' + n.symbol + ' ' + n.handle);
    assert.ok(['cat', 'photo', 'avatar', 'mixed'].indexOf(n.image) >= 0);
  });
  const lower = sample.filter(function (n) { return n.symbol === n.symbol.toLowerCase() && /[a-z]/.test(n.symbol); }).length / sample.length;
  const upper = sample.filter(function (n) { return n.symbol === n.symbol.toUpperCase() && /[A-Z]/.test(n.symbol); }).length / sample.length;
  assert.ok(lower > 0.15 && lower < 0.5 && upper > 0.3, 'casing mix: lower ' + lower.toFixed(2) + ' upper ' + upper.toFixed(2));
  // nothing that points at a real person, company or coin may ever be added to the word banks
  const blocked = ['trump', 'elon', 'musk', 'bernie', 'sanders', 'obama', 'biden', 'putin', 'kanye', 'swift', 'beyonce', 'messi', 'ronaldo', 'openai', 'chatgpt', 'google', 'apple', 'tesla', 'microsoft', 'amazon', 'nike', 'disney', 'bitcoin', 'ethereum', 'solana', 'pepe', 'doge', 'shib', 'bonk', 'wif', 'binance', 'coinbase', 'usdc', 'tether'];   // (not 'pump': pumpkin is just a cat name)
  Object.keys(Names.BANKS).forEach(function (k) { Names.BANKS[k].forEach(function (w) { blocked.forEach(function (b) { assert.ok(w.toLowerCase().indexOf(b) < 0, 'the word "' + w + '" in bank ' + k + ' contains "' + b + '"'); }); }); });
});

test('launch pictures fit the name and come only from the pool; without a pool the icon is empty', function () {
  const images = { cat: ['/img/tk/cat-001.jpg', '/img/tk/cat-002.jpg'], photo: ['/img/tk/photo-001.jpg'], avatar: ['/img/tk/av-001.svg', '/img/tk/av-002.svg'] };
  const m = mk(15, 0, { images: images }), all = [].concat(images.cat, images.photo, images.avatar), counts = { cat: 0, other: 0 };
  for (let i = 0; i < 400; i++) { const mint = m.lp.spawn(NOW + i * 1000); const icon = m.world.get(mint).icon; assert.ok(all.indexOf(icon) >= 0, 'icon from the pool: ' + icon); if (icon.indexOf('cat-') >= 0) counts.cat++; else counts.other++; }
  assert.ok(counts.cat > 400 * 0.08 && counts.cat < 400 * 0.22, 'cat photos go to cat names: ' + counts.cat + ' of 400');
  const bare = mk(16, 0); assert.strictEqual(bare.world.get(bare.lp.spawn(NOW)).icon, null);
});

test('token avatars never use an emoji: a missing or broken picture shows the ticker initials', function () {
  const fs = require('fs'), path = require('path'), src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.ok(src.indexOf('FACES') < 0 && src.indexOf('emoFace') < 0, 'the emoji face helpers are gone');
  const from = src.indexOf('function initFace'), to = src.indexOf('function pulseCard'), block = src.slice(from, to);
  assert.ok(from > 0 && to > from && !/[\u2600-\u27BF\u{1F300}-\u{1FAFF}]/u.test(block), 'no emoji in the avatar code');
  assert.ok(/addEventListener\('error'/.test(block), 'a picture that fails to load is replaced');
});

test('the Pulse page code runs: a card is built, avatars never use emoji, numbers roll (no browser needed)', function () {
  const fs = require('fs'), path = require('path'), vm = require('vm');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const esc = /function esc\(s\) \{[^\n]*\}/.exec(src)[0];
  const block = src.slice(src.indexOf('// ---------- pulse ----------'), src.indexOf('// ---------- new pairs ----------'));
  const listeners = [], rolled = [];
  const box = { window: { matchMedia: function () { return { matches: false }; } }, document: { addEventListener: function (t, f) { listeners.push(t); }, hidden: false },
    performance: { now: function () { return 0; } }, requestAnimationFrame: function (f) { rolled.push(f); }, compact: function (n) { return '$' + Math.round(n); }, icon: function () { return ''; }, scramble: function () {}, Math: Math, Number: Number, String: String, Date: Date };
  vm.createContext(box);
  vm.runInContext(esc + '\n' + block + '\nthis.api = { pulseCard, initFace, tokFace, rollNum, nbFmt, ageShort, hashStr };', box);
  const A = box.api, card = { mint: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAApump', symbol: 'poorcat', name: 'poorcat', icon: '/img/tk/cat-003.jpg', createdAt: Date.now() - 5000, handle: '@poorcat', x: true, tg: false, web: true };
  const html = A.pulseCard(card);
  assert.ok(html.indexOf('poorcat') > 0 && html.indexOf('/img/tk/cat-003.jpg') > 0 && html.indexOf('AAAA...pump') > 0, 'a card has the ticker, its picture and the short address');
  const bare = A.pulseCard(Object.assign({}, card, { icon: null }));
  assert.ok(bare.indexOf('class="emo"') > 0 && bare.indexOf('>PO<') > 0, 'no picture: the ticker initials');
  assert.ok(!/[\u2600-\u27BF\u{1F300}-\u{1FAFF}]/u.test(A.tokFace({ icon: null, symbol: 'x', mint: 'm' }) + A.tokFace({ icon: '/img/tk/av-001.svg', symbol: 'x', mint: 'm' })), 'no emoji in any token avatar');
  assert.ok(A.tokFace({ icon: 'http://evil.example/x.png', symbol: 'ab', mint: 'm' }).indexOf('evil.example') < 0, 'only https and local pictures are used');
  assert.ok(listeners.indexOf('error') >= 0, 'a broken picture is replaced');
  const el = { _a: {}, textContent: '', getAttribute: function (k) { return k in this._a ? this._a[k] : null; }, setAttribute: function (k, v) { this._a[k] = String(v); }, removeAttribute: function (k) { delete this._a[k]; }, isConnected: true };
  assert.strictEqual(A.rollNum(el, 100, box.compact), 0, 'the first value just appears'); assert.strictEqual(el.textContent, '$100');
  assert.strictEqual(A.rollNum(el, 100, box.compact), 0, 'same value: nothing');
  assert.strictEqual(A.rollNum(el, 150, box.compact), 1, 'up'); assert.strictEqual(A.rollNum(el, 90, box.compact), -1, 'down');
  assert.strictEqual(A.nbFmt(-5), '-$5'); assert.strictEqual(A.nbFmt(7), '+$7');
});

test('launches arrive fast by default (about one every couple of seconds) so New Pairs keeps changing', function () {
  const world = World.create({ rng: World.mulberry32(11) }), lp = Launchpad.create({ world: world, rng: World.mulberry32(12) });
  let t = NOW; for (let i = 0; i < 300; i++) { t += 1000; lp.tick(t); world.step(t); }
  const n = lp.stats(t).launched;
  assert.ok(n > 120 && n < 260, 'launches in 5 minutes with the default rate: ' + n);
});

test('a token somebody looked at in the last 10 minutes is not removed even if it went nowhere', function () {
  const m = mk(13, 0); const mint = m.lp.spawn(NOW);
  Object.assign(m.lp.live[mint], { mT: 2500, dur: 200, decay: 0.6 });   // a launch that fizzles out
  m.run(550);
  m.world.touch(mint, m.now());
  m.run(500);                                          // it already counts as dead, but somebody looked at it 500 s ago
  assert.ok(m.world.has(mint), 'a recently viewed launch stays');
  m.run(700);                                          // more than 10 minutes without a view
  assert.ok(!m.world.has(mint) || m.lp.live[mint].migrated, 'and goes once nobody looks');
});

(async function () {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log('ok   ' + t.name); } catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.message || e)); }
  }
  console.log(failed ? '\n' + failed + ' failed' : '\n' + tests.length + ' launchpad tests passed');
  process.exit(failed ? 1 : 0);
})();
