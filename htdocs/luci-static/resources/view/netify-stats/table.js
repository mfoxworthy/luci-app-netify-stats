'use strict';
'require view';
'require rpc';
'require poll';
'require ui';
'require netify-stats.transform as T';

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

var RANGES = [ '1h', '1d', '30d' ];

function fmtBytes(n) {
    if (n == null || isNaN(n) || n <= 0) return '0 B';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
}

function sumSeries(values) {
    if (!Array.isArray(values)) return 0;
    var t = 0;
    for (var i = 0; i < values.length; i++)
        if (values[i] != null) t += values[i];
    return t;
}

// Merge rx and tx query responses into [{name, rx, tx, total}]
function mergeResults(rxResp, txResp) {
    var rows = {};
    function add(resp, key) {
        if (!resp || !Array.isArray(resp.series)) return;
        resp.series.forEach(function (s) {
            if (!rows[s.name]) rows[s.name] = { name: s.name, rx: 0, tx: 0, total: 0 };
            rows[s.name][key] = sumSeries(s.values);
        });
    }
    add(rxResp, 'rx');
    add(txResp, 'tx');
    return Object.keys(rows).map(function (k) {
        var r = rows[k];
        r.total = r.rx + r.tx;
        return r;
    });
}

function loadPrefs(state) {
    try {
        var raw = localStorage.getItem('nsp-pref-table');
        if (!raw) return;
        var p = JSON.parse(raw);
        if (p.range   && RANGES.indexOf(p.range) !== -1)              state.range   = p.range;
        if (typeof p.iface === 'string')                               state.iface   = p.iface;
        if (p.tab === 'apps' || p.tab === 'cats')                      state.tab     = p.tab;
        if (['name','rx','tx','total'].indexOf(p.sortCol) !== -1)      state.sortCol = p.sortCol;
        if (p.sortDir === 'asc' || p.sortDir === 'desc')               state.sortDir = p.sortDir;
    } catch (e) {}
}

function savePrefs(state) {
    try {
        localStorage.setItem('nsp-pref-table', JSON.stringify({
            range:   state.range,
            iface:   state.iface,
            tab:     state.tab,
            sortCol: state.sortCol,
            sortDir: state.sortDir
        }));
    } catch (e) {}
}

