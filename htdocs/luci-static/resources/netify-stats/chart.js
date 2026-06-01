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

// Load the vendored Chart.js UMD once (sets window.Chart).
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

var RANGES = [ '1h', '1d', '30d' ];
var METRICS = [ 'rx_bytes', 'tx_bytes', 'pkts', 'flows' ];

return baseclass.extend({
    render: function (dimension, title) {
        return view.extend({
            chart: null,
            state: { metric: 'rx_bytes', range: '1h' },

            load: function () { return loadChart(); },

            // Query + (re)draw into the canvas.
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
                                plugins: { legend: { position: 'bottom' } }
                            }
                        };
                        if (self.chart) {
                            self.chart.data = cfg.data;
                            self.chart.update();
                        } else {
                            var ctx = document.getElementById('nsp-canvas').getContext('2d');
                            self.chart = new window.Chart(ctx, cfg);
                        }
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
                            self.refresh();
                        }
                    }, r);
                });

                var metricSel = E('select', {
                    'class': 'cbi-input-select',
                    'change': function (ev) { self.state.metric = ev.target.value; self.refresh(); }
                }, METRICS.map(function (m) {
                    return E('option', { 'value': m, 'selected': m === self.state.metric ? '' : null }, m);
                }));

                var node = E('div', { 'class': 'cbi-map' }, [
                    E('h2', {}, title),
                    E('div', { 'class': 'cbi-section' }, [
                        E('div', { 'style': 'display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px' }, [
                            E('div', { 'class': 'btn-group' }, rangeBtns),
                            E('div', {}, [ E('span', { 'class': 'label', 'style': 'margin-right:6px' }, _('Metric')), metricSel ])
                        ]),
                        E('div', { 'id': 'nsp-chartbox', 'style': 'position:relative;height:340px' }, [
                            E('canvas', { 'id': 'nsp-canvas' }),
                            E('div', { 'id': 'nsp-nodata', 'style': 'display:none;position:absolute;top:45%;width:100%;text-align:center;color:#777' }, _('No data yet'))
                        ])
                    ])
                ]);

                // initial draw + live refresh on the 1h range
                self.refresh();
                poll.add(function () { if (self.state.range === '1h') return self.refresh(); }, 10);

                return node;
            },

            handleSaveApply: null, handleSave: null, handleReset: null
        });
    }
});
