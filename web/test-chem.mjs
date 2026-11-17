/**
 * test-chem.mjs — 施药天气判定测试（纯 Node，不联网）
 * -------------------------------------------------------------
 * 守的是三条底线：
 *   1. 依据可追溯：每条都有发布机构、条款、URL、查证日期，不许编条款号；
 *   2. 药剂类型真的有差异：除草剂低温是硬拦、杀虫剂低温只是提示；
 *   3. 首答结论先行：两行、有实测数值、可展开，不输出长清单、不做用药建议。
 *
 * 用法：node web/test-chem.mjs
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

require('./chem.js');
const CH = globalThis.TianZhiChem;

let pass = 0, fail = 0;
const check = (c, m) => { c ? (pass++, console.log('  ✔ ' + m)) : (fail++, console.log('  ✘ ' + m)); };

/* ---------------- 构造逐时数据 ---------------- */
const DATES = ['2026-11-17', '2026-11-18', '2026-11-19'];
const pad = h => String(h).padStart(2, '0');
const RULES = {
  spray: {
    wind_max: 3.4, temp_min: 5, temp_max: 30, prob_block: 50,
    rain_hour_max: 0.1, dew_gap_min: 1.5, hum_max: 92,
    sunset_margin_h: 1.5, hours: [9, 16], min_window_hours: 2
  }
};
function mkRaw(opt) {
  const o = {
    time: [], temperature_2m: [], precipitation: [], precipitation_probability: [],
    wind_speed_10m: [], relative_humidity_2m: [], dew_point_2m: [],
    wind_direction_10m: [], cloud_cover: []
  };
  const wind = opt.wind || (() => 2);
  const temp = opt.temp || (() => 12);
  const dew = opt.dew || (() => 8);
  const hum = opt.hum || (() => 60);
  DATES.forEach((d, di) => {
    for (let h = 0; h < 24; h++) {
      o.time.push(d + 'T' + pad(h) + ':00');
      o.wind_speed_10m.push(wind(h, di));
      o.temperature_2m.push(temp(h, di));
      o.dew_point_2m.push(dew(h, di));
      o.relative_humidity_2m.push(hum(h, di));
      o.precipitation.push(0);
      o.precipitation_probability.push(10);
      o.wind_direction_10m.push(252);
      o.cloud_cover.push(50);
    }
  });
  return { hourly: o };
}
function mkResult(opt) {
  return {
    days: DATES.map((d, i) => ({
      date: d, tmax: (opt && opt.tmax) || 16,
      tmin: (opt && opt.tmin !== undefined) ? opt.tmin : 8,
      dayRain: 0, dayProb: 10, sunriseH: 7, sunsetH: 17.2
    }))
  };
}
function ask(q, opt, hour, prev) {
  const m = CH.match(q, prev || null);
  return {
    m,
    a: CH.answer(m, {
      result: (opt && opt.result) || mkResult(opt),
      raw: (opt && opt.raw) || mkRaw(opt || {}),
      rules: RULES, now: new Date('2026-11-17T' + pad(hour === undefined ? 10 : hour) + ':00:00'),
      plot: { name: '莲池区麦田' }
    })
  };
}

console.log('施药依据查证日期:', CH.CHECKED);
console.log('依据文件数:', CH.SOURCES.length, '| 药剂类型:', Object.keys(CH.TYPES).length);

