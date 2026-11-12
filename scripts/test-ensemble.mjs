/**
 * test-ensemble.mjs — 用真实集合预报数据验证窗口置信度算法
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const E = require('../web/ensemble.js');

const LAT = 38.478, LON = 116.252;

async function fetchEnsemble(model) {
  const url = 'https://ensemble-api.open-meteo.com/v1/ensemble' +
    '?latitude=' + LAT + '&longitude=' + LON +
    '&hourly=precipitation,temperature_2m,wind_speed_10m' +
    '&models=' + model + '&forecast_days=7&timezone=Asia/Shanghai';
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

let pass = 0, fail = 0;
const check = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };

(async () => {
  console.log('=== 集合预报窗口置信度测试 ===\n');

  /* ---- 1. 取真实数据 ---- */
  console.log('== 1. 数据获取 ==');
  const json = await fetchEnsemble('ecmwf_ifs025');
  check(!!json.hourly, 'ECMWF ensemble returned');

  const data = E.assemble(json);
  check(!!data, 'assemble() works');
  check(data.precip.count >= 20, 'member count = ' + data.precip.count);
  check(!!data.wind && !!data.temp, 'wind + temp members parsed');

  /* ---- 2. 逐小时概率 ---- */
  console.log('\n== 2. 逐小时可作业概率 ==');
  const dates = Object.keys(E.groupByDate(data.precip)).slice(0, 7);
  console.log('   dates: ' + dates.join(', '));

  const first = E.hourlyProbability(data, dates[0]);
  check(!!first, 'hourlyProbability works');
  check(first && first.hours.length > 0, 'hours count = ' + (first ? first.hours.length : 0));
  check(first && first.memberCount === data.precip.count, 'memberCount matches');

  if (first) {
    console.log('   ' + dates[0] + ' 逐小时支持率：');
    console.log('   ' + first.hours.map(h => h.hour + '时:' + Math.round(h.prob * 100) + '%').join('  '));
    check(first.hours.every(h => h.prob >= 0 && h.prob <= 1), 'all probs in [0,1]');
  }

  /* ---- 3. 窗口提取 ---- */
  console.log('\n== 3. 窗口提取 + 置信等级 ==');
  let found = 0;
  const summary = [];
  for (const d of dates) {
    const ev = E.evaluateDay(data, d);
    if (!ev) continue;
    if (ev.best) {
      found++;
      summary.push({
        date: d,
        start: ev.best.start,
        end: ev.best.end,
        hours: ev.best.hours,
        level: ev.best.level.label,
        weakest: Math.round(ev.best.weakest.prob * 100),
        avg: Math.round(ev.best.avgProb * 100)
      });
    } else {
      summary.push({ date: d, windows: 0 });
    }
  }

  console.log('   日期        窗口          时长  最弱支持率  平均  置信');
  summary.forEach(s => {
    if (s.windows === 0) {
      console.log('   ' + s.date + '   (无窗口)');
    } else {
      console.log('   ' + s.date + '  ' +
        (E.pad2(s.start) + ':00-' + E.pad2(s.end) + ':00').padEnd(12) +
        String(s.hours).padStart(3) + 'h' +
        String(s.weakest + '%').padStart(9) +
        String(s.avg + '%').padStart(7) + '   ' + s.level);
    }
  });

  check(found > 0, 'at least one window found across 7 days');

  /* ---- 4. 置信等级单调性 ---- */
  console.log('\n== 4. 等级判定正确性 ==');
  check(E.levelOf(0.9).key === 'high', 'levelOf(0.9) = high');
  check(E.levelOf(0.6).key === 'mid', 'levelOf(0.6) = mid');
  check(E.levelOf(0.3).key === 'low', 'levelOf(0.3) = low');
  check(E.levelOf(0.7).key === 'high', 'levelOf(0.7) = high (boundary)');
  check(E.levelOf(0.5).key === 'mid', 'levelOf(0.5) = mid (boundary)');

  /* ---- 5. 关闭条件文案 ---- */
  console.log('\n== 5. 窗口关闭条件 ==');
  const withWin = summary.find(s => s.hours);
  if (withWin) {
    const ev = E.evaluateDay(data, withWin.date);
    check(!!ev.closeCondition, 'closeCondition generated');
    console.log('   ' + (ev.closeCondition || '(none)').slice(0, 160));
  }

  /* ---- 6. 推迟代价 ---- */
  console.log('\n== 6. 推迟风险对比 ==');
  const r1 = E.riskOnDay(data, dates[0]);
  const r5 = E.riskOnDay(data, dates[4] || dates[dates.length - 1]);
  check(!!r1 && !!r5, 'riskOnDay works');
  if (r1 && r5) {
    console.log('   ' + r1.date + ' 作业风险 ' + Math.round(r1.risk * 100) + '%');
    console.log('   ' + r5.date + ' 作业风险 ' + Math.round(r5.risk * 100) + '%');
    const dc = E.delayCost(data, r1.date, r5.date);
    console.log('   推迟代价: ' + Math.round(dc.deltaRisk * 100) + ' 个百分点，显著=' + dc.meaningful);
    check(typeof dc.deltaRisk === 'number', 'delayCost computes');
  }

  /* ---- 7. 确定性：同样输入同样输出 ---- */
  console.log('\n== 7. 结果可复现 ==');
  const a = E.evaluateDay(data, dates[0]);
  const b = E.evaluateDay(data, dates[0]);
  check(JSON.stringify(a) === JSON.stringify(b), 'same input → same output (deterministic)');

  /* ---- 8. 无数据时优雅退回 ---- */
  console.log('\n== 8. 缺数据时不崩 ==');
  check(E.assemble(null) === null, 'assemble(null) = null');
  check(E.evaluateDay(null, '2026-11-12') === null, 'evaluateDay(null) = null');
  check(E.hourlyProbability({}, '2026-11-12') === null, 'hourlyProbability({}) = null');

  /* ---- 9. 多模型一致性 ---- */
  console.log('\n== 9. 不同模型对比 ==');
  for (const model of ['gfs025', 'icon_seamless']) {
    try {
      const j2 = await fetchEnsemble(model);
      const d2 = E.assemble(j2);
      const e2 = E.evaluateDay(d2, dates[0]);
      const best2 = e2 && e2.best;
      console.log('   ' + model.padEnd(16) + (best2
        ? E.pad2(best2.start) + ':00-' + E.pad2(best2.end) + ':00  ' + best2.level.label + '  成员' + d2.precip.count
        : '无窗口  成员' + d2.precip.count));
      check(!!d2, model + ' assembled');
    } catch (e) {
      console.log('   ' + model + ' FAILED: ' + e.message);
    }
  }

  console.log(`\n===== 结果: 通过 ${pass} / 失败 ${fail} =====`);
  process.exit(fail ? 1 : 0);
})();
