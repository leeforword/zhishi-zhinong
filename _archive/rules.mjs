/**
 * 规则引擎 v2：逐小时分析，给出"哪天 + 几点"可作业
 *
 * 关键修正：
 *   v1 用 daily.wind_speed_10m_max（日最大风速）判断打药 → 永远判定"不宜"
 *   v2 用 hourly 数据，在作业时段（6:00-17:00）内找连续可作业窗口
 *
 * 这些阈值来自公开农技常识，均标注「待核实」
 */

export const RULES = {
  _meta: {
    version: '2.0',
    source: '公开农技常识（待核实，正式使用须以当地农技部门指导意见为准）',
    last_updated: '2026-11-10'
  },

  spray: {
    name: '打药',
    hours: [6, 17],                 // 建议作业时段 6:00-17:00
    wind_max: 2.5,                  // 作业时段逐小时风速上限 m/s
    gust_max: 5,                    // 阵风上限 m/s
    temp_min: 5,                    // 最低气温 ℃
    temp_max: 32,                   // 最高气温 ℃
    rain_24h_max: 1,                // 作业前 24h 累计降水上限 mm
    min_window_hours: 2,            // 最小连续可作业时长
    reasons: {
      wind: '风力偏大，药液飘移风险高',
      temp_low: '气温偏低，药效下降',
      temp_high: '气温过高，易产生药害',
      rain: '近期有降雨，药液易被冲刷'
    }
  },

  irrigation: {
    name: '灌溉',
    rain_7d_threshold: 5,           // 未来 7 天累计降水低于此值 → 提示墒情
    hot_temp: 30                    // 最高气温超过此值 → 蒸发大
  },

  harvest: {
    name: '晾晒',
    rain_max: 1,                    // 日降水上限 mm
    prob_max: 50,                   // 降雨概率上限 %
    temp_min: 5
  }
};

const DOW = ['周日','周一','周二','周三','周四','周五','周六'];

/* =========================================================
   逐小时工具
   ========================================================= */
function groupByDay(hourly) {
  const map = new Map();
  hourly.time.forEach((t, i) => {
    const date = t.slice(0, 10);
    if (!map.has(date)) map.set(date, []);
    map.get(date).push({
      hour: parseInt(t.slice(11, 13), 10),
      wind: hourly.wind_speed_10m[i],
      temp: hourly.temperature_2m[i],
      rain: hourly.precipitation[i]
    });
  });
  return map;
}

/** 判断单个小时是否适合打药 */
function hourSprayable(h, rules) {
  if (h.wind > rules.wind_max) return false;
  if (h.temp < rules.temp_min || h.temp > rules.temp_max) return false;
  return true;
}

/** 在一天的作业时段内找连续可打药窗口 */
function findSprayWindows(hours, rules) {
  const [hStart, hEnd] = rules.hours;
  const work = hours.filter(h => h.hour >= hStart && h.hour < hEnd)
                    .sort((a, b) => a.hour - b.hour);

  const windows = [];
  let cur = null;
  for (const h of work) {
    if (hourSprayable(h, rules)) {
      if (!cur) cur = { start: h.hour, end: h.hour, winds: [h.wind], temps: [h.temp] };
      else { cur.end = h.hour; cur.winds.push(h.wind); cur.temps.push(h.temp); }
    } else if (cur) {
      windows.push(cur);
      cur = null;
    }
  }
  if (cur) windows.push(cur);

  return windows
    .filter(w => (w.end - w.start) + 1 >= rules.min_window_hours)
    .map(w => ({
      start: w.start,
      end: w.end + 1,                          // 结束小时改为开区间显示
      hours: (w.end - w.start) + 1,
      avgWind: +(w.winds.reduce((a, b) => a + b, 0) / w.winds.length).toFixed(1),
      maxWind: +Math.max(...w.winds).toFixed(1),
      avgTemp: +(w.temps.reduce((a, b) => a + b, 0) / w.temps.length).toFixed(1)
    }));
}

/** 降水是否超标（取当天及前一天） */
function rainBlocked(dayHours, prevDayHours, rules) {
  const dayRain = dayHours.reduce((a, h) => a + (h.rain || 0), 0);
  const prevRain = prevDayHours ? prevDayHours.reduce((a, h) => a + (h.rain || 0), 0) : 0;
  return { blocked: dayRain > 0.5 || prevRain >= rules.rain_24h_max, dayRain, prevRain };
}

/* =========================================================
   主入口
   ========================================================= */
