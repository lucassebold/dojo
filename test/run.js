'use strict';
// Plain-node tests: node test/run.js  (no network: DexScreener/GeckoTerminal are stubbed)
const assert = require('assert');
const http = require('http');
const net = require('net');
process.env.GECKO_SPACING_MS = '5';
process.env.GECKO_COOLDOWN_MS = '80';
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

// ---- market cache + HTTP API with a stubbed upstream ----
function pairFor(mint, price, liq) {
  return { chainId: 'solana', pairAddress: 'P' + mint.slice(0, 40), dexId: 'raydium', baseToken: { address: mint, symbol: mint.slice(0, 4), name: 'n' }, priceUsd: String(price), liquidity: { usd: liq }, txns: {}, volume: {}, priceChange: {} };
}
let dexCalls = 0, geckoCalls = 0, dexDown = false, geckoLimited = false, price = 0.01;
upstream.getJson = async function (url) {
  if (/dexscreener/.test(url)) {
    dexCalls++;
    if (dexDown) throw new Error('HTTP 429 em api.dexscreener.com');
    if (/token-boosts/.test(url)) return [{ chainId: 'solana', tokenAddress: M2 }];
    if (/tokens\/v1/.test(url)) return url.split('/').pop().split(',').map(function (m) { return pairFor(m, price, 200000); });
    return { pairs: [pairFor(M2, price, 200000)] };
  }
  geckoCalls++;
  if (geckoLimited) throw new Error('HTTP 429 em api.geckoterminal.com');
  return { data: { attributes: { ohlcv_list: [[2, 1, 2, 0.5, 1.5, 10], [1, 1, 2, 0.5, 1.5, 10]] } } };
};
const market = require('../src/market');

test('market: many readers of the same token cost one upstream call', async function () {
  dexCalls = 0;
  await Promise.all([1, 2, 3, 4, 5].map(function () { return market.prices([M], 10000); }));
  const first = dexCalls;
  for (let i = 0; i < 20; i++) await market.prices([M], 10000);
  assert.ok(first >= 1 && first <= 5);
  assert.strictEqual(dexCalls, first, 'later reads must come from the cache');
});

test('market: serves the last good price when the upstream fails', async function () {
  await market.prices([M2], 0);
  dexDown = true;
  const r = await market.prices([M2], 0);
  assert.ok(r[M2] && r[M2].price > 0);
  dexDown = false;
});

test('market: candles are cached, sorted and queued', async function () {
  geckoCalls = 0;
  const pair = 'P' + M.slice(0, 40);
  const a = await market.candles(pair, '15m'), b = await market.candles(pair, '15m');
  assert.strictEqual(geckoCalls, 1);
  assert.deepStrictEqual(a.map(function (c) { return c.time; }), [1, 2]);
  assert.strictEqual(b.length, 2);
  await assert.rejects(function () { return market.candles('bad address!', '15m'); });
});

test('market: a 429 from GeckoTerminal pauses upstream calls and answers "busy" fast, then recovers', async function () {
  const P1 = 'Q' + M.slice(1, 40), P2 = 'R' + M.slice(1, 40);
  geckoLimited = true; geckoCalls = 0;
  await assert.rejects(function () { return market.candles(P1, '5m'); }, /busy/i);
  assert.strictEqual(geckoCalls, 1);
  const t0 = Date.now();
  await assert.rejects(function () { return market.candles(P2, '5m'); }, /busy/i);   // during the pause: no upstream call
  assert.strictEqual(geckoCalls, 1);
  assert.ok(Date.now() - t0 < 50);
  geckoLimited = false;
  await new Promise(function (r) { setTimeout(r, 120); });
  const ok = await market.candles(P2, '5m');
  assert.ok(ok.length > 0);
});

test('market: too many chart requests waiting are refused instead of queued forever', async function () {
  const mk = function (i) { return 'ABCDEFGHJ'.charAt(i) + 'Z' + M.slice(2, 40); };
  const calls = [];
  for (let i = 0; i < 9; i++) calls.push(market.candles(mk(i), '1h').then(function () { return 'ok'; }, function (e) { return /busy/i.test(e.message) ? 'busy' : 'err:' + e.message; }));
  const out = await Promise.all(calls);
  assert.ok(out.filter(function (x) { return x === 'busy'; }).length >= 1, out.join(','));
  assert.ok(out.filter(function (x) { return x === 'ok'; }).length >= 1, out.join(','));
  assert.ok(!out.some(function (x) { return /^err/.test(x); }), out.join(','));
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
