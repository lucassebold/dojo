'use strict';
// Plain-node tests: node test/run.js  (no network: DexScreener is stubbed). Simulator maths: node test/world_tests.js
const assert = require('assert');
const http = require('http');
const net = require('net');
process.env.DATA_DIR = require('path').join(require('os').tmpdir(), 'dojo-test-' + Date.now());
const sim = require('../src/sim');
const upstream = require('../src/http');

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }
const near = function (a, b, eps) { assert.ok(Math.abs(a - b) <= (eps || 1e-6), a + ' != ' + b); };

const M = 'So11111111111111111111111111111111111111112';       // valid base58 shape
const M2 = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const snap = function (over) { return Object.assign({ mint: M, symbol: 'TST', icon: null, price: 0.01, liquidity: 100000 }, over || {}); };

test('buy: fee and price impact follow the pool model', function () {
  const a = sim.newAccount('t', 0);
  const q = sim.quote(a, snap(), 'buy', { usd: 1000 });
  assert.ok(q.ok);
  near(q.fee, 1000 * sim.FEE_PCT / 100);
  const x = 1000 - q.fee, R = 50000;
  near(q.execPrice, 0.01 * (1 + x / R), 1e-12);
  near(q.qty, x / q.execPrice, 1e-6);
  near(q.impactPct, x / R * 100, 1e-9);
});

test('buy: rejects missing cash, tiny orders, thin liquidity, unknown price', function () {
  const a = sim.newAccount('t', 0);
  assert.ok(/Not enough cash/.test(sim.quote(a, snap(), 'buy', { usd: sim.START_CASH + 1 }).error));
  assert.ok(/minimum/.test(sim.quote(a, snap(), 'buy', { usd: 0.5 }).error));
  assert.ok(/thin/.test(sim.quote(a, snap({ liquidity: 500 }), 'buy', { usd: 10 }).error));
  assert.ok(/No live price/.test(sim.quote(a, null, 'buy', { usd: 10 }).error));
  assert.ok(/do not hold/.test(sim.quote(a, snap(), 'sell', { pct: 100 }).error));
});

test('round trip at an unchanged price loses about 2 fees plus the pool impact, never gains', function () {
  const a = sim.newAccount('t', 0), s = snap();
  sim.apply(a, s, sim.quote(a, s, 'buy', { usd: 1000 }), 1);
  const t = sim.apply(a, s, sim.quote(a, s, 'sell', { pct: 100 }), 2);
  assert.ok(a.cash < sim.START_CASH);
  assert.ok(a.cash > sim.START_CASH - 60);          // $1000 into a $100k pool: ~2% impact each way + fees, about $45
  assert.strictEqual(Object.keys(a.positions).length, 0);
  near(a.realized, a.cash - sim.START_CASH, 1e-6);
  assert.ok(t.pnl < 0);
});

test('profit: price doubles, partial sells keep cost basis consistent', function () {
  const a = sim.newAccount('t', 0), s = snap({ liquidity: 10000000 });
  sim.apply(a, s, sim.quote(a, s, 'buy', { usd: 1000 }), 1);
  const up = snap({ liquidity: 10000000, price: 0.02 });
  const t1 = sim.apply(a, up, sim.quote(a, up, 'sell', { pct: 50 }), 2);
  assert.ok(t1.pnl > 0);
  const left = a.positions[M];
  near(left.cost, 1000 / 2, 1e-6);                  // half the cost basis stays with half the tokens
  const t2 = sim.apply(a, up, sim.quote(a, up, 'sell', { pct: 100 }), 3);
  assert.ok(t2.pnl > 0);
  assert.ok(a.cash > sim.START_CASH + 900);
  const sm = sim.summary(a, {});
  assert.strictEqual(sm.closed, 2);
  assert.strictEqual(sm.winRate, 100);
});

test('equity values positions at liquidation value, so thin pools cannot inflate it', function () {
  const a = sim.newAccount('t', 0), s = snap({ liquidity: 2000 });
  sim.apply(a, s, sim.quote(a, s, 'buy', { usd: 500 }), 1);
  const pumped = snap({ liquidity: 2000, price: 1 });   // price 100x, same tiny pool
  const sm = sim.summary(a, { [M]: pumped });
  assert.ok(sm.positions[0].value < 1001, 'value capped by what the pool can pay: ' + sm.positions[0].value);
  assert.ok(sm.equity < sim.START_CASH + 1001);
});

