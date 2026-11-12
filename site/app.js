(function () {
  'use strict';

  var T = window.TianZhi;
  if (!T) {
    document.body.innerHTML = '<div style="padding:40px;font-family:sans-serif">缺少 logic.js，请确认它与 index.html 在同一个目录。</div>';
    return;
  }

  // 集合预报层（可选）：取不到时为 undefined，界面自动退回确定性窗口
  var E = window.TianZhiEnsemble || null;

  /** 日期短格式：2026-11-13 → 11/13 */
  function fmtDate(s) {
    if (!s) return '';
    var p = s.split('-');
    return parseInt(p[1], 10) + '/' + parseInt(p[2], 10);
  }

  var CROP_NAME = T.CROP_NAME, RULES = T.RULES, pad2 = T.pad2, CITIES = T.CITIES;
  var $ = function (id) { return document.getElementById(id); };
  var isFile = location.protocol === 'file:';
  var STORE_KEY = 'tianzhi.plots.v3';

  /* =========================================================
     状态与持久化
     ========================================================= */
  var DEFAULT_PLOTS = [
    { id: 'p1', name: '东洼地', area: 10, crop: 'wheat', place: '保定市',   city: '保定市', lat: 38.8729, lon: 115.4625 },
    { id: 'p2', name: '南坡地', area: 6,  crop: 'wheat', place: '石家庄市', city: '石家庄市', lat: 38.0414, lon: 114.4786 },
    { id: 'p3', name: '北地块', area: 15, crop: 'maize', place: '邯郸市',   city: '邯郸市', lat: 36.6103, lon: 114.4900 },
    { id: 'p4', name: '西洼地', area: 8,  crop: 'wheat', place: '衡水市',   city: '衡水市', lat: 37.7392, lon: 115.6758 }
  ];

  var state = {
    plots: [],
    activeId: null,
    raw: null,
    result: null,
    loading: false,
    chartDay: null,
    editing: null,
    pendingDelete: null,
    task: 'spray'          // 未来七天当前查看的作业类型：spray / irrigation / harvest
  };

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        plots: state.plots, activeId: state.activeId
      }));
    } catch (e) { /* 隐私模式或 file:// 受限时忽略 */ }
  }

  function loadStore() {
    try {
      var s = localStorage.getItem(STORE_KEY);
      if (!s) return false;
      var o = JSON.parse(s);
      if (!o || !Array.isArray(o.plots) || !o.plots.length) return false;
      state.plots = o.plots;
      state.activeId = o.activeId || o.plots[0].id;
      return true;
    } catch (e) { return false; }
  }

  function activePlot() {
    for (var i = 0; i < state.plots.length; i++) {
      if (state.plots[i].id === state.activeId) return state.plots[i];
    }
    return state.plots[0] || null;
  }

  /* =========================================================
     小工具
     ========================================================= */
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove('on'); }, 2600);
  }
  function setStatus(kind, text) {
    $('status').className = 'status' + (kind ? ' ' + kind : '');
    $('statusText').textContent = text;
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
  }
  function round1(n) { return Math.round(n * 10) / 10; }

  var ICONS = {
    clear:'<circle cx="12" cy="12" r="4.2"/><path d="M12 3.2v2.2M12 18.6v2.2M3.2 12h2.2M18.6 12h2.2M5.8 5.8l1.6 1.6M16.6 16.6l1.6 1.6M18.2 5.8l-1.6 1.6M7.4 16.6l-1.6 1.6"/>',
    partly:'<circle cx="9.4" cy="9.2" r="3.2"/><path d="M9.4 3.6v1.6M3.8 9.2h1.6M5.4 5.2l1.1 1.1"/><path d="M8.6 18.6h9.2a2.9 2.9 0 0 0 .2-5.8 4.3 4.3 0 0 0-8.2-.6 2.7 2.7 0 0 0-1.2 6.4z"/>',
    cloud:'<path d="M7 18.4h9.6a3.2 3.2 0 0 0 .3-6.4 4.6 4.6 0 0 0-8.8-.6A2.9 2.9 0 0 0 7 18.4z"/>',
    overcast:'<path d="M6.4 15.4h10.2a2.9 2.9 0 0 0 .2-5.8 4.3 4.3 0 0 0-8.2-.6 2.7 2.7 0 0 0-2.2 6.4z"/><path d="M5.4 18.6h11"/>',
    fog:'<path d="M7 18.4h9.6a3.2 3.2 0 0 0 .3-6.4 4.6 4.6 0 0 0-8.8-.6A2.9 2.9 0 0 0 7 18.4z"/><path d="M4.4 20.6h15.2M6.4 8.6h4"/>',
    rain:'<path d="M7 15.2h9.6a3.2 3.2 0 0 0 .3-6.4 4.6 4.6 0 0 0-8.8-.6A2.9 2.9 0 0 0 7 15.2z"/><path d="M8.6 18v2.4M12 18v2.4M15.4 18v2.4"/>',
    snow:'<path d="M7 15.2h9.6a3.2 3.2 0 0 0 .3-6.4 4.6 4.6 0 0 0-8.8-.6A2.9 2.9 0 0 0 7 15.2z"/><path d="M8.4 18.2v2M8.4 18.2l-1.5.9M8.4 18.2l1.5.9M14.4 18.2v2M14.4 18.2l-1.5.9M14.4 18.2l1.5.9"/>',
    storm:'<path d="M7 15.2h9.6a3.2 3.2 0 0 0 .3-6.4 4.6 4.6 0 0 0-8.8-.6A2.9 2.9 0 0 0 7 15.2z"/><path d="M12.6 16.4l-1.8 3h2.6l-1.4 2.6"/>',
    none:'<circle cx="12" cy="12" r="1.6"/>'
  };
  function iconKey(code) {
    if (code === null || code === undefined) return 'none';
    if (code === 0) return 'clear';
    if (code === 1) return 'partly';
    if (code === 2) return 'cloud';
    if (code === 3) return 'overcast';
    if (code === 45 || code === 48) return 'fog';
    if (code >= 51 && code <= 67) return 'rain';
    if (code >= 71 && code <= 77) return 'snow';
    if (code >= 80 && code <= 82) return 'rain';
    if (code >= 85 && code <= 86) return 'snow';
    if (code >= 95) return 'storm';
    return 'none';
  }
  function iconOf(code, size) {
    var k = iconKey(code);
    var color = (k === 'clear' || k === 'partly') ? '#f59e0b'
              : (k === 'rain' || k === 'storm') ? '#3b82f6'
              : (k === 'snow') ? '#60a5fa'
              : (k === 'fog') ? '#9ca3af' : '#9ca3af';
    var s = size || 22;
    return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="' + color +
           '" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + ICONS[k] + '</svg>';
  }

  var VERDICT = {
    spray:      { ok: '可作业',   warn: '谨慎',     bad: '不宜' },
    irrigation: { ok: '无需灌溉', warn: '注意墒情', bad: '不宜作业' },
    harvest:    { ok: '适合晾晒', warn: '谨慎',     bad: '不宜晾晒' }
  };
  var STATE_TEXT = { ok: '可作业', warn: '谨慎', bad: '不宜' };
  var STATE_CLS  = { ok: 's-ok', warn: 's-warn', bad: 's-bad' };

  /* =========================================================
     天气获取
     ========================================================= */
  function fetchWithTimeout(url, ms) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, ms);
    return fetch(url, { signal: ctrl.signal }).then(function (r) {
      clearTimeout(timer);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }, function (e) { clearTimeout(timer); throw e; });
  }

  /**
   * 取天气：统一走 weather.js（和风优先，失败自动回退 Open-Meteo）
   * 返回结构与 Open-Meteo 原始结构一致，上层无需关心来源。
   */
  function fetchWeather(lat, lon, opts) {
    var W = window.TianZhiWeather;
    if (!W) {
      // 极端情况：weather.js 没加载，直接打 Open-Meteo
      var u = new URL('https://api.open-meteo.com/v1/forecast');
      u.searchParams.set('latitude', lat);
      u.searchParams.set('longitude', lon);
      u.searchParams.set('hourly', 'temperature_2m,precipitation,wind_speed_10m,relative_humidity_2m');
      u.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,weather_code');
      u.searchParams.set('timezone', 'Asia/Shanghai');
      u.searchParams.set('forecast_days', '7');
      return fetchWithTimeout(u.toString(), 15000);
    }
    return W.getWeather(lat, lon, opts || {});
  }

  /* =========================================================
     SVG 图表（手写，无图表库）
     ========================================================= */

  /** 逐小时风速折线 + 阈值线 + 可作业时段底色 */
  function windChartSvg(hours, maxWind) {
    var W = 620, H = 210, L = 40, R = 14, TP = 16, B = 30;
    var iw = W - L - R, ih = H - TP - B;
    var ymax = Math.max(4, Math.ceil(Math.max(maxWind, RULES.spray.wind_max) + 1));
    var x = function (h) { return L + (h / 23) * iw; };
    var y = function (v) { return TP + ih - (v / ymax) * ih; };

    var p = [];
    // 可作业时段底色
    p.push('<rect x="' + x(RULES.spray.hours[0]).toFixed(1) + '" y="' + TP + '" width="' +
      (x(RULES.spray.hours[1]) - x(RULES.spray.hours[0])).toFixed(1) + '" height="' + ih +
      '" fill="rgba(95,115,82,.13)" rx="4"/>');
    // 横向网格
    for (var g = 0; g <= ymax; g += 2) {
      p.push('<line x1="' + L + '" y1="' + y(g).toFixed(1) + '" x2="' + (W - R) + '" y2="' + y(g).toFixed(1) +
        '" stroke="#f1f5f9" stroke-width="1"/>');
      p.push('<text x="' + (L - 7) + '" y="' + (y(g) + 3.5).toFixed(1) + '" font-size="9.5" text-anchor="end">' + g + '</text>');
    }
    // 面积 + 折线
    var area = 'M' + x(hours[0].hour).toFixed(1) + ',' + y(hours[0].wind).toFixed(1);
    var line = area;
    for (var i = 1; i < hours.length; i++) {
      area += ' L' + x(hours[i].hour).toFixed(1) + ',' + y(hours[i].wind).toFixed(1);
      line += ' L' + x(hours[i].hour).toFixed(1) + ',' + y(hours[i].wind).toFixed(1);
    }
    area += ' L' + x(hours[hours.length - 1].hour).toFixed(1) + ',' + (TP + ih) + ' L' + x(hours[0].hour).toFixed(1) + ',' + (TP + ih) + ' Z';
    p.push('<path d="' + area + '" fill="url(#windGrad)"/>');
    p.push('<path d="' + line + '" fill="none" stroke="#4a5f3f" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>');

    // 阈值线
    var ty = y(RULES.spray.wind_max).toFixed(1);
    p.push('<line x1="' + L + '" y1="' + ty + '" x2="' + (W - R) + '" y2="' + ty +
      '" stroke="#a83e28" stroke-width="1.4" stroke-dasharray="5 4"/>');
    p.push('<text x="' + (W - R) + '" y="' + (+ty - 5).toFixed(1) + '" font-size="9.5" text-anchor="end" fill="#a83e28">上限 2.5</text>');

    // 点
    hours.forEach(function (h) {
      var ok = h.wind <= RULES.spray.wind_max;
      p.push('<circle cx="' + x(h.hour).toFixed(1) + '" cy="' + y(h.wind).toFixed(1) + '" r="2.6" fill="' +
        (ok ? '#4a5f3f' : '#a83e28') + '" stroke="#fff" stroke-width="1"/>');
    });

    // 横轴
    [0, 6, 12, 18, 23].forEach(function (h) {
      p.push('<text x="' + x(h).toFixed(1) + '" y="' + (H - 10) + '" font-size="9.5" text-anchor="middle">' + h + '时</text>');
    });
    p.push('<text x="' + L + '" y="' + (TP - 4) + '" font-size="9" fill="#9ca3af">风速 m/s</text>');

    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '">' +
      '<defs><linearGradient id="windGrad" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#10b981" stop-opacity=".38"/>' +
      '<stop offset="100%" stop-color="#10b981" stop-opacity=".04"/></linearGradient></defs>' +
      p.join('') + '</svg>';
  }

  /** 7 天 × 24 小时 作业窗口热力图 */
  function heatChartSvg(raw, result) {
    var days = result.days;
    var W = 1180, H = 250, L = 52, R = 12, TP = 22, B = 30;
    var cw = (W - L - R) / 24, chh = (H - TP - B) / days.length;

    var p = [];
    days.forEach(function (d, di) {
      var hours = T.hoursOf(raw.hourly, d.date);
      var map = {};
      hours.forEach(function (h) { map[h.hour] = h; });

      // 该日是否被降雨拦截（与"今天的建议"里的判定保持一致）
      var prev = di > 0 ? days[di - 1] : null;
      var blocked = d.dayRain > RULES.spray.rain_day_max ||
                    (prev && prev.dayRain >= RULES.spray.rain_prev_max);

      p.push('<text x="' + (L - 9) + '" y="' + (TP + di * chh + chh / 2 + 3.6).toFixed(1) +
        '" font-size="11" text-anchor="end" fill="#7d8f76">' + (di === 0 ? '今天' : d.dow) + '</text>');

      for (var h = 0; h < 24; h++) {
        var cell = map[h];
        var inWork = h >= RULES.spray.hours[0] && h < RULES.spray.hours[1];
        var color = '#f3f4f6';
        if (blocked && inWork) {
          color = '#c7d2fe';                       // 降雨拦截
        } else if (cell && inWork) {
          var v = T.hourVerdict(cell);
          color = v === 'ok' ? '#bbf7d0' : v === 'wind' ? '#fed7aa' : v === 'cold' ? '#bfdbfe' : '#fde68a';
        }
        p.push('<rect x="' + (L + h * cw).toFixed(1) + '" y="' + (TP + di * chh).toFixed(1) +
          '" width="' + (cw - 2).toFixed(1) + '" height="' + (chh - 2.2).toFixed(1) +
          '" rx="2.5" fill="' + color + '"/>');
      }
    });

    var wx = function (h) { return L + h * cw; };
    // 作业时段边界
    [RULES.spray.hours[0], RULES.spray.hours[1]].forEach(function (h) {
      p.push('<line x1="' + wx(h).toFixed(1) + '" y1="' + (TP - 7) + '" x2="' + wx(h).toFixed(1) +
        '" y2="' + (TP + days.length * chh).toFixed(1) + '" stroke="#c9d4b8" stroke-width="1" stroke-dasharray="3 3"/>');
    });
    p.push('<text x="' + (wx(RULES.spray.hours[0]) + 4).toFixed(1) + '" y="' + (TP - 9) +
      '" font-size="9.5" fill="#9ca3af">6:00 作业时段开始</text>');
    p.push('<text x="' + (wx(RULES.spray.hours[1]) - 4).toFixed(1) + '" y="' + (TP - 9) +
      '" font-size="9.5" fill="#9ca3af" text-anchor="end">17:00 结束</text>');

    [0, 3, 6, 9, 12, 15, 18, 21].forEach(function (h) {
      p.push('<text x="' + (L + h * cw + cw / 2).toFixed(1) + '" y="' + (H - 9) +
        '" font-size="10" text-anchor="middle">' + h + ':00</text>');
    });

    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '">' + p.join('') + '</svg>';
  }

  /** 7 天温度双折线 + 降水柱（降水单独占底部区域，避免被温度带遮住） */
  function tempChartSvg(result) {
    var W = 620, H = 230, L = 40, R = 14, TP = 16, B = 30;
    var RAIN_BAND = 46;
    var iw = W - L - R;
    var ihT = H - TP - B - RAIN_BAND;          // 温度区高度
    var days = result.days;
    var tmax = days.map(function (d) { return d.tmax; });
    var tmin = days.map(function (d) { return d.tmin; });
    var ymax = Math.ceil((Math.max.apply(null, tmax) + 2) / 5) * 5;
    var ymin = Math.floor((Math.min.apply(null, tmin) - 2) / 5) * 5;
    var x = function (i) { return L + (days.length === 1 ? iw / 2 : i / (days.length - 1) * iw); };
    var y = function (v) { return TP + ihT - (v - ymin) / (ymax - ymin) * ihT; };
    var rainTop = TP + ihT + 8;                 // 降水柱区顶部
    var rainBase = TP + ihT + RAIN_BAND - 8;    // 降水基线

    var p = [];
    // 温度网格
    for (var g = ymin; g <= ymax; g += 5) {
      p.push('<line x1="' + L + '" y1="' + y(g).toFixed(1) + '" x2="' + (W - R) + '" y2="' + y(g).toFixed(1) + '" stroke="#f1f5f9"/>');
      p.push('<text x="' + (L - 7) + '" y="' + (y(g) + 3.5).toFixed(1) + '" font-size="9.5" text-anchor="end">' + g + '</text>');
    }
    // 温差带
    var band = 'M' + x(0).toFixed(1) + ',' + y(tmax[0]).toFixed(1);
    for (var i = 1; i < days.length; i++) band += ' L' + x(i).toFixed(1) + ',' + y(tmax[i]).toFixed(1);
    for (var j = days.length - 1; j >= 0; j--) band += ' L' + x(j).toFixed(1) + ',' + y(tmin[j]).toFixed(1);
    band += ' Z';
    p.push('<path d="' + band + '" fill="#fee2e2" opacity=".5"/>');

    function poly(arr, color) {
      var d = 'M' + x(0).toFixed(1) + ',' + y(arr[0]).toFixed(1);
      for (var i = 1; i < arr.length; i++) d += ' L' + x(i).toFixed(1) + ',' + y(arr[i]).toFixed(1);
      var out = '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
      arr.forEach(function (v, i) {
        out += '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(v).toFixed(1) + '" r="2.6" fill="#fff" stroke="' + color + '" stroke-width="1.6"/>';
      });
      return out;
    }
    p.push(poly(tmax, '#a83e28'));
    p.push(poly(tmin, '#3b82f6'));

    days.forEach(function (d, i) {
      p.push('<text x="' + x(i).toFixed(1) + '" y="' + (y(d.tmax) - 7).toFixed(1) + '" font-size="9.5" text-anchor="middle" fill="#ef4444">' + d.tmax + '</text>');
      p.push('<text x="' + x(i).toFixed(1) + '" y="' + (y(d.tmin) + 14).toFixed(1) + '" font-size="9.5" text-anchor="middle" fill="#3b82f6">' + d.tmin + '</text>');
    });

    // 降水柱（独立区域）
    p.push('<line x1="' + L + '" y1="' + rainBase + '" x2="' + (W - R) + '" y2="' + rainBase + '" stroke="#e5e7eb"/>');
    var maxRain = Math.max(1, Math.max.apply(null, days.map(function (d) { return d.dayRain; })));
    days.forEach(function (d, i) {
      if (d.dayRain > 0) {
        var bh = Math.max(3, d.dayRain / maxRain * (rainBase - rainTop));
        p.push('<rect x="' + (x(i) - 7).toFixed(1) + '" y="' + (rainBase - bh).toFixed(1) +
          '" width="14" height="' + bh.toFixed(1) + '" rx="2.5" fill="#93c5fd"/>');
        p.push('<text x="' + x(i).toFixed(1) + '" y="' + (rainBase - bh - 4).toFixed(1) +
          '" font-size="8.5" text-anchor="middle" fill="#60a5fa">' + d.dayRain.toFixed(1) + '</text>');
      }
    });
    p.push('<text x="' + (L - 7) + '" y="' + (rainBase + 3).toFixed(1) + '" font-size="8.5" text-anchor="end" fill="#9ca3af">mm</text>');

    days.forEach(function (d, i) {
      p.push('<text x="' + x(i).toFixed(1) + '" y="' + (H - 8) + '" font-size="10" text-anchor="middle">' +
        (i === 0 ? '今天' : d.dow.slice(1)) + '</text>');
    });
    p.push('<text x="' + (W - R) + '" y="' + (TP - 4) + '" font-size="9" fill="#9ca3af" text-anchor="end">温度 ℃ / 降水 mm</text>');
    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '">' + p.join('') + '</svg>';
  }

  /** 一周可行性环形图 */
  function donutSvg(result) {
    var f = T.feasibility(result);
    var S = 150, cx = S / 2, cy = S / 2, r = 56, thick = 17;
    var total = f.total || 1;
    var segs = [
      { n: f.ok, c: '#22c55e' },
      { n: f.warn, c: '#f59e0b' },
      { n: f.bad, c: '#ef4444' }
    ].filter(function (s) { return s.n > 0; });

    var p = ['<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="#f3f4f6" stroke-width="' + thick + '"/>'];
    var circ = 2 * Math.PI * r;
    var offset = 0;
    segs.forEach(function (s) {
      var len = s.n / total * circ;
      p.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + s.c +
        '" stroke-width="' + thick + '" stroke-dasharray="' + (len - 2).toFixed(1) + ' ' + (circ - len + 2).toFixed(1) +
        '" stroke-dashoffset="' + (-offset).toFixed(1) + '" stroke-linecap="round" transform="rotate(-90 ' + cx + ' ' + cy + ')"/>');
      offset += len;
    });
    p.push('<text x="' + cx + '" y="' + (cy - 2) + '" font-size="26" font-weight="700" text-anchor="middle" fill="#111827">' + f.ok + '/' + f.total + '</text>');
    p.push('<text x="' + cx + '" y="' + (cy + 16) + '" font-size="10.5" text-anchor="middle" fill="#6b7280">天可作业</text>');

    var svg = '<svg class="donut" width="' + S + '" height="' + S + '" viewBox="0 0 ' + S + ' ' + S + '">' + p.join('') + '</svg>';

    var html = '<div class="donut-wrap">' + svg + '<div class="donut-legend">' +
      '<div class="k"><i style="background:#22c55e"></i>可作业 <b>' + f.ok + '</b> 天</div>' +
      '<div class="k"><i style="background:#f59e0b"></i>需谨慎 <b>' + f.warn + '</b> 天</div>' +
      '<div class="k"><i style="background:#ef4444"></i>不宜 <b>' + f.bad + '</b> 天</div>' +
      '</div></div>';

    // 补充三个关键数字，避免卡片右侧留白
    var best = T.bestWindow(result);
    var bestH = 0;
    if (best) {
      bestH = Math.max.apply(null, best.spray.windows.map(function (w) { return w.hours; }));
    }
    html += '<div class="kpi-row">' +
      '<div class="kpi"><span>一周降水</span><b>' + result.weekRain + '<i>mm</i></b></div>' +
      '<div class="kpi"><span>最长窗口</span><b>' + (bestH || 0) + '<i>小时</i></b></div>' +
      '<div class="kpi"><span>最佳日</span><b>' + (best ? (new Date(best.date + 'T00:00:00').getMonth() + 1) + '/' +
        new Date(best.date + 'T00:00:00').getDate() : '—') + '<i></i></b></div>' +
      '</div>';
    return html;
  }

  /** 长势趋势（示意数据） */
  function growthSvg(plot) {
    var pts = T.growthTrend(plot, 8);
    var W = 620, H = 190, L = 40, R = 14, TP = 16, B = 30;
    var iw = W - L - R, ih = H - TP - B;
    var ymin = 0.30, ymax = 0.85;
    var x = function (i) { return L + i / (pts.length - 1) * iw; };
    var y = function (v) { return TP + ih - (v - ymin) / (ymax - ymin) * ih; };

    var p = [];
    [0.4, 0.5, 0.6, 0.7, 0.8].forEach(function (v) {
      p.push('<line x1="' + L + '" y1="' + y(v).toFixed(1) + '" x2="' + (W - R) + '" y2="' + y(v).toFixed(1) + '" stroke="#f1f5f9"/>');
      p.push('<text x="' + (L - 7) + '" y="' + (y(v) + 3.5).toFixed(1) + '" font-size="9.5" text-anchor="end">' + v.toFixed(1) + '</text>');
    });

    var d = 'M' + x(0).toFixed(1) + ',' + y(pts[0].value).toFixed(1);
    for (var i = 1; i < pts.length; i++) d += ' L' + x(i).toFixed(1) + ',' + y(pts[i].value).toFixed(1);
    var area = d + ' L' + x(pts.length - 1).toFixed(1) + ',' + (TP + ih) + ' L' + x(0).toFixed(1) + ',' + (TP + ih) + ' Z';
    p.push('<path d="' + area + '" fill="url(#growGrad)"/>');
    p.push('<path d="' + d + '" fill="none" stroke="#22c55e" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>');
    pts.forEach(function (pt, i) {
      p.push('<circle cx="' + x(i).toFixed(1) + '" cy="' + y(pt.value).toFixed(1) + '" r="3" fill="#fff" stroke="#22c55e" stroke-width="1.8"/>');
      p.push('<text x="' + x(i).toFixed(1) + '" y="' + (H - 10) + '" font-size="9" text-anchor="middle">' + pt.label + '</text>');
    });
    p.push('<text x="' + L + '" y="' + (H - 22) + '" font-size="9" fill="#9ca3af">长势指数</text>');

    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '">' +
      '<defs><linearGradient id="growGrad" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#10b981" stop-opacity=".3"/>' +
      '<stop offset="100%" stop-color="#10b981" stop-opacity=".02"/></linearGradient></defs>' +
      p.join('') + '</svg>';
  }

  function renderCharts() {
    var raw = state.raw, result = state.result, plot = activePlot();
    if (!raw || !result) return;

    // 逐小时风速（跟随选中的那天）
    var day = state.chartDay || result.days[0].date;
    var d = result.days.filter(function (x) { return x.date === day; })[0] || result.days[0];
    var hours = T.hoursOf(raw.hourly, d.date);
    var dt = new Date(d.date + 'T00:00:00');
    $('windTitle').textContent = '逐小时风速 · ' + (dt.getMonth() + 1) + '月' + dt.getDate() + '日 ' + d.dow;
    $('windSub').textContent = '虚线为 2.5 m/s 作业上限；' + d.spray.why;
    $('windChart').innerHTML = hours.length
      ? windChartSvg(hours, d.windMax)
      : '<div class="chart-note">该日无逐小时数据</div>';

    $('heatChart').innerHTML = heatChartSvg(raw, result);
    $('tempChart').innerHTML = tempChartSvg(result);
    $('donutChart').innerHTML = donutSvg(result);
    $('growthChart').innerHTML = growthSvg(plot);
  }

  /* =========================================================
     渲染：地块
     ========================================================= */
  function renderPlots() {
    var box = $('plotList');
    box.innerHTML = '';
    state.plots.forEach(function (p) {
      var d = document.createElement('div');

      // 行内确认删除（不用浏览器原生 confirm）
      if (state.pendingDelete === p.id) {
        d.className = 'plot confirming';
        d.innerHTML =
          '<div class="plot-body">' +
            '<div class="confirm-txt">删除「' + esc(p.name) + '」？</div>' +
            '<div class="confirm-acts">' +
              '<button class="mini-btn ghost" data-act="cancel">取消</button>' +
              '<button class="mini-btn danger" data-act="confirm">删除</button>' +
            '</div>' +
          '</div>';
        d.onclick = function (e) {
          var btn = e.target.closest ? e.target.closest('button[data-act]') : null;
          if (!btn) return;
          e.stopPropagation();
          if (btn.getAttribute('data-act') === 'confirm') doDelete(p);
          else { state.pendingDelete = null; renderPlots(); }
        };
        box.appendChild(d);
        return;
      }

      d.className = 'plot' + (p.id === state.activeId ? ' on' : '');
      d.innerHTML =
        '<div class="plot-main">' +
          '<span class="plot-dot"></span>' +
          '<span class="plot-name">' + esc(p.name) + '</span>' +
          '<span class="plot-area">' + p.area + ' 亩</span>' +
        '</div>' +
        '<div class="plot-meta">' + esc(p.place) +
          (p.city && p.city !== p.place ? ' · ' + esc(p.city) : '') +
          '<span class="plot-crop">' + CROP_NAME[p.crop] + '</span></div>' +
        '<span class="plot-acts">' +
          '<button class="ico-btn" data-act="edit" title="编辑">' +
            '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4l10-10-4-4L4 16v4z"/></svg>' +
          '</button>' +
          '<button class="ico-btn del" data-act="del" title="删除">' +
            '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>' +
          '</button>' +
        '</span>';

      d.onclick = function (e) {
        var btn = e.target.closest ? e.target.closest('button[data-act]') : null;
        if (btn) {
          e.stopPropagation();
          if (btn.getAttribute('data-act') === 'edit') openModal(p);
          else askDelete(p);
          return;
        }
        if (state.loading || p.id === state.activeId) return;
        state.activeId = p.id;
        state.chartDay = null;
        save();
        renderPlots();
        load();
      };
      box.appendChild(d);
    });
    $('plotCount').textContent = state.plots.length + ' 块';
  }

  function askDelete(p) {
    if (state.plots.length <= 1) { toast('至少保留一块地'); return; }
    state.pendingDelete = p.id;
    renderPlots();
  }

  function doDelete(p) {
    state.pendingDelete = null;
    state.plots = state.plots.filter(function (x) { return x.id !== p.id; });
    if (state.activeId === p.id) state.activeId = state.plots[0].id;
    save();
    renderPlots();
    load();
    toast('已删除「' + p.name + '」');
  }

  /* =========================================================
     渲染：Hero / 天 / 卡
     ========================================================= */
  /* 中文数字与月日写法，用于手册式排版 */
  var CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  function cnDay(n) {
    if (n <= 10) return CN_NUM[n];
    if (n < 20) return '十' + CN_NUM[n - 10];
    var t = Math.floor(n / 10), o = n % 10;
    return CN_NUM[t] + '十' + (o ? CN_NUM[o] : '');
  }
  function cnMonth(m) {
    if (m <= 10) return CN_NUM[m] + '月';
    if (m === 11) return '十一月';
    if (m === 12) return '十二月';
    return m + '月';
  }

  /* =========================================================
     最佳窗口卡（含倒计时 + 已打药标记）
     ========================================================= */
  var countdownTimer = null;

  /* ---- 集合预报：置信度评估 ----
     优先用真集合（50 成员）；取不到时退回多模型分歧（4 模型）。
     两者都会在界面上标明是哪种，不混淆。 */
  function ensembleEval() {
    if (!state.raw || !E) return null;
    if (state._ensCache && state._ensCache.key === state._ensKey) return state._ensCache.val;
    try {
      var best = E.assembleBest(state.raw.ensemble, state.raw.multiModel);
      if (!best || !best.data) return null;
      var data = best.data;
      var dates = Object.keys(E.groupByDate(data.precip));
      var evals = {};
      dates.forEach(function (d) {
        var ev = E.evaluateDay(data, d, null, 0.5, 2);
        if (ev) evals[d] = ev;
      });
      var val = {
        data: data, dates: dates, evals: evals,
        kind: best.kind, label: best.label, caveat: best.caveat
      };
      state._ensCache = { key: state._ensKey, val: val };
      return val;
    } catch (e) {
      return null;
    }
  }

  /** 置信度徽章 */
  function confBadge(level, prob) {
    return '<span class="conf-badge" style="background:' + level.color + '1a;color:' + level.color +
      ';border-color:' + level.color + '40">' +
      '<i style="background:' + level.color + '"></i>置信度 ' + level.label +
      '<b>' + Math.round(prob * 100) + '%</b></span>';
  }

  /** 逐小时支持率条：一眼看出窗口稳不稳 */
  function confStrip(strip, level) {
    var cells = strip.map(function (h) {
      var pct = Math.round(h.prob * 100);
      var op = 0.15 + h.prob * 0.85;
      var col = h.prob >= 0.7 ? '#16a34a' : h.prob >= 0.5 ? '#d97706' : '#dc2626';
      return '<i title="' + pad2(h.hour) + ':00  ' + pct + '% 成员支持" ' +
        'style="background:' + col + ';opacity:' + op.toFixed(2) + '"></i>';
    }).join('');
    return '<div class="conf-strip">' + cells + '</div>';
  }

  function renderHero(result) {
    var box = $('heroIn');
    var best = T.bestWindow(result);
    var now = new Date();
    var dow = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
    if ($('todayDate')) $('todayDate').textContent = cnMonth(now.getMonth() + 1) + cnDay(now.getDate()) + '日 ' + dow;

    clearInterval(countdownTimer);

    var ens = ensembleEval();

    if (!best) {
      if ($('windowSub')) $('windowSub').textContent = '未来七日';
      box.innerHTML =
        '<div class="window-label">未来七天</div>' +
        '<div class="window-date" style="color:#b91c1c">暂无合适窗口</div>' +
        '<div class="window-meta" style="margin-top:6px">' + esc(result.days[0].spray.why) + '</div>' +
        renderLimits(result) +
        renderSprayRow(null);
      return;
    }

    var w = best.spray.windows.slice().sort(function (a, b) { return b.hours - a.hours; })[0];
    var dt = new Date(best.date + 'T00:00:00');
    if ($('windowSub')) $('windowSub').textContent = best.dow;

    // 集合预报给出的置信度
    var ev = ens && ens.evals[best.date];
    var ensBest = ev && ev.best;

    // 置信度优先用集合结果；没有集合数据就明说
    var confHtml = '';
    if (ensBest) {
      var memberWord = ens.kind === 'ensemble' ? '集合成员' : '模型';
      confHtml =
        '<div class="conf-row">' +
          confBadge(ensBest.level, ensBest.weakest.prob) +
          '<span class="conf-src">' + ens.data.precip.count + ' 个' + memberWord + '中，' +
            Math.round(ensBest.weakest.prob * 100) + '% 支持最薄弱时段</span>' +
        '</div>' +
        confStrip(ensBest.strip, ensBest.level) +
        (ens.caveat
          ? '<div class="conf-caveat">' + esc(ens.caveat) + '</div>'
          : '<div class="conf-caveat ok">' + esc(ens.label) + '</div>');
    } else if (ens) {
      confHtml = '<div class="conf-row"><span class="conf-none">该日没有支持率过半的窗口</span></div>' +
        '<div class="conf-caveat' + (ens.caveat ? '' : ' ok') + '">' + esc(ens.caveat || ens.label) + '</div>';
    } else {
      confHtml = '<div class="conf-row"><span class="conf-none">未取到集合预报或多模型数据，暂无法评估置信度</span></div>';
    }

    box.innerHTML =
      '<div class="window-top">' +
        '<div>' +
          '<div class="window-label">推荐作业日</div>' +
          '<div class="window-date">' + cnMonth(dt.getMonth() + 1) + cnDay(dt.getDate()) + '日 · ' + best.dow + '</div>' +
          '<div class="window-time">' + pad2(w.start) + ':00 – ' + pad2(w.end) + ':00</div>' +
          '<div class="window-meta">连续 <b>' + w.hours + ' 小时</b> · 风速 <b>' + w.avgWind + ' m/s</b> · 气温 <b>' + w.avgTemp + '℃</b></div>' +
        '</div>' +
        '<span class="badge ok"><span class="bd"></span>可作业</span>' +
      '</div>' +
      confHtml +
      '<div class="countdown" id="countdownRow">' +
        '<span class="cd-l" id="cdLabel">—</span>' +
        '<span class="cd-time" id="cdTime">—</span>' +
      '</div>' +
      renderDelayCost(ens, best.date) +
      renderCloseCondition(ensBest) +
      renderSprayRow(best, w) +
      renderWhatIf(best, result);

    startCountdown(best, w);
    bindWhatIf(best, result);
  }

  /* ---- 推迟代价：窗口往后挪，风险怎么变 ---- */
  function renderDelayCost(ens, bestDate) {
    if (!ens) return '';
    var base = ens.evals[bestDate];
    if (!base || !base.best) return '';

    // 找出后面第一个明显更差的日子
    var later = ens.dates.filter(function (d) { return d > bestDate; }).slice(0, 4);
    var rows = [];
    later.forEach(function (d) {
      var ev = ens.evals[d];
      if (!ev) return;
      var risk, label;
      if (ev.best) {
        risk = 1 - ev.best.weakest.prob;
        label = '仍有窗口（' + pad2(ev.best.start) + ':00–' + pad2(ev.best.end) + ':00）';
      } else {
        risk = 1;
        label = '无窗口';
      }
      rows.push({ date: d, risk: risk, label: label, hasWin: !!ev.best, level: ev.best && ev.best.level });
    });

    if (!rows.length) return '';

    // 只显示风险显著上升的那一天
    var baseRisk = 1 - base.best.weakest.prob;
    var worse = rows.filter(function (r) { return r.risk > baseRisk + 0.15; })[0];
    if (!worse) {
      var last = rows[rows.length - 1];
      return '<div class="delay-row">推迟到 ' + fmtDate(last.date) + ' 风险 ' +
        Math.round(last.risk * 100) + '%，与推荐日（' + Math.round(baseRisk * 100) + '%）差别不大</div>';
    }

    var dt2 = new Date(worse.date + 'T00:00:00');
    return '<div class="delay-row warn">' +
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 8v5"/><circle cx="12" cy="17" r="1"/><path d="M10.3 3.9 2.6 17.4A2 2 0 0 0 4.3 20.4h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>' +
      '<span>若推迟到 <b>' + (dt2.getMonth() + 1) + '/' + dt2.getDate() + '</b>，作业风险从 <b>' +
        Math.round(baseRisk * 100) + '%</b> 升到 <b>' + Math.round(worse.risk * 100) + '%</b>' +
        (worse.hasWin ? '' : '（该日无可用窗口）') + '</span>' +
    '</div>';
  }

  /* ---- 窗口关闭条件 ---- */
  function renderCloseCondition(ensBest) {
    if (!ensBest || !ensBest.weakest) return '';
    var weak = ensBest.weakest;
    var pct = Math.round(weak.prob * 100);
    var nextThr = weak.prob >= 0.7 ? 70 : weak.prob >= 0.5 ? 50 : null;
    var cond = nextThr
      ? '若 ' + pad2(weak.hour) + ':00 的成员支持率跌到 ' + nextThr + '% 以下，窗口置信度会下降一档'
      : '当前已是最低置信档，窗口随时可能关闭';
    return '<div class="close-cond"><b>窗口关闭条件</b>' + cond +
      '<span class="cc-now">（该小时现为 ' + pct + '%，是窗口内最薄弱的一环）</span></div>';
  }

  /* ---- 反事实推演：如果换个假设，结论会怎样 ----
     设计要点：假设必须是"能真的改变结论"的那几种，否则点了没反应
     会显得功能是假的。这里从当前数据里实时算出每个假设的影响，
     并标注哪些会改变结论。 */
  var WHATIF_CASES = [
    { key: 'wind20', label: '风速要求收紧到 2.0 m/s', rule: { wind_max: 2.0 },
      why: '更保守的飘移控制' },
    { key: 'wind50', label: '风速放宽到 5.0 m/s', rule: { wind_max: 5.0 },
      why: '抢农时，接受一定飘移' },
    { key: 'temp2', label: '气温下限降到 2℃', rule: { temp_min: 2 },
      why: '早晚温度低也能打' },
    { key: 'rain0', label: '完全不能有雨（0 mm）', rule: { rain_hour_max: 0 },
      why: '要求绝对无雨' },
    { key: 'hours', label: '只看上午 6–12 时', rule: { hours: [6, 12] },
      why: '人手只够半天' }
  ];

  function renderWhatIf(best) {
    var ens = ensembleEval();
    // 先算出每个假设的影响，按钮上直接标注，避免用户点了没反应
    var impacts = {};
    if (ens && ens.evals[best.date] && ens.evals[best.date].best) {
      WHATIF_CASES.forEach(function (c) {
        impacts[c.key] = computeWhatIf(ens, best.date, c);
      });
    }

    var btns = WHATIF_CASES.map(function (c) {
      var im = impacts[c.key];
      var tip = im
        ? (im.flipped ? '会改变结论' : '结论不变') + '：' + im.newTxt
        : c.why;
      return '<button data-whatif="' + c.key + '" title="' + esc(tip) + '"' +
        (im && im.flipped ? ' class="flips"' : '') + '>' +
        c.label +
        (im && im.flipped ? '<i class="flip-dot"></i>' : '') +
      '</button>';
    }).join('');

    var flipCount = Object.keys(impacts).filter(function (k) { return impacts[k] && impacts[k].flipped; }).length;

    return '<div class="whatif">' +
      '<div class="whatif-t">' +
        '质疑一下这个窗口：<span>换个假设，重算给你看' +
          (flipCount ? '（带 <i class="flip-dot inline"></i> 的会改变结论）' : '') +
        '</span>' +
      '</div>' +
      '<div class="whatif-btns">' + btns +
        '<button data-whatif="reset" class="reset">恢复默认</button>' +
      '</div>' +
      '<div class="whatif-out" id="whatifOut"></div>' +
    '</div>';
  }

  /** 计算某个假设的影响（供按钮标注与实际点击共用） */
  function computeWhatIf(ens, date, c) {
    var base = E.DEFAULT_RULE;
    var rule = {};
    Object.keys(base).forEach(function (k) { rule[k] = base[k]; });
    Object.keys(c.rule).forEach(function (k) { rule[k] = c.rule[k]; });

    var ev2 = E.evaluateDay(ens.data, date, rule, 0.5, 2);
    var oldBest = ens.evals[date] && ens.evals[date].best;
    var newBest = ev2 && ev2.best;

    var oldTxt = oldBest
      ? pad2(oldBest.start) + ':00–' + pad2(oldBest.end) + ':00，' + oldBest.hours + ' 小时，置信「' + oldBest.level.label + '」'
      : '无窗口';
    var newTxt = newBest
      ? pad2(newBest.start) + ':00–' + pad2(newBest.end) + ':00，' + newBest.hours + ' 小时，置信「' + newBest.level.label + '」'
      : '无窗口';

    var flipped = (!oldBest && !!newBest) || (!!oldBest && !newBest) ||
                  (!oldBest && !newBest ? false :
                   (oldBest && newBest && oldBest.level.key !== newBest.level.key) ||
                   (oldBest && newBest && Math.abs(oldBest.hours - newBest.hours) >= 1));

    return { oldTxt: oldTxt, newTxt: newTxt, flipped: flipped, rule: rule };
  }

  function bindWhatIf(best, result) {
    var box = document.querySelector('.whatif');
    if (!box) return;
    Array.prototype.forEach.call(box.querySelectorAll('button[data-whatif]'), function (b) {
      b.onclick = function () {
        var key = b.getAttribute('data-whatif');
        Array.prototype.forEach.call(box.querySelectorAll('button'), function (x) {
          if (x.getAttribute('data-whatif') !== 'reset') x.classList.toggle('on', x === b);
        });
        if (key === 'reset') {
          $('whatifOut').innerHTML = '';
          $('whatifOut').classList.remove('on');
          Array.prototype.forEach.call(box.querySelectorAll('button'), function (x) {
            x.classList.remove('on');
          });
          return;
        }
        runWhatIf(key, best);
      };
    });
  }

  /** 真的重算一遍：改规则 → 重跑集合统计 → 对比窗口 */
  function runWhatIf(key, best) {
    var out = $('whatifOut');
    var ens = ensembleEval();
    if (!ens || !out) return;

    var c = WHATIF_CASES.filter(function (x) { return x.key === key; })[0];
    if (!c) return;

    var im = computeWhatIf(ens, best.date, c);
    var oldRisk = null, newRisk = null;
    var ev2 = E.evaluateDay(ens.data, best.date, im.rule, 0.5, 2);
    var ob = ens.evals[best.date] && ens.evals[best.date].best;
    var nb = ev2 && ev2.best;
    if (ob) oldRisk = 1 - ob.weakest.prob;
    if (nb) newRisk = 1 - nb.weakest.prob;

    out.innerHTML =
      '<div class="wf-line">' +
        '<div class="wf-row"><span>默认规则</span><b>' + im.oldTxt + '</b></div>' +
        '<div class="wf-row"><span>' + esc(c.label) + '</span><b class="' + (im.flipped ? 'flip' : '') + '">' + im.newTxt + '</b></div>' +
        (oldRisk !== null && newRisk !== null
          ? '<div class="wf-row"><span>最弱环节风险</span><b>' +
            Math.round(oldRisk * 100) + '% → ' + Math.round(newRisk * 100) + '%</b></div>'
          : '') +
        '<div class="wf-verdict ' + (im.flipped ? 'flip' : 'same') + '">' +
          (im.flipped
            ? '⚠ 结论改变 —— 这个假设对结论有实质影响，说明窗口对这个条件敏感'
            : '结论没变 —— 即使按这个假设，窗口依然成立，说明判断比较稳') +
        '</div>' +
      '</div>';
    out.classList.add('on');
  }

  /* ---- 倒计时：距窗口开始 / 结束还有多久 ---- */
  function startCountdown(best, w) {
    var targetStart = new Date(best.date + 'T' + pad2(w.start) + ':00:00');
    var targetEnd = new Date(best.date + 'T' + pad2(w.end) + ':00:00');

    function tick() {
      var elLabel = $('cdLabel'), elTime = $('cdTime');
      if (!elLabel || !elTime) { clearInterval(countdownTimer); return; }

      var now = new Date();
      var diff, label, urgent = false;

      if (now < targetStart) {
        diff = targetStart - now;
        label = '距窗口开始';
      } else if (now < targetEnd) {
        diff = targetEnd - now;
        label = '距窗口结束';
        urgent = diff < 60 * 60 * 1000;       // 不到 1 小时标红
      } else {
        elLabel.textContent = '本窗口已结束';
        elTime.textContent = '—';
        elTime.className = 'cd-time';
        clearInterval(countdownTimer);
        return;
      }

      var totalSec = Math.floor(diff / 1000);
      var d = Math.floor(totalSec / 86400);
      var hh = Math.floor((totalSec % 86400) / 3600);
      var mm = Math.floor((totalSec % 3600) / 60);
      var ss = totalSec % 60;

      elLabel.innerHTML = label + ' · 为 <b>' +
        cnMonth(targetStart.getMonth() + 1) + cnDay(targetStart.getDate()) + '日</b>';
      if (d > 0) {
        elTime.textContent = d + ' 天 ' + hh + ':' + pad2(mm) + ':' + pad2(ss);
      } else {
        elTime.textContent = pad2(hh) + ':' + pad2(mm) + ':' + pad2(ss);
      }
      elTime.className = 'cd-time' + (urgent ? ' urgent' : '');
    }

    tick();
    countdownTimer = setInterval(tick, 1000);
  }

  /* ---- 无窗口时：列出本周主要限制因素 ---- */
  function renderLimits(result) {
    var raw = state.raw;
    if (!raw || !raw.hourly) return '';
    var cnt = { cold: 0, wind: 0, hot: 0, rain: 0 };
    result.days.forEach(function (d) {
      T.hoursOf(raw.hourly, d.date).forEach(function (h) {
        if (h.hour < 6 || h.hour > 17) return;
        var v = T.hourVerdict(h);
        if (v !== 'ok') cnt[v]++;
        if (h.rain >= 0.1) cnt.rain++;
      });
    });
    var rows = [
      { k: 'cold', label: '气温过低', color: '#3b82f6' },
      { k: 'wind', label: '风速过大', color: '#f59e0b' },
      { k: 'hot', label: '气温过高', color: '#ef4444' },
      { k: 'rain', label: '降雨', color: '#6366f1' }
    ].filter(function (r) { return cnt[r.k] > 0; });

    if (!rows.length) return '';

    var totalH = result.days.length * 12;
    return '<div style="margin-top:12px;padding-top:10px;border-top:1px dashed #e5e7eb">' +
      '<div style="font-size:11px;color:#6b7280;margin-bottom:6px">本周作业时段受限原因（共 ' + totalH + ' 小时）</div>' +
      rows.map(function (r) {
        return '<div style="display:flex;align-items:center;gap:8px;font-size:12px;padding:2px 0">' +
          '<span style="width:6px;height:6px;border-radius:50%;background:' + r.color + ';flex:none"></span>' +
          '<span style="flex:1;color:#374151">' + r.label + '</span>' +
          '<span style="font-family:var(--mono);color:#111827;font-weight:600">' + cnt[r.k] + '</span>' +
          '<span style="font-size:11px;color:#9ca3af">小时</span>' +
        '</div>';
      }).join('') +
    '</div>';
  }

  /* ---- 已打药标记 ---- */
  function renderSprayRow(best, win) {
    var rec = getSprayRecord();
    if (rec) {
      var t = new Date(rec.at);
      return '<div class="spray-row">' +
        '<span class="spray-note">' +
          '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8.5 12.2l2.4 2.4 4.6-4.8"/></svg>' +
          '已标记打药 · ' + (t.getMonth() + 1) + '/' + t.getDate() + ' ' + pad2(t.getHours()) + ':' + pad2(t.getMinutes()) +
        '</span>' +
        '<button class="btn btn-sm btn-ghost" id="sprayUndoBtn">撤销</button>' +
      '</div>';
    }
    return '<div class="spray-row">' +
      '<button class="btn btn-sm" id="sprayDoneBtn">标记已打药</button>' +
      '<span class="spray-note">标记后自动监控未来 24 小时降雨</span>' +
    '</div>';
  }

  function bindSprayButtons() {
    var done = $('sprayDoneBtn');
    if (done) {
      done.onclick = function () {
        setSprayRecord(new Date().toISOString());
        toast('已标记打药，将监控未来 24 小时降雨');
        renderHero(state.result);
        renderAlerts(state.result);
        bindSprayButtons();
      };
    }
    var undo = $('sprayUndoBtn');
    if (undo) {
      undo.onclick = function () {
        setSprayRecord(null);
        toast('已撤销打药标记');
        renderHero(state.result);
        renderAlerts(state.result);
        bindSprayButtons();
      };
    }
  }

  /* =========================================================
     七日卡片
     ========================================================= */
  function renderDays(result) {
    var box = $('days');
    var best = T.bestWindow(result);
    var now = new Date();
    var todayStr = now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
    var sel = state.chartDay || (result.days[0] && result.days[0].date);
    var task = state.task || 'spray';
    box.innerHTML = '';

    result.days.forEach(function (d) {
      var dt = new Date(d.date + 'T00:00:00');
      var isBest = task === 'spray' && best && best.date === d.date;
      var item = d[task];

      var el = document.createElement('div');
      el.className = 'day'
        + (d.date === todayStr ? ' today' : '')
        + (isBest ? ' best' : '')
        + (d.date === sel ? ' sel' : '');
      el.title = item.why;

      // 打药额外显示具体可作业时段
      var detail = '';
      if (task === 'spray') {
        if (item.windows && item.windows.length) {
          var w = item.windows.slice().sort(function (a, b) { return b.hours - a.hours; })[0];
          detail = pad2(w.start) + ':00–' + pad2(w.end) + ':00';
        } else {
          detail = d.dayRain > 0 ? '雨 ' + d.dayRain.toFixed(1) + ' mm' : '无窗口';
        }
      } else if (task === 'irrigation') {
        // 灌溉按日雨量说明，比"无雨"更能解释为什么不宜
        detail = d.dayRain > 0
          ? '雨 ' + d.dayRain.toFixed(1) + ' mm'
          : (d.dayProb >= 50 ? '降雨概率 ' + d.dayProb + '%' : '无雨');
      } else {
        detail = d.dayRain > 0 ? '雨 ' + d.dayRain.toFixed(1) + ' mm'
               : (d.dayProb >= 50 ? '概率 ' + d.dayProb + '%' : '无雨');
      }

      el.innerHTML =
        (isBest ? '<div class="day-badge">最佳</div>' : '') +
        '<div class="day-dow">' + (d.date === todayStr ? '今天' : d.dow) + '</div>' +
        '<div class="day-date">' + (dt.getMonth() + 1) + '/' + dt.getDate() + '</div>' +
        '<div class="day-icon">' + iconOf(d.code, 18) + '</div>' +
        '<div class="day-weather">' + (d.weather || '') + '</div>' +
        '<div class="day-temp"><b>' + d.tmax + '°</b> / ' + d.tmin + '°</div>' +
        '<div class="day-rain' + (d.dayRain > 0 ? '' : ' none') + '">' + detail + '</div>' +
        '<div class="day-state" style="background:' + stateBg(item.status) + ';color:' + stateFg(item.status) + '">' +
          verdictOf(task, item.status) + '</div>';

      el.onclick = function () {
        state.chartDay = d.date;
        renderDays(state.result);
        renderCharts();
      };
      box.appendChild(el);
    });

    // 若七天结论完全相同，加一句整体说明，避免用户以为卡片没生效
    var statuses = result.days.map(function (d) { return (d[task] || {}).status; });
    var allSame = statuses.every(function (s) { return s === statuses[0]; });
    var note = $('daysNote');
    if (note) {
      if (allSame && statuses[0]) {
        var txt = verdictOf(task, statuses[0]);
        note.textContent = '未来七天判断一致：均为「' + txt + '」';
        note.style.display = '';
      } else {
        note.style.display = 'none';
      }
    }
  }

  function stateBg(s) { return s === 'ok' ? 'rgba(240,253,244,.95)' : s === 'warn' ? 'rgba(255,251,235,.95)' : 'rgba(254,242,242,.95)'; }
  function stateFg(s) { return s === 'ok' ? '#15803d' : s === 'warn' ? '#b45309' : '#b91c1c'; }

  /** 三种作业各自的结论文案 */
  var VERDICT_TEXT = {
    spray:      { ok: '可作业', warn: '谨慎',     bad: '不宜' },
    irrigation: { ok: '无需灌溉', warn: '建议灌溉', bad: '不宜灌溉' },
    harvest:    { ok: '适宜晾晒', warn: '勉强可晒', bad: '不宜晾晒' }
  };
  function verdictOf(task, status) {
    return (VERDICT_TEXT[task] || VERDICT_TEXT.spray)[status] || status;
  }

  /** 作业类型切换 */
  function bindTaskSwitch() {
    var box = $('taskSwitch');
    if (!box || box.__bound) return;
    box.__bound = true;
    Array.prototype.forEach.call(box.querySelectorAll('.task-btn'), function (b) {
      b.onclick = function () {
        var t = b.getAttribute('data-task');
        if (state.task === t) return;
        state.task = t;
        Array.prototype.forEach.call(box.querySelectorAll('.task-btn'), function (x) {
          x.classList.toggle('on', x === b);
        });
        if (state.result) renderDays(state.result);
      };
    });
  }

  /* =========================================================
     今日判读（列表）
     -------------------------------------------------------------
     打药一项分两段说清楚：
       · 今日剩余时段能不能干（避免早上打开就显示"不宜"的误导）
       · 最近一个能干活的日子是哪天
     ========================================================= */
  function renderCards(result) {
    var box = $('cards');
    var t = result.days[0];

    // 今日剩余时段
    var remain = null;
    if (state.raw && state.raw.hourly) {
      try {
        remain = T.todayRemaining(state.raw.hourly, state.raw.daily, new Date(), 'spray');
      } catch (e) { remain = null; }
    }

    var best = T.bestWindow(result);

    // 打药：优先说今日剩余时段，再补最近好日子
    var sprayStatus = t.spray.status, sprayWhy = t.spray.why;
    if (remain && !remain.ended) {
      sprayStatus = remain.status;
      sprayWhy = remain.why;
      if (best && best.date !== remain.date) {
        var bd = new Date(best.date + 'T00:00:00');
        sprayWhy += '；最近好日子 ' + (bd.getMonth() + 1) + '/' + bd.getDate() + '（' + best.dow + '）';
      }
    }

    var items = [
      { key: 'spray', name: '打药', status: sprayStatus, why: sprayWhy },
      { key: 'irrigation', name: '灌溉', status: t.irrigation.status, why: t.irrigation.why },
      { key: 'harvest', name: '晾晒', status: t.harvest.status, why: t.harvest.why }
    ];

    box.innerHTML = items.map(function (it) {
      var cls = it.status === 'ok' ? 'ok' : it.status === 'warn' ? 'warn' : 'bad';
      return '<div class="kpi-item">' +
        '<span class="kpi-dot ' + cls + '"></span>' +
        '<div class="kpi-main">' +
          '<div class="kpi-t">' + it.name +
            '<span class="badge ' + cls + '">' + verdictOf(it.key, it.status) + '</span>' +
          '</div>' +
          '<div class="kpi-d">' + esc(it.why) + '</div>' +
        '</div>' +
      '</div>';
    }).join('');
    $('weekRainNote').textContent = '一周累计雨量 ' + result.weekRain + ' mm';
  }

  /* =========================================================
     告警栈：临雨 / 打药后避雨 / 霜冻
     ========================================================= */
  function alertCard(kind, icon, title, desc, extraHtml, actions) {
    return '<div class="alert ' + kind + '">' +
      '<span class="a-icon">' + icon + '</span>' +
      '<div class="a-body">' +
        '<div class="a-title">' + title + '</div>' +
        (desc ? '<div class="a-desc">' + desc + '</div>' : '') +
      '</div>' +
      (extraHtml || '') +
      (actions ? '<div class="a-act">' + actions + '</div>' : '') +
    '</div>';
  }

  function renderAlerts(result) {
    var box = $('alerts');
    if (!box) return;
    var out = [];
    var plot = activePlot();
    var d0 = result && result.days && result.days[0];

    /* ---- 1. 临雨提醒（分钟级）---- */
    var m = state.raw && state.raw.minutely;
    if (m && m.points && m.points.length) {
      var willRain = (m.maxPrecip > 0) || (m.startsInMin !== null && m.startsInMin !== undefined);
      if (willRain) {
        var nowRaining = (m.points[0] && m.points[0].precip > 0);
        var head;
        if (nowRaining) {
          head = '正在下雨';
        } else if (m.startsInMin !== null && m.startsInMin !== undefined) {
          var mmn = Math.max(5, Math.round(m.startsInMin / 5) * 5);
          head = mmn <= 5 ? '约 5 分钟内开始下雨'
               : mmn <= 90 ? '约 ' + mmn + ' 分钟后开始下雨'
               : '约 ' + Math.round(mmn / 60) + ' 小时后开始下雨';
        } else {
          head = '未来 2 小时可能有降水';
        }
        var total2h = m.points.reduce(function (a, p) { return a + p.precip; }, 0);
        var desc = total2h > 0 ? '未来 2 小时累计约 ' + (Math.round(total2h * 10) / 10) + ' mm' : '';
        if (d0 && d0.spray.status === 'ok') {
          desc += (desc ? ' · ' : '') + '今日原本可以作业，建议暂缓打药';
        }
        var peak = Math.max.apply(null, m.points.map(function (p) { return p.precip; })) || 1;
        var bars = m.points.map(function (p) {
          return '<i style="height:' + Math.max(1, Math.round(p.precip / peak * 16)) + 'px"></i>';
        }).join('');
        out.push(alertCard(
          nowRaining ? 'danger' : 'info',
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M7 15h9.4a3.1 3.1 0 0 0 .3-6.2 4.5 4.5 0 0 0-8.6-.6A2.85 2.85 0 0 0 7 15z"/>' +
            '<path d="M8.6 17.6v2.2M12 17.6v2.2M15.4 17.6v2.2"/></svg>',
          head,
          desc,
          '<span class="spark">' + bars + '</span>'
        ));
      }
    }

    /* ---- 2. 打药后避雨警戒 ---- */
    var rec = getSprayRecord();
    if (rec && state.raw && state.raw.daily) {
      var at = new Date(rec.at);
      // 先看分钟级降水（更灵敏），再看逐时（覆盖更远）
      var soon = minutelyRainAhead(state.raw);
      var after = rainWithin24h(at, state.raw);

      if (soon) {
        out.push(alertCard(
          'danger',
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 8v5"/><circle cx="12" cy="17" r="1"/><path d="M10.3 3.9 2.6 17.4A2 2 0 0 0 4.3 20.4h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
          '刚打过药，马上要下雨',
          '你在 ' + (at.getMonth() + 1) + '/' + at.getDate() + ' ' + pad2(at.getHours()) + ':' + pad2(at.getMinutes()) +
          ' 标记了打药，' + soon.text + ' —— 药液可能被冲刷，建议雨后检查叶面着药情况，必要时补喷。'
        ));
      } else if (after) {
        var hrs = Math.max(1, Math.round((after.time - at) / 3600000));
        out.push(alertCard(
          'danger',
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 8v5"/><circle cx="12" cy="17" r="1"/><path d="M10.3 3.9 2.6 17.4A2 2 0 0 0 4.3 20.4h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
          '打药后 24 小时内有降雨风险',
          '你在 ' + (at.getMonth() + 1) + '/' + at.getDate() + ' ' + pad2(at.getHours()) + ':' + pad2(at.getMinutes()) +
          ' 标记了打药，约 ' + hrs + ' 小时后有 ' + after.mm.toFixed(1) + ' mm 降水 —— 药效可能被冲刷，建议雨后检查，必要时补喷。'
        ));
      } else {
        out.push(alertCard(
          'success',
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8.5 12.2l2.4 2.4 4.6-4.8"/></svg>',
          '已打药 · 24 小时内无降雨',
          '未来 24 小时无有效降水，药效可正常发挥。'
        ));
      }
    }

    /* ---- 3. 霜冻 / 低温预警（冬小麦越冬期）---- */
    if (plot && plot.crop === 'wheat' && result && result.days) {
      var month = new Date().getMonth() + 1;
      var winterSeason = (month >= 11 || month <= 3);
      if (winterSeason) {
        var cold = null;
        result.days.forEach(function (d) {
          if (d.tmin < 0 && (!cold || d.tmin < cold.tmin)) cold = d;
        });
        if (cold) {
          var severe = cold.tmin <= -5;
          out.push(alertCard(
            severe ? 'danger' : 'warn',
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
              '<path d="M12 3v18M5 7l14 10M19 7L5 17"/></svg>',
            (severe ? '强低温预警' : '低温提醒') + ' · 最低 ' + cold.tmin + '℃',
            (new Date(cold.date + 'T00:00:00').getMonth() + 1) + '/' + new Date(cold.date + 'T00:00:00').getDate() +
            '（' + cold.dow + '）最低气温 ' + cold.tmin + '℃。' +
            (severe ? '冬小麦有冻害风险，建议检查覆盖与镇压力度，视墒情考虑灌越冬水。'
                    : '冬小麦越冬期，注意观察苗情与土壤墒情。')
          ));
        }
      }
    }

    box.innerHTML = out.join('');
  }

  /* ---- 打药记录读写 ---- */
  var SPRAY_KEY = 'tianzhi.spray.v1';

  function getSprayRecord() {
    try {
      var s = localStorage.getItem(SPRAY_KEY);
      if (!s) return null;
      var o = JSON.parse(s);
      if (!o || !o.byPlot) return null;
      return o.byPlot[state.activeId] || null;
    } catch (e) { return null; }
  }

  function setSprayRecord(iso) {
    try {
      var s = localStorage.getItem(SPRAY_KEY);
      var o = (s && JSON.parse(s)) || { byPlot: {} };
      if (!o.byPlot) o.byPlot = {};
      if (iso) o.byPlot[state.activeId] = { at: iso };
      else delete o.byPlot[state.activeId];
      localStorage.setItem(SPRAY_KEY, JSON.stringify(o));
    } catch (e) { /* 忽略 */ }
  }

  /** 从打药时刻起 24 小时内，最早的一场有效降水 */
  function rainWithin24h(fromTime, raw) {
    if (!raw || !raw.hourly || !raw.hourly.time) return null;
    var limit = fromTime.getTime() + 24 * 3600 * 1000;
    for (var i = 0; i < raw.hourly.time.length; i++) {
      var t = new Date(raw.hourly.time[i]);
      var ts = t.getTime();
      if (ts < fromTime.getTime() || ts > limit) continue;
      var mm = raw.hourly.precipitation[i] || 0;
      // 阈值 0.3mm：足以打湿叶面，影响药效附着
      if (mm >= 0.3) return { time: t, mm: mm };
    }
    return null;
  }

  /** 分钟级降水：未来 2 小时是否会下（比逐时灵敏，专门用于"刚打完药"场景） */
  function minutelyRainAhead(raw) {
    var m = raw && raw.minutely;
    if (!m || !m.points || !m.points.length) return null;
    var total = m.points.reduce(function (a, p) { return a + p.precip; }, 0);
    if (m.startInMin === 0) return null;
    if (!(m.maxPrecip > 0)) return null;
    var mins = (m.startsInMin === null || m.startsInMin === undefined) ? 0 : m.startsInMin;
    var head = mins <= 10 ? '10 分钟内就会下雨'
             : mins <= 60 ? '约 ' + Math.round(mins / 5) * 5 + ' 分钟后会下雨'
             : '约 ' + Math.round(mins / 30) / 2 + ' 小时后会下雨';
    return { text: head + '（未来 2 小时约 ' + (Math.round(total * 10) / 10) + ' mm）', mins: mins };
  }

  /** 取数失败时的界面
   *  设计考虑：这是别人第一次打开最可能遇到的状态（没网 / 断了 / 接口临时故障），
   *  所以不能只写"失败"，要说清楚三件事：
   *    1. 发生了什么
   *    2. 为什么（最可能的原因）
   *    3. 怎么办（具体操作）
   */
  function renderError(msg) {
    var isFile = location.protocol === 'file:';
    $('heroIn').innerHTML =
      '<div class="window-label">暂时取不到天气数据</div>' +
      '<div class="window-date" style="color:#b45309;font-size:20px">需要联网才能使用</div>' +
      '<div class="window-meta" style="margin-top:8px">' + esc(msg || '') + '</div>' +
      '<div class="err-help">' +
        '<div class="err-help-t">可以这样处理：</div>' +
        '<ol>' +
          '<li>检查设备是否连上网络（打开任意网站试试）</li>' +
          '<li>如果用了代理 / VPN / 校园网，尝试关掉后重试</li>' +
          '<li>点击下面的「重新获取」按钮</li>' +
        '</ol>' +
        (isFile
          ? '<div class="err-note">当前是直接双击打开（file://）模式。' +
            '若长期无法联网，可双击 start.bat 用本地服务打开，同样需要网络。</div>'
          : '') +
      '</div>' +
      '<div style="margin-top:12px"><button class="btn btn-sm btn-primary" id="retryBtn">重新获取</button></div>';

    $('days').innerHTML = '<div style="grid-column:1/-1;color:var(--text-3);font-size:12px;padding:20px 6px;text-align:center">' +
      '联网后可查看未来七天作业窗口</div>';
    $('cards').innerHTML = '<div style="color:var(--text-3);font-size:12px;padding:16px 0">等待数据</div>';
    if ($('alerts')) $('alerts').innerHTML = '';
    ['windChart', 'heatChart', 'tempChart', 'donutChart', 'growthChart'].forEach(function (k) {
      var el = $(k);
      if (el) el.innerHTML = '<div class="chart-note">暂无数据</div>';
    });
    var note = $('daysNote');
    if (note) note.style.display = 'none';

    var rb = $('retryBtn');
    if (rb) rb.onclick = function () { load(); };
  }

  /* =========================================================
     加载
     ========================================================= */
  function load() {
    var plot = activePlot();
    if (!plot) return;
    state.loading = true;
    state.result = null;

    $('tbTitle').textContent = plot.name + ' · ' + CROP_NAME[plot.crop];
    $('tbSub').textContent = plot.place + (plot.city && plot.city !== plot.place ? ' · ' + plot.city : '') + ' · 华北平原';
    setStatus('busy', '正在获取天气…');
    $('refreshBtn').classList.add('spin');

    fetchWeather(plot.lat, plot.lon).then(function (w) {
      if (!w.hourly || !w.daily) throw new Error('返回数据不完整');
      state.raw = w;
      state._ensKey = plot.lat.toFixed(3) + ',' + plot.lon.toFixed(3) + ',' + (w.hourly.time[0] || '');
      state._ensCache = null;
      var result = T.evaluateWeather(w.hourly, w.daily);
      state.result = result;
      if (!state.chartDay || !result.days.some(function (d) { return d.date === state.chartDay; })) {
        state.chartDay = result.days[0].date;
      }

      $('tbSub').textContent = plot.place +
        (plot.city && plot.city !== plot.place ? ' · ' + plot.city : '') +
        ' · ' + plot.lat.toFixed(2) + '°N ' + plot.lon.toFixed(2) + '°E';
      renderHero(result);
      renderDays(result);
      renderCards(result);
      renderCharts();
      renderAlerts(result);
      bindSprayButtons();

      // 报头数据源
      if ($('heroMeta')) {
        $('heroMeta').textContent = plot.name + ' · ' + CROP_NAME[plot.crop] + ' · ' + plot.area + ' 亩';
      }

      var n = new Date();
      setStatus('', '实时数据 · ' + pad2(n.getHours()) + ':' + pad2(n.getMinutes()) + ' 更新');
    }).catch(function (err) {
      var msg = (err && err.name === 'AbortError')
        ? '请求超时（15 秒）。可能是网络较慢，或被防火墙拦截。'
        : (err && err.message ? err.message : '未知错误');
      renderError(msg);
      setStatus('err', '获取失败');
    }).then(function () {
      state.loading = false;
      $('refreshBtn').classList.remove('spin');
    });
  }

  /* =========================================================
     地点搜索（本地字典 + 在线兜底）
     ========================================================= */
  function searchLocal(q) {
    var exact = [], part = [];
    Object.keys(CITIES).forEach(function (k) {
      if (k === q) exact.push(k);
      else if (k.indexOf(q) >= 0 || q.indexOf(k) >= 0) part.push(k);
    });
    return exact.concat(part).map(function (k) {
      return { name: k, admin: '常用地点', lat: CITIES[k][0], lon: CITIES[k][1] };
    });
  }

  function geoQuery(name) {
    var u = new URL('https://geocoding-api.open-meteo.com/v1/search');
    u.searchParams.set('name', name);
    u.searchParams.set('count', '20');
    u.searchParams.set('language', 'zh');
    u.searchParams.set('format', 'json');
    return fetchWithTimeout(u.toString(), 12000).then(function (j) {
      return (j.results || []).filter(function (x) { return x.country === '中国'; });
    }).catch(function () { return []; });
  }

  function searchOnline(q) {
    var tries = [q];
    if (!/[市县区旗盟州]$/.test(q)) tries.push(q + '市', q + '县');
    return Promise.all(tries.map(geoQuery)).then(function (groups) {
      var seen = {}, list = [];
      groups.forEach(function (g) {
        g.forEach(function (x) {
          var key = Math.round(x.latitude * 50) + ',' + Math.round(x.longitude * 50);
          if (seen[key]) return;
          seen[key] = 1;
          list.push({
            name: x.name,
            admin: [(x.admin1 || ''), (x.admin2 || '')].filter(Boolean).join(' · ') || x.country,
            lat: x.latitude, lon: x.longitude,
            exact: x.name === q || x.name === q + '市' || x.name === q + '县'
          });
        });
      });
      var north = ['河北', '山东', '河南', '山西', '北京', '天津', '内蒙'];
      list.sort(function (a, b) {
        var sa = (a.exact ? 2 : 0) + (north.some(function (p) { return a.admin.indexOf(p) >= 0; }) ? 1 : 0);
        var sb = (b.exact ? 2 : 0) + (north.some(function (p) { return b.admin.indexOf(p) >= 0; }) ? 1 : 0);
        return sb - sa;
      });
      return list.slice(0, 8);
    });
  }

  /* =========================================================
     地图：高德 JS API（官方授权调用）
     -------------------------------------------------------------
     - 通过官方 SDK 渲染，合规、无坐标偏移
     - 点击取点后做 GCJ-02 → WGS-84 转换，再与本地县界数据比对
       （不转换会偏差约 500 米，县界附近会反查错县）
     - SDK 加载失败时降级为本地行政区划示意地图
     ========================================================= */
  var GEO = window.HEBEI_GEO || null;
  var AMAP_CFG = (window.TIANZHI_CONFIG || {});

  var MAP = {
    instance: null,      // AMap.Map 实例
    marker: null,        // 选中点标记
    plotMarkers: [],     // 已有地块标记
    layer: 'road',       // road | sat
    ready: false,
    failed: false
  };

  /* ---------- 点是否在多边形内（射线法） ---------- */
  function inRing(lon, lat, ring) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1];
      var xj = ring[j][0], yj = ring[j][1];
      if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  /**
   * 在县界数据里查找坐标所属行政区
   * @param {number} lon WGS-84 经度
   * @param {number} lat WGS-84 纬度
   */
  function locateCounty(lon, lat) {
    if (!GEO || !GEO.counties) return null;
    for (var i = 0; i < GEO.counties.length; i++) {
      var c = GEO.counties[i];
      for (var k = 0; k < c.rings.length; k++) {
        if (inRing(lon, lat, c.rings[k])) {
          return { name: c.name, city: c.city, adcode: c.adcode };
        }
      }
    }
    // 不在任何县内 → 找最近县，超过 0.25°（约 27km）就不认
    var best = null, bestD = Infinity;
    for (var m = 0; m < GEO.counties.length; m++) {
      var cc = GEO.counties[m];
      for (var r = 0; r < cc.rings.length; r++) {
        var ring = cc.rings[r];
        for (var q = 0; q < ring.length; q += 2) {
          var p = ring[q];
          var d = Math.pow(p[0] - lon, 2) + Math.pow(p[1] - lat, 2);
          if (d < bestD) { bestD = d; best = cc; }
        }
      }
    }
    if (best && bestD < 0.06) return { name: best.name, city: best.city, adcode: best.adcode, near: true };
    return null;
  }

  /** 展示用地名：市辖区用地级市名，其余用原名 */
  function displayName(loc) {
    if (!loc) return null;
    if (/区$/.test(loc.name) && loc.city) return loc.city;
    return loc.name;
  }

  /** 带行政区的完整描述，避免"保定市（保定市）" */
  function describePlace(loc) {
    if (!loc) return '';
    var n = displayName(loc);
    if (!loc.city || loc.city === n) return n;
    return n + '（' + loc.city + '）';
  }

  /** WGS-84 坐标反查地名（供启动迁移、无地图时使用） */
  function placeLabel(lon, lat) {
    var c = locateCounty(lon, lat);
    return c ? displayName(c) : null;
  }

  /* ---------- 加载高德 SDK ---------- */
  var amapLoading = null;
  function loadAMap() {
    if (amapLoading) return amapLoading;
    amapLoading = new Promise(function (resolve, reject) {
      if (!AMAP_CFG.amapKey) { reject(new Error('未配置高德 key')); return; }
      if (window.AMap) { resolve(window.AMap); return; }

      // 安全密钥必须在地图脚本之前设置
      if (AMAP_CFG.amapSecurityJsCode) {
        window._AMapSecurityConfig = { securityJsCode: AMAP_CFG.amapSecurityJsCode };
      }

      var s = document.createElement('script');
      s.src = 'https://webapi.amap.com/maps?v=' + (AMAP_CFG.amapVersion || '2.0') +
              '&key=' + encodeURIComponent(AMAP_CFG.amapKey);
      s.async = true;
      var timer = setTimeout(function () { reject(new Error('高德 SDK 加载超时')); }, 12000);

      s.onload = function () {
        clearTimeout(timer);
        if (window.AMap) resolve(window.AMap);
        else reject(new Error('SDK 已加载但 AMap 未就绪'));
      };
      s.onerror = function () {
        clearTimeout(timer);
        reject(new Error('高德 SDK 加载失败（网络或 key 问题）'));
      };
      document.head.appendChild(s);
    });
    return amapLoading;
  }

  /* ---------- 初始化地图 ---------- */
  function initAMap(centerWgs, zoom) {
    return loadAMap().then(function (AMap) {
      if (MAP.instance) { return MAP.instance; }

      var c = T.wgs84ToGcj(centerWgs[0], centerWgs[1]);

      // 视野限制在河北及周边，避免拖到省外看到无关内容
      var b1 = T.wgs84ToGcj(112.8, 42.9);   // 西北角
      var b2 = T.wgs84ToGcj(120.2, 35.6);   // 东南角
      var bounds = new AMap.Bounds(
        new AMap.LngLat(b1[0], b1[1]),
        new AMap.LngLat(b2[0], b2[1])
      );

      MAP.instance = new AMap.Map('amapBox', {
        zoom: zoom || 8,
        zooms: [6, 16],          // 允许放大到街道级，也防止缩得过小
        center: c,
        limitBounds: bounds,     // 拖拽/缩放不超出河北范围
        viewMode: '2D',
        resizeEnable: true,
        mapStyle: 'amap://styles/whitesmoke'   // 素净风格，与页面配色协调
      });

      MAP.instance.on('complete', function () {
        MAP.ready = true;
        updateMapMode();
      });

      // 供自动化测试访问（也是调试入口）
      window.__tzMap = MAP.instance;

      // 叠加河北省/市边界（本地 GeoJSON，离线可用）
      setTimeout(function () { addBoundaries(); }, 100);

      MAP.instance.on('click', function (e) {
        if (!e || !e.lnglat) return;
        onMapPick(e.lnglat.getLng(), e.lnglat.getLat());
      });

      // 初始放一个空的地块标记集合
      MAP.plotMarkers = [];
      return MAP.instance;
    });
  }

  /* 供自动化测试与调试使用：程序化取点（模拟点击地图中心） */
  window.__tzPickCenter = function () {
    if (!MAP.instance) return false;
    var c = MAP.instance.getCenter();
    onMapPick(c.getLng(), c.getLat());
    return true;
  };

  /* ---------- 点击取点：GCJ-02 → WGS-84 ---------- */
  function onMapPick(gLng, gLat) {
    // 高德给的是 GCJ-02，转回 WGS-84 才能和县界/天气数据对齐
    var w = T.gcjToWgs84(gLng, gLat);
    var lon = Math.round(w[0] * 10000) / 10000;
    var lat = Math.round(w[1] * 10000) / 10000;

    var loc = locateCounty(lon, lat);

    form.lat = lat;
    form.lon = lon;
    form.place = loc ? displayName(loc) : '未知位置';
    form.city = loc ? loc.city : '';
    form.source = 'map';

    $('mapCoord').textContent = lat.toFixed(4) + '°N, ' + lon.toFixed(4) + '°E';
    $('mapRead').innerHTML = loc
      ? '已选点：<span class="loc">' + describePlace(loc) + '</span>'
      : '已选点（省外或海上）';
    $('fHint').className = 'hint';
    $('fHint').textContent = loc
      ? '已选地点：' + describePlace(loc)
      : '已选地点：' + lat.toFixed(2) + '°N, ' + lon.toFixed(2) + '°E';

    drawMarker(lat, lon);
    drawPlotMarkers();
  }

  /* ---------- 地图标记 ---------- */
  function drawMarker(lat, lon) {
    if (!MAP.instance || !window.AMap) return;
    var AMap = window.AMap;
    var gc = T.wgs84ToGcj(lon, lat);
    if (MAP.marker) {
      MAP.marker.setPosition(gc);
    } else {
      MAP.marker = new AMap.Marker({
        position: gc,
        anchor: 'center',
        content: '<div style="width:14px;height:14px;border-radius:50%;background:#3d6247;border:3px solid #fff;box-shadow:0 0 0 4px rgba(61,98,71,.18),0 2px 6px rgba(0,0,0,.25)"></div>',
        zIndex: 200
      });
      MAP.instance.add(MAP.marker);
    }
  }

  function drawPlotMarkers() {
    if (!MAP.instance || !window.AMap) return;
    var AMap = window.AMap;
    MAP.plotMarkers.forEach(function (m) { MAP.instance.remove(m); });
    MAP.plotMarkers = [];
    state.plots.forEach(function (p) {
      if (form.editing && p.id === form.editing.id) return;
      var gc = T.wgs84ToGcj(p.lon, p.lat);
      var mk = new AMap.Marker({
        position: gc,
        anchor: 'center',
        title: p.name,
        content: '<div style="width:9px;height:9px;border-radius:50%;background:#22c55e;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.2)"></div>',
        zIndex: 150
      });
      MAP.instance.add(mk);
      MAP.plotMarkers.push(mk);
    });
  }

  /* ---------- 行政边界叠加 ----------
     高德瓦片只画道路和地名，不画县界，而农业定位最需要县界。
     尝试两条路：
       1) 官方 DistrictSearch（需要 key 开通"行政区查询"服务）
       2) 本地 GeoJSON 县界（已内置，离线可用，最稳）
     本地数据是 WGS-84，必须转成 GCJ-02 才能和高德地图对齐。
  */
  var boundaryAdded = false;

  function addBoundaries() {
    if (boundaryAdded || !MAP.instance) return;
    boundaryAdded = true;

    // 先用本地数据（快、稳、离线可用）
    try {
      addLocalBoundaries();
    } catch (e) {
      console.warn('[田智] 本地边界绘制失败：', e.message);
    }
  }

  /** 用内置 GeoJSON 画省界 + 市界（WGS-84 → GCJ-02） */
  function addLocalBoundaries() {
    if (!GEO || !MAP.instance) return false;
    var AMap = window.AMap;
    var lines = 0;

    function drawRings(rings, color, weight, opacity) {
      rings.forEach(function (ring) {
        if (!ring || ring.length < 3) return;
        var path = [];
        // 稠密点下逐点转换成本高，先抽稀再转换
        var step = ring.length > 220 ? Math.ceil(ring.length / 220) : 1;
        for (var i = 0; i < ring.length; i += step) {
          var g = T.wgs84ToGcj(ring[i][0], ring[i][1]);
          path.push(new AMap.LngLat(g[0], g[1]));
        }
        // 闭合
        if (path.length > 2) {
          var g0 = T.wgs84ToGcj(ring[0][0], ring[0][1]);
          path.push(new AMap.LngLat(g0[0], g0[1]));
        }
        MAP.instance.add(new AMap.Polyline({
          path: path,
          strokeColor: color,
          strokeWeight: weight,
          strokeOpacity: opacity,
          lineJoin: 'round',
          zIndex: 90,
          bubble: true
        }));
        lines++;
      });
    }

    drawRings(GEO.province, '#3d6247', 2.2, 0.85);
    GEO.cities.forEach(function (ct) {
      drawRings(ct.rings, '#7a8f6a', 1.1, 0.7);
    });

    // 县界在 zoom>=9 时再叠加，避免过密
    MAP.instance.on('zoomend', function () {
      var z = MAP.instance.getZoom();
      if (z >= 9 && !MAP._countyLines) {
        MAP._countyLines = [];
        GEO.counties.forEach(function (c) {
          c.rings.forEach(function (ring) {
            if (ring.length < 3) return;
            var step = ring.length > 120 ? Math.ceil(ring.length / 120) : 1;
            var path = [];
            for (var i = 0; i < ring.length; i += step) {
              var g = T.wgs84ToGcj(ring[i][0], ring[i][1]);
              path.push(new AMap.LngLat(g[0], g[1]));
            }
            var pl = new AMap.Polyline({
              path: path,
              strokeColor: '#94a3b8',
              strokeWeight: 0.9,
              strokeOpacity: 0.55,
              zIndex: 80,
              bubble: true
            });
            MAP.instance.add(pl);
            MAP._countyLines.push(pl);
          });
        });
      } else if (z < 9 && MAP._countyLines) {
        MAP.instance.remove(MAP._countyLines);
        MAP._countyLines = null;
      }
    });

    return lines > 0;
  }

  /* ---------- 图层切换 ---------- */
  function setMapLayer(kind) {
    MAP.layer = kind;
    $('layerRoad').className = 'layer-btn' + (kind === 'road' ? ' on' : '');
    $('layerSat').className = 'layer-btn' + (kind === 'sat' ? ' on' : '');
    if (!MAP.instance) return;
    // 高德 2.0：先清图层再添加
    try {
      MAP.instance.setMapStyle(kind === 'sat' ? 'amap://styles/normal' : 'amap://styles/whitesmoke');
      if (kind === 'sat') {
        if (!MAP._satLayer) MAP._satLayer = new window.AMap.TileLayer.Satellite();
        MAP.instance.add(MAP._satLayer);
      } else if (MAP._satLayer) {
        MAP.instance.remove(MAP._satLayer);
      }
    } catch (e) { /* 忽略图层切换异常 */ }
  }

  function updateMapMode() {
    var el = $('mapMode');
    if (!el) return;
    if (MAP.failed) el.textContent = '示意地图（高德加载失败）';
    else if (MAP.ready) el.textContent = '高德地图 · 河北';
    else el.textContent = '地图加载中…';
  }

  /* ---------- 降级：本地行政区划示意 ---------- */
  function renderFallbackMap(sel) {
    var stage = $('mapStage');
    if (!stage) return;
    var w = stage.clientWidth || 400, h = stage.clientHeight || 330;

    // 河北范围
    var B = { lon0: 113.3, lon1: 119.9, lat0: 42.7, lat1: 36.0 };
    function px(lon) { return (lon - B.lon0) / (B.lon1 - B.lon0) * w; }
    function py(lat) { return (B.lat0 - lat) / (B.lat0 - B.lat1) * h; }

    var p = ['<rect width="' + w + '" height="' + h + '" fill="#eef2e4"/>'];
    if (GEO) {
      GEO.province.forEach(function (ring) {
        var d = ring.map(function (pt, i) {
          return (i ? 'L' : 'M') + px(pt[0]).toFixed(1) + ',' + py(pt[1]).toFixed(1);
        }).join(' ') + ' Z';
        p.push('<path d="' + d + '" fill="#e3eccc" stroke="#94a3b8" stroke-width="1.2"/>');
      });
      GEO.cities.forEach(function (ct) {
        ct.rings.forEach(function (ring) {
          var d = ring.map(function (pt, i) {
            return (i ? 'L' : 'M') + px(pt[0]).toFixed(1) + ',' + py(pt[1]).toFixed(1);
          }).join(' ') + ' Z';
          p.push('<path d="' + d + '" fill="none" stroke="#b6c79a" stroke-width="1"/>');
        });
      });
    } else {
      p.push('<text x="' + (w / 2) + '" y="' + (h / 2) + '" text-anchor="middle" font-size="12" fill="#6b7280">无地图数据</text>');
    }
    if (sel) {
      p.push('<circle cx="' + px(sel.lon).toFixed(1) + '" cy="' + py(sel.lat).toFixed(1) + '" r="6.5" fill="#3d6247" stroke="#fff" stroke-width="2.5"/>');
    }
    $('amapBox').innerHTML =
      '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" style="cursor:crosshair" id="fallbackSvg">' + p.join('') + '</svg>';

    var svg = $('fallbackSvg');
    svg.onclick = function (e) {
      var rect = svg.getBoundingClientRect();
      var x = (e.clientX - rect.left) / rect.width * w;
      var y = (e.clientY - rect.top) / rect.height * h;
      var lon = Math.round((B.lon0 + x / w * (B.lon1 - B.lon0)) * 10000) / 10000;
      var lat = Math.round((B.lat0 - y / h * (B.lat0 - B.lat1)) * 10000) / 10000;
      var loc = locateCounty(lon, lat);
      form.lat = lat; form.lon = lon;
      form.place = loc ? displayName(loc) : '未知位置';
      form.city = loc ? loc.city : '';
      form.source = 'map';
      $('mapCoord').textContent = lat.toFixed(4) + '°N, ' + lon.toFixed(4) + '°E';
      $('mapRead').innerHTML = loc
        ? '已选点：<span class="loc">' + describePlace(loc) + '</span>'
        : '已选点（省外或海上）';
      $('fHint').className = 'hint';
      $('fHint').textContent = loc ? '已选地点：' + describePlace(loc) : '已选地点：' + lat.toFixed(2) + '°N, ' + lon.toFixed(2) + '°E';
      renderFallbackMap({ lat: lat, lon: lon });
    };
  }

  /* ---------- 统一入口 ---------- */
  function renderMap(sel) {
    if (MAP.failed) { renderFallbackMap(sel); return; }

    var center = sel ? [sel.lon, sel.lat] : [116.30, 39.05];
    initAMap(center, sel ? 10 : 8).then(function () {
      updateMapMode();
      if (sel) {
        drawMarker(sel.lat, sel.lon);
        // 视野移到该点；zoom 8 既能看清县域范围又不至于太空
        MAP.instance.setCenter(T.wgs84ToGcj(sel.lon, sel.lat));
        var z = MAP.instance.getZoom();
        if (z < 8 || z > 12) MAP.instance.setZoom(8);
      }
      // 选点落在地图范围外时，把中心拉回合法区域
      if (MAP.instance.getCenter) {
        var cc = MAP.instance.getCenter();
        if (cc.getLng() < 112 || cc.getLng() > 121 || cc.getLat() < 35 || cc.getLat() > 43) {
          MAP.instance.setCenter(T.wgs84ToGcj(116.30, 39.05));
        }
      }
      drawPlotMarkers();
      // 容器尺寸变化后通知地图重绘
      setTimeout(function () { if (MAP.instance) MAP.instance.resize(); }, 60);
    }).catch(function (err) {
      console.warn('[田智] 高德地图不可用，已降级：', err.message);
      MAP.failed = true;
      updateMapMode();
      renderFallbackMap(sel);
    });
  }

  function bindMapStage() {
    if (bindMapStage._bound) return;
    bindMapStage._bound = true;

    $('layerRoad').onclick = function () { setMapLayer('road'); };
    $('layerSat').onclick = function () { setMapLayer('sat'); };

    $('mapToggle').onclick = function () {
      var panel = $('mapPanel');
      var open = panel.style.display !== 'none';
      panel.style.display = open ? 'none' : 'block';
      $('mapToggleTxt').textContent = open ? '展开' : '收起';
      if (!open) {
        // 展开后等布局完成再初始化/重绘地图
        setTimeout(function () {
          renderMap(pickSel());
          if (MAP.instance) MAP.instance.resize();
        }, 60);
      }
    };

    // 预加载 SDK：打开弹窗时就后台开始拉取，
    // 这样用户点"展开地图"时基本已经就绪（避免首屏多等 1-2 秒）
    loadAMap().catch(function (err) {
      MAP.failed = true;
      console.warn('[田智] 高德 SDK 预加载失败：', err.message);
    });
  }

  function pickSel() {
    return form.lat ? { lat: form.lat, lon: form.lon } : null;
  }

  /**
   * 把高德地图视野移到指定 WGS-84 坐标
   * （入参为 WGS-84，内部自动转 GCJ-02）
   */
  function mapCenterOn(lon, lat, zoom) {
    if (!MAP.instance || !T || !T.wgs84ToGcj) return;
    try {
      var gc = T.wgs84ToGcj(lon, lat);
      MAP.instance.setCenter(gc);
      if (zoom) MAP.instance.setZoom(zoom);
    } catch (e) { /* 地图未就绪时忽略 */ }
  }

  /* =========================================================
     地块弹窗
     ========================================================= */
  var form = { lat: 0, lon: 0, place: '', results: [] };

  /* 预设城市按钮已移除：农户通常只在一小块地方耕种，
     摆一排城市快捷按钮既不常用，也和"用我的位置"抢视觉重点。
     现在地点入口只有三个：搜索框、地图点选、用我的位置。 */
  function buildPresets() {
    var box = $('presetChips');
    if (box) box.remove();
  }

  /** 选中一个地点后统一更新：表单状态 + 地图 + 提示 */
  function setFormPlace(name, lon, lat, admin, source) {
    form.place = name;
    form.lon = lon;
    form.lat = lat;
    form.source = source || 'search';

    var loc = locateCounty(lon, lat);
    var desc;
    if (loc) {
      // 一律以坐标所在行政区为准，避免"名字和坐标对不上"
      desc = describePlace(loc);
      form.place = displayName(loc);
    } else {
      desc = name + (admin ? '（' + admin + '）' : '');
    }
    form.city = loc ? loc.city : '';

    $('fHint').className = 'hint';
    $('fHint').textContent = '已选地点：' + desc;
    $('mapCoord').textContent = lat.toFixed(2) + '°N, ' + lon.toFixed(2) + '°E';
    $('mapRead').innerHTML = '已选点：<span class="loc">' + desc + '</span>';
    $('fResults').innerHTML = '';
  }

  function openModal(plot) {
    state.editing = plot || null;
    $('modalTitle').textContent = plot ? '编辑地块' : '新增地块';
    $('fName').value = plot ? plot.name : '';
    $('fArea').value = plot ? plot.area : 10;
    $('fCrop').value = plot ? plot.crop : 'wheat';
    $('fLoc').value = '';
    $('fResults').innerHTML = '';

    var base = plot || activePlot();
    form = { lat: base.lat, lon: base.lon, place: base.place, results: [] };

    // 老的错误数据（地名是"地图选点"）用坐标反查修正
    var resolved = (base.place && base.place !== '地图选点')
      ? base.place
      : (placeLabel(base.lon, base.lat) || base.place || '未命名');

    setFormPlace(resolved, base.lon, base.lat, '', 'init');
    if (!plot) {
      $('fHint').textContent = '已选地点：' + $('fHint').textContent.replace('已选地点：', '') + '（默认沿用当前地块，可修改）';
    }

    // 地图默认收起，保证"保存"按钮在一屏内可见
    $('mapPanel').style.display = 'none';
    $('mapToggleTxt').textContent = '展开';

    bindMapStage();
    mapCenterOn(base.lon, base.lat, plot ? 9 : 8);
    $('plotMask').classList.add('on');
    setTimeout(function () { $('fName').focus(); }, 60);
  }

  function closeModal() {
    $('plotMask').classList.remove('on');
    state.editing = null;
  }

  function showFormResults(list) {
    form.results = list;
    var box = $('fResults');
    if (!list.length) {
      box.innerHTML = '<div class="result-list"><div class="result-item" style="color:#6b7280;cursor:default">没找到，试试加“市”或“县”，或用地图选点</div></div>';
      return;
    }
    box.innerHTML = '<div class="result-list">' + list.map(function (r, i) {
      return '<div class="result-item" data-i="' + i + '"><b>' + esc(r.name) + '</b><span>' + esc(r.admin) + '</span></div>';
    }).join('') + '</div>';
    Array.prototype.forEach.call(box.querySelectorAll('.result-item'), function (el) {
      var i = parseInt(el.getAttribute('data-i'), 10);
      if (isNaN(i)) return;
      el.onclick = function () {
        var r = list[i];
        setFormPlace(r.name, r.lon, r.lat, r.admin, 'search');
        mapCenterOn(r.lon, r.lat, 9);
        renderMap({ lat: r.lat, lon: r.lon });
      };
    });
  }

  function formSearch() {
    var q = $('fLoc').value.trim();
    if (!q) { toast('先输入一个地名'); return; }
    var local = searchLocal(q);
    if (local.length) { showFormResults(local); return; }
    $('fHint').textContent = '正在检索“' + q + '”…';
    searchOnline(q).then(function (list) { showFormResults(list); });
  }

  function formGeo() {
    if (isFile) {
      toast('「用我的位置」需要先用 start.bat 启动本地服务');
      return;
    }
    if (!navigator.geolocation) { toast('当前浏览器不支持定位'); return; }
    $('fGeoBtn').disabled = true;
    $('fHint').textContent = '正在获取你的位置…';
    navigator.geolocation.getCurrentPosition(function (pos) {
      var lat = pos.coords.latitude, lon = pos.coords.longitude;
      var url = 'https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=' + lat +
                '&longitude=' + lon + '&localityLanguage=zh';
      fetchWithTimeout(url, 10000).then(function (j) {
        var nm = j.city || j.locality || j.principalSubdivision || '我的位置';
        setFormPlace(nm, lon, lat, '', 'geo');
        $('fHint').textContent = '已定位到：' + $('fHint').textContent.replace('已选地点：', '');
        mapCenterOn(lon, lat, 10);
        renderMap({ lat: lat, lon: lon });
      }).catch(function () {
        var nm = placeLabel(lon, lat) || '我的位置';
        setFormPlace(nm, lon, lat, '', 'geo');
        mapCenterOn(lon, lat, 10);
        renderMap({ lat: lat, lon: lon });
      }).then(function () { $('fGeoBtn').disabled = false; });
    }, function (err) {
      $('fGeoBtn').disabled = false;
      var m = { 1: '你拒绝了定位授权', 2: '暂时拿不到位置', 3: '定位超时' };
      $('fHint').textContent = m[err.code] || '定位失败';
    }, { timeout: 12000, maximumAge: 60000 });
  }

  function formSave() {
    var name = $('fName').value.trim();
    var area = parseFloat($('fArea').value);
    var crop = $('fCrop').value;
    if (!name) { toast('给地块起个名字'); $('fName').focus(); return; }
    if (!area || area <= 0) { toast('面积要大于 0'); $('fArea').focus(); return; }
    if (!form.place) { toast('先选一个地点'); return; }

    // 保存前用坐标再校正一次地名，杜绝"名字和坐标对不上"
    var loc = locateCounty(form.lon, form.lat);
    var finalPlace = loc ? displayName(loc) : form.place;
    var finalCity = loc ? loc.city : '';

    if (state.editing) {
      var p = state.plots.filter(function (x) { return x.id === state.editing.id; })[0];
      p.name = name; p.area = area; p.crop = crop;
      p.place = finalPlace; p.city = finalCity;
      p.lat = form.lat; p.lon = form.lon;
      state.activeId = p.id;
      toast('已保存「' + name + '」');
    } else {
      var np = {
        id: 'p' + Date.now(),
        name: name, area: area, crop: crop,
        place: finalPlace, city: finalCity,
        lat: form.lat, lon: form.lon
      };
      state.plots.push(np);
      state.activeId = np.id;
      toast('已新增「' + name + '」');
    }
    state.chartDay = null;
    save();
    renderPlots();
    closeModal();
    load();
  }

  /* =========================================================
     问答
     ========================================================= */
  function appendMsg(role, text) {
    var log = $('qaLog');
    var d = document.createElement('div');
    d.className = 'msg ' + role;
    var who = document.createElement('div');
    who.className = 'who';
    who.textContent = (role === 'me') ? '我' : '田智';
    var body = document.createElement('div');
    body.className = 'body';
    body.textContent = text;
    d.appendChild(who); d.appendChild(body);
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d;
  }

  function appendTyping() {
    var log = $('qaLog');
    var d = document.createElement('div');
    d.className = 'msg bot typing-wrap';
    d.innerHTML = '<div class="who">田智</div><div class="typing"><i></i><i></i><i></i></div>';
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d;
  }

  var LLM = window.TianZhiLLM;
  var aiOn = LLM ? LLM.isEnabled() : false;

  function renderAiToggle() {
    var t = $('aiToggle'), tag = $('aiTag');
    t.textContent = aiOn ? '开' : '关';
    t.className = 'ai-toggle' + (aiOn ? '' : ' off');
    tag.className = 'ai-tag' + (aiOn ? '' : ' off');
    tag.textContent = aiOn ? 'AI 增强' : '纯规则引擎';
  }

  /**
   * 问答主流程
   *   1. 规则引擎先判断意图（命中就用引擎答案，数字绝对可靠）
   *   2. 规则看不懂 → 交给大模型做意图分类（它只输出类别，不产出内容）
   *   3. 得到意图后仍由规则引擎产出答案
   *   4. 若开启 AI 增强 → 大模型只做口语化改写，且必须通过数字一致性校验
   *   5. 任何一步失败都静默回退到模板答案
   */
  function ask(text) {
    var input = $('qaInput');
    var q = (text !== undefined ? text : input.value).trim();
    if (!q) return;
    appendMsg('me', q);
    input.value = '';

    if (!state.result) { appendMsg('bot', '天气数据还没加载好，稍等一下再问。'); return; }

    var plot = activePlot();
    var result = state.result;
    var capabilities = '哪天几点适合打药、要不要浇水、能不能晾晒、这几天什么天气';

    // --- 第一步：规则层意图 ---
    var intent = T.ruleIntent(q);
    var typing = null;

    if (intent) {
      respondWith(intent, q, result, plot, capabilities);
      return;
    }

    // --- 第二步：规则看不懂，交给大模型分类 ---
    if (aiOn && LLM && LLM.isEnabled()) {
      typing = appendTyping();
      LLM.classify(q).then(function (k) {
        if (typing) typing.remove();
        respondWith(k, q, result, plot, capabilities);
      }).catch(function () {
        if (typing) typing.remove();
        appendMsg('bot', T.answerQuestion(q, result, plot)); // 兜底模板
      });
      return;
    }

    // 未开启 AI：走模板
    respondWith(null, q, result, plot, capabilities);
  }

  function respondWith(intent, q, result, plot, capabilities) {
    // 超出范围
    if (intent === 'out') {
      if (aiOn && LLM && LLM.isEnabled()) {
        var tp = appendTyping();
        LLM.refuse(q, capabilities).then(function (txt) {
          tp.remove();
          appendMsg('bot', txt);
        }).catch(function () {
          tp.remove();
          appendMsg('bot', T.answerQuestion(q, result, plot));
        });
        return;
      }
      appendMsg('bot', T.answerQuestion(q, result, plot));
      return;
    }

    // 没有意图（规则和大模型都没识别）→ 模板兜底
    if (!intent || !T.INTENT_QUERY[intent]) {
      appendMsg('bot', T.answerQuestion(q, result, plot));
      return;
    }

    // 关键：答案由规则引擎产出，数字全部来自实时数据
    var template = T.answerByIntent(intent, result, plot);

    if (!aiOn || !LLM || !LLM.isEnabled()) {
      appendMsg('bot', template);
      return;
    }

    // AI 只做改写，且必须通过数字校验
    var ty = appendTyping();
    LLM.refine(template, {
      place: plot.name + '（' + plot.place + '）',
      crop: CROP_NAME[plot.crop]
    }).then(function (nice) {
      ty.remove();
      appendMsg('bot', nice);
    }).catch(function (err) {
      ty.remove();
      // 校验失败或被拒时，明确告知并回退模板
      if (err && /数字不一致/.test(err.message || '')) {
        appendMsg('bot', template);
        if (err.extra && err.extra.length) {
          console.warn('[田智] 大模型改写出现新数字，已拦截:', err.extra);
        }
      } else {
        appendMsg('bot', template);
      }
    });
  }

  /* =========================================================
     事件
     ========================================================= */
  $('addPlotBtn').onclick = function () { openModal(null); };
  $('modalClose').onclick = closeModal;
  $('modalCancel').onclick = closeModal;
  $('modalSave').onclick = formSave;
  /* 点遮罩空白处关闭弹窗
     -------------------------------------------------------------
     注意：不能简单用 click 判断。用户拖拽地图时，鼠标按下在地图上、
     松开可能落在遮罩上，浏览器仍会派发一个 click 到遮罩，
     导致"拖一下地图弹窗就消失了"。
     所以要求 mousedown 和 mouseup 都落在遮罩本身才关闭。
  */
  var maskDownOnSelf = false;
  $('plotMask').addEventListener('mousedown', function (e) {
    maskDownOnSelf = (e.target === $('plotMask'));
  });
  $('plotMask').addEventListener('mouseup', function (e) {
    if (maskDownOnSelf && e.target === $('plotMask')) closeModal();
    maskDownOnSelf = false;
  });
  // 触摸设备同理
  $('plotMask').addEventListener('touchstart', function (e) {
    maskDownOnSelf = (e.target === $('plotMask'));
  }, { passive: true });
  $('plotMask').addEventListener('touchend', function (e) {
    if (maskDownOnSelf && e.target === $('plotMask')) closeModal();
    maskDownOnSelf = false;
  });
  $('fSearchBtn').onclick = formSearch;
  $('fLoc').addEventListener('keydown', function (e) { if (e.key === 'Enter') formSearch(); });
  $('fGeoBtn').onclick = formGeo;

  $('refreshBtn').onclick = function () { if (!state.loading) load(); };
  $('qaSend').onclick = function () { ask(); };
  $('qaInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') ask(); });
  Array.prototype.forEach.call(document.querySelectorAll('.chip-btn'), function (b) {
    b.onclick = function () { ask(b.getAttribute('data-q')); };
  });
  $('aiToggle').onclick = function () {
    if (!LLM || !LLM.hasKey()) { toast('未配置大模型 key，当前为纯规则模式'); return; }
    aiOn = !aiOn;
    LLM.setEnabled(aiOn);
    renderAiToggle();
    toast(aiOn ? '已开启 AI 增强（数字仍来自规则引擎）' : '已切换为纯规则引擎模式');
  };

  /* =========================================================
     启动
     ========================================================= */
  if (!loadStore()) {
    state.plots = DEFAULT_PLOTS.slice();
    state.activeId = state.plots[0].id;
    save();
  }

  // 数据迁移：修正历史遗留的错误地名（例如早先版本把地名存成了"地图选点"）
  (function migrate() {
    var changed = false;
    state.plots.forEach(function (p) {
      if (!p.place || p.place === '地图选点' || p.place === '我的位置' || p.place === '未知位置') {
        var loc = locateCounty(p.lon, p.lat);
        if (loc) { p.place = displayName(loc); p.city = loc.city; changed = true; }
      } else if (!p.city) {
        var loc2 = locateCounty(p.lon, p.lat);
        if (loc2) { p.city = loc2.city; changed = true; }
      }
    });
    if (changed) save();
  })();

  /* =========================================================
     手机端抽屉（地块列表）
     -------------------------------------------------------------
     手机上侧栏太占宽度，改成从左侧滑出的抽屉。
     交互要点：
       · 点汉堡打开，点遮罩或按 Esc 关闭
       · 选中地块后自动关闭（用户接下来要看的是内容）
       · 抽屉打开时锁住背景滚动，避免滑动穿透
     ========================================================= */
  function bindDrawer() {
    var mask = $('drawerMask');
    var side = $('sidebar');
    var btn = $('menuBtn');
    if (!mask || !side || !btn) return;

    function open() {
      side.classList.add('open');
      mask.classList.add('on');
      document.body.style.overflow = 'hidden';
    }
    function close() {
      side.classList.remove('open');
      mask.classList.remove('on');
      document.body.style.overflow = '';
    }
    function isOpen() { return side.classList.contains('open'); }

    btn.onclick = function (e) {
      e.stopPropagation();
      if (isOpen()) close(); else open();
    };
    mask.onclick = close;

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isOpen()) close();
    });

    // 选中地块后自动收起
    side.addEventListener('click', function (e) {
      var p = e.target.closest ? e.target.closest('.plot') : null;
      if (p && isOpen()) setTimeout(close, 120);
    });

    // 转回宽屏时清掉抽屉状态，避免卡在半开
    window.addEventListener('resize', function () {
      if (window.innerWidth > 640 && isOpen()) close();
    });
  }

  save();
  bindDrawer();       // 手机端侧栏抽屉
  buildPresets();     // 预设城市按钮已移除，这里只清理旧 DOM
  bindTaskSwitch();   // 未来七天：打药 / 灌溉 / 晾晒 切换
  bindMapStage();     // 提前绑定并预加载高德 SDK
  renderAiToggle();
  appendMsg('bot', '你好。可以问我哪天适合打药、要不要浇水、这几天什么天气。\n数字都从实时气象数据算出来，不是我编的。');
  renderPlots();
  load();

})();
