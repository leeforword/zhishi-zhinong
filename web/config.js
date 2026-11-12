/* =============================================================
   知时智农 · 配置
   -------------------------------------------------------------
   这个文件会被提交到公开仓库，所以规则很简单：

     ✔ 可以放在这里  —— 有域名白名单、泄露了也能补救的 key
     ✘ 不能放在这里  —— 按量计费、泄露了直接扣钱的 key

   具体到三把 key：

     amapKey（高德）     公开。但请务必去 console.amap.com
                         绑定你的托管域名（设置 → 域名白名单），
                         绑定后别的网站用不了这把 key。
     qweatherKey（和风） 公开。免费额度，被刷爆只是当天凑不满数据，
                         控制台随时可以换一把。
     deepseekKey（大模型）★ 不放在这里 ★
                         按量计费，谁拿到谁花钱。已清空。

   想在本地开 AI 润色怎么办：
     新建 web/config.local.js（该文件已被 .gitignore 忽略，不会上传），写：

       Object.assign(window.TIANZHI_CONFIG, {
         deepseekKey: '你的 key',
         enableLLM: true
       });

     页面会在 config.js 之后加载它。公网构建（scripts/build-site.mjs）
     会自动跳过这个文件，所以线上永远是关掉的状态。

   一句话：AI 只是把已算好的结论说得更口语，关掉它，
   所有天气判断、打药窗口、置信度、反事实推演的数字完全不变。
   ============================================================= */
window.TIANZHI_CONFIG = {

  /* ---------- 大模型（意图识别 / 话术润色 / 兜底）----------
     公网版留空：留空时 llm.js 自动降级，不报错。
     本地要用请写在 config.local.js 里，见文件头说明。 */
  deepseekKey: '',
  deepseekModel: 'deepseek-chat',
  deepseekEndpoint: 'https://api.deepseek.com/chat/completions',

  /* ---------- 高德地图 JS API ----------
     注意：这是「Web端」类型的 key，只能用于 JS API，不能调用 REST 接口 */
  amapKey: '948cc31be84ca8439eef646a5a2a5281',
  amapSecurityJsCode: '6b429de056e2bcafb5c8a8ae12ffc33',
  amapVersion: '2.0',

  /* ---------- 和风天气 ----------
     ⚠️ 新版和风必须使用「账号专属 API Host」（控制台 → 项目详情页顶部）。
        填错会返回 Invalid Host。

     双源分工，各取所长：
       · Open-Meteo   → 7 天逐时/逐日主预报（网格 9–11km，任意经纬度可用）
       · 和风天气     → 分钟级降水（未来 2 小时，每 5 分钟）+ 灾害预警

     任一数据源不可用都不影响页面，只是对应功能自动隐藏。 */
  qweatherKey: '50b832fd5ab94314b13640cab4cb9d05',
  qweatherHost: 'kj3dnbj73b.re.qweatherapi.com',

  /* 关掉可只留 Open-Meteo（演示降级路径用） */
  enableQWeather: true,

  /* ---------- 功能开关 ---------- */
  enableLLM: false,            // 公网版无 key，默认关闭；本地可在 config.local.js 打开

  timeoutMs: 9000
};
