'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const market = require('./market');
const risk = require('./risk');
const sim = require('./sim');
const store = require('./store');

const ON_RAILWAY = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
const PORT = Number(process.env.PORT) || 3100;
const HOST = process.env.HOST || (ON_RAILWAY ? '0.0.0.0' : '127.0.0.1');
const PUBLIC = path.join(__dirname, '..', 'public');
const TRADE_PRICE_MAX_AGE_MS = 4000;   // a fill never uses a price older than this
const VIEW_PRICE_MAX_AGE_MS = 4000;   // balances and the token page can be a little older

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function fail(res, code, msg) { send(res, code, { error: msg }); }

// ---- simple per-IP rate limiter (in memory) ----
const hits = {};
function clientIp(req) {
  if (ON_RAILWAY) { const f = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(); if (f) return f; }
  return req.socket.remoteAddress || '?';
}
function limited(req, name, max, windowMs) {
  const k = name + ':' + clientIp(req), now = Date.now();
  const h = hits[k] && now - hits[k].t < windowMs ? hits[k] : (hits[k] = { t: now, n: 0 });
  h.n++;
  return h.n > max;
}
setInterval(function () { const cut = Date.now() - 3600000; Object.keys(hits).forEach(function (k) { if (hits[k].t < cut) delete hits[k]; }); }, 600000).unref();

