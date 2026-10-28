'use strict';
// Accounts live in one JSON file (no database). Point DATA_DIR at a persistent disk in production.
const fs = require('fs');
const path = require('path');

const FILE = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'accounts.json');
let data = { accounts: {} };
let timer = null;

exports.load = function () {
  try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { data = { accounts: {} }; }
  if (!data.accounts || typeof data.accounts !== 'object') data.accounts = {};
};
exports.get = function (token) { return Object.prototype.hasOwnProperty.call(data.accounts, token) ? data.accounts[token] : null; };
exports.put = function (token, acct) { data.accounts[token] = acct; exports.save(); };
exports.each = function (fn) { Object.keys(data.accounts).forEach(function (k) { fn(k, data.accounts[k]); }); };
exports.count = function () { return Object.keys(data.accounts).length; };

function write() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(data));
  fs.renameSync(FILE + '.tmp', FILE);
}
// At most one write per second, atomic (write a temp file, then rename).
exports.save = function () {
  if (timer) return;
  timer = setTimeout(function () { timer = null; try { write(); } catch (e) { console.error('Save failed:', e.message); } }, 1000);
};
exports.flush = function () { if (timer) { clearTimeout(timer); timer = null; } try { write(); } catch (e) { console.error('Save failed:', e.message); } };
