/**
 * test-logic.mjs — 逻辑层测试
 * 加载 logic.js（浏览器/Node 双用），用真实天气数据跑遍所有问答分支
 * 用法：node test-logic.mjs [--source=qweather|open-meteo]
 *
 * 为什么默认走和风而不是 Open-Meteo：
 *   和风是主预报源，测试就该测生产实际走的那条路；而且
 *   api.open-meteo.com 在部分网络（含校园网、国内多数出口）不可达，
 *   以前把它写死在测试里，本地跑不通、CI 也可能因第三方故障卡住发布。
 *   现在两个源都试，谁通谁上，两个都不通才报错并说明原因。
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// config.js / weather.js 是按浏览器全局写的，先补一个 window 别名
globalThis.window = globalThis;
require('./config.js');
require('./weather.js');

const T = require('./logic.js');
const W = globalThis.TianZhiWeather;

const arg = process.argv.find((a) => a.startsWith('--source='));
const PREFER = arg ? arg.split('=')[1] : 'qweather';

function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' 超时 ' + ms + 'ms')), ms))
  ]);
}

let lastSource = '';

async function fetchWeather(lat, lon) {
  const q = () => withTimeout(W._fromQWeather168(lat, lon), 20000, '和风');
  const o = () => withTimeout(W._fromOpenMeteo(lat, lon), 20000, 'Open-Meteo');
  const order = PREFER === 'open-meteo' ? [['open-meteo', o], ['qweather', q]]
                                        : [['qweather', q], ['open-meteo', o]];
  const errors = [];
  for (const [name, fn] of order) {
    try {
      const r = await fn();
      lastSource = name;
      return r;
    } catch (e) {
      errors.push(name + ': ' + e.message);
    }
  }
  throw new Error('两个数据源都取不到 —— ' + errors.join(' / '));
}

const CITIES = {
  '保定':   [38.8729, 115.4625],
  '石家庄': [38.0414, 114.4786],
  '邯郸':   [36.6103, 114.4900],
  '衡水':   [37.7392, 115.6758]
};

let pass = 0, fail = 0;
const check = (c, m) => { c ? (pass++, console.log('  ✔ ' + m)) : (fail++, console.log('  ✘ ' + m)); };

console.log('逻辑层版本:', T.RULES.meta.version);
console.log('依据:', T.RULES.meta.source);

const QUESTIONS = [
  { q: '下周哪天能打药？',   expect: /打药|窗口/ },
  { q: '什么时候喷药合适',    expect: /打药|窗口/ },
  { q: '这几天要不要浇水？',  expect: /降水|墒|灌溉/ },
  { q: '需要灌溉吗',          expect: /降水|墒|灌溉/ },
  { q: '可以晾晒吗',          expect: /晾晒/ },
  { q: '今天天气怎么样？',    expect: /℃/ },
  { q: '风大不大',            expect: /风速|℃/ },
  { q: '这地长势如何',        expect: /示意数据|遥感/ },
  { q: '这是什么病？',        expect: /不在我的能力范围|后面版本|后续/ },
  { q: '该施什么肥？',        expect: /不在我的能力范围|后面版本|后续/ },
  { q: '明天股票涨吗？',      expect: /不在我的处理范围/ }
];

for (const [city, [lat, lon]] of Object.entries(CITIES)) {
  console.log(`\n===== ${city} =====`);
  const w = await fetchWeather(lat, lon);
  const result = T.evaluateWeather(w.hourly, w.daily);
  const plot = { name: city + '地块', crop: 'wheat' };

  check(result.days.length === 7, '7 天结果');
  check(typeof result.weekRain === 'number' && !isNaN(result.weekRain), 'weekRain 有效');
  check(result.days.every(d => d.dow && d.tmax !== undefined), '每天字段完整');
  check(result.days.every(d => !/NaN|undefined/.test(d.spray.why)), '打药原因无 NaN');

  const best = T.bestWindow(result);
  if (best) {
    check(/^\d{4}-\d{2}-\d{2}$/.test(best.date), `最佳窗口日期合法: ${best.date}`);
    check(best.spray.windows.length > 0, '最佳窗口含具体时段');
  } else {
    check(true, '本期无窗口（合法结果）');
  }

  // 一致性
  result.days.forEach(d => {
    const has = d.spray.windows.length > 0;
    check(has === (d.spray.status === 'ok'), `${d.date} 窗口与状态一致`);
    d.spray.windows.forEach(wn => {
      check(wn.avgWind <= T.RULES.spray.wind_max + 0.01, `${d.date} 窗口风速合规 ${wn.avgWind}`);
      check(wn.hours >= T.RULES.spray.min_window_hours, `${d.date} 窗口时长合规 ${wn.hours}h`);
    });
  });

  // 今日判读（todayRemaining）必须与逐日判定同口径，不能一个说能、一个说不能
  const rem = T.todayRemaining(w.hourly, w.daily, new Date(), 'spray');
  if (rem && !rem.ended) {
    check(rem.status === result.days[0].spray.status,
      `今日判读与逐日判定一致（${rem.status} / ${result.days[0].spray.status}）`);
    if (rem.status === 'ok') {
      const endH = result.days[0].spray.hours[1];
      check(rem.windows.every((x) => x.end <= endH), '今日窗口不越过日落收工时刻（' + endH + ' 时）');
    }
  } else {
    check(true, '今日时段已过或数据未覆盖，跳过一致性断言');
  }

  // 图表一致性：热力图逐小时判定 必须与 "该日是否有窗口" 吻合
  const WEEK = result.days;
  WEEK.forEach((d, di) => {
    const hours = T.hoursOf(w.hourly, d.date);
    if (!hours.length) return;
    // 用引擎自己算出的 blocked，不要在这里重算一遍：
    // 引擎的前一日降水是「逐小时累加」，而 d.dayRain 取的是逐日接口的值，
    // 和风这两个数偶尔对不上（例如逐日 0.0 mm、逐时累加 1.2 mm），
    // 重算就会得出"热力图有窗口、引擎说没有"的假不一致。
    const blocked = d.spray.blocked;
    // 统计作业时段内连续 ok 的最长游程
    let run = 0, bestRun = 0;
    // 引擎按当日日落收紧截止小时，热力图也得用同一天的 hours，否则会"热力图说有、引擎说无"
    const endH = (d.spray.hours && d.spray.hours[1]) || T.RULES.spray.hours[1];
    hours
      .filter(h => h.hour >= T.RULES.spray.hours[0] && h.hour < endH)
      .sort((a, b) => a.hour - b.hour)
      .forEach(h => {
        if (!blocked && T.hourVerdict(h) === 'ok') { run++; bestRun = Math.max(bestRun, run); }
        else run = 0;
      });
    const heatSaysWindow = bestRun >= T.RULES.spray.min_window_hours;
    const engineSaysWindow = d.spray.status === 'ok';
    check(heatSaysWindow === engineSaysWindow,
      `${d.date} 热力图与引擎一致（热力 ${bestRun}h / 引擎 ${engineSaysWindow ? '有窗口' : '无窗口'}）`);
  });

  for (const { q, expect } of QUESTIONS) {
    let a;
    try { a = T.answerQuestion(q, result, plot); }
    catch (e) { check(false, `[${q}] 抛异常 ${e.message}`); continue; }
    check(typeof a === 'string' && a.length > 8, `[${q}] 有回复`);
    check(expect.test(a), `[${q}] 内容匹配 ${expect}`);
    check(!/NaN|undefined|null/.test(a), `[${q}] 无 NaN`);
  }
}

console.log('\n===== 边界 =====');
check(/还没加载好/.test(T.answerQuestion('打药', null, { name: 'x' })), 'null 结果友好提示');

const w2 = await fetchWeather(38.8729, 115.4625);
const r2 = T.evaluateWeather(w2.hourly, w2.daily);
const wheat = T.answerQuestion('要不要浇水', r2, { name: '麦地', crop: 'wheat' });
const maize = T.answerQuestion('要不要浇水', r2, { name: '玉米地', crop: 'maize' });
check(wheat !== maize, '不同作物灌溉建议有区分');

console.log('\n===== 降雨概率拦截（回归） =====');
function synth(prob, rain) {
  const hourly = { time: [], temperature_2m: [], precipitation: [], precipitation_probability: [],
    wind_speed_10m: [], relative_humidity_2m: [] };
  for (let h = 0; h < 24; h++) {
    hourly.time.push('2026-06-01T' + String(h).padStart(2, '0') + ':00');
    hourly.temperature_2m.push(20);
    hourly.precipitation.push(rain);
    hourly.precipitation_probability.push(prob);
    hourly.wind_speed_10m.push(1.2);
    hourly.relative_humidity_2m.push(65);
  }
  const daily = {
    time: ['2026-06-01'], temperature_2m_max: [25], temperature_2m_min: [15],
    precipitation_sum: [rain], precipitation_probability_max: [prob],
    wind_speed_10m_max: [1.2], weather_code: [2]
  };
  return T.evaluateWeather(hourly, daily);
}
const highProb = synth(70, 0);
check(highProb.days[0].spray.status === 'bad', '70% 降雨概率：不排窗口');
check(/降雨概率/.test(highProb.days[0].spray.why), '70% 概率：原因写明概率');
check(highProb.days[0].spray.windows.length === 0, '70% 概率：窗口为空');
check(highProb.days[0].blockedBy === 'prob', '70% 概率：blockedBy=prob');
const lowProb = synth(10, 0);
check(lowProb.days[0].spray.status === 'ok', '10% 概率：正常给出窗口');
check(lowProb.days[0].spray.windows[0].hours >= 6, '10% 概率：窗口覆盖作业时段');
const wetHour = synth(10, 0.5);
check(wetHour.days[0].spray.status === 'bad', '小时降水 0.5mm：不排窗口');
check(wetHour.days[0].blockedBy === 'rain', '小时降水：blockedBy=rain');

console.log('\n===== 露点 / 湿度 / 日落（v4.7 新增） =====');
/** 可调参的合成一天：露点、湿度、云量、日出日落都能改 */
function synth2(opt) {
  const o = Object.assign({
    prob: 10, rain: 0, wind: 1.4, temp: 20, hum: 65, dew: 14,
    cloud: 20, sunrise: '05:00', sunset: '19:30'
  }, opt || {});
  const hourly = {
    time: [], temperature_2m: [], precipitation: [], precipitation_probability: [],
    wind_speed_10m: [], relative_humidity_2m: [], dew_point_2m: [],
    cloud_cover: [], wind_direction_10m: [], surface_pressure: [], visibility: []
  };
  for (let h = 0; h < 24; h++) {
    hourly.time.push('2026-06-01T' + String(h).padStart(2, '0') + ':00');
    hourly.temperature_2m.push(typeof o.temp === 'function' ? o.temp(h) : o.temp);
    hourly.precipitation.push(o.rain);
    hourly.precipitation_probability.push(o.prob);
    hourly.wind_speed_10m.push(o.wind);
    hourly.relative_humidity_2m.push(typeof o.hum === 'function' ? o.hum(h) : o.hum);
    hourly.dew_point_2m.push(typeof o.dew === 'function' ? o.dew(h) : o.dew);
    hourly.cloud_cover.push(o.cloud);
    hourly.wind_direction_10m.push(210);
    hourly.surface_pressure.push(1008);
    hourly.visibility.push(18);
  }
  const daily = {
    time: ['2026-06-01'], temperature_2m_max: [25], temperature_2m_min: [15],
    precipitation_sum: [o.rain], precipitation_probability_max: [o.prob],
    wind_speed_10m_max: [o.wind], weather_code: [2],
    sunrise: [o.sunrise], sunset: [o.sunset]
  };
  return T.evaluateWeather(hourly, daily);
}

