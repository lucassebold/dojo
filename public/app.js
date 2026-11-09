'use strict';
// Dojo: practice trading terminal. Plain JS, no build.
const $ = function (s, r) { return (r || document).querySelector(s); };
const view = $('#view');

// ---------- helpers ----------
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function money(n) { n = Number(n) || 0; return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function compact(n) { n = Number(n) || 0; const a = Math.abs(n); if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B'; if (a >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M'; if (a >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K'; return '$' + n.toFixed(0); }
function price(p) {
  p = Number(p) || 0; if (!p) return '$0';
  if (p >= 1) return '$' + p.toLocaleString('en-US', { maximumFractionDigits: 4 });
  const zeros = Math.floor(-Math.log10(p));
  if (zeros >= 2) {   // 0.0₅ 16: the small number counts the zeros after the decimal point, the way trading terminals write tiny prices
    const digits = String(Math.round(p * Math.pow(10, zeros + 3))).replace(/0+$/, '') || '0';
    return '$0.0' + String(zeros).replace(/\d/g, function (d) { return '\u2080\u2081\u2082\u2083\u2084\u2085\u2086\u2087\u2088\u2089'.charAt(d); }) + digits;
  }
  const d = Math.min(10, Math.max(4, Math.ceil(-Math.log10(p)) + 3));
  return '$' + p.toFixed(d);
}
function qty(n) { n = Number(n) || 0; return n >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : n.toLocaleString('en-US', { maximumFractionDigits: 4 }); }
function pct(n, plus) { n = Number(n) || 0; return (n > 0 && plus !== false ? '+' : '') + n.toFixed(2) + '%'; }
function cls(n) { return n > 0 ? 'up' : n < 0 ? 'down' : 'muted'; }
function ago(t) { const s = Math.max(0, (Date.now() - t) / 1000); return s < 60 ? Math.floor(s) + 's ago' : s < 3600 ? Math.floor(s / 60) + 'm ago' : s < 86400 ? Math.floor(s / 3600) + 'h ago' : Math.floor(s / 86400) + 'd ago'; }
function icon(u, size) { return u && /^https:\/\//.test(u) ? '<img src="' + esc(u) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' : '<span class="ph"></span>'; }
let toastT = null;
function toast(msg, err) { const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false; clearTimeout(toastT); toastT = setTimeout(function () { t.hidden = true; }, 4200); }

// ---------- player id (anonymous, kept in this browser) ----------
function playerId() {
  let id = null;
  try { id = localStorage.getItem('dojo_player'); } catch (e) { /* storage blocked */ }
  if (!id || !/^[a-f0-9]{32}$/.test(id)) {
    const a = new Uint8Array(16); (window.crypto || window.msCrypto).getRandomValues(a);
    id = Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    try { localStorage.setItem('dojo_player', id); } catch (e) { /* storage blocked */ }
  }
  return id;
}
const PLAYER = playerId();

function api(path, opts) {
  opts = opts || {};
  const init = { method: opts.method || 'GET', headers: { 'x-player': PLAYER } };
  if (opts.body) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
  return fetch(path, init).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || 'Request failed (' + r.status + ')'); return j; });
  });
}

// ---------- account (header balance) ----------
let ME = null, FEE = 0.5;
function setMe(me) {
  ME = me;
  $('#balEq').textContent = money(me.equity);
  const p = $('#balPnl'); p.textContent = pct(me.pnlPct); p.className = cls(me.pnl);
}
function refreshMe() { return api('/api/me').then(function (j) { FEE = j.fee; setMe(j.me); return j.me; }).catch(function () { return ME; }); }
setInterval(refreshMe, 20000);

// ---------- router ----------
let timers = [], chart = null, onResize = null;
function every(ms, fn) { timers.push(setInterval(fn, ms)); }
function clearPage() {
  timers.forEach(clearInterval); timers = [];
  if (chart) { try { chart.remove(); } catch (e) { /* gone */ } chart = null; }
  if (onResize) { window.removeEventListener('resize', onResize); onResize = null; }
}
function route() {
  clearPage();
  const h = location.hash.replace(/^#/, '') || '/';
  const nav = h === '/' || h.indexOf('/token/') === 0 ? 'home' : h === '/new' ? 'new' : h === '/portfolio' ? 'portfolio' : h === '/leaderboard' ? 'board' : '';
  document.querySelectorAll('[data-nav]').forEach(function (a) { a.classList.toggle('on', a.getAttribute('data-nav') === nav); });
  window.scrollTo(0, 0);
  const m = /^\/token\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(h);
  if (m) return tokenPage(m[1]);
  if (h === '/new') return newPairsPage();
  if (h === '/portfolio') return portfolioPage();
  if (h === '/leaderboard') return leaderboardPage();
  return homePage();
}
window.addEventListener('hashchange', route);

// ---------- search ----------
(function () {
  const input = $('#searchInput'), box = $('#searchResults');
  let t = null, seq = 0;
  input.addEventListener('input', function () {
    clearTimeout(t);
    const q = input.value.trim();
    if (q.length < 2) { box.hidden = true; return; }
    t = setTimeout(function () {
      const my = ++seq;
      api('/api/search?q=' + encodeURIComponent(q)).then(function (j) {
        if (my !== seq) return;
        box.innerHTML = j.tokens.length ? j.tokens.map(function (s) {
          return '<a href="#/token/' + esc(s.mint) + '"><span><b>' + esc(s.symbol) + '</b> <span class="muted">' + esc(s.name) + '</span></span><span class="muted">' + compact(s.liquidity) + ' liq</span></a>';
        }).join('') : '<a><span class="muted">No results</span></a>';
        box.hidden = false;
      }).catch(function (e) { box.innerHTML = '<a><span class="down">' + esc(e.message) + '</span></a>'; box.hidden = false; });
    }, 300);
  });
  box.addEventListener('click', function () { box.hidden = true; input.value = ''; });
  document.addEventListener('click', function (e) { if (!e.target.closest('.search')) box.hidden = true; });
  $('#searchForm').addEventListener('submit', function (e) { e.preventDefault(); const q = input.value.trim(); if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q)) { location.hash = '#/token/' + q; input.value = ''; box.hidden = true; } });
})();

// ---------- home: trending list ----------
// The market is simulated and moves every second, so the list refreshes every 3 s. Rows are tinted by the move in the chosen
// period, HOT marks tokens whose volume is accelerating, and a number that moved pops, flashes and rolls to its new value.
const TF = [['m5', '5m'], ['h1', '1h'], ['h6', '6h'], ['h24', '24h']];
const TREND_REFRESH_MS = 3000, TREND_SHOWN = 40, TREND_RESORT_MS = 20000;
let trendTf = 'h1', trendList = [], trendPrev = {}, trendAt = 0, trendOrder = [], trendSortedAt = 0, pressing = false;
document.addEventListener('pointerdown', function () { pressing = true; }, true);
document.addEventListener('pointerup', function () { pressing = false; }, true);
document.addEventListener('pointercancel', function () { pressing = false; }, true);
function isHot(t) { return (t.volume.h1 >= 5000 && t.volume.m5 * 12 >= t.volume.h1 * 3) || t.change.m5 >= 15; }
function isNew(t) { return t.createdAt && Date.now() - t.createdAt < 6 * 3600000; }
function arrowPct(v) { return (v >= 0 ? '↑ ' : '↓ ') + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 1 }) + '%'; }
function setTrend(list) { trendPrev = {}; trendList.forEach(function (t) { trendPrev[t.mint] = t; }); trendList = list; trendAt = Date.now(); }

