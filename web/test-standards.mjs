/**
 * test-standards.mjs — 作业标准库测试（纯 Node，不联网）
 * -------------------------------------------------------------
 * 这个文件守的是「不能编」这条底线：
 *   · 每条文件必须有编号、名称、发布单位、可访问链接
 *   · 没有全文的条目 limits 必须为 null，不许按标题猜数字
 *   · 合并结果必须能追到具体文件，且取严方向正确
 *   · 问答文本里不能出现 undefined / NaN / null
 *
 * 用法：node web/test-standards.mjs
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

require('./standards.js');
const S = globalThis.TianZhiStandards;

let pass = 0, fail = 0;
const check = (c, m) => { c ? (pass++, console.log('  ✔ ' + m)) : (fail++, console.log('  ✘ ' + m)); };

console.log('标准库查证日期:', S.CHECKED);
console.log('条目数:', S.LIST.length);

/* ---------- 1. 元数据完整性 ---------- */
console.log('\n===== 1. 条目完整性 =====');
const ids = {};
S.LIST.forEach((s) => {
  check(!!s.id && !ids[s.id], `id 唯一：${s.id}`);
  ids[s.id] = 1;
  check(!!s.code && !!s.title, `${s.id} 有编号与名称`);
  check(!!s.issuer, `${s.id} 有发布单位`);
  check(/^https?:\/\//.test(s.url || ''), `${s.id} 有可访问链接`);
  check(!!s.effective || !!s.issued, `${s.id} 有发布/实施时间`);
  check(s.limits === null || typeof s.limits === 'object', `${s.id} limits 为对象或 null（不允许 undefined）`);
  if (s.limits) {
    if (s.limits.wind_max !== undefined) {
      check(s.limits.wind_max > 0 && s.limits.wind_max <= 10, `${s.id} 风速限值合理：${s.limits.wind_max}`);
    }
    if (s.limits.temp_min !== undefined && s.limits.temp_max !== undefined) {
      check(s.limits.temp_min < s.limits.temp_max, `${s.id} 温度区间方向正确`);
    }
    if (s.limits.hours) {
      check(s.limits.hours[0] >= 0 && s.limits.hours[1] <= 24 && s.limits.hours[0] < s.limits.hours[1],
        `${s.id} 时段合法：${s.limits.hours.join('–')}`);
    }
  }
  if (s.binding) check(!!s.limits, `${s.id} 声明参与取严，就必须有数值`);
  if (s.status === 'repealed') check(!s.binding, `${s.id} 已废止，不应参与取严`);
});

/* ---------- 2. 属地合并 ---------- */
console.log('\n===== 2. 属地合并（取严） =====');
const sjz = S.effective('石家庄市');
check(sjz.patch.wind_max === 3.0, '石家庄取市级更严值 3.0 m/s');
check(sjz.by.wind_max === 'db1301-452', '石家庄风速出处指向 DB1301/T 452-2023');
check(sjz.stricter.indexOf('石家庄') >= 0, '石家庄提示「市级更严已优先」');

const hd = S.effective('邯郸市');
check(hd.patch.wind_max === 3.4, '邯郸无市级标准，回落省级 3.4 m/s');
check(hd.patch.temp_min === 5 && hd.patch.temp_max === 30, '邯郸气温 5–30℃');
check(hd.patch.hours_start === 9 && hd.patch.hours_end === 16, '邯郸时段 9–16 时');

const none = S.effective('');
check(none.patch.wind_max === 3.4, '属地未知时按省级 3.4 m/s');
check(none.cityName === '', '属地未知时不编造城市名');

const ts = S.effective('唐山');
check(ts.patch.wind_max === 3.4, '唐山市标准 5 m/s 更宽，不覆盖省级 3.4');

['石家庄', '石家庄市', ' 石家庄市 '].forEach((n) => {
  check(S.normCity(n) === '石家庄市', `地名归一化：${n} → 石家庄市`);
});

/* ---------- 3. 覆盖 11 市 ---------- */
console.log('\n===== 3. 全省覆盖 =====');
const cov = S.coverage();
check(cov.length === 11, '覆盖河北 11 个地级市');
cov.forEach((c) => {
  check(!!c.status && !/undefined/.test(c.status), `${c.city} 有收录状态`);
  check(!!c.note && !/undefined/.test(c.note), `${c.city} 有说明`);
});
check(cov.filter((c) => c.status.indexOf('可执行') >= 0).length >= 1, '至少一个市有可执行标准');
check((cov.filter((c) => c.city === '保定市')[0] || {}).status.indexOf('技术口径') >= 0, '保定标注为技术口径，不当成标准');
check(cov.every((c) => c.status !== '未检索到公开市级文件' || /省级/.test(c.note)),
  '未检索到文件的市都说明按省级执行');

/* ---------- 4. 文本与 HTML ---------- */
console.log('\n===== 4. 输出文本 =====');
const a = S.answer('保定市', '东洼地');
check(a.indexOf('3.4') >= 0, '回答含风速限值');
check(a.indexOf('NY/T 1276-2025') >= 0, '回答引用 NY/T 1276-2025');
check(a.indexOf('DB13/T 5517-2022') >= 0, '回答引用 DB13/T 5517-2022');
check(a.indexOf('保定市') >= 0, '回答点明属地');
check(!/undefined|NaN|null/.test(a), '回答无 undefined / NaN / null');
check(a.indexOf('查证日期') >= 0, '回答标注查证日期');

const sjzA = S.answer('石家庄市', '测试地块');
check(sjzA.indexOf('3.0') >= 0, '石家庄回答用 3.0 m/s');
check(sjzA.indexOf('DB1301/T 452-2023') >= 0, '石家庄回答引用市级标准');

const html = S.limitsHtml('石家庄市') + S.sourcesHtml('石家庄市') +
  S.coverageHtml() + S.quotesHtml('石家庄市');
check(html.length > 500, 'HTML 渲染非空');
check(!/undefined/.test(html), 'HTML 无 undefined');
check(/std-badge/.test(S.limitsHtml('石家庄市')), '限值行带出处徽标');
check(/target="_blank"/.test(S.sourcesHtml('石家庄市')), '文件列表可跳原文');

/* ---------- 5. 与规则引擎联动 ---------- */
console.log('\n===== 5. 规则引擎联动 =====');
const T = require('./logic.js');
T.setRuleSource('测试');
check(T.RULES.meta.source === '测试', 'setRuleSource 可写入出处');
T.applyRuleOverrides(S.effective('石家庄市').patch);
check(T.RULES.spray.wind_max === 3.0, '石家庄补丁写入规则引擎：3.0');
check(T.RULES.spray.hours[0] === 9 && T.RULES.spray.hours[1] === 16, '时段写入 9–16');
check(T.RULES.spray.temp_max === 30, '温度上限写入 30');
T.applyRuleOverrides(S.effective('邯郸市').patch);
check(T.RULES.spray.wind_max === 3.4, '换到邯郸后回到 3.4');

const intent = T.ruleIntent('我这里按什么标准打药？');
check(intent === 'standard', '「按什么标准打药」识别为标准意图');
const intent2 = T.ruleIntent('哪天能打药？');
check(intent2 === 'spray', '普通打药问题仍走 spray');
check(T.INTENT_QUERY.standard && T.INTENT_QUERY.standard.length > 0, '标准意图有标准问法');

console.log(`\n===== 结果: 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
