'use strict';
// The practice market the rest of the app talks to. Real tokens, simulated prices (see world.js).
// The only network use is slow: a refresh of the real prices every minute (the "anchor"), new tokens every 3 minutes,
// and a lookup when somebody opens or searches a token that is not in the market yet. Trading and charts never wait on it.
const fs = require('fs');
const path = require('path');
const feed = require('./feed');
const World = require('./world');
const Launchpad = require('./launchpad');

const world = World.create({});
let pinned = function () { return {}; };     // mints somebody holds: never removed from the market
const IMAGES = loadImages();
const lp = Launchpad.create({ images: IMAGES, world: world, rate: process.env.LAUNCH_RATE !== undefined ? Number(process.env.LAUNCH_RATE) : undefined, pinned: function () { return pinned(); } });
// the pictures of the made-up launches (public/img/tk, see tools/fetch_token_images.py), grouped by kind
// Every token that enters the market gets a picture: a real token without one (or an old saved launch) gets a stable cartoon avatar
function admit(seed, now) {
  if (!seed.icon) { const pool = IMAGES.avatar; if (pool.length) { let h = 2166136261; for (let i = 0; i < seed.mint.length; i++) { h ^= seed.mint.charCodeAt(i); h = Math.imul(h, 16777619); } seed.icon = pool[(h >>> 0) % pool.length]; } }
  return world.add(seed, now);
}
function loadImages() {
  const out = { cat: [], photo: [], avatar: [] };
  try {
    fs.readdirSync(path.join(__dirname, '..', 'public', 'img', 'tk')).sort().forEach(function (f) {
      const u = '/img/tk/' + f;
      if (/^cat-/.test(f)) out.cat.push(u); else if (/^photo-/.test(f)) out.photo.push(u); else if (/^av-/.test(f)) out.avatar.push(u);
    });
  } catch (e) { /* no pictures: the page draws placeholders */ }
  return out;
}
exports._world = world; exports._lp = lp;
// one second of the market: the launchpad moves its launches, then every token takes a step
function advance(now) { lp.tick(now); world.step(now); }
exports.isMint = feed.isMint;

const MAX_TOKENS = 160, MIN_LIQUIDITY = 1000, TREND_MAX = 60, NEW_MAX = 40, NEW_MAX_AGE_MS = 24 * 3600000;
const ANCHOR_EVERY_MS = 60000, DISCOVER_EVERY_MS = 180000, CACHE_EVERY_MS = 300000;
const CACHE_FILE = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'universe.json');

const stats = { tokens: 0, anchorRefreshes: 0, dexCalls: 0 };
Object.defineProperty(stats, 'tokens', { get: function () { return world.size(); }, enumerable: true });
Object.defineProperty(stats, 'dexCalls', { get: function () { return feed.stats.calls; }, enumerable: true });
exports.stats = stats;

exports.setPinned = function (fn) { pinned = fn; };

exports.prices = async function (mints) {
  const out = {}, missing = [], now = Date.now();
  mints.forEach(function (m) { if (world.has(m)) world.touch(m, now); else if (feed.isMint(m)) missing.push(m); });
  if (missing.length) {
    const real = await feed.snapshots(missing);       // a real token we have not seen yet: add it with its real numbers
    Object.keys(real).forEach(function (k) { admit(real[k], Date.now()); });
  }
  mints.forEach(function (m) { const s = world.snapshot(m); if (s) out[m] = s; });
  return out;
};

exports.search = async function (q) {
  const found = await feed.search(q);
  found.forEach(function (real) { admit(real, Date.now()); });
  return found.map(function (r) { return world.snapshot(r.mint); }).filter(Boolean).sort(function (a, b) { return b.liquidity - a.liquidity; });
};

exports.trending = async function () {
  return world.list().filter(function (s) { return !s.meta && s.liquidity >= MIN_LIQUIDITY; }).sort(function (a, b) { return b.volume.h1 - a.volume.h1; }).slice(0, TREND_MAX);
};

exports.newPairs = async function () {
  const cut = Date.now() - NEW_MAX_AGE_MS;
  return world.list().filter(function (s) { return !s.meta && s.createdAt > cut && s.liquidity >= MIN_LIQUIDITY; }).sort(function (a, b) { return b.createdAt - a.createdAt; }).slice(0, NEW_MAX);
};

