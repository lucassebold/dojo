'use strict';
// Names for the made-up launches, in the style of what shows up on a real launchpad: single lowercase words, loud capitalised
// concepts, tickers with an expansion, money jokes, internet slang, pets, hashtags. Nobody's name and no brand is used on purpose:
// the banks below are plain words, and a test keeps a list of real names out of them.
const BANKS = {
  cat: ['poorcat', 'sadcat', 'chonk', 'mittens', 'whiskers', 'tabby', 'mochi', 'miso', 'noodle', 'biscuit', 'pickles', 'waffles', 'gizmo', 'luna', 'oreo', 'ziggy', 'meowdy', 'purrfect', 'kitty', 'tuna', 'nugget', 'pumpkin', 'boots', 'smokey', 'shadow', 'cocoa', 'bean', 'tofu', 'sprout', 'peanut', 'toast', 'marble'],
  pet: ['rocky', 'bruno', 'cooper', 'ollie', 'pupper', 'doggo', 'bork', 'zoomies', 'fetch', 'walkies', 'good boy', 'corgi time', 'sausage dog', 'milo', 'max', 'buddy', 'scout', 'finn', 'daisy', 'bella', 'charlie', 'teddy', 'hazel', 'penny', 'rex'],
  concept: ['prometheus', 'nuremberg', 'atlas', 'icarus', 'oracle', 'phantom', 'zenith', 'eclipse', 'vortex', 'nimbus', 'obsidian', 'cipher', 'horizon', 'monolith', 'titan', 'helios', 'nomad', 'ember', 'tundra', 'mirage', 'summit', 'aurora', 'labyrinth', 'odyssey', 'archive', 'catalyst', 'paradox', 'equinox', 'quasar', 'sentinel', 'meridian', 'citadel', 'genesis', 'exodus', 'pantheon', 'requiem'],
  money: ['loanshark', 'overdraft', 'paperhands', 'bagholder', 'tax refund', 'landlord', 'rent is due', 'side hustle', 'day job', 'exit liquidity', 'down bad', 'soft launch', 'gas fees', 'dollar cost', 'margin call', 'stimmy', 'broke boys', 'payday', 'piggy bank', 'ramen budget', 'late fee', 'junk bond', 'penny stock', 'bull trap', 'dead cat bounce', 'moon mission', 'rug radar', 'diamond hands', 'cash only', 'coupon'],
  slang: ['gigachad', 'npc', 'sigma', 'rizz', 'mid', 'ratio', 'cope', 'aura', 'based', 'delulu', 'yapping', 'brainrot', 'touch grass', 'main character', 'no cap', 'cooked', 'locked in', 'goated', 'lowkey', 'vibe check', 'plot twist', 'big yikes', 'unhinged', 'feral', 'gremlin', 'goblin mode', 'villain era', 'ick', 'bussin', 'drip'],
  thing: ['pizza', 'taco', 'banana', 'toast', 'ramen', 'pancake', 'donut', 'espresso', 'sushi', 'pretzel', 'avocado', 'cactus', 'umbrella', 'bicycle', 'lantern', 'compass', 'anchor', 'teapot', 'sandwich', 'pickle jar', 'popcorn', 'lighthouse', 'skateboard', 'typewriter', 'jukebox', 'vending machine', 'lava lamp', 'snow globe', 'paper plane', 'trampoline'],
  tag: ['tbt', 'nofilter', 'mood', 'wip', '404', 'sunday', 'ootd', 'fyp', 'rn', 'irl', 'pov', 'dat', 'wyd', 'bts', 'eod'],
  adj: ['Tiny', 'Lazy', 'Grumpy', 'Sleepy', 'Hungry', 'Brave', 'Sneaky', 'Salty', 'Spicy', 'Crispy', 'Chaotic', 'Midnight', 'Golden', 'Rusty', 'Lucky', 'Wobbly', 'Cosmic', 'Feral', 'Humble', 'Shiny', 'Dizzy', 'Cranky', 'Jolly', 'Sassy', 'Mighty'],
  noun: ['Bear', 'Fox', 'Owl', 'Otter', 'Goat', 'Llama', 'Crab', 'Moth', 'Mole', 'Newt', 'Toad', 'Yak', 'Seal', 'Wolf', 'Hawk', 'Moose', 'Badger', 'Heron', 'Ferret', 'Gecko', 'Walrus', 'Pigeon', 'Raccoon', 'Beaver', 'Koala'],
  group: ['Club', 'Society', 'Labs', 'Union', 'Guild', 'Syndicate', 'Collective', 'Gang', 'Crew', 'Army', 'Cartel', 'Order'],
  suffix: ['coin', 'inu', 'token', 'fi', 'dao', 'swap', 'pad', 'ai']
};
exports.BANKS = BANKS;

