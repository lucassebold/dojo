'use strict';
// 22 scenarios of a person practising on Dojo, run against a LIVE server with real market data (needs internet).
// Start the server on a CLEAN data dir first:  PORT=3919 DATA_DIR=./data-scenarios node src/server.js   then:  PORT=3919 node test/scenarios_live.js
const http = require('http');
const PORT = process.env.PORT || 3919;
const A = 'a1'.repeat(16), B = 'b2'.repeat(16);

function call(method, path, body, player) {
  return new Promise(function (resolve, reject) {
    const data = body ? JSON.stringify(body) : null;
    const h = {}; if (player) h['x-player'] = player; if (data) { h['content-type'] = 'application/json'; h['content-length'] = Buffer.byteLength(data); }
    const req = http.request({ host: '127.0.0.1', port: PORT, method: method, path: path, headers: h }, function (res) {
      let s = ''; res.on('data', function (c) { s += c; }); res.on('end', function () { let j = null; try { j = JSON.parse(s); } catch (e) { /* */ } resolve({ status: res.statusCode, b: j, text: s }); });
    });
    req.setTimeout(60000, function () { req.destroy(new Error('timeout')); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
const near = function (a, b, e) { return Math.abs(a - b) <= (e || 0.01); };
const results = [];
async function sc(id, title, expected, fn) {
  let ok = false, got = '';
  try { const r = await fn(); ok = r[0]; got = r[1]; } catch (e) { got = 'EXCEPTION ' + e.message; }
  results.push({ id: id, ok: ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + id + ' - ' + title + '\n      expected: ' + expected + '\n      got:      ' + got);
}
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
const m2 = function (n) { return '$' + n.toFixed(2); };

(async function () {
  let big, thin, me;
  await sc('01', 'First visit creates a practice account', 'cash $10,000, equity $10,000, no positions, nickname Trader-xxxx', async function () {
    const r = await call('GET', '/api/me', null, A); me = r.b.me;
    return [r.status === 200 && me.cash === 10000 && me.equity === 10000 && me.positions.length === 0 && /^Trader-[a-f0-9]{4}$/.test(me.nickname), 'cash ' + me.cash + ', equity ' + me.equity + ', ' + me.nickname];
  });

  await sc('02', 'Home shows real trending markets', 'at least 10 tokens, each with price > 0, liquidity >= $1,000 and a pair address', async function () {
    const t = (await call('GET', '/api/trending')).b.tokens;
    big = t.filter(function (x) { return x.liquidity >= 80000; })[0]; thin = t.filter(function (x) { return x.liquidity >= 1500 && x.liquidity <= 8000; })[0];
    return [t.length >= 10 && t.every(function (x) { return x.price > 0 && x.liquidity >= 1000 && x.pair; }), t.length + ' tokens; deep pool: ' + (big && big.symbol) + ' (' + Math.round(big.liquidity) + ' liq); thin pool: ' + (thin && thin.symbol) + ' (' + (thin && Math.round(thin.liquidity)) + ' liq)'];
  });

  await sc('03', 'Search by name and by pasted address', 'searching the symbol finds the token; pasting its address opens it; a 1-letter search returns nothing', async function () {
    const byName = (await call('GET', '/api/search?q=' + encodeURIComponent(big.symbol))).b.tokens;
    const byAddr = await call('GET', '/api/token/' + big.mint);
    const short = (await call('GET', '/api/search?q=a')).b.tokens;
    return [byName.some(function (x) { return x.mint === big.mint; }) && byAddr.status === 200 && byAddr.b.token.symbol === big.symbol && short.length === 0, byName.length + ' results by name; address -> ' + byAddr.status + '; 1-letter -> ' + short.length];
  });

  await sc('04', 'Open a token: price, risk and chart', 'snapshot with risk label, and candles (>= 5; new pairs have few) with high >= low', async function () {
    const t = (await call('GET', '/api/token/' + big.mint)).b;
    const bars = (await call('GET', '/api/bars?pair=' + big.pair + '&res=15m')).b.bars;
    return [t.token.price > 0 && ['low', 'moderate', 'high'].indexOf(t.risk.label) >= 0 && bars.length >= 5 && bars.every(function (c) { return c.high >= c.low; }), 'price ' + t.token.price + ', risk ' + t.risk.label + ' (' + t.risk.score + '), ' + bars.length + ' candles'];
  });

  await sc('05', 'All 6 chart periods load, and the second time is instant (cache)', 'each of 1m,5m,15m,1h,4h,D returns candles; repeat of all six in under 1 s', async function () {
    const rs = ['1m', '5m', '15m', '1h', '4h', 'D'], counts = [];
    for (const r of rs) { let n = 0; for (let k = 0; k < 4 && !n; k++) { const x = await call('GET', '/api/bars?pair=' + big.pair + '&res=' + r); if (x.b && x.b.bars) n = x.b.bars.length; else await sleep(7000); } counts.push(n); }
    const t0 = Date.now();
    for (const r of rs) await call('GET', '/api/bars?pair=' + big.pair + '&res=' + r);
    const ms = Date.now() - t0;
    return [counts.every(function (c) { return c > 0; }) && ms < 1000, 'candles ' + counts.join('/') + '; second pass ' + ms + ' ms'];
  });

  let q50;
  await sc('06', 'Preview a $50 buy before confirming (nothing is spent)', 'fee $0.25, impact small, qty ~ (50-fee)/avg price; cash unchanged afterwards', async function () {
    q50 = (await call('POST', '/api/quote', { mint: big.mint, side: 'buy', usd: 50 }, A)).b.quote;
    const cash = (await call('GET', '/api/me', null, A)).b.me.cash;
    return [near(q50.fee, 0.25, 1e-6) && q50.impactPct < 1 && near(q50.qty * q50.execPrice, 49.75, 0.01) && cash === 10000, 'fee ' + q50.fee + ', impact ' + q50.impactPct.toFixed(3) + '%, qty*price ' + (q50.qty * q50.execPrice).toFixed(3) + ', cash ' + cash];
  });

  let buy1;
  await sc('07', 'Buy $100', 'cash $9,900, one position, cost $100, trade fee $0.50', async function () {
    const r = await call('POST', '/api/trade', { mint: big.mint, side: 'buy', usd: 100 }, A); buy1 = r.b;
    const p = r.b.me.positions[0];
    return [r.status === 200 && near(r.b.me.cash, 9900, 1e-6) && r.b.me.positions.length === 1 && near(p.cost, 100, 1e-6) && near(r.b.trade.fee, 0.5, 1e-6), 'cash ' + r.b.me.cash + ', position ' + p.symbol + ' qty ' + Math.round(p.qty) + ' cost ' + p.cost + ', equity ' + m2(r.b.me.equity)];
  });

  await sc('08', 'Right after buying you are slightly down (fees + impact), not up', 'equity between $9,990 and $10,000 (loss of roughly fee + impact)', async function () {
    const e = buy1.me.equity;
    return [e < 10000 && e > 9990, 'equity ' + m2(e) + ' (' + buy1.me.pnlPct.toFixed(3) + '%)'];
  });

  await sc('09', 'Buy the same token again (average entry)', 'one position, cost $300, avg entry between the two fill prices', async function () {
    const r = await call('POST', '/api/trade', { mint: big.mint, side: 'buy', usd: 200 }, A); const p = r.b.me.positions[0];
    return [r.status === 200 && r.b.me.positions.length === 1 && near(p.cost, 300, 1e-6) && near(p.avgPrice, p.cost / p.qty, 1e-12), 'qty ' + Math.round(p.qty) + ', cost ' + p.cost + ', avg ' + p.avgPrice.toPrecision(5)];
  });

  await sc('10', 'Sell 50%', 'half the tokens left, cost basis halves, cash goes up, trade records a P&L', async function () {
    const before = (await call('GET', '/api/me', null, A)).b.me, p0 = before.positions[0];
    const r = await call('POST', '/api/trade', { mint: big.mint, side: 'sell', pct: 50 }, A); const p = r.b.me.positions[0];
    return [r.status === 200 && near(p.qty, p0.qty / 2, p0.qty * 1e-9) && near(p.cost, p0.cost / 2, 1e-6) && r.b.me.cash > before.cash && r.b.trade.pnl !== null, 'qty ' + Math.round(p0.qty) + ' -> ' + Math.round(p.qty) + ', cost ' + p0.cost + ' -> ' + p.cost.toFixed(2) + ', trade pnl ' + m2(r.b.trade.pnl)];
  });

  await sc('11', 'Sell everything', 'position disappears, win rate and closed-trade count appear, realized P&L = cash - 10,000', async function () {
    const r = await call('POST', '/api/trade', { mint: big.mint, side: 'sell', pct: 100 }, A); const m = r.b.me;
    return [r.status === 200 && m.positions.length === 0 && m.closed === 2 && near(m.realized, m.cash - 10000, 1e-6) && m.winRate !== null, 'positions ' + m.positions.length + ', closed ' + m.closed + ', realized ' + m2(m.realized) + ', cash ' + m2(m.cash) + ', win rate ' + m.winRate + '%'];
  });

  await sc('12', 'Mistakes are refused with a clear message', 'each bad order returns 400 with an explanation', async function () {
    const cases = [
      [{ mint: big.mint, side: 'buy', usd: 1e6 }, /Not enough cash/], [{ mint: big.mint, side: 'buy', usd: 0.5 }, /minimum/], [{ mint: big.mint, side: 'buy', usd: -10 }, /amount/i],
      [{ mint: big.mint, side: 'sell', pct: 100 }, /do not hold/], [{ mint: 'hello', side: 'buy', usd: 10 }, /Invalid token/], [{ mint: big.mint, side: 'sell', pct: 150 }, /how much|do not hold|percentage/i], [{ mint: big.mint, side: 'hold', usd: 10 }, /Unknown/]];
    const out = [];
    for (const c of cases) { const r = await call('POST', '/api/trade', c[0], A); out.push(r.status + ' ' + (r.b && r.b.error || '').slice(0, 38)); if (r.status !== 400 || !c[1].test(r.b.error)) return [false, out.join(' | ')]; }
    return [true, out.join(' | ')];
  });

  await sc('13', 'A thin pool makes a big order expensive', 'buying $500 in the thin pool shows impact > 20%; equity right after is well below $10,000 - fee', async function () {
    if (!thin) return [false, 'no thin token available right now'];
    const q = (await call('POST', '/api/quote', { mint: thin.mint, side: 'buy', usd: 500 }, A)).b.quote;
    const r = await call('POST', '/api/trade', { mint: thin.mint, side: 'buy', usd: 500 }, A); const loss = 10000 - r.b.me.equity;
    await call('POST', '/api/trade', { mint: thin.mint, side: 'sell', pct: 100 }, A);
    return [q.impactPct > 20 && loss > 50, thin.symbol + ' liq ' + Math.round(thin.liquidity) + ': impact ' + q.impactPct.toFixed(1) + '%, instant paper loss ' + m2(loss)];
  });

  await sc('14', 'Going all-in on a mid-size pool', 'buy with all cash: allowed, impact reported, equity reflects exit value (below cash spent)', async function () {
    const cash = (await call('GET', '/api/me', null, A)).b.me.cash;
    const r = await call('POST', '/api/trade', { mint: big.mint, side: 'buy', usd: cash }, A);
    const m = r.b.me, ok = r.status === 200 && m.cash < 0.01 && m.equity < cash && r.b.trade.impactPct > 1;
    await call('POST', '/api/trade', { mint: big.mint, side: 'sell', pct: 100 }, A);
    return [ok, 'spent ' + m2(cash) + ', impact ' + r.b.trade.impactPct.toFixed(2) + '%, equity right after ' + m2(m.equity)];
  });

  await sc('15', 'Hold several tokens at once', 'buy $20 in 8 different trending tokens; portfolio lists 8 positions with prices', async function () {
    const t = (await call('GET', '/api/trending')).b.tokens.filter(function (x) { return x.liquidity >= 20000; }).slice(0, 8);
    let n = 0; for (const x of t) { const r = await call('POST', '/api/trade', { mint: x.mint, side: 'buy', usd: 20 }, A); if (r.status === 200) n++; }
    const m = (await call('GET', '/api/me', null, A)).b.me;
    return [n === t.length && m.positions.length === t.length && m.positions.every(function (p) { return p.price > 0 && p.value > 0; }), n + '/' + t.length + ' bought; ' + m.positions.length + ' positions; held value ' + m2(m.held) + ', cash ' + m2(m.cash)];
  });

  await sc('16', 'Equity moves with the market while holding', 'after ~20 s, positions are re-priced from the live source (live flag true) and equity is consistent: cash + exit values', async function () {
    await sleep(14000);
    const m = (await call('GET', '/api/me', null, A)).b.me;
    const sum = m.cash + m.positions.reduce(function (s, p) { return s + p.value; }, 0);
    return [m.positions.every(function (p) { return p.live; }) && near(sum, m.equity, 0.01), 'all live: ' + m.positions.every(function (p) { return p.live; }) + '; equity ' + m2(m.equity) + ' vs cash+values ' + m2(sum)];
  });

  await sc('17', 'Sell the whole portfolio, one by one', 'every position sold; no open positions; trades list has buys and sells', async function () {
    const m = (await call('GET', '/api/me', null, A)).b.me; let n = 0;
    for (const p of m.positions) { const r = await call('POST', '/api/trade', { mint: p.mint, side: 'sell', pct: 100 }, A); if (r.status === 200) n++; }
    const after = (await call('GET', '/api/me', null, A)).b.me, tr = (await call('GET', '/api/me/trades', null, A)).b.trades;
    return [n === m.positions.length && after.positions.length === 0 && tr.some(function (t) { return t.side === 'buy'; }) && tr.some(function (t) { return t.side === 'sell'; }), n + ' sold; open ' + after.positions.length + '; history ' + tr.length + ' trades; equity ' + m2(after.equity)];
  });

  await sc('18', 'Nickname', 'valid name saved; HTML/too-short/too-long refused', async function () {
    const ok = await call('POST', '/api/me/nickname', { nickname: 'Lucas Trader' }, A);
    const bad = [await call('POST', '/api/me/nickname', { nickname: '<script>x</script>' }, A), await call('POST', '/api/me/nickname', { nickname: 'ab' }, A), await call('POST', '/api/me/nickname', { nickname: 'a'.repeat(17) }, A)];
    return [ok.status === 200 && bad.every(function (r) { return r.status === 400; }), 'valid ' + ok.status + '; invalid ' + bad.map(function (r) { return r.status; }).join(',')];
  });

  await sc('19', 'Two people do not see each other, leaderboard ranks both', 'player B starts clean; after B trades, both appear; my row is flagged; tokens never leak', async function () {
    const b0 = (await call('GET', '/api/me', null, B)).b.me;
    await call('POST', '/api/trade', { mint: big.mint, side: 'buy', usd: 100 }, B);
    const lb = (await call('GET', '/api/leaderboard', null, A)).b;
    return [b0.cash === 10000 && b0.positions.length === 0 && lb.rows.length === 2 && lb.rows.some(function (r) { return r.id === lb.you; }) && lb.rows.some(function (r) { return r.nickname === 'Lucas Trader'; }) && JSON.stringify(lb).indexOf(A) < 0 && JSON.stringify(lb).indexOf(B) < 0, lb.rows.map(function (r, i) { return '#' + (i + 1) + ' ' + r.nickname + ' ' + r.pnlPct.toFixed(2) + '%'; }).join(', ')];
  });

  await sc('20', 'Reset the account', 'cash back to $10,000, no positions, no history, reset counter = 1', async function () {
    const r = await call('POST', '/api/me/reset', {}, A); const m = r.b.me;
    const tr = (await call('GET', '/api/me/trades', null, A)).b.trades;
    return [m.cash === 10000 && m.positions.length === 0 && m.tradeCount === 0 && m.resets === 1 && tr.length === 0, 'cash ' + m.cash + ', trades ' + tr.length + ', resets ' + m.resets];
  });

  await sc('21', 'Outsiders: no player id, forged id, path tricks', '401 without id, 401 for malformed id; static path traversal blocked; home page served', async function () {
    const a = await call('GET', '/api/me'), b = await call('GET', '/api/me', null, 'xyz'), c = await call('GET', '/..%2f..%2fsrc%2fserver.js'), d = await call('GET', '/');
    return [a.status === 401 && b.status === 401 && c.status !== 200 && d.status === 200, [a.status, b.status, c.status, d.status].join(',')];
  });

  await sc('22', 'Spamming search is throttled, not crashed', 'after ~40 searches in a minute the server answers 429; other pages still work', async function () {
    let limited = 0; for (let i = 0; i < 46; i++) { const r = await call('GET', '/api/search?q=tok' + (i % 3) + 'x', null, A); if (r.status === 429) limited++; }
    const still = await call('GET', '/api/me', null, A);
    return [limited > 0 && still.status === 200, limited + ' of 46 throttled; /api/me still ' + still.status];
  });

  const h = (await call('GET', '/api/health')).b;
  console.log('\nUpstream usage for ALL scenarios above: ' + JSON.stringify(h.upstream));
  const f = results.filter(function (r) { return !r.ok; });
  console.log('\n' + (results.length - f.length) + '/' + results.length + ' passed' + (f.length ? ' - failed: ' + f.map(function (x) { return x.id; }).join(', ') : ''));
})();