test('summary falls back to the last known price when a refresh fails', function () {
  const a = sim.newAccount('t', 0), s = snap();
  sim.apply(a, s, sim.quote(a, s, 'buy', { usd: 100 }), 1);
  const sm = sim.summary(a, {});
  assert.strictEqual(sm.positions[0].live, false);
  assert.ok(sm.positions[0].value > 90);
});

test('position limit and reset', function () {
  const a = sim.newAccount('t', 0);
  for (let i = 0; i < 30; i++) a.positions['m' + i] = { mint: 'm' + i, qty: 1, cost: 1 };
  assert.ok(/up to 30/.test(sim.quote(a, snap(), 'buy', { usd: 10 }).error));
  sim.reset(a, 5);
  assert.strictEqual(a.cash, sim.START_CASH);
  assert.strictEqual(Object.keys(a.positions).length, 0);
  assert.strictEqual(a.resets, 1);
});

// ---- simulated market with a stubbed DexScreener (only used for names, sizes and the slow real-price anchor) ----
const createdAt = {}, thin = {};   // per-mint overrides
function pairFor(mint, price, liq) {
  return {
    chainId: 'solana', pairAddress: 'P' + mint.slice(0, 40), dexId: 'raydium', baseToken: { address: mint, symbol: mint.slice(0, 4), name: 'n' }, priceUsd: String(price),
    liquidity: { usd: thin[mint] ? 100 : liq }, txns: { h24: { buys: 500, sells: 450 } }, volume: { m5: 900, h1: 9000, h6: 40000, h24: 120000 },
    priceChange: { m5: 1, h1: 4, h6: -3, h24: 10 }, marketCap: price * 1e9, pairCreatedAt: createdAt[mint] || 0
  };
}
let dexCalls = 0, dexDown = false, price = 0.01, boosts = [], profiles = [];
upstream.getJson = async function (url) {
  dexCalls++;
  if (dexDown) throw new Error('HTTP 429 em api.dexscreener.com');
  if (/token-boosts\/top/.test(url)) return boosts.map(function (m) { return { chainId: 'solana', tokenAddress: m }; });
  if (/token-boosts\/latest/.test(url)) return [];
  if (/token-profiles/.test(url)) return profiles.map(function (m) { return { chainId: 'solana', tokenAddress: m }; });
  if (/tokens\/v1/.test(url)) return url.split('/').pop().split(',').map(function (m) { return pairFor(m, price, 200000); });
  return { pairs: [pairFor(M2, price, 200000)] };
};
const market = require('../src/market');
let clock = Date.now();
const tick = function (seconds) { clock += seconds * 1000; market._tick(clock); };

test('market: an unknown real token is fetched once, then served from the simulation', async function () {
  dexCalls = 0;
  const r = await market.prices([M]);
  assert.ok(r[M] && r[M].price > 0 && r[M].sim === true);
  near(r[M].price, 0.01, 0.0005);                       // starts at the real price
  assert.strictEqual(dexCalls, 1);
  for (let i = 0; i < 20; i++) await market.prices([M]);
  assert.strictEqual(dexCalls, 1, 'known tokens never touch the network');
});

test('market: prices keep moving on their own and cost no upstream call', async function () {
  await market.prices([M]);
  dexCalls = 0;
  const seen = {};
  for (let i = 0; i < 30; i++) { tick(1); seen[(await market.prices([M]))[M].price] = 1; }
  assert.ok(Object.keys(seen).length >= 25, 'the price should change almost every second, got ' + Object.keys(seen).length + ' distinct values');
  assert.strictEqual(dexCalls, 0);
});

test('market: the real price is a slow anchor: the simulation follows it', async function () {
  await market.prices([M]);
  price = 0.02;                                         // the real market doubles
  await market._refresh();
  tick(2 * 3600);                                       // two simulated hours
  const p = (await market.prices([M]))[M].price;
  assert.ok(p > 0.012 && p < 0.035, 'should have followed the real price up, got ' + p);
  price = 0.01; await market._refresh(); tick(2 * 3600);
  const q = (await market.prices([M]))[M].price;
  assert.ok(q < p, 'and back down');
});

