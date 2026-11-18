(function () {
  'use strict';

  var T = window.TianZhi;
  if (!T) {
    document.body.innerHTML = '<div style="padding:40px;font-family:sans-serif">缺少 logic.js，请确认它与 index.html 在同一个目录。</div>';
    return;
  }

  // 内容层：面向用户的全部文字、知识口径、资料来源与作品说明（content.js）
  // 缺失时只是不渲染新增模块，不影响天气与规则引擎，避免单点故障拖垮整页。
  var CONTENT = window.TianZhiContent || null;

  // 集合预报层（可选）：取不到时为 undefined，界面自动退回确定性窗口
  var E = window.TianZhiEnsemble || null;

  // 作业标准库：河北省 / 市级公开文件的阈值来源（standards.js）
  var STD = window.TianZhiStandards || null;

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
              : (k === 'rain' || k === 'storm') ? '#3B7CA3'
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

  /* 图表宽度按容器实测：
     固定 620px 在手机上塞不进 336px 的卡片，只能横向滚动，
     滚到右边就被容器"切"掉——用户看到的就是截断。
     这里按容器实时取宽度，字号保持绝对像素，图就不会被裁也不需要滑。 */
  function chartW(el, fallback) {
    var w = 0;
    try { w = el && el.clientWidth ? el.clientWidth : 0; } catch (e) { w = 0; }
    if (!w) w = fallback || 620;
    return Math.max(300, Math.min(820, Math.round(w)));
  }

  /** 逐小时风速折线 + 阈值线 + 可作业时段底色 + 降雨概率条 */
  function windChartSvg(hours, maxWind, width) {
    var W = width || 620, H = 238, L = 38, R = 12, TP = 18, B = 30;
    var iw = W - L - R, ih = H - TP - B;

    var realMax = 0;
    hours.forEach(function (h) { if (h.wind > realMax) realMax = h.wind; });
    var seed = Math.max(realMax, Number(maxWind) || 0, RULES.spray.wind_max);
    var ymax = Math.max(4, Math.ceil(seed + 1));
    if (ymax % 2) ymax += 1;

    /* X 轴固定 0–24：晚上 10 点打开时今天只剩 2 小时数据，
       如果按数据范围铺开，整张图会缩成一条竖线，看起来像坏了。
       固定一整天，缺数据的地方就留白——那本来就是"已经过去"。 */
    var x = function (h) { return L + (h / 24) * iw; };
    var y = function (v) { return TP + ih - (v / ymax) * ih; };

    var p = [];
    // 可作业时段底色（9–16），与规则一致，不再写死
    var bandFrom = RULES.spray.hours[0], bandTo = RULES.spray.hours[1];
    p.push('<rect x="' + x(bandFrom).toFixed(1) + '" y="' + TP + '" width="' +
      (x(bandTo) - x(bandFrom)).toFixed(1) + '" height="' + ih +
      '" fill="rgba(14,107,74,.09)" rx="3"/>');

    // 降雨概率：底部细条，超过 50% 变红。比再加一条折线更不抢视线。
    hours.forEach(function (h) {
      if (h.prob === null || h.prob === undefined) return;
      var bh = (Math.min(100, Math.max(0, h.prob)) / 100) * ih * 0.16;
      if (bh < 1) return;
      p.push('<rect x="' + (x(h.hour) + 1.5).toFixed(1) + '" y="' + (TP + ih - bh).toFixed(1) +
        '" width="' + Math.max(2.5, iw / 24 - 3).toFixed(1) + '" height="' + bh.toFixed(1) +
        '" fill="' + (h.prob >= RULES.spray.prob_block ? 'rgba(190,74,60,.32)' : 'rgba(47,111,159,.20)') +
        '" rx="1.5"/>');
    });

    // 横向网格
    for (var g = 0; g <= ymax; g += 2) {
      p.push('<line x1="' + L + '" y1="' + y(g).toFixed(1) + '" x2="' + (W - R) + '" y2="' + y(g).toFixed(1) +
        '" stroke="#eef1ea" stroke-width="1"/>');
      p.push('<text x="' + (L - 6) + '" y="' + (y(g) + 3.5).toFixed(1) + '" font-size="9" text-anchor="end" fill="#9aa196">' + g + '</text>');
    }

    // 面积 + 折线（只有一个点时只画点，不画一条零长度的线）
    if (hours.length > 1) {
      var area = 'M' + x(hours[0].hour).toFixed(1) + ',' + y(hours[0].wind).toFixed(1);
      var line = area;
      for (var i2 = 1; i2 < hours.length; i2++) {
        area += ' L' + x(hours[i2].hour).toFixed(1) + ',' + y(hours[i2].wind).toFixed(1);
        line += ' L' + x(hours[i2].hour).toFixed(1) + ',' + y(hours[i2].wind).toFixed(1);
      }
      area += ' L' + x(hours[hours.length - 1].hour).toFixed(1) + ',' + (TP + ih) +
        ' L' + x(hours[0].hour).toFixed(1) + ',' + (TP + ih) + ' Z';
      p.push('<path d="' + area + '" fill="url(#windGrad)"/>');
      p.push('<path d="' + line + '" fill="none" stroke="#0E6B4A" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>');
    }

    // 阈值线
    var ty = y(RULES.spray.wind_max).toFixed(1);
    p.push('<line x1="' + L + '" y1="' + ty + '" x2="' + (W - R) + '" y2="' + ty +
      '" stroke="#BE4A3C" stroke-width="1.2" stroke-dasharray="4 4" opacity=".85"/>');
    // 加白色描边做底，标签压在虚线/曲线上也读得清
    p.push('<text x="' + (L + 5) + '" y="' + (+ty - 6).toFixed(1) +
      '" font-size="9" fill="#BE4A3C" stroke="#fff" stroke-width="3" paint-order="stroke" stroke-linejoin="round">上限 ' +
      RULES.spray.wind_max + '</text>');

    // 数据点
    hours.forEach(function (h) {
      var ok = h.wind <= RULES.spray.wind_max;
      p.push('<circle cx="' + x(h.hour).toFixed(1) + '" cy="' + y(h.wind).toFixed(1) + '" r="2.4" fill="' +
        (ok ? '#0E6B4A' : '#BE4A3C') + '" stroke="#fff" stroke-width="1"/>');
    });

    // 横轴：0/6/12/18/24，固定刻度，避免"只有 23 时"的图看起来没画完
    [0, 6, 12, 18, 24].forEach(function (h, i3) {
      var a = i3 === 0 ? 'start' : (i3 === 4 ? 'end' : 'middle');
      p.push('<text x="' + x(h).toFixed(1) + '" y="' + (H - 10) + '" font-size="9" text-anchor="' + a + '" fill="#9aa196">' +
        (h === 24 ? '24 时' : h + ' 时') + '</text>');
    });
    p.push('<text x="' + L + '" y="' + (TP - 5) + '" font-size="9" fill="#9aa196">m/s</text>');

    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '">' +
      '<defs><linearGradient id="windGrad" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#0E6B4A" stop-opacity=".22"/>' +
      '<stop offset="100%" stop-color="#0E6B4A" stop-opacity=".02"/></linearGradient></defs>' +
      p.join('') + '</svg>';
  }

  /* ===== 依据层补充图（v5.1）：露点差 / 气温带 / 风向飘移 / 降雨与需水 =====
     全部沿用 windChartSvg 的骨架：固定 0–24 轴、阈值虚线带白描边标签、
     点色随达标状态变化，保证四张新图与旧图是同一套语言。 */

  /** 24h 露点差：气温 − 露点。低于 dew_gap_min 视为叶面近饱和（结露） */
  function dewChartSvg(hours, width) {
    var W = width || 620, H = 238, L = 38, R = 12, TP = 18, B = 30;
    var iw = W - L - R, ih = H - TP - B;
    var gapMin = RULES.spray.dew_gap_min;
    var gaps = hours.map(function (h) {
      return (h.temp !== null && h.dew !== null && h.dew !== undefined) ? h.temp - h.dew : null;
    });
    var vals = gaps.filter(function (v) { return v !== null; });
    if (!vals.length) return '<div class="chart-note">该日无露点数据</div>';
    var ymax = Math.max(gapMin + 2.5, Math.ceil(Math.max.apply(null, vals)) + 1);
    var ymin = Math.min(-1, Math.floor(Math.min.apply(null, vals)));
    var x = function (h) { return L + (h / 24) * iw; };
    var y = function (v) { return TP + ih - (v - ymin) / (ymax - ymin) * ih; };
    var p = [];
    for (var g = Math.ceil(ymin); g <= ymax; g += 2) {
      p.push('<line x1="' + L + '" y1="' + y(g).toFixed(1) + '" x2="' + (W - R) + '" y2="' + y(g).toFixed(1) +
        '" stroke="#eef1ea" stroke-width="1"/>');
      p.push('<text x="' + (L - 6) + '" y="' + (y(g) + 3.5).toFixed(1) + '" font-size="9" text-anchor="end" fill="#9aa196">' + g + '</text>');
    }
    /* 结露时段底条：一眼看出"几点叶子是湿的" */
    hours.forEach(function (h, i) {
      if (gaps[i] === null || gaps[i] >= gapMin) return;
      p.push('<rect x="' + (x(h.hour) + 1).toFixed(1) + '" y="' + TP + '" width="' +
        Math.max(3, iw / 24 - 2).toFixed(1) + '" height="' + ih +
        '" fill="rgba(107,114,128,.14)" rx="2"/>');
    });
    var line = '', started = false;
    hours.forEach(function (h, i) {
      if (gaps[i] === null) { started = false; return; }
      line += (started ? ' L' : 'M') + x(h.hour).toFixed(1) + ',' + y(gaps[i]).toFixed(1);
      started = true;
    });
    p.push('<path d="' + line + '" fill="none" stroke="#255677" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>');
    var dy = y(gapMin).toFixed(1);
    p.push('<line x1="' + L + '" y1="' + dy + '" x2="' + (W - R) + '" y2="' + dy +
      '" stroke="#BE4A3C" stroke-width="1.2" stroke-dasharray="4 4" opacity=".85"/>');
    p.push('<text x="' + (L + 5) + '" y="' + (+dy - 6).toFixed(1) +
      '" font-size="9" fill="#BE4A3C" stroke="#fff" stroke-width="3" paint-order="stroke" stroke-linejoin="round">结露线 ' + gapMin + '℃</text>');
    hours.forEach(function (h, i) {
      if (gaps[i] === null) return;
      var ok = gaps[i] > gapMin;
      p.push('<circle cx="' + x(h.hour).toFixed(1) + '" cy="' + y(gaps[i]).toFixed(1) + '" r="2.4" fill="' +
        (ok ? '#255677' : '#BE4A3C') + '" stroke="#fff" stroke-width="1"/>');
    });
    [0, 6, 12, 18, 24].forEach(function (h, i3) {
      var a = i3 === 0 ? 'start' : (i3 === 4 ? 'end' : 'middle');
      p.push('<text x="' + x(h).toFixed(1) + '" y="' + (H - 10) + '" font-size="9" text-anchor="' + a + '" fill="#9aa196">' +
        (h === 24 ? '24 时' : h + ' 时') + '</text>');
    });
    p.push('<text x="' + L + '" y="' + (TP - 5) + '" font-size="9" fill="#9aa196">℃</text>');
    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '">' + p.join('') + '</svg>';
  }

  /** 24h 气温 + 作业温度带：出带的时段一眼看出是太冷还是太热 */
  function tempBandSvg(hours, width) {
    var W = width || 620, H = 238, L = 38, R = 12, TP = 18, B = 30;
    var iw = W - L - R, ih = H - TP - B;
    var lo = RULES.spray.temp_min, hi = RULES.spray.temp_max;
    var temps = hours.map(function (h) { return (h.temp === null || h.temp === undefined) ? null : h.temp; })
      .filter(function (v) { return v !== null; });
    if (!temps.length) return '<div class="chart-note">该日无气温数据</div>';
    var ymax = Math.ceil(Math.max(hi + 2, Math.max.apply(null, temps) + 1));
    var ymin = Math.floor(Math.min(lo - 2, Math.min.apply(null, temps)) - 0);
    var x = function (h) { return L + (h / 24) * iw; };
    var y = function (v) { return TP + ih - (v - ymin) / (ymax - ymin) * ih; };
    var p = [];
    for (var g = ymin; g <= ymax; g += 5) {
      p.push('<line x1="' + L + '" y1="' + y(g).toFixed(1) + '" x2="' + (W - R) + '" y2="' + y(g).toFixed(1) +
        '" stroke="#eef1ea" stroke-width="1"/>');
      p.push('<text x="' + (L - 6) + '" y="' + (y(g) + 3.5).toFixed(1) + '" font-size="9" text-anchor="end" fill="#9aa196">' + g + '°</text>');
    }
    /* 作业温度带 */
    p.push('<rect x="' + L + '" y="' + y(hi).toFixed(1) + '" width="' + iw + '" height="' +
      (y(lo) - y(hi)).toFixed(1) + '" fill="rgba(14,107,74,.10)" rx="3"/>');
    var line = '', started = false;
    hours.forEach(function (h, i) {
      if (temps[i] === null) { started = false; return; }
      line += (started ? ' L' : 'M') + x(h.hour).toFixed(1) + ',' + y(temps[i]).toFixed(1);
      started = true;
    });
    p.push('<path d="' + line + '" fill="none" stroke="#C0811A" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>');
    hours.forEach(function (h, i) {
      if (temps[i] === null) return;
      var t = temps[i];
      var col = (t >= lo && t <= hi) ? '#0E6B4A' : (t < lo ? '#255677' : '#BE4A3C');
      p.push('<circle cx="' + x(h.hour).toFixed(1) + '" cy="' + y(t).toFixed(1) + '" r="2.4" fill="' + col + '" stroke="#fff" stroke-width="1"/>');
    });
    [0, 6, 12, 18, 24].forEach(function (h, i3) {
      var a = i3 === 0 ? 'start' : (i3 === 4 ? 'end' : 'middle');
      p.push('<text x="' + x(h).toFixed(1) + '" y="' + (H - 10) + '" font-size="9" text-anchor="' + a + '" fill="#9aa196">' +
        (h === 24 ? '24 时' : h + ' 时') + '</text>');
    });
    p.push('<text x="' + L + '" y="' + (TP - 5) + '" font-size="9" fill="#9aa196">℃</text>');
    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '">' + p.join('') + '</svg>';
  }

  /** 24h 风向·飘移：箭头指向雾滴飘去的方向（下风向），红 = 该时风速超上限 */
  function driftChartSvg(hours, width) {
    var W = width || 620, H = 238, L = 38, R = 12, TP = 18, B = 30;
    var iw = W - L - R, ih = H - TP - B;
    var cy = TP + ih / 2;
    var x = function (h) { return L + (h / 24) * iw; };
    var p = [];
    p.push('<line x1="' + L + '" y1="' + cy + '" x2="' + (W - R) + '" y2="' + cy + '" stroke="#eef1ea" stroke-width="1.5"/>');
    /* 方位刻度：上北，帮助读出箭头朝向 */
    p.push('<text x="' + (W - R + 1) + '" y="' + (cy - 8) + '" font-size="9" fill="#9aa196">N↑</text>');
    var lim = RULES.spray.wind_max, maxW = 1;
    hours.forEach(function (h) { if (h.wind > maxW) maxW = h.wind; });
    var lenMax = Math.min(iw / 24 - 4, 26);
    hours.forEach(function (h) {
      if (h.dir === null || h.dir === undefined) return;
      var over = h.wind > lim;
      var col = over ? '#BE4A3C' : '#0E6B4A';
      var len = Math.max(7, (h.wind / Math.max(maxW, lim)) * lenMax);
      /* 气象风向是「来向」；雾滴飘向 = 来向 + 180°。屏幕坐标：北 = 上 */
      var to = (h.dir + 180) * Math.PI / 180;
      var dx = Math.sin(to), dyy = -Math.cos(to);
      var x0 = x(h.hour), y0 = cy, x1 = x0 + dx * len, y1 = cy + dyy * len;
      var tip = pad2(h.hour) + ':00 ' + dirText(h.dir) + '风 ' + dirDeg(h.dir) + ' · ' + h.wind + ' m/s，飘向' + driftText(h.dir);
      p.push('<g><title>' + tip + '</title>' +
        '<line x1="' + x0.toFixed(1) + '" y1="' + y0.toFixed(1) + '" x2="' + x1.toFixed(1) + '" y2="' + y1.toFixed(1) +
        '" stroke="' + col + '" stroke-width="2" stroke-linecap="round"/>' +
        /* 箭头两撇 */
        '<line x1="' + x1.toFixed(1) + '" y1="' + y1.toFixed(1) + '" x2="' + (x1 - (dx * 5 + dyy * 3.2)).toFixed(1) + '" y2="' + (y1 - (dyy * 5 - dx * 3.2)).toFixed(1) +
        '" stroke="' + col + '" stroke-width="1.6" stroke-linecap="round"/>' +
        '<line x1="' + x1.toFixed(1) + '" y1="' + y1.toFixed(1) + '" x2="' + (x1 - (dx * 5 - dyy * 3.2)).toFixed(1) + '" y2="' + (y1 - (dyy * 5 + dx * 3.2)).toFixed(1) +
        '" stroke="' + col + '" stroke-width="1.6" stroke-linecap="round"/>' +
        '<circle cx="' + x0.toFixed(1) + '" cy="' + y0.toFixed(1) + '" r="1.6" fill="' + col + '" opacity=".55"/></g>');
    });
    if (!hours.some(function (h) { return h.dir !== null && h.dir !== undefined; })) {
      return '<div class="chart-note">该日无风向数据</div>';
    }
    [0, 6, 12, 18, 24].forEach(function (h, i3) {
      var a = i3 === 0 ? 'start' : (i3 === 4 ? 'end' : 'middle');
      p.push('<text x="' + x(h).toFixed(1) + '" y="' + (H - 10) + '" font-size="9" text-anchor="' + a + '" fill="#9aa196">' +
        (h === 24 ? '24 时' : h + ' 时') + '</text>');
    });
    /* 每 3 小时一个风速读数，窄图自动跳过部分标签防重叠 */
    var step = W < 470 ? 6 : 3;
    hours.forEach(function (h) {
      if (h.hour % step) return;
      p.push('<text x="' + x(h.hour).toFixed(1) + '" y="' + (cy + 14).toFixed(1) +
        '" font-size="8.5" text-anchor="middle" fill="#9aa196" stroke="#fff" stroke-width="2.5" paint-order="stroke">' +
        h.wind + '</text>');
    });
    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '">' + p.join('') + '</svg>';
  }

  /** 7 天降雨 vs 需水：柱 = 每日预报雨量，蓝线 = 累计，虚线 = 周有效降水参考 */
  function rainNeedSvg(result, width) {
    var W = width || 620, H = 238, L = 38, R = 40, TP = 18, B = 30;
    var iw = W - L - R, ih = H - TP - B;
    var days = result.days;
    var REF = 15; /* 与灌溉判定同一口径：一周有效降水 15mm */
    var maxBar = 0;
    days.forEach(function (d) { if (d.dayRain > maxBar) maxBar = d.dayRain; });
    var ymax = Math.max(4, Math.ceil(maxBar + 1));
    var cum = 0, cums = days.map(function (d) { cum += (d.dayRain || 0); return cum; });
    var cumMax = Math.max(REF + 5, Math.ceil(cum[cum.length - 1] + 2));
    var x = function (i) { return L + (i + 0.5) / days.length * iw; };
    var yL = function (v) { return TP + ih - Math.min(v, ymax) / ymax * ih; };
    var yR = function (v) { return TP + ih - v / cumMax * ih; };
    var p = [];
    for (var g = 0; g <= ymax; g += 2) {
      p.push('<line x1="' + L + '" y1="' + yL(g).toFixed(1) + '" x2="' + (W - R) + '" y2="' + yL(g).toFixed(1) +
        '" stroke="#eef1ea" stroke-width="1"/>');
      p.push('<text x="' + (L - 6) + '" y="' + (yL(g) + 3.5).toFixed(1) + '" font-size="9" text-anchor="end" fill="#9aa196">' + g + '</text>');
    }
    var bw = Math.max(6, iw / days.length * 0.42);
    days.forEach(function (d, i) {
      var v = d.dayRain || 0;
      if (v <= 0) return;
      var bh = Math.max(1.5, TP + ih - yL(v));
      p.push('<rect x="' + (x(i) - bw / 2).toFixed(1) + '" y="' + yL(v).toFixed(1) +
        '" width="' + bw.toFixed(1) + '" height="' + bh.toFixed(1) +
        '" fill="rgba(47,111,159,.30)" rx="2.5"/>');
    });
    var line = '';
    cums.forEach(function (v, i) { line += (i ? ' L' : 'M') + x(i).toFixed(1) + ',' + yR(v).toFixed(1); });
    p.push('<path d="' + line + '" fill="none" stroke="#255677" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>');
    cums.forEach(function (v, i) {
      p.push('<circle cx="' + x(i).toFixed(1) + '" cy="' + yR(v).toFixed(1) + '" r="2.4" fill="#255677" stroke="#fff" stroke-width="1"/>');
    });
    var ry = yR(REF).toFixed(1);
    p.push('<line x1="' + L + '" y1="' + ry + '" x2="' + (W - R) + '" y2="' + ry +
      '" stroke="#8A6110" stroke-width="1.2" stroke-dasharray="4 4" opacity=".85"/>');
    p.push('<text x="' + (W - R - 3) + '" y="' + (+ry - 6).toFixed(1) +
      '" font-size="9" fill="#8A6110" text-anchor="end" stroke="#fff" stroke-width="3" paint-order="stroke" stroke-linejoin="round">周参考 ' + REF + 'mm</text>');
    /* 干旱周整张图只剩一条贴底的零线，直说，别让人以为是图没画出来 */
    if (maxBar === 0) {
      p.push('<text x="' + (L + iw / 2) + '" y="' + (TP + ih * 0.42) + '" font-size="12" text-anchor="middle" fill="#9aa196">未来七天预报无有效降雨</text>');
    }
    days.forEach(function (d, i) {
      var dt = new Date(d.date + 'T00:00:00');
      p.push('<text x="' + x(i).toFixed(1) + '" y="' + (H - 10) + '" font-size="9" text-anchor="middle" fill="#9aa196">' +
        (dt.getMonth() + 1) + '/' + dt.getDate() + '</text>');
    });
    p.push('<text x="' + L + '" y="' + (TP - 5) + '" font-size="9" fill="#9aa196">mm/日</text>');
    p.push('<text x="' + (W - R + 26) + '" y="' + (TP - 5) + '" font-size="9" fill="#255677">累计</text>');
    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '">' + p.join('') + '</svg>';
  }

  /* 热力图色板：一处定义，图例文字与色块不会再漂 */
  var HEAT_COLOR = {
    ok: '#bbf7d0', wind: '#fed7aa', cold: '#C7DCE8', hot: '#fde68a',
    rain: '#fecaca', dew: '#cbd5e1'
  };

  /** 7 天 × 24 小时 作业窗口热力图 */
  function heatChartSvg(raw, result, width) {
    var days = result.days;
    /* 原来写死 1180 宽：手机卡片只有 330px 量级，整张图被容器切掉右半边，
       24 列的刻度和色块都看不全。改成按容器宽实时算，列宽自动收窄。 */
    var W = width || 620;
    var narrow = W < 470;
    var H = 238, L = narrow ? 38 : 52, R = 12, TP = 22, B = 30;
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
      // 当日实际截止小时：冬季日落早，引擎会按逆温提前收工，热力图必须跟着切
      var endH = (d.spray.hours && d.spray.hours[1]) || RULES.spray.hours[1];

      p.push('<text x="' + (L - 9) + '" y="' + (TP + di * chh + chh / 2 + 3.6).toFixed(1) +
        '" font-size="11" text-anchor="end" fill="#7d8f76">' + (di === 0 ? '今天' : d.dow) + '</text>');

      for (var h = 0; h < 24; h++) {
        var cell = map[h];
        var inWork = h >= RULES.spray.hours[0] && h < endH;
        var color = '#f3f4f6';
        if (blocked && inWork) {
          color = '#c7d2fe';                       // 降雨拦截
        } else if (cell && inWork) {
          var v = T.hourVerdict(cell);
          color = HEAT_COLOR[v] || '#fde68a';
        }
        p.push('<rect x="' + (L + h * cw).toFixed(1) + '" y="' + (TP + di * chh).toFixed(1) +
          '" width="' + (cw - 2).toFixed(1) + '" height="' + (chh - 2.2).toFixed(1) +
          '" rx="2.5" fill="' + color + '"/>');
      }
    });

    // 提前收工的日子：在当日行末画一道刻线，说明"这天日落早就得早点收"
    days.forEach(function (d, di) {
      if (!d.spray.cutoffShortened || !d.spray.hours) return;
      var xs = (L + d.spray.hours[1] * cw).toFixed(1);
      p.push('<line x1="' + xs + '" y1="' + (TP + di * chh + 1).toFixed(1) +
        '" x2="' + xs + '" y2="' + (TP + (di + 1) * chh - 2).toFixed(1) +
        '" stroke="#BE4A3C" stroke-width="1.6" opacity=".55"/>');
    });

    var wx = function (h) { return L + h * cw; };
    // 作业时段边界
    [RULES.spray.hours[0], RULES.spray.hours[1]].forEach(function (h) {
      p.push('<line x1="' + wx(h).toFixed(1) + '" y1="' + (TP - 7) + '" x2="' + wx(h).toFixed(1) +
        '" y2="' + (TP + days.length * chh).toFixed(1) + '" stroke="#c9d4b8" stroke-width="1" stroke-dasharray="3 3"/>');
    });
    var h0 = RULES.spray.hours[0], h1 = RULES.spray.hours[1];
    p.push('<text x="' + (wx(h0) + 3).toFixed(1) + '" y="' + (TP - 9) +
      '" font-size="' + (narrow ? 9 : 9.5) + '" fill="#9ca3af">' + (narrow ? h0 + '时' : h0 + ':00 作业时段开始') + '</text>');
    if (!narrow) {
      p.push('<text x="' + (wx(h1) - 4).toFixed(1) + '" y="' + (TP - 9) +
        '" font-size="9.5" fill="#9ca3af" text-anchor="end">' + h1 + ':00 省站上限</text>');
    }

    (narrow ? [0, 6, 12, 18] : [0, 3, 6, 9, 12, 15, 18, 21]).forEach(function (h) {
      p.push('<text x="' + (L + h * cw + cw / 2).toFixed(1) + '" y="' + (H - 9) +
        '" font-size="' + (narrow ? 9.5 : 10) + '" text-anchor="middle">' + h + (narrow ? '' : ':00') + '</text>');
    });

    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '">' + p.join('') + '</svg>';
  }

  /** 7 天温度双折线 + 降水柱（降水单独占底部区域，避免被温度带遮住） */
  function tempChartSvg(result, width) {
    var W = width || 620, H = 238, L = 40, R = 14, TP = 16, B = 30;
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
    p.push(poly(tmin, '#3B7CA3'));

    days.forEach(function (d, i) {
      p.push('<text x="' + x(i).toFixed(1) + '" y="' + (y(d.tmax) - 7).toFixed(1) + '" font-size="9.5" text-anchor="middle" fill="#ef4444">' + d.tmax + '</text>');
      p.push('<text x="' + x(i).toFixed(1) + '" y="' + (y(d.tmin) + 14).toFixed(1) + '" font-size="9.5" text-anchor="middle" fill="#3B7CA3">' + d.tmin + '</text>');
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

    days.forEach(function (d, i) {
      var a = i === 0 ? 'start' : (i === days.length - 1 ? 'end' : 'middle');
      p.push('<text x="' + x(i).toFixed(1) + '" y="' + (H - 8) + '" font-size="10" text-anchor="' + a + '">' +
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
  function growthSvg(plot, width) {
    var pts = T.growthTrend(plot, 8);
    /* 与其余三张图统一 238 高：2×2 网格里四张卡才真正对齐 */
    var W = width || 620, H = 238, L = 40, R = 14, TP = 16, B = 30;
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
      var a = i === 0 ? 'start' : (i === pts.length - 1 ? 'end' : 'middle');
      p.push('<text x="' + x(i).toFixed(1) + '" y="' + (H - 10) + '" font-size="9" text-anchor="' + a + '">' + pt.label + '</text>');
    });
    p.push('<text x="' + L + '" y="' + (H - 22) + '" font-size="9" fill="#9ca3af">长势指数</text>');

    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '">' +
      '<defs><linearGradient id="growGrad" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#10b981" stop-opacity=".3"/>' +
      '<stop offset="100%" stop-color="#10b981" stop-opacity=".02"/></linearGradient></defs>' +
      p.join('') + '</svg>';
  }

  /* 转屏 / 改窗口后按新宽度重绘：svg 只是等比缩放，重绘后才不糊 */
  var chartResizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(chartResizeTimer);
    chartResizeTimer = setTimeout(function () {
      if (state.result) renderCharts();
    }, 220);
  });

  /* 风向角度 → 中文方位
     -------------------------------------------------------------
     16 方位在《地面气象观测规范》里写作「北东北 / 西西南 / 西西北」，
     那是给观测记录用的，念出来别扭。界面上改用同义的「偏」式说法：
       西西南 (WSW) → 西南偏西，西西北 (WNW) → 西北偏西
     再把度数一起给出，既好念又能核对。 */
  function dirText(deg) {
    if (deg === null || deg === undefined || isNaN(deg)) return '—';
    var names = ['北', '北偏东', '东北', '东北偏东', '东', '东南偏东', '东南', '南偏东',
      '南', '南偏西', '西南', '西南偏西', '西', '西北偏西', '西北', '北偏西'];
    return names[Math.round(Number(deg) / 22.5) % 16];
  }
  function dirDeg(deg) {
    if (deg === null || deg === undefined || isNaN(deg)) return '';
    return Math.round(Number(deg)) + '°';
  }
  /* 下风向：风从哪来，雾滴就往反方向飘——这是打药最该看的方向 */
  function driftText(deg) {
    if (deg === null || deg === undefined || isNaN(deg)) return '—';
    return dirText((Number(deg) + 180) % 360);
  }

  /** 桌面实况条：把温湿风压能见度摊开，一眼看到"数据有多全" */
  function renderNowStrip(result) {
    var box = $('nowStrip');
    if (!box || !state.raw) return;
    var raw = state.raw, d0 = result.days[0];
    var hours = T.hoursOf(raw.hourly, d0.date);
    if (!hours.length && result.days[1]) hours = T.hoursOf(raw.hourly, result.days[1].date);
    if (!hours.length) { box.innerHTML = ''; return; }
    var nowH = new Date().getHours();
    var h = hours.slice().sort(function (a, b) {
      return Math.abs(a.hour - nowH) - Math.abs(b.hour - nowH);
    })[0];
    var sunrise = d0.sunrise || '', sunset = d0.sunset || '';
    function v(x, unit, digits) {
      if (x === null || x === undefined) return '—';
      var n = Number(x);
      if (!isFinite(n)) return '—';
      return (digits === 1 ? round1(n) : Math.round(n)) + (unit || '');
    }
    var gap = (h.dew !== null && h.dew !== undefined && h.temp !== null && h.temp !== undefined)
      ? round1(h.temp - h.dew) : null;
    var dew = gap !== null && gap <= RULES.spray.dew_gap_min;
    var items = [
      ['气温', v(h.temp, ' ℃'), ''],
      ['风速', v(h.wind, ' m/s', 1), ''],
      ['风向', (h.dir === null || h.dir === undefined ? '—' : dirText(h.dir)),
        (h.dir === null || h.dir === undefined ? '' : dirDeg(h.dir))],
      ['湿度', v(h.hum, '%'), ''],
      ['露点差', (gap === null ? '—' : gap.toFixed(1) + ' ℃'), (dew ? '结露' : '')],
      ['气压', v(h.press, ' hPa'), ''],
      ['能见度', v(h.vis, ' km', 1), ''],
      ['云量', v(h.cloud, '%'), ''],
      ['日出', sunrise || '—', ''],
      ['日落', sunset || '—', ''],
      ['日照', (d0.daylightH === null || d0.daylightH === undefined ? '—' : d0.daylightH.toFixed(1) + ' h'), '']
    ];
    box.innerHTML = items.map(function (x) {
      return '<div class="ns' + (x[0] === '露点差' && dew ? ' dew' : '') + '">' +
        '<span>' + x[0] + '</span><b>' + x[1] +
        (x[2] ? '<i>' + x[2] + '</i>' : '') + '</b></div>';
    }).join('');
  }

  /** 桌面端逐时表：不额外请求，全部来自已取到的逐小时数据 */
  function renderProTable(date, d, hours) {
    var tb = $('proTable');
    if (!tb) return;
    var dt = new Date(date + 'T00:00:00');
    if ($('proTitle')) $('proTitle').textContent = (dt.getMonth() + 1) + '月' + dt.getDate() + '日 ' + d.dow + ' · 24 小时';

    if (!hours.length) {
      tb.innerHTML = '<tr><td style="text-align:left;padding:12px">该日逐小时数据尚未覆盖（预报从明天开始）</td></tr>';
      if ($('proSum')) $('proSum').innerHTML = '';
      return;
    }

    var sumW = 0, maxW = 0, maxH = null, sumRain = 0, sumHum = 0, humN = 0, okH = 0;
    hours.forEach(function (h) {
      sumW += h.wind;
      if (h.wind > maxW) { maxW = h.wind; maxH = h.hour; }
      sumRain += (h.rain || 0);
      if (h.hum !== null && h.hum !== undefined) { sumHum += h.hum; humN++; }
      if (h.hour >= RULES.spray.hours[0] && h.hour < RULES.spray.hours[1] &&
          h.rain <= RULES.spray.rain_hour_max &&
          (h.prob === null || h.prob === undefined || h.prob < RULES.spray.prob_block) &&
          T.hourVerdict(h) === 'ok') okH++;
    });

    if ($('proSum')) {
      $('proSum').innerHTML =
        '<span class="pro-chip">平均风速<b>' + round1(sumW / hours.length) + ' m/s</b></span>' +
        '<span class="pro-chip">最大风速<b>' + round1(maxW) + ' m/s' + (maxH !== null ? '（' + maxH + ' 时）' : '') + '</b></span>' +
        '<span class="pro-chip">累计降水<b>' + round1(sumRain) + ' mm</b></span>' +
        '<span class="pro-chip">平均湿度<b>' + (humN ? Math.round(sumHum / humN) : '—') + '%</b></span>' +
        '<span class="pro-chip">可作业<b>' + okH + ' 小时</b></span>' +
        '<span class="pro-chip">判定口径<b>' + RULES.spray.wind_max + ' m/s · ' +
          RULES.spray.prob_block + '% 概率 · 露点差 ≤ ' + RULES.spray.dew_gap_min + '℃</b></span>' +
        (d.spray.cutoffShortened
          ? '<span class="pro-chip">已按日落收紧<b>' + d.sunset + ' → ' + d.spray.hours[1] + ':00 收工</b></span>'
          : '');
    }

    var head = '<thead><tr><th>时刻</th><th>风速 m/s</th><th>风向</th><th>气温 ℃</th>' +
      '<th>湿度 %</th><th>露点差 ℃</th><th>降水 mm</th><th>概率 %</th><th>判定</th></tr></thead>';
    var endH = (d.spray.hours && d.spray.hours[1]) || RULES.spray.hours[1];
    var body = hours.map(function (h) {
      var inWin = h.hour >= RULES.spray.hours[0] && h.hour < endH;
      var v = T.hourVerdict(h);
      var label = v === 'ok' ? '可作业' : v === 'cold' ? '低温' : v === 'hot' ? '高温'
        : v === 'rain' ? '降水' : v === 'dew' ? '结露' : '风大';
      var gap = (h.dew !== null && h.dew !== undefined && h.temp !== null && h.temp !== undefined)
        ? round1(h.temp - h.dew) : null;
      /* 作业时段之外的小时不是"判定不合格"，只是本来就不干活：
         凌晨 0 点标成红色"低温"会让人以为窗口被这条挡住了。 */
      var cls = !inWin ? 'off' : (v === 'ok' ? '' : 'bad');
      if (!inWin) label = '非时段';
      return '<tr' + (cls ? ' class="' + cls + '"' : '') + '>' +
        '<td>' + pad2(h.hour) + ':00</td>' +
        '<td>' + round1(h.wind) + '</td>' +
        '<td>' + dirText(h.dir) + (dirDeg(h.dir) ? ' ' + dirDeg(h.dir) : '') + '</td>' +
        '<td>' + Math.round(h.temp) + '</td>' +
        '<td>' + (h.hum === null || h.hum === undefined ? '—' : Math.round(h.hum)) + '</td>' +
        '<td>' + (gap === null ? '—' : gap.toFixed(1)) + '</td>' +
        '<td>' + (h.rain === null || h.rain === undefined ? '—' : round1(h.rain)) + '</td>' +
        '<td>' + (h.prob === null || h.prob === undefined ? '—' : Math.round(h.prob)) + '</td>' +
        '<td><span class="ok-dot' + (!inWin ? ' off-dot' : (v === 'ok' ? '' : ' bad-dot')) +
          '"></span>' + label + '</td>' +
      '</tr>';
    }).join('');
    tb.innerHTML = head + '<tbody>' + body + '</tbody>';
  }

  function renderCharts() {
    var raw = state.raw, result = state.result, plot = activePlot();
    if (!raw || !result) return;

    // 逐小时风速（跟随选中的那天）
    var day = state.chartDay || result.days[0].date;
    var d = result.days.filter(function (x) { return x.date === day; })[0] || result.days[0];
    var hours = T.hoursOf(raw.hourly, d.date);
    var dt = new Date(d.date + 'T00:00:00');
    // 区块标题已经写了「逐小时风速」，卡片里只留日期，避免同一句话出现两遍
    $('windTitle').textContent = (dt.getMonth() + 1) + '月' + dt.getDate() + '日 ' + d.dow;
    var eh = (d.spray.hours && d.spray.hours[1]) || RULES.spray.hours[1];
    $('windSub').textContent = '虚线 ' + RULES.spray.wind_max + ' m/s = 上限 · 绿底 ' +
      RULES.spray.hours[0] + '–' + eh + ' 时 = 可作业时段' +
      (d.spray.cutoffShortened ? '（日落 ' + d.sunset + '，比省站 16 时提前收工）' : '');
    // 图例里的上限数字跟着规则走，不要在 HTML 里写死（会跟实际判定对不上）
    if ($('windLimitTag')) $('windLimitTag').textContent = RULES.spray.wind_max + ' m/s 上限';
    $('windChart').innerHTML = hours.length
      ? windChartSvg(hours, d.windMax, chartW($('windChart')))
      : '<div class="chart-note">该日无逐小时数据</div>';

    renderProTable(d.date, d, hours);

    $('heatChart').innerHTML = heatChartSvg(raw, result, chartW($('heatChart')));
    $('tempChart').innerHTML = tempChartSvg(result, chartW($('tempChart')));
    if ($('donutChart')) $('donutChart').innerHTML = donutSvg(result);
    $('growthChart').innerHTML = growthSvg(plot, chartW($('growthChart')));
    /* v5.1 新增四张：露点差 / 气温带 / 风向飘移（都跟选中日走）+ 7 天降雨需水 */
    $('dewChart').innerHTML = hours.length
      ? dewChartSvg(hours, chartW($('dewChart')))
      : '<div class="chart-note">该日无逐小时数据</div>';
    $('tempBandChart').innerHTML = hours.length
      ? tempBandSvg(hours, chartW($('tempBandChart')))
      : '<div class="chart-note">该日无逐小时数据</div>';
    $('driftChart').innerHTML = hours.some(function (h) { return h.dir !== null && h.dir !== undefined; })
      ? driftChartSvg(hours, chartW($('driftChart')))
      : '<div class="chart-note">该日无风向数据</div>';
    $('rainChart').innerHTML = rainNeedSvg(result, chartW($('rainChart')));
  }

  /* =========================================================
     渲染：地块
     ========================================================= */
  /** 生成一行地块（左侧栏和「我的」页共用同一套渲染） */
  function buildPlotNode(p) {
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
      return d;
    }

    d.className = 'plot' + (p.id === state.activeId ? ' on' : '');
    d.innerHTML =
      '<div class="plot-main">' +
        '<img class="plot-art" src="img/crop-' + (p.crop === 'maize' ? 'corn' : 'wheat') + '.webp" alt="" loading="lazy" onerror="this.style.display=\'none\'">' +
        '<span class="plot-dot"></span>' +
        '<span class="plot-name">' + esc(p.name) + '</span>' +
        '<span class="plot-area">' + p.area + ' 亩</span>' +
      '</div>' +
      '<div class="plot-meta">' + esc(placeText(p)) +
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
      // 手机端在「我的」里切换地块后，回到内容页才看得到结果
      if (currentView !== 'content') setView('content');
    };
    return d;
  }

  function renderPlots() {
    ['plotList', 'minePlotList', 'plotGrid'].forEach(function (id) {
      var box = $(id);
      if (!box) return;
      box.innerHTML = '';
      state.plots.forEach(function (p) { box.appendChild(buildPlotNode(p)); });
    });
    if ($('plotCount')) $('plotCount').textContent = state.plots.length + ' 块';
    if ($('minePlotCount')) $('minePlotCount').textContent = state.plots.length + ' 块';
    if ($('plotHint')) $('plotHint').textContent = state.plots.length + ' 块 · 点击切换下方数据';
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


  /* =========================================================
     节气：21 世纪通用算式（精确到日），用于首页节气条
     ========================================================= */
  var TERM_C = [
    ['小寒', 5.4055], ['大寒', 20.12], ['立春', 3.87], ['雨水', 18.73],
    ['惊蛰', 5.63], ['春分', 20.646], ['清明', 4.81], ['谷雨', 20.1],
    ['立夏', 5.52], ['小满', 21.04], ['芒种', 5.678], ['夏至', 21.37],
    ['小暑', 7.108], ['大暑', 22.83], ['立秋', 7.5], ['处暑', 23.13],
    ['白露', 7.646], ['秋分', 23.042], ['寒露', 8.318], ['霜降', 23.438],
    ['立冬', 7.438], ['小雪', 22.36], ['大雪', 7.18], ['冬至', 21.94]
  ];

  function termDay(year, i) {
    var y = year % 100;
    var d = Math.floor(y * 0.2422 + TERM_C[i][1]) - Math.floor(y / 4);
    var m = Math.floor(i / 2) + 1;
    return new Date(year, m - 1, d);
  }

  function termEvents(now) {
    var y = now.getFullYear(), out = [];
    for (var yr = y - 1; yr <= y + 1; yr++) {
      for (var i = 0; i < 24; i++) out.push({ name: TERM_C[i][0], date: termDay(yr, i) });
    }
    out.sort(function (a, b) { return a.date - b.date; });
    return out;
  }

  function renderSolarTerm() {
    var now = new Date();
    now.setHours(0, 0, 0, 0);
    var evs = termEvents(now), cur = -1, next = -1;
    for (var i = 0; i < evs.length; i++) {
      if (evs[i].date <= now) cur = i;
      else { next = i; break; }
    }
    if (cur < 0 || next < 0) return;
    var c = evs[cur], n = evs[next];
    var days = Math.floor((now - c.date) / 86400000);
    var hou = Math.min(3, Math.floor(days / 5) + 1);
    var toNext = Math.round((n.date - now) / 86400000);

    if ($('jqNow')) $('jqNow').textContent = c.name;
    if ($('jqSub')) $('jqSub').textContent = ['初候', '二候', '三候'][hou - 1] + ' · 第 ' + (days + 1) + ' 天';
    if ($('jqNext')) $('jqNext').textContent = '距' + n.name + ' ' + toNext + ' 天';
    if ($('jqFarm') && CONTENT) {
      var tip = CONTENT.termNote(c.name);
      $('jqFarm').textContent = '农事：' + (tip || '按当前天气窗口安排田间作业');
    }
  }

  /* 物候横幅：按月份切到当前生育期的插画，夏玉米季（7–10 月）不显示 */
  function renderSeasonBanner() {
    var box = $('seasonBanner');
    if (!box) return;
    var m = new Date().getMonth() + 1;
    var map = {
      1: ['season-winter', '越冬期', '幼苗贴伏越冬 · 防冻害，视墒情与苗情考虑越冬水'],
      2: ['season-regreen', '返青期', '新叶开始抽出 · 促弱苗转壮，关注倒春寒'],
      3: ['season-regreen', '返青期', '新叶抽出 · 看墒情浇返青水，防倒春寒'],
      4: ['season-jointing', '拔节期', '节间伸长 · 需水需肥高峰，注意防倒伏与病虫'],
      5: ['season-mature', '灌浆成熟期', '穗重易倒伏 · 降雨前留意抢收与晾晒'],
      6: ['season-mature', '成熟期', '临近收获 · 阴雨会降低品质，及早安排'],
      11: ['season-winter', '越冬期', '幼苗贴伏越冬 · 防冻害，视墒情与苗情考虑越冬水'],
      12: ['season-winter', '越冬期', '幼苗贴伏越冬 · 防冻害，视墒情与苗情考虑越冬水']
    };
    var e = map[m];
    if (!e) { box.hidden = true; return; }
    var img = $('seasonImg');
    if (img) {
      var f = 'img/' + e[0] + '.webp';
      if (img.getAttribute('src') !== f) img.setAttribute('src', f);
    }
    if ($('seasonName')) $('seasonName').textContent = e[1];
    if ($('seasonDesc')) $('seasonDesc').textContent = e[2];
    box.hidden = false;
  }


  /* ---- 天气主题：背景随实况/预报变化，但正文始终深色可读 ---- */
  function applyWeatherTheme(code, windMax) {
    var h = new Date().getHours();
    var night = h < 6 || h >= 18;
    var cls = 'cloud';
    if (code === 0 || code === 1) cls = 'clear';
    else if (code === 2 || code === 3) cls = 'cloud';
    else if (code === 45 || code === 48) cls = 'fog';
    else if (code >= 51 && code <= 67) cls = 'rain';
    else if (code >= 71 && code <= 77) cls = 'snow';
    else if (code >= 80 && code <= 82) cls = 'rain';
    else if (code >= 95) cls = 'storm';
    /* 大风本身就是一种「天」：风天单列一套背景（阈值跟属地标准走），
       雷暴 / 暴雪保持自己的主题不被覆盖 */
    var windLine = (RULES.spray.wind_max || 3.4) * 1.6;
    if (windMax != null && windMax >= windLine && cls !== 'storm' && cls !== 'snow') cls = 'wind';
    document.body.className = document.body.className.replace(/\bwx-[a-z]+\b/g, '').trim();
    document.body.classList.add('wx-' + cls);
    if (night) document.body.classList.add('wx-night');
    var MAP = {
      clear: '#dceaf8', cloud: '#e4ebf1', rain: '#dfe8ea', snow: '#e8f0f7',
      fog: '#e9ece7', storm: '#dfe4ee', night: '#dfe6ee', wind: '#e0ede6'
    };
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', MAP[night ? 'night' : cls] || '#e6efe9');
    /* 决策卡与页面同一天气语言；状态类 st-* 由 renderDecision 维护，这里只换 wx- */
    var dec = $('decision');
    if (dec) {
      dec.className = dec.className.replace(/\bwx-[a-z]+\b/g, '').trim() +
        ' wx-' + (night ? 'night' : cls);
    }
    /* 决策卡插画：与 wx-* 同名映射，multiply 融进卡片渐变；加载失败自动隐藏 */
    var ART = {
      clear: 'weather-clear', cloud: 'weather-cloud', rain: 'weather-rain',
      snow: 'weather-snow', fog: 'weather-fog', storm: 'weather-storm',
      wind: 'weather-wind', night: 'weather-night'
    };
    var art = $('dArt');
    if (art) {
      var f = 'img/' + (ART[night ? 'night' : cls] || 'weather-cloud') + '.webp';
      if (art.getAttribute('src') !== f) art.setAttribute('src', f);
    }
  }

  /* =========================================================
     L1 决策卡
     -------------------------------------------------------------
     一个页面只回答一个问题：这件活，现在/今天能不能干、几点干。
     所以结论按「动作」写，不按「状态」写：
       能打 / 明天能打 / 今天别打 —— 而不是"适宜 / 不宜"。
     ========================================================= */

  function longestWin(list) {
    if (!list || !list.length) return null;
    return list.slice().sort(function (a, b) { return b.hours - a.hours; })[0];
  }

  function hoursUntil(dateStr, hour) {
    var t = new Date(dateStr + 'T' + pad2(hour) + ':00:00');
    return (t - new Date()) / 3600000;
  }

  function relDayShort(dateStr, result) {
    var today = result.days[0] && result.days[0].date;
    var t1 = result.days[1] && result.days[1].date;
    var t2 = result.days[2] && result.days[2].date;
    if (dateStr === today) return '今天';
    if (dateStr === t1) return '明天';
    if (dateStr === t2) return '后天';
    return dateStr.slice(5).replace('-', '/');
  }

  /** 打药：主结论永远先回答"今天/现在"，再给"下一次机会" */
  function sprayDecision(result) {
    var today = result.days[0];
    var now = new Date();
    var nowH = now.getHours() + now.getMinutes() / 60;
    var rem = null;
    if (state.raw && state.raw.hourly) {
      try { rem = T.todayRemaining(state.raw.hourly, state.raw.daily, now, 'spray'); } catch (e) { rem = null; }
    }

    /* ---- 今天还有机会：分"正在窗口里"和"稍后进窗口" ---- */
    if (rem && !rem.ended && rem.status === 'ok') {
      var live = rem.windows.filter(function (w) { return nowH >= w.start && nowH < w.end; });
      var later = rem.windows.filter(function (w) { return w.start > nowH; });
      if (live.length) {
        var w0 = longestWin(live);
        return {
          kind: 'live', day: today, date: today.date, win: w0, status: 'ok',
          word: '现在就能打',
          why: '这个时段风速 ' + w0.avgWind + ' m/s（上限 ' + RULES.spray.wind_max +
            '）、降雨概率 ' + today.dayProb + '%、露点差 ' + dewGapOf(today) +
            '℃，叶面是干的。还剩 ' + Math.max(1, Math.round(w0.end - nowH)) + ' 小时。',
          whenDay: '今天 ' + today.date.slice(5).replace('-', '/') + ' ' + today.dow,
          whenTime: pad2(w0.start) + ':00–' + pad2(w0.end) + ':00',
          whenLeft: '进行中'
        };
      }
      if (later.length) {
        var w1 = longestWin(later);
        return {
          kind: 'today', day: today, date: today.date, win: w1, status: 'ok',
          word: '今天 ' + w1.start + ' 点后可以打',
          why: '现在还没到窗口' + (nowH < RULES.spray.hours[0] ? '（作业时段从 ' + RULES.spray.hours[0] + ' 点开始）' : '') +
            '。' + w1.start + ' 点起风速 ' + w1.avgWind + ' m/s、降雨概率 ' + today.dayProb +
            '%，能连续干 ' + w1.hours + ' 小时。',
          whenDay: '今天 ' + today.date.slice(5).replace('-', '/') + ' ' + today.dow,
          whenTime: pad2(w1.start) + ':00–' + pad2(w1.end) + ':00',
          whenLeft: '距开始 ' + Math.max(1, Math.round(hoursUntil(today.date, w1.start))) + ' 小时'
        };
      }
    }

    /* ---- 今天不行：先讲清楚今天为什么不行，再给下一次机会 ---- */
    var todayWhy = (rem && !rem.ended) ? rem.why : today.spray.why;
    todayWhy = todayWhy.replace(/^今日/, '今天');

    for (var i = 1; i < result.days.length; i++) {
      var d = result.days[i];
      if (d.spray.status === 'ok' && d.spray.windows.length) {
        var w2 = longestWin(d.spray.windows);
        var rel = i === 1 ? '明天' : (i === 2 ? '后天' : d.dow);
        return {
          kind: 'future', day: d, date: d.date, win: w2, status: 'warn',
          word: '今天不能打',
          why: todayWhy + '。下一次机会在' + rel + '（' + d.date.slice(5).replace('-', '/') + '）的 ' +
            w2.start + '–' + w2.end + ' 点，只有 ' + w2.hours + ' 小时。',
          whenDay: '下一次窗口 · ' + rel + ' ' + d.date.slice(5).replace('-', '/'),
          whenTime: pad2(w2.start) + ':00–' + pad2(w2.end) + ':00',
          whenLeft: Math.round(hoursUntil(d.date, w2.start) / 24) + ' 天后',
          /* 结论说「今天不能打」，右侧大号时间和下面四项数值却来自未来，
             不写清楚就会被读成今天的实况。 */
          fromNote: '下面四项是「' + rel + ' ' + d.date.slice(5).replace('-', '/') +
            ' 这个窗口」的预报，不是今天的实况'
        };
      }
    }

    return {
      kind: 'none', day: today, date: today.date, win: null, status: 'bad',
      word: '这七天都不能打',
      why: todayWhy + '。雨前打药会被冲刷，风大会飘到邻地，两种都不值得赌。',
      whenDay: '未来七天', whenTime: '—', whenLeft: ''
    };
  }

  function dewGapOf(d) {
    if (!state.raw || !state.raw.hourly || !d) return '—';
    var hours = T.hoursOf(state.raw.hourly, d.date);
    var h = hours.filter(function (x) { return x.hour >= RULES.spray.hours[0] && x.hour < RULES.spray.hours[1]; })[0];
    if (!h || h.dew === null || h.dew === undefined) return '—';
    return round1(h.temp - h.dew).toFixed(1);
  }

  function irrDecision(result) {
    var d = result.days[0];
    var it = d.irrigation;
    var word = it.status === 'ok' ? '今天不用浇'
      : (it.status === 'warn' ? '该安排浇水了' : '今天别浇');
    return {
      kind: 'today', day: d, date: d.date, win: null,
      status: it.status === 'ok' ? 'ok' : (it.status === 'warn' ? 'warn' : 'bad'),
      word: word, why: it.why,
      whenDay: '今天 ' + d.date.slice(5).replace('-', '/') + ' ' + d.dow,
      whenTime: '日出前后',
      whenLeft: '蒸发最小'
    };
  }

  function harvDecision(result) {
    var d = result.days[0];
    var it = d.harvest;
    var word = it.status === 'ok' ? '今天适合晾晒'
      : (it.status === 'warn' ? '能晒，但效率不高' : '今天别晒');
    return {
      kind: 'today', day: d, date: d.date, win: null,
      status: it.status === 'ok' ? 'ok' : (it.status === 'warn' ? 'warn' : 'bad'),
      word: word, why: it.why,
      whenDay: '今天 ' + d.date.slice(5).replace('-', '/') + ' ' + d.dow,
      whenTime: (d.sunrise && d.sunset) ? (d.sunrise + '–' + d.sunset) : '白天',
      whenLeft: d.daylightH ? '日照 ' + d.daylightH.toFixed(1) + ' 小时' : ''
    };
  }

  function metricsFor(task, dec, result) {
    var d = dec.day, r = RULES.spray;
    if (task === 'spray') {
      var w = dec.win;
      var gap = dewGapOf(d);
      var gapN = gap === '—' ? null : Number(gap);
      return [
        { k: '风速', v: w ? w.avgWind + ' m/s' : '—', j: '上限 ' + r.wind_max, cls: w && w.avgWind > r.wind_max * 0.9 ? 'warn' : 'ok' },
        { k: '降雨概率', v: d.dayProb + '%', j: d.dayProb < 30 ? '低' : '偏高', cls: d.dayProb < 30 ? 'ok' : (d.dayProb < 50 ? 'warn' : 'bad') },
        { k: '露点差', v: gap + '℃', j: gapN === null ? '' : (gapN > r.dew_gap_min ? '叶面干' : '有露水'), cls: gapN === null ? '' : (gapN > r.dew_gap_min ? 'ok' : 'bad') },
        { k: '窗口长度', v: w ? w.hours + ' 小时' : '—', j: w && w.hours >= 4 ? '够长' : '偏短', cls: w && w.hours >= 4 ? 'ok' : 'warn' }
      ];
    }
    if (task === 'irrigation') {
      return [
        { k: '今日降水', v: d.dayRain + ' mm', j: d.dayRain >= 5 ? '够了' : '偏少', cls: d.dayRain >= 5 ? 'ok' : 'warn' },
        { k: '7 天累计', v: result.weekRain + ' mm', j: result.weekRain >= 15 ? '墒情够' : '偏干', cls: result.weekRain >= 15 ? 'ok' : 'warn' },
        { k: '降雨概率', v: d.dayProb + '%', j: d.dayProb >= 70 ? '等雨' : '可浇', cls: d.dayProb >= 70 ? 'bad' : 'ok' },
        { k: '最高气温', v: d.tmax + '℃', j: d.tmax >= 28 ? '蒸发大' : '正常', cls: d.tmax >= 28 ? 'warn' : 'ok' }
      ];
    }
    return [
      { k: '日照时长', v: d.daylightH ? d.daylightH.toFixed(1) + ' h' : '—', j: d.sunHours === null ? '' : (d.sunHours >= 3 ? '够晒' : '不足'), cls: d.sunHours === null ? '' : (d.sunHours >= 3 ? 'ok' : 'warn') },
      { k: '平均云量', v: (d.cloudNoon === null ? '—' : d.cloudNoon + '%'), j: d.cloudNoon === null ? '' : (d.cloudNoon < 50 ? '晴好' : '偏阴'), cls: d.cloudNoon === null ? '' : (d.cloudNoon < 50 ? 'ok' : 'warn') },
      { k: '降雨概率', v: d.dayProb + '%', j: d.dayProb >= 50 ? '要盖' : '无雨', cls: d.dayProb >= 50 ? 'bad' : 'ok' },
      { k: '最高气温', v: d.tmax + '℃', j: d.tmax < 8 ? '效率低' : '可以', cls: d.tmax < 8 ? 'warn' : 'ok' }
    ];
  }

  function renderDecision(result, task) {
    var box = $('decision');
    if (!box) return;
    var dec = task === 'spray' ? sprayDecision(result)
      : (task === 'irrigation' ? irrDecision(result) : harvDecision(result));

    /* 重写状态类时保留天气类（applyWeatherTheme 写入的 wx-*），否则换地块瞬间背景会闪回默认 */
    var wxKeep = (box.className.match(/\bwx-[a-z]+\b/) || [''])[0];
    box.className = 'decision st-' + (dec.status === 'ok' ? 'ok' : (dec.status === 'warn' ? 'warn' : 'bad')) +
      (wxKeep ? ' ' + wxKeep : '');

    if ($('dWord')) $('dWord').textContent = dec.word;
    if ($('dWhy')) $('dWhy').textContent = dec.why;
    if ($('dDay')) $('dDay').textContent = dec.whenDay || '';
    if ($('dTime')) $('dTime').textContent = dec.whenTime || '';
    if ($('dLeft')) $('dLeft').textContent = dec.whenLeft || '';
    if ($('dFrom')) {
      $('dFrom').textContent = dec.fromNote || '';
      $('dFrom').style.display = dec.fromNote ? '' : 'none';
    }

    var n = new Date();
    if ($('dMeta')) {
      var city = activePlot() ? activePlot().city : '';
      var eff = window.TianZhiStandards ? window.TianZhiStandards.effective(city) : null;
      var stdTx = eff && eff.cityName ? eff.cityName + '属地标准' : '省级标准';
      $('dMeta').textContent = stdTx + ' · ' + pad2(n.getHours()) + ':' + pad2(n.getMinutes()) + ' 更新';
    }
    /* 顶栏日期原先由旧天象头写入，v5 删掉天象头后会一直停在「—」，在这里补回来 */
    if ($('todayDate')) {
      var dow0 = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][n.getDay()];
      $('todayDate').textContent = (n.getMonth() + 1) + '月' + n.getDate() + '日 ' + dow0;
    }

    if ($('dMetrics')) {
      $('dMetrics').innerHTML = metricsFor(task, dec, result).map(function (m) {
        return '<div class="d-metric"><span>' + esc(m.k) + '</span><b>' + esc(m.v) + '</b>' +
          (m.j ? '<i class="' + (m.cls || '') + '">' + esc(m.j) + '</i>' : '') + '</div>';
      }).join('');
    }

    renderLogLine(task);
  }

  /* ---- 作业记录：本机留痕，用来回答"上次打药是几天前" ---- */
  function loadLogs() {
    try { return JSON.parse(localStorage.getItem('tz_logs') || '[]'); } catch (e) { return []; }
  }
  function saveLogs(list) {
    try { localStorage.setItem('tz_logs', JSON.stringify(list.slice(-40))); } catch (e) {}
  }
  function renderLogLine(task) {
    var line = $('dLogLine');
    if (!line) return;
    var logs = loadLogs().filter(function (x) { return x.task === task; });
    var names = { spray: '打药', irrigation: '灌溉', harvest: '晾晒' };
    if (!logs.length) {
      line.innerHTML = '<b>' + names[task] + '</b> 还没有记录，干完点一下左边的按钮。';
      return;
    }
    var last = logs[logs.length - 1];
    var d0 = new Date(last.date + 'T00:00:00');
    var days = Math.round((new Date(new Date().toDateString()) - new Date(d0.toDateString())) / 86400000);
    var when = days <= 0 ? '今天' : (days === 1 ? '昨天' : days + ' 天前');
    line.innerHTML = '<b>上次' + names[task] + '</b> ' + when + '（' + last.date.slice(5).replace('-', '/') + '）' +
      ' · 记录只存在这台设备' +
      ' <button type="button" id="dLogUndo">撤销</button>';
    var u = $('dLogUndo');
    if (u) u.onclick = function () {
      var all = loadLogs();
      all.splice(all.lastIndexOf(last), 1);
      saveLogs(all);
      renderLogLine(task);
    };
  }

  /* =========================================================
     L2 未来七天：一条条带
     -------------------------------------------------------------
     七张卡要横滑、要逐张读；一条条带能一眼看出"这周哪两天能干活"。
     ========================================================= */
  function renderWeek(result, task) {
    var strip = $('weekStrip');
    if (!strip) return;
    var today = result.days[0].date;
    var dec = task === 'spray' ? sprayDecision(result)
      : (task === 'irrigation' ? irrDecision(result) : harvDecision(result));
    /* 首次进入时，详情跟决策卡指向同一天，避免"上面说周六、下面讲今天"。
       注意：只在「还没有选中日期」时才自动选——以前这里判断
       `state.chartDay === today` 也归零，导致用户点「今天」又被弹到周五。 */
    var valid = state.chartDay && result.days.some(function (d) {
      return d.date === state.chartDay;
    });
    if (!valid) {
      state.chartDay = (dec.kind === 'future' && dec.date) ? dec.date : today;
    }
    var sel = state.chartDay;
    var names = { spray: '打药', irrigation: '灌溉', harvest: '晾晒' };
    if ($('wkTitle')) $('wkTitle').textContent = names[task] + '的窗口分布';
    if ($('wkSub')) {
      $('wkSub').textContent = task === 'spray'
        ? '色块是当天可作业的时段，位置对应钟点'
        : '整格颜色代表当天是否适合' + names[task];
    }
    /* 这行原先由已删除的「今日判读」卡写入，v5 后一直空着 */
    if ($('weekRainNote')) $('weekRainNote').textContent = '一周累计雨量 ' + result.weekRain + ' mm';
    /* 图例必须跟当前任务一致：打药只有「可作业 / 无窗口」两态，
       挂着一个用不上的「勉强」色块，会让人以为漏判了一档。 */
    if ($('wkLegend')) {
      $('wkLegend').innerHTML = task === 'spray'
        ? '<i><s style="background:#0E6B4A"></s>可作业</i>' +
          '<i><s class="none"></s>无窗口</i>'
        : '<i><s style="background:#0E6B4A"></s>适合</i>' +
          '<i><s style="background:#C0811A"></s>勉强</i>' +
          '<i><s style="background:#EBCFC9"></s>不宜</i>';
    }

    strip.innerHTML = result.days.map(function (d, i) {
      var dt = new Date(d.date + 'T00:00:00');
      var item = d[task] || {};
      var isToday = d.date === today;
      var inner = '', note = '';

      if (task === 'spray') {
        var w = longestWin(d.spray.windows);
        if (d.spray.status === 'ok' && w) {
          var from = 6, span = 12;                     // 条带覆盖 6–18 时
          var l = Math.max(0, (w.start - from) / span * 100);
          var wd = Math.min(100 - l, (w.end - w.start) / span * 100);
          inner = '<div class="wk-fill" style="left:' + l.toFixed(1) + '%;width:' + Math.max(6, wd).toFixed(1) + '%"></div>';
          note = pad2(w.start) + '–' + pad2(w.end);
        } else {
          /* 不画块：空白就是"这天没有窗口"，比给一条灰色更像"没有" */
          inner = '';
          note = d.spray.blocked ? '雨阻' : '无窗口';
        }
      } else {
        var st = item.status;
        var cls = st === 'ok' ? '' : (st === 'warn' ? ' warn' : ' bad');
        inner = '<div class="wk-fill' + cls + '" style="left:0;width:100%"></div>';
        note = st === 'ok' ? '可以' : (st === 'warn' ? '勉强' : '不宜');
      }

      return '<button type="button" class="wk' + (d.date === sel ? ' sel' : '') +
          (inner ? ' has' : '') +
          (task === 'spray' && !inner && d.spray.blocked ? ' st-rain' : '') +
          '" data-date="' + d.date + '">' +
        '<span class="wk-dow"><b>' + (isToday ? '今天' : d.dow) + '</b>' +
          (dt.getMonth() + 1) + '/' + dt.getDate() + '</span>' +
        '<span class="wk-slot">' + inner + '</span>' +
        '<span class="wk-note">' + note + '</span>' +
      '</button>';
    }).join('');

    Array.prototype.forEach.call(strip.querySelectorAll('.wk'), function (b) {
      b.onclick = function () {
        state.chartDay = b.getAttribute('data-date');
        renderWeek(state.result, state.task || 'spray');
        renderCharts();
        renderDayDetail(state.result, state.task || 'spray', state.chartDay);
      };
    });

    renderDayDetail(result, task, sel);
  }

  function renderDayDetail(result, task, date) {
    var box = $('weekDay');
    if (!box) return;
    var d = result.days.filter(function (x) { return x.date === date; })[0] || result.days[0];
    var dt = new Date(d.date + 'T00:00:00');
    var item = d[task] || {};
    var cells;
    if (task === 'spray') {
      var w = longestWin(d.spray.windows);
      cells = [
        ['可作业时段', w ? pad2(w.start) + '–' + pad2(w.end) : '无'],
        ['平均风速', w ? w.avgWind + ' m/s' : d.windMax + ' m/s'],
        ['降雨概率', d.dayProb + '%'],
        ['日落 / 收工', (d.sunset || '—') + ' / ' + d.spray.hours[1] + ' 时']
      ];
    } else if (task === 'irrigation') {
      cells = [
        ['当日降水', d.dayRain + ' mm'],
        ['降雨概率', d.dayProb + '%'],
        ['最高气温', d.tmax + '℃'],
        ['7 天累计', result.weekRain + ' mm']
      ];
    } else {
      cells = [
        ['日照 / 白天', (d.sunHours === null ? '—' : d.sunHours + ' h') + ' / ' + (d.daylightH ? d.daylightH.toFixed(1) + ' h' : '—')],
        ['平均云量', d.cloudNoon === null ? '—' : d.cloudNoon + '%'],
        ['当日降水', d.dayRain + ' mm'],
        ['最高气温', d.tmax + '℃']
      ];
    }
    box.innerHTML =
      '<div class="wd-h"><b>' + (dt.getMonth() + 1) + ' 月 ' + dt.getDate() + ' 日 ' + d.dow + '</b>' +
        '<span>' + (d.weather || '—') + ' · ' + d.tmax + '° / ' + d.tmin + '° · 日出 ' + (d.sunrise || '—') + '</span></div>' +
      '<div class="wd-grid">' + cells.map(function (c) {
        return '<div class="wd-cell"><span>' + esc(c[0]) + '</span><b>' + esc(c[1]) + '</b></div>';
      }).join('') + '</div>' +
      '<div class="wd-why">' + esc(item.why || '') + '</div>';
  }

  function bindDecision() {
    var tabs = $('dTabs');
    if (tabs && !tabs.__bound) {
      tabs.__bound = true;
      Array.prototype.forEach.call(tabs.querySelectorAll('button'), function (b) {
        b.onclick = function () {
          var t = b.getAttribute('data-task');
          if (state.task === t) return;
          state.task = t;
          Array.prototype.forEach.call(tabs.querySelectorAll('button'), function (x) {
            x.classList.toggle('on', x === b);
          });
          if (state.result) {
            renderDecision(state.result, t);
            renderWeek(state.result, t);
            renderCharts();
          }
        };
      });
    }
    if ($('dLogBtn') && !$('dLogBtn').__bound) {
      $('dLogBtn').__bound = true;
      $('dLogBtn').onclick = function () {
        var task = state.task || 'spray';
        var logs = loadLogs();
        logs.push({ task: task, date: todayStr(), at: new Date().toISOString() });
        saveLogs(logs);
        renderLogLine(task);
        toast('已记下：' + todayStr().slice(5).replace('-', '/') + ' ' +
          ({ spray: '打药', irrigation: '灌溉', harvest: '晾晒' })[task]);
      };
    }
    if ($('dBasisBtn') && !$('dBasisBtn').__bound) {
      $('dBasisBtn').__bound = true;
      $('dBasisBtn').onclick = function () {
        var p = $('basisPanel');
        if (p) {
          p.open = true;
          if (p.scrollIntoView) p.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } else {
          openBasis();
        }
      };
    }
  }

  function todayStr() {
    var n = new Date();
    return n.getFullYear() + '-' + pad2(n.getMonth() + 1) + '-' + pad2(n.getDate());
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
  /* v5：错误态也用决策页的骨架。
     旧版第一行就写 $('heroIn')，那个 DOM 在 v5 已删除，会直接抛错——
     连「重新获取」按钮都渲染不出来，用户只能刷新页面。 */
  function renderError(msg) {
    var isFile = location.protocol === 'file:';
    var box = $('alerts');
    if (box) {
      box.innerHTML =
        '<div class="cbox" style="padding:14px 16px;border-color:#E3B7AE">' +
          '<img class="err-art" src="img/empty-offline.webp" alt="" loading="lazy" onerror="this.style.display=\'none\'">' +
          '<b style="font-size:13px;color:#8C3025">暂时取不到天气数据 · 需要联网才能使用</b>' +
          '<p style="margin:6px 0 8px;font-size:11.5px;color:var(--text-2);line-height:1.6">' + esc(msg || '') + '</p>' +
          '<div style="font-size:11px;color:var(--text-2);line-height:1.85">' +
            '可以这样处理：<br>1. 检查设备是否连上网络<br>' +
            '2. 用了代理 / 校园网时，先关掉再试<br>' +
            '3. 点下面的「重新获取」' +
            (isFile ? '<br>当前是双击打开（file://）模式，也可以双击 start.bat 用本地服务打开。' : '') +
          '</div>' +
          '<button class="btn" id="retryBtn" type="button" style="margin-top:10px">重新获取</button>' +
        '</div>';
    }
    if ($('dWord')) $('dWord').textContent = '等待实时天气';
    if ($('dWhy')) $('dWhy').textContent = '结论必须由实时气象算出，没有数据就不猜。原因与重试入口在上面。';
    if ($('dMeta')) $('dMeta').textContent = '未更新';
    if ($('dFrom')) { $('dFrom').textContent = ''; $('dFrom').style.display = 'none'; }
    ['dDay', 'dTime', 'dLeft', 'dMetrics', 'weekStrip', 'weekDay', 'nowStrip', 'proSum', 'proTable']
      .forEach(function (k) { var el = $(k); if (el) el.innerHTML = ''; });
    ['windChart', 'heatChart', 'tempChart', 'growthChart'].forEach(function (k) {
      var el = $(k);
      if (el) el.innerHTML = '<div class="chart-note">暂无数据</div>';
    });
    var rb = $('retryBtn');
    if (rb) rb.onclick = function () { load(); };
  }

  /* =========================================================
     加载
     ========================================================= */

  /** 侧栏底部：如实写出这一次的数据到底来自谁 */
  function updateFootSources(w) {
    var el = $('footWeather');
    if (!el) return;
    var s = (w && w.sources) || [];
    var main = s.indexOf('qweather') >= 0 ? '和风天气'
      : (s.indexOf('open-meteo') >= 0 ? 'Open-Meteo' : '未知数据源');
    var extra = [];
    if (s.indexOf('ensemble') >= 0) extra.push('集合');
    if (s.indexOf('multi-model') >= 0) extra.push('多模式');
    
    el.textContent = main + (extra.length ? ' + ' + extra.join('/') : '');
  }

  function load() {
    var plot = activePlot();
    if (!plot) return;

    /* 换地块 = 换属地：自动模式必须跟着地块的市重套标准，
       否则在石家庄看到的窗口，搬到邯郸还是同一套阈值。 */
    if (S) {
      var std = S.get('standard');
      if (std.mode !== 'manual' && (plot.city || '') !== (std.city || '')) {
        S.save('standard', { city: plot.city || '' });
        S.applyRules(plot.city || '');
        if (currentView === 'mine') renderStandard();
      }
    }

    state.loading = true;
    state.result = null;
    $('tbTitle').textContent = plot.name + ' · ' + CROP_NAME[plot.crop];
    $('tbSub').textContent = placeText(plot) + ' · 华北平原';
    setStatus('busy', '正在获取天气…');
    $('refreshBtn').classList.add('spin');

    fetchWeather(plot.lat, plot.lon).then(function (w) {
      if (!w.hourly || !w.daily) throw new Error('返回数据不完整');
      state.raw = w;
      updateFootSources(w);
      state._ensKey = plot.lat.toFixed(3) + ',' + plot.lon.toFixed(3) + ',' + (w.hourly.time[0] || '');
      state._ensCache = null;
      var result = T.evaluateWeather(w.hourly, w.daily);
      state.result = result;
      if (!state.chartDay || !result.days.some(function (d) { return d.date === state.chartDay; })) {
        /* 晚上打开时今天只剩一两个小时，图会像"没画"。此时默认看明天，
           7 天卡片也会跟着高亮明天，不会出现"选今天、图是明天"的错位。 */
        var hToday = T.hoursOf(w.hourly, result.days[0].date).filter(function (h) {
          return h.hour >= RULES.spray.hours[0] && h.hour < RULES.spray.hours[1] && h.hour >= new Date().getHours();
        });
        state.chartDay = (hToday.length < 2 && result.days[1]) ? result.days[1].date : result.days[0].date;
      }

      $('tbSub').textContent = placeText(plot) +
        ' · ' + plot.lat.toFixed(2) + '°N ' + plot.lon.toFixed(2) + '°E';
      applyWeatherTheme(result.days[0].weather_code, result.days[0].windMax);
      state.task = state.task || 'spray';
      renderDecision(result, state.task);
      renderWeek(result, state.task);
      renderCharts();
      renderAlerts(result);
      renderNowStrip(result);
      bindDecision();
      renderSolarTerm();
      renderSeasonBanner();

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

  /* =========================================================
     地名显示："市名 · 村名"
     -------------------------------------------------------------
     老数据里 place 存的是县级名（"保定市"），新数据存的是最细的
     可用名称（村名，退而求其次乡镇名）。两种都要能正确显示，
     所以判断"谁包含谁"而不是简单拼接。
     ========================================================= */
  function placeText(p) {
    if (!p) return '';
    var sub = (p.place || '').trim();
    var city = (p.city || '').trim();

    if (sub && city && sub !== city && sub.indexOf(city) !== 0) {
      return city + ' · ' + sub;
    }
    return sub || city || '未命名';
  }

  /** WGS-84 坐标反查地名（供启动迁移、无地图时使用） */
  function placeLabel(lon, lat) {
    var c = locateCounty(lon, lat);
    return c ? displayName(c) : null;
  }

  /* =========================================================
     精确地名（村 / 乡镇）：在线反查
     -------------------------------------------------------------
     为什么分两步走：
       点击的瞬间先用本地县界给出"县名"，界面立刻有反馈；
       同时后台去问高德（能到村）和 BigDataCloud（能到乡镇），
       谁更细就用谁的结果把"已选地点"升级一次。

     为什么不直接等在线结果：
       在线反查要 300–1500ms，让"已选地点"空着等它，
       用户会以为没点成功，然后再点一次。体验上不能这么做。
     ========================================================= */
  var PLACE_SEQ = 0;

  var PRECISION_TAG = {
    poi: '精确到地点',
    village: '精确到村',
    township: '精确到乡镇/街道',
    county: '仅到区县',
    city: '仅到市'
  };

  function resolveFinePlace(lon, lat) {
    if (!window.TianZhiPlace) return Promise.resolve(null);
    return window.TianZhiPlace.resolve(lon, lat, {
      // 高德 SDK 加载好才用得上；没加载就只走 BigDataCloud
      AMap: window.AMap || null,
      amapWebKey: (window.TIANZHI_CONFIG && window.TIANZHI_CONFIG.amapWebKey) || '',
      toGcj: function (lo, la) {
        try { return T.wgs84ToGcj(lo, la); } catch (e) { return [lo, la]; }
      }
    }).catch(function () { return null; });
  }

  /** 用更细的结果更新界面（只更新仍在同一坐标上的选择） */
  function applyFinePlace(fine, lon, lat) {
    if (!fine || !fine.label) return;
    if (Math.abs(form.lon - lon) > 1e-6 || Math.abs(form.lat - lat) > 1e-6) return;

    if (fine.sub) form.place = fine.sub;
    if (fine.city) form.city = fine.city;
    form.village = fine.village || '';
    form.precision = fine.precision;

    // 用户是从"附近地点"里挑的，就别用村镇名盖掉他选的那一条
    if (form.poiLock && form.poiLock.name) {
      var pl = form.poiLock;
      var city = fine.city || form.city || '';
      $('fHint').className = 'hint';
      $('fHint').textContent = '已选地点：' + (city ? city + ' · ' : '') + pl.name +
        (pl.distance != null ? '（' + pl.distance + ' 米）' : '');
      $('mapRead').innerHTML = '已选点：<span class="loc">' + pl.name + '</span>';
      return;
    }

    var tag = PRECISION_TAG[fine.precision];
    var suffix = tag ? '（' + tag + '）' : '';

    $('fHint').className = 'hint';
    $('fHint').textContent = '已选地点：' + fine.label + suffix;
    $('mapRead').innerHTML = '已选点：<span class="loc">' + fine.label + '</span>';

    // 高德服务不可用（例如安全密钥不匹配）时，说明白为什么只到乡镇
    if (!fine.village && fine.error && /SCODE|KEY/i.test(fine.error)) {
      $('fHint').className = 'hint warn';
      $('fHint').textContent = '已选地点：' + fine.label +
        '（高德定位服务鉴权失败，暂时只能到乡镇）';
      if (window.console) console.warn('[打药窗] 高德逆地理编码失败：' + fine.error);
    }
  }

  /** 触发一次在线精确化，结果回来时只认最后一次点击 */
  function kickFinePlace(lon, lat) {
    var seq = ++PLACE_SEQ;
    return resolveFinePlace(lon, lat).then(function (fine) {
      if (seq !== PLACE_SEQ) return;      // 期间又点了别处
      applyFinePlace(fine, lon, lat);
    });
  }

  /** 地名里是否已经是"细粒度"（村/乡镇），用于决定要不要提示升级中 */
  function isFineName(s) {
    return /(村|庄|屯|营|寨|沟|铺|集|堡|街道|镇|乡)$/.test(s || '');
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
      setMapLayer('road');   // 默认路网：先看清村道、地块边界与周边参照，再切卫星

      /* 弹窗先开、地图后到时，把之前记下的中心点补上 */
      if (MAP.pending) {
        var pd = MAP.pending; MAP.pending = null;
        setTimeout(function () {
          mapCenterOn(pd.lon, pd.lat, pd.zoom, pd.dur);
          drawMarker(pd.lat, pd.lon);
        }, 60);
      }

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
    if (MAP.instance) {
      var c = MAP.instance.getCenter();
      onMapPick(c.getLng(), c.getLat());
      return true;
    }
    /* 高德不可用时，本地示意图同样能点选取点；测试钩子也走同一条链路，
       免得「降级后取点功能是否存在」永远没人验证。 */
    var svg = $('fallbackSvg');
    if (svg && svg.onclick) {
      var r = svg.getBoundingClientRect();
      svg.onclick({ clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 });
      return true;
    }
    return false;
  };

  /* ---------- 点击取点：GCJ-02 → WGS-84 ---------- */
  function onMapPick(gLng, gLat) {
    /* 地图点选是这一步的主操作：先把软键盘收起来，
       否则手机上键盘会一直压在表单上，看不到刚选的位置。 */
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
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
      ? '已选地点：' + describePlace(loc) + '（正在识别精确位置…）'
      : '已选地点：' + lat.toFixed(2) + '°N, ' + lon.toFixed(2) + '°E';

    // 后台补一次更细的地名（村名或具体地点，取不到就退回乡镇）
    kickFinePlace(lon, lat);

    drawMarker(lat, lon);
    drawPlotMarkers();
    flyToPoint(lon, lat, 560);   // 点一下就把镜头推到这块地，不是留在原地
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

  function drawLineSet(rings, kind) {
    if (!MAP.instance || !window.AMap || !MAP._lines) return;
    var AMap = window.AMap;
    var ST = {
      prov: { c: '#41694f', w: 1.8, o: 0.55, z: 90 },
      city: { c: '#5d7b63', w: 1.0, o: 0.38, z: 85 },
      county: { c: '#94a3b8', w: 0.8, o: 0.32, z: 80 }
    }[kind];
    rings.forEach(function (ring) {
      if (!ring || ring.length < 3) return;
      var path = [];
      /* DataV 的边界坐标本身就是 GCJ-02（与高德底图同源：省界 bbox 与高德
         District API 差 < 0.0001°）。以前在这又转了一次 WGS→GCJ，
         整条边界会整体偏移约 500 m——「边缘线不对」就是它。直接用原坐标。 */
      for (var i = 0; i < ring.length; i++) path.push(new AMap.LngLat(ring[i][0], ring[i][1]));
      var pl = new AMap.Polyline({
        path: path,
        strokeColor: ST.c,
        strokeWeight: ST.w,
        strokeOpacity: ST.o,
        lineJoin: 'round',
        zIndex: ST.z,
        bubble: true
      });
      MAP.instance.add(pl);
      MAP._lines[kind].push(pl);
    });
  }

  /** 边界按缩放分层：省级一直有、市级 ≥9、县级 ≥12，避免一层网格糊在图上 */
  function syncBoundaryZoom() {
    if (!MAP.instance || !MAP._lines || !GEO) return;
    var z = MAP.instance.getZoom();
    if (z >= 9 && !MAP._lines.city.length) {
      GEO.cities.forEach(function (ct) { drawLineSet(ct.rings, 'city'); });
    }
    if (z >= 12 && !MAP._lines.county.length) {
      GEO.counties.forEach(function (c) { drawLineSet(c.rings, 'county'); });
    }
    var vis = { prov: z < 10, city: z >= 9 && z < 12, county: z >= 12 };
    Object.keys(vis).forEach(function (k) {
      MAP._lines[k].forEach(function (p) {
        try { vis[k] ? p.show() : p.hide(); } catch (e) { /* 忽略 */ }
      });
    });
  }

  function addBoundaries() {
    if (boundaryAdded || !MAP.instance) return;
    boundaryAdded = true;
    MAP._lines = { prov: [], city: [], county: [] };
    try {
      drawLineSet(GEO.province, 'prov');
      syncBoundaryZoom();
      MAP.instance.on('zoomend', syncBoundaryZoom);
    } catch (e) {
      console.warn('[打药窗] 本地边界绘制失败：', e.message);
    }
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
    /* 本地示意地图没有卫星图层：这时把「路网/卫星」藏起来，
       否则点了没反应、还高亮成卫星，比没有按钮更让人困惑。 */
    var layers = document.querySelector('.map-layers');
    if (layers) layers.style.display = MAP.failed ? 'none' : '';
    if (MAP.failed) {
      el.textContent = '本地示意地图 · 可点选';
      el.title = '高德地图未加载，已自动切换为本地行政区划示意图；点选与地点搜索照常可用';
    } else if (MAP.ready) {
      el.textContent = '高德地图 · 河北';
      el.title = '';
    } else {
      el.textContent = '地图加载中…';
      el.title = '';
    }
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
    /* 降级后标签也要跟着改，否则用户看到示意图却一直显示「地图加载中…」 */
    if (MAP.failed) { updateMapMode(); renderFallbackMap(sel); return; }

    var center = sel ? [sel.lon, sel.lat] : [116.30, 39.05];
    initAMap(center, sel ? 12 : 9).then(function () {
      updateMapMode();
      if (sel) {
        drawMarker(sel.lat, sel.lon);
        // 直接落到「已选点」上；12 级能看清村道与地块轮廓，又不会糊成一片
        MAP.instance.setCenter(T.wgs84ToGcj(sel.lon, sel.lat));
        var z = MAP.instance.getZoom();
        if (z < 10 || z > 15) MAP.instance.setZoom(12);
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
      console.warn('[打药窗] 高德地图不可用，已降级：', err.message);
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
    bindSheetDrag();
    bindViewport();

    // 预加载 SDK：打开弹窗时就后台开始拉取，
    // 这样用户点"展开地图"时基本已经就绪（避免首屏多等 1-2 秒）
    loadAMap().catch(function (err) {
      MAP.failed = true;
      updateMapMode();
      console.warn('[打药窗] 高德 SDK 预加载失败：', err.message);
    });
  }

  function pickSel() {
    return form.lat ? { lat: form.lat, lon: form.lon } : null;
  }

  /**
   * 把高德地图视野移到指定 WGS-84 坐标
   * （入参为 WGS-84，内部自动转 GCJ-02）
   */
  /**
   * 地图移动
   * @param {number} dur 毫秒；给了就走平滑运镜（setZoomAndCenter 的第 3 个参数
   *                     immediately=false + duration），不给就是瞬移
   */
  function mapCenterOn(lon, lat, zoom, dur) {
    /* 打开弹窗时高德可能还没加载完：先记下来，等实例就绪再落点，
       否则「已选点」在衡水、地图却停在北京附近。 */
    if (!MAP.instance || !T || !T.wgs84ToGcj) {
      MAP.pending = { lon: lon, lat: lat, zoom: zoom, dur: dur };
      return;
    }
    try {
      var m = MAP.instance;
      var gc = T.wgs84ToGcj(lon, lat);
      if (dur && m.setZoomAndCenter) {
        var z = zoom || m.getZoom();
        if (m.getMaxZoom) z = Math.min(z, m.getMaxZoom());
        m.setZoomAndCenter(z, gc, false, dur);   // 平滑推近，不是瞬间跳
      } else {
        m.setCenter(gc);
        if (zoom) m.setZoom(zoom);
      }
    } catch (e) { /* 地图未就绪时忽略 */ }
  }

  /** 点选后"推镜头"到这块地：放大到最大级别，带缓动 */
  function flyToPoint(lon, lat, dur) {
    if (!MAP.instance) return;
    var z = 18;
    try {
      if (MAP.instance.getMaxZoom) z = MAP.instance.getMaxZoom();
      if (z > 18) z = 18;          // 再高底图就糊成马赛克了
      if (z < 16) z = 16;
    } catch (e) { z = 17; }
    mapCenterOn(lon, lat, z, dur || 620);
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
    // 从别处重新选点时，之前"选中的附近地点"作废
    if (form.source !== 'poi') form.poiLock = null;

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

    // 后台把"县名"升级成"村名/乡镇名"，回来时自己更新界面
    if (!isFineName(form.place)) {
      $('fHint').textContent = '已选地点：' + desc + '（正在识别到村…）';
    }
    kickFinePlace(lon, lat);
    // 从列表里选的点不重拉列表，否则刚选中的高亮会被刷新掉
    if (form.source !== 'poi') refreshNearby(lon, lat);
  }

  /* =========================================================
     附近地点（仿腾讯地图选点）
     restapi/v3/place/around 给出 1 公里内按距离排序的 POI，
     点一条直接把地块坐标挪过去，名字也顺手填好。
     ========================================================= */
  var NEARBY = { items: [], sel: -1, seq: 0 };

  function placeOpts() {
    var cfg = window.TIANZHI_CONFIG || {};
    return {
      amapWebKey: cfg.amapWebKey || '',
      city: form.city || '',
      radius: 1000,
      toGcj: function (lo, la) {
        try { return T.wgs84ToGcj(lo, la); } catch (e) { return [lo, la]; }
      }
    };
  }

  function refreshNearby(lon, lat) {
    var box = $('nearbyList');
    if (!box || !window.TianZhiPlace || !window.TianZhiPlace.around) return;
    NEARBY.sel = -1;
    var seq = ++NEARBY.seq;
    box.innerHTML = '<div class="nearby-empty">正在找周边地点…</div>';

    window.TianZhiPlace.around(lon, lat, placeOpts()).then(function (r) {
      if (seq !== NEARBY.seq) return;             // 快速连点时只认最后一次
      if (!r.list.length) {
        box.innerHTML = '<div class="nearby-empty">' +
          (r.error ? '周边地点加载失败（' + esc(r.error) + '）' : '这一带 1 公里内没有可识别的地点') +
          '</div>';
        return;
      }
      NEARBY.items = r.list;
      renderNearbyList();
    });
  }

  function searchNearby(kw) {
    var box = $('nearbyList');
    if (!box) return;
    var seq = ++NEARBY.seq;
    NEARBY.sel = -1;
    box.innerHTML = '<div class="nearby-empty">正在搜索…</div>';

    window.TianZhiPlace.searchPoi(kw, form.lon, form.lat, placeOpts()).then(function (r) {
      if (seq !== NEARBY.seq) return;
      if (!r.list.length) {
        box.innerHTML = '<div class="nearby-empty">没搜到「' + esc(kw) + '」，换个词试试</div>';
        return;
      }
      NEARBY.items = r.list;
      renderNearbyList();
    });
  }

  function renderNearbyList() {
    var box = $('nearbyList');
    if (!box) return;
    box.innerHTML = NEARBY.items.map(function (p, i) {
      var d = p.distance == null ? '' : (p.distance >= 1000 ? (p.distance / 1000).toFixed(1) + 'km' : p.distance + 'm');
      var meta = [d, p.area, p.address || p.type].filter(Boolean).join(' · ');
      return '<button class="nb-item' + (i === NEARBY.sel ? ' on' : '') + '" data-i="' + i + '">' +
        '<span class="nb-main"><span class="nb-name">' + esc(p.name) + '</span>' +
        '<span class="nb-meta">' + esc(meta) + '</span></span>' +
        '<span class="nb-dist">' + (i === NEARBY.sel ? '已选' : '选') + '</span>' +
      '</button>';
    }).join('');
  }

  function selectNearby(i) {
    var p = NEARBY.items[i];
    if (!p || p.lng == null || p.lat == null) return;
    NEARBY.sel = i;
    renderNearbyList();

    var w = T.gcjToWgs84(p.lng, p.lat);
    form.poiLock = { name: p.name, distance: p.distance };
    setFormPlace(p.name, w[0], w[1], p.area, 'poi');
    if (MAP.instance) drawMarker(w[1], w[0]);
    flyToPoint(w[0], w[1], 600);
    $('fHint').textContent = '已选地点：' + (form.city ? form.city + ' · ' : '') + p.name +
      (p.distance != null ? '（' + p.distance + ' 米）' : '');
  }

  function bindNearby() {
    var box = $('nearbyList');
    if (box) {
      box.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('.nb-item') : null;
        if (!b) return;
        selectNearby(Number(b.getAttribute('data-i')));
      });
    }
    var kw = $('nearbyKw');
    if (kw) {
      var timer = null;
      kw.addEventListener('input', function () {
        clearTimeout(timer);
        var v = kw.value.trim();
        timer = setTimeout(function () {
          if (!form || form.lon == null) return;
          if (v) searchNearby(v); else refreshNearby(form.lon, form.lat);
        }, 420);
      });
    }
  }

  /* 锁滚动时把滚动条宽度补回去，否则页面会横向抖一下 */
  function lockBody(on) {
    var b = document.body;
    if (on) {
      var sw = window.innerWidth - document.documentElement.clientWidth;
      b.dataset.padRight = b.style.paddingRight || '';
      if (sw > 0) b.style.paddingRight = sw + 'px';
      b.style.overflow = 'hidden';
    } else {
      b.style.overflow = '';
      b.style.paddingRight = b.dataset.padRight || '';
    }
  }

  function openModal(plot) {
    state.editing = plot || null;
    $('modalTitle').textContent = plot ? '编辑地块' : '新增地块';
    $('fName').value = plot ? plot.name : '';
    $('fArea').value = plot ? plot.area : 10;
    $('fCrop').value = plot ? plot.crop : 'wheat';
    $('fLoc').value = '';
    $('fResults').innerHTML = '';
    var body0 = document.querySelector('.plot-modal .modal-body');
    if (body0) body0.scrollTop = 0;
    SHEET.detent = 'peek';

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

    /* 手机：地图铺满整屏 + 表单抽屉默认停在 peek（地图为主，看得见自己的地）。
       桌面：卡片布局，setSheetDetent 会移除位移，地图在上、表单在下。 */
    bindMapStage();
    bindViewport();          // 先量一次可视视口：抽屉档位、水印锚点都按它算
    syncViewport();
    mapCenterOn(base.lon, base.lat, plot ? 13 : 12);
    lockBody(true);
    $('plotMask').classList.add('on');
    // 弹窗出现后才有真实尺寸：重绘地图，并把抽屉落到默认档位
    setTimeout(function () {
      renderMap({ lat: base.lat, lon: base.lon });
      if (MAP.instance) MAP.instance.resize();
      setSheetDetent('peek', false);
      updateMapWatermark();
    }, 80);
    /* 手机端不自动聚焦名称：弹窗一开就弹键盘，会把地图挡掉一半，
       而这一步真正要做的是先在地图上点自己的地。桌面端保留聚焦方便直接输入。 */
    if (window.innerWidth >= 900) {
      setTimeout(function () { $('fName').focus(); }, 60);
    }
  }

  function closeModal() {
    $('plotMask').classList.remove('on');
    SHEET.detent = 'peek';
    var s = $('plotSheet');
    if (s) { s.classList.remove('dragging'); s.style.removeProperty('--sheet-y'); }
    lockBody(false);
    state.editing = null;
  }

  /**
   * 高德式底部抽屉：手机上是「地图铺满 + 可拖拽表单抽屉」。
   * 抽屉贴底，用 --sheet-y（距顶的位移，px）在三个档位间移动：
   *   form 表单展开 / peek 默认（地图为主）/ map 地图最大化；
   * 继续下拉超过阈值则关闭。桌面端不启用（卡片布局，--sheet-y 被移除）。
   */
  var SHEET = { detent: 'peek', y: 0 };

  /* ---------- 视觉视口：手机键盘的真相 ----------
     键盘弹起时 Android（interactive-widget=resizes-content）会缩「布局视口」，
     iOS 只缩「视觉视口」，布局视口和内联的 100dvh 都不动 —— 抽屉就被键盘顶出屏幕、
     表单输入框与水印互相错位。统一把 visualViewport 的实时高度/偏移写进
     --vvh / --vv-top，CSS 用它们钉住弹窗，抽屉、水印、输入框便一起跟着键盘走。 */
  var VV = { h: 0, top: 0 };
  function sheetVh() { return VV.h || window.innerHeight || 640; }
  function isSheetMobile() {
    return window.matchMedia && window.matchMedia('(max-width:640px)').matches;
  }
  function detentPx(name) {
    var vh = sheetVh();
    /* 抽屉是整屏高、靠位移下移，所以这里的值就是「屏幕顶部留出的地图高度」 */
    if (name === 'form') return Math.round(vh * 0.14);
    if (name === 'map') return Math.round(vh * 0.74);
    return Math.round(vh * 0.50);              // peek
  }
  /* 水印锚在「抽屉上沿之上」的可见地图条里：既不会被抽屉盖住（合规要看得到），
     也不会隔着半透明抽屉浮在表单上。地图条太窄时退回屏幕底部，
     免得和「高德地图·河北」「路网/卫星」两个胶囊挤在同一行。 */
  function updateMapWatermark() {
    var stage = $('mapStage');
    if (!stage) return;
    var band = sheetVh() - SHEET.y;
    stage.style.setProperty('--wm-bottom', (band > 140 ? band + 8 : 8) + 'px');
    /* 地图条窄到放不下浮层时（表单展开），收起「已选点」浮标 ——
       它会和抽屉里的位置摘要重复，半掩在抽屉后面反而像渲染错位 */
    var modal = document.querySelector('.plot-modal');
    if (modal) modal.classList.toggle('map-tight', isSheetMobile() && band < 170);
  }
  function setSheetDetent(name, animate) {
    SHEET.detent = name;
    var s = $('plotSheet');
    if (!s) return;
    if (!isSheetMobile()) { s.style.removeProperty('--sheet-y'); SHEET.y = 0; return; }
    var y = detentPx(name); SHEET.y = y;
    if (animate !== false) s.classList.remove('dragging');
    s.style.setProperty('--sheet-y', y + 'px');
    s.style.setProperty('--sheet-pad', y + 'px');   // 滚动区底部留白 = 抽屉挂到屏幕外的那一截
    updateMapWatermark();
  }

  /**
   * 抽屉手势：整块可拖（高德/微信那种手感），但绝不抢表单的活。
   *  - 触摸走 touch 事件（no-passive）：起拖 7px 后 preventDefault 接管，
   *    既跟手，又不会让底下的内容跟着一起滚；
   *  - 输入框 / 按钮 / 下拉 / 折叠标题一律不接管，点就是点，输入就是输入；
   *  - 表单展开（form 档）时内容优先滚动，只有滚到顶再往下拉才收起抽屉；
   *  - 把手与标题栏始终可拖，也是键盘（方向键）能操作的入口。
   *  - 拖到底只停在「地图最大化」，**不会关窗**：新增/编辑地块里可能有填了一半的内容，
   *    关闭只由左上角「取消」触发，避免一个下拉手势把输入全丢掉。
   */
  function bindSheetDrag() {
    var sheet = $('plotSheet');
    if (!sheet || sheet.__bound) return;
    sheet.__bound = true;

    var st = null;            // 当前手势：{y0,startY,lastY,lastT,v,active,pendCollapse}
    var DRAG_MIN = 7;         // 起拖阈值，小于它就是「点」

    function bodyEl() { return sheet.querySelector('.modal-body'); }
    function isCtl(el) {
      return !!(el && el.closest && el.closest(
        'input,textarea,select,button,a,label,summary,[contenteditable="true"],[data-nodrag]'));
    }
    function begin(y, fromHandle, target) {
      if (!isSheetMobile()) return null;
      if (!fromHandle && isCtl(target)) return null;
      var inBody = !!(target && target.closest && target.closest('.modal-body'));
      var body = bodyEl();
      var atForm = SHEET.detent === 'form';
      /* 表单展开、内容已滚离顶部：这一下是在滚内容，不是拖抽屉 */
      if (!fromHandle && atForm && inBody && body && body.scrollTop > 2) return null;
      return {
        y0: y, startY: SHEET.y, lastY: y, lastT: Date.now(), v: 0, active: false,
        pendCollapse: !fromHandle && atForm && inBody
      };
    }
    function move(y, ev) {
      if (!st) return;
      var dy = y - st.y0;
      if (!st.active) {
        if (Math.abs(dy) < DRAG_MIN) return;
        if (st.pendCollapse && dy < 0) { st = null; return; }   // 上滑看内容：交还给滚动
        st.active = true;
        sheet.classList.add('dragging');
        /* 一开拖就收键盘：键盘、抽屉、地图不该抢同一块屏 */
        var ae = document.activeElement;
        if (ae && sheet.contains(ae) && ae.blur) ae.blur();
      }
      if (ev && ev.cancelable) ev.preventDefault();
      var ny = st.startY + dy;
      var top = detentPx('form'), max = detentPx('map');
      if (ny < top) ny = top + (ny - top) * 0.28;                  // 顶部橡皮筋
      /* 底部只到「地图最大化」为止：再往下拉给一点点回弹手感（最多 24px），
         松手回到 map 档，绝不继续下移、更不关窗 */
      if (ny > max) ny = max + Math.min((ny - max) * 0.15, 24);
      SHEET.y = ny;
      sheet.style.setProperty('--sheet-y', ny + 'px');
      var now = Date.now(), dt = now - st.lastT;
      if (dt > 0) { st.v = (y - st.lastY) / dt; st.lastY = y; st.lastT = now; }
    }
    function finish() {
      if (!st) return;
      var g2 = st; st = null;
      if (!g2.active) return;
      sheet.classList.remove('dragging');
      var order = ['form', 'peek', 'map'], best = 'peek', bd = Infinity, i, d;
      for (i = 0; i < order.length; i++) {
        d = Math.abs(SHEET.y - detentPx(order[i]));
        if (d < bd) { bd = d; best = order[i]; }
      }
      /* 甩动优先于距离：快速上推直接跳上一档 */
      if (g2.v < -0.6) best = (SHEET.y < detentPx('peek')) ? 'form' : 'peek';
      else if (g2.v > 0.6) best = (SHEET.y < detentPx('map')) ? 'peek' : 'map';
      if (best === 'map' && SHEET.y > detentPx('map')) best = 'map';   // 到底就停，不越界
      setSheetDetent(best);
    }
    function cancel() {
      if (!st) return;
      st = null;
      sheet.classList.remove('dragging');
      setSheetDetent(SHEET.detent);
    }

    /* 触摸：no-passive 才能在接管后真正拦住滚动 */
    sheet.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) { st = null; return; }
      st = begin(e.touches[0].clientY, false, e.target);
    }, { passive: true });
    sheet.addEventListener('touchmove', function (e) {
      if (!st || e.touches.length !== 1) return;
      move(e.touches[0].clientY, e);
    }, { passive: false });
    sheet.addEventListener('touchend', finish);
    sheet.addEventListener('touchcancel', cancel);

    /* 鼠标/触控笔：触摸已被上面的 touch 分支处理，这里跳过，免得同一手势跑两遍 */
    sheet.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'touch') return;
      var fromHandle = !!(e.target.closest && e.target.closest('#sheetGrab,.modal-head'));
      st = begin(e.clientY, fromHandle, e.target);
      if (st) { try { sheet.setPointerCapture(e.pointerId); } catch (err) { /* 旧浏览器忽略 */ } }
    });
    sheet.addEventListener('pointermove', function (e) {
      if (e.pointerType === 'touch' || !st) return;
      move(e.clientY, null);
    });
    sheet.addEventListener('pointerup', function (e) { if (e.pointerType !== 'touch') finish(); });
    sheet.addEventListener('pointercancel', function (e) { if (e.pointerType !== 'touch') cancel(); });

    var g = $('sheetGrab');
    if (g) {
      /* 轻点把手 = 展开/收起：不想拖的人也能一按到位 */
      g.addEventListener('click', function () {
        if (!isSheetMobile()) return;
        setSheetDetent(SHEET.detent === 'form' ? 'peek' : 'form');
      });
      g.addEventListener('keydown', function (e) {
        if (!isSheetMobile()) return;
        var order = ['map', 'peek', 'form'], idx = order.indexOf(SHEET.detent);
        if (e.key === 'ArrowUp') { e.preventDefault(); setSheetDetent(order[Math.min(order.length - 1, idx + 1)]); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); setSheetDetent(order[Math.max(0, idx - 1)]); }
      });
    }

    /* 聚焦输入控件：先把抽屉拉到 form 档，等键盘落定再把它滚进可视区 */
    sheet.addEventListener('focusin', function (e) {
      if (!isSheetMobile()) return;
      var el = e.target;
      if (!el || !el.matches || !el.matches('input,textarea,select')) return;
      if (SHEET.detent !== 'form') setSheetDetent('form');
      setTimeout(keepFocusVisible, 260);
      setTimeout(keepFocusVisible, 560);
    });
  }

  /* ---------- 键盘避让：把当前焦点控件滚回可视区 ---------- */
  function keepFocusVisible() {
    var el = document.activeElement;
    var body = document.querySelector('.plot-modal .modal-body');
    if (!el || !body || !body.contains(el)) return;
    var r = el.getBoundingClientRect(), br = body.getBoundingClientRect();
    var pad = 16;
    if (r.bottom > br.bottom - pad) body.scrollTop += Math.ceil(r.bottom - (br.bottom - pad));
    else if (r.top < br.top + pad) body.scrollTop -= Math.ceil((br.top + pad) - r.top);
  }

  /* ---------- 视口同步：键盘开合 / 横竖屏 / 地址栏伸缩 ---------- */
  function syncViewport() {
    var vv = window.visualViewport;
    var h = Math.round(vv ? vv.height : window.innerHeight);
    var top = Math.round(vv ? vv.offsetTop : 0);
    if (!h) return;
    var changed = Math.abs(h - VV.h) > 1 || Math.abs(top - VV.top) > 1;
    VV.h = h; VV.top = top;
    var de = document.documentElement;
    de.style.setProperty('--vvh', h + 'px');
    de.style.setProperty('--vv-top', top + 'px');
    if (!changed) return;
    var mask = $('plotMask');
    if (!mask || !mask.classList.contains('on')) return;
    /* 可视高度变了：档位按新高度重算，并让高德重排一次 ——
       否则地图还按旧高度排版，水印会停在旧位置「浮」在表单上 */
    setSheetDetent(SHEET.detent, false);
    if (MAP.instance) setTimeout(function () { MAP.instance.resize(); }, 50);
    keepFocusVisible();
  }
  function bindViewport() {
    if (bindViewport._bound) return;
    bindViewport._bound = true;
    syncViewport();
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', syncViewport);
      window.visualViewport.addEventListener('scroll', syncViewport);
    }
    window.addEventListener('resize', syncViewport);
    window.addEventListener('orientationchange', function () { setTimeout(syncViewport, 150); });
    /* 收键盘后也校一次：iOS 的 focusout 时机不稳 */
    document.addEventListener('focusout', function () {
      setTimeout(function () {
        if (!isSheetMobile()) return;
        var mask = $('plotMask');
        if (mask && mask.classList.contains('on')) syncViewport();
      }, 120);
    });
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
        mapCenterOn(r.lon, r.lat, 11, 700);
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
        flyToPoint(lon, lat, 700);
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

    // 保存前再校正一次：优先用在线解析出的细粒度名称（村 / 乡镇），
    // 拿不到才退回本地县界给出的县名。
    // 注意不能反过来——县界只到县，用它覆盖会把已经识别出的村名抹掉。
    var loc = locateCounty(form.lon, form.lat);
    var bad = !form.place || form.place === '未知位置' || form.place === '地图选点' || form.place === '我的位置';
    var finalPlace = bad ? (loc ? displayName(loc) : form.place) : form.place;
    var finalCity = form.city || (loc ? loc.city : '');

    if (state.editing) {
      var p = state.plots.filter(function (x) { return x.id === state.editing.id; })[0];
      p.name = name; p.area = area; p.crop = crop;
      p.place = finalPlace; p.city = finalCity;
      p.village = form.village || '';
      p.lat = form.lat; p.lon = form.lon;
      state.activeId = p.id;
      toast('已保存「' + name + '」');
    } else {
      var np = {
        id: 'p' + Date.now(),
        name: name, area: area, crop: crop,
        place: finalPlace, city: finalCity, village: form.village || '',
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
  /* 首答要能一眼看出「结论 / 时间 / 数字」：第一行加粗，日期与时段加重。
     -------------------------------------------------------------
     只做排版，不改文字：所有数字仍是规则引擎给的原字符串，
     拆行与加重都在渲染层完成，复制/测试拿到的 data-brief 仍是纯文本。 */
  var QA_EM = /(\d{1,2}:\d{2}\s*[–\-]\s*\d{1,2}:\d{2}|\d{1,2}\/\d{1,2}|\d+(?:\.\d+)?\s*(?:m\/s|℃|%|小时|天|份))/g;
  var QA_EM_ONE = new RegExp('^' + QA_EM.source + '$');

  function qaRichText(body, text, strong) {
    body.setAttribute('data-brief', text);
    String(text).split('\n').forEach(function (line, i) {
      var row = document.createElement('div');
      /* 只有「判定结论」这类两行答案才把第一行加粗；
         开场白、知识库摘录、方法说明都是长段落，加粗只会显得吵。 */
      row.className = strong ? (i === 0 ? 'qa-l1' : 'qa-l2') : 'qa-p';
      String(line).split(QA_EM).forEach(function (part) {
        if (!part) return;
        if (QA_EM_ONE.test(part)) {
          var b = document.createElement('b');
          b.className = 'qa-num';
          b.textContent = part;
          row.appendChild(b);
        } else {
          row.appendChild(document.createTextNode(part));
        }
      });
      body.appendChild(row);
    });
  }

  /**
   * 追加一条对话消息。
   * withNote=true 时给机器人回答挂上「依据 / 边界 / 核实」条与纠错入口——
   * 评审里「知识准确性」「对话体验」「AI 伦理与合规」都要求回答能被核对、
   * 能被指出错误，而不是一句来路不明的结论。
   */
  function appendMsg(role, text, withNote, notes) {
    var log = $('qaLog');
    var d = document.createElement('div');
    d.className = 'msg ' + role;
    var who = document.createElement('div');
    who.className = 'who';
    who.textContent = (role === 'me') ? '我' : '打药窗';
    var body = document.createElement('div');
    body.className = 'body';
    /* 首答分层：第一段是结论，其余整段折进「展开完整分析」。
       有 sections 时按段再折一层：理由默认可见，数字明细与依据各自收起，
       一张卡片不再一次铺开十几屏字。 */
    var sections = (notes && notes.sections) || null;
    var brief = text, rest = '';
    var pIdx = text.indexOf('\n\n');
    if (!sections && pIdx > 0 && ((notes && notes.fold) || text.length > 180)) {
      brief = text.slice(0, pIdx);
      rest = text.slice(pIdx + 2);
    }
    if (role === 'bot') qaRichText(body, brief, !!(notes && notes.verdict));
    else body.textContent = brief;
    if (sections && sections.length) {
      var det = document.createElement('details');
      det.className = 'qa-more';
      var sum = document.createElement('summary');
      sum.textContent = '展开完整分析（' + sections.length + ' 段）';
      var dv = document.createElement('div');
      dv.className = 'qa-more-body';
      sections.forEach(function (sec, i) {
        var blk, title = document.createElement('b'), txt = document.createElement('div');
        txt.className = 'qa-sec-t';
        txt.textContent = sec.body;
        title.textContent = sec.title;
        if (i === 0) {
          /* 第一段（为什么这么判）不进二次折叠：结论下面直接能看到理由 */
          blk = document.createElement('div');
          blk.className = 'qa-sec';
          blk.appendChild(title); blk.appendChild(txt);
        } else {
          blk = document.createElement('details');
          blk.className = 'qa-sub';
          var s2 = document.createElement('summary');
          s2.textContent = sec.title;
          blk.appendChild(s2); blk.appendChild(txt);
        }
        dv.appendChild(blk);
      });
      det.appendChild(sum); det.appendChild(dv);
      body.appendChild(det);
    } else if (rest) {
      var det2 = document.createElement('details');
      det2.className = 'qa-more';
      var sum2 = document.createElement('summary');
      sum2.textContent = '展开完整分析';
      var dv2 = document.createElement('div');
      dv2.className = 'qa-more-body';
      dv2.textContent = rest;
      det2.appendChild(sum2); det2.appendChild(dv2);
      body.appendChild(det2);
    }
    d.appendChild(who); d.appendChild(body);

    if (role === 'bot' && withNote) {
      var line = document.createElement('div');
      line.className = 'an-line';
      var txt = document.createElement('span');
      txt.textContent = '依据：' + ((notes && notes.source) ? notes.source : '实时天气 + 本地规则引擎');
      line.appendChild(txt);
      var b0 = document.createElement('button');
      b0.type = 'button'; b0.textContent = '依据库'; b0.setAttribute('data-act', 'lib');
      var b2 = document.createElement('button');
      b2.type = 'button'; b2.textContent = '纠错'; b2.setAttribute('data-act', 'fix');
      line.appendChild(b0); line.appendChild(b2);
      body.appendChild(line);
      var sugs = (notes && notes.suggest) || SUG[lastIntent];
      /* 药剂追问按当前药种动态生成：不要出现「换成除草剂呢」这种
         当前已经就是除草剂的无效按钮。 */
      if (lastIntent === 'chem' && !(notes && notes.suggest) && qaContext.chem && qaContext.chem.type !== 'banned') {
        var CHEM_LBL = { herbicide: '除草剂', insecticide: '杀虫剂', fungicide: '杀菌剂' };
        var curChem = qaContext.chem.type;
        var otherChem = ['herbicide', 'insecticide', 'fungicide'].filter(function (k) { return k !== curChem; });
        sugs = qaContext.chem.scope === 'week'
          ? ['那今天呢？', '换成' + CHEM_LBL[otherChem[0]] + '呢？', '有露水能打吗？', '这周雨量多少？']
          : ['那哪天能打？', '换成' + CHEM_LBL[otherChem[0]] + '呢？', '有露水能打吗？', '几点风最小？'];
      }
      if (sugs && sugs.length) {
        var row = document.createElement('div');
        row.className = 'sug-row';
        sugs.forEach(function (t) {
          var b = document.createElement('button');
          b.type = 'button'; b.className = 'sug'; b.textContent = t;
          b.onclick = function () { ask(t); };
          row.appendChild(b);
        });
        body.appendChild(row);
      }
    }

    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    if (role === 'bot' && withNote) {
      qaContext.lastBrief = text;
      qaContext.lastWhy = (notes && notes.sections && notes.sections[0]) ? notes.sections[0].body : '';
    }
    return d;
  }

  /* =========================================================
     内容层挂载：知识依据 / 资料来源 / 作品说明 / 范围卡 / 示例问题
     ========================================================= */
  function renderContentLayer() {
    if (!CONTENT) return;
    var chips = $('qaChips');
    if (chips) {
      chips.innerHTML = CONTENT.chat.presets.map(function (p) {
        return '<button class="chip-btn" data-q="' + CONTENT.esc(p.q) + '">' +
          CONTENT.esc(p.label) + '</button>';
      }).join('');
      // 事件委托：按钮是动态渲染的，绑定必须在容器上
      chips.addEventListener('click', function (e) {
        var b = e.target && e.target.closest ? e.target.closest('.chip-btn') : null;
        if (b && b.getAttribute('data-q')) ask(b.getAttribute('data-q'));
      });
    }
  }

  /* =========================================================
     判定依据弹层：口径 / 来源 / 边界
     ---------------------------------------------------------
     以前这些内容直接摊在首页，农户要滚很久。
     现在首页只留一个入口，评委想核对时点开即可。
     ========================================================= */
  var BASIS_SOURCES = [
    ['气象', '和风天气主预报 + Open-Meteo 集合 / 多模型'],
    ['地图', '高德 JS API / Web 服务；地名兜底 BigDataCloud'],
    ['标准', '河北省植保植检总站 2026 意见 + DB13/T 5517-2022 + 市级标准（见「我的 → 作业标准」）'],
    ['计算', '本地规则引擎；AI 只做意图分类与口语改写，不产生数字']
  ];

  function renderBasis() {
    if ($('basisRules') && CONTENT && CONTENT.rules) {
      // 只列四条主干规则，口径细节留在参赛说明书里
      var keep = ['打药窗口', '灌溉建议', '晾晒 / 入库', '结论置信度'];
      var list = CONTENT.rules.filter(function (r) { return keep.indexOf(r.title) >= 0; });
      $('basisRules').innerHTML = list.map(function (r) {
        return '<div class="basis-rule"><b>' + esc(r.title) + '</b>' +
          '<p>' + esc(r.expr) + '</p><span>' + esc(r.src) + '</span></div>';
      }).join('');
    }
    if ($('basisSources')) {
      $('basisSources').innerHTML = BASIS_SOURCES.map(function (x) {
        return '<div><i>' + esc(x[0]) + '</i><span>' + esc(x[1]) + '</span></div>';
      }).join('');
    }
    var KB = window.TianZhiKB;
    if ($('kbStat') && KB) {
      var st = KB.stats();
      var parts = Object.keys(st.by).map(function (k) { return k + ' ' + st.by[k]; });
      $('kbStat').innerHTML = '本地索引 <b>' + st.total + '</b> 条 · ' + parts.join(' · ') +
        ' · 离线可用，不联网';
    }
    if ($('basisBoundary') && CONTENT) {
      $('basisBoundary').textContent =
        CONTENT.scope.boundaryNote + ' 结论只用于安排作业时间，不替代农药标签、剂量与安全间隔期要求。';
    }
    renderChemBasis();
  }

  /**
   * 「我的 → 施药依据库」
   * -------------------------------------------------------------
   * 对话里不再摊 15 份依据全文：判定要点留在回答里，原文与药剂档案
   * 统一收到这一页。数据全部来自 chem.js，不在 HTML 里另抄一份，
   * 免得以后改了口径两处不一致。
   */
  function renderChemBasis() {
    var CH = window.TianZhiChem;
    if (!CH) return;
    var srcBox = $('chemSrcList');
    if (srcBox) {
      srcBox.innerHTML = CH.SOURCES.map(function (s) {
        return '<div class="chem-src">' +
          '<div class="chem-src-h"><b>' + esc(s.code) + '</b><span>' + esc(s.level) + '</span></div>' +
          '<p>' + esc(s.point) + '</p>' +
          '<div class="chem-src-m">' + esc(s.issuer) + ' · ' + esc(s.clause) +
          (s.url ? ' · <a href="' + esc(s.url) + '" target="_blank" rel="noopener">原文</a>' : '') +
          '</div></div>';
      }).join('');
    }
    if ($('chemSrcCount')) $('chemSrcCount').textContent = CH.SOURCES.length;
    if ($('chemSrcStat')) $('chemSrcStat').textContent = '查证 ' + CH.CHECKED + ' · 离线可查';
    var prodBox = $('chemProdList');
    if (prodBox) {
      prodBox.innerHTML = CH.PRODUCTS.map(function (p) {
        var warn = CH.warnOf ? CH.warnOf(p, '') : '';
        return '<div class="chem-prod">' +
          '<div class="chem-prod-h"><b>' + esc(p.name) + '</b><span>' + esc(p.mode) + '</span></div>' +
          '<p>' + esc(p.what) + '</p>' +
          '<p class="chem-prod-w">天气：' + esc(p.weather) + '</p>' +
          (warn ? '<p class="chem-prod-n">' + esc(warn) + '</p>' : '') +
          '</div>';
      }).join('');
    }
    if ($('chemProdCount')) $('chemProdCount').textContent = CH.PRODUCTS.length;
  }

  /** 对话里的「依据库」按钮：跳到我的页，并把依据列表展开到位 */
  function goBasisLib() {
    closeBasis();
    setView('mine');
    setTimeout(function () {
      var adv = $('chemSrcAdv');
      if (adv) adv.open = true;
      var card = $('chemBasisCard');
      if (card && card.scrollIntoView) card.scrollIntoView({ block: 'start' });
    }, 80);
  }

  function openBasis() {
    renderBasis();
    if ($('basisMask')) $('basisMask').classList.add('on');
    lockBody(true);
  }
  function closeBasis() {
    if ($('basisMask')) $('basisMask').classList.remove('on');
    lockBody(false);
  }
  function renderKbHits(q) {
    var box = $('kbHits');
    var KB = window.TianZhiKB;
    if (!box || !KB) return;
    if (!q) { box.innerHTML = ''; return; }
    var hits = KB.search(q, 5);
    if (!hits.length) {
      box.innerHTML = '<div class="kb-empty">本地没有匹配项。换个词，或直接问「按什么标准打药」。</div>';
      return;
    }
    box.innerHTML = hits.map(function (e) {
      return '<div class="kb-hit"><b>' + esc(e.title) + '</b>' +
        '<span>' + esc(e.text) + '</span>' +
        '<i>' + esc(e.type) + ' · ' + esc(e.sourceLabel) + '</i></div>';
    }).join('');
  }

  function bindBasis() {
    if ($('basisOpen')) $('basisOpen').onclick = openBasis;
    if ($('basisOpenChat')) $('basisOpenChat').onclick = openBasis;
    if ($('basisClose')) $('basisClose').onclick = closeBasis;
    if ($('basisMask')) {
      $('basisMask').addEventListener('click', function (e) {
        if (e.target === $('basisMask')) closeBasis();
      });
    }
    if ($('basisToStd')) {
      $('basisToStd').onclick = function () { closeBasis(); setView('mine'); };
    }
    if ($('kbSearch') && !$('kbSearch')._kbBound) {
      $('kbSearch')._kbBound = true;
      $('kbSearch').addEventListener('input', function () {
        renderKbHits(this.value.trim());
      });
    }
  }

  /* 回答下方：一行依据 + 详情 / 纠错 */
  function bindAnswerNotes() {
    var log = $('qaLog');
    if (!log) return;
    log.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('.an-line button') : null;
      if (!b) return;
      if (b.getAttribute('data-act') === 'basis') { openBasis(); return; }
      if (b.getAttribute('data-act') === 'lib') { goBasisLib(); return; }
      if (b.getAttribute('data-act') === 'fix') openCorrectionForm(b);
    });
  }

  function openCorrectionForm(btn) {
    var line = btn.closest ? btn.closest('.an-line') : null;
    var note = line ? line.parentNode : btn.parentNode;
    if (!note || note.querySelector('.an-form')) return;
    var form = document.createElement('div');
    form.className = 'an-form';
    var ta = document.createElement('textarea');
    ta.rows = 2;
    ta.placeholder = '哪里说错了？正确信息是什么？（只存本机，不上传）';
    var row = document.createElement('div');
    var ok = document.createElement('button');
    ok.type = 'button'; ok.textContent = '保存纠错';
    var no = document.createElement('button');
    no.type = 'button'; no.textContent = '取消';
    row.appendChild(ok); row.appendChild(no);
    form.appendChild(ta); form.appendChild(row);
    note.appendChild(form);
    ta.focus();
    no.onclick = function () { form.remove(); };
    ok.onclick = function () {
      var v = (ta.value || '').trim();
      if (!v) { toast('先写一句哪里不对'); return; }
      try {
        var key = 'tianzhi.corrections.v1';
        var arr = JSON.parse(localStorage.getItem(key) || '[]');
        arr.push({ t: new Date().toISOString(), q: v });
        if (arr.length > 50) arr = arr.slice(-50);
        localStorage.setItem(key, JSON.stringify(arr));
      } catch (err) { /* 隐私模式下 localStorage 可能不可写，不因此打断对话 */ }
      form.remove();
      appendMsg('bot', CONTENT ? CONTENT.chat.correctionSaved : '已记录在本机，谢谢反馈。');
      toast('纠错已记在本机，不会上传');
    };
  }

  /* 评审要求：能解释依据、能承认不确定、能理解追问、超范围诚实 */
  var qaContext = { intent: null, chem: null, lastQ: '', lastBrief: '', lastWhy: '' };
  var lastIntent = '';
  var SUG = {
    spray: ['明天和后天哪天更好？', '几点风最小？', '我这里按什么标准打药？'],
    irrigation: ['未来七天雨量多少？', '明天和后天哪天更好？'],
    harvest: ['未来七天雨量多少？', '几点风最小？'],
    standard: ['为什么是这个时段？', '这个结论准不准？'],
    weather: ['日出日落几点？', '几点风最小？', '未来七天雨量多少？'],
    kb: ['按什么标准打药？'],
    chem: ['那哪天能打？', '有露水能打吗？', '换成杀虫剂呢？']
  };

  /** 追问按钮跟着「这一轮问的时间范围」走，别一律推「那明天呢」 */
  function chemSuggest(m) {
    var LBL = { herbicide: '除草剂', insecticide: '杀虫剂', fungicide: '杀菌剂' };
    var others = ['herbicide', 'insecticide', 'fungicide'].filter(function (k) { return k !== m.type; });
    if (m.scope === 'week') {
      return ['那今天呢？', '换成' + LBL[others[0]] + '呢？', '这周雨量多少？'];
    }
    return ['那哪天能打？', '有露水能打吗？', '换成' + LBL[others[0]] + '呢？'];
  }

  /**
   * 药剂判定的唯一出口：ask 与 respondWith 都走这里，
   * 保证「同一类问法」永远是同一种排版与同一套数字。
   */
  function answerChem(m, result, plot) {
    var CH = window.TianZhiChem;
    if (!CH) return false;
    var ans = CH.answer(m, {
      result: result, raw: state.raw, rules: RULES, plot: plot, now: new Date()
    });
    if (!ans) return false;
    qaContext.intent = 'chem';
    lastIntent = 'chem';
    /* prev 里存的是对象，不是 key：下一轮「那明天呢」要沿用整个药剂档案 */
    qaContext.chem = {
      type: ans.type, product: m.product || null,
      dayIdx: ans.dayIdx || 0, scope: ans.scope || 'now', topic: m.topic
    };
    appendMsg('bot', ans.brief, true, {
      source: ans.source, fold: true, verdict: true,
      sections: ans.sections, suggest: chemSuggest(m)
    });
    return true;
  }

  /**
   * 每轮注入给大模型的会话上下文。
   * -------------------------------------------------------------
   * 为什么要有：LLM 只看到「待改写的一句话」时，很容易把用户的
   * 「这周哪天」改写成「明天不能打」——因为句子里没有主语。
   * 这里把地块、药种、时间范围、上一轮问答压成一段事实清单，
   * 和 system prompt 一起发过去。清单里的数字全部来自规则引擎，
   * 不是模型生成的，所以不会引入新的数字来源。
   */
  function buildTurnContext(plot, result) {
    if (!result || !result.days || !result.days.length) return '';
    var L = [];
    var d0 = result.days[0];
    L.push('地点：' + plot.name + (plot.place ? '（' + plot.place + '）' : '') +
      '；作物：' + (CROP_NAME[plot.crop] || '冬小麦'));
    var n = new Date();
    L.push('现在：' + (n.getMonth() + 1) + '月' + n.getDate() + '日 ' +
      pad2(n.getHours()) + ':' + pad2(n.getMinutes()));
    L.push('属地阈值：风速 ≤ ' + RULES.spray.wind_max + ' m/s；气温 ' +
      RULES.spray.temp_min + '–' + RULES.spray.temp_max + '℃；作业 ' +
      RULES.spray.hours[0] + '–' + RULES.spray.hours[1] + ' 时；降雨概率 ≥ ' +
      RULES.spray.prob_block + '% 关闭窗口');
    var oks = result.days.filter(function (d) {
      return d.spray.status === 'ok' && d.spray.windows.length;
    }).map(function (d) {
      var w = d.spray.windows.slice().sort(function (a, b) { return b.hours - a.hours; })[0];
      return d.date.slice(5) + ' ' + pad2(w.start) + '–' + pad2(w.end);
    });
    L.push('未来七天通用可作业日：' + (oks.length ? oks.join('；') : '无'));
    L.push('今天：' + (d0.spray.status === 'ok' ? '有窗口' : '无窗口：' + d0.spray.why) +
      '；最低 ' + d0.tmin + '℃、最高 ' + d0.tmax + '℃');
    if (qaContext.chem) {
      var LBL = { herbicide: '除草剂', insecticide: '杀虫剂', fungicide: '杀菌剂' };
      var sc = qaContext.chem.scope === 'week' ? '未来一周'
        : (qaContext.chem.scope === 'day' ? '指定某天' : '现在');
      L.push('上一轮药种：' + (LBL[qaContext.chem.type] || '未指定') +
        (qaContext.chem.product ? '（' + qaContext.chem.product.name + '）' : '') +
        '；上一轮问的时间范围：' + sc);
    }
    if (qaContext.lastQ) L.push('上一轮用户问：' + qaContext.lastQ);
    if (qaContext.lastBrief) L.push('上一轮我答：' + qaContext.lastBrief.replace(/\n/g, ' / '));
    return L.join('\n');
  }

  /** 两天的窗口对比：回答"明天和后天哪天更好" */
  function compareDays(a, b, result) {
    function brief(d) {
      if (!d) return '没有这一天';
      if (d.spray.status === 'ok' && d.spray.windows.length) {
        var w = d.spray.windows.slice().sort(function (x, y) { return y.hours - x.hours; })[0];
        return '有窗口 ' + pad2(w.start) + '–' + pad2(w.end) + '（' + w.hours + ' 小时，平均风速 ' +
          w.avgWind + ' m/s，降雨概率 ' + (d.dayProb || 0) + '%）';
      }
      return '不合适：' + d.spray.why;
    }
    var ta = brief(a), tb = brief(b);
    var wa = a && a.spray.status === 'ok' ? a.spray.windows.reduce(function (m, w) { return Math.max(m, w.hours); }, 0) : 0;
    var wb = b && b.spray.status === 'ok' ? b.spray.windows.reduce(function (m, w) { return Math.max(m, w.hours); }, 0) : 0;
    var verdict;
    if (!wa && !wb) verdict = '两天都不合适，等下一轮天气过程再看。';
    else if (wa >= wb) verdict = '优先选' + (a ? a.dow : '前一天') + '，窗口更长。';
    else verdict = '优先选' + (b ? b.dow : '后一天') + '，窗口更长。';
    return '【' + (a ? a.date.slice(5) : '—') + ' vs ' + (b ? b.date.slice(5) : '—') + '】\n\n' +
      (a ? a.dow : '前一天') + '：' + ta + '\n' + (b ? b.dow : '后一天') + '：' + tb +
      '\n\n' + verdict + '\n\n两天都按属地标准判定：风速 ≤ ' + RULES.spray.wind_max +
      ' m/s、降雨概率 < ' + RULES.spray.prob_block + '%、时段 ' + RULES.spray.hours[0] + '–' + RULES.spray.hours[1] + ' 时。';
  }

  /** 未来七天雨量清单 */
  function weekRainAnswer(result, plot) {
    var rows = result.days.map(function (d) {
      return '· ' + d.date.slice(5) + ' ' + d.dow + '：' + d.dayRain + ' mm，概率 ' + (d.dayProb || 0) + '%';
    }).join('\n');
    return '【' + plot.name + '】未来七天降水：\n\n' + rows +
      '\n\n累计 ' + result.weekRain + ' mm。雨前不打药、不灌溉，这条比"今天有没有空"更重要。';
  }

  /** 日出日落与日照：直接支撑“几点收工”“为什么晾晒降级” */
  function sunAnswer(result, plot) {
    var rows = result.days.slice(0, 3).map(function (d) {
      return '· ' + d.date.slice(5) + ' ' + d.dow + '：日出 ' + (d.sunrise || '—') +
        '，日落 ' + (d.sunset || '—') +
        (d.daylightH !== null && d.daylightH !== undefined ? '，白天 ' + d.daylightH.toFixed(1) + ' 小时' : '');
    }).join('\n');
    var d0 = result.days[0];
    var tail = d0.spray.cutoffShortened
      ? '今天日落 ' + d0.sunset + '，按「日落前 1.5 小时」算，实际 ' + d0.spray.hours[1] + ':00 就得收工——再晚近地层起逆温，雾滴悬着不落。'
      : '今天日落较晚，作业仍按文件口径 ' + d0.spray.hours[1] + ':00 收工。';
    return '【' + plot.name + '】近三天日出日落：\n\n' + rows + '\n\n' + tail;
  }

  /** 作业时段里风最小的一小时 */
  function bestHourAnswer(result, plot) {
    var day = result.days.filter(function (d) { return d.spray.status === 'ok'; })[0] || result.days[0];
    var hours = T.hoursOf(state.raw.hourly, day.date).filter(function (h) {
      return h.hour >= RULES.spray.hours[0] && h.hour < RULES.spray.hours[1];
    });
    if (!hours.length) return '【' + plot.name + '】' + day.dow + '没有逐小时数据，暂时算不出最稳的一小时。';
    var ok = hours.filter(function (h) {
      return T.hourVerdict(h) === 'ok' && h.rain <= RULES.spray.rain_hour_max &&
        (h.prob === null || h.prob === undefined || h.prob < RULES.spray.prob_block);
    });
    var pool = ok.length ? ok : hours;
    var best = pool.slice().sort(function (x, y) { return x.wind - y.wind; })[0];
    return '【' + plot.name + '】' + day.dow + '风最小的一小时是 ' + pad2(best.hour) + ':00–' +
      pad2(best.hour + 1) + ':00：风速 ' + best.wind + ' m/s、气温 ' + Math.round(best.temp) +
      '℃' + (best.prob !== null && best.prob !== undefined ? '、降雨概率 ' + best.prob + '%' : '') + '。' +
      (ok.length ? '' : '\n\n注意：这一小时也没有完全达标，只是相对最稳，别把它当成推荐窗口。');
  }

  function preAnswer(q, result, plot) {
    if (!CONTENT) return null;
    if (/(明天|后天).*(哪天|哪个)|哪天更好|对比.*(明天|后天)/.test(q)) {
      lastIntent = 'spray';
      // 按问句里实际提到的两天取，不要一律取"明天+后天"
      var idxs = [];
      if (/今天/.test(q)) idxs.push(0);
      if (/明天/.test(q)) idxs.push(1);
      if (/后天/.test(q)) idxs.push(2);
      if (idxs.length < 2) idxs = [1, 2];
      /* 上一轮如果是除草剂/杀虫剂/杀菌剂，就按那个药种比，
         否则会拿通用口径说「两天都能打」，把药种条件丢了。 */
      var CT = qaContext.chem && qaContext.chem.type;
      var CHm = window.TianZhiChem;
      if (CT && CT !== 'generic' && CHm && CHm.compareDays) {
        var cmp = CHm.compareDays(CT, {
          result: result, raw: state.raw, rules: RULES, now: new Date()
        }, idxs);
        if (cmp) {
          qaContext.intent = 'chem';
          lastIntent = 'chem';
          return cmp.brief;
        }
      }
      return compareDays(result.days[idxs[0]], result.days[idxs[1]], result);
    }
    if (/(未来七天|这周|一周).*(雨|降水)|雨量/.test(q)) {
      lastIntent = 'irrigation';
      return weekRainAnswer(result, plot);
    }
    if (/(日出|日落|天亮|天黑|日照时长|几点黑)/.test(q)) {
      lastIntent = 'weather';
      return sunAnswer(result, plot);
    }
    if (/(几点|什么时候).*(风最小|风最稳)|风最小/.test(q)) {
      lastIntent = 'spray';
      return bestHourAnswer(result, plot);
    }
    if (/为什么|依据|怎么判|怎么算|判定|口径|规则|阈值|凭什么/.test(q)) {
      /* 上一轮有具体判定理由时先复述它，再讲通用口径：
         「为什么」问的是刚才那条结论，不是想看一份说明书。 */
      var lastWhy = qaContext.lastWhy;
      return (lastWhy ? '上一轮是这么判的：\n' + lastWhy + '\n\n' : '') + CONTENT.chat.methodAnswer;
    }
    if (/准不准|可靠|可信|置信|把握|有多准|准吗|会不会错/.test(q)) return CONTENT.chat.reliabilityAnswer;
    if (/节气|该忙什么|现在忙|农事安排/.test(q)) {
      // 问的是具体节气就答那一个，别一律拿"当前节气"顶回去
      var asked = Object.keys(CONTENT.terms).filter(function (n) { return q.indexOf(n) >= 0; })[0];
      var nm = asked || ($('jqNow') ? $('jqNow').textContent : '');
      var tip = CONTENT.termNote(nm);
      if (!nm || nm === '—') return null;
      lastIntent = 'weather';
      var head = asked ? ('「' + nm + '」的农事：') : ('现在是「' + nm + '」。');
      return head + (tip || '') +
        '\n\n节气农事是通用常识提醒，不含这块地的苗情判断；要不要下地，还是看上面按实时天气算出来的窗口。';
    }
    if (/说错|不对|纠错|有误|错了|反馈/.test(q)) {
      return '如果哪条结论你觉得不对，点回答下方的「记一条纠错」写下来，记录只存在这台设备上。\n\n' +
        '我不会在没有依据的情况下当场改口；后续版本会把这类反馈用于规则复核。拿不准时请以当地农技部门与农药标签为准。';
    }
    if (qaContext.intent && /^(那|接着|再|然后|换)/.test(q) && T.INTENT_QUERY[qaContext.intent]) {
      try {
        return CONTENT.chat.contextHint + T.answerByIntent(qaContext.intent, result, plot);
      } catch (e) { return null; }
    }
    return null;
  }

  function appendTyping() {
    var log = $('qaLog');
    var d = document.createElement('div');
    d.className = 'msg bot typing-wrap';
    d.innerHTML = '<div class="who">打药窗</div><div class="typing"><i></i><i></i><i></i></div>';
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
    /* 记下这一轮问句：下一轮注入上下文时，模型才知道「那」指的是什么 */
    qaContext.lastQ = q;

    var plot = activePlot();

    /* 作业标准是静态文件，不依赖天气。天气还没回来时也应该能答，
       否则用户一问「按什么标准」就被「稍等」挡回去，体验很差。 */
    var ST0 = window.TianZhiStandards;
    if (ST0 && T.ruleIntent(q) === 'standard') {
      lastIntent = 'standard';
      appendMsg('bot', ST0.answer(plot && plot.city, plot && plot.name), true, {
        source: '标准文件原文',
        caveat: '标准只约束气象条件，不替代农药标签与当地农技部门意见',
        verify: '按编号到全国标准信息公共服务平台或政府网站查原文；本库查证日期 ' + ST0.CHECKED
      });
      return;
    }

    if (!state.result) {
      appendMsg('bot', CONTENT ? CONTENT.chat.loading : '天气数据还没加载好，稍等一下再问。');
      return;
    }

    var result = state.result;
    // 拒答话术里报给用户的「能力清单」，与范围卡保持同一套口径
    var capabilities = CONTENT
      ? CONTENT.scope.can.slice(0, 4).join('、')
      : '哪天几点适合打药、要不要浇水、能不能晾晒、这几天什么天气';

    // --- 第 0 步：依据 / 可靠性 / 节气 / 纠错 / 追问，先由内容层直接答 ---
    // 这些问题的答案不含实时数字，但可以解释「怎么算的、有多悬、边界在哪」，
    // 是交互智能体区别于「天气查询框」的关键。
    var pre = preAnswer(q, result, plot);
    if (pre) {
      /* 两行以内的「判定型」短答案才交给 AI 顺一遍、也才加粗首行；
         方法说明、可靠性这类长段落保持原样。 */
      var short = pre.length <= 220 && pre.indexOf('\n\n') < 0;
      if (aiOn && LLM && LLM.isEnabled() && short) {
        var tp0 = appendTyping();
        LLM.refine(pre, {
          place: plot.name + '（' + plot.place + '）',
          crop: CROP_NAME[plot.crop], question: q,
          context: buildTurnContext(plot, result)
        }).then(function (nice) {
          tp0.remove();
          appendMsg('bot', nice, true, { verdict: true });
        }, function () {
          tp0.remove();
          appendMsg('bot', pre, true, { verdict: true });
        });
        return;
      }
      appendMsg('bot', pre, true, { verdict: short });
      return;
    }

    // --- 第 0.5 步：药剂已定，判断「此时此地能不能施」---
    // 农户不问选药，只问选定的药在当前天气下能不能用。
    // 通用问答 AI 只能复述条文；这里把每条判据落到这块地的逐时数值上。
    // 关键：先由 chem.match 解析「时间范围 + 药种 + 话题」，
    // 再决定交给 chem 还是通用规则层。「这周哪天能打草甘膦」必须由 chem 答，
    // 因为通用层不认识草甘膦，也只会答「今天」。
    var CH = window.TianZhiChem;
    if (CH) {
      var chemM = CH.match(q, qaContext.chem);
      var otherTask = /晾晒|晒|浇水|灌溉|墒|收割|收获/.test(q) &&
        !/打药|喷药|施药|喷雾|用药|除草|杀虫|杀菌/.test(q);
      /* 只要问的是喷雾作业，就交给 chem：它有逐时窗口、药剂阈值和两行结论，
         通用规则层那段长段落不再抢这类问题，避免同一个问题两种排版。 */
      var sprayWord = /打药|喷药|施药|喷雾|用药|喷洒|农药/.test(q);
      var shouldChem = !otherTask && (
        chemM.kind === 'banned' || !!chemM.product || chemM.topic !== null ||
        chemM.type !== 'generic' || sprayWord ||
        (chemM.isFollow && qaContext.intent === 'chem'));
      if (shouldChem && answerChem(chemM, result, plot)) return;
    }

    // --- 第一步：规则层意图 ---
    var intent = T.ruleIntent(q);
    var typing = null;

    if (intent) {
      qaContext.intent = intent === 'out' ? null : intent;
      respondWith(intent, q, result, plot, capabilities);
      return;
    }

    // --- 第二步：本地知识库（离线）优先，能答就不劳烦大模型 ---
    var KB = window.TianZhiKB;
    if (KB) {
      var hits = KB.search(q, 3);
      // 至少标题或标签命中，避免正文里碰巧出现一个字的噪声
      if (hits.length && hits[0].title.length) {
        var bestHit = hits[0];
        var hitText = '本地知识库命中（离线）：\n\n· ' + bestHit.title + '\n  ' +
          bestHit.text + (bestHit.sourceLabel ? '\n  — ' + bestHit.sourceLabel : '');
        if (hits.length > 1) {
          hitText += '\n\n另外还有：' + hits.slice(1).map(function (h) { return h.title; }).join('；');
        }
        lastIntent = 'kb';
        appendMsg('bot', hitText, true, {
          source: '本地知识库 · ' + bestHit.type,
          caveat: '离线索引，不含实时天气；具体作业仍以当前窗口为准',
          verify: '可在「依据 → 本地知识库」里按关键词检索'
        });
        return;
      }
    }

    // --- 第三步：规则与本地库都不认识，交给大模型分类 ---
    if (aiOn && LLM && LLM.isEnabled()) {
      typing = appendTyping();
      LLM.classify(q, { context: buildTurnContext(plot, result) }).then(function (k) {
        if (typing) typing.remove();
        qaContext.intent = (k && k !== 'out') ? k : null;
        respondWith(k, q, result, plot, capabilities);
      }).catch(function () {
        if (typing) typing.remove();
        appendMsg('bot', T.answerQuestion(q, result, plot), true); // 兜底模板
      });
      return;
    }

    // 未开启 AI：走模板
    respondWith(null, q, result, plot, capabilities);
  }

  function respondWith(intent, q, result, plot, capabilities) {
    lastIntent = intent || '';
    // 超出范围：诚实说不会，并给出该找谁（评审「知识边界」硬指标）
    if (intent === 'out') {
      if (aiOn && LLM && LLM.isEnabled()) {
        var tp = appendTyping();
        LLM.refuse(q, capabilities, { context: buildTurnContext(plot, result) }).then(function (txt) {
          tp.remove();
          appendMsg('bot', txt, true);
        }).catch(function () {
          tp.remove();
          appendMsg('bot', T.answerQuestion(q, result, plot), true);
        });
        return;
      }
      appendMsg('bot', T.answerQuestion(q, result, plot), true);
      return;
    }

    // 没有意图（规则和大模型都没识别）→ 模板兜底
    if (!intent || !T.INTENT_QUERY[intent]) {
      appendMsg('bot', T.answerQuestion(q, result, plot), true);
      return;
    }

    /* 大模型把问题归到 spray 时，仍然交给 chem 出结论：
       以前这里会退回逻辑层的长段落，同一个「哪天能打」出现两种排版。 */
    if (intent === 'spray' && window.TianZhiChem) {
      if (answerChem(window.TianZhiChem.match(q, qaContext.chem), result, plot)) return;
    }

    // 关键：答案由规则引擎产出，数字全部来自实时数据
    var template = T.answerByIntent(intent, result, plot);

    if (!aiOn || !LLM || !LLM.isEnabled()) {
      appendMsg('bot', template, true);
      return;
    }

    // AI 只做改写，且必须通过数字校验
    var ty = appendTyping();
    LLM.refine(template, {
      place: plot.name + '（' + plot.place + '）',
      crop: CROP_NAME[plot.crop],
      question: q,
      context: buildTurnContext(plot, result)
    }).then(function (nice) {
      ty.remove();
      appendMsg('bot', nice, true);
    }).catch(function (err) {
      ty.remove();
      // 校验失败或被拒时回退模板；出现新数字时留痕，说明「AI 不碰数字」不是口号
      if (err && /数字不一致/.test(err.message || '')) {
        appendMsg('bot', template, true);
        if (err.extra && err.extra.length) {
          console.warn('[打药窗] 大模型改写出现新数字，已拦截:', err.extra);
        }
      } else {
        appendMsg('bot', template, true);
      }
    });
  }

  /* =========================================================
     事件
     ========================================================= */
  $('addPlotBtn').onclick = function () { openModal(null); };
  // 弹窗头部现在是「取消 / 标题 / 保存」，没有 × 了；
  // 可选元素一律先判空，避免缺一个按钮就把整段初始化打断
  if ($('modalCancel')) $('modalCancel').onclick = closeModal;
  if ($('modalSave')) $('modalSave').onclick = formSave;
  if ($('modalSave2')) $('modalSave2').onclick = formSave;
  /* 关闭只能点左上角「取消」
     -------------------------------------------------------------
     不提供「点遮罩空白处关闭」：地图拖动、手势回弹、误触空白都会让一次
     填了一半的新增地块凭空消失，而这里没有草稿恢复。桌面端同样只留「取消」。
     以前那段 mousedown/mouseup 双判定（防止拖地图误关）因此整体删除。
  */
  $('fSearchBtn').onclick = formSearch;
  $('fLoc').addEventListener('keydown', function (e) { if (e.key === 'Enter') formSearch(); });
  $('fGeoBtn').onclick = formGeo;

  $('refreshBtn').onclick = function () { if (!state.loading) load(); };
  $('qaSend').onclick = function () { ask(); };
  $('qaInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') ask(); });
  // 示例问题由 content.js 动态渲染，点击走 #qaChips 上的事件委托
  // （见 renderContentLayer，不要在这里逐个绑定，否则渲染后按钮是死的）
  $('aiToggle').onclick = function () {
    if (!LLM || !LLM.hasKey()) { toast('未配置大模型 key，当前为纯规则模式'); return; }
    aiOn = !aiOn;
    LLM.setEnabled(aiOn);
    renderAiToggle();
    toast(aiOn ? '已开启 AI 增强（数字仍来自规则引擎）' : '已切换为纯规则引擎模式');
  };

  /* =========================================================
     视图切换：内容 / 对话 / 我的
     -------------------------------------------------------------
     手机用底部 Tab，电脑用左侧栏。同一套 DOM，只切 .on。
     ========================================================= */
  var currentView = 'content';

  /* 底部 Tab 的滑动胶囊
     不能用百分比算：胶囊是绝对定位在 padding box 上，按钮在 content box 里，
     两者基准不同，按 (100%-12)/3 算宽度会一格格偏，第三个 tab 最明显。
     改成直接量按钮的真实位置，误差为 0；动画仍走 transform，保持 60fps。 */
  function moveTabPill(name) {
    var nav = $('tabBar');
    var pill = $('tabPill');
    if (!nav || !pill) return;
    var tabs = nav.querySelectorAll('[data-view]');
    if (!tabs.length) return;

    var target = null, idx = 0;
    Array.prototype.forEach.call(tabs, function (b, i) {
      if (b.getAttribute('data-view') === name) { target = b; idx = i; }
    });
    if (!target) target = tabs[0];

    var nb = nav.getBoundingClientRect();
    var tb = target.getBoundingClientRect();
    if (!tb.width || !nb.width) return;   // 桌面端底栏隐藏时量不到

    /* 绝对定位的包含块是 padding box，原点在 border 内侧。
       所以偏移必须减掉 nav 的边框宽度，再加上按钮自己的位置——
       之前用 CSS 的 top:6px/bottom:6px 估，按钮 52px 高、内容区 62px 高，
       估出来的胶囊比按钮低 6px、矮 2px，看着就是"没压住"。 */
    var cs = window.getComputedStyle(nav);
    var bw = parseFloat(cs.borderLeftWidth) || 0;
    var bh = parseFloat(cs.borderTopWidth) || 0;

    pill.style.width = tb.width + 'px';
    pill.style.height = tb.height + 'px';
    pill.style.top = (tb.top - nb.top - bh) + 'px';
    pill.style.transform = 'translateX(' + (tb.left - nb.left - bw) + 'px)';
    void idx;
  }

  var scrollMemo = { content: 0, chat: 0, mine: 0 };

  function setView(name) {
    if (['content', 'chat', 'mine'].indexOf(name) < 0) name = 'content';
    var prevView = currentView;
    // 必须在切换 display 之前记：切完再读 scrollY，浏览器的滚动位置已经被夹到 0 了
    var fromY = window.scrollY || 0;
    currentView = name;

    [['content', 'viewContent'], ['chat', 'viewChat'], ['mine', 'viewMine']]
      .forEach(function (pair) {
        var el = $(pair[1]);
        if (el) el.classList.toggle('on', pair[0] === name);
      });

    Array.prototype.forEach.call(document.querySelectorAll('[data-view]'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-view') === name);
    });

    // 聊天视图下输入框贴底，安装提示条会压住它（见 index.html 里的 CSS）
    document.documentElement.classList.toggle('zz-chat', name === 'chat');

    if (name === 'chat') {
      var log = $('qaLog');
      if (log) setTimeout(function () { log.scrollTop = log.scrollHeight; }, 30);
    }
    // 每个视图各记各的滚动位置：切回来还在原地，不会突然跳顶
    if (prevView !== name) {
      scrollMemo[prevView] = fromY;
      // 等一帧再滚：刚切过来的视图还没完成布局，直接 scrollTo 会被截断到很小的值
      var target = name === 'chat' ? 0 : (scrollMemo[name] || 0);
      setTimeout(function () { window.scrollTo(0, target); }, 40);
    }
    moveTabPill(name);
    // 点击瞬间 :active 可能还在生效，等手指松开后再按真实矩形校准一次，
    // 避免胶囊停在按压态的框上（连点切页时以当前视图为准，不写错位置）。
    setTimeout(function () { if (currentView === name) moveTabPill(name); }, 220);

    // 图表是按容器宽度画的：如果数据是在别的视图里加载完的，
    // 那时 content 还是 display:none，量到的宽度是 0，图会按 620 画成小字。
    // 切回来时重画一次，宽度才对。
    if (name === 'content' && state.result) {
      setTimeout(function () { renderCharts(); }, 80);
    }
    if (name === 'mine') {
      renderStandard();
      fillRuleInputs();
      renderChemBasis();
    }
    try { history.replaceState(null, '', '#' + name); } catch (e) { /* file:// 下可能不允许 */ }
  }

  function bindViews() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-view]'), function (b) {
      b.onclick = function () { setView(b.getAttribute('data-view')); };
    });
    // 直接带 #chat / #mine 打开时进对应页（便于分享具体页面）
    var h = (location.hash || '').replace('#', '');
    if (h === 'chat' || h === 'mine') setView(h);
  }

  /* =========================================================
     「我的」页：阈值 / AI / 地块
     ========================================================= */
  var S = window.TianZhiSettings;

  /* ---------- 农事阈值 ---------- */
  /* =========================================================
     「我的」页：作业标准（属地自动套用）
     ========================================================= */

  function stdCity() {
    var p = activePlot();
    return p && p.city ? p.city : '';
  }

  function manualLimitsHtml() {
    var r = T.RULES.spray;
    var rows = [
      ['风速上限', '≤ ' + r.wind_max + ' m/s', '当前为手动值'],
      ['气温区间', r.temp_min + ' – ' + r.temp_max + ' ℃', '当前为手动值'],
      ['作业时段', pad2(r.hours[0]) + ':00 – ' + pad2(r.hours[1]) + ':00', '当前为手动值'],
      ['当日降水', '≤ ' + r.rain_day_max + ' mm', '当前为手动值'],
      ['最短窗口', '≥ ' + r.min_window_hours + ' 小时', '当前为手动值'],
      ['结露门槛', '气温−露点 ≤ ' + r.dew_gap_min + ' ℃ 或湿度 ≥ ' + r.hum_max + '%', '当前为手动值'],
      ['日落收工', '日落前 ' + r.sunset_margin_h + ' 小时', '当前为手动值']
    ];
    return '<div class="std-grid">' + rows.map(function (x) {
      return '<div class="std-row"><div class="std-k">' + esc(x[0]) + '</div>' +
        '<div class="std-v">' + esc(x[1]) + '</div>' +
        '<div class="std-h">' + esc(x[2]) + '</div>' +
        '<span class="std-badge tool">手动</span></div>';
    }).join('') + '</div>';
  }

  function renderStandard() {
    var box = $('stdBox');
    if (!box) return;

    if (!STD) {
      box.innerHTML = '<div class="note">标准库未加载（standards.js 缺失）。当前仍可用下方手动阈值，但无法显示属地依据。</div>';
      return;
    }

    var city = stdCity();
    var st = S ? S.get('standard') : { mode: 'auto' };
    var auto = st.mode !== 'manual';
    var e = STD.effective(city);

    var title = auto
      ? '按' + (e.cityName || '河北省') + '现行文件执行'
      : '手动阈值（已脱离属地标准）';
    var sub = auto
      ? (e.label + ' · 文件查证 ' + STD.CHECKED + (e.stricter ? ' · ' + e.stricter : ''))
      : '滑轴里的数字优先。建议先切回「按标准」看一遍，再决定是否真的需要更严或更宽。';

    var html = '<div class="std-head">' +
      '<div class="std-head-l"><b>' + esc(title) + '</b><span>' + esc(sub) + '</span></div>' +
      '<div class="std-mode">' +
      '<button data-std-mode="auto" class="' + (auto ? 'on' : '') + '">按标准</button>' +
      '<button data-std-mode="manual" class="' + (auto ? '' : 'on') + '">手动</button>' +
      '</div></div>';

    html += auto ? STD.limitsHtml(city) : manualLimitsHtml();

    /* 依据文件清单很长（13 份 + 链接），默认展开会把「我的」撑成几屏，
       收进折叠层：要看原文的再点开，日常只看上面的生效阈值。 */
    var srcHtml = STD.sourcesHtml(city);
    var srcN = (srcHtml.match(/class="std-file"/g) || []).length;
    if (srcHtml) {
      html += '<details class="std-adv" style="margin-top:12px">' +
        '<summary>依据文件清单（' + srcN + ' 份，点开核对原文）</summary>' +
        '<div class="std-adv-body">' + srcHtml + '</div></details>';
    }

    html += '<details class="std-adv" style="margin-top:12px">' +
      '<summary>河北省 11 市收录情况（含未检索到的市）</summary>' +
      '<div class="std-adv-body">' + STD.coverageHtml() + '</div></details>';

    html += '<details class="std-adv">' +
      '<summary>原文摘录（可逐条核对）</summary>' +
      '<div class="std-adv-body">' + STD.quotesHtml(city) + '</div></details>';

    html += '<div class="std-src-note">标准只约束气象条件，不替代农药标签与当地农技部门意见。' +
      '县级文件多为转发省级，未逐县收录；市级未检索到公开文件、或仅有非标准技术口径的，按省级执行。' +
      '每行右侧标注该字段最严的来源；气温上下限来自不同文件时，标上限来源（超上限更危险）。' +
      '作业时段是文件口径的上限，实际每天还会按日落再收紧（例如日落 17:03 → 15 时收工），' +
      '收工时刻在这两天的卡片与逐时表里都会写出来。' +
      '如你们县有更严要求，可在下方手动校准。</div>';

    box.innerHTML = html;
  }

  function setStdMode(mode) {
    if (!S || !STD) return;
    S.save('standard', { mode: mode === 'manual' ? 'manual' : 'auto', city: stdCity() });
    S.applyRules(stdCity());
    fillRuleInputs();
    renderStandard();
    toast(mode === 'manual' ? '已切到手动阈值' : '已恢复按属地标准');
    load();
  }

  function fillRuleInputs() {
    if (!S) return;
    var r;
    var st = S.get('standard');
    if (st.mode !== 'manual' && STD) {
      // 自动模式：滑轴显示当前属地标准的实际数值，而不是旧的本地存储
      r = STD.effective(stdCity()).patch;
    } else {
      r = S.get('rules');
    }
    if ($('setWind')) $('setWind').value = r.wind_max;
    if ($('setTempMin')) $('setTempMin').value = Math.round(r.temp_min);
    if ($('setTempMax')) $('setTempMax').value = Math.round(r.temp_max);
    if ($('setHourStart')) $('setHourStart').value = r.hours_start;
    if ($('setHourEnd')) $('setHourEnd').value = r.hours_end;
    if ($('setRainDay')) $('setRainDay').value = (r.rain_day_max !== undefined ? r.rain_day_max : 0.5);
    syncRuleLabels();
  }

  /** 滑轴旁边的实时数值 */
  function syncRuleLabels() {
    if ($('thWindV') && $('setWind')) $('thWindV').textContent = Number($('setWind').value).toFixed(1) + ' m/s';
    if ($('thTempV') && $('setTempMin') && $('setTempMax')) {
      $('thTempV').textContent = $('setTempMin').value + ' — ' + $('setTempMax').value + ' ℃';
    }
    if ($('thHourV') && $('setHourStart') && $('setHourEnd')) {
      $('thHourV').textContent = $('setHourStart').value + ' — ' + $('setHourEnd').value + ' 时';
    }
    if ($('thRainV') && $('setRainDay')) $('thRainV').textContent = Number($('setRainDay').value).toFixed(1) + ' mm';
  }

  /** 滑轴：拖动即时回显；上下限互相顶住，不让出现反区间 */
  function bindRuleSliders() {
    var pairs = [['setTempMin', 'setTempMax'], ['setHourStart', 'setHourEnd']];
    ['setWind', 'setTempMin', 'setTempMax', 'setHourStart', 'setHourEnd', 'setRainDay'].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.addEventListener('input', function () {
        pairs.forEach(function (p) {
          var a = $(p[0]), b = $(p[1]);
          if (!a || !b) return;
          if (id === p[0] && Number(a.value) > Number(b.value) - 1) b.value = String(Number(a.value) + 1);
          if (id === p[1] && Number(b.value) < Number(a.value) + 1) a.value = String(Number(b.value) - 1);
        });
        syncRuleLabels();
      });
    });
    syncRuleLabels();
  }

  function saveRules() {
    if (!S) return;
    var min = Number($('setTempMin').value);
    var max = Number($('setTempMax').value);
    if (isFinite(min) && isFinite(max) && max <= min) {
      toast('气温上限要大于下限');
      return;
    }
    var start = Number($('setHourStart').value);
    var end = Number($('setHourEnd').value);
    if (isFinite(start) && isFinite(end) && end <= start) {
      toast('作业时段结束要晚于开始');
      return;
    }

    S.save('rules', {
      wind_max: Number($('setWind').value),
      temp_min: min,
      temp_max: max,
      hours_start: start,
      hours_end: end,
      rain_day_max: Number($('setRainDay').value)
    });
    // 手动改了就切到手动模式，否则下一次按属地标准重算会把用户的值覆盖掉，
    // 用户会以为「保存没生效」。
    S.save('standard', { mode: 'manual' });
    S.applyRules(stdCity());
    fillRuleInputs();          // 回填：逻辑层纠正过的值（比如时段写反）要能看出来
    renderStandard();
    toast('已保存为手动阈值，正在重算');
    load();
  }

  /* ---------- AI 设置 ---------- */

  function activeAiMode() {
    var on = $('aiModeTabs') ? $('aiModeTabs').querySelector('button.on') : null;
    return on ? on.getAttribute('data-mode') : 'off';
  }

  function syncAiRows() {
    var mode = activeAiMode();
    if ($('aiRowProxy')) $('aiRowProxy').style.display = mode === 'proxy' ? '' : 'none';
    if ($('aiRowKey')) $('aiRowKey').style.display = mode === 'direct' ? '' : 'none';
    if ($('aiRowModel')) $('aiRowModel').style.display = mode === 'direct' ? '' : 'none';
  }

  function fillAiInputs() {
    if (!S) return;
    var ai = S.get('ai');
    if ($('aiProxyUrl')) $('aiProxyUrl').value = ai.proxyUrl || '';
    if ($('aiKey')) $('aiKey').value = ai.key || '';
    if ($('aiEndpoint')) $('aiEndpoint').value = ai.endpoint || '';
    if ($('aiModeTabs')) {
      Array.prototype.forEach.call($('aiModeTabs').querySelectorAll('button'), function (b) {
        b.classList.toggle('on', b.getAttribute('data-mode') === ai.mode);
      });
    }
    syncAiRows();
  }

  function renderAiStatus() {
    var st = S ? S.aiStatus() : { ok: false, text: '未配置' };
    if ($('aiState')) $('aiState').textContent = st.text;
    if ($('chatSub')) {
      $('chatSub').textContent = st.ok
        ? 'AI 只负责把结论说顺；所有数字来自规则引擎'
        : '纯规则引擎模式：回答由实时气象数据算出，不经过大模型';
    }
    if ($('aiHintBox') && !$('aiHintBox').textContent) {
      $('aiHintBox').innerHTML = '中转模式下前端没有 key，仓库公开也不怕被刷。' +
        '部署方法见仓库里的 <b>worker/README.md</b>。';
    }
  }

  function saveAi() {
    if (!S) return;
    var mode = activeAiMode();
    S.save('ai', {
      mode: mode,
      proxyUrl: ($('aiProxyUrl').value || '').trim(),
      key: ($('aiKey').value || '').trim(),
      endpoint: ($('aiEndpoint').value || '').trim() || 'https://api.deepseek.com/chat/completions'
    });
    var L = window.TianZhiLLM;
    if (L) {
      L.reconfigure();
      aiOn = L.isEnabled();
      if (aiOn) L.setEnabled(true);
    }
    renderAiToggle();
    renderAiStatus();
    fillAiInputs();
    toast('AI 设置已保存');
  }

  function bindMine() {
    if ($('mineAddPlot')) $('mineAddPlot').onclick = function () { openModal(null); };
    if ($('setSaveRules')) $('setSaveRules').onclick = saveRules;
    bindRuleSliders();
    if ($('setResetRules')) {
      $('setResetRules').onclick = function () {
        S.reset('rules');
        S.save('standard', { mode: 'auto', city: stdCity() });
        S.applyRules(stdCity());
        fillRuleInputs();
        renderStandard();
        toast('已恢复按属地标准');
        load();
      };
    }
    if ($('stdBox') && !$('stdBox')._stdBound) {
      $('stdBox')._stdBound = true;
      $('stdBox').addEventListener('click', function (e) {
        var b = e.target && e.target.closest ? e.target.closest('[data-std-mode]') : null;
        if (b) setStdMode(b.getAttribute('data-std-mode'));
      });
    }
    if ($('aiModeTabs')) {
      Array.prototype.forEach.call($('aiModeTabs').querySelectorAll('button'), function (b) {
        b.onclick = function () {
          Array.prototype.forEach.call($('aiModeTabs').querySelectorAll('button'), function (x) {
            x.classList.remove('on');
          });
          b.classList.add('on');
          syncAiRows();
        };
      });
    }
    if ($('aiSave')) $('aiSave').onclick = saveAi;
    if ($('aiTest')) {
      $('aiTest').onclick = function () {
        var btn = this;
        saveAi();                       // 先保存，测的就是屏幕上这套配置
        var L = window.TianZhiLLM;
        if (!L || !L.isEnabled()) {
          $('aiHintBox').textContent = '还没配好：' + (S ? S.aiStatus().text : '未配置');
          return;
        }
        btn.disabled = true;
        var old = btn.textContent;
        btn.textContent = '测试中…';
        L.classify('哪天能打药').then(function (k) {
          $('aiHintBox').innerHTML = '连接正常，模型返回类别：<b>' + k + '</b>';
        }).catch(function (e) {
          $('aiHintBox').textContent = '连接失败：' + (e && e.message || e);
        }).then(function () {
          btn.disabled = false;
          btn.textContent = old;
        });
      };
    }
    fillRuleInputs();
    renderStandard();
    fillAiInputs();
    renderAiStatus();
  }

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
  /* 反事实按钮在手机上默认收起，点标题展开。
     用事件委托挂在 #heroIn 上：这块内容每次重算都会重建，直接绑按钮会丢。 */
  function bindAdvToggle() {
    var box = $('heroIn');
    if (!box) return;
    box.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('.whatif-t') : null;
      if (!t) return;
      var wrap = t.parentNode;
      if (wrap && wrap.classList.contains('whatif')) wrap.classList.toggle('open');
    });
  }

  function bindDrawer() {
    var mask = $('drawerMask');
    var side = $('sidebar');
    var btn = $('menuBtn');
    var closeBtn = $('drawerClose');
    if (!mask || !side || !btn) return;

    function open() {
      side.classList.add('open');
      mask.classList.add('on');
      document.body.style.overflow = 'hidden';
      document.body.classList.add('drawer-open');
      btn.setAttribute('aria-expanded', 'true');
    }
    function close() {
      side.classList.remove('open');
      mask.classList.remove('on');
      document.body.style.overflow = '';
      document.body.classList.remove('drawer-open');
      btn.setAttribute('aria-expanded', 'false');
    }
    function isOpen() { return side.classList.contains('open'); }

    btn.onclick = function (e) {
      e.stopPropagation();
      if (isOpen()) close(); else open();
    };
    mask.onclick = close;
    if (closeBtn) closeBtn.onclick = close;

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isOpen()) close();
    });

    // 在抽屉里向左划也能关掉：手机上第一直觉就是划走
    var tx = 0, ty = 0, tracking = false;
    side.addEventListener('touchstart', function (e) {
      if (!isOpen() || e.touches.length !== 1) return;
      tracking = true; tx = e.touches[0].clientX; ty = e.touches[0].clientY;
    }, { passive: true });
    side.addEventListener('touchend', function (e) {
      if (!tracking) return;
      tracking = false;
      var t = e.changedTouches[0];
      var dx = t.clientX - tx, dy = t.clientY - ty;
      // 横向位移够大且明显大于纵向才当"划走"，否则会和上下滚动打架
      if (dx < -55 && Math.abs(dx) > Math.abs(dy) * 1.6) close();
    }, { passive: true });

    // 切到别的 Tab 时顺手收起，否则抽屉会盖在新页面上
    var tabbar = $('tabBar');
    if (tabbar) tabbar.addEventListener('click', function () { if (isOpen()) close(); });

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
  bindNearby();       // 弹窗里的「附近地点」
  bindDrawer();       // 手机端侧栏抽屉
  renderSolarTerm();     // 节气条 + 节气农事提醒
  renderContentLayer();  // 知识依据 / 资料来源 / 作品说明 / 范围卡 / 示例问题
  bindAnswerNotes();     // 回答下方：详情 / 纠错
  bindBasis();           // 「依据」弹层
  setTimeout(function () { moveTabPill(currentView || 'content'); }, 120);
  var advWide = null;
  function syncAdv(force) {
    var el = $('basisPanel');
    if (!el) return;
    var wide = window.matchMedia('(min-width:900px)').matches;
    if (force || wide !== advWide) { el.open = wide; advWide = wide; }
  }
  window.addEventListener('resize', function () {
    moveTabPill(currentView || 'content');
    syncAdv(false);
  });
  /* 手机上「数据与依据」默认收起，图表是在宽度为 0 的容器里画的；
     点开时按真实宽度重画一次，否则图会被压成一条或字小到看不清。 */
  (function () {
    var el = $('basisPanel');
    if (!el) return;
    el.addEventListener('toggle', function () {
      if (!el.open || !state.result) return;
      setTimeout(function () {
        renderCharts();
        renderNowStrip(state.result);
      }, 40);
    });
  })();
  buildPresets();     // 预设城市按钮已移除，这里只清理旧 DOM
  bindViews();        // 内容 / 对话 / 我的 三个视图
  /* 决策卡插画：某张图缺失时隐藏，换到有图的主题再恢复，不留破图图标 */
  (function () {
    var art = $('dArt');
    if (!art) return;
    art.onload = function () { art.style.display = ''; };
    art.onerror = function () { art.style.display = 'none'; };
  })();
  bindMine();         // 「我的」页：阈值 / AI 设置
  bindMapStage();     // 提前绑定并预加载高德 SDK

  // 把用户改过的阈值先灌进规则引擎，再取第一次天气（否则首屏用的是默认阈值）
  if (S) S.applyRules();

  renderAiToggle();
  appendMsg('bot', CONTENT ? CONTENT.chat.welcomeShort
    : '你好。可以问我哪天适合打药、要不要浇水、这几天什么天气。数字都从实时气象数据算出来，不是我编的。');
  renderPlots();
  syncAdv(true);
  applyWeatherTheme(null);
  load();

})();
