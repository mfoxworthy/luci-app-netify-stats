'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert');

// --- Load chart.js with LuCI stubs ---
const src = fs.readFileSync(
    path.join(__dirname, '../htdocs/luci-static/resources/netify-stats/chart.js'), 'utf8');

const baseclass = { extend: obj => obj };
const view      = { extend: obj => obj };
const rpc       = { declare: () => () => Promise.resolve({}) };
const ui        = { addNotification: () => {} };
const poll      = { add: () => {} };
const T         = { transform: () => ({ empty: true, labels: [], datasets: [] }) };
const L         = { resource: s => s };
const E         = () => ({});
const _         = s => s;
const window_   = {};
const document_ = {
    createElement: () => ({ onload: null, onerror: null }),
    head: { appendChild: () => {} },
    getElementById: () => null
};
let store = {};
const localStorage_ = {
    getItem:  k     => store[k] || null,
    setItem:  (k,v) => { store[k] = v; },
    removeItem: k   => { delete store[k]; }
};

const mod = new Function(
    'baseclass','view','rpc','ui','poll','T','L','E','_',
    'window','document','localStorage',
    src
)(baseclass, view, rpc, ui, poll, T, L, E, _,
  window_, document_, localStorage_);

// __test__ must exist — fails here if chart.js hasn't been updated yet
const { handleLegendClick, loadPrefs, savePrefs } = mod.__test__;

let n = 0;
const ok = (name, cond) => { assert.ok(cond, name); n++; };

function makeState() {
    return { range: '1h', metric: 'rx_bytes', hidden: new Set(), isolated: new Set() };
}

// ── handleLegendClick ──────────────────────────────────────────────────────

// Normal mode: visible → hidden
let s = makeState();
handleLegendClick('netflix', s);
ok('normal: visible->hidden adds to hidden',    s.hidden.has('netflix'));
ok('normal: visible->hidden isolated empty',    s.isolated.size === 0);

// Normal mode: hidden → isolated (enters isolation mode)
handleLegendClick('netflix', s);
ok('normal: hidden->isolated removes hidden',   !s.hidden.has('netflix'));
ok('normal: hidden->isolated adds isolated',    s.isolated.has('netflix'));

// Isolation mode: add a non-hidden, non-isolated series
s = makeState();
handleLegendClick('netflix', s); // visible→hidden
handleLegendClick('netflix', s); // hidden→isolated
handleLegendClick('spotify', s); // visible→add to isolated
ok('isolate: add visible to isolated set',      s.isolated.has('spotify'));
ok('isolate: first series still isolated',      s.isolated.has('netflix'));
ok('isolate: nothing in hidden',                s.hidden.size === 0);

// Isolation mode: pull a hidden series into isolated
s = makeState();
handleLegendClick('amazon', s);  // amazon → hidden
handleLegendClick('netflix', s); // netflix → hidden
handleLegendClick('netflix', s); // netflix → isolated
handleLegendClick('amazon', s);  // amazon (hidden) → isolated
ok('isolate: hidden pulled into isolated',      s.isolated.has('amazon'));
ok('isolate: pulled series removed from hidden',!s.hidden.has('amazon'));

// Isolation mode: remove one isolated series (not the last)
s = makeState();
handleLegendClick('netflix', s); // → hidden
handleLegendClick('netflix', s); // → isolated
handleLegendClick('spotify', s); // → isolated
handleLegendClick('netflix', s); // remove netflix
ok('isolate: removed from isolated',            !s.isolated.has('netflix'));
ok('isolate: other series still isolated',      s.isolated.has('spotify'));
ok('isolate: hidden unchanged',                 s.hidden.size === 0);

// Isolation mode: remove the last isolated series → restore all
s = makeState();
handleLegendClick('amazon', s);  // → hidden
handleLegendClick('netflix', s); // → hidden
handleLegendClick('netflix', s); // → isolated (enter isolation)
handleLegendClick('netflix', s); // remove last isolated
ok('isolate: last removed clears isolated',     s.isolated.size === 0);
ok('isolate: last removed clears hidden',       s.hidden.size === 0);

// ── loadPrefs / savePrefs ─────────────────────────────────────────────────

// round-trip: save then load restores all fields
store = {};
s = makeState();
s.range    = '30d';
s.metric   = 'tx_bytes';
s.hidden   = new Set(['tiktok']);
s.isolated = new Set(['netflix', 'spotify']);
savePrefs('apps', s);

let s2 = makeState();
loadPrefs('apps', s2);
ok('prefs: range round-trips',    s2.range === '30d');
ok('prefs: metric round-trips',   s2.metric === 'tx_bytes');
ok('prefs: hidden round-trips',   s2.hidden.has('tiktok') && s2.hidden.size === 1);
ok('prefs: isolated round-trips', s2.isolated.has('netflix') && s2.isolated.has('spotify') && s2.isolated.size === 2);

// apps and cats keys are independent
store = {};
s = makeState(); s.range = '1d';
savePrefs('apps', s);
s = makeState(); s.range = '30d';
savePrefs('cats', s);
let sa = makeState(); loadPrefs('apps', sa);
let sc = makeState(); loadPrefs('cats', sc);
ok('prefs: apps key independent of cats', sa.range === '1d');
ok('prefs: cats key independent of apps', sc.range === '30d');

// invalid range is rejected, valid metric still loaded
store = {};
store['nsp-pref-cats'] = JSON.stringify({ range: 'INVALID', metric: 'flows' });
let s3 = makeState(); loadPrefs('cats', s3);
ok('prefs: invalid range rejected',    s3.range === '1h');   // default preserved
ok('prefs: valid metric still loaded', s3.metric === 'flows');

// invalid metric is rejected
store = {};
store['nsp-pref-apps'] = JSON.stringify({ range: '1d', metric: 'NOPE' });
let s4 = makeState(); loadPrefs('apps', s4);
ok('prefs: invalid metric rejected', s4.metric === 'rx_bytes');

// missing key is a no-op
store = {};
let s5 = makeState(); loadPrefs('apps', s5);
ok('prefs: missing key is noop', s5.range === '1h' && s5.metric === 'rx_bytes' && s5.hidden.size === 0);

// corrupt JSON is a no-op
store = {};
store['nsp-pref-apps'] = '{not: valid json';
let s6 = makeState(); loadPrefs('apps', s6);
ok('prefs: corrupt JSON is noop', s6.range === '1h');

console.log('chart-prefs: ' + n + ' checks passed');
