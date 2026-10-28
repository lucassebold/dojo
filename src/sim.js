'use strict';
// Paper-trading maths. Pure functions: no network, no disk.
//
// Fill model (constant-product pool, the same shape as most Solana memecoin pools):
//   - the pool holds about half of its liquidity on each side, R = liquidity / 2
//   - buying x dollars pays an average price of spot * (1 + x / R)
//   - selling tokens worth x dollars at spot returns x / (1 + x / R)
//   - a flat fee (FEE_PCT) is charged on top, to mimic platform + network costs
// Positions are valued at their estimated liquidation value (after price impact, before fee),
// so a pumped, illiquid token cannot inflate the balance or the leaderboard.

const START_CASH = Number(process.env.START_CASH) || 10000;
const FEE_PCT = process.env.FEE_PCT !== undefined && process.env.FEE_PCT !== '' ? Number(process.env.FEE_PCT) : 0.5;
const MIN_TRADE_USD = 1;
const MIN_LIQUIDITY_USD = 1000;
const MAX_POSITIONS = 30;
const MAX_TRADES_KEPT = 500;

exports.START_CASH = START_CASH;
exports.FEE_PCT = FEE_PCT;
exports.MIN_TRADE_USD = MIN_TRADE_USD;

exports.newAccount = function (nickname, now) {
  return { nickname: nickname, cash: START_CASH, startCash: START_CASH, positions: {}, trades: [], tradeCount: 0, realized: 0, resets: 0, createdAt: now, lastSeen: now };
};

function fail(error) { return { ok: false, error: error }; }

// amount: { usd } for a buy, { pct } (1-100) for a sell. Never changes the account.
exports.quote = function (acct, snap, side, amount) {
  if (!snap || !(snap.price > 0)) return fail('No live price for this token right now.');
  if (!(snap.liquidity >= MIN_LIQUIDITY_USD)) return fail('Liquidity is below $' + MIN_LIQUIDITY_USD + ': too thin to trade, even in practice.');
  const R = snap.liquidity / 2, fee = FEE_PCT / 100;
  const pos = acct.positions[snap.mint];

  if (side === 'buy') {
    const usd = Number(amount.usd);
    if (!isFinite(usd) || usd < MIN_TRADE_USD) return fail('The minimum order is $' + MIN_TRADE_USD + '.');
    if (usd > acct.cash + 1e-9) return fail('Not enough cash: you have $' + acct.cash.toFixed(2) + '.');
    if (!pos && Object.keys(acct.positions).length >= MAX_POSITIONS) return fail('You can hold up to ' + MAX_POSITIONS + ' tokens at once. Sell one first.');
    const feeUsd = usd * fee, x = usd - feeUsd;
    const execPrice = snap.price * (1 + x / R);
    return { ok: true, side: 'buy', price: snap.price, execPrice: execPrice, qty: x / execPrice, usd: usd, fee: feeUsd, net: usd, impactPct: x / R * 100 };
  }

  if (side === 'sell') {
    if (!pos || !(pos.qty > 0)) return fail('You do not hold this token.');
    const pct = Number(amount.pct);
    if (!isFinite(pct) || pct <= 0 || pct > 100) return fail('Choose a percentage between 1 and 100.');
    const qty = pct >= 100 ? pos.qty : pos.qty * pct / 100;
    const spot = qty * snap.price;
    const gross = spot / (1 + spot / R);
    const feeUsd = gross * fee;
    return { ok: true, side: 'sell', price: snap.price, execPrice: gross / qty, qty: qty, usd: gross, fee: feeUsd, net: gross - feeUsd, impactPct: (1 - gross / spot) * 100, all: pct >= 100 };
  }
  return fail('Unknown order side.');
};

// Executes a quote on the account. Returns the trade record.
exports.apply = function (acct, snap, q, now) {
  const m = snap.mint;
  let pnl = null;
  if (q.side === 'buy') {
    acct.cash -= q.usd;
    const pos = acct.positions[m] || (acct.positions[m] = { mint: m, symbol: snap.symbol, icon: snap.icon, qty: 0, cost: 0 });
    pos.qty += q.qty; pos.cost += q.usd;
    pos.lastPrice = snap.price; pos.lastLiq = snap.liquidity; pos.symbol = snap.symbol;
  } else {
    const pos = acct.positions[m];
    const frac = q.all ? 1 : q.qty / pos.qty;
    const costPart = pos.cost * frac;
    pnl = q.net - costPart;
    acct.cash += q.net; acct.realized += pnl;
    if (q.all || pos.qty - q.qty <= 1e-12) delete acct.positions[m];
    else { pos.qty -= q.qty; pos.cost -= costPart; pos.lastPrice = snap.price; pos.lastLiq = snap.liquidity; }
  }
  const t = { id: now.toString(36) + Math.random().toString(36).slice(2, 6), t: now, side: q.side, mint: m, symbol: snap.symbol, qty: q.qty, price: q.execPrice, usd: q.side === 'buy' ? q.usd : q.net, fee: q.fee, impactPct: q.impactPct, pnl: pnl };
  acct.trades.unshift(t);
  if (acct.trades.length > MAX_TRADES_KEPT) acct.trades.length = MAX_TRADES_KEPT;
  acct.tradeCount++;
  return t;
};

// Liquidation value of a position given a (possibly stale) price and liquidity.
function liquidationValue(qty, price, liq) {
  const spot = qty * price;
  if (!(liq > 0)) return 0;
  return spot / (1 + spot / (liq / 2));
}

// prices: { mint: snapshot }. Falls back to the last known price for tokens we could not refresh.
exports.summary = function (acct, prices) {
  let held = 0;
  const positions = Object.keys(acct.positions).map(function (m) {
    const p = acct.positions[m], s = prices[m];
    if (s && s.price > 0) { p.lastPrice = s.price; p.lastLiq = s.liquidity; if (s.icon) p.icon = s.icon; }
    const price = p.lastPrice || 0, liq = p.lastLiq || 0;
    const value = liquidationValue(p.qty, price, liq);
    held += value;
    return { mint: m, symbol: p.symbol, icon: p.icon || null, qty: p.qty, cost: p.cost, avgPrice: p.cost / p.qty, price: price, value: value, pnl: value - p.cost, pnlPct: p.cost ? (value - p.cost) / p.cost * 100 : 0, live: !!s };
  }).sort(function (a, b) { return b.value - a.value; });

  const equity = acct.cash + held;
  const sells = acct.trades.filter(function (t) { return t.side === 'sell'; });
  const wins = sells.filter(function (t) { return t.pnl > 0; });
  const pnls = sells.map(function (t) { return t.pnl; });
  return {
    nickname: acct.nickname, cash: acct.cash, held: held, equity: equity, startCash: acct.startCash,
    pnl: equity - acct.startCash, pnlPct: (equity - acct.startCash) / acct.startCash * 100,
    realized: acct.realized, tradeCount: acct.tradeCount, closed: sells.length,
    winRate: sells.length ? wins.length / sells.length * 100 : null,
    best: pnls.length ? Math.max.apply(null, pnls) : null, worst: pnls.length ? Math.min.apply(null, pnls) : null,
    positions: positions, resets: acct.resets
  };
};

exports.reset = function (acct, now) {
  acct.cash = START_CASH; acct.startCash = START_CASH; acct.positions = {}; acct.trades = []; acct.tradeCount = 0; acct.realized = 0; acct.resets++; acct.lastSeen = now;
};
