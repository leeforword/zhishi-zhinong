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
         deepseekKey: '',
         enableLLM: false
       });

     页面会在 config.js 之后加载它。公网构建（scripts/build-site.mjs）
     会自动跳过这个文件，所以线上永远是关掉的状态。

   一句话：AI 只是把已算好的结论说得更口语，关掉它，
   所有天气判断、打药窗口、置信度、反事实推演的数字完全不变。
   ============================================================= */
window.TIANZHI_CONFIG = {

  /* ---------- AI 中转地址（推荐） ----------
     把这个填成你部署好的 Cloudflare Worker 地址，例如：
       llmProxyUrl: 'https://zhishi-ai.你的账号.workers.dev',

     ★ 为什么不是填 key：仓库是公开的，前端写 key 等于公开送人。
       把 key 放在 Worker 里（服务端），前端只知道中转地址，
       就算源码里有这一行也偷不到东西。部署见 worker/README.md

     留空 = 默认关闭 AI，退回纯规则引擎（结论和数字完全不变）。 */
  llmProxyUrl: '',

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

  /* Web 服务 key（可选，强烈建议配）
     ------------------------------------------------------------
     JS API 的逆地理编码要走安全密钥，一旦 key 与 securityJsCode 不配对，
     就会返回 INVALID_USER_SCODE，只能退到乡镇级。
     Web 服务 key 走 restapi，不需要安全密钥，最稳，能到村/POI。

     申请：console.amap.com → 应用管理 → 我的应用 → 添加 Key
           服务平台选「Web服务」，不要设 IP 白名单（浏览器端调用）
     填进来之后，逆地理会优先走它，不再依赖 JS 的安全密钥。 */
  amapWebKey: '',

  /* ---------- 和风天气 ----------
     ⚠️ 新版和风必须使用「账号专属 API Host」（控制台 → 项目详情页顶部）。
        填错会返回 Invalid Host。

     双源分工，各取所长：
       · 和风天气     → 主预报：7 天 168 小时逐时 + 7 天逐日，
                        附带分钟级降水（未来 2 小时）与灾害预警
       · Open-Meteo   → 集合预报（置信度）与多模式分歧；
                        和风不可用时整体兜底

     任一数据源不可用都不影响页面，只是对应功能自动隐藏。 */
  qweatherKey: '50b832fd5ab94314b13640cab4cb9d05',
  qweatherHost: 'kj3dnbj73b.re.qweatherapi.com',

  /* 关掉可只留 Open-Meteo（演示降级路径用） */
  enableQWeather: true,

  /* ---------- 主预报源 ----------
     'qweather'   和风天气做主预报（默认）：168 小时逐时，同化国内站网，
                  县域尺度的温度和风更贴本地，还带逐时降水概率 pop
     'open-meteo' 改回 Open-Meteo 做主预报（9–11km 全球模式插值）

     两种模式下，集合预报（置信度）和多模式分歧仍然取自 Open-Meteo，
     因为和风的免费额度给不了这两样。 */
  preferSource: 'qweather',

  /* ---------- Open-Meteo 中转（可选，解决国内直连超时） ----------
     集合预报（置信度）和多模式分歧只有 Open-Meteo 有，但
     api.open-meteo.com / ensemble-api.open-meteo.com 在国内多数网络
     （校园网尤其明显）是 TCP 超时——直连拿不到，界面会退化成
     「主预报余量评估」，看起来就是没有置信度。

     解决办法：部署 worker/ai-proxy.js（免费，约 10 分钟），
     然后把地址填在这里，例如：
       openMeteoProxy: 'https://zhishi-ai.你的账号.workers.dev',

     留空 = 直连。和风天气的主预报不受这个开关影响。 */
  openMeteoProxy: '',

  /* ---------- 功能开关 ---------- */
  enableLLM: false,            // 公网版无 key，默认关闭；本地可在 config.local.js 打开

  timeoutMs: 9000
};