// Price shape over the last 24 h from the 5m / 1h / 6h / 24h changes (older points sit closer together).
function sparkline(t, up) {
  const p = Number(t.price), at = function (c) { const f = 1 + (Number(c) || 0) / 100; return f > 0.01 ? p / f : null; };
  const pts = [[0, at(t.change.h24)], [0.35, at(t.change.h6)], [0.7, at(t.change.h1)], [0.93, at(t.change.m5)], [1, p]].filter(function (x) { return x[1] != null && x[1] > 0; });
  if (pts.length < 2) return '';
  const lo = Math.min.apply(null, pts.map(function (x) { return x[1]; })), hi = Math.max.apply(null, pts.map(function (x) { return x[1]; })), W = 84, H = 30;
  const xy = pts.map(function (x) { return [3 + x[0] * (W - 9), hi === lo ? H / 2 : 4 + (1 - (x[1] - lo) / (hi - lo)) * (H - 8)]; });
  const col = up ? '#22c55e' : '#ef4444', end = xy[xy.length - 1];
  return '<svg class="spark" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true"><polyline fill="none" stroke="' + col + '" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" opacity=".85" points="' +
    xy.map(function (q) { return q[0].toFixed(1) + ',' + q[1].toFixed(1); }).join(' ') + '"/><circle class="ring" cx="' + end[0].toFixed(1) + '" cy="' + end[1].toFixed(1) + '" r="2.6" fill="' + col + '"/><circle cx="' + end[0].toFixed(1) + '" cy="' + end[1].toFixed(1) + '" r="2.6" fill="' + col + '"/></svg>';
}

function tokRow(t, on, bumps, idx) {
  const chg = Number(t.change[trendTf]) || 0, up = chg >= 0, prev = bumps ? trendPrev[t.mint] : null;
  const pc = prev ? Number(prev.change[trendTf]) || 0 : chg;
  // only what the user can actually see changing gets the pop: compare the rendered text, not the raw number
  const mcMoved = prev && compact(prev.marketCap) !== compact(t.marketCap), chMoved = prev && arrowPct(pc) !== arrowPct(chg);
  // Each row breathes all the time: bigger moves and HOT rows breathe faster. The phase comes from the clock, so a
  // re-render does not restart it, and rows are staggered so the list ripples instead of blinking together.
  const k = Math.min(1, Math.abs(chg) / 60), bt = isHot(t) ? 1.5 : 2.8 - k, delay = -(((Date.now() / 1000) + (idx || 0) * 0.17) % bt);
  return '<a class="tok ' + (up ? 't-up' : 't-down') + (on ? ' on' : '') + '" style="--i:' + k.toFixed(2) + ';--bt:' + bt.toFixed(2) + 's;--d:' + delay.toFixed(2) + 's" href="#/token/' + esc(t.mint) + '">' +
    icon(t.icon) +
    '<div class="n"><div class="nm"><b>' + esc(t.symbol) + '</b>' + (isHot(t) ? '<span class="tag hot">&#128293; HOT</span>' : '') + (isNew(t) ? '<span class="tag new">NEW</span>' : '') + '</div>' +
    '<div class="sub">' + price(t.price) + '<span class="extra"> &middot; ' + (t.createdAt ? esc(ago(t.createdAt).replace(' ago', '')) + ' &middot; ' : '') + 'vol ' + compact(t.volume[trendTf]) + '</span></div></div>' + sparkline(t, up) +
    '<div class="r"><div class="mc' + (mcMoved ? (t.marketCap > prev.marketCap ? ' bump-up' : ' bump-down') + '" data-from="' + esc(prev.marketCap) + '" data-to="' + esc(t.marketCap) + '" data-k="usd' : '') + '">' + compact(t.marketCap) + '</div>' +
    '<div class="ch ' + (up ? 'up' : 'down') + (chMoved ? (chg > pc ? ' bump-up' : ' bump-down') + '" data-from="' + esc(pc) + '" data-to="' + esc(chg) + '" data-k="pct' : '') + '">' + arrowPct(chg) + '</div></div></a>';
}
// The order is kept for 20 s so rows do not jump around while the numbers move; it is re-sorted by volume in the chosen period.
function orderedTrend(resort) {
  const by = {}; trendList.forEach(function (t) { by[t.mint] = t; });
  if (resort || !trendOrder.length || Date.now() - trendSortedAt > TREND_RESORT_MS) {
    trendOrder = trendList.slice().sort(function (a, b) { return b.volume[trendTf] - a.volume[trendTf]; }).slice(0, TREND_SHOWN).map(function (t) { return t.mint; });
    trendSortedAt = Date.now();
  }
  return trendOrder.map(function (m) { return by[m]; }).filter(Boolean);
}
// Rolls the changed numbers from their old value to the new one (only values that moved carry data-from).
function animateNums(root) {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  Array.prototype.forEach.call(root.querySelectorAll('[data-to]'), function (el) {
    const from = Number(el.getAttribute('data-from')), to = Number(el.getAttribute('data-to')), usdKind = el.getAttribute('data-k') === 'usd', t0 = performance.now();
    (function step(now) {
      const k = Math.min(1, (now - t0) / 900), e = 1 - Math.pow(1 - k, 3), v = from + (to - from) * e;
      el.textContent = usdKind ? compact(v) : arrowPct(v);
      if (k < 1 && el.isConnected) requestAnimationFrame(step);
    })(t0);
  });
}
// Ambient life: every 2 s a few visible rows re-"build" a number, digits shuffling and settling left to right on the TRUE value.
// It is only a visual effect (neutral violet glow, no green/red, no arrow). The first 10 visible rows take turns (4 per tick,
// each about every 5 s) and 2 random rows from the rest keep the bottom from sitting still.
function scramble(el) {
  const final = el.textContent, n = final.length, t0 = performance.now();
  el.classList.add('scan');
  (function step(now) {
    if (!el.isConnected) return;
    const k = Math.min(1, (now - t0) / 700), fixed = Math.floor(k * n);
    let out = '';
    for (let i = 0; i < n; i++) { const c = final.charAt(i); out += i < fixed || !/[0-9]/.test(c) ? c : String(Math.floor(Math.random() * 10)); }
    el.textContent = out;
    if (k < 1) requestAnimationFrame(step); else el.classList.remove('scan');
  })(t0);
}
function ambientTick(box) {
  if (!box || document.hidden || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
  const rows = Array.prototype.filter.call(box.querySelectorAll('.tok'), function (r) { const b = r.getBoundingClientRect(); return b.bottom > 0 && b.top < window.innerHeight; });
  const run = function (row) {
    const el = row.querySelector(Math.random() < 0.65 ? '.mc' : '.ch');
    if (el && !el.hasAttribute('data-to') && !el.classList.contains('scan')) scramble(el);   // never touch a number that is rolling for a real move
  };
  const top = rows.slice(0, 10), rest = rows.slice(10);
  if (!box._turns || box._turns.length < 4) {
    const order = top.map(function (_, i) { return i; });
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)), x = order[i]; order[i] = order[j]; order[j] = x; }
    box._turns = (box._turns || []).concat(order);
  }
  for (let i = 0; i < 4; i++) { const row = top[box._turns.shift()]; if (row) run(row); }
  for (let i = 0; i < 2 && rest.length; i++) run(rest.splice(Math.floor(Math.random() * rest.length), 1)[0]);
}
function renderTrend(box, bumps, resort) {
  if (!box) return;
  const list = orderedTrend(resort);
  box.innerHTML = list.length ? list.map(function (t, i) { return tokRow(t, false, bumps, i); }).join('') : '<div class="empty">No markets to show right now.</div>';
  animateNums(box);
}