test('market: DexScreener down does not stop the market', async function () {
  await market.prices([M]);
  dexDown = true;
  await market._refresh();                              // fails quietly
  tick(60);
  const r = await market.prices([M]);
  assert.ok(r[M].price > 0);
  await assert.rejects(function () { return market.prices([M2.slice(0, -1) + 'x']); }, /429/, 'only a token never seen before needs the network');
  dexDown = false;
});

test('market: discovery stocks the market; trending by 1h volume; new pairs newest first, thin and old dropped', async function () {
  const mk = function (c) { return 'N' + c + M.slice(2, 40); };
  const A = mk('1'), B = mk('2'), C = mk('3'), D = mk('4');
  const now = Date.now();
  createdAt[A] = now - 5 * 60000; createdAt[B] = now - 3 * 86400000; createdAt[C] = now - 60 * 60000; createdAt[D] = now - 60000; thin[D] = true;
  boosts = [A, B, D]; profiles = [C, 'not-a-mint'];
  await market._discover();
  const ids = (await market.newPairs()).map(function (s) { return s.mint; });
  assert.deepStrictEqual(ids.filter(function (m) { return [A, B, C, D].indexOf(m) >= 0; }), [A, C], 'newest first; 3-day-old and thin pools dropped');
  const t = await market.trending();
  assert.ok(t.length >= 3);
  for (let i = 1; i < t.length; i++) assert.ok(t[i - 1].volume.h1 >= t[i].volume.h1, 'sorted by 1h volume');
  assert.ok(!t.some(function (s) { return s.mint === D; }), 'thin pools are not trending');
  const before = dexCalls; await market._discover();
  assert.ok(dexCalls > before, 'discovery looks again');
});

test('market: candles come from the simulation, per period, with the last one still forming', async function () {
  const s = (await market.prices([M]))[M];
  const m1 = await market.candles(s.pair, '1m', 300), h1 = await market.candles(s.pair, '1h', 300);
  assert.ok(m1.length >= 100 && h1.length >= 10);
  for (let i = 1; i < m1.length; i++) assert.strictEqual(m1[i].time - m1[i - 1].time, 60, 'one candle per minute, no gaps');
  const last = (await market.candles(s.pair, '1m', 2));
  assert.strictEqual(last.length, 2);
  tick(2);
  const again = await market.candles(s.pair, '1m', 2);
  assert.ok(again[1].close !== last[1].close || again[1].time !== last[1].time, 'the last candle moves');
  const s1 = await market.candles(s.pair, '1s', 300), s15 = await market.candles(s.pair, '15s', 300);
  assert.ok(s1.length >= 100 && s15.length >= 20, 'second-level candles exist from the start: ' + s1.length + ' / ' + s15.length);
  assert.ok(s.flow5m && s.flow5m.vol > 0 && s.ath >= s.marketCap * 0.999, 'snapshot carries the 5m flow and the ATH');
  await assert.rejects(function () { return market.candles('Z'.repeat(40), '1m'); }, /Unknown pair/);
  await assert.rejects(function () { return market.candles('bad', '1m'); }, /Invalid pair/);
});

test('market: search adds the real tokens it finds to the market', async function () {
  const found = await market.search('anything');
  assert.ok(found.length >= 1 && found[0].sim === true && found[0].price > 0);
  assert.ok((await market.prices([found[0].mint]))[found[0].mint]);
});

