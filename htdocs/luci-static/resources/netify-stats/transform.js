'use strict';
'require baseclass';

var OTHER_COLOR = 'rgb(150, 150, 150)';

// Stable name -> color (golden-angle hue hash). __other__ is fixed grey.
function colorFor(name) {
    if (name === '__other__') return OTHER_COLOR;
    var h = 0;
    for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    var hue = (h % 360);
    return 'hsl(' + hue + ', 65%, 55%)';
}

function fmtLabel(epoch, range) {
    var d = new Date(epoch * 1000);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    if (range === '30d') return p(d.getMonth() + 1) + '/' + p(d.getDate());
    return p(d.getHours()) + ':' + p(d.getMinutes());
}

// (response, range) -> { empty, labels, datasets }
function transform(resp, range) {
    if (!resp || resp.error || !Array.isArray(resp.series) || resp.series.length === 0)
        return { empty: true, labels: [], datasets: [] };

    var step = resp.step || 1, start = resp.start || 0;
    var len = 0;
    resp.series.forEach(function (s) { if (s.values && s.values.length > len) len = s.values.length; });

    var anyValue = resp.series.some(function (s) {
        return (s.values || []).some(function (v) { return v !== null && v !== undefined; });
    });
    if (!anyValue) return { empty: true, labels: [], datasets: [] };

    var labels = [];
    for (var i = 0; i < len; i++) labels.push(fmtLabel(start + step * i, range));

    // __other__ ordered last; everything stacked under one stack id.
    var ordered = resp.series.slice().sort(function (a, b) {
        if (a.name === '__other__') return 1;
        if (b.name === '__other__') return -1;
        return 0;
    });

    var datasets = ordered.map(function (s) {
        var c = colorFor(s.name);
        return {
            label: s.name,
            data: (s.values || []).slice(),
            backgroundColor: c,
            borderColor: c,
            fill: true,
            stack: 'nsp',
            pointRadius: 0,
            tension: 0.2
        };
    });

    return { empty: false, labels: labels, datasets: datasets };
}

return baseclass.extend({
    OTHER_COLOR: OTHER_COLOR,
    colorFor: colorFor,
    fmtLabel: fmtLabel,
    transform: transform
});
