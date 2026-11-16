'use strict';
// Simulated token launches for the Pulse page, in the style of a bonding-curve launchpad.
// A launch is born small, then follows a scripted path set at birth: most fizzle out (dud / meh), some run (runner) and a few
// graduate: when the simulated market cap crosses MIGRATE_MC the token "migrates" to a normal pool and moves to the third column.
// The script only moves the ANCHOR price; the usual simulation (noise, regimes, jumps, volume, candles) runs on top of it, so a
// launch trades and charts like any other token. Names, addresses and holder stats are made up: this is a practice market.
const Names = require('./names');
const MIGRATE_MC = 25000, FINAL_FROM = 0.35, SUPPLY = 1e9;
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const TYPES = [
  { id: 'dud',      p: 0.55, mT: [2200, 3800],   dur: [120, 600],   decay: 0.35, act: 0.6 },
  { id: 'meh',      p: 0.25, mT: [6000, 13000],  dur: [300, 1500],  decay: 0.4,  act: 1.5 },
  { id: 'runner',   p: 0.12, mT: [14000, 23000], dur: [300, 1800],  decay: 0.25, act: 3 },
  { id: 'graduate', p: 0.08, mT: [27000, 36000], dur: [240, 2400],  decay: 0,    act: 4 }
];

function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
function smooth(x) { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); }
function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function frac(h, k) { return ((Math.imul(h ^ Math.imul(k + 1, 2654435761), 2246822519) >>> 0) % 10000) / 10000; }
function poisson(rng, n) { if (n <= 0) return 0; const L = Math.exp(-n); let k = 0, p = 1; do { k++; p *= rng(); } while (p > L); return k - 1; }
const liqFor = function (mc, migrated) { return migrated ? Math.max(2500, 0.3 * mc) : Math.max(1500, 0.22 * mc + 1200); };
const shortAddr = function (a) { return a.slice(0, 4) + '...' + a.slice(-4); };

// Holder and wallet stats for a token that is NOT a simulated launch (real tokens in the market): stable per token.
exports.cardStats = function (s) {
  const h = hash(s.mint), trades = s.buys24 + s.sells24, who = s.symbol.toLowerCase().replace(/[^a-z0-9]/g, '');
  return {
    holders: Math.round(40 + trades * 0.35), top10: 10 + frac(h, 1) * 35, dev: frac(h, 2) < 0.6 ? 0 : frac(h, 3) * 6, snipers: frac(h, 4) * 8, insiders: frac(h, 5) * 6, bundlers: frac(h, 6) * 10,
    x: frac(h, 7) < 0.7, tg: frac(h, 8) < 0.45, web: frac(h, 9) < 0.4, handle: '@' + who, followers: Math.floor(Math.pow(frac(h, 10), 3) * 200000), creator: shortAddr(s.mint.slice(3) + s.mint.slice(0, 3)), dexPaid: frac(h, 11) < 0.6
  };
};

function card(s, spark) {
  const m = s.meta, st = m || exports.cardStats(s);
  return {
    hot: false, spark: spark ? spark(s.mint) : [],      // hot is decided across the whole screen in pulse()
    mint: s.mint, pair: s.pair, symbol: s.symbol, name: s.name, icon: s.icon, createdAt: s.createdAt, price: s.price, marketCap: s.marketCap, volume: s.volume.h24, volume5m: s.volume.m5,
    netBuy: s.netBuy || 0, buys: s.buys24, sells: s.sells24, change5m: s.change.m5, dex: s.dex,
    progress: m ? m.progress : 1, migrated: m ? m.migrated : true, migratedAt: m ? m.migratedAt : s.createdAt, fake: !!m,
    holders: st.holders, top10: st.top10, dev: st.dev, snipers: st.snipers, insiders: st.insiders, bundlers: st.bundlers,
    x: st.x, tg: st.tg, web: st.web, handle: st.handle, followers: st.followers, creator: st.creator, dexPaid: st.dexPaid
  };
}

// Migrated: simulated graduates (latest first) with room kept for the real tokens of the market, so both always show.
function migratedColumn(grads, real, limit, by, cardOf) {
  const g = grads.sort(by(function (s) { return s.meta.migratedAt; })).slice(0, Math.max(1, limit - 10));
  const r = real.sort(by(function (s) { return s.createdAt; })).slice(0, limit - g.length);
  return g.concat(r).map(cardOf).sort(by(function (c) { return c.migratedAt; }));
}

