'use strict';
'require view';
'require rpc';
'require poll';
'require ui';
'require netify-stats.transform as T';

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

// ── Helpers ──────────────────────────────────────────────────────────────────


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

function loadPrefs() {
    try {
        var p = JSON.parse(localStorage.getItem('nsp-pref-dashboard') || '{}');
        return {
            sortCol: ['mac', 'rx', 'tx', 'total'].indexOf(p.sortCol) !== -1 ? p.sortCol : 'total',
            sortDir: p.sortDir === 'asc' ? 'asc' : 'desc'
        };
    } catch (e) { return { sortCol: 'total', sortDir: 'desc' }; }
}

function savePrefs(prefs) {
    try { localStorage.setItem('nsp-pref-dashboard', JSON.stringify(prefs)); } catch (e) {}
}

// Build top-N slices for a mini doughnut (remainder → __other__ grey).
function topSlices(apps, n) {
    var sorted = (apps || []).slice().sort(function (a, b) {
        return (b.rx + b.tx) - (a.rx + a.tx);
    });
    var top  = sorted.slice(0, n);
    var rest = sorted.slice(n);
    var other_rx = 0, other_tx = 0;
    rest.forEach(function (a) { other_rx += a.rx; other_tx += a.tx; });
    var slices = top.map(function (a) {
        return { name: a.name, val: a.rx + a.tx, color: T.colorFor(a.name) };
    });
    if (other_rx + other_tx > 0)
        slices.push({ name: '__other__', val: other_rx + other_tx, color: T.OTHER_COLOR });
    return slices;
}

// Destroy all Chart.js instances stored on elements inside `root`.
function destroyCharts(root) {
    root.querySelectorAll('canvas[data-chartid]').forEach(function (canvas) {
        var id = canvas.getAttribute('data-chartid');
        if (window._nspCharts && window._nspCharts[id]) {
            window._nspCharts[id].destroy();
            delete window._nspCharts[id];
        }
    });
}

// Create a Chart.js doughnut in `canvas`. Returns the Chart instance.
function makeDonut(canvas, labels, values, colors, tooltipCallbacks) {
    if (!window._nspCharts) window._nspCharts = {};
    var id = canvas.getAttribute('data-chartid') || ('c' + Math.random().toString(36).slice(2));
    canvas.setAttribute('data-chartid', id);
    var ch = new window.Chart(canvas, {
        type: 'doughnut',
        data: { labels: labels, datasets: [{ data: values, backgroundColor: colors, borderWidth: 1 }] },
        options: {
            responsive: false, animation: false, cutout: '60%',
            plugins: {
                legend: { display: false },
                tooltip: tooltipCallbacks
                    ? { callbacks: tooltipCallbacks }
                    : { enabled: true }
            }
        }
    });
    window._nspCharts[id] = ch;
    return ch;
}

// ── View ─────────────────────────────────────────────────────────────────────

