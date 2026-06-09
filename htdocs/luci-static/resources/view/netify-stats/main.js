'use strict';
'require view';
'require rpc';
'require poll';
'require ui';
'require netify-stats.transform as T';

// ── RPC declarations ─────────────────────────────────────────────────────────

var callQuery = rpc.declare({
    object: 'luci.netify-stats',
    method: 'query',
    params: [ 'dimension', 'metric', 'range', 'keys', 'iface' ],
    expect: { }
});

var callListInterfaces = rpc.declare({
    object: 'luci.netify-stats',
    method: 'list_interfaces',
    params: [],
    expect: { interfaces: [] }
});

var callQueryLive = rpc.declare({
    object: 'luci.netify-stats',
    method: 'query_live',
    params: [],
    expect: {}
});

var callResetLive = rpc.declare({
    object: 'luci.netify-stats',
    method: 'reset_live',
    params: [],
    expect: {}
});

// ── Constants ─────────────────────────────────────────────────────────────────

var RANGES  = [ '1h', '1d', '30d' ];
var METRICS = [ 'rx_bytes', 'tx_bytes', 'pkts', 'flows' ];
var TABS    = [ 'hosts', 'apps', 'cats', 'bandwidth' ];

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function fmtBytes(n) {
    if (!n) return '0 B';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
}

function fmtAge(start) {
    if (!start) return '';
    var secs = Math.floor(Date.now() / 1000) - start;
    if (secs < 60)   return secs + 's';
    if (secs < 3600) return Math.floor(secs / 60) + 'm';
    return Math.floor(secs / 3600) + 'h ' + Math.floor((secs % 3600) / 60) + 'm';
}

function topSlices(apps, n) {
    var sorted = (apps || []).slice().sort(function (a, b) { return (b.rx + b.tx) - (a.rx + a.tx); });
    var top = sorted.slice(0, n), rest = sorted.slice(n);
    var orx = 0, otx = 0;
    rest.forEach(function (a) { orx += a.rx; otx += a.tx; });
    var slices = top.map(function (a) { return { name: a.name, val: a.rx + a.tx, color: T.colorFor(a.name) }; });
    if (orx + otx > 0) slices.push({ name: '__other__', val: orx + otx, color: T.OTHER_COLOR });
    return slices;
}

function destroyCharts(root) {
    root.querySelectorAll('canvas[data-chartid]').forEach(function (cv) {
        var id = cv.getAttribute('data-chartid');
        if (window._nspCharts && window._nspCharts[id]) {
            window._nspCharts[id].destroy();
            delete window._nspCharts[id];
        }
    });
}

function makeDonut(canvas, labels, values, colors, tooltipCallbacks) {
    if (!window._nspCharts) window._nspCharts = {};
    var id = canvas.getAttribute('data-chartid') || ('c' + Math.random().toString(36).slice(2));
    canvas.setAttribute('data-chartid', id);
    var ch = new window.Chart(canvas, {
        type: 'doughnut',
        data: { labels: labels, datasets: [{ data: values, backgroundColor: colors, borderWidth: 1 }] },
        options: {
            responsive: false, animation: false, cutout: '45%',
            plugins: {
                legend: { display: false },
                tooltip: tooltipCallbacks ? { callbacks: tooltipCallbacks } : { enabled: true }
            }
        }
    });
    window._nspCharts[id] = ch;
    return ch;
}

// Legend click: pure state machine from chart.js
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

function applyVisibility(chart, state) {
    chart.data.datasets.forEach(function (ds, i) {
        var meta = chart.getDatasetMeta(i);
        meta.hidden = state.isolated.size > 0 ? !state.isolated.has(ds.label) : state.hidden.has(ds.label);
    });
    chart.update('none');
}

// ── Prefs ─────────────────────────────────────────────────────────────────────

function loadPrefs() {
    try { return JSON.parse(localStorage.getItem('nsp-pref-main') || 'null') || {}; } catch (e) { return {}; }
}
function savePrefs(p) {
    try { localStorage.setItem('nsp-pref-main', JSON.stringify(p)); } catch (e) {}
}