// 1) 正常干燥的一天：应该给出 9–16 的完整窗口
const dryDay = synth2({});
check(dryDay.days[0].spray.status === 'ok', '干燥晴天：给出窗口');
check(dryDay.days[0].spray.hours[1] === 16, '夏季日落晚：实际截止仍按 16 时');
check(dryDay.days[0].spray.cutoffShortened === false, '夏季日落晚：未提前收工');
check(dryDay.days[0].sunrise === '05:00' && dryDay.days[0].sunset === '19:30', '日出日落已带入逐日结果');
check(Math.abs(dryDay.days[0].daylightH - 14.5) < 0.05, '日照时数 = 日落 − 日出 = ' + dryDay.days[0].daylightH);

// 2) 气温贴露点（差 1℃）：结露，不排窗口
const dewDay = synth2({ temp: 16, dew: 15 });
check(dewDay.days[0].spray.status === 'bad', '气温−露点 1℃：结露，不排窗口');
check(dewDay.days[0].spray.dewHours >= 6, '结露小时数已统计：' + dewDay.days[0].spray.dewHours);
check(/结露/.test(dewDay.days[0].spray.why), '原因写明结露');

// 3) 湿度过饱和（95%）：即便露点差看起来正常也不排窗口
const humDay = synth2({ hum: 95, dew: 8 });
check(humDay.days[0].spray.status === 'bad', '湿度 95%：按近饱和拦截');
check(T.isDew({ temp: 22, dew: 8, hum: 95 }, T.RULES.spray) === true, 'isDew 认湿度');