function readBody(req) {
  return new Promise(function (resolve, reject) {
    let s = '';
    req.on('data', function (c) { s += c; if (s.length > 4096) { reject(new Error('Body too large')); req.destroy(); } });
    req.on('end', function () { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

// ---- players: an anonymous random token kept in the browser. Fake money only, so no login. ----
const TOKEN_RE = /^[a-f0-9]{32}$/;
function publicId(token) { return crypto.createHash('sha256').update(token).digest('hex').slice(0, 8); }
function randomNick() { return 'Trader-' + crypto.randomBytes(2).toString('hex'); }
function cleanNick(s) { s = String(s || '').trim().replace(/\s+/g, ' '); return /^[A-Za-z0-9 _-]{3,16}$/.test(s) ? s : null; }

// Returns the account, creating it the first time a valid token is seen. Null if the token is invalid or creation is throttled.
function account(req, res) {
  const token = String(req.headers['x-player'] || '');
  if (!TOKEN_RE.test(token)) { fail(res, 401, 'Missing player id.'); return null; }
  let a = store.get(token);
  if (!a) {
    if (limited(req, 'newacct', 20, 3600000)) { fail(res, 429, 'Too many new accounts from this network. Try again later.'); return null; }
    a = sim.newAccount(randomNick(), Date.now());
    store.put(token, a);
  }
  a.lastSeen = Date.now();
  return { token: token, acct: a };
}

async function viewSummary(acct) {
  const mints = Object.keys(acct.positions);
  let prices = {};
  if (mints.length) { try { prices = await market.prices(mints, VIEW_PRICE_MAX_AGE_MS); } catch (e) { /* use last known prices */ } }
  return sim.summary(acct, prices);
}

// ---- leaderboard (cached 30 s) ----
let board = { t: 0, rows: [] };
async function leaderboard() {
  if (Date.now() - board.t < 30000) return board.rows;
  const mintSet = {};
  store.each(function (k, a) { Object.keys(a.positions).forEach(function (m) { mintSet[m] = 1; }); });
  let prices = {};
  try { prices = await market.prices(Object.keys(mintSet), 30000); } catch (e) { /* last known prices */ }
  const rows = [];
  store.each(function (token, a) {
    if (!a.tradeCount) return;
    const s = sim.summary(a, prices);
    rows.push({ id: publicId(token), nickname: a.nickname, equity: s.equity, pnlPct: s.pnlPct, trades: s.tradeCount, winRate: s.winRate });
  });
  rows.sort(function (a, b) { return b.pnlPct - a.pnlPct; });
  board = { t: Date.now(), rows: rows.slice(0, 50) };
  return board.rows;
}

function tradeInput(b) {
  if (!b || !market.isMint(b.mint)) return { error: 'Invalid token.' };
  if (b.side === 'buy') { const usd = Number(b.usd); return isFinite(usd) && usd > 0 ? { side: 'buy', amount: { usd: usd } } : { error: 'Enter an amount in dollars.' }; }
  if (b.side === 'sell') { const pct = Number(b.pct); return isFinite(pct) && pct > 0 && pct <= 100 ? { side: 'sell', amount: { pct: pct } } : { error: 'Choose how much to sell.' }; }
  return { error: 'Unknown order side.' };
}

async function api(req, res, url) {
  const p = url.pathname, q = url.searchParams, m = req.method;
  if (limited(req, 'api', 300, 60000)) return fail(res, 429, 'Too many requests. Slow down a little.');

  if (p === '/api/health') return send(res, 200, { ok: true, players: store.count(), upstream: market.stats, startCash: sim.START_CASH, feePct: sim.FEE_PCT });

  if (p === '/api/trending' && m === 'GET') return send(res, 200, { tokens: await market.trending() });

  if (p === '/api/new' && m === 'GET') return send(res, 200, { tokens: await market.newPairs() });

  if (p === '/api/search' && m === 'GET') {
    const term = String(q.get('q') || '').trim().slice(0, 80);
    if (term.length < 2) return send(res, 200, { tokens: [] });
    if (limited(req, 'search', 40, 60000)) return fail(res, 429, 'Too many searches. Wait a moment.');
    return send(res, 200, { tokens: await market.search(term) });
  }

  let mt = /^\/api\/token\/([^/]+)$/.exec(p);
  if (mt && m === 'GET') {
    if (!market.isMint(mt[1])) return fail(res, 400, 'Invalid token address.');
    const snaps = await market.prices([mt[1]], VIEW_PRICE_MAX_AGE_MS);
    const s = snaps[mt[1]];
    if (!s) return fail(res, 404, 'Token not found on Solana.');
    return send(res, 200, { token: s, risk: risk.score(s, null) });
  }

  if (p === '/api/bars' && m === 'GET') return send(res, 200, { bars: await market.candles(String(q.get('pair') || ''), String(q.get('res') || '15m')) });

  if (p === '/api/leaderboard' && m === 'GET') {
    const who = String(req.headers['x-player'] || '');
    return send(res, 200, { rows: await leaderboard(), you: TOKEN_RE.test(who) ? publicId(who) : null });
  }

  // ---- everything below needs a player ----
  if (p === '/api/me' && m === 'GET') {
    const me = account(req, res); if (!me) return;
    store.save();
    return send(res, 200, { me: await viewSummary(me.acct), fee: sim.FEE_PCT, minTrade: sim.MIN_TRADE_USD });
  }
  if (p === '/api/me/trades' && m === 'GET') {
    const me = account(req, res); if (!me) return;
    return send(res, 200, { trades: me.acct.trades.slice(0, 100) });
  }
  if (p === '/api/me/nickname' && m === 'POST') {
    const me = account(req, res); if (!me) return;
    const nick = cleanNick((await readBody(req)).nickname);
    if (!nick) return fail(res, 400, 'Use 3 to 16 letters, numbers, spaces, - or _.');
    me.acct.nickname = nick; store.save();
    return send(res, 200, { nickname: nick });
  }
  if (p === '/api/me/reset' && m === 'POST') {
    const me = account(req, res); if (!me) return;
    sim.reset(me.acct, Date.now()); store.save();
    return send(res, 200, { me: await viewSummary(me.acct) });
  }

  if ((p === '/api/quote' || p === '/api/trade') && m === 'POST') {
    const me = account(req, res); if (!me) return;
    if (limited(req, 'trade', 90, 60000)) return fail(res, 429, 'Too many orders. Slow down a little.');
    const body = await readBody(req), inp = tradeInput(body);
    if (inp.error) return fail(res, 400, inp.error);
    const snaps = await market.prices([body.mint], TRADE_PRICE_MAX_AGE_MS);
    // No awaits from here on, so the account cannot change between the quote and the fill.
    const q = sim.quote(me.acct, snaps[body.mint], inp.side, inp.amount);
    if (!q.ok) return fail(res, 400, q.error);
    if (p === '/api/quote') return send(res, 200, { quote: q });
    const t = sim.apply(me.acct, snaps[body.mint], q, Date.now());
    store.save();
    return send(res, 200, { trade: t, me: sim.summary(me.acct, snaps) });
  }
  return fail(res, 404, 'Not found.');
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (file.indexOf(PUBLIC) !== 0) { res.writeHead(403); return res.end(); }
  fs.readFile(file, function (err, buf) {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': /vendor/.test(rel) ? 'public, max-age=86400' : 'no-cache' });
    res.end(buf);
  });
}

const server = http.createServer(function (req, res) {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch (e) { res.writeHead(400); return res.end(); }
  if (url.pathname.indexOf('/api/') === 0) {
    api(req, res, url).catch(function (e) { if (!res.headersSent) fail(res, e.message === 'Body too large' || e.message === 'Invalid JSON' ? 400 : 502, e.message); });
  } else serveStatic(req, res, url);
});

exports.server = server;
if (require.main === module) {
  store.load();
  market.startWatcher();
  server.listen(PORT, HOST, function () { console.log('Dojo at http://' + HOST + ':' + PORT + '  (' + store.count() + ' players, start cash $' + sim.START_CASH + ', fee ' + sim.FEE_PCT + '%)'); });
  const bye = function () { store.flush(); process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
}