function initChartState(prefs, dim) {
    var saved = (prefs[dim] || {});
    var state = {
        range: RANGES.indexOf(saved.range) !== -1 ? saved.range : '1h',
        metric: METRICS.indexOf(saved.metric) !== -1 ? saved.metric : 'rx_bytes',
        iface: typeof saved.iface === 'string' ? saved.iface : '',
        hidden: new Set(Array.isArray(saved.hidden) ? saved.hidden : []),
        isolated: new Set(Array.isArray(saved.isolated) ? saved.isolated : [])
    };
    state.hidden.forEach(function (k) { state.isolated.delete(k); });
    return state;
}

function saveChartState(prefs, dim, state) {
    prefs[dim] = { range: state.range, metric: state.metric, iface: state.iface,
                   hidden: Array.from(state.hidden), isolated: Array.from(state.isolated) };
    savePrefs(prefs);
}

// ── Main view ─────────────────────────────────────────────────────────────────

return view.extend({
    _prefs: null,
    _ifaces: [],
    _charts: {},        // dim → Chart.js instance
    _chartStates: {},   // dim → state
    _liveData: null,
    _hostTick: 0,
    _pollAdded: false,
    _bwTab: 'apps',    // bandwidth sub-tab

    load: function () {
        var self = this;
        self._prefs = loadPrefs();
        self._chartStates.apps = initChartState(self._prefs, 'apps');
        self._chartStates.cats = initChartState(self._prefs, 'cats');
        return Promise.all([
            loadChart(),
            callListInterfaces(),
            callQueryLive()
        ]).then(function (r) {
            self._ifaces = r[1] || [];
            self._liveData = r[2] || {};
            // validate stale iface prefs
            ['apps', 'cats'].forEach(function (dim) {
                var st = self._chartStates[dim];
                if (st.iface && self._ifaces.indexOf(st.iface) === -1) {
                    st.iface = '';
                    saveChartState(self._prefs, dim, st);
                }
            });
        });
    },

    render: function () {
        var self  = this;
        var prefs = self._prefs;
        var tab   = TABS.indexOf(prefs.tab) !== -1 ? prefs.tab : 'hosts';

        // Tab buttons
        var tabLabels = { hosts: _('Hosts'), apps: _('Applications'), cats: _('Categories'), bandwidth: _('Bandwidth') };
        var tabBtns = TABS.map(function (t) {
            return E('button', {
                'class': 'btn' + (t === tab ? ' cbi-button-action' : ''),
                'data-tab': t,
                'click': function (ev) {
                    var newTab = ev.target.getAttribute('data-tab');
                    if (newTab === self._activeTab) return;
                    prefs.tab = newTab;
                    savePrefs(prefs);
                    ev.target.parentNode.querySelectorAll('button').forEach(function (b) {
                        b.classList.toggle('cbi-button-action', b.getAttribute('data-tab') === newTab);
                    });
                    self._switchTab(newTab);
                }
            }, tabLabels[t]);
        });

        self._activeTab = tab;
        var content = E('div', { 'id': 'nsp-main-content' });

        var node = E('div', { 'class': 'cbi-map' }, [
            E('h2', {}, _('Netify Dashboard')),
            E('div', { 'class': 'cbi-section' }, [
                E('div', { 'class': 'btn-group', 'style': 'margin-bottom:16px' }, tabBtns),
                content
            ])
        ]);

        setTimeout(function () { self._switchTab(tab); }, 0);

        if (!self._pollAdded) {
            poll.add(function () {
                var t = self._activeTab;
                if (t === 'hosts') {
                    self._hostTick = (self._hostTick || 0) + 1;
                    if (self._hostTick >= 3) { self._hostTick = 0; return self._refreshHosts(); }
                } else if (t === 'apps' || t === 'cats') {
                    if (self._chartStates[t] && self._chartStates[t].range === '1h')
                        return self._refreshChart(t);
                } else if (t === 'bandwidth') {
                    var bwst = self._chartStates['bw_' + self._bwTab];
                    if (bwst && bwst.range === '1h') return self._refreshBandwidth();
                }
            }, 10);
            self._pollAdded = true;
        }

        return node;
    },

    _switchTab: function (tab) {
        var self    = this;
        var content = document.getElementById('nsp-main-content');
        if (!content) return;
        destroyCharts(content);
        content.innerHTML = '';
        self._activeTab = tab;

        if (tab === 'hosts') {
            content.appendChild(self._buildHostsPanel());
        } else if (tab === 'apps' || tab === 'cats') {
            self._buildChartPanel(tab, content);
        } else if (tab === 'bandwidth') {
            content.appendChild(self._buildBandwidthPanel());
        }
    },

    // ── Hosts tab ─────────────────────────────────────────────────────────────

    _refreshHosts: function () {
        var self = this;
        return callQueryLive().then(function (data) {
            self._liveData = data;
            var wrap = document.getElementById('nsp-hosts-wrap');
            if (!wrap || self._activeTab !== 'hosts') return;
            destroyCharts(wrap);
            wrap.innerHTML = '';
            self._renderHostsInto(wrap, data);
        }).catch(function (e) {
            ui.addNotification(null, E('p', _('Live query failed: %s').format(e.message)), 'warning');
        });
    },

    _buildHostsPanel: function () {
        var self = this;
        var data = self._liveData || {};
        var wrap = E('div', { 'id': 'nsp-hosts-wrap' });
        self._renderHostsInto(wrap, data);
        return wrap;
    },

    _renderHostsInto: function (wrap, data) {
        var self = this;
        // Info bar
        var ageText = data.start
            ? _('Accumulating since %s · %s elapsed').format(new Date(data.start * 1000).toLocaleString(), fmtAge(data.start))
            : _('No data yet');
        wrap.appendChild(E('div', { 'style': 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px' }, [
            E('span', { 'style': 'color:#777;font-size:12px' }, ageText),
            E('button', { 'class': 'btn', 'click': function () { callResetLive().then(function () { self._refreshHosts(); }); } }, _('Reset'))
        ]));
        // Doughnuts
        var chartsRow = E('div', { 'style': 'display:flex;gap:24px;margin-bottom:16px' });
        chartsRow.appendChild(self._buildDonutPanel(_('Applications'), data.apps || []));
        chartsRow.appendChild(self._buildDonutPanel(_('Categories'),   data.cats || []));
        wrap.appendChild(chartsRow);
        // Host table
        wrap.appendChild(self._buildHostTable(data.hosts || []));
    },

    _buildDonutPanel: function (title, series) {
        var canvas = E('canvas', { 'width': '200', 'height': '200', 'data-chartid': 'global-' + title,
                                   'style': 'display:block;margin:0 auto' });
        var tooltipCallbacks = { label: function (ctx) {
            var entry = series[ctx.dataIndex];
            if (!entry) return '';
            var lines = [ fmtBytes(entry.rx + entry.tx) ];
            if (entry.interfaces) Object.keys(entry.interfaces).forEach(function (iface) {
                var m = entry.interfaces[iface];
                lines.push(iface + ': ' + fmtBytes(m.rx) + ' ↓  ' + fmtBytes(m.tx) + ' ↑');
            });
            return lines;
        }};
        setTimeout(function () {
            var el = document.querySelector('[data-chartid="global-' + title + '"]');
            if (window.Chart && el && series.length > 0)
                makeDonut(el, series.map(function (s) { return s.name; }),
                              series.map(function (s) { return s.rx + s.tx; }),
                              series.map(function (s) { return T.colorFor(s.name); }),
                              tooltipCallbacks);
        }, 0);
        return E('div', { 'style': 'flex:1;text-align:center;min-width:0' }, [
            E('div', { 'style': 'font-weight:bold;margin-bottom:8px' }, title), canvas
        ]);
    },

    _buildHostTable: function (hosts) {
        var self  = this;
        var prefs = self._prefs;
        var hp    = prefs.hosts || {};
        var sortCol = ['mac','rx','tx','total'].indexOf(hp.sortCol) !== -1 ? hp.sortCol : 'total';
        var sortDir = hp.sortDir === 'asc' ? 'asc' : 'desc';

        if (!hosts.length) return E('div', { 'style': 'color:#777;padding:12px' }, _('No host data yet'));

        var dir = sortDir === 'asc' ? 1 : -1;
        var sorted = hosts.slice().sort(function (a, b) {
            if (sortCol === 'mac') return a.mac.localeCompare(b.mac) * dir;
            if (sortCol === 'rx')  return (a.rx - b.rx) * dir;
            if (sortCol === 'tx')  return (a.tx - b.tx) * dir;
            return ((a.rx + a.tx) - (b.rx + b.tx)) * dir;
        });

        var tbody = E('tbody', {});

        function thSort(label, col, align) {
            var arrow = sortCol === col ? (sortDir === 'desc' ? ' ↓' : ' ↑') : '';
            return E('th', {
                'style': 'cursor:pointer;padding:6px 8px;user-select:none;text-align:' + (align || 'left'),
                'click': function () {
                    hp.sortDir = (sortCol === col && sortDir === 'desc') ? 'asc' : 'desc';
                    hp.sortCol = col;
                    prefs.hosts = hp;
                    savePrefs(prefs);
                    var wrap = document.getElementById('nsp-hosts-wrap');
                    if (wrap) { destroyCharts(wrap); wrap.innerHTML = ''; self._renderHostsInto(wrap, self._liveData || {}); }
                }
            }, label + arrow);
        }

        var thead = E('thead', {}, E('tr', {}, [
            thSort(_('Host'), 'mac'),
            E('th', { 'style': 'padding:6px 8px;text-align:center' }, _('Top Apps')),
            thSort(_('RX'), 'rx', 'right'),
            thSort(_('TX'), 'tx', 'right')
        ]));

        sorted.forEach(function (host, idx) {
            var slices   = topSlices(host.apps, 5);
            var canvasId = 'mini-' + host.mac.replace(/:/g, '');
            var canvas   = E('canvas', { 'width': '56', 'height': '56', 'data-chartid': canvasId,
                                         'style': 'display:block;margin:0 auto' });
            setTimeout(function () {
                var el = document.querySelector('[data-chartid="' + canvasId + '"]');
                if (window.Chart && el && slices.length > 0)
                    makeDonut(el, slices.map(function (s) { return s.name; }),
                                  slices.map(function (s) { return s.val; }),
                                  slices.map(function (s) { return s.color; }), null);
            }, 0);

            var display = (host.ip || host.mac) + ' (' + host.mac.slice(0, 8) + '…)';
            var mainRow = E('tr', { 'style': 'cursor:pointer', 'click': function () {
                tbody.querySelectorAll('tr[data-detail="' + idx + '"]').forEach(function (r) {
                    r.style.display = r.style.display === 'none' ? '' : 'none';
                });
            }}, [
                E('td', { 'style': 'padding:4px 8px' }, '▶ ' + display),
                E('td', { 'style': 'padding:4px 8px;text-align:center' }, canvas),
                E('td', { 'style': 'padding:4px 8px;text-align:right;white-space:nowrap' }, fmtBytes(host.rx)),
                E('td', { 'style': 'padding:4px 8px;text-align:right;white-space:nowrap' }, fmtBytes(host.tx))
            ]);

            var detailRows = (host.apps || []).slice()
                .sort(function (a, b) { return (b.rx + b.tx) - (a.rx + a.tx); })
                .map(function (a) {
                    return E('tr', { 'data-detail': String(idx), 'style': 'display:none;background:#f8f8f8' }, [
                        E('td', { 'style': 'padding:2px 8px 2px 32px;color:' + T.colorFor(a.name) }, a.name),
                        E('td'),
                        E('td', { 'style': 'padding:2px 8px;text-align:right;white-space:nowrap' }, fmtBytes(a.rx)),
                        E('td', { 'style': 'padding:2px 8px;text-align:right;white-space:nowrap' }, fmtBytes(a.tx))
                    ]);
                });

            tbody.appendChild(mainRow);
            detailRows.forEach(function (r) { tbody.appendChild(r); });
        });

        return E('table', { 'style': 'width:100%;border-collapse:collapse' }, [ thead, tbody ]);
    },

    // ── Chart tabs (Applications / Categories) ────────────────────────────────

    _buildChartPanel: function (dim, container) {
        var self  = this;
        var state = self._chartStates[dim];

        var rangeBtns = RANGES.map(function (r) {
            return E('button', {
                'class': 'btn' + (r === state.range ? ' cbi-button-action' : ''),
                'data-range': r,
                'click': function (ev) {
                    state.range = r;
                    ev.target.parentNode.querySelectorAll('button').forEach(function (b) {
                        b.classList.toggle('cbi-button-action', b.getAttribute('data-range') === r);
                    });
                    saveChartState(self._prefs, dim, state);
                    self._refreshChart(dim);
                }
            }, r);
        });

        var metricSel = E('select', { 'class': 'cbi-input-select', 'change': function (ev) {
            state.metric = ev.target.value;
            saveChartState(self._prefs, dim, state);
            self._refreshChart(dim);
        }}, METRICS.map(function (m) {
            return E('option', { 'value': m, 'selected': m === state.metric ? '' : null }, m);
        }));

        var ifaceSel = (!self._ifaces || self._ifaces.length < 2) ? null : E('select', {
            'class': 'cbi-input-select',
            'change': function (ev) {
                state.iface = ev.target.value;
                saveChartState(self._prefs, dim, state);
                self._refreshChart(dim);
            }
        }, [ E('option', { value: '', selected: state.iface === '' ? '' : null }, _('All interfaces')) ]
            .concat(self._ifaces.map(function (f) {
                return E('option', { value: f, selected: f === state.iface ? '' : null }, f);
            })));

        var resetBtn = E('button', { 'id': 'nsp-chart-reset-' + dim, 'class': 'btn', 'disabled': true,
            'click': function () {
                state.hidden.clear(); state.isolated.clear();
                saveChartState(self._prefs, dim, state);
                var ch = self._charts[dim];
                if (ch) applyVisibility(ch, state);
            }
        }, _('Reset view'));

        var rightControls = [ E('span', { 'class': 'label', 'style': 'margin-right:6px' }, _('Metric')), metricSel ];
        if (ifaceSel) rightControls.push(ifaceSel);
        rightControls.push(resetBtn);

        var chartWrap = E('div', { 'id': 'nsp-chart-' + dim, 'style': 'position:relative;height:340px' }, [
            E('canvas', { 'id': 'nsp-canvas-' + dim }),
            E('div', { 'id': 'nsp-nodata-' + dim, 'style': 'display:none;position:absolute;top:45%;width:100%;text-align:center;color:#777' }, _('No data yet'))
        ]);

        container.appendChild(E('div', { 'style': 'display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px' }, [
            E('div', { 'class': 'btn-group' }, rangeBtns),
            E('div', { 'style': 'display:flex;align-items:center;gap:8px' }, rightControls)
        ]));
        container.appendChild(chartWrap);

        self._charts[dim] = null;
        self._refreshChart(dim);
    },

    _refreshChart: function (dim) {
        var self  = this;
        var state = self._chartStates[dim];
        return callQuery(dim, state.metric, state.range, [], state.iface)
            .then(function (resp) {
                if (self._activeTab !== dim) return;
                var data   = T.transform(resp, state.range);
                var nodata = document.getElementById('nsp-nodata-' + dim);
                if (data.empty) {
                    var ch = self._charts[dim];
                    if (ch) { ch.destroy(); self._charts[dim] = null; }
                    if (nodata) nodata.style.display = '';
                    return;
                }
                if (nodata) nodata.style.display = 'none';
                var cfg = {
                    type: 'line',
                    data: { labels: data.labels, datasets: data.datasets },
                    options: {
                        responsive: true, maintainAspectRatio: false, animation: false,
                        interaction: { mode: 'index', intersect: false },
                        scales: { y: { stacked: true, beginAtZero: true }, x: { ticks: { maxTicksLimit: 8 } } },
                        plugins: { legend: { position: 'bottom', onClick: function (e, item) {
                            handleLegendClick(item.text, state);
                            saveChartState(self._prefs, dim, state);
                            applyVisibility(self._charts[dim], state);
                            var btn = document.getElementById('nsp-chart-reset-' + dim);
                            if (btn) btn.disabled = (state.hidden.size === 0 && state.isolated.size === 0);
                        }}}
                    }
                };
                if (self._charts[dim]) {
                    self._charts[dim].data = cfg.data;
                } else {
                    var ctx = document.getElementById('nsp-canvas-' + dim);
                    if (!ctx) return;
                    self._charts[dim] = new window.Chart(ctx.getContext('2d'), cfg);
                }
                applyVisibility(self._charts[dim], state);
            })
            .catch(function (e) {
                ui.addNotification(null, E('p', _('Chart query failed: %s').format(e.message)), 'warning');
            });
    },

    // ── Bandwidth tab ─────────────────────────────────────────────────────────

    _initBwState: function (dim) {
        var self  = this;
        var key   = 'bw_' + dim;
        if (self._chartStates[key]) return self._chartStates[key];
        var saved = (self._prefs[key] || {});
        var st = {
            range:   RANGES.indexOf(saved.range) !== -1 ? saved.range : '1h',
            metric:  METRICS.indexOf(saved.metric) !== -1 ? saved.metric : 'rx_bytes',
            iface:   typeof saved.iface === 'string' ? saved.iface : '',
            sortCol: ['name','rx','tx','total'].indexOf(saved.sortCol) !== -1 ? saved.sortCol : 'total',
            sortDir: saved.sortDir === 'asc' ? 'asc' : 'desc'
        };
        if (st.iface && self._ifaces.indexOf(st.iface) === -1) st.iface = '';
        self._chartStates[key] = st;
        return st;
    },

    _buildBandwidthPanel: function () {
        var self = this;
        var wrap = E('div', { 'id': 'nsp-bw-wrap' });
        self._renderBandwidthInto(wrap, self._bwTab);
        return wrap;
    },

    _refreshBandwidth: function () {
        var self = this;
        var wrap = document.getElementById('nsp-bw-wrap');
        if (!wrap || self._activeTab !== 'bandwidth') return;
        self._renderBandwidthInto(wrap, self._bwTab);
    },

    _renderBandwidthInto: function (wrap, dim) {
        var self  = this;
        var state = self._initBwState(dim);

        function saveState() {
            self._prefs['bw_' + dim] = {
                range: state.range, metric: state.metric, iface: state.iface,
                sortCol: state.sortCol, sortDir: state.sortDir
            };
            savePrefs(self._prefs);
        }

        // Controls
        var rangeBtns = RANGES.map(function (r) {
            return E('button', {
                'class': 'btn' + (r === state.range ? ' cbi-button-action' : ''),
                'data-range': r,
                'click': function (ev) {
                    state.range = r;
                    ev.target.parentNode.querySelectorAll('button').forEach(function (b) {
                        b.classList.toggle('cbi-button-action', b.getAttribute('data-range') === r);
                    });
                    saveState();
                    self._renderBandwidthInto(wrap, dim);
                }
            }, r);
        });

        var ifaceSel = (!self._ifaces || self._ifaces.length < 2) ? null : E('select', {
            'class': 'cbi-input-select', 'change': function (ev) {
                state.iface = ev.target.value; saveState(); self._renderBandwidthInto(wrap, dim);
            }
        }, [ E('option', { value: '', selected: state.iface === '' ? '' : null }, _('All interfaces')) ]
            .concat(self._ifaces.map(function (f) {
                return E('option', { value: f, selected: f === state.iface ? '' : null }, f);
            })));

        // Sub-tabs
        var subTabs = ['apps', 'cats'].map(function (d) {
            return E('button', {
                'class': 'btn' + (d === dim ? ' cbi-button-action' : ''),
                'click': function (ev) {
                    if (self._bwTab === d) return;
                    self._bwTab = d;
                    ev.target.parentNode.querySelectorAll('button').forEach(function (b) {
                        b.classList.toggle('cbi-button-action', b === ev.target);
                    });
                    self._renderBandwidthInto(wrap, d);
                }
            }, d === 'apps' ? _('Applications') : _('Categories'));
        });

        var rightControls = ifaceSel ? [ ifaceSel ] : [];

        wrap.innerHTML = '';
        wrap.appendChild(E('div', { 'style': 'display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px' }, [
            E('div', { 'class': 'btn-group' }, rangeBtns),
            E('div', { 'style': 'display:flex;align-items:center;gap:8px' }, rightControls)
        ]));
        wrap.appendChild(E('div', { 'class': 'btn-group', 'style': 'margin-bottom:12px' }, subTabs));

        var tableHolder = E('div', { 'style': 'color:#777;padding:12px' }, _('Loading…'));
        wrap.appendChild(tableHolder);

        Promise.all([
            callQuery(dim, 'rx_bytes', state.range, [], state.iface),
            callQuery(dim, 'tx_bytes', state.range, [], state.iface)
        ]).then(function (results) {
            if (self._activeTab !== 'bandwidth' || self._bwTab !== dim) return;
            var rows = mergeResults(results[0], results[1]);
            tableHolder.innerHTML = '';
            tableHolder.appendChild(self._buildBwTable(rows, state, dim, saveState, wrap));
        });
    },

    _buildBwTable: function (rows, state, dim, saveState, wrap) {
        var self = this;
        var hasData = rows.some(function (r) { return r.name !== '__other__' && r.total > 0; });
        if (!hasData) return E('div', { 'style': 'color:#777;padding:12px' }, _('No data yet'));

        var other = rows.filter(function (r) { return r.name === '__other__'; });
        var rest  = rows.filter(function (r) { return r.name !== '__other__'; });
        var dir   = state.sortDir === 'asc' ? 1 : -1;
        rest.sort(function (a, b) {
            if (state.sortCol === 'name') return a.name.localeCompare(b.name) * dir;
            return (a[state.sortCol] - b[state.sortCol]) * dir;
        });
        var sorted   = rest.concat(other);
        var maxTotal = rest.reduce(function (m, r) { return Math.max(m, r.total); }, 0) || 1;

        function thSort(label, col, align) {
            var arrow = state.sortCol === col ? (state.sortDir === 'desc' ? ' ↓' : ' ↑') : '';
            return E('th', {
                'style': 'cursor:pointer;padding:6px 8px;user-select:none;text-align:' + (align || 'left'),
                'click': function () {
                    state.sortDir = (state.sortCol === col && state.sortDir === 'desc') ? 'asc' : 'desc';
                    state.sortCol = col;
                    saveState();
                    var w = document.getElementById('nsp-bw-wrap');
                    if (w) self._renderBandwidthInto(w, dim);
                }
            }, label + arrow);
        }

        var tbody = E('tbody', {});
        sorted.forEach(function (row) {
            var pct   = Math.round((row.total / maxTotal) * 100);
            var color = T.colorFor(row.name);
            var label = row.name === '__other__' ? _('(other)') : T.cleanName(row.name);
            tbody.appendChild(E('tr', {}, [
                E('td', { 'style': 'padding:4px 8px;color:' + color + ';white-space:nowrap' }, label),
                E('td', { 'style': 'padding:4px 8px' },
                    E('div', { 'style': 'background:#e0e0e0;border-radius:3px;height:14px' },
                        E('div', { 'style': 'background:' + color + ';width:' + pct + '%;height:100%;border-radius:3px;min-width:' + (pct > 0 ? '2px' : '0') })
                    )
                ),
                E('td', { 'style': 'padding:4px 8px;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums' }, fmtBytes(row.rx)),
                E('td', { 'style': 'padding:4px 8px;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums' }, fmtBytes(row.tx))
            ]));
        });

        return E('table', { 'style': 'width:100%;border-collapse:collapse' }, [
            E('thead', {}, E('tr', {}, [
                thSort(_('Name'), 'name'),
                E('th', { 'style': 'padding:6px 8px' }, _('Share')),
                thSort(_('RX'), 'rx', 'right'),
                thSort(_('TX'), 'tx', 'right')
            ])),
            tbody
        ]);
    },

    handleSaveApply: null, handleSave: null, handleReset: null
});

// ── Bandwidth helpers ─────────────────────────────────────────────────────────

function mergeResults(rxResp, txResp) {
    var rows = {};
    function add(resp, key) {
        if (!resp || !Array.isArray(resp.series)) return;
        resp.series.forEach(function (s) {
            if (!rows[s.name]) rows[s.name] = { name: s.name, rx: 0, tx: 0, total: 0 };
            var t = 0;
            (s.values || []).forEach(function (v) { if (v != null) t += v; });
            rows[s.name][key] = t;
        });
    }
    add(rxResp, 'rx');
    add(txResp, 'tx');
    return Object.keys(rows).map(function (k) {
        var r = rows[k]; r.total = r.rx + r.tx; return r;
    });
}
