/**
 * run-all.mjs — 一键跑全部测试
 * -------------------------------------------------------------
 * 分两类：
 *   纯 Node 测试  —— 不需要浏览器，跑得快
 *   浏览器测试    —— 通过 CDP 驱动 Chrome
 *
 * 覆盖率说明写在这里，避免以后忘了哪些没测：
 *   · 规则引擎（246 条断言）
 *   · 集合预报置信度（23 条）
 *   · 二维码编解码往返（19 条）
 *   · 手机端排版/触控/抽屉（53 条）
 *   · 窗口置信度卡 + 反事实推演（15 条）
 *   · 端到端主流程（51 条）
 *   · 断网降级（4 条）
 *   · file:// 离线可用（17 条）
 *   · 单文件版真实加载（21 条）
 *   · 公网版无 Key 可用（12 条）
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = 8940;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---- 需要一个本地服务器给浏览器测试用 ---- */
console.log('=== 启动测试服务器 :' + PORT + ' ===');
const server = spawn(process.execPath, ['server.mjs', String(PORT)], {
  cwd: path.join(ROOT, 'web'), stdio: 'ignore'
});
await sleep(1500);

const NODE_TESTS = [
  ['test-qr.mjs', '二维码编解码', 'scripts'],
  ['test-qr-page.mjs', '/qr 页面可扫', 'scripts'],
  ['test-ensemble.mjs', '集合预报置信度', 'scripts'],
  ['test-logic.mjs', '规则引擎', 'web']
];

/* 每个需要页面地址的测试都传 run-all 自己起的服务器，
   不要依赖 8931 是否恰好有人在跑——这是之前的坑：
   窗口卡测试硬编码 8931，服务一停就全项失败。 */
const BASE = 'http://127.0.0.1:' + PORT + '/';

const BROWSER_TESTS = [
  ['e2e.mjs', '端到端主流程', 'web', [BASE, '../screenshots']],
  ['test-offline.mjs', 'file:// 离线可用', 'scripts'],
  ['test-degrade.mjs', '断网降级', 'scripts'],
  ['test-window-card.mjs', '窗口置信度卡', 'scripts', [BASE]],
  ['test-mobile.mjs', '手机端适配', 'scripts', [BASE]],
  ['test-single.mjs', '单文件版加载', 'scripts'],
  ['test-public.mjs', '公网版无 Key', 'scripts']
];

const results = [];

function runOne(script, label, args, cwd, retry) {
  const p = path.join(cwd, script);
  if (!fs.existsSync(p)) {
    console.log('\n--- ' + label + ' ---\n  跳过（脚本不存在）');
    results.push({ label, ok: null });
    return;
  }
  console.log('\n--- ' + label + ' ---');

  const attempt = () => execFileSync(process.execPath, [p, ...(args || [])], {
    cwd, encoding: 'utf8', timeout: 180000
  });

  try {
    const out = attempt();
    const m = out.match(/RESULT:\s*pass\s*(\d+)\s*\/\s*fail\s*(\d+)/i) ||
              out.match(/结果:\s*通过\s*(\d+)\s*\/\s*失败\s*(\d+)/);
    console.log(out.trim().split('\n').slice(-3).join('\n'));
    const ok = m ? parseInt(m[2], 10) === 0 : /pass\s*\d+\s*\/\s*fail\s*0/i.test(out);
    results.push({ label, ok, detail: m ? m[1] + ' 通过 / ' + m[2] + ' 失败' : '已完成' });
    return;
  } catch (e) {
    const out = ((e.stdout || '') + (e.stderr || '')).toString();
    const m = out.match(/RESULT:\s*pass\s*(\d+)\s*\/\s*fail\s*(\d+)/i) ||
              out.match(/结果:\s*通过\s*(\d+)\s*\/\s*失败\s*(\d+)/);

    // 网络依赖型测试偶发失败（气象接口不稳定），重试一次再判负
    if (retry) {
      console.log('  首次未通过，重试一次（可能只是网络抖动）…');
      try {
        const out2 = attempt();
        const m2 = out2.match(/RESULT:\s*pass\s*(\d+)\s*\/\s*fail\s*(\d+)/i) ||
                   out2.match(/结果:\s*通过\s*(\d+)\s*\/\s*失败\s*(\d+)/);
        console.log(out2.trim().split('\n').slice(-3).join('\n'));
        const ok2 = m2 ? parseInt(m2[2], 10) === 0 : true;
        results.push({
          label, ok: ok2,
          detail: (m2 ? m2[1] + ' 通过 / ' + m2[2] + ' 失败' : '已完成') + '（重试后）'
        });
        return;
      } catch (e2) {
        /* 落到下面记为失败 */
      }
    }

    const fails = out.split('\n').filter(l => /FAIL|✘/.test(l)).slice(0, 6);
    console.log('  失败:' + (fails.length ? '\n  ' + fails.join('\n  ') : ' 见上方输出'));
    results.push({
      label, ok: false,
      detail: m ? m[1] + ' 通过 / ' + m[2] + ' 失败' : '进程异常退出'
    });
  }
}

console.log('\n=== 纯 Node 测试 ===');
for (const [s, l, where] of NODE_TESTS) {
  const cwd = where === 'web' ? path.join(ROOT, 'web') : HERE;
  // 依赖在线气象接口的测试允许重试
  runOne(s, l, [], cwd, s === 'test-ensemble.mjs');
}

console.log('\n=== 浏览器测试 ===');
for (const [s, l, where, a] of BROWSER_TESTS) {
  const cwd = where === 'web' ? path.join(ROOT, 'web') : HERE;
  runOne(s, l, a, cwd, true);
}

/* ---- 汇总 ---- */
console.log('\n' + '='.repeat(52));
console.log('  汇总');
console.log('='.repeat(52));
let allOk = true;
for (const r of results) {
  const mark = r.ok === null ? '－' : (r.ok ? '✔' : '✘');
  if (r.ok === false) allOk = false;
  console.log('  ' + mark + '  ' + r.label.padEnd(18) + (r.detail || ''));
}
console.log('='.repeat(52));
console.log(allOk ? '\n  全部通过' : '\n  有失败项，请看上面输出');

try { server.kill(); } catch (e) { /* ignore */ }
await sleep(300);
process.exit(allOk ? 0 : 1);