function freePort() { return new Promise(function (r) { const s = net.createServer(); s.listen(0, '127.0.0.1', function () { const p = s.address().port; s.close(function () { r(p); }); }); }); }
function call(port, method, path, body, player) {
  return new Promise(function (resolve, reject) {
    const data = body ? JSON.stringify(body) : null;
    const h = {}; if (player) h['x-player'] = player; if (data) { h['content-type'] = 'application/json'; h['content-length'] = Buffer.byteLength(data); }
    const req = http.request({ host: '127.0.0.1', port: port, method: method, path: path, headers: h }, function (res) {
      let s = ''; res.on('data', function (c) { s += c; }); res.on('end', function () { let j = null; try { j = JSON.parse(s); } catch (e) { /* static */ } resolve({ status: res.statusCode, body: j, text: s }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

test('api: full flow - account, quote, buy, sell, isolation, leaderboard, validation', async function () {
  const srv = require('../src/server');
  const port = await freePort();
  await new Promise(function (r) { srv.server.listen(port, '127.0.0.1', r); });
  try {
    const A = 'a'.repeat(32), B = 'b'.repeat(32);
    assert.strictEqual((await call(port, 'GET', '/api/me')).status, 401);
    assert.strictEqual((await call(port, 'GET', '/api/me', null, 'not-a-token')).status, 401);
    const me = await call(port, 'GET', '/api/me', null, A);
    assert.strictEqual(me.status, 200);
    assert.strictEqual(me.body.me.cash, sim.START_CASH);

    price = 0.01;
    const bad = await call(port, 'POST', '/api/trade', { mint: 'nope', side: 'buy', usd: 10 }, A);
    assert.strictEqual(bad.status, 400);
    assert.strictEqual((await call(port, 'POST', '/api/trade', { mint: M, side: 'buy', usd: -5 }, A)).status, 400);
    assert.strictEqual((await call(port, 'POST', '/api/trade', { mint: M, side: 'buy', usd: 1e9 }, A)).status, 400);
    const tokPair = (await call(port, 'GET', '/api/token/' + M)).body.token.pair;
    const quote = await call(port, 'POST', '/api/quote', { mint: M, side: 'buy', usd: 100 }, A);
    assert.strictEqual(quote.status, 200);
    assert.strictEqual((await call(port, 'GET', '/api/me', null, A)).body.me.cash, sim.START_CASH, 'a quote must not spend money');

    const buy = await call(port, 'POST', '/api/trade', { mint: M, side: 'buy', usd: 100 }, A);
    assert.strictEqual(buy.status, 200);
    near(buy.body.me.cash, sim.START_CASH - 100);
    assert.strictEqual(buy.body.me.positions.length, 1);

    const other = await call(port, 'GET', '/api/me', null, B);
    assert.strictEqual(other.body.me.positions.length, 0, 'players do not see each other');
    assert.strictEqual((await call(port, 'POST', '/api/trade', { mint: M, side: 'sell', pct: 100 }, B)).status, 400);

    const sell = await call(port, 'POST', '/api/trade', { mint: M, side: 'sell', pct: 100 }, A);
    assert.strictEqual(sell.status, 200);
    assert.strictEqual(sell.body.me.positions.length, 0);
    assert.strictEqual((await call(port, 'GET', '/api/me/trades', null, A)).body.trades.length, 2);
    assert.strictEqual((await call(port, 'GET', '/api/me/trades?mint=' + M, null, A)).body.trades.length, 2, 'trades can be filtered by token');
    assert.strictEqual((await call(port, 'GET', '/api/me/trades?mint=' + M2, null, A)).body.trades.length, 0);
    assert.strictEqual((await call(port, 'GET', '/api/me/trades?mint=' + M + '&limit=1', null, A)).body.trades.length, 1, 'and limited');
    const sec = await call(port, 'GET', '/api/bars?pair=' + tokPair + '&res=1s&limit=5');
    assert.ok(sec.status === 200 && sec.body.bars.length === 5, '1s bars through the API');

    assert.strictEqual((await call(port, 'POST', '/api/me/nickname', { nickname: '<b>x</b>' }, A)).status, 400);
    assert.strictEqual((await call(port, 'POST', '/api/me/nickname', { nickname: 'Ana Maria' }, A)).status, 200);
    const lb = await call(port, 'GET', '/api/leaderboard', null, A);
    assert.strictEqual(lb.body.rows.length, 1);
    assert.strictEqual(lb.body.rows[0].nickname, 'Ana Maria');
    assert.ok(lb.body.you);
    assert.ok(!JSON.stringify(lb.body).includes(A), 'the player token must never be exposed');

    const tok = await call(port, 'GET', '/api/token/' + M);
    assert.strictEqual(tok.status, 200);
    assert.strictEqual((await call(port, 'GET', '/api/token/xyz')).status, 400);
    assert.strictEqual((await call(port, 'GET', '/%2e%2e/%2e%2e/package.json')).status === 200, false, 'no path traversal');
    assert.strictEqual((await call(port, 'GET', '/')).status, 200);
    const rs = await call(port, 'POST', '/api/me/reset', {}, A);
    assert.strictEqual(rs.body.me.cash, sim.START_CASH);
    assert.strictEqual(rs.body.me.tradeCount, 0);
  } finally { srv.server.close(); }
});

(async function () {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log('ok   ' + t.name); } catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack || e)); }
  }
  console.log(failed ? '\n' + failed + ' failed' : '\n' + tests.length + ' tests passed');
  process.exit(failed ? 1 : 0);
})();