return view.extend({
    _prefs: null,
    _data:  null,
    _pollAdded: false,

    load: function () {
        this._prefs = loadPrefs();
        return Promise.all([callQueryLive(), loadChart()]).then(function(r) { return r[0]; });
    },

    refresh: function () {
        var self = this;
        return callQueryLive().then(function (data) {
            self._data = data;
            self._redraw();
        }).catch(function (e) {
            ui.addNotification(null, E('p', _('netify-stats live query failed: %s').format(e.message)), 'warning');
        });
    },

    render: function (data) {
        var self = this;
        self._data = data || {};

        var resetBtn = E('button', {
            'class': 'btn',
            'click': function () {
                callResetLive().then(function () { self.refresh(); });
            }
        }, _('Reset'));

        var infoBar = E('div', {
            'id': 'nsp-dash-infobar',
            'style': 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px'
        }, [
            E('span', { 'id': 'nsp-dash-age', 'style': 'color:#777;font-size:12px' }, ''),
            resetBtn
        ]);

        var chartsRow = E('div', {
            'id': 'nsp-dash-charts',
            'style': 'display:flex;gap:24px;margin-bottom:16px'
        });

        var tableWrap = E('div', { 'id': 'nsp-dash-table' });

        var node = E('div', { 'class': 'cbi-map' }, [
            E('h2', {}, _('Netify Dashboard')),
            E('div', { 'class': 'cbi-section' }, [ infoBar, chartsRow, tableWrap ])
        ]);

        // Initial draw after DOM is inserted
        setTimeout(function () { self._redraw(); }, 0);

        if (!self._pollAdded) {
            poll.add(function () { self.refresh(); }, 30);
            self._pollAdded = true;
        }

        return node;
    },

    _redraw: function () {
        var self  = this;
        var data  = self._data || {};

        // Update info bar
        var ageEl = document.getElementById('nsp-dash-age');
        if (ageEl) ageEl.textContent = data.start
            ? _('Accumulating since %s · %s elapsed').format(
                new Date(data.start * 1000).toLocaleString(),
                fmtAge(data.start))
            : _('No data yet');

        // Charts row
        var chartsRow = document.getElementById('nsp-dash-charts');
        if (chartsRow) {
            destroyCharts(chartsRow);
            chartsRow.innerHTML = '';
            chartsRow.appendChild(self._buildDonutPanel(_('Applications'), data.apps || []));
            chartsRow.appendChild(self._buildDonutPanel(_('Categories'),   data.cats || []));
        }

        // Host table
        var tableWrap = document.getElementById('nsp-dash-table');
        if (tableWrap) {
            destroyCharts(tableWrap);
            tableWrap.innerHTML = '';
            tableWrap.appendChild(self._buildHostTable(data.hosts || []));
        }
    },

    _buildDonutPanel: function (title, series) {
        var labels = [], values = [], colors = [];
        series.forEach(function (s) {
            labels.push(s.name);
            values.push(s.rx + s.tx);
            colors.push(T.colorFor(s.name));
        });

        var canvas = E('canvas', {
            'width': '200', 'height': '200', 'style': 'display:block;margin:0 auto',
            'data-chartid': 'global-' + title
        });

        var tooltipCallbacks = {
            label: function (ctx) {
                var entry = series[ctx.dataIndex];
                if (!entry) return '';
                var lines = [ fmtBytes(entry.rx + entry.tx) ];
                if (entry.interfaces) {
                    Object.keys(entry.interfaces).forEach(function (iface) {
                        var m = entry.interfaces[iface];
                        lines.push(iface + ': ' + fmtBytes(m.rx) + ' ↓  ' + fmtBytes(m.tx) + ' ↑');
                    });
                }
                return lines;
            }
        };

        setTimeout(function () {
            var el = document.querySelector('[data-chartid="global-' + title + '"]');
            if (window.Chart && el && labels.length > 0)
                makeDonut(el, labels, values, colors, tooltipCallbacks);
        }, 0);

        return E('div', { 'style': 'flex:1;text-align:center;min-width:0' }, [
            E('div', { 'style': 'font-weight:bold;margin-bottom:8px' }, title),
            canvas
        ]);
    },

    _buildHostTable: function (hosts) {
        var self  = this;
        var prefs = self._prefs;

        if (!hosts.length)
            return E('div', { 'style': 'color:#777;padding:12px' }, _('No host data yet'));

        // Sort
        var dir = prefs.sortDir === 'asc' ? 1 : -1;
        var sorted = hosts.slice().sort(function (a, b) {
            if (prefs.sortCol === 'mac') return a.mac.localeCompare(b.mac) * dir;
            if (prefs.sortCol === 'rx')  return (a.rx - b.rx) * dir;
            if (prefs.sortCol === 'tx')  return (a.tx - b.tx) * dir;
            return ((a.rx + a.tx) - (b.rx + b.tx)) * dir;
        });

        var tbody = E('tbody', {});

        function thSort(label, col, align) {
            var arrow = prefs.sortCol === col ? (prefs.sortDir === 'desc' ? ' ↓' : ' ↑') : '';
            return E('th', {
                'style': 'cursor:pointer;padding:6px 8px;user-select:none;text-align:' + (align || 'left'),
                'click': function () {
                    prefs.sortDir = (prefs.sortCol === col && prefs.sortDir === 'desc') ? 'asc' : 'desc';
                    prefs.sortCol = col;
                    savePrefs(prefs);
                    var tableWrap = document.getElementById('nsp-dash-table');
                    if (tableWrap) {
                        destroyCharts(tableWrap);
                        tableWrap.innerHTML = '';
                        tableWrap.appendChild(self._buildHostTable(hosts));
                    }
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
            var canvas   = E('canvas', {
                'width': '56', 'height': '56',
                'data-chartid': canvasId,
                'style': 'vertical-align:middle'
            });

            setTimeout(function () {
                var el = document.querySelector('[data-chartid="' + canvasId + '"]');
                if (window.Chart && el && slices.length > 0)
                    makeDonut(
                        el,
                        slices.map(function (s) { return s.name; }),
                        slices.map(function (s) { return s.val; }),
                        slices.map(function (s) { return s.color; }),
                        null
                    );
            }, 0);

            var display = (host.ip || host.mac) + ' (' + host.mac.slice(0, 8) + '…)';

            var mainRow = E('tr', {
                'style': 'cursor:pointer',
                'click': function () {
                    var detail = tbody.querySelector('tr[data-detail="' + idx + '"]');
                    if (detail)
                        detail.style.display = detail.style.display === 'none' ? '' : 'none';
                }
            }, [
                E('td', { 'style': 'padding:4px 8px' }, '▶ ' + display),
                E('td', { 'style': 'padding:4px 8px' }, canvas),
                E('td', { 'style': 'padding:4px 8px;text-align:right;white-space:nowrap' }, fmtBytes(host.rx)),
                E('td', { 'style': 'padding:4px 8px;text-align:right;white-space:nowrap' }, fmtBytes(host.tx))
            ]);

            var detailApps = (host.apps || []).slice().sort(function (a, b) {
                return (b.rx + b.tx) - (a.rx + a.tx);
            });
            var detailInner = detailApps.map(function (a) {
                return E('tr', { 'style': 'background:#f8f8f8' }, [
                    E('td', { 'style': 'padding:2px 8px 2px 32px;color:' + T.colorFor(a.name), 'colspan': '2' }, a.name),
                    E('td', { 'style': 'padding:2px 8px;text-align:right;white-space:nowrap' }, fmtBytes(a.rx)),
                    E('td', { 'style': 'padding:2px 8px;text-align:right;white-space:nowrap' }, fmtBytes(a.tx))
                ]);
            });

            var detailRow = E('tr', { 'data-detail': String(idx), 'style': 'display:none' }, [
                E('td', { 'colspan': '4', 'style': 'padding:0' },
                    E('table', { 'style': 'width:100%;border-collapse:collapse' }, detailInner)
                )
            ]);

            tbody.appendChild(mainRow);
            tbody.appendChild(detailRow);
        });

        return E('table', { 'style': 'width:100%;border-collapse:collapse' }, [ thead, tbody ]);
    },

    handleSaveApply: null, handleSave: null, handleReset: null
});