// Pulse: simulated launches (New Pairs, Final Stretch) and what has migrated (simulated graduates plus the real tokens)
exports.pulse = async function () { return Launchpad.pulse(world.list(), 30, { spark: function (m) { return world.sparkline(m, 24, 300); }, stats: lp.stats(Date.now()) }); };

exports.candles = async function (pair, res, limit) {
  if (!feed.isMint(pair)) throw new Error('Invalid pair');
  const mint = world.mintOfPair(pair);
  if (!mint) throw new Error('Unknown pair');
  return world.bars(mint, res, limit);
};

// ---- keeping the market stocked ----
function evict() {
  const held = pinned(), real = function () { return world.mints().filter(function (m) { return !world.get(m).meta; }); };
  while (real().length > MAX_TOKENS) {
    const loose = real().filter(function (m) { return !held[m]; }).sort(function (a, b) { return world.get(a).viewedAt - world.get(b).viewedAt; });
    if (!loose.length) return;
    world.remove(loose[0]);
  }
}

async function refreshAnchors() {
  const mints = world.mints();
  if (!mints.length) return;
  try {
    const real = await feed.snapshots(mints);
    Object.keys(real).forEach(function (k) { world.setReal(k, real[k], Date.now()); });
    stats.anchorRefreshes++;
  } catch (e) { /* keep simulating around the last anchors */ }
}

async function discoverNow() {
  try {
    const fresh = (await feed.discover()).filter(function (m) { return !world.has(m); }).slice(0, 90);
    if (fresh.length) {
      const real = await feed.snapshots(fresh);
      Object.keys(real).forEach(function (k) { if (real[k].liquidity >= MIN_LIQUIDITY) admit(real[k], Date.now()); });
      evict();
    }
  } catch (e) { /* try again in 3 minutes */ }
}

// The last real numbers are kept on disk, so a restart while DexScreener is down still has a market to show.
function saveCache() {
  try {
    const rows = world.mints().map(function (m) {
      const t = world.get(m);
      return Object.assign({ mint: t.mint, symbol: t.symbol, name: t.name, icon: t.icon, pair: t.pair, dex: t.dex, createdAt: t.createdAt, meta: t.meta, pull: t.pull, sigmaScale: t.sigmaScale, launch: !!t.meta }, t.real);
    });
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE + '.tmp', JSON.stringify({ tokens: rows, launches: lp.serialize() }));
    fs.renameSync(CACHE_FILE + '.tmp', CACHE_FILE);
  } catch (e) { /* the cache is only a convenience */ }
}
function loadCache() {
  try {
    const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')), rows = Array.isArray(j) ? j : j.tokens || [];
    rows.forEach(function (s) { if (s && feed.isMint(s.mint)) admit(s, Date.now()); });
    lp.restore(j.launches);
  } catch (e) { /* no cache yet */ }
}

// So the Pulse columns are not empty after a restart, the last minutes of launches are simulated at once (before the real tokens join).
const WARMUP_MIN = process.env.WARMUP_MIN !== undefined ? Number(process.env.WARMUP_MIN) : 30;
function warmUp(minutes) {
  if (!(minutes > 0) || world.size()) return;
  const end = Date.now();
  for (let t = end - minutes * 60000; t < end;) { t += 1000; advance(t); }
}
exports.warmUp = warmUp;

exports.start = function () {
  warmUp(WARMUP_MIN);
  loadCache();
  const timers = [];
  timers.push(setInterval(function () { advance(Date.now()); }, 1000));
  timers.push(setInterval(function () { refreshAnchors(); }, ANCHOR_EVERY_MS));
  timers.push(setInterval(function () { discoverNow(); }, DISCOVER_EVERY_MS));
  timers.push(setInterval(saveCache, CACHE_EVERY_MS));
  timers.forEach(function (t) { if (t.unref) t.unref(); });
  discoverNow().then(function () { if (world.size()) saveCache(); });
  return timers;
};
exports.stop = function (timers) { (timers || []).forEach(clearInterval); };
exports.flush = saveCache;
exports._tick = function (now) { advance(now); };
exports._refresh = refreshAnchors;
exports._discover = discoverNow;