return view.extend({
    load: function () {
        var self = this;
        self.state = { range: '1h', iface: '', tab: 'apps', sortCol: 'total', sortDir: 'desc' };
        self._pollAdded = false;
        loadPrefs(self.state);
        return Promise.all([
            callListInterfaces(),
            callQuery(self.state.tab, 'rx_bytes', self.state.range, [], self.state.iface),
            callQuery(self.state.tab, 'tx_bytes', self.state.range, [], self.state.iface)
        ]).then(function (r) {
            return { ifaces: r[0], rows: mergeResults(r[1], r[2]) };
        });
    },

    refresh: function () {
        var self = this;
        return Promise.all([
            callQuery(self.state.tab, 'rx_bytes', self.state.range, [], self.state.iface),
            callQuery(self.state.tab, 'tx_bytes', self.state.range, [], self.state.iface)
        ]).then(function (r) {
            var rows = mergeResults(r[0], r[1]);
            var wrap = document.getElementById('nsp-table-wrap');
            if (wrap) wrap.replaceChildren(self.buildTable(rows));
        }).catch(function (e) {
            ui.addNotification(null, E('p', _('netify-stats query failed: %s').format(e.message)), 'warning');
        });
    },

    buildTable: function (rows) {
        var self  = this;
        var state = self.state;

        // Empty state
        var hasData = rows.some(function (r) { return r.name !== '__other__' && r.total > 0; });
        if (!hasData)
            return E('div', { style: 'padding:20px;text-align:center;color:#777' }, _('No data yet'));

        // Split __other__ off; sort the rest
        self.currentRows = rows;
        var other = rows.filter(function (r) { return r.name === '__other__'; });
        var rest  = rows.filter(function (r) { return r.name !== '__other__'; });
        var dir = state.sortDir === 'asc' ? 1 : -1;
        rest.sort(function (a, b) {
            if (state.sortCol === 'name') return a.name.localeCompare(b.name) * dir;
            return (a[state.sortCol] - b[state.sortCol]) * dir;
        });
        var sorted = rest.concat(other);

        // Bar scale: max total among non-other rows
        var maxTotal = rest.reduce(function (m, r) { return Math.max(m, r.total); }, 0) || 1;

        // Sortable column header
        function th(label, col, align) {
            var arrow = state.sortCol === col ? (state.sortDir === 'desc' ? ' ↓' : ' ↑') : '';
            return E('th', {
                style: 'cursor:pointer;user-select:none;padding:6px 8px;text-align:' + (align || 'left'),
                click: function () {
                    state.sortDir = (state.sortCol === col && state.sortDir === 'desc') ? 'asc' : 'desc';
                    state.sortCol = col;
                    savePrefs(state);
                    var wrap = document.getElementById('nsp-table-wrap');
                    if (wrap) wrap.replaceChildren(self.buildTable(self.currentRows));
                }
            }, label + arrow);
        }

        var thead = E('thead', {}, E('tr', {}, [
            th(_('Name'), 'name'),
            E('th', { style: 'padding:6px 8px;min-width:120px' }, _('Share')),
            th(_('RX'), 'rx', 'right'),
            th(_('TX'), 'tx', 'right')
        ]));

        var tbody = E('tbody', {});
        sorted.forEach(function (row) {
            var isOther = row.name === '__other__';
            var pct     = Math.round((row.total / maxTotal) * 100);
            var color   = T.colorFor(row.name);
            var label   = isOther ? _('(other)') : row.name;

            tbody.appendChild(E('tr', {}, [
                E('td', { style: 'padding:4px 8px;color:' + color + ';white-space:nowrap' }, label),
                E('td', { style: 'padding:4px 8px' },
                    E('div', { style: 'background:#e0e0e0;border-radius:3px;height:14px' },
                        E('div', { style: 'background:' + color + ';width:' + pct + '%;height:100%;border-radius:3px;min-width:' + (pct > 0 ? '2px' : '0') })
                    )
                ),
                E('td', { style: 'padding:4px 8px;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums' }, fmtBytes(row.rx)),
                E('td', { style: 'padding:4px 8px;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums' }, fmtBytes(row.tx))
            ]));
        });

        return E('table', { style: 'width:100%;border-collapse:collapse' }, [ thead, tbody ]);
    },

    render: function (data) {
        var self  = this;
        var state = self.state;

        // Clear stale iface pref
        if (state.iface && (!data.ifaces || data.ifaces.indexOf(state.iface) === -1)) {
            state.iface = '';
            savePrefs(state);
        }

        // Range buttons
        var rangeBtns = RANGES.map(function (r) {
            return E('button', {
                'class': 'btn' + (r === state.range ? ' cbi-button-action' : ''),
                'data-range': r,
                'click': function (ev) {
                    state.range = r;
                    ev.target.parentNode.querySelectorAll('button').forEach(function (b) {
                        b.classList.toggle('cbi-button-action', b.getAttribute('data-range') === r);
                    });
                    savePrefs(state);
                    self.refresh();
                }
            }, r);
        });

        // Interface dropdown
        var ifaceSel = (!data.ifaces || data.ifaces.length < 2) ? null : E('select', {
            'class': 'cbi-input-select',
            'change': function (ev) {
                state.iface = ev.target.value;
                savePrefs(state);
                self.refresh();
            }
        }, [ E('option', { value: '', selected: state.iface === '' ? '' : null }, _('All interfaces')) ]
            .concat(data.ifaces.map(function (f) {
                return E('option', { value: f, selected: f === state.iface ? '' : null }, f);
            }))
        );

        // Tab buttons
        function tabBtn(dim, label) {
            return E('button', {
                'class': 'btn' + (dim === state.tab ? ' cbi-button-action' : ''),
                'click': function (ev) {
                    if (state.tab === dim) return;
                    state.tab = dim;
                    ev.target.parentNode.querySelectorAll('button').forEach(function (b) {
                        b.classList.toggle('cbi-button-action', b === ev.target);
                    });
                    savePrefs(state);
                    self.refresh();
                }
            }, label);
        }

        // Initial table
        var initialTable = self.buildTable(data.rows);

        var rightControls = ifaceSel ? [ ifaceSel ] : [];

        var node = E('div', { 'class': 'cbi-map' }, [
            E('h2', {}, _('Netify Bandwidth')),
            E('div', { 'class': 'cbi-section' }, [
                E('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px' }, [
                    E('div', { 'class': 'btn-group' }, rangeBtns),
                    E('div', { style: 'display:flex;align-items:center;gap:8px' }, rightControls)
                ]),
                E('div', { 'class': 'btn-group', style: 'margin-bottom:12px' }, [
                    tabBtn('apps', _('Applications')),
                    tabBtn('cats', _('Categories'))
                ]),
                E('div', { id: 'nsp-table-wrap' }, initialTable)
            ])
        ]);

        if (!self._pollAdded) {
            poll.add(function () { if (state.range === '1h') return self.refresh(); }, 10);
            self._pollAdded = true;
        }

        return node;
    },

    handleSaveApply: null, handleSave: null, handleReset: null
});