// The three Pulse columns from the market snapshots.
exports.pulse = function (snaps, limit, extra) {
  limit = limit || 30;
  const sp = extra && extra.spark, cardOf = function (s) { return card(s, sp); };
  const launches = snaps.filter(function (s) { return s.meta; }), real = snaps.filter(function (s) { return !s.meta && s.liquidity >= 1000; });
  const pre = launches.filter(function (s) { return !s.meta.migrated; });
  const by = function (f) { return function (a, b) { return f(b) - f(a); }; };
  const out = {
    newPairs: pre.filter(function (s) { return s.meta.progress < FINAL_FROM; }).sort(by(function (s) { return s.createdAt; })).slice(0, limit).map(cardOf),
    finalStretch: pre.filter(function (s) { return s.meta.progress >= FINAL_FROM; }).sort(by(function (s) { return s.meta.progress; })).slice(0, limit).map(cardOf),
    migrated: migratedColumn(launches.filter(function (s) { return s.meta.migrated; }), real, limit, by, cardOf),
    stats: extra && extra.stats || null
  };
  // HOT = the 15% of cards moving most right now (at least +10% in 5 minutes), so the tag keeps meaning "standout"
  const all = out.newPairs.concat(out.finalStretch, out.migrated).map(function (c) { return c.change5m; }).sort(function (a, b) { return b - a; });
  const cut = Math.max(10, all.length ? all[Math.floor(all.length * 0.15)] : 10);
  out.newPairs.concat(out.finalStretch, out.migrated).forEach(function (c) { c.hot = c.change5m >= cut; });
  return out;
};

exports.MIGRATE_MC = MIGRATE_MC; exports.FINAL_FROM = FINAL_FROM;