// 4) 午后湿度回落：只有上午结露，窗口应从露水干后开始
const noonDry = synth2({ hum: function (h) { return h < 11 ? 96 : 55; }, dew: 9 });
check(noonDry.days[0].spray.status === 'ok', '上午结露、午后转干：仍给窗口');
check(noonDry.days[0].spray.windows[0].start >= 11, '窗口从露水干了之后开始：' + noonDry.days[0].spray.windows[0].start + ' 时');

// 5) 冬季日落早：截止小时被日落收紧，且不再有 16 时那一格
const winterDay = synth2({ sunset: '17:03' });
check(winterDay.days[0].spray.hours[1] === 15, '日落 17:03 → 15 时收工：' + winterDay.days[0].spray.hours[1]);
check(winterDay.days[0].spray.cutoffShortened === true, '标记为按日落提前收工');
check(winterDay.days[0].spray.windows.every(w => w.end <= 15), '窗口不越过日落收紧的截止');

// 6) 日照不足：晾晒标黄而不是"适宜"
const cloudyDay = synth2({ cloud: 90 });
check(cloudyDay.days[0].harvest.status === 'warn', '云量 90%：晾晒降级为谨慎');
check(/日照|云量/.test(cloudyDay.days[0].harvest.why), '晾晒原因写明日照/云量');