/* ---------------- 1. 依据完整性 ---------------- */
console.log('\n===== 1. 依据可追溯 =====');
const ids = {};
CH.SOURCES.forEach(s => {
  check(!!s.id && !ids[s.id], `id 唯一：${s.id}`);
  ids[s.id] = 1;
  check(!!s.code && !!s.title && !!s.issuer, `${s.id} 有编号/名称/发布机构`);
  check(!!s.clause && !!s.point, `${s.id} 有条款与要点`);
  check(/^https?:\/\//.test(s.url || ''), `${s.id} 有原文链接`);
  check(!!s.level, `${s.id} 标注证据级别`);
});
check(/^\d{4}-\d{2}-\d{2}$/.test(CH.CHECKED), '有查证日期');
check(CH.SOURCES.every(s => s.code.indexOf('7.5.1.3.1') < 0), '不含未经查证的条款号');
check(CH.SOURCES.some(s => s.point.indexOf('5.4 m/s') >= 0), '收录 NY/T 1276 风速红线');
check(CH.SOURCES.some(s => s.point.indexOf('3.3 m/s') >= 0), '收录化学除草风速上限');
check(CH.SOURCES.some(s => s.point.indexOf('8℃') >= 0), '收录河北冬前化除日均温口径');

/* ---------------- 2. 药剂类型阈值 ---------------- */
console.log('\n===== 2. 药剂类型差异 =====');
const T = CH.TYPES;
check(!!T.generic && !!T.herbicide && !!T.insecticide && !!T.fungicide, '四类药剂口径齐全');
check(T.herbicide.wind_stop < T.generic.wind_stop, '除草剂风速上限严于通用');
check(T.herbicide.temp_min_hard === 8 && T.insecticide.temp_min_hard === null,
  '除草剂有低温硬下限，杀虫剂没有（只是药效变慢）');
check(T.insecticide.temp_min_ideal === 15, '杀虫剂 15℃ 为适温下限');
check(T.fungicide.rain_free_h >= 4 && T.insecticide.rain_free_h <= 2,
  '保护性杀菌与触杀型杀虫的喷后无雨口径不同');
const Lh = CH.effectiveLimits('herbicide', RULES), Li = CH.effectiveLimits('insecticide', RULES);
check(Lh.wind_stop === 3.3 && Li.wind_stop === 3.4, '属地 3.4 m/s 与药剂阈值取严正确');
check(Lh.temp_min === 8 && Li.temp_min === 5, '属地 5℃ 与药剂硬下限取严正确');

/* ---------------- 3. 逐时判定 ---------------- */
console.log('\n===== 3. 逐项判定 =====');
const good = { hour: 10, wind: 2, temp: 12, rain: 0, prob: 10, hum: 60, dew: 8, cloud: 50, dir: 252 };
const cGood = CH.checkHour('herbicide', good, { hours: [], work: [9, 16] }, Lh);
check(cGood.ok && cGood.worst === 'ok', '适宜逐时通过');
const cWind = CH.checkHour('herbicide', Object.assign({}, good, { wind: 6.7 }), { work: [9, 16] }, Lh);
check(!cWind.ok && cWind.items.some(x => x.name === '风' && x.state === 'bad'), '大风判不可施');
const cDew = CH.checkHour('herbicide', Object.assign({}, good, { dew: 11.2 }), { work: [9, 16] }, Lh);
check(!cDew.ok && cDew.items.some(x => x.name === '叶面' && x.state === 'bad'), '结露判不可施');
const cColdH = CH.checkHour('herbicide', Object.assign({}, good, { temp: 4 }), { work: [9, 16] }, Lh);
const cColdI = CH.checkHour('insecticide', Object.assign({}, good, { temp: 8 }), { work: [9, 16] }, Li);
const tempH = cColdH.items.filter(x => x.name === '温度')[0];
const tempI = cColdI.items.filter(x => x.name === '温度')[0];
check(tempH.state === 'bad', '除草剂 4℃ 硬拦（药害风险）');
check(tempI.state === 'warn' && /不是禁施/.test(tempI.text), '杀虫剂 8℃ 只提示药效偏慢，不禁施');
const cNight = CH.checkHour('herbicide', Object.assign({}, good, { hour: 20 }), { work: [9, 16] }, Lh);
check(!cNight.ok && cNight.items.some(x => x.name === '时段'), '夜间不会被误判为「现在能打」');
const cHum = CH.checkHour('herbicide', Object.assign({}, good, { hum: 30 }), { work: [9, 16] }, Lh);
check(!cHum.ok && cHum.items.some(x => x.name === '湿度'), '相对湿度 <40% 判不可施');

/* ---------------- 4. 识别与追问 ---------------- */
console.log('\n===== 4. 需求理解与追问 =====');
check(CH.match('我想打除草剂，现在能打吗？').type === 'herbicide', '识别除草剂');
check(CH.match('吡虫啉现在能打吗？').type === 'insecticide', '识别具体杀虫剂药名');
check(CH.match('戊唑醇今天能打吗？').type === 'fungicide', '识别具体杀菌剂药名');
check(CH.match('有露水能打药吗？').topic === 'dew', '识别露水话题');
check(CH.match('风这么大会飘到邻田吗？').topic === 'drift', '识别飘移话题');
check(CH.match('打完药几小时下雨要紧吗？').topic === 'rain', '识别喷后遇雨话题');
check(CH.match('那明天呢？', { type: 'herbicide', dayIdx: 0 }).dayIdx === 1, '追问「明天」切到次日');
check(CH.match('换成杀虫剂呢？', { type: 'herbicide', dayIdx: 0 }).type === 'insecticide', '追问换药种');
check(CH.match('那明天呢？', { type: 'herbicide', dayIdx: 0 }).type === 'herbicide', '追问不改日期时保留药种');
check(CH.match('我要打百草枯').kind === 'banned', '禁用药剂合规拦截');
check(CH.match('我家小麦该打什么药？', { type: 'insecticide', dayIdx: 1 }).type === 'generic',
  '新问题不继承上一轮药种（选药问题必须留给拒答层）');

/* ---------------- 5. 首答形态 ---------------- */
console.log('\n===== 5. 结论先行 / 可展开 =====');
function briefOK(label, q, opt, hour, prev, expect) {
  const { a } = ask(q, opt, hour, prev);
  const lines = a.brief.split('\n');
  check(lines.length === 2, `${label}：首答两行（实际 ${lines.length}）`);
  check(a.brief.length <= 170, `${label}：首答 ≤170 字（实际 ${a.brief.length}）`);
  check(a.brief.indexOf('展开') < 0 && !/【|^\d\./m.test(a.brief), `${label}：首答不含长清单`);
  check(!/推荐|处方|建议用|诊断|剂量|混配/.test(a.brief), `${label}：首答不做用药建议`);
  check(a.brief.indexOf('NaN') < 0 && a.brief.indexOf('undefined') < 0, `${label}：无脏值`);
  if (expect) check(expect.test(a.brief), `${label}：${expect}`);
  return a;
}
const a1 = briefOK('适宜·除草剂', '我想打除草剂，现在能打吗？', {}, 10, null, /可以打/);
check(/10:00|11:00|12:00/.test(a1.brief), '给出具体可作业时段');
briefOK('大风', '今天想打除草剂，风这么大能打吗？', { wind: () => 6.7 }, 10, null, /不能打/);
briefOK('夜间', '现在能打除草剂吗？', {}, 20, null, /不能打/);
briefOK('露水', '有露水能打药吗？', { dew: h => h < 12 ? 11.2 : 8 }, 10, null, /结露/);
briefOK('低温除草', '降温了还能打除草剂吗？', { tmin: 1, temp: () => 6 }, 10, null, /不能打/);
const a2 = ask('那明天呢？', { wind: (h, di) => di === 0 ? 6.7 : 2 }, 20, { type: 'herbicide', dayIdx: 0 });
check(/明天/.test(a2.a.brief) && a2.a.type === 'herbicide', '追问明天：保持药种、换日期');
const a3 = ask('换成杀虫剂呢？', {}, 10, { type: 'herbicide', dayIdx: 0 });
check(a3.a.type === 'insecticide' && /杀虫剂/.test(a3.a.brief), '追问换药种后按新类型重算');
const a4 = ask('飘到邻田怎么办？', {}, 10);
check(/西南偏西|东北偏东/.test(a4.a.detail), '飘移话题给出这块地的实际风向与下风向');
const a5 = ask('我要打百草枯', {}, 10);
check(/不能施用/.test(a5.a.brief) && a5.a.type === 'banned', '禁药拦截不进入天气判定');

console.log('\n===== 6. 展开层依据 =====');
check(/依据文件/.test(a1.detail), '展开层含依据文件清单');
check(/NY\/T 1276/.test(a1.detail), '展开层含国家标准');
check(/https?:\/\//.test(a1.detail), '展开层含可核对链接');
check(/查证日期/.test(a1.detail), '展开层含查证日期');
check(/边界/.test(a1.detail) && /不推荐药剂/.test(a1.detail), '展开层明确能力边界');
check(a1.detail.length > 800, '展开层有实质内容，不是空壳');

/* ---------------- 7. 离线知识库索引 ---------------- */
console.log('\n===== 7. 本地知识库 =====');
require('./kb.js');
const KB = globalThis.TianZhiKB;
const st = KB.stats();
check(st.by['施药依据'] === CH.SOURCES.length, '依据文件全部进入离线索引');
check((st.by['药剂口径'] || 0) === 3, '三类药剂口径进入索引');
check((st.by['施药话题'] || 0) === Object.keys(CH.TOPICS).length, '专项话题进入索引');
check(KB.search('露水', 5).some(e => e.type.indexOf('施药') >= 0), '检索「露水」命中施药依据');
check(KB.search('逆温', 5).some(e => e.type.indexOf('施药') >= 0), '检索「逆温」命中施药依据');

console.log('\n===== RESULT: pass ' + pass + ' / fail ' + fail + ' =====');
process.exit(fail ? 1 : 0);