exports.create = function (opts) {
  const world = opts.world, rng = opts.rng || Math.random, pinned = opts.pinned || function () { return {}; };
  const rate = opts.rate != null ? opts.rate : 0.6, maxLive = opts.maxLive || 220;   // launches per second, and how many may be alive
  let spawned = 0, graduated = 0; const recent = [];                               // counters for the Pulse bar
  const live = {};
  let lastTick = 0;
  const lp = { live: live };

  const rb58 = function (n) { let o = ''; for (let i = 0; i < n; i++) o += B58.charAt(Math.floor(rng() * 58)); return o; };
  const pick = function (a) { return a[Math.floor(rng() * a.length)]; };
  const between = function (r) { return r[0] + rng() * (r[1] - r[0]); };

  // a picture that fits the name: cat photos for cats, photos for concepts and things, cartoon avatars for slang and pets
  const images = opts.images || {};
  function pickImage(kind) {
    const pool = kind === 'mixed' ? (rng() < 0.5 ? images.photo : images.avatar) : images[kind];
    return pool && pool.length ? pool[Math.floor(rng() * pool.length)] : null;     // null: the page draws a placeholder
  }

  lp.spawn = function (now) {
    const nm = Names.generate(rng), roll = rng();
    let acc = 0, type = TYPES[0];
    for (let i = 0; i < TYPES.length; i++) { acc += TYPES[i].p; if (roll < acc) { type = TYPES[i]; break; } }
    const m0 = 4000 + rng() * 1200, mint = rb58(40) + 'pump', pair = rb58(44), creator = rb58(44);
    const rec = {
      mint: mint, born: now, type: type.id, m0: m0, mT: between(type.mT), dur: between(type.dur), decay: type.decay, act: type.act,
      migrated: false, migAge: 0, migMc: 0, postMult: 1,
      dev0: rng() * 12, sniper0: rng() * 25, insider0: rng() * 12, bundler0: rng() * 18,
      devSellAt: type.id === 'dud' && rng() < 0.7 ? 60 + rng() * 540 : rng() < 0.3 ? 600 + rng() * 3000 : Infinity
    };
    const meta = {
      launch: true, migrated: false, migratedAt: 0, progress: 0, holders: 1, top10: 85, dev: rec.dev0, snipers: rec.sniper0, insiders: rec.insider0, bundlers: rec.bundler0,
      x: rng() < 0.6, tg: rng() < 0.35, web: rng() < 0.3, handle: nm.handle, followers: Math.floor(Math.pow(rng(), 3) * 20000), creator: shortAddr(creator), dexPaid: false
    };
    world.add({
      mint: mint, pair: pair, symbol: nm.symbol, name: nm.name, icon: pickImage(nm.image), dex: 'pump.fun', createdAt: now - 1000, price: m0 / SUPPLY, liquidity: liqFor(m0, false), marketCap: m0,
      change: { m5: 0, h1: 0, h6: 0, h24: 0 }, volume: { m5: m0 * 0.05, h1: m0 * 0.3, h6: m0 * 0.3, h24: m0 * 0.3 }, buys24: 2 + Math.floor(rng() * 6), sells24: Math.floor(rng() * 2),
      launch: true, pull: 1 / 20, sigmaScale: 0.55, meta: meta
    }, now);
    live[mint] = rec; spawned++; recent.push(now);
    return mint;
  };

  function target(rec, age) {
    if (rec.migrated) {
      const since = age - rec.migAge, base = rec.migMc * Math.pow(rec.postMult, smooth(since / 1200));
      return since > 1200 ? base * Math.exp(-0.08 * (since - 1200) / 600) : base;
    }
    if (age < rec.dur) return rec.m0 * Math.pow(rec.mT / rec.m0, smooth(age / rec.dur));
    return rec.mT * Math.exp(-rec.decay * (age - rec.dur) / 600);
  }

  function updateStats(rec, t, meta, age) {
    const trades = t.lastBuys + t.lastSells;
    meta.holders = Math.max(1, Math.min(trades + 2, Math.round(2 + 0.2 * Math.pow(trades, 0.93))));   // roughly a fifth of the trades come from distinct wallets
    meta.top10 = clamp(12 + 75 / (1 + meta.holders / 18), 6, 90);
    meta.dev = age >= rec.devSellAt ? Math.max(0, rec.dev0 * (1 - (age - rec.devSellAt) / 120)) : rec.dev0;
    meta.snipers = rec.sniper0 * Math.exp(-age / 900);
    meta.insiders = rec.insider0 * Math.exp(-age / 3600);
    meta.bundlers = rec.bundler0 * Math.exp(-age / 1800);
  }

  function remove(mint) { delete live[mint]; world.remove(mint); }

  // Once a second: new launches, move every launch along its script, migrate the ones that crossed the line, clean up the dead.
  lp.tick = function (now) {
    const dt = lastTick ? Math.min(5, (now - lastTick) / 1000) : 1;
    lastTick = now;
    for (let n = poisson(rng, rate * dt); n > 0; n--) lp.spawn(now);      // new launches never stop: the cap below drops the oldest ones instead
    const held = pinned();
    Object.keys(live).forEach(function (mint) {
      const rec = live[mint], t = world.get(mint), snap = world.snapshot(mint);
      if (!t || !snap) { delete live[mint]; return; }
      const age = (now - rec.born) / 1000, meta = t.meta;
      if (!rec.migrated && snap.marketCap >= MIGRATE_MC) {
        rec.migrated = true; rec.migAge = age; rec.migMc = snap.marketCap; rec.postMult = rng() < 0.6 ? 0.45 + rng() * 0.35 : 1.3 + rng() * 1.4;
        graduated++; meta.migrated = true; meta.migratedAt = now; meta.dexPaid = rng() < 0.5; meta.progress = 1;
        world.nudge(mint, { dex: 'pumpswap' });
      }
      const mc = target(rec, age), boost = rec.migrated && age - rec.migAge < 600 ? 3 : 1;
      if (!rec.migrated) meta.progress = clamp(snap.marketCap / MIGRATE_MC, 0, 1);
      world.nudge(mint, { price: mc / SUPPLY, liquidity: liqFor(mc, rec.migrated), vps: mc * rec.act / 3600 * (age < rec.dur ? 2 : 1) * boost });
      updateStats(rec, t, meta, age);
      // a token that went nowhere is dropped, unless somebody holds it or looked at it in the last 10 minutes
      const dead = (!rec.migrated && age > 1500 && meta.progress < FINAL_FROM) || (!rec.migrated && age > 2700) || (rec.migrated && age - rec.migAge > 1500) || (!rec.migrated && age > 600 && snap.marketCap < 1800);
      if (dead && !held[mint] && now - t.viewedAt > 600000) remove(mint);
    });
    // too many waiting to migrate: drop the oldest ones nobody holds or watches, the ones going nowhere first (Final Stretch is kept)
    const waiting = Object.keys(live).filter(function (m) { return !live[m].migrated; });
    if (waiting.length > maxLive) {
      const final = function (m) { return world.get(m).meta.progress >= FINAL_FROM ? 1 : 0; };
      waiting.filter(function (m) { return !held[m] && now - world.get(m).viewedAt > 600000; })
        .sort(function (a, b) { return final(a) - final(b) || live[a].born - live[b].born; }).slice(0, waiting.length - maxLive).forEach(remove);
    }
  };

  lp.serialize = function () { return Object.keys(live).map(function (m) { return live[m]; }); };
  lp.restore = function (recs) { (recs || []).forEach(function (r) { if (r && world.has(r.mint)) live[r.mint] = r; }); };
  lp.count = function () { return Object.keys(live).length; };
  lp.stats = function (now) {
    const cut = (now || lastTick) - 60000;
    while (recent.length && recent[0] < cut) recent.shift();
    return { launched: spawned, migrated: graduated, perMin: recent.length };
  };
  return lp;
};