const THEMES = [   // weight, image kind (cat photo / random photo / cartoon avatar / either)
  ['cat', 0.14, 'cat'], ['pet', 0.09, 'avatar'], ['concept', 0.16, 'photo'], ['money', 0.11, 'mixed'], ['slang', 0.10, 'avatar'],
  ['thing', 0.11, 'photo'], ['acro', 0.15, 'mixed'], ['tag', 0.06, 'photo'], ['combo', 0.08, 'mixed']
];
const title = function (s) { return s.replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); }); };
const nospace = function (s) { return s.replace(/[^a-z0-9]/gi, ''); };

exports.generate = function (rng) {
  const pick = function (a) { return a[Math.floor(rng() * a.length)]; };
  let roll = rng(), theme = THEMES[0];
  for (let i = 0; i < THEMES.length; i++) { roll -= THEMES[i][1]; if (roll < 0) { theme = THEMES[i]; break; } }
  const kind = theme[0], image = theme[2];
  let name, symbol, base;
  if (kind === 'acro') {                                   // "TLB Tiny Lazy Bear"
    const words = rng() < 0.5 ? [pick(BANKS.adj), pick(BANKS.noun)] : [pick(BANKS.adj), pick(BANKS.noun), pick(BANKS.group)];
    name = words.join(' '); symbol = words.map(function (w) { return w[0]; }).join('') + (rng() < 0.4 ? pick(['', 'X', 'V', 'K']) : ''); base = words[1];
  } else if (kind === 'tag') {
    base = pick(BANKS.tag); name = '#' + base; symbol = '#' + base;
  } else if (kind === 'combo') {                           // "Mochi Coin", "rocky inu"
    const w = pick(BANKS.cat.concat(BANKS.pet, BANKS.thing)).split(' ')[0], sfx = pick(BANKS.suffix);
    base = w; name = title(w) + ' ' + (sfx.length <= 3 ? sfx.toUpperCase() : title(sfx)); symbol = (rng() < 0.5 ? w : w.slice(0, 4) + sfx.slice(0, 3)).toUpperCase();
  } else {
    base = pick(BANKS[kind]);
    const style = rng();
    if (style < 0.40) { symbol = nospace(base).toUpperCase(); name = title(base); }                       // LOANSHARK  Loan Shark
    else if (style < 0.75) { symbol = nospace(base).toLowerCase(); name = base.indexOf(' ') < 0 ? symbol : title(base); }   // poorcat  poorcat
    else { const k = nospace(base).replace(/[aeiou]/gi, '').slice(0, 4).toUpperCase(); symbol = k.length >= 3 ? k : nospace(base).slice(0, 4).toUpperCase(); name = title(base); }   // PRMT  Prometheus
  }
  symbol = symbol.slice(0, 10); name = name.slice(0, 28);
  const suffix = pick(['', '', 'hq', 'lab', 'onsol', 'sol', 'fans', 'dev', 'club']) + (rng() < 0.25 ? String(Math.floor(rng() * 99)) : '');
  return { name: name, symbol: symbol, image: image, handle: '@' + nospace(base).toLowerCase() + suffix };
};
