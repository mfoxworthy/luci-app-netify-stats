'use strict';
'require baseclass';
'require view';
'require rpc';
'require ui';
'require poll';
'require netify-stats.transform as T';

var callQuery = rpc.declare({
    object: 'luci.netify-stats',
    method: 'query',
    params: [ 'dimension', 'metric', 'range', 'keys' ],
    expect: { }
});

function loadChart() {
    if (window.Chart) return Promise.resolve(window.Chart);
    return new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = L.resource('netify-stats/chart.min.js');
        s.onload = function () { resolve(window.Chart); };
        s.onerror = function () { reject(new Error('failed to load Chart.js')); };
        document.head.appendChild(s);
    });
}

var RANGES  = [ '1h', '1d', '30d' ];
var METRICS = [ 'rx_bytes', 'tx_bytes', 'pkts', 'flows' ];

// Pure state machine. Mutates state.hidden and state.isolated in place.
// Each label lives in at most one set at a time.
function handleLegendClick(label, state) {
    if (state.isolated.size > 0) {
        if (state.isolated.has(label)) {
            state.isolated.delete(label);
            if (state.isolated.size === 0) state.hidden.clear();
        } else if (state.hidden.has(label)) {
            state.hidden.delete(label);
            state.isolated.add(label);
        } else {
            state.isolated.add(label);
        }
    } else {
        if (state.hidden.has(label)) {
            state.hidden.delete(label);
            state.isolated.add(label);
        } else {
            state.hidden.add(label);
        }
    }
}

function loadPrefs(dimension, state) {
    try {
        var raw = localStorage.getItem('nsp-pref-' + dimension);
        if (!raw) return;
        var p = JSON.parse(raw);
        if (p.range   && RANGES.indexOf(p.range)   !== -1) state.range   = p.range;
        if (p.metric  && METRICS.indexOf(p.metric)  !== -1) state.metric  = p.metric;
        if (Array.isArray(p.hidden))   state.hidden   = new Set(p.hidden);
        if (Array.isArray(p.isolated)) state.isolated = new Set(p.isolated);
    } catch (e) {}
}

function savePrefs(dimension, state) {
    try {
        localStorage.setItem('nsp-pref-' + dimension, JSON.stringify({
            range:    state.range,
            metric:   state.metric,
            hidden:   Array.from(state.hidden),
            isolated: Array.from(state.isolated)
        }));
    } catch (e) {}
}

function applyVisibility(chart, state) {
    chart.data.datasets.forEach(function (dataset, i) {
        var meta = chart.getDatasetMeta(i);
        if (state.isolated.size > 0) {
            meta.hidden = !state.isolated.has(dataset.label);
        } else {
            meta.hidden = state.hidden.has(dataset.label);
        }
    });
    var btn = document.getElementById('nsp-reset');
    if (btn) btn.disabled = (state.hidden.size === 0 && state.isolated.size === 0);
    chart.update('none');
}

return baseclass.extend({
    __test__: { handleLegendClick: handleLegendClick, loadPrefs: loadPrefs, savePrefs: savePrefs },

    render: function (dimension, title) {
        return view.extend({
            chart: null,
            state: { metric: 'rx_bytes', range: '1h', hidden: new Set(), isolated: new Set() },

            load: function () {
                var self = this;
                loadPrefs(dimension, self.state);
                return loadChart();
            },

            refresh: function () {
                var self = this;
                return callQuery(dimension, self.state.metric, self.state.range, [])
                    .then(function (resp) {
                        var data = T.transform(resp, self.state.range);
                        var holder = document.getElementById('nsp-chartbox');
                        if (!holder) return;
                        var msg = document.getElementById('nsp-nodata');
                        if (data.empty) {
                            if (self.chart) { self.chart.destroy(); self.chart = null; }
                            msg.style.display = ''; return;
                        }
                        msg.style.display = 'none';
                        var cfg = {
                            type: 'line',
                            data: { labels: data.labels, datasets: data.datasets },
                            options: {
                                responsive: true, maintainAspectRatio: false, animation: false,
                                interaction: { mode: 'index', intersect: false },
                                scales: { y: { stacked: true, beginAtZero: true }, x: { ticks: { maxTicksLimit: 8 } } },
                                plugins: {
                                    legend: {
                                        position: 'bottom',
                                        onClick: function (e, legendItem) {
                                            handleLegendClick(legendItem.text, self.state);
                                            savePrefs(dimension, self.state);
                                            applyVisibility(self.chart, self.state);
                                        }
                                    }
                                }
                            }
                        };
                        if (self.chart) {
                            self.chart.data = cfg.data;
                            // do NOT call chart.update() here — applyVisibility below calls chart.update('none')
                        } else {
                            var ctx = document.getElementById('nsp-canvas').getContext('2d');
                            self.chart = new window.Chart(ctx, cfg);
                        }
                        applyVisibility(self.chart, self.state);
                    })
                    .catch(function (e) {
                        ui.addNotification(null, E('p', _('netify-stats query failed: %s').format(e.message)), 'warning');
                    });
            },

            render: function () {
                var self = this;

                var rangeBtns = RANGES.map(function (r) {
                    return E('button', {
                        'class': 'btn' + (r === self.state.range ? ' cbi-button-action' : ''),
                        'data-range': r,
                        'click': function (ev) {
                            self.state.range = r;
                            ev.target.parentNode.querySelectorAll('button').forEach(function (b) {
                                b.classList.toggle('cbi-button-action', b.getAttribute('data-range') === r);
                            });
                            savePrefs(dimension, self.state);
                            self.refresh();
                        }
                    }, r);
                });

                var metricSel = E('select', {
                    'class': 'cbi-input-select',
                    'change': function (ev) {
                        self.state.metric = ev.target.value;
                        savePrefs(dimension, self.state);
                        self.refresh();
                    }
                }, METRICS.map(function (m) {
                    return E('option', { 'value': m, 'selected': m === self.state.metric ? '' : null }, m);
                }));

                var resetBtn = E('button', {
                    'id': 'nsp-reset',
                    'class': 'btn',
                    'disabled': true,
                    'click': function () {
                        self.state.hidden.clear();
                        self.state.isolated.clear();
                        savePrefs(dimension, self.state);
                        if (self.chart) applyVisibility(self.chart, self.state);
                    }
                }, _('Reset view'));

                var node = E('div', { 'class': 'cbi-map' }, [
                    E('h2', {}, title),
                    E('div', { 'class': 'cbi-section' }, [
                        E('div', { 'style': 'display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px' }, [
                            E('div', { 'class': 'btn-group' }, rangeBtns),
                            E('div', { 'style': 'display:flex;align-items:center;gap:8px' }, [
                                E('span', { 'class': 'label', 'style': 'margin-right:6px' }, _('Metric')),
                                metricSel,
                                resetBtn
                            ])
                        ]),
                        E('div', { 'id': 'nsp-chartbox', 'style': 'position:relative;height:340px' }, [
                            E('canvas', { 'id': 'nsp-canvas' }),
                            E('div', { 'id': 'nsp-nodata', 'style': 'display:none;position:absolute;top:45%;width:100%;text-align:center;color:#777' }, _('No data yet'))
                        ])
                    ])
                ]);

                self.refresh();
                poll.add(function () { if (self.state.range === '1h') return self.refresh(); }, 10);

                return node;
            },

            handleSaveApply: null, handleSave: null, handleReset: null
        });
    }
});
