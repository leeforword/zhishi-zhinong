/* =============================================================
   田智 · 天气数据适配层
   -------------------------------------------------------------
   目标：把多个天气数据源统一成一个结构，上层（logic.js / app.js）
   完全不关心数据来自谁。

   统一结构（与 Open-Meteo 原始结构兼容）：
   {
     hourly: { time[], temperature_2m[], precipitation[],
               wind_speed_10m[], relative_humidity_2m[] },
     daily:  { time[], temperature_2m_max[], temperature_2m_min[],
               precipitation_sum[], precipitation_probability_max[],
               wind_speed_10m_max[], weather_code[] },
     // 和风增强（可能为 null）
     minutely: { summary, points:[{time, precip}] } | null,
     warnings: [{ title, type, level, text }] | null,
     sources: ['open-meteo', 'qweather']
   }

   为什么是"双源"而不是一家包干：
     主预报用和风（/v7/weather/168h，168 小时逐时，同化国内站网），
     但和风的免费额度给不了集合预报和多模式，
     而这两样正是本作品"置信度"和"分歧提示"的依据。
     所以分工是：
       · 和风天气   → 主预报（168 小时逐时 + 7 天逐日）+ 分钟级降水 + 灾害预警
       · Open-Meteo → 集合预报（50 成员，算置信度）+ 多模式分歧 + 主源故障时兜底
     前者让数字更贴本地，后者让"这个结论有多稳"可量化。
   ============================================================= */
