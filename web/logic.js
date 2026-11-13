/* =============================================================
   知时智农 · 逻辑层
   -------------------------------------------------------------
   纯函数，不依赖 DOM，浏览器与 Node 均可运行。
   浏览器：<script src="logic.js"> 后通过 window.TianZhi 访问
   Node  ：const TianZhi = require('./logic.js')
   ============================================================= */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;                 // Node / 测试
  } else {
    root.TianZhi = api;                   // 浏览器
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ===========================================================
     一、规则库
     阈值来自公开农技常识，未经当地农技部门核定（界面已标注）

     关于风速阈值 3.4 m/s 的说明
     -------------------------------------------------------------
     农药喷雾对风速敏感，原因是飘移（drift）：风会把雾滴带离靶标，
     造成药害、防治失效、邻近作物受害。

     常用经验界线是「3 级风以下可以作业」：
       0–1 级（0–1.5 m/s）  静风/软风，最佳
       2 级（1.6–3.3 m/s）  轻风，可以作业
       3 级（3.4–5.4 m/s）  微风，飘移明显，一般不建议
       4 级以上             不宜作业

     因此取 3 级风的下限 3.4 m/s 作为上限，即「不超过 3 级风」。
     早先版本用 2.5 m/s 偏保守，会把大量实际可作业的时段判掉。

     注意：这个阈值是可调的（见 ensemble.js 的 DEFAULT_RULE），
     农户可以在界面上修改并看到窗口如何变化——阈值本身不该是黑箱。
     =========================================================== */
  var RULES = {
    meta: {
      version: '3.1',
      source: '公开农技常识（待核实，正式使用须以当地农技部门指导意见为准）',
      windBasis: '3 级风下限 3.4 m/s（飘移控制经验界线）'
    },
    spray: {
      name: '打药',
      hours: [6, 17],          // 建议作业时段 6:00–17:00
      wind_max: 3.4,           // 作业时段逐小时风速上限 m/s（≈3 级风）
      temp_min: 5,             // 最低气温 ℃
      temp_max: 32,            // 最高气温 ℃
      rain_day_max: 0.5,       // 当天降水超过此值 → 不宜
      rain_prev_max: 1,        // 前一天降水超过此值 → 不宜
      min_window_hours: 2      // 最小连续可作业时长
    },
    irrigation: {
      name: '灌溉',
      rain_no_need: 5,         // 当天降水达到此值 → 不宜灌溉（白浇）
      prob_block: 70,          // 当天降雨概率达到此值 → 不宜灌溉（等雨）
      rain_7d_enough: 15,      // 未来 7 天累计降水达到此值 → 墒情尚可
      hot_temp: 30             // 最高气温超过此值 → 蒸发大
    },
    harvest: {
      name: '晾晒',
      rain_max: 1,
      prob_max: 50,
      temp_min: 5
    }
  };

  /* ===========================================================
     阈值覆盖（来自「我的」页的用户设置）
     -----------------------------------------------------------
     为什么允许用户改：
       这些阈值来自公开农技常识，没有经过当地农技部门核定。
       与其写死一个数字然后标"待核实"，不如让懂行的人按本地
       标准自己调——风速上限各地差别很大（平原/山区/邻近敏感作物）。

     实现方式：直接修改上面这个 RULES 对象。
       引擎里所有判定都读它，改完立刻生效；下次重算就会用新阈值。
     只覆盖认识的字段，非法值一律忽略（不能让用户把页面玩坏）。
     =========================================================== */
  var OVERRIDABLE = {
    wind_max: 'number', temp_min: 'number', temp_max: 'number',
    rain_day_max: 'number', rain_prev_max: 'number',
    hours_start: 'int', hours_end: 'int', min_window_hours: 'int'
  };

  function applyRuleOverrides(o) {
    if (!o || typeof o !== 'object') return false;
    var s = RULES.spray;
    var changed = false;

    Object.keys(OVERRIDABLE).forEach(function (k) {
      if (!(k in o)) return;
      var v = Number(o[k]);
      if (!isFinite(v)) return;

      if (k === 'hours_start') {
        if (v < 0 || v > 23) return;
        s.hours[0] = Math.round(v);
        changed = true;
        return;
      }
      if (k === 'hours_end') {
        if (v < 1 || v > 24) return;
        s.hours[1] = Math.round(v);
        changed = true;
        return;
      }
      if (k === 'min_window_hours') {
        if (v < 1 || v > 12) return;
        s.min_window_hours = Math.round(v);
        changed = true;
        return;
      }
      // 其余都是正数量：风速/气温/降水
      if (v < 0 || v > 200) return;
      s[k] = v;
      changed = true;
    });

    // 时段起止写反了就纠正，否则窗口永远算不出来
    if (s.hours[1] <= s.hours[0]) s.hours[1] = Math.min(24, s.hours[0] + 1);

    return changed;
  }

  var CROP_NAME = { wheat: '冬小麦', maize: '夏玉米' };

  var DOW = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  /* ===========================================================
     二、常用地点坐标
     -------------------------------------------------------------
     为什么要有这张表：免费地理编码服务对中文县级地名支持很差
     （"保定"会被识别成云南的保定，"衡水"直接查不到），
     所以华北农区主要县市全部内置，保证定位准确。
     坐标为县市中心近似值，用于取天气已经足够（误差约 5–20 km）。

     在线检索只作为兜底，处理表里没有的地名。
     =========================================================== */
  var CITIES = {
    /* ---- 河北 · 地级市 ---- */
    '石家庄': [38.0414, 114.4786], '唐山': [39.6304, 118.1804],
    '秦皇岛': [39.9354, 119.5996], '邯郸': [36.6103, 114.4900],
    '邢台': [37.0682, 114.5048],   '保定': [38.8729, 115.4625],
    '张家口': [40.7681, 114.8869], '承德': [40.9515, 117.9634],
    '沧州': [38.3037, 116.8388],   '廊坊': [39.5379, 116.6835],
    '衡水': [37.7392, 115.6758],

    /* ---- 河北 · 石家庄 ---- */
    '正定': [38.1461, 114.5708], '藁城': [38.0217, 114.8467],
    '晋州': [38.0333, 115.0333], '新乐': [38.3500, 114.6833],
    '鹿泉': [38.0833, 114.3167], '栾城': [37.9000, 114.6500],
    '赵县': [37.7531, 114.7752], '无极': [38.1833, 114.9667],
    '深泽': [38.1833, 115.2000], '行唐': [38.4333, 114.5500],
    '灵寿': [38.3000, 114.3667], '高邑': [37.6167, 114.6167],
    '元氏': [37.7667, 114.5333], '赞皇': [37.6667, 114.3833],
    '平山': [38.2667, 114.2000], '井陉': [38.0333, 114.1333],
    '辛集': [37.9432, 115.2177],

    /* ---- 河北 · 保定 ---- */
    '定州': [38.5164, 114.9918], '安国': [38.4187, 115.3269],
    '高碑店': [39.3268, 115.8737], '涿州': [39.4858, 115.9741],
    '定兴': [39.2667, 115.8000], '徐水': [39.0167, 115.6500],
    '清苑': [38.7667, 115.4833], '满城': [38.9500, 115.3167],
    '蠡县': [38.4833, 115.5833], '博野': [38.4667, 115.4667],
    '望都': [38.7167, 115.1500], '唐县': [38.7500, 114.9833],
    '曲阳': [38.6167, 114.7000], '阜平': [38.8500, 114.2000],
    '涞源': [39.3500, 114.6833], '易县': [39.3500, 115.5000],
    '涞水': [39.3833, 115.7167], '高阳': [38.7000, 115.7833],
    '顺平': [38.8333, 115.1333], '雄县': [38.9833, 116.1167],
    '容城': [39.0500, 115.8667], '安新': [38.9333, 115.9333],
    '雄安': [38.9900, 115.9400],

    /* ---- 河北 · 衡水 ---- */
    '冀州': [37.5500, 115.5833], '深州': [38.0000, 115.5667],
    '枣强': [37.5167, 115.7333], '武邑': [37.8000, 115.8833],
    '武强': [38.0333, 115.9833], '饶阳': [38.2333, 115.7333],
    '安平': [38.2333, 115.5167], '故城': [37.3500, 115.9667],
    '景县': [37.6833, 116.2667], '阜城': [37.8667, 116.1500],

    /* ---- 河北 · 邢台 ---- */
    '南宫': [37.3600, 115.3900], '沙河': [36.8600, 114.5000],
    '宁晋': [37.6247, 114.9196], '巨鹿': [37.2167, 115.0333],
    '隆尧': [37.3500, 114.7667], '柏乡': [37.5000, 114.6833],
    '清河': [37.0400, 115.6700], '威县': [36.9800, 115.2667],
    '临西': [36.8667, 115.5000], '临城': [37.4333, 114.5000],

    /* ---- 河北 · 邯郸 ---- */
    '武安': [36.7000, 114.2000], '大名': [36.2800, 115.1500],
    '魏县': [36.3600, 114.9333], '曲周': [36.7833, 114.9500],
    '磁县': [36.3667, 114.3833], '临漳': [36.3333, 114.6167],
    '成安': [36.4333, 114.6667], '广平': [36.4833, 114.9500],

    /* ---- 河北 · 沧州 ---- */
    '泊头': [38.0833, 116.5833], '任丘': [38.7100, 116.1000],
    '河间': [38.4333, 116.1000], '献县': [38.1906, 116.1258],
    '黄骅': [38.3700, 117.3300], '肃宁': [38.4167, 115.8333],
    '青县': [38.5833, 116.8000], '吴桥': [37.6333, 116.3833],
    '东光': [37.8833, 116.5333], '南皮': [38.0333, 116.7000],

    /* ---- 河北 · 唐山 / 廊坊 ---- */
    '遵化': [40.1900, 117.9600], '迁安': [40.0100, 118.7000],
    '玉田': [39.9000, 117.7500], '乐亭': [39.4300, 118.9100],
    '滦州': [39.7400, 118.7000], '三河': [39.9800, 117.0800],
    '固安': [39.4400, 116.3000], '霸州': [39.1200, 116.3900],
    '永清': [39.3200, 116.5000], '香河': [39.7600, 117.0100],

    /* ---- 河北 · 坝上 / 山区（少量）---- */
    '张北': [41.1600, 114.7200], '蔚县': [39.8400, 114.5900],
    '怀来': [40.4200, 115.5200], '平泉': [40.9900, 118.7000],
    '围场': [41.9400, 117.7600], '丰宁': [41.2100, 116.6500],

    /* ---- 周边省市 ---- */
    '北京': [39.9042, 116.4074], '天津': [39.3434, 117.3616],
    '太原': [37.8706, 112.5489], '大同': [40.0800, 113.3000],
    '济南': [36.6512, 117.1201], '德州': [37.4355, 116.3574],
    '聊城': [36.4569, 115.9852], '滨州': [37.3800, 117.9700],
    '淄博': [36.8100, 118.0600], '潍坊': [36.7100, 119.1600],
    '菏泽': [35.2300, 115.4800], '济宁': [35.4100, 116.5900],
    '安阳': [36.0997, 114.3931], '新乡': [35.3030, 113.9268],
    '濮阳': [35.7600, 115.0300], '鹤壁': [35.7500, 114.3000],
    '焦作': [35.2200, 113.2400], '开封': [34.8000, 114.3100],
    '郑州': [34.7500, 113.6300], '洛阳': [34.6200, 112.4500],
    '商丘': [34.4100, 115.6500]
  };

  /* ===========================================================
     三、天气现象文字（WMO code）
     =========================================================== */
  var WEATHER_TEXT = {
    0: '晴', 1: '晴间多云', 2: '多云', 3: '阴',
    45: '有雾', 48: '雾凇',
    51: '零星小雨', 53: '小雨', 55: '中雨',
    56: '冻毛毛雨', 57: '冻雨',
    61: '小雨', 63: '中雨', 65: '大雨',
    66: '冻雨', 67: '强冻雨',
    71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
    80: '阵雨', 81: '强阵雨', 82: '暴雨',
    85: '阵雪', 86: '强阵雪',
    95: '雷阵雨', 96: '雷雨伴冰雹', 99: '强雷暴伴冰雹'
  };

  function weatherText(code) {
    return WEATHER_TEXT[code] || '—';
  }

  /* ===========================================================
     四、逐小时工具
     =========================================================== */
  function groupByDay(hourly) {
    var map = {};
    var order = [];
    for (var i = 0; i < hourly.time.length; i++) {
      var t = hourly.time[i];
      var date = t.slice(0, 10);
      if (!map[date]) { map[date] = []; order.push(date); }
      map[date].push({
        hour: parseInt(t.slice(11, 13), 10),
        wind: hourly.wind_speed_10m[i],
        temp: hourly.temperature_2m[i],
        rain: hourly.precipitation[i],
        humid: hourly.relative_humidity_2m ? hourly.relative_humidity_2m[i] : null
      });
    }
    order.sort();
    return { map: map, order: order };
  }

  function hourOk(h, r) {
    if (h.temp < r.temp_min || h.temp > r.temp_max) return false;
    if (h.wind > r.wind_max) return false;
    return true;
  }

  /** 在一天的作业时段内找出连续可作业窗口 */
  function findSprayWindows(hours, r) {
    var work = hours.filter(function (h) {
      return h.hour >= r.hours[0] && h.hour < r.hours[1];
    }).sort(function (a, b) { return a.hour - b.hour; });

    var windows = [], cur = null;
    work.forEach(function (h) {
      if (hourOk(h, r)) {
        if (!cur) cur = { start: h.hour, end: h.hour, winds: [h.wind], temps: [h.temp] };
        else { cur.end = h.hour; cur.winds.push(h.wind); cur.temps.push(h.temp); }
      } else if (cur) { windows.push(cur); cur = null; }
    });
    if (cur) windows.push(cur);

    return windows
      .filter(function (w) { return (w.end - w.start) + 1 >= r.min_window_hours; })
      .map(function (w) {
        var sumW = w.winds.reduce(function (a, b) { return a + b; }, 0);
        var sumT = w.temps.reduce(function (a, b) { return a + b; }, 0);
        return {
          start: w.start,
          end: w.end + 1,
          hours: (w.end - w.start) + 1,
          avgWind: round1(sumW / w.winds.length),
          maxWind: round1(Math.max.apply(null, w.winds)),
          avgTemp: round1(sumT / w.temps.length)
        };
      });
  }

  function round1(n) { return Math.round(n * 10) / 10; }

  /* ===========================================================
     五、主评估函数：天气数据 → 农事判断
     =========================================================== */
  function evaluateWeather(hourly, daily) {
    var r = RULES.spray;
    var g = groupByDay(hourly);
    var di = {};
    daily.time.forEach(function (t, i) { di[t] = i; });

    /* 按「逐日」来建天，而不是按「逐时」——
       和风 168h 是从当前小时往后数的，晚上 23 点之后第一批小时就落到明天 0 点，
       今天整天都不在逐时里；如果按逐时建天，今天会整块消失（只剩 6 天）。
       改成以 daily.time 为准，缺逐时的天就按"无可作业时段"处理。 */
    var dayDates = daily.time.slice();
    var days = dayDates.map(function (date, idx) {
      var hours = g.map[date] || [];
      var prev = idx > 0 ? (g.map[dayDates[idx - 1]] || null) : null;
      var j = di[date];

      var dayRain = round1(daily.precipitation_sum[j] || 0);
      var dayProb = daily.precipitation_probability_max ? (daily.precipitation_probability_max[j] || 0) : 0;
      var tmax = Math.round(daily.temperature_2m_max[j]);
      var tmin = Math.round(daily.temperature_2m_min[j]);
      var windMax = round1(daily.wind_speed_10m_max ? (daily.wind_speed_10m_max[j] || 0) : 0);
      var code = daily.weather_code ? daily.weather_code[j] : null;

      /* ---- 打药 ---- */
      var prevRain = prev ? round1(prev.reduce(function (a, h) { return a + (h.rain || 0); }, 0)) : 0;
      var blocked = dayRain > r.rain_day_max || prevRain >= r.rain_prev_max;

      var windows = blocked ? [] : findSprayWindows(hours, r);
      var sprayStatus, sprayWhy;

      if (blocked) {
        sprayStatus = 'bad';
        sprayWhy = '当天或前一天有降雨，药液容易被冲刷，不建议作业';
      } else if (windows.length === 0 && hours.length === 0) {
        // 今天已经过完 / 逐时从明天开始：按逐日判一下雨，其余情况说清原因
        sprayStatus = 'bad';
        sprayWhy = '当天已没有可作业时段（逐小时预报从明天开始）';
      } else if (windows.length === 0) {
        sprayStatus = 'bad';
        var work = hours.filter(function (h) { return h.hour >= r.hours[0] && h.hour < r.hours[1]; });
        // 逐小时分类：cold / hot / wind / ok（与 findSprayWindows 的判定保持一致）
        var cnt = { wind: 0, cold: 0, hot: 0, ok: 0 };
        work.forEach(function (h) {
          if (h.temp < r.temp_min) cnt.cold++;
          else if (h.temp > r.temp_max) cnt.hot++;
          else if (h.wind > r.wind_max) cnt.wind++;
          else cnt.ok++;
        });
        var okCnt = cnt.ok;
        var workLen = work.length;

        var parts = [];
        if (cnt.cold > 0) parts.push(cnt.cold + ' 小时气温低于 ' + r.temp_min + '℃');
        if (cnt.wind > 0) parts.push(cnt.wind + ' 小时风速超过 ' + r.wind_max + ' m/s');
        if (cnt.hot > 0) parts.push(cnt.hot + ' 小时气温高于 ' + r.temp_max + '℃');

        if (okCnt === 0) {
          sprayWhy = '作业时段（6–17 时）' + parts.join('、') + '，没有可作业时间';
        } else if (okCnt === workLen) {
          sprayWhy = '可作业小时不连续，凑不成 ' + r.min_window_hours + ' 小时以上的连续窗口';
        } else {
          sprayWhy = '作业时段（6–17 时，共 ' + workLen + ' 小时）内' + parts.join('、') +
                     '，只有 ' + okCnt + ' 小时达标且不连续，凑不成连续窗口';
        }
      } else {
        var best = windows.slice().sort(function (a, b) { return b.hours - a.hours; })[0];
        sprayStatus = 'ok';
        sprayWhy = '建议 ' + pad2(best.start) + ':00–' + pad2(best.end) + ':00 作业，' +
                   '连续 ' + best.hours + ' 小时，平均风速 ' + best.avgWind + ' m/s，气温 ' + best.avgTemp + '℃';
      }

      /* ---- 灌溉 ----
         三个可行动状态，与打药对齐：
           bad  不宜灌溉（当天已有足量降水 / 明显要下雨 → 白浇）
           ok   无需灌溉（近期降水充足，墒情尚可）
           warn 建议灌溉（近期少雨且较热，该安排了）

         为什么按"当天"判定而不是整周累计：
           整周雨量对七天中每一天都一样，会让七天卡片显示完全相同的结论，
           切换毫无意义。灌溉本来就是"今天该不该浇"的决策，
           所以看当天降水 + 当天是否明显要下雨。 */
      var weekRain = 0;
      for (var k = 0; k < daily.precipitation_sum.length; k++) weekRain += (daily.precipitation_sum[k] || 0);
      weekRain = round1(weekRain);

      var irrR = RULES.irrigation;
      var irrStatus, irrWhy;
      if (dayRain >= irrR.rain_no_need) {
        irrStatus = 'bad';
        irrWhy = '当天降水 ' + dayRain + ' mm，再灌溉就是白浇，建议改日';
      } else if (dayProb >= irrR.prob_block && dayRain < irrR.rain_no_need) {
        irrStatus = 'bad';
        irrWhy = '降雨概率 ' + dayProb + '%，很可能马上有雨，建议等雨后再定';
      } else if (weekRain >= irrR.rain_7d_enough) {
        irrStatus = 'ok';
        irrWhy = '未来 7 天累计降水 ' + weekRain + ' mm，墒情尚可，今日无需灌溉';
      } else if (tmax >= irrR.hot_temp) {
        irrStatus = 'warn';
        irrWhy = '7 天累计降水仅 ' + weekRain + ' mm 且最高温 ' + tmax + '℃，蒸发大，建议安排灌溉';
      } else {
        irrStatus = 'warn';
        irrWhy = '7 天累计降水仅 ' + weekRain + ' mm，墒情可能不足，建议适时灌溉';
      }

      /* ---- 晾晒 ----
           ok   适宜晾晒
           warn 勉强可晒（概率偏高 / 温度偏低，效率低）
           bad  不宜晾晒（有降水） */
      var harvStatus, harvWhy;
      if (dayRain >= RULES.harvest.rain_max) {
        harvStatus = 'bad';
        harvWhy = '有降水 ' + dayRain + ' mm，不宜晾晒';
      } else if (dayProb >= RULES.harvest.prob_max) {
        harvStatus = 'warn';
        harvWhy = '降雨概率 ' + dayProb + '%，晾晒需谨慎，建议备好遮盖';
      } else if (tmax < RULES.harvest.temp_min) {
        harvStatus = 'warn';
        harvWhy = '最高气温仅 ' + tmax + '℃，晾晒效率低';
      } else {
        harvStatus = 'ok';
        harvWhy = '天气晴好，适合晾晒';
      }

      return {
        date: date,
        dow: DOW[new Date(date + 'T00:00:00').getDay()],
        code: code,
        weather: code === null ? '' : weatherText(code),
        tmax: tmax, tmin: tmin,
        dayRain: dayRain, dayProb: dayProb, windMax: windMax,
        spray: { status: sprayStatus, why: sprayWhy, windows: windows, blocked: blocked },
        irrigation: { status: irrStatus, why: irrWhy },
        harvest: { status: harvStatus, why: harvWhy }
      };
    });

    var total = 0;
    days.forEach(function (d) { total += d.dayRain; });

    return { days: days, weekRain: round1(total) };
  }

  function pad2(n) { return String(n).length < 2 ? '0' + n : String(n); }

  /** 未来 7 天最佳作业窗口 */
  function bestWindow(result) {
    if (!result || !result.days) return null;
    var ok = result.days.filter(function (d) {
      return d.spray.status === 'ok' && d.spray.windows.length > 0;
    });
    if (!ok.length) return null;
    return ok.slice().sort(function (a, b) {
      var wa = a.spray.windows.slice().sort(function (x, y) { return y.hours - x.hours; })[0];
      var wb = b.spray.windows.slice().sort(function (x, y) { return y.hours - x.hours; })[0];
      return (wb.hours - wa.hours) || (wa.avgWind - wb.avgWind);
    })[0];
  }

  /* ===========================================================
     六、问答：把结构化结论转成自然语言
     所有数字来自 evaluateWeather，不编造
     =========================================================== */
  function fmtDate(date, result) {
    var dt = new Date(date + 'T00:00:00');
    var d = null;
    if (result && result.days) {
      for (var i = 0; i < result.days.length; i++) {
        if (result.days[i].date === date) { d = result.days[i]; break; }
      }
    }
    return (dt.getMonth() + 1) + '月' + dt.getDate() + '日' + (d ? '（' + d.dow + '）' : '');
  }

  function answerQuestion(q, result, plot) {
    if (!result) return '天气数据还没加载好，请稍等一下再问。';

    var tag = '【' + plot.name + '】';
    var best;

    /* ---- 打药 ---- */
    if (/打药|喷药|施药|农药|喷雾|喷洒|除草剂/.test(q)) {
      var ok = result.days.filter(function (d) {
        return d.spray.status === 'ok' && d.spray.windows.length > 0;
      });

      if (!ok.length) {
        var reasons = [];
        result.days.forEach(function (d) {
          if (reasons.indexOf(d.spray.why) < 0) reasons.push(d.spray.why);
        });
        return tag + '未来一周没有合适的打药窗口。\n\n主要原因：\n' +
          reasons.slice(0, 2).map(function (x) { return '· ' + x; }).join('\n') +
          '\n\n建议再等等天气，或问问当地农技员。';
      }

      var lines = ok.map(function (d) {
        var w = d.spray.windows.slice().sort(function (a, b) { return b.hours - a.hours; })[0];
        return '· ' + fmtDate(d.date, result) + ' ' + pad2(w.start) + ':00–' + pad2(w.end) + ':00' +
          '（' + w.hours + ' 小时，风速 ' + w.avgWind + ' m/s，气温 ' + w.avgTemp + '℃）';
      }).join('\n');

      best = bestWindow(result);
      var bw = best.spray.windows.slice().sort(function (a, b) { return b.hours - a.hours; })[0];

      return tag + '未来一周有 ' + ok.length + ' 天可以打药：\n\n' + lines +
        '\n\n最合适的是 ' + fmtDate(best.date, result) + ' ' + pad2(bw.start) + ':00–' + pad2(bw.end) + ':00，' +
        '连续 ' + bw.hours + ' 小时，平均风速只有 ' + bw.avgWind + ' m/s。\n\n' +
        '判断依据：在 6:00–17:00 作业时段内，逐小时风速不超过 ' + RULES.spray.wind_max +
        ' m/s、气温在 ' + RULES.spray.temp_min + '–' + RULES.spray.temp_max + '℃ 之间，且前后没有降雨。';
    }

    /* ---- 灌溉 ---- */
    if (/浇|灌水|灌溉|墒|水肥|补水|旱|缺水/.test(q)) {
      var today = result.days[0];
      var rainDays = result.days.filter(function (d) { return d.dayRain >= 1; }).length;
      var head = rainDays > 0
        ? '未来一周累计降水 ' + result.weekRain + ' mm，有 ' + rainDays + ' 天可能下雨。'
        : '未来一周累计降水只有 ' + result.weekRain + ' mm，基本没有有效降水。';

      var advice;
      if (result.weekRain < RULES.irrigation.rain_7d_enough) {
        advice = plot.crop === 'wheat'
          ? '现在冬小麦正在越冬前，如果墒情不足，可以趁晴好天气安排冬灌，灌完记得划锄保墒。'
          : '未来一周降水偏少，注意看看土壤墒情，需要时安排灌溉。';
      } else {
        advice = '降水条件基本正常，按平常管理就行。';
      }

      return tag + head + '\n\n今天的判断：' + today.irrigation.why + '。\n\n' + advice +
        '\n\n判断依据：未来 7 天累计降水低于 ' + RULES.irrigation.rain_7d_enough + ' mm 时提示关注墒情；' +
        '当天降水达到 ' + RULES.irrigation.rain_no_need + ' mm 或降雨概率超过 ' +
        RULES.irrigation.prob_block + '% 时不宜灌溉。';
    }

    /* ---- 晾晒 / 收获 ---- */
    if (/晾晒|收获|收粮|晒|收割|入库/.test(q)) {
      var good = result.days.filter(function (d) { return d.harvest.status === 'ok'; });
      if (!good.length) return tag + '未来一周没有太合适的晾晒窗口，降雨或湿度条件不太理想。';
      return tag + '未来一周有 ' + good.length + ' 天适合晾晒：' +
        good.map(function (d) { return fmtDate(d.date, result); }).join('、') + '。\n\n' +
        '判断依据：当天降水小于 ' + RULES.harvest.rain_max + ' mm 且降雨概率低于 ' + RULES.harvest.prob_max + '%。';
    }

    /* ---- 天气 ---- */
    if (/天气|下雨|降水|温度|气温|风|冷不冷|热不热|穿/.test(q)) {
      var t = result.days[0];
      var rainTxt = t.dayRain > 0 ? '预计降水 ' + t.dayRain + ' mm' : '预计没有降水';
      return tag + '今天（' + fmtDate(t.date, result) + '）' + t.weather + '，最高 ' + t.tmax +
        '℃、最低 ' + t.tmin + '℃，' + rainTxt + '，日最大风速 ' + t.windMax + ' m/s。\n\n' +
        '未来一周累计降水 ' + result.weekRain + ' mm。';
    }

    /* ---- 长势 ---- */
    if (/长势|苗情|长得|NDVI|遥感|苗/.test(q)) {
      return tag + '长势判读现在用的是示意数据，真实遥感还没接进来，这是下一个版本要做的事。\n\n' +
        '如果要判断这块地要不要加强管理，可以先看我给的灌溉和打药建议。';
    }

    /* ---- 超出范围：明确拒答 ---- */
    if (/病|虫|草|杂草|肥|土|种|品种|药名|用什么药|打什么药|产量|价格|补贴/.test(q)) {
      return '病虫害识别和测土配方施肥目前还不在我的能力范围内——这两件事需要图像识别和土壤检测数据，是后面版本要做的。\n\n' +
        '我现在能回答：\n· 哪天、几点适合打药\n· 要不要浇水\n· 今天和未来一周的天气';
    }

    /* ---- 兜底 ---- */
    return '这个问题还不在我的处理范围内。你可以这样问我：\n· 哪天能打药？\n· 这几天要不要浇水？\n· 今天天气怎么样？';
  }

  /* ===========================================================
     七、图表数据接口
     =========================================================== */

  /** 取出某一天的逐小时数据（按小时排序） */
  function hoursOf(hourly, date) {
    var out = [];
    for (var i = 0; i < hourly.time.length; i++) {
      if (hourly.time[i].slice(0, 10) === date) {
        out.push({
          hour: parseInt(hourly.time[i].slice(11, 13), 10),
          wind: hourly.wind_speed_10m[i],
          temp: hourly.temperature_2m[i],
          rain: hourly.precipitation[i]
        });
      }
    }
    return out.sort(function (a, b) { return a.hour - b.hour; });
  }

  /** 逐小时是否适合打药（供热力图与曲线标注用） */
  function hourVerdict(h) {
    var r = RULES.spray;
    if (h.temp < r.temp_min) return 'cold';
    if (h.temp > r.temp_max) return 'hot';
    if (h.wind > r.wind_max) return 'wind';
    return 'ok';
  }

  /* 简易确定性伪随机（同一地块每次结果一致，避免"假数据天天变"） */
  function seeded(seed) {
    var s = seed % 2147483647;
    if (s <= 0) s += 2147483646;
    return function () { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
  }

  /**
   * 长势指数趋势（示意数据）
   * 真实遥感未接入，这里用确定性随机游走模拟一个多时相趋势，
   * 界面上必须标注"示意数据"。
   */
  function growthTrend(plot, points) {
    var n = points || 8;
    var seed = 0;
    String(plot.id || plot.name).split('').forEach(function (c) { seed += c.charCodeAt(0); });
    var rnd = seeded(seed * 97 + 13);
    var v = 0.56 + rnd() * 0.14;          // 起点 0.56–0.70
    var out = [];
    var today = new Date();
    for (var i = n - 1; i >= 0; i--) {
      // 每次约 5 天一个时相，往前推
      var d = new Date(today.getTime() - i * 5 * 86400000);
      v += (rnd() - 0.48) * 0.07;
      v = Math.max(0.34, Math.min(0.82, v));
      out.push({
        date: d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()),
        label: (d.getMonth() + 1) + '/' + d.getDate(),
        value: Math.round(v * 100) / 100
      });
    }
    return out;
  }

  /** 一周可行性汇总（给环形图用） */
  function feasibility(result) {
    if (!result || !result.days) return { ok: 0, warn: 0, bad: 0, total: 0 };
    var c = { ok: 0, warn: 0, bad: 0, total: result.days.length };
    result.days.forEach(function (d) {
      var s = d.spray.status;
      if (s === 'ok') c.ok++;
      else if (s === 'bad') c.bad++;
      else c.warn++;
    });
    return c;
  }

  /* ===========================================================
     八、意图识别（供 UI 判断是否需要大模型兜底）
     =========================================================== */

  /**
   * 规则层意图识别，返回 spray / irrigation / harvest / weather / growth / out，
   * 未命中返回 null（null 表示"规则看不懂，可以交给大模型试试"）
   */
  function ruleIntent(q) {
    if (/打药|喷药|施药|农药|喷雾|喷洒|除草剂/.test(q)) return 'spray';
    if (/浇|灌水|灌溉|墒|水肥|补水|旱|缺水/.test(q)) return 'irrigation';
    if (/晾晒|收获|收粮|晒|收割|入库/.test(q)) return 'harvest';
    if (/天气|下雨|降水|温度|气温|风|冷不冷|热不热|穿/.test(q)) return 'weather';
    if (/长势|苗情|长得|NDVI|遥感|苗/.test(q)) return 'growth';
    if (/病|虫|草|杂草|肥|土|种|品种|药名|用什么药|打什么药|产量|价格|补贴/.test(q)) return 'out';
    return null;
  }

  /** 意图 → 标准问法，保证答案里的数字一律由规则引擎产生 */
  var INTENT_QUERY = {
    spray: '哪天能打药',
    irrigation: '这几天要不要浇水',
    harvest: '可以晾晒吗',
    weather: '今天天气怎么样',
    growth: '这地长势如何'
  };

  function answerByIntent(intent, result, plot) {
    var q = INTENT_QUERY[intent];
    if (!q) return null;
    return answerQuestion(q, result, plot);
  }

  /* ===========================================================
     九、坐标系转换
     -------------------------------------------------------------
     高德地图返回 GCJ-02（火星坐标），而：
       - 天气 API 用 WGS-84
       - 我们的河北行政区划 GeoJSON 也是 WGS-84
     两者直线偏差约 300–500 米，县界附近会导致反查错县，
     所以必须先转回 WGS-84 再判断。
     算法为公开的 GCJ-02 加偏/去偏实现。
     =========================================================== */
  var GCJ = {
    a: 6378245.0,
    ee: 0.00669342162296594323
  };

  function outOfChina(lng, lat) {
    return !(lng > 73.66 && lng < 135.05 && lat > 3.86 && lat < 53.55);
  }

  function transformLat(x, y) {
    var ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
    ret += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
    return ret;
  }

  function transformLon(x, y) {
    var ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
    ret += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
    return ret;
  }

  /** WGS-84 → GCJ-02 */
  function wgs84ToGcj(lng, lat) {
    if (outOfChina(lng, lat)) return [lng, lat];
    var dLat = transformLat(lng - 105.0, lat - 35.0);
    var dLon = transformLon(lng - 105.0, lat - 35.0);
    var radLat = lat / 180.0 * Math.PI;
    var magic = Math.sin(radLat);
    magic = 1 - GCJ.ee * magic * magic;
    var sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / ((GCJ.a * (1 - GCJ.ee)) / (magic * sqrtMagic) * Math.PI);
    dLon = (dLon * 180.0) / (GCJ.a / sqrtMagic * Math.cos(radLat) * Math.PI);
    return [lng + dLon, lat + dLat];
  }

  /** GCJ-02 → WGS-84（迭代逼近，精度优于 1 米） */
  function gcjToWgs84(lng, lat) {
    if (outOfChina(lng, lat)) return [lng, lat];
    var wgsLng = lng, wgsLat = lat;
    for (var i = 0; i < 5; i++) {
      var g = wgs84ToGcj(wgsLng, wgsLat);
      var dLng = g[0] - lng;
      var dLat = g[1] - lat;
      if (Math.abs(dLng) < 1e-10 && Math.abs(dLat) < 1e-10) break;
      wgsLng -= dLng;
      wgsLat -= dLat;
    }
    return [wgsLng, wgsLat];
  }

  /* ===========================================================
     十、多气象模式一致性比较
     -------------------------------------------------------------
     不同数值预报模式对同一地点的结论可能明显不同
     （实测：ECMWF 说能打药，GFS/CMA 说不能）。

     这里不取平均、不猜最准，而是如实比较、如实告知分歧。
     展示时按"多数模式一致"的原则给出主结论。
     =========================================================== */

  /** 模式展示名 */
  var MODEL_NAME = {
    ecmwf_ifs025: '欧洲ECMWF',
    gfs_global: '美国GFS',
    icon_global: '德国ICON',
    cma_grapes_global: '中国CMA',
    best_match: '综合推荐'
  };

  /**
   * 比较多个模式的评估结果
   * @param {Array<{model, result}>} list 各模式的 evaluateWeather 结果
   */
  function compareModels(list) {
    if (!list || !list.length) return null;

    var items = list.map(function (it) {
      var okDays = it.result.days.filter(function (d) { return d.spray.status === 'ok'; }).length;
      var best = bestWindow(it.result);
      var bestHours = 0;
      var bestDate = null;
      if (best) {
        var w = best.spray.windows.slice().sort(function (a, b) { return b.hours - a.hours; })[0];
        bestHours = w.hours;
        bestDate = best.date;
      }
      return {
        model: it.model,
        name: MODEL_NAME[it.model] || it.model,
        okDays: okDays,
        bestDate: bestDate,
        bestHours: bestHours,
        weekRain: it.result.weekRain
      };
    });

    var okCounts = items.map(function (x) { return x.okDays; });
    var maxOk = Math.max.apply(null, okCounts);
    var minOk = Math.min.apply(null, okCounts);

    // 分歧判定：
    //   完全一致（全部 >0 或全部 =0）→ consensus
    //   有模式说有窗口、有模式说没有 → divergent（这才是最要紧的）
    var someOk = okCounts.some(function (n) { return n > 0; });
    var allOk = okCounts.every(function (n) { return n > 0; });
    var level = 'consensus';
    if (someOk && !allOk) level = 'divergent';

    // 最佳日期是否一致
    var dates = items.filter(function (x) { return x.bestDate; }).map(function (x) { return x.bestDate; });
    var sameDate = dates.length > 1 && dates.every(function (d) { return d === dates[0]; });

    // 多数派结论
    var votes = {};
    items.forEach(function (x) { votes[x.okDays > 0 ? 'yes' : 'no'] = (votes[x.okDays > 0 ? 'yes' : 'no'] || 0) + 1; });
    var majority = (votes.yes || 0) >= (votes.no || 0) ? 'yes' : 'no';

    return {
      items: items,
      level: level,                  // consensus | divergent
      majority: majority,            // yes | no
      sameDate: sameDate,
      maxOk: maxOk,
      minOk: minOk
    };
  }

  /** 生成人类可读的分歧说明 */
  function describeConsensus(cmp) {
    if (!cmp) return '';
    if (cmp.level === 'consensus') {
      if (cmp.majority === 'no') return '各气象模式一致认为本周没有合适的打药窗口。';
      if (cmp.sameDate) return '各气象模式结论一致，最佳日期相同。';
      return '各气象模式都认为本周有可作业窗口，但具体日期存在差异。';
    }
    // 分歧
    var yes = cmp.items.filter(function (x) { return x.okDays > 0; })
      .map(function (x) { return x.name + ' ' + x.okDays + ' 天'; });
    var no = cmp.items.filter(function (x) { return x.okDays === 0; })
      .map(function (x) { return x.name; });
    var parts = [];
    if (yes.length) parts.push(yes.join('、') + ' 认为可作业');
    if (no.length) parts.push(no.join('、') + ' 认为无窗口');
    return '⚠ 气象模式之间存在分歧：' + parts.join('；') + '。建议临近日期再确认。';
  }

  /* ===========================================================
     今日剩余时段判定
     -------------------------------------------------------------
     为什么不直接看 days[0].spray：
       逐时数据里今天已经过去大半，要求"连续 2 小时"往往无法满足，
       于是早上九点打开页面会看到"今日打药 不宜"这种误导结论。
     这里只统计"从现在到现在之后"的时段，才是真正还能做的事。
     =========================================================== */
  function todayRemaining(hourly, daily, now, ruleKey) {
    var nowD = now || new Date();
    var todayStr = nowD.getFullYear() + '-' + pad2(nowD.getMonth() + 1) + '-' + pad2(nowD.getDate());
    var nowHour = nowD.getHours();

    var r = RULES.spray;
    var g = groupByDay(hourly);
    var hours = g.map[todayStr];
    if (!hours) return null;

    var di = {};
    daily.time.forEach(function (t, i) { di[t] = i; });
    var j = di[todayStr];
    if (j === undefined) return null;

    var dayRain = round1(daily.precipitation_sum[j] || 0);
    var prevRain = 0;

    // 只看尚未结束的小时
    var future = hours.filter(function (h) { return h.hour >= nowHour; });
    if (!future.length) {
      return {
        date: todayStr, ended: true, status: 'bad',
        windows: [], futureHours: 0,
        why: '今日作业时段（' + r.hours[0] + ':00–' + r.hours[1] + ':00）已过'
      };
    }

    if (ruleKey === 'spray' || !ruleKey) {
      var blocked = dayRain > r.rain_day_max || prevRain >= r.rain_prev_max;
      var windows = blocked ? [] : findSprayWindows(future, r);
      var status, why;
      if (blocked) {
        status = 'bad';
        why = '今日已有降雨 ' + dayRain + ' mm，药液容易被冲刷';
      } else if (!windows.length) {
        status = 'bad';
        var bad = future.filter(function (h) { return hourVerdict(h) !== 'ok'; });
        var cold = bad.filter(function (h) { return hourVerdict(h) === 'cold'; }).length;
        var wind = bad.filter(function (h) { return hourVerdict(h) === 'wind'; }).length;
        var bits = [];
        if (cold) bits.push('气温低于 ' + r.temp_min + '℃ 有 ' + cold + ' 小时');
        if (wind) bits.push('风速超 ' + r.wind_max + ' m/s 有 ' + wind + ' 小时');
        why = '今日剩余时段不可作业：' + (bits.length ? bits.join('，') : '气象条件不满足');
      } else {
        status = 'ok';
        var w = windows.slice().sort(function (a, b) { return b.hours - a.hours; })[0];
        why = '今日 ' + pad2(w.start) + ':00–' + pad2(w.end) + ':00 可以作业，连续 ' + w.hours + ' 小时';
      }
      return {
        date: todayStr, ended: false, status: status, why: why,
        windows: windows, futureHours: future.length
      };
    }

    return null;
  }

  /* =========================================================== */
  return {
    RULES: RULES,
    applyRuleOverrides: applyRuleOverrides,
    CROP_NAME: CROP_NAME,
    DOW: DOW,
    CITIES: CITIES,
    weatherText: weatherText,
    evaluateWeather: evaluateWeather,
    todayRemaining: todayRemaining,
    bestWindow: bestWindow,
    answerQuestion: answerQuestion,
    answerByIntent: answerByIntent,
    ruleIntent: ruleIntent,
    INTENT_QUERY: INTENT_QUERY,
    hoursOf: hoursOf,
    hourVerdict: hourVerdict,
    growthTrend: growthTrend,
    feasibility: feasibility,
    wgs84ToGcj: wgs84ToGcj,
    gcjToWgs84: gcjToWgs84,
    MODEL_NAME: MODEL_NAME,
    compareModels: compareModels,
    describeConsensus: describeConsensus,
    pad2: pad2
  };
});