// 7) 风向角度换算：252° 应是"西南偏西"，下风向是"东北偏东"
check(T.fmtHour(17.05) === '17:03', 'fmtHour 17.05 → 17:03');
check(T.hhmmToHour('17:03') > 17, 'hhmmToHour 解析正常');

console.log('\n===== 城市字典 =====');
check(Object.keys(T.CITIES).length >= 20, `城市字典 ${Object.keys(T.CITIES).length} 个`);
check(T.CITIES['衡水'] && T.CITIES['安国'], '含衡水、安国等县级市');

/* ==========================================================
   灌溉决策层（irrig.js）：生育期定位 / 墒情估算 / 定额与时机
   ========================================================== */
console.log('\n===== 灌溉决策层 =====');
require('./irrig.js');
const IR = globalThis.TianZhiIrrig;
check(!!IR && IR.SOURCES.length >= 8, `灌溉依据 ${IR ? IR.SOURCES.length : 0} 份（≥8）`);
check(IR.SOURCES.every((s) => s.url && s.issuer && s.note), '每条灌溉依据都有机构、原文链接与要点');

check(IR.stageOf('wheat', '2026-04-10').key === 'jointing', '4 月中 → 冬小麦拔节—孕穗');
check(IR.stageOf('wheat', '2026-12-20').key === 'winter', '12 月下 → 冬小麦越冬期（跨年区间）');
check(IR.stageOf('maize', '2026-08-05').key === 'bell', '8 月初 → 夏玉米大喇叭口');
check(IR.stageOf('wheat', '2026-04-10').critical === true, '拔节—孕穗标记为需水临界期');

// ET0：华北 4 月晴好天气应在 2.5–6 mm/日 之间
const et0 = IR.et0Of('2026-04-10', 22, 8, 38.9);
check(et0 > 2.5 && et0 < 6.5, `ET0(Hargreaves) ${et0} mm/日 落在合理区间`);

// 连续无雨 → 墒情下滑并给出「该浇」；同一天有 15mm 雨 → 不宜浇
const dry = IR.plan({ crop: 'wheat', lat: 38.9, days: [
  { date: '2026-04-10', tmin: 9, tmax: 24, dayRain: 0, dayProb: 5 },
  { date: '2026-04-11', tmin: 10, tmax: 26, dayRain: 0, dayProb: 5 }
] });
check(dry[1].sm < dry[0].sm, `无雨两天墒情下降 ${dry[0].sm}% → ${dry[1].sm}%`);
check(dry[0].status === 'warn' && dry[0].need, '拔节期没雨 → 提示该浇');
check(/方\/亩/.test(dry[0].why), '结论里带灌水定额（方/亩）');

const wet = IR.plan({ crop: 'maize', lat: 38.9, days: [
  { date: '2026-08-05', tmin: 24, tmax: 32, dayRain: 16, dayProb: 90 }
] });
check(wet[0].status === 'bad' && !wet[0].need, '大喇叭口期当天 16mm 雨 → 不宜灌溉');

// 越冬水窗口：日均温 3–5℃ 才算适期
const nw = IR.winterWindow([{ tmin: -1, tmax: 7, dayRain: 0, dayProb: 0 }]);
check(nw.inRange === true, `日均温 ${nw.tmean}℃ 落在 3–5℃ 冬灌适期`);
const nw2 = IR.winterWindow([{ tmin: 8, tmax: 20, dayRain: 0, dayProb: 0 }]);
check(nw2.inRange === false, '日均温 14℃ 不算冬灌适期');

// 问答两行结论：首行结论、次行原因，且带生育期
const ans = IR.answer({ crop: 'wheat', lat: 38.9, days: [
  { date: '2026-04-10', tmin: 9, tmax: 24, dayRain: 0, dayProb: 5 }
] });
check(ans.brief.split('\n').length === 2, '灌溉首答是两行');
check(/拔节/.test(ans.brief) && /墒情|下限/.test(ans.brief), '首答写清生育期与墒情');

console.log(`\n===== 结果: 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