function homePage() {
  view.innerHTML = '<div class="wrap"><div class="hero"><span class="aibadge">Practice market &middot; real tokens, simulated prices</span><h1>Trade memecoins.<br><em>Risk nothing.</em></h1>' +
    '<p>Practice with <b>$10,000</b> of fake money on real Solana tokens. Prices are simulated from the real market: they move like the real thing, with the same liquidity and price impact, and they never freeze. No wallet. No sign-up.</p>' +
    '<div class="trust"><span>Prices moving every second</span><span>Real tokens and liquidity</span><span>No wallet needed</span><span>Compete on the leaderboard</span></div></div>' +
    '<div class="trendhead"><div class="sec-title">Trending on Solana<span class="livedot"></span><span class="trendage" id="trendage">live</span></div>' +
    '<div class="tftabs" id="tftabs">' + TF.map(function (x) { return '<button data-tf="' + x[0] + '"' + (x[0] === trendTf ? ' class="on"' : '') + '>' + x[1] + '</button>'; }).join('') + '</div></div>' +
    '<div id="trend" class="list"><div class="empty">Loading markets...</div></div></div>';
  $('#tftabs').addEventListener('click', function (e) {
    const b = e.target.closest('button'); if (!b) return;
    trendTf = b.getAttribute('data-tf');
    Array.prototype.forEach.call($('#tftabs').children, function (x) { x.classList.toggle('on', x === b); });
    renderTrend($('#trend'), false, true);
  });
  const load = function () {
    if (pressing) return;      // a re-render between mouse down and up would swallow the click
    api('/api/trending').then(function (j) { setTrend(j.tokens); renderTrend($('#trend'), true, false); })
      .catch(function (e) { const box = $('#trend'); if (box && !box.querySelector('.tok')) box.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  };
  if (trendList.length) renderTrend($('#trend'), false, false);   // instant paint from the last read
  every(1000, function () { const a = $('#trendage'); if (a && trendAt) a.textContent = 'updated ' + Math.floor((Date.now() - trendAt) / 1000) + 's ago'; });
  every(2000, function () { ambientTick($('#trend')); });
  load(); every(TREND_REFRESH_MS, load);
}

// ---------- new pairs ----------
function newPairsPage() {
  let amt = 100;
  try { amt = Number(localStorage.getItem('dojo_quickbuy')) || 100; } catch (e) { /* storage blocked */ }
  view.innerHTML = '<div class="wrap"><div class="row" style="margin:22px 0 10px"><div><h2 style="margin:0">New Pairs</h2><span class="muted">Pools created in the last 24 hours, newest first. Very new tokens are the riskiest: practice here.</span></div>' +
    '<label class="qb">Quick buy $<input id="qbAmt" inputmode="decimal" value="' + esc(amt) + '" aria-label="Quick buy amount in dollars"></label></div>' +
    '<div id="np" class="list"><div class="empty">Loading new pairs...</div></div></div>';
  $('#qbAmt').addEventListener('input', function () { try { localStorage.setItem('dojo_quickbuy', String(parseFloat($('#qbAmt').value) || 100)); } catch (e) { /* storage blocked */ } });
  function row(s) {
    const tx = s.buys24 + s.sells24, buyShare = tx ? Math.round(s.buys24 * 100 / tx) : 0;
    return '<div class="np"><a class="np-main" href="#/token/' + esc(s.mint) + '">' + icon(s.icon) +
      '<div class="n"><b>' + esc(s.symbol) + '</b><span>' + esc(s.name) + '</span></div>' +
      '<div class="age" data-t="' + esc(s.createdAt) + '">' + esc(ago(s.createdAt).replace(' ago', '')) + '</div>' +
      '<div class="r"><span class="muted">MC</span> <b>' + compact(s.marketCap) + '</b><br><span class="muted">Liq</span> ' + compact(s.liquidity) + '</div>' +
      '<div class="r"><span class="muted">Vol 1h</span> <b>' + compact(s.volume.h1) + '</b><br><span class="muted">Txns</span> ' + tx + ' <span class="' + (buyShare >= 50 ? 'up' : 'down') + '">' + buyShare + '% buys</span></div>' +
      '<div class="r ' + cls(s.change.h1) + '"><b>' + pct(s.change.h1) + '</b><br><span class="muted">1h</span></div></a>' +
      '<button class="btn small qbtn" data-mint="' + esc(s.mint) + '" data-sym="' + esc(s.symbol) + '">&#9889; Buy</button></div>';
  }
  const load = function () {
    api('/api/new').then(function (j) {
      $('#np').innerHTML = j.tokens.length ? j.tokens.map(row).join('') : '<div class="empty">No new pairs to show right now.</div>';
    }).catch(function (e) { if (!$('#np .np')) $('#np').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  };
  $('#np').addEventListener('click', function (e) {
    const b = e.target.closest('.qbtn'); if (!b || b.disabled) return;
    const usd = parseFloat(String($('#qbAmt').value).replace(',', '.'));
    if (!isFinite(usd) || usd <= 0) return toast('Enter a quick buy amount.', true);
    b.disabled = true;
    api('/api/trade', { method: 'POST', body: { mint: b.getAttribute('data-mint'), side: 'buy', usd: usd } }).then(function (j) {
      setMe(j.me); toast('Bought ' + qty(j.trade.qty) + ' ' + j.trade.symbol + ' for ' + money(j.trade.usd));
    }).catch(function (err) { toast(err.message, true); }).then(function () { b.disabled = false; });
  });
  load(); every(15000, load);
  every(1000, function () { Array.prototype.forEach.call(document.querySelectorAll('.age'), function (a) { a.textContent = ago(Number(a.getAttribute('data-t'))).replace(' ago', ''); }); });
}

// ---------- token page ----------
// A pro-terminal chart: candles + volume, a two-line legend that follows the cursor, Market cap or Price on the axis, your buys and
// sells drawn on the candles, a dashed line at your average entry coloured by your P&L, zoom shortcuts, log / % scales, and the
// Bought / Sold / Holding / PnL block under the order panel. Candles come straight from the simulated market, so they never wait on an API.
const CHART_TFS = ['1s', '15s', '30s', '1m', '5m', '15m', '1h', '4h', 'D'];
const TF_STEP = { '1s': 1, '15s': 15, '30s': 30, '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, 'D': 86400 };
const RANGES = [['5m', 300], ['15m', 900], ['1h', 3600], ['6h', 21600], ['24h', 86400]];
const TZ = -new Date().getTimezoneOffset() * 60;      // chart times are shown in the viewer's local time, like the terminal does
function clock(t) { return new Date(t).toLocaleTimeString('en-GB'); }
function utcLabel() { const h = -new Date().getTimezoneOffset() / 60; return 'UTC' + (h >= 0 ? '+' : '') + h; }

function tokenPage(mint) {
  view.innerHTML = '<div class="tokpage"><div class="tokmain"><div id="thead" class="thead"><span class="muted">Loading...</span></div>' +
    '<div class="charttools"><div class="tfs" id="tfs"></div><div class="toolr"><button id="hideall" class="tbtn" title="Hide your buy/sell arrows and entry line">Hide All</button>' +
    '<div class="modes" id="modes"><button data-m="mc">MarketCap</button><span>/</span><button data-m="price">Price</button></div></div></div>' +
    '<div class="chartwrap"><div class="legend" id="legend"></div><div id="chart"></div></div>' +
    '<div class="chartbar"><div class="ranges" id="ranges"></div><div class="barr"><span id="clock" class="muted"></span><button id="bpct" class="tbtn">%</button><button id="blog" class="tbtn">log</button><button id="bauto" class="tbtn on">auto</button></div></div>' +
    '<div class="btabs" id="btabs"><button data-t="trades" class="on">Trades</button><button data-t="positions">Positions</button><button data-t="info">Info &amp; risk</button></div>' +
    '<div class="tokinfo" id="bpane"></div></div><aside class="tokside" id="side"></aside></div>';
  let snap = null, risk = null, res = '1m', mode = 'mc', tab = 'trades', series = null, vol = null, entryLine = null, hideMarks = false, scaleMode = 0, autoScale = true;
  let rawBars = [], byTime = {}, cursorTime = null, mult = 1, myTrades = [], side = 'buy', quoteSeq = 0, quoteT = null, busy = false;
  try { mode = localStorage.getItem('dojo_chart_mode') === 'price' ? 'price' : 'mc'; } catch (e) { /* storage blocked */ }

  CHART_TFS.forEach(function (r) {
    const b = document.createElement('button'); b.textContent = r === 'D' ? '1D' : r; b.className = r === res ? 'on' : '';
    b.addEventListener('click', function () {
      res = r; Array.prototype.forEach.call($('#tfs').children, function (x) { x.classList.toggle('on', x === b); });
      rawBars = []; byTime = {}; if (series) { series.setData([]); vol.setData([]); series.setMarkers([]); }
      if (chart) chart.applyOptions({ timeScale: { secondsVisible: TF_STEP[r] < 60 } });
      loadBars(true);
    });
    $('#tfs').appendChild(b);
  });
  RANGES.forEach(function (r) {
    const b = document.createElement('button'); b.textContent = r[0];
    b.addEventListener('click', function () {
      if (!chart || !rawBars.length) return;
      const last = rawBars[rawBars.length - 1].time + TZ;
      chart.timeScale().setVisibleRange({ from: last - r[1], to: last + TF_STEP[res] * 3 });
    });
    $('#ranges').appendChild(b);
  });
  function paintModes() { Array.prototype.forEach.call($('#modes').querySelectorAll('button'), function (b) { b.classList.toggle('on', b.getAttribute('data-m') === mode); }); }
  $('#modes').addEventListener('click', function (e) {
    const b = e.target.closest('button'); if (!b) return;
    mode = b.getAttribute('data-m'); try { localStorage.setItem('dojo_chart_mode', mode); } catch (er) { /* storage blocked */ }
    paintModes(); if (series) { applyScale(); series.setData(rawBars.map(conv)); paintEntry(); showLegend(); }
  });
  paintModes();
  $('#hideall').addEventListener('click', function () { hideMarks = !hideMarks; $('#hideall').classList.toggle('on', hideMarks); paintMarkers(); paintEntry(); });
  function setScale(m) {
    scaleMode = scaleMode === m ? 0 : m;
    $('#bpct').classList.toggle('on', scaleMode === 2); $('#blog').classList.toggle('on', scaleMode === 1);
    if (chart) chart.priceScale('right').applyOptions({ mode: scaleMode });
  }
  $('#bpct').addEventListener('click', function () { setScale(2); });
  $('#blog').addEventListener('click', function () { setScale(1); });
  $('#bauto').addEventListener('click', function () { autoScale = !autoScale; $('#bauto').classList.toggle('on', autoScale); if (chart) chart.priceScale('right').applyOptions({ autoScale: autoScale }); });
  every(1000, function () { const c = $('#clock'); if (c) c.textContent = new Date().toLocaleTimeString('en-GB') + ' ' + utcLabel(); });

  function position() { return ME && ME.positions.filter(function (p) { return p.mint === mint; })[0] || null; }
  const unit = function () { return mode === 'mc' ? mult : 1; };
  const conv = function (b) { const m = unit(); return { time: b.time + TZ, open: b.open * m, high: b.high * m, low: b.low * m, close: b.close * m }; };
  const fmtVal = function (v) { return mode === 'mc' ? compact(v).slice(1) : price(v).slice(1); };   // no $ on the chart, like the terminal

  // ---- header, side panel blocks, bottom panel ----
  function head() {
    const s = snap, sup = s.supply || (s.price > 0 ? s.marketCap / s.price : 0);
    $('#thead').innerHTML = '<div class="name">' + icon(s.icon) + '<div><b style="font-size:16px">' + esc(s.symbol) + '</b> <span class="muted">' + esc(s.name) + '</span><br><span class="up">' + (s.createdAt ? esc(ago(s.createdAt).replace(' ago', '')) : '') + '</span> <span class="simtag" title="Simulated price, based on the real market">sim</span></div></div>' +
      '<div class="bigmc">' + compact(s.marketCap) + '</div>' +
      '<div class="stat"><span>Price</span><b>' + price(s.price) + '</b></div>' +
      '<div class="stat"><span>Liquidity</span><b>' + compact(s.liquidity) + '</b></div>' +
      '<div class="stat"><span>Supply</span><b>' + qtyShort(sup) + '</b></div>' +
      '<div class="stat"><span>ATH</span><b>' + compact(s.ath || s.marketCap) + '</b></div>' +
      '<div class="stat"><span>5m</span><b class="' + cls(s.change.m5) + '">' + pct(s.change.m5) + '</b></div>' +
      '<div class="stat"><span>1h</span><b class="' + cls(s.change.h1) + '">' + pct(s.change.h1) + '</b></div>' +
      '<div class="stat"><span>24h</span><b class="' + cls(s.change.h24) + '">' + pct(s.change.h24) + '</b></div>';
  }
  function qtyShort(n) { n = Number(n) || 0; return n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(0); }
  function flowBlock() {
    const el = $('#flow'); if (!el || !snap || !snap.flow5m) return;
    const f = snap.flow5m, net = f.buyVol - f.sellVol, tot = f.buyVol + f.sellVol || 1;
    el.innerHTML = '<div class="fcell"><span>5m Vol</span><b>' + compact(f.vol) + '</b></div><div class="fcell"><span>Buys</span><b class="up">' + f.buys + ' / ' + compact(f.buyVol) + '</b></div>' +
      '<div class="fcell"><span>Sells</span><b class="down">' + f.sells + ' / ' + compact(f.sellVol) + '</b></div><div class="fcell"><span>Net Vol</span><b class="' + cls(net) + '">' + (net >= 0 ? '+' : '-') + compact(Math.abs(net)) + '</b></div>' +
      '<div class="fbar"><i style="width:' + (f.buyVol / tot * 100).toFixed(1) + '%"></i></div>';
  }
  function pnlBlock() {
    const el = $('#pnl'); if (!el) return;
    let bought = 0, sold = 0;
    myTrades.forEach(function (t) { if (t.side === 'buy') bought += t.usd; else sold += t.usd; });
    const pos = position(), holding = pos ? pos.value : 0, pnl = holding + sold - bought, pc = bought ? pnl / bought * 100 : 0, none = !myTrades.length;
    const cell = function (label, val, c) { return '<div class="pcell"><span>' + label + '</span><b class="' + (c || '') + '">' + val + '</b></div>'; };
    el.innerHTML = cell('Bought', none ? money(0) : money(bought)) + cell('Sold', none ? money(0) : money(sold)) + cell('Holding', money(holding)) +
      cell('PnL', (pnl >= 0 ? '+' : '') + money(pnl) + ' <small>(' + (pc >= 0 ? '+' : '') + pc.toFixed(0) + '%)</small>', none ? 'muted' : cls(pnl));
  }
  function paintBottom() {
    Array.prototype.forEach.call($('#btabs').children, function (b) { b.classList.toggle('on', b.getAttribute('data-t') === tab); });
    const el = $('#bpane'); if (!el) return;
    if (tab === 'trades') {
      const sup = snap && snap.price > 0 ? snap.marketCap / snap.price : 1;
      el.innerHTML = myTrades.length ? '<div class="scroll"><table><tr><th>Time</th><th>Type</th><th class="r">Market cap</th><th class="r">Price</th><th class="r">Amount</th><th class="r">Value</th><th class="r">Fee</th><th class="r">P&amp;L</th></tr>' +
        myTrades.map(function (t) {
          return '<tr><td class="muted">' + clock(t.t) + '</td><td class="' + (t.side === 'buy' ? 'up' : 'down') + '"><b>' + (t.side === 'buy' ? 'Buy' : 'Sell') + '</b></td><td class="r">' + compact(t.price * sup) + '</td><td class="r">' + price(t.price) +
            '</td><td class="r">' + qty(t.qty) + '</td><td class="r">' + money(t.usd) + '</td><td class="r muted">' + money(t.fee) + '</td><td class="r ' + cls(t.pnl) + '">' + (t.pnl == null ? '-' : money(t.pnl)) + '</td></tr>';
        }).join('') + '</table></div>'
        : '<div class="empty" style="border:0">You have not traded ' + (snap ? esc(snap.symbol) : 'this token') + ' yet. Your buys and sells will show here and on the chart.</div>';
    } else if (tab === 'positions') {
      const ps = ME ? ME.positions : [];
      el.innerHTML = ps.length ? '<div class="scroll"><table><tr><th>Token</th><th class="r">Amount</th><th class="r">Avg entry</th><th class="r">Price</th><th class="r">Exit value</th><th class="r">P&amp;L</th></tr>' +
        ps.map(function (p) { return '<tr><td><a href="#/token/' + esc(p.mint) + '"><b>' + esc(p.symbol) + '</b></a></td><td class="r">' + qty(p.qty) + '</td><td class="r">' + price(p.avgPrice) + '</td><td class="r">' + price(p.price) + '</td><td class="r">' + money(p.value) + '</td><td class="r ' + cls(p.pnl) + '">' + money(p.pnl) + ' <small>(' + pct(p.pnlPct) + ')</small></td></tr>'; }).join('') + '</table></div>'
        : '<div class="empty" style="border:0">No open positions.</div>';
    } else if (risk && snap) {
      const s = snap, age = s.createdAt ? ago(s.createdAt).replace(' ago', '') : '?';
      el.innerHTML = '<div class="card"><div class="row"><b>Risk</b><span class="badge ' + esc(risk.label) + '">' + esc(risk.label) + ' (' + risk.score + '/100)</span></div>' +
        (risk.reasons.length ? '<ul style="margin:8px 0 0;padding-left:18px" class="muted">' + risk.reasons.map(function (r) { return '<li>' + esc(r.text) + '</li>'; }).join('') + '</ul>' : '<p class="muted" style="margin:8px 0 0">Nothing unusual in the data. That is not a guarantee.</p>') + '</div>' +
        '<div class="card"><div class="kv"><span>Pair age</span><b>' + esc(age) + '</b></div><div class="kv"><span>Buys / sells (24h)</span><b>' + s.buys24 + ' / ' + s.sells24 + '</b></div>' +
        '<div class="kv"><span>Exchange</span><b>' + esc(s.dex) + '</b></div><div class="kv"><span>Address</span><b class="mono">' + esc(s.mint.slice(0, 6)) + '...' + esc(s.mint.slice(-4)) + '</b></div></div>';
    }
  }
  $('#btabs').addEventListener('click', function (e) { const b = e.target.closest('button'); if (!b) return; tab = b.getAttribute('data-t'); paintBottom(); });

  function loadTrades() {
    return api('/api/me/trades?mint=' + encodeURIComponent(mint) + '&limit=500').then(function (j) { myTrades = j.trades; pnlBlock(); paintBottom(); paintMarkers(); }).catch(function () {});
  }
  function loadSnap() {
    return api('/api/token/' + mint).then(function (j) {
      snap = j.token; risk = j.risk; head(); flowBlock(); pnlBlock(); renderPos(); paintEntry();
      if (!$('#amt')) renderSide(false);
      if (tab === 'info') paintBottom();
    });
  }
  function refreshAll() { return refreshMe().then(function () { pnlBlock(); renderPos(); paintEntry(); if (tab === 'positions') paintBottom(); }); }

  // ---- chart ----
  function fmt(p) { const d = p >= 1 ? 4 : Math.min(10, Math.ceil(-Math.log10(p)) + 4); return { type: 'price', precision: d, minMove: Math.pow(10, -d) }; }
  function applyScale() {
    if (!series) return;
    series.applyOptions({ priceFormat: { type: 'custom', minMove: mode === 'mc' ? 0.01 : Math.max(fmt(snap.price || 0.0001).minMove, 1e-12), formatter: function (v) { return fmtVal(v); } } });
  }
  function volPoint(b) { return { time: b.time + TZ, value: b.volume || 0, color: b.close >= b.open ? '#26d0a066' : '#f0504e66' }; }
  function ensureChart() {
    if (chart || !snap) return;
    const el = $('#chart');
    chart = LightweightCharts.createChart(el, {
      height: 520, width: el.clientWidth, layout: { background: { color: '#09060f' }, textColor: '#9a8fb3' },
      grid: { vertLines: { color: '#150f20' }, horzLines: { color: '#150f20' } }, crosshair: { mode: 0 },
      timeScale: { timeVisible: true, secondsVisible: TF_STEP[res] < 60, borderColor: '#261b3a' },
      rightPriceScale: { borderColor: '#261b3a', scaleMargins: { top: 0.08, bottom: 0.24 }, mode: scaleMode }
    });
    series = chart.addCandlestickSeries({ upColor: '#26d0a0', downColor: '#f0504e', borderVisible: false, wickUpColor: '#26d0a0', wickDownColor: '#f0504e', priceLineStyle: 1, priceLineWidth: 1 });
    vol = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: '', lastValueVisible: true, priceLineVisible: false });
    vol.priceScale().applyOptions({ scaleMargins: { top: 0.86, bottom: 0 } });
    applyScale();
    chart.subscribeCrosshairMove(function (p) { cursorTime = p && p.time ? p.time - TZ : null; showLegend(); });
    onResize = function () { if (chart) chart.applyOptions({ width: el.clientWidth }); };
    window.addEventListener('resize', onResize);
  }
  // Two lines like the terminal: the candle under the cursor (the latest one when the cursor is away) and its volume
  function showLegend() {
    const el = $('#legend'); if (!el || !snap) return;
    const b = (cursorTime && byTime[cursorTime]) || rawBars[rawBars.length - 1], tf = res === 'D' ? '1D' : res;
    const title = '<b>' + esc(snap.name || snap.symbol) + '/USD</b> <span class="muted">on ' + esc(snap.dex || 'dex') + ' &middot; ' + tf + ' &middot; dojo &middot; ' + (mode === 'mc' ? 'Market cap' : 'Price') + '</span>';
    if (!b) { el.innerHTML = title; return; }
    const m = unit(), up = b.close >= b.open, c = up ? 'up' : 'down', d = (b.close - b.open) * m, ch = b.open ? (b.close / b.open - 1) * 100 : 0;
    el.innerHTML = title + ' <span class="lg">O<i class="' + c + '">' + fmtVal(b.open * m) + '</i></span><span class="lg">H<i class="' + c + '">' + fmtVal(b.high * m) + '</i></span><span class="lg">L<i class="' + c + '">' + fmtVal(b.low * m) + '</i></span>' +
      '<span class="lg">C<i class="' + c + '">' + fmtVal(b.close * m) + '</i></span><span class="lg"><i class="' + c + '">' + (d >= 0 ? '+' : '-') + fmtVal(Math.abs(d)) + ' (' + (ch >= 0 ? '+' : '') + ch.toFixed(2) + '%)</i></span>' +
      '<div class="lgv">Volume <i class="' + c + '">' + compact(b.volume).slice(1) + '</i></div>';
  }
  // Your buys and sells, as arrows on the candle where they happened (only where that candle is on the chart)
  function paintMarkers() {
    if (!series) return;
    const step = TF_STEP[res], ms = [];
    if (!hideMarks) myTrades.slice().reverse().forEach(function (t) {
      const bt = Math.floor(t.t / 1000 / step) * step; if (!byTime[bt]) return;
      ms.push({ time: bt + TZ, position: t.side === 'buy' ? 'belowBar' : 'aboveBar', color: t.side === 'buy' ? '#26d0a0' : '#f0504e', shape: t.side === 'buy' ? 'arrowUp' : 'arrowDown', text: (t.side === 'buy' ? 'B ' : 'S ') + compact(t.usd) });
    });
    series.setMarkers(ms);
  }
  // A dashed line at your average entry, green when you are up and red when you are down, with the P&L on it
  function paintEntry() {
    if (!series) return;
    const pos = position();
    if (!pos || hideMarks) { if (entryLine) { series.removePriceLine(entryLine); entryLine = null; } return; }
    const o = { price: pos.avgPrice * unit(), color: pos.pnl >= 0 ? '#26d0a0' : '#f0504e', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'Entry ' + (pos.pnl >= 0 ? '+' : '') + pos.pnlPct.toFixed(1) + '%' };
    if (entryLine) entryLine.applyOptions(o); else entryLine = series.createPriceLine(o);
  }
  function loadBars(first) {
    const askedRes = res;
    if (!snap) return;
    api('/api/bars?pair=' + encodeURIComponent(snap.pair) + '&res=' + res).then(function (j) {
      if (res !== askedRes) return;      // the user already switched period
      ensureChart();
      const m = $('#chart').querySelector('.chartmsg'); if (m) m.remove();
      mult = snap.price > 0 ? snap.marketCap / snap.price : 1;
      rawBars = j.bars; byTime = {}; rawBars.forEach(function (b) { byTime[b.time] = b; });
      applyScale(); series.setData(rawBars.map(conv)); vol.setData(rawBars.map(volPoint));
      paintMarkers(); paintEntry(); showLegend();
      if (first) chart.timeScale().fitContent();
    }).catch(function (e) {
      if (res === askedRes && !$('#chart').querySelector('.chartmsg')) $('#chart').insertAdjacentHTML('beforeend', '<div class="chartmsg note">' + esc(e.message) + '</div>');
    });
  }
  // Every 2 s: the last candles, straight from the simulation
  function pollBars() {
    if (!series || !rawBars.length) return;
    const askedRes = res;
    api('/api/bars?pair=' + encodeURIComponent(snap.pair) + '&res=' + res + '&limit=2').then(function (j) {
      if (res !== askedRes || !series || !rawBars.length) return;
      const lastT = rawBars[rawBars.length - 1].time;
      j.bars.forEach(function (b) {
        if (b.time < lastT) return;
        if (b.time === lastT) rawBars[rawBars.length - 1] = b; else rawBars.push(b);
        byTime[b.time] = b; series.update(conv(b)); vol.update(volPoint(b));
      });
      showLegend();
    }).catch(function () { /* the next poll tries again */ });
  }

  // ---- order panel ----
  function renderPos() {
    const el = $('#poscard'); if (!el || !snap) return;
    const pos = position();
    el.innerHTML = pos ? '<div class="row"><b>Your position</b><span class="' + cls(pos.pnl) + '">' + money(pos.pnl) + ' (' + pct(pos.pnlPct) + ')</span></div>' +
      '<div class="kv"><span>Holding</span><b>' + qty(pos.qty) + ' ' + esc(pos.symbol) + '</b></div><div class="kv"><span>Avg entry</span><b>' + price(pos.avgPrice) + '</b></div><div class="kv"><span>Cost</span><b>' + money(pos.cost) + '</b></div><div class="kv"><span>Exit value</span><b>' + money(pos.value) + '</b></div>'
      : '<span class="muted">You do not hold ' + esc(snap.symbol) + ' yet.</span>';
  }
  function renderSide(keepInput) {
    if (!snap) return;
    const prev = keepInput && $('#amt') ? $('#amt').value : '';
    const presets = side === 'buy' ? [50, 100, 500, 1000] : [25, 50, 75, 100];
    $('#side').innerHTML = '<div class="flow" id="flow"></div>' +
      '<div class="seg"><button class="buy' + (side === 'buy' ? ' on' : '') + '" data-side="buy">Buy</button><button class="sell' + (side === 'sell' ? ' on' : '') + '" data-side="sell">Sell</button></div>' +
      '<div class="row note"><span>Market &middot; Cash</span><b id="cashv">' + (ME ? money(ME.cash) : '...') + '</b></div>' +
      '<div class="presets">' + presets.map(function (p) { return '<button data-p="' + p + '">' + (side === 'buy' ? '$' + p : p + '%') + '</button>'; }).join('') + '</div>' +
      '<label class="field"><span>' + (side === 'buy' ? 'Amount to spend (USD)' : 'Percent of your position to sell') + '</span><input id="amt" inputmode="decimal" autocomplete="off" placeholder="100" value="' + esc(prev) + '"></label>' +
      '<div class="preview" id="prev"><span class="muted">Enter an amount to see the fill.</span></div>' +
      '<button class="btn tradebtn ' + (side === 'buy' ? 'buy' : 'sell') + '" id="go" disabled>' + (side === 'buy' ? 'Buy ' : 'Sell ') + esc(snap.symbol) + '</button>' +
      '<div class="pnlblock" id="pnl"></div>' +
      '<p class="note">Fills use the simulated price, the pool\'s liquidity (price impact) and a ' + esc(FEE) + '% fee, like a real order.</p>' +
      '<div class="card" id="poscard" style="margin-top:14px"></div>';
    flowBlock(); pnlBlock(); renderPos();
    Array.prototype.forEach.call(document.querySelectorAll('[data-side]'), function (b) { b.addEventListener('click', function () { side = b.getAttribute('data-side'); renderSide(false); }); });
    Array.prototype.forEach.call(document.querySelectorAll('[data-p]'), function (b) { b.addEventListener('click', function () { $('#amt').value = b.getAttribute('data-p'); onInput(); }); });
    $('#amt').addEventListener('input', onInput);
    $('#go').addEventListener('click', execute);
    if (prev) onInput();
  }
  function body() {
    const v = parseFloat(String($('#amt').value).replace(',', '.'));
    if (!isFinite(v) || v <= 0) return null;
    return side === 'buy' ? { mint: mint, side: 'buy', usd: v } : { mint: mint, side: 'sell', pct: Math.min(100, v) };
  }
  function onInput() {
    clearTimeout(quoteT); $('#go').disabled = true;
    const b = body();
    if (!b) { $('#prev').innerHTML = '<span class="muted">Enter an amount to see the fill.</span>'; return; }
    quoteT = setTimeout(function () {
      const my = ++quoteSeq;
      api('/api/quote', { method: 'POST', body: b }).then(function (j) {
        if (my !== quoteSeq || !$('#prev')) return;
        const q = j.quote, sym = esc(snap.symbol);
        $('#prev').innerHTML = (q.side === 'buy'
          ? 'You get about <b>' + qty(q.qty) + ' ' + sym + '</b><br><span class="muted">Avg price ' + price(q.execPrice) + ' &middot; fee ' + money(q.fee) + '</span>'
          : 'You receive about <b>' + money(q.net) + '</b> for ' + qty(q.qty) + ' ' + sym + '<br><span class="muted">Avg price ' + price(q.execPrice) + ' &middot; fee ' + money(q.fee) + '</span>') +
          '<br><span class="' + (q.impactPct > 5 ? 'warn' : 'muted') + '">Price impact ' + q.impactPct.toFixed(2) + '%' + (q.impactPct > 5 ? ' - this order moves the market a lot' : '') + '</span>';
        $('#go').disabled = false;
      }).catch(function (e) { if (my === quoteSeq && $('#prev')) $('#prev').innerHTML = '<span class="down">' + esc(e.message) + '</span>'; });
    }, 250);
  }
  function execute() {
    const b = body(); if (!b || busy) return;
    busy = true; $('#go').disabled = true;
    api('/api/trade', { method: 'POST', body: b }).then(function (j) {
      setMe(j.me); const t = j.trade;
      toast((t.side === 'buy' ? 'Bought ' : 'Sold ') + qty(t.qty) + ' ' + t.symbol + ' at ' + price(t.price) + (t.pnl != null ? ' (' + (t.pnl >= 0 ? '+' : '') + money(t.pnl) + ')' : ''));
      renderSide(false); loadTrades(); paintEntry();
    }).catch(function (e) { toast(e.message, true); onInput(); }).then(function () { busy = false; });
  }

  Promise.all([refreshMe(), loadSnap(), loadTrades()]).then(function () { renderSide(false); paintBottom(); loadBars(true); }).catch(function (e) {
    $('#thead').innerHTML = '<span class="down">' + esc(e.message) + '</span>';
  });
  every(2000, function () { loadSnap().catch(function () {}); });
  every(2000, function () { refreshAll(); const c = $('#cashv'); if (c && ME) c.textContent = money(ME.cash); });
  every(2000, pollBars);
  every(30000, function () { loadBars(false); });
}

// ---------- portfolio ----------
function portfolioPage() {
  view.innerHTML = '<div class="wrap"><div class="row" style="margin:22px 0 4px"><h2 style="margin:0">Portfolio</h2><div class="nick"><input id="nick" maxlength="16" aria-label="Nickname"><button class="btn small" id="saveNick">Save name</button></div></div><div id="pf"><div class="empty">Loading...</div></div></div>';
  let tradesCache = null;
  function render(me) {
    const posRows = me.positions.length ? me.positions.map(function (p) {
      return '<tr><td><a href="#/token/' + esc(p.mint) + '"><b>' + esc(p.symbol) + '</b></a></td><td class="r">' + qty(p.qty) + '</td><td class="r">' + price(p.avgPrice) + '</td><td class="r">' + price(p.price) + (p.live ? '' : ' <span class="muted" title="Could not refresh. Showing the last known price.">*</span>') + '</td><td class="r">' + money(p.value) + '</td>' +
        '<td class="r ' + cls(p.pnl) + '">' + money(p.pnl) + '<br><small>' + pct(p.pnlPct) + '</small></td><td class="r"><button class="btn small" data-sell="' + esc(p.mint) + '" data-pct="50">50%</button> <button class="btn small sell" data-sell="' + esc(p.mint) + '" data-pct="100">Sell all</button></td></tr>';
    }).join('') : '<tr><td colspan="7"><div class="empty" style="border:0">No open positions. Pick a token on <a href="#/" style="color:var(--accent2)">Markets</a> to place your first trade.</div></td></tr>';
    $('#pf').innerHTML = '<div class="stats"><div class="stat"><span>Equity</span><b class="big">' + money(me.equity) + '</b></div><div class="stat"><span>Total P&amp;L</span><b class="big ' + cls(me.pnl) + '">' + money(me.pnl) + ' (' + pct(me.pnlPct) + ')</b></div>' +
      '<div class="stat"><span>Cash</span><b class="big">' + money(me.cash) + '</b></div><div class="stat"><span>Win rate</span><b class="big">' + (me.winRate == null ? '-' : me.winRate.toFixed(0) + '%') + '</b><br><small class="muted">' + me.closed + ' closed trades</small></div>' +
      '<div class="stat"><span>Best / worst trade</span><b class="big">' + (me.best == null ? '-' : '<span class="up">' + money(me.best) + '</span>') + '</b><br><small class="' + (me.worst < 0 ? 'down' : 'muted') + '">' + (me.worst == null ? '' : money(me.worst)) + '</small></div></div>' +
      '<div class="sec-title">Open positions</div><div class="card scroll"><table><tr><th>Token</th><th class="r">Amount</th><th class="r">Avg entry</th><th class="r">Price</th><th class="r">Exit value</th><th class="r">P&amp;L</th><th></th></tr>' + posRows + '</table><p class="note" style="margin:8px 0 0">Exit value is what the position would fetch right now after price impact, so thin pools cannot inflate your balance.</p></div>' +
      '<div class="sec-title">Trade history</div><div class="card scroll" id="hist"><span class="muted">Loading...</span></div>' +
      '<div class="row" style="margin-top:20px"><span class="note">Started with ' + money(me.startCash) + (me.resets ? ' &middot; ' + me.resets + ' reset' + (me.resets > 1 ? 's' : '') : '') + '</span><button class="btn small" id="reset">Reset account</button></div>';
    Array.prototype.forEach.call(document.querySelectorAll('[data-sell]'), function (b) {
      b.addEventListener('click', function () {
        b.disabled = true;
        api('/api/trade', { method: 'POST', body: { mint: b.getAttribute('data-sell'), side: 'sell', pct: Number(b.getAttribute('data-pct')) } }).then(function (j) {
          setMe(j.me); toast('Sold ' + qty(j.trade.qty) + ' ' + j.trade.symbol + (j.trade.pnl != null ? ' (' + (j.trade.pnl >= 0 ? '+' : '') + money(j.trade.pnl) + ')' : '')); tradesCache = null; render(j.me); loadTrades();
        }).catch(function (e) { toast(e.message, true); b.disabled = false; });
      });
    });
    $('#reset').addEventListener('click', function () {
      if (!confirm('Reset your account? You get a fresh ' + money(me.startCash) + ' and your history is cleared.')) return;
      api('/api/me/reset', { method: 'POST', body: {} }).then(function (j) { setMe(j.me); tradesCache = null; render(j.me); loadTrades(); toast('Account reset.'); }).catch(function (e) { toast(e.message, true); });
    });
    loadTrades();
  }
  function loadTrades() {
    const draw = function (list) {
      const el = $('#hist'); if (!el) return;
      el.innerHTML = list.length ? '<table><tr><th>When</th><th>Side</th><th>Token</th><th class="r">Amount</th><th class="r">Price</th><th class="r">Value</th><th class="r">Fee</th><th class="r">P&amp;L</th></tr>' + list.map(function (t) {
        return '<tr><td class="muted">' + ago(t.t) + '</td><td class="' + (t.side === 'buy' ? 'up' : 'down') + '">' + (t.side === 'buy' ? 'Buy' : 'Sell') + '</td><td><a href="#/token/' + esc(t.mint) + '">' + esc(t.symbol) + '</a></td><td class="r">' + qty(t.qty) + '</td><td class="r">' + price(t.price) + '</td><td class="r">' + money(t.usd) + '</td><td class="r muted">' + money(t.fee) + '</td><td class="r ' + cls(t.pnl) + '">' + (t.pnl == null ? '-' : money(t.pnl)) + '</td></tr>';
      }).join('') + '</table>' : '<div class="empty" style="border:0">No trades yet.</div>';
    };
    if (tradesCache) return draw(tradesCache);
    api('/api/me/trades').then(function (j) { tradesCache = j.trades; draw(j.trades); }).catch(function () { draw([]); });
  }
  refreshMe().then(function (me) {
    if (!me) { $('#pf').innerHTML = '<div class="empty">Could not load your account.</div>'; return; }
    $('#nick').value = me.nickname; render(me);
  });
  $('#saveNick').addEventListener('click', function () {
    api('/api/me/nickname', { method: 'POST', body: { nickname: $('#nick').value } }).then(function (j) { toast('Saved as ' + j.nickname); }).catch(function (e) { toast(e.message, true); });
  });
  every(15000, function () { refreshMe().then(function (me) { if (me && $('#pf') && document.activeElement.tagName !== 'BUTTON') render(me); }); });
}

// ---------- leaderboard ----------
function leaderboardPage() {
  view.innerHTML = '<div class="wrap"><h2 style="margin:22px 0 4px">Leaderboard</h2><p class="muted" style="margin:0 0 12px">Ranked by return on the starting balance. Only players who have traded appear. Positions count at their exit value.</p><div class="card scroll" id="lb"><span class="muted">Loading...</span></div></div>';
  const load = function () {
    api('/api/leaderboard').then(function (j) {
      $('#lb').innerHTML = j.rows.length ? '<table><tr><th>#</th><th>Trader</th><th class="r">Return</th><th class="r">Equity</th><th class="r">Trades</th><th class="r">Win rate</th></tr>' + j.rows.map(function (r, i) {
        return '<tr class="' + (r.id === j.you ? 'me' : '') + '"><td>' + (i + 1) + '</td><td><b>' + esc(r.nickname) + '</b>' + (r.id === j.you ? ' <span class="badge">you</span>' : '') + '</td><td class="r ' + cls(r.pnlPct) + '">' + pct(r.pnlPct) + '</td><td class="r">' + money(r.equity) + '</td><td class="r">' + r.trades + '</td><td class="r">' + (r.winRate == null ? '-' : r.winRate.toFixed(0) + '%') + '</td></tr>';
      }).join('') + '</table>' : '<div class="empty" style="border:0">Nobody has traded yet. Be the first.</div>';
    }).catch(function (e) { $('#lb').innerHTML = '<span class="down">' + esc(e.message) + '</span>'; });
  };
  load(); every(30000, load);
}

refreshMe();
route();