export function evaluateWeather(hourly, daily) {
  const rules = RULES;
  const byDay = groupByDay(hourly);
  const dates = [...byDay.keys()].sort();
  const di = Object.fromEntries(daily.time.map((t, i) => [t, i]));

  const results = dates.map((date, idx) => {
    const hours = byDay.get(date);
    const prev = idx > 0 ? byDay.get(dates[idx - 1]) : null;
    const j = di[date];

    const dayRain  = +(daily.precipitation_sum[j] ?? 0).toFixed(1);
    const dayProb  = daily.precipitation_probability_max?.[j] ?? 0;
    const tmax     = Math.round(daily.temperature_2m_max[j]);
    const tmin     = Math.round(daily.temperature_2m_min[j]);
    const windMax  = +(daily.wind_speed_10m_max?.[j] ?? 0).toFixed(1);

    // --- 打药 ---
    const rain = rainBlocked(hours, prev, rules.spray);
    let sprayWindows = findSprayWindows(hours, rules.spray);
    let sprayStatus, sprayWhy;
    if (rain.blocked) {
      sprayWindows = [];
      sprayStatus = 'bad';
      sprayWhy = rules.spray.reasons.rain + `（当天 ${rain.dayRain.toFixed(1)}mm）`;
    } else if (sprayWindows.length === 0) {
      sprayStatus = 'bad';
      // 找出真正的限制因素：统计作业时段内每个小时的失败原因，取最多的那个
      const workHours = hours.filter(h => h.hour >= rules.spray.hours[0] && h.hour < rules.spray.hours[1]);
      const cnt = { wind: 0, temp_low: 0, temp_high: 0 };
      workHours.forEach(h => {
        if (h.temp < rules.spray.temp_min) cnt.temp_low++;
        else if (h.temp > rules.spray.temp_max) cnt.temp_high++;
        else if (h.wind > rules.spray.wind_max) cnt.wind++;
      });
      const dominant = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0];
      const minWind = Math.min(...workHours.map(h => h.wind));
      if (cnt[dominant] === 0) {
        sprayWhy = rules.spray.reasons.wind + '（无连续 2 小时以上的适宜窗口）';
      } else if (dominant === 'temp_low') {
        sprayWhy = rules.spray.reasons.temp_low + `（作业时段最低 ${Math.min(...workHours.map(h => h.temp)).toFixed(1)}℃）`;
      } else if (dominant === 'temp_high') {
        sprayWhy = rules.spray.reasons.temp_high + `（作业时段最高 ${Math.max(...workHours.map(h => h.temp)).toFixed(1)}℃）`;
      } else {
        sprayWhy = rules.spray.reasons.wind + `（作业时段有 ${cnt.wind} 个小时风速超过 ${rules.spray.wind_max} m/s，最低 ${minWind.toFixed(1)} m/s）`;
      }
    } else {
      const best = sprayWindows.sort((a, b) => b.hours - a.hours)[0];
      sprayStatus = 'ok';
      sprayWhy = `建议 ${String(best.start).padStart(2,'0')}:00–${String(best.end).padStart(2,'0')}:00 作业（连续 ${best.hours} 小时），平均风速 ${best.avgWind} m/s，气温 ${best.avgTemp}℃`;
    }

    // --- 灌溉 ---
    const weekRain = daily.precipitation_sum.reduce((a, b) => a + (b || 0), 0);
    let irrStatus = 'ok', irrWhy = '降水条件正常';
    if (dayRain >= 5) { irrStatus = 'bad'; irrWhy = `当天降水 ${dayRain}mm，无需灌溉`; }
    else if (weekRain < rules.irrigation.rain_7d_threshold && tmax >= rules.irrigation.hot_temp) {
      irrStatus = 'warn'; irrWhy = `7 天累计降水仅 ${weekRain.toFixed(1)}mm 且最高温 ${tmax}℃，注意墒情`;
    } else if (weekRain < rules.irrigation.rain_7d_threshold) {
      irrStatus = 'warn'; irrWhy = `7 天累计降水仅 ${weekRain.toFixed(1)}mm，建议关注墒情`;
    }

    // --- 晾晒 ---
    let harvStatus = 'ok', harvWhy = '天气适宜晾晒';
    if (dayRain >= rules.harvest.rain_max) { harvStatus = 'bad'; harvWhy = `有降水 ${dayRain}mm，不宜晾晒`; }
    else if (dayProb >= rules.harvest.prob_max) { harvStatus = 'warn'; harvWhy = `降雨概率 ${dayProb}%，谨慎晾晒`; }
    else if (tmax < rules.harvest.temp_min) { harvStatus = 'warn'; harvWhy = '气温偏低，晾晒效率低'; }

    return {
      date,
      dow: DOW[new Date(date + 'T00:00:00').getDay()],
      tmax, tmin, dayRain, dayProb, windMax,
      spray: { status: sprayStatus, why: sprayWhy, windows: sprayWindows },
      irrigation: { status: irrStatus, why: irrWhy },
      harvest: { status: harvStatus, why: harvWhy }
    };
  });

  return { days: results, weekRain: +results.reduce((a, d) => a + d.dayRain, 0).toFixed(1) };
}

/** 汇总：未来 7 天最佳作业窗口 */
export function bestWindow(result) {
  const ok = result.days.filter(d => d.spray.status === 'ok' && d.spray.windows.length);
  if (!ok.length) return null;
  return ok.sort((a, b) => {
    const wa = a.spray.windows[0], wb = b.spray.windows[0];
    return wb.hours - wa.hours || wa.avgWind - wb.avgWind;
  })[0];
}