(function (root) {
  'use strict';

  var CFG = root.TIANZHI_CONFIG || {};

  var QW = {
    key: CFG.qweatherKey || '',
    host: CFG.qweatherHost || '',
    enabled: CFG.enableQWeather !== false && !!CFG.qweatherKey && !!CFG.qweatherHost
  };

  var stats = { base: 'none', lastError: null, extras: [] };

  function hasQWeather() { return QW.enabled; }
  function getSource() { return stats.base; }
  function getStats() { return stats; }

  /* ---------------- 通用请求 ---------------- */
  function fetchJSON(url, ms) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, ms || 12000);
    return fetch(url, { signal: ctrl.signal }).then(function (r) {
      clearTimeout(timer);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }, function (e) {
      clearTimeout(timer);
      throw e;
    });
  }

  /* ============================================================
     一、Open-Meteo：主预报
     ============================================================ */
  function fromOpenMeteo(lat, lon) {
    var u = new URL('https://api.open-meteo.com/v1/forecast');
    u.searchParams.set('latitude', lat);
    u.searchParams.set('longitude', lon);
    u.searchParams.set('hourly', 'temperature_2m,precipitation,wind_speed_10m,relative_humidity_2m');
    u.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min,precipitation_sum,' +
      'precipitation_probability_max,wind_speed_10m_max,weather_code');
    u.searchParams.set('timezone', 'Asia/Shanghai');
    u.searchParams.set('forecast_days', '7');

    return fetchJSON(u.toString(), 15000).then(function (j) {
      if (!j.hourly || !j.daily) throw new Error('Open-Meteo 返回不完整');
      stats.base = 'open-meteo';
      return {
        hourly: j.hourly,
        daily: j.daily,
        resolution: '9–11 km'
      };
    });
  }

  /* ============================================================
     二、和风天气：分钟级降水 + 灾害预警
     ============================================================ */

  function qwUrl(path) {
    return 'https://' + QW.host + path +
      (path.indexOf('?') >= 0 ? '&' : '?') + 'key=' + encodeURIComponent(QW.key);
  }

  function qwGet(path) {
    return fetchJSON(qwUrl(path), 9000).then(function (j) {
      if (String(j.code) !== '200') throw new Error('和风 code=' + j.code);
      return j;
    });
  }

  function locParam(lat, lon) {
    return lon.toFixed(4) + ',' + lat.toFixed(4);
  }

  /** 分钟级降水：未来 2 小时，每 5 分钟一个点 */
  function getMinutely(lat, lon) {
    return qwGet('/v7/minutely/5m?location=' + locParam(lat, lon)).then(function (j) {
      var pts = (j.minutely || []).map(function (m) {
        return {
          time: String(m.fxTime || '').slice(0, 16),
          precip: parseFloat(m.precip) || 0
        };
      });
      var wet = pts.filter(function (p) { return p.precip > 0; });
      return {
        summary: j.summary || '',
        points: pts,
        // 多久之后开始下雨（分钟），没有则 null
        startsInMin: wet.length ? pts.indexOf(wet[0]) * 5 : null,
        maxPrecip: pts.reduce(function (a, p) { return Math.max(a, p.precip); }, 0)
      };
    }).catch(function () { return null; });
  }

  /** 灾害预警
   *
   *  注意：旧接口 /v7/warning/now 已被和风官方废弃，现在固定返回 403 Deprecated。
   *  新接口 /weatheralert/v1/current/{lat}/{lon} 用同一把 key 即可访问
   *  （虽然文档写的是 JWT Bearer，实测 key 参数式和 key 头式两种都能通）。
   *  返回结构也变了：老的是 warning[]，新的是 alerts[]。
   */
  var SEVERITY_LEVEL = {
    extreme: '红', severe: '橙', moderate: '黄', minor: '蓝', unknown: ''
  };

  function getWarnings(lat, lon) {
    // 新接口要求经纬度最多两位小数
    var la = Number(lat).toFixed(2), lo = Number(lon).toFixed(2);
    return qwGet('/weatheralert/v1/current/' + la + '/' + lo).then(function (j) {
      var list = (j.alerts || []).map(function (w) {
        var sev = w.severity || 'unknown';
        var color = (w.color && w.color.code) || '';
        return {
          title: w.headline || ((w.eventType && w.eventType.name) || '天气预警'),
          type: (w.eventType && w.eventType.name) || '',
          level: color || SEVERITY_LEVEL[sev] || '',
          severity: sev,
          text: w.description || '',
          instruction: w.instruction || '',
          sender: w.senderName || '',
          expire: w.expireTime || ''
        };
      });
      return list.length ? list : null;
    }).catch(function () { return null; });
  }

  /** 并行取增强数据，任一失败都返回 null，不阻塞主流程 */
  function getQWeatherExtras(lat, lon) {
    if (!QW.enabled) return Promise.resolve({ minutely: null, warnings: null });
    return Promise.all([getMinutely(lat, lon), getWarnings(lat, lon)])
      .then(function (r) {
        if (r[0]) stats.extras.push('minutely');
        if (r[1]) stats.extras.push('warnings');
        return { minutely: r[0], warnings: r[1] };
      })
      .catch(function () { return { minutely: null, warnings: null }; });
  }

  /* ============================================================
     二·五、和风 168 小时逐时 —— 主预报（默认首选）
     -------------------------------------------------------------
     早期版本把和风只当"兜底 + 分钟级降水"，是因为当时判断和风
     只能给城市级预报。2026-11 重新实测后纠正了这个判断：

       /v7/weather/168h  → 真的返回 168 小时逐时，字段齐全
         （temp / precip / windSpeed / humidity / pop 每小时都有）

     所以现在让和风做主源，理由不是"国产优先"，而是它更适合这块地：
       · 和风同化了国内地面观测站，县域尺度的温度/风和实况更贴
       · 它的降水包含"逐小时降水概率 pop"，Open-Meteo 的逐时没有
       · Open-Meteo 是 9–11 km 的全球模式插值，代表县域而非地块

     仍然保留 Open-Meteo 的两个不可替代用途：
       · 集合预报（50 个成员）→ 打药窗口的置信度靠它
       · 多模式分歧（ECMWF/GFS/ICON/CMA）→ 用来暴露不确定性
     这两项和风的免费额度给不了，缺了它们反而会"看起来更确定、其实更不可靠"。

     ⚠️ 单位换算：和风 windSpeed 是 km/h，本项目内部统一用 m/s。
     ============================================================ */
  function fromQWeather168(lat, lon) {
    var loc = locParam(lat, lon);
    return Promise.all([
      qwGet('/v7/weather/168h?location=' + loc),
      qwGet('/v7/weather/7d?location=' + loc)
    ]).then(function (res) {
      var hours = res[0].hourly || [];
      var days = res[1].daily || [];
      if (hours.length < 24) throw new Error('和风逐时数据不足（' + hours.length + ' 小时）');
      if (!days.length) throw new Error('和风逐日数据为空');

      var daily = {
        time: [], temperature_2m_max: [], temperature_2m_min: [],
        precipitation_sum: [], precipitation_probability_max: [],
        wind_speed_10m_max: [], weather_code: []
      };
      days.forEach(function (d) {
        var date = String(d.fxDate || '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
        daily.time.push(date);
        daily.temperature_2m_max.push(r1(d.tempMax));
        daily.temperature_2m_min.push(r1(d.tempMin));
        daily.precipitation_sum.push(r1(d.precip));
        daily.wind_speed_10m_max.push(r1(num(d.windSpeedDay) / 3.6));
        var wmo = QW_ICON_TO_WMO[String(d.iconDay)];
        daily.weather_code.push(wmo === undefined ? 3 : wmo);
      });

      /* ⚠️ 这一步很容易被忽略，但不做就会出 NaN：
         和风的 168 小时是从「现在」开始往后数的，所以它会跨 8 个日历日
         （比如 11-12 22:00 → 11-19 21:00）。
         而上层是按"逐时数据里出现的日期"建天、再去逐日数组里取当天的
         最高温、降水概率的 —— 第 8 天在逐日数组里没有对应项，
         取出来就是 undefined，界面上会显示 NaN℃。
         所以这里把逐时裁到"逐日数据覆盖的那 7 天"，两边严格对齐。 */
      var keep = {};
      daily.time.forEach(function (d) { keep[d] = 1; });

      var hourly = {
        time: [], temperature_2m: [], precipitation: [],
        wind_speed_10m: [], relative_humidity_2m: []
      };
      var popByDate = {};

      hours.forEach(function (h) {
        // 和风格式 2026-11-12T21:00+08:00 → 统一裁成 2026-11-12T21:00
        var t = String(h.fxTime || '').slice(0, 16);
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(t)) return;

        var d = t.slice(0, 10);
        if (!keep[d]) return;

        hourly.time.push(t);
        hourly.temperature_2m.push(r1(h.temp));
        hourly.precipitation.push(r1(h.precip));
        hourly.wind_speed_10m.push(r1(num(h.windSpeed) / 3.6));
        hourly.relative_humidity_2m.push(Math.round(num(h.humidity)));

        var pop = num(h.pop);
        if (popByDate[d] === undefined || pop > popByDate[d]) popByDate[d] = pop;
      });

      // 逐日降水概率用当天的逐时最大值，比留 0 诚实
      daily.time.forEach(function (date, i) {
        daily.precipitation_probability_max[i] =
          popByDate[date] === undefined ? 0 : Math.round(popByDate[date]);
      });

      if (hourly.time.length < 24) throw new Error('和风逐时数据不足以覆盖 7 天');

      stats.base = 'qweather';
      return {
        hourly: hourly,
        daily: daily,
        resolution: '和风天气（国内站网同化）',
        sourceLabel: '和风天气'
      };
    });
  }

  /* ============================================================
     三、和风兜底：Open-Meteo 不可用时，用城市预报顶上
     ============================================================ */
  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  /** 和风天气图标码 → WMO code（图表按 WMO 取图标） */
  var QW_ICON_TO_WMO = {
    '100': 0, '101': 2, '102': 2, '103': 2, '104': 3,
    '150': 1, '151': 2, '152': 2, '153': 2,
    '300': 80, '301': 80, '302': 95, '303': 95, '304': 96,
    '305': 61, '306': 63, '307': 65, '308': 65, '309': 51,
    '310': 65, '311': 65, '312': 65, '313': 67, '314': 61,
    '315': 63, '316': 65, '317': 65, '318': 65, '399': 61,
    '400': 71, '401': 73, '402': 75, '403': 75, '404': 61,
    '405': 61, '406': 61, '407': 71, '408': 73, '409': 75,
    '410': 75, '456': 77, '457': 77, '499': 71,
    '500': 45, '501': 48, '502': 45, '503': 45, '504': 45,
    '507': 45, '508': 45, '509': 45, '510': 45, '511': 48,
    '512': 48, '513': 48, '514': 45, '515': 45,
    '900': 32, '901': 32, '999': 3
  };

  function num(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }
  function r1(v) { return Math.round(num(v) * 10) / 10; }

  function fromQWeatherFallback(lat, lon) {
    var loc = locParam(lat, lon);
    return Promise.all([
      qwGet('/v7/weather/24h?location=' + loc),
      qwGet('/v7/weather/7d?location=' + loc)
    ]).then(function (res) {
      var hours = res[0].hourly || [];
      var days = res[1].daily || [];
      if (!hours.length || !days.length) throw new Error('和风数据为空');

      var hourly = { time: [], temperature_2m: [], precipitation: [], wind_speed_10m: [], relative_humidity_2m: [] };
      var daily = {
        time: [], temperature_2m_max: [], temperature_2m_min: [],
        precipitation_sum: [], precipitation_probability_max: [],
        wind_speed_10m_max: [], weather_code: []
      };

      // 真实逐时（未来 24 小时）
      hours.forEach(function (h) {
        hourly.time.push(String(h.fxTime).slice(0, 16));
        hourly.temperature_2m.push(num(h.temp));
        hourly.precipitation.push(num(h.precip));
        hourly.wind_speed_10m.push(num(h.windSpeed) / 3.6);   // km/h → m/s
        hourly.relative_humidity_2m.push(num(h.humidity));
      });

      days.forEach(function (d) {
        var date = String(d.fxDate).slice(0, 10);
        daily.time.push(date);
        daily.temperature_2m_max.push(num(d.tempMax));
        daily.temperature_2m_min.push(num(d.tempMin));
        daily.precipitation_sum.push(num(d.precip));
        daily.precipitation_probability_max.push(0);
        daily.wind_speed_10m_max.push(num(d.windSpeedDay) / 3.6);
        daily.weather_code.push(
          QW_ICON_TO_WMO[String(d.iconDay)] !== undefined ? QW_ICON_TO_WMO[String(d.iconDay)] : 3
        );
      });

      // 24 小时之后按逐日最高/最低余弦插值（图表会标注为估算）
      var last = hourly.time.length ? hourly.time[hourly.time.length - 1] : '';
      days.forEach(function (d) {
        var date = String(d.fxDate).slice(0, 10);
        var tmax = num(d.tempMax), tmin = num(d.tempMin);
        var w = num(d.windSpeedDay) / 3.6;
        for (var hh = 0; hh < 24; hh++) {
          var iso = date + 'T' + pad(hh) + ':00';
          if (hourly.time.indexOf(iso) >= 0 || iso <= last) continue;
          var phase = Math.cos((hh - 15) / 24 * 2 * Math.PI);
          hourly.time.push(iso);
          hourly.temperature_2m.push(Math.round((tmin + (tmax - tmin) * (0.5 + 0.5 * phase)) * 10) / 10);
          hourly.precipitation.push(0);
          hourly.wind_speed_10m.push(Math.round(w * 10) / 10);
          hourly.relative_humidity_2m.push(60);
        }
      });

      // 按时间排序
      var idx = hourly.time.map(function (t, i) { return i; })
        .sort(function (a, b) { return hourly.time[a] < hourly.time[b] ? -1 : 1; });
      var sorted = { time: [], temperature_2m: [], precipitation: [], wind_speed_10m: [], relative_humidity_2m: [] };
      idx.forEach(function (i) {
        sorted.time.push(hourly.time[i]);
        sorted.temperature_2m.push(hourly.temperature_2m[i]);
        sorted.precipitation.push(hourly.precipitation[i]);
        sorted.wind_speed_10m.push(hourly.wind_speed_10m[i]);
        sorted.relative_humidity_2m.push(hourly.relative_humidity_2m[i]);
      });

      stats.base = 'qweather';
      return {
        hourly: sorted,
        daily: daily,
        resolution: '城市级',
        estimatedHours: true
      };
    });
  }

  /* ============================================================
     集合预报（用于窗口置信度）
     -------------------------------------------------------------
     为什么要单独取集合预报：
       确定性预报只给一条曲线，算出来的"窗口"看起来确定，实际上是
       抽签。集合预报给多条曲线，可以算出"有多少比例的成员支持
       这个窗口"，这才是农户真正需要的"这个窗口有多稳"。

     ⚠️ 重要实测结论（2026-11）
       ensemble-api.open-meteo.com 是一个**独立域名**，稳定性明显
       不如主域名 api.open-meteo.com：
         主接口    ：3 次全部 200，耗时 200ms 左右
         集合接口  ：5 次中 3 次连接超时（10s+），2 次成功
       因此这一项必须满足两个条件：
         1. 超时时间要短（5s），绝不能拖慢主流程
         2. 失败要静默降级，界面退回"多模型分歧"方案

     降级方案见下方 getMultiModelHint：
       用主接口一次取 4 个模型的确定性预报，算它们之间的分歧。
       虽然不是真集合，但能反映"不同模式看法是否一致"，
       且在同一个稳定域名上，1 次请求即可。
     ============================================================ */
  var ENSEMBLE_URL = 'https://ensemble-api.open-meteo.com/v1/ensemble';

  function getEnsemble(lat, lon, model) {
    var m = model || 'ecmwf_ifs025';
    var url = ENSEMBLE_URL +
      '?latitude=' + lat.toFixed(4) + '&longitude=' + lon.toFixed(4) +
      '&hourly=precipitation,temperature_2m,wind_speed_10m' +
      '&models=' + m +
      '&forecast_days=7&timezone=Asia%2FShanghai';

    // 5 秒超时：这个域名经常连不上，不能让它拖住整个页面
    return fetchJSON(url, 5000).then(function (j) {
      if (!j || !j.hourly) return null;
      if (j.error) return null;
      stats.extras.push('ensemble:' + m);
      return j;
    }).catch(function () { return null; });
  }

  /* ============================================================
     降级方案：多模型分歧
     -------------------------------------------------------------
     集合预报取不到时，用主接口同时取多个模型的确定性预报，
     看它们对"能不能干活"的判断是否一致。

     局限（必须在界面上说清楚）：
       这不是真正的集合预报，只是 4 个模型之间的分歧。
       但"4 个模型里 4 个都说能打"仍然是一个有意义的信号，
       而且它和主预报在同一个域名，几乎不会失败。
     ============================================================ */
  var MULTI_MODELS = ['best_match', 'ecmwf_ifs025', 'gfs_seamless', 'icon_seamless'];

  function getMultiModel(lat, lon) {
    var url = 'https://api.open-meteo.com/v1/forecast' +
      '?latitude=' + lat.toFixed(4) + '&longitude=' + lon.toFixed(4) +
      '&hourly=precipitation,temperature_2m,wind_speed_10m' +
      '&models=' + MULTI_MODELS.join(',') +
      '&forecast_days=7&timezone=Asia%2FShanghai';

    return fetchJSON(url, 12000).then(function (j) {
      if (!j || !j.hourly) return null;
      stats.extras.push('multi-model');
      return j;
    }).catch(function () { return null; });
  }

  /* ============================================================
     四、对外接口
     ============================================================ */
  /**
   * 取天气
   * @param {number} lat
   * @param {number} lon
   * @param {object} opts { preferSource: 'qweather'|'open-meteo'|'auto' }
   */
  function getWeather(lat, lon, opts) {
    opts = opts || {};
    stats.lastError = null;
    stats.extras = [];
    stats.baseError = null;

    // 默认和风优先（config.js 里 preferSource 可改回 open-meteo）
    var prefer = opts.preferSource || CFG.preferSource || 'qweather';

    var baseP;
    if (prefer === 'open-meteo') {
      baseP = fromOpenMeteo(lat, lon).catch(function (err) {
        stats.lastError = 'Open-Meteo 不可用（' + err.message + '）';
        if (!QW.enabled) throw err;
        return fromQWeather168(lat, lon).catch(function () {
          return fromQWeatherFallback(lat, lon);
        });
      });
    } else {
      // 和风优先：拿得到 168 小时逐时就用它
      baseP = (QW.enabled
        ? fromQWeather168(lat, lon).catch(function (err) {
            stats.baseError = err.message;
            return fromQWeatherFallback(lat, lon);   // 逐时不够时退到城市级估算
          })
        : Promise.reject(new Error('未配置和风天气')))
        .catch(function (err) {
          stats.lastError = '和风不可用（' + (err && err.message || '') + '）';
          // 和风全挂 → 回到 Open-Meteo，保证页面还能出结论
          return fromOpenMeteo(lat, lon);
        });
    }

    // 主预报 + 增强数据并行（集合预报也一起取，取不到不影响主流程）
    return Promise.all([
      baseP,
      getQWeatherExtras(lat, lon),
      getEnsemble(lat, lon),
      getMultiModel(lat, lon)
    ]).then(function (r) {
      var base = r[0], extras = r[1], ens = r[2], multi = r[3];
      base.minutely = extras.minutely;
      base.warnings = extras.warnings;
      base.ensemble = ens;                 // 原始集合数据，由 ensemble.js 解析
      base.multiModel = multi;             // 降级用：多模型确定性预报
      base.sources = [];
      if (stats.base === 'open-meteo') base.sources.push('open-meteo');
      if (stats.base === 'qweather') base.sources.push('qweather');
      if (extras.minutely) base.sources.push('qweather-minutely');
      if (extras.warnings) base.sources.push('qweather-warning');
      if (ens) base.sources.push('ensemble');
      if (multi) base.sources.push('multi-model');
      if (!base.sourceLabel) {
        base.sourceLabel = stats.base === 'qweather' ? '和风天气' :
          (stats.base === 'open-meteo' ? 'Open-Meteo' : '未知源');
      }
      base.baseError = stats.baseError || null;
      return base;
    });
  }

  root.TianZhiWeather = {
    getWeather: getWeather,
    hasQWeather: hasQWeather,
    getSource: getSource,
    getStats: getStats,
    MULTI_MODELS: MULTI_MODELS,
    // 便于调试与测试
    _fromOpenMeteo: fromOpenMeteo,
    _fromQWeather168: fromQWeather168,
    _fromQWeatherFallback: fromQWeatherFallback,
    _getMinutely: getMinutely,
    _getWarnings: getWarnings,
    _getEnsemble: getEnsemble,
    _getMultiModel: getMultiModel
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
