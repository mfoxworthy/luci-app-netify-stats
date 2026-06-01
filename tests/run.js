'use strict';
// Load the real LuCI transform module with minimal stubs and assert behavior.
const fs = require('fs'), path = require('path'), assert = require('assert');

const src = fs.readFileSync(
  path.join(__dirname, '../htdocs/luci-static/resources/netify-stats/transform.js'), 'utf8');
// LuCI modules are: 'require baseclass'; ... return baseclass.extend({...});
// Wrap in a function that returns the module value, injecting a baseclass stub.
const baseclass = { extend: (obj) => obj };
const T = new Function('baseclass', src)(baseclass);

let n = 0; const ok = (name, cond) => { assert.ok(cond, name); n++; };

// 1. happy path: two series, nulls preserved, __other__ last and grey
const resp = { step: 10, start: 1000, series: [
  { name: '__other__', values: [1, 2] },
  { name: 'netflix',   values: [null, 5] } ] };
let r = T.transform(resp, '1h');
ok('not empty', r.empty === false);
ok('2 datasets', r.datasets.length === 2);
ok('__other__ last', r.datasets[r.datasets.length - 1].label === '__other__');
ok('null preserved', r.datasets.find(d => d.label === 'netflix').data[0] === null);
ok('labels aligned to start+step', r.labels.length === 2);
ok('stacked', r.datasets[0].stack === 'nsp');

// 2. stable color: same name -> same color across calls
ok('color stable', T.colorFor('netflix') === T.colorFor('netflix'));
ok('other is grey', /128|gray|grey|#9/i.test(T.colorFor('__other__')) || T.colorFor('__other__') === T.OTHER_COLOR);

// 3. error response -> empty
ok('error -> empty', T.transform({ error: 'nope' }, '1h').empty === true);

// 4. all-null / no series -> empty
ok('no series -> empty', T.transform({ step: 10, start: 0, series: [] }, '1h').empty === true);
ok('all-null -> empty', T.transform({ step: 10, start: 0, series: [ { name: 'a', values: [null, null] } ] }, '1h').empty === true);

console.log(`transform: ${n} checks passed`);
