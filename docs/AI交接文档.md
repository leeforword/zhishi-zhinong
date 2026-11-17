# 知时智农 · AI 交接文档

> 面向：下一个接手这个项目的 AI / 开发者。
> 基线：`main` 分支 `ec0a269`，2026-11-16 实测。
> 原则：本文只写代码里能验证的事实；不能确认的一律标 **未知/需确认**，不做推测性补全。

---

## 0. 30 秒版

- 这是什么：一个**纯静态前端**的农事决策智能体。把 7 天天气预报翻译成「哪天几点能打药 / 要不要浇水 / 能不能晾晒」，结论由本地规则引擎算出，大模型只负责把话说顺。
- 代码在哪：`D:\zhishi-zhinong`，源码在 `web/`，发布产物在 `site/`，远端 `github.com/leeforword/zhishi-zhinong`（公开仓库）。
- 怎么跑：`node web/server.mjs 8931` → `http://127.0.0.1:8931/`。零依赖，不需要 `npm install`。
- 怎么发：`node scripts/build-site.mjs` → `git push origin main` → GitHub Actions 自动发布 Pages。
- 先自检：`node scripts/doctor.mjs`（只读，实测 通过 59 / 警告 2 / 失败 0）。
- 阈值从哪来：`web/standards.js` 收录 13 份河北省 / 国家公开文件，按地块所属市自动取严；用户不用自己调风速。
- 最大坑：**新增一个 JS 文件要同时改三处**（`index.html` 的 script、`sw.js` 的 SHELL、`scripts/build-site.mjs` 的 JS_FILES），漏一处线上就白屏或断网白屏。`doctor.mjs` 会抓这个。

---

## 1. 项目目标

### 1.1 赛事背景（来自 `docs/大赛通知.txt`）

- 河北农业大学首届大学生人工智能素养大赛，主题「智绘青春·AI 赋能未来」。
- 本项目报名 **A 赛道（2026 级本科生）第 3 个方向「AI 智构」交互智能体创意**。
- 通知里的硬性时间：作品提交 **11 月 16 日—11 月 22 日**（学院统一提交，逾期不受理），初评 11/23—11/29，复评 12/4—12/10。
- A 赛道智能体方向要求提交：运行说明、**演示录屏 ≤3 分钟**、**关键界面截图 3—5 张**；作品须原创并如实标注 AI 使用情况。

### 1.2 产品目标

服务对象：华北平原种冬小麦 / 夏玉米的种植户，以及下地实习、返乡实践的学生。

要解决的问题：预报只说「多云、3 级风」，但站在地头要决定的是「今天几点风最小、雨前够不够打完一遍药」。本项目输出的是**带依据的时间窗口**，不是天气播报。

三个核心判断：

| 任务 | 判据（默认阈值） |
|---|---|
| 打药 | 作业时段 9:00–16:00 内逐小时风速 ≤3.4 m/s（石家庄 3.0）、气温 5–30℃、当日降水 ≤0.5 mm、前一日 <1.0 mm，连续满足 ≥2 小时才成一个窗口；阈值按属地文件自动取严 |
| 灌溉 | 当日降水 ≥5 mm 或降雨概率 ≥70% 不建议；未来 7 天累计 ≥15 mm 视为墒情尚可 |
| 晾晒 | 当日降水 ≤1 mm、降雨概率 ≤50%、气温 ≥5℃ |

### 1.3 明确的非目标（写进了产品文案，别当成缺陷）

- 不答病虫害识别、药名配比、测土施肥、产量价格、真实苗情 —— 问到会明确拒答。
- 不接入真实遥感 NDVI，长势模块只是「方法占位」，不输出苗情结论。
- 不编造用户反馈、准确率、增产数据。

---

## 2. 现状快照（2026-11-17 实测）

| 项 | 值 | 验证方式 |
|---|---|---|
| 线上地址 | `https://leeforword.github.io/zhishi-zhinong/` | HTTP 200（v5.0 待推送生效） |
| 域名根 | `https://leeforword.github.io/` | HTTP 200（跳转页 + 微信验证文件） |
| 最近提交 | v5.0 决策页重构（本次提交） | `git log -1` |
| 规则引擎测试 | 通过 271 / 失败 0（含露点/湿度/日落回归） | `node web/test-logic.mjs` |
| 标准库 / 本地库测试 | 通过 164 / 失败 0（离线） | `node web/test-standards.mjs` |
| 端到端测试 | 通过 117 / 失败 0 | `node web/e2e.mjs`（需先起本地服务器） |
| 构建 | 产物自检全过 | `node scripts/build-site.mjs` |
| 页面版本号 | v5.1（「我的 → 关于」） | `web/index.html` |
| 插画素材 | `web/img/` 17 张 webp（约 1.5MB）；PNG 原稿在 `web/img-src/`（不进仓库） | `ls web/img` |
| 规则引擎版本 | 3.1（`RULES.meta.version`） | `web/logic.js` |
| 安卓壳 | versionCode 3 / versionName 1.2，包名 `io.github.leeforword.twa` | `android-webview/AndroidManifest.xml` |
| 本地 Node | v22.22.2；CI 用 Node 20 | `node -v`、`deploy.yml` |

端到端已全绿：高德 SDK 在本地不可用时自动降级为行政区划示意图，测试同时覆盖高德与降级两种地图态，详见 §11.1。

---

## 3. 目录结构（实际存在，非设想）

```
D:\zhishi-zhinong\
├── web\                         开发目录，唯一改代码的地方
│   ├── index.html               2362 行 / 120 KB：全部页面结构 + 全部 CSS
│   ├── app.js                   3526 行 / 155 KB：状态、渲染、图表、地图、问答交互
│   ├── logic.js                 942 行：规则引擎 + 问答模板 + 坐标转换
│   ├── weather.js               539 行：和风 / Open-Meteo 适配与兜底
│   ├── place.js                 498 行：坐标 → 地名（多源）
│   ├── ensemble.js              490 行：集合预报 / 多模型分歧
│   ├── content.js               182 行：界面文案与口径（v4.5 精简到 12 KB；13 节作品说明已移出）
│   ├── kb.js                    本地知识库索引：13 标准 + 24 节气 + 6 口径 + 167 县 = 210 条（离线）
│   ├── standards.js             608 行：河北省 / 国家作业标准库，按属地取严（v4.4 新增）
│   ├── pwa.js                   482 行：安装引导、SW 更新、断网提示
│   ├── llm.js                   282 行：大模型意图 / 润色 / 数字校验
│   ├── settings.js              162 行：本地设置（阈值、AI 配置）
│   ├── sw.js                    172 行：Service Worker
│   ├── config.js                113 行：公开配置（会进公开仓库）
│   ├── config.local.js          16 行：私有配置，已被 gitignore，**不进产物**
│   ├── hebei-geo.js             159 KB / 2 行（压缩）：河北 167 个县级边界，离线
│   ├── server.mjs               216 行：零依赖本地静态服务器（含 /qr 扫码页）
│   ├── qr.mjs                   486 行：手写二维码编码/渲染，只被 server.mjs 用
│   ├── test-logic.mjs           158 行：规则引擎测试（纯 Node）
│   ├── test-standards.mjs       127 行：标准库完整性 / 合并方向 / 问答文本（离线）
│   ├── e2e.mjs                  494 行：Chrome Headless + CDP 端到端（零依赖）
│   ├── manifest.webmanifest     PWA 清单
│   ├── icons\                   192 / 512 / maskable / apple-touch / svg
│   ├── download\                zhishi-zhinong.apk（45 KB，WebView 壳）、zhishi-zhinong-twa.apk（1.2 MB，已弃用备份）
│   ├── .well-known\assetlinks.json   TWA 数字资产校验（WebView 壳不依赖）
│   └── a48619f8….txt            微信「申请恢复访问」的域名验证文件（40 B）
├── site\                        发布产物，**已提交**，由 build-site.mjs 生成，不要手改
├── scripts\
│   ├── build-site.mjs           ★ 唯一发布链路：web/ → site/ + 自检
│   ├── doctor.mjs               ★ 交接自检（只读）
│   ├── make-icons.mjs           生成 PNG 图标（手写 PNG 编码，零依赖）
│   ├── build-single.mjs         打成单文件 HTML（旧交付方式）
│   ├── build-public.mjs         生成「公网版」目录
│   ├── package.mjs              生成 dist/ 交付包（调用上面两个）
│   ├── build-geo.mjs            生成 hebei-geo.js
│   └── test-*.mjs / audit-*.mjs 开发期验证脚本，**未逐一复测，可能已与当前 UI 脱节**
├── worker\
│   ├── ai-proxy.js              Cloudflare Worker：大模型中转 + Open-Meteo 中转
│   └── README.md                部署步骤（环境变量 DEEPSEEK_KEY / ALLOWED_ORIGINS）
├── android-webview\             自建系统 WebView 壳（不是 TWA）
│   ├── AndroidManifest.xml      minSdk 23 / target 34
│   ├── src\...\MainActivity.java 站点地址、返回键、定位授权、断网页
│   ├── build.sh                 aapt2 → javac → d8 → zipalign → apksigner
│   └── build\                   构建产物（已 gitignore）
├── docs\                        运行说明 / 部署安装 / AI 使用声明 / 演示脚本 / 大赛通知
│   └── 作品说明（参赛材料）.md   13 节正文（v4.5 从 App 移出，改这里再转 PDF）
├── screenshots\                 e2e 与人工截图（build 会取其中 2 张进 site）
├── dist\                        11-13 的旧交付物，已 gitignore；含乱码目录名，可删
├── _archive\                    早期版本备份，不参与构建
├── .build\                      便携 JDK + 调试输出，已 gitignore
├── .github\workflows\deploy.yml Pages 自动部署
├── index.html                   仓库根跳转页（转到 site/），分支部署兜底
├── start.bat                    Windows 一键启动（自动开 --lan + 打开 /qr）
├── README.md                    面向使用者的说明（**部分滞后**，见 §11.4）
└── 使用说明.txt                 早期纯文本说明
```

忽略规则要点（`.gitignore`）：`web/config.local.js`、`/dist/`、`.build/`、`android-webview/build/`、`.workbuddy/`、`*.zip`、`*.lnk`。**`site/` 不在忽略列表里，它是发布源，必须提交。**

---

## 4. 技术栈与依赖

### 4.1 运行时

- 原生 HTML / CSS / JavaScript（ES5 风格 IIFE，无框架、无打包器、无 TypeScript）。
- 单一 SPA，三个视图靠 `class="view on"` 切换，不刷新页面。
- 图表全部**手写 SVG**（`windChartSvg / heatChartSvg / tempChartSvg / donutSvg / growthSvg`），无图表库。
- PWA：`manifest.webmanifest` + `sw.js`（应用外壳缓存）。
- 视觉：CSS 变量 + 媒体查询 + `backdrop-filter` 玻璃拟态；无 UI 框架。

### 4.2 开发期依赖

| 依赖 | 用途 | 是否必需 |
|---|---|---|
| Node.js ≥18 | 本地服务器、构建、测试（用到内置 `fetch`） | 构建/测试必需 |
| Chrome 或 Edge | `web/e2e.mjs` 通过 CDP 驱动 | 只有 e2e 需要 |
| Android SDK build-tools 34 + platform android-34 | 打 APK | 只有重打 APK 需要 |
| JDK | `android-webview/build.sh` | 只有重打 APK 需要；脚本会找 `.build/jdk-*` |
| Python + Pillow | 之前处理截图用 | **构建不需要** |

**没有 `package.json`，没有 `node_modules`。** 不要执行 `npm install`，也不要引入依赖——这个项目的卖点之一就是零依赖、可离线复现。

### 4.3 外部服务（运行期，见 §9）

和风天气、Open-Meteo、高德（JS API + Web 服务）、BigDataCloud、DataV GeoAtlas（已离线内置）、DeepSeek（默认关闭）。

---

## 5. 安装 / 运行 / 测试 / 构建 / 部署

### 5.1 本地运行

```bash
cd /d/zhishi-zhinong
node web/server.mjs 8931            # 只允许本机
node web/server.mjs 8931 --lan      # 允许同一 WiFi 的手机访问，并打印二维码
```

打开 `http://127.0.0.1:8931/`；手机扫码页 `http://127.0.0.1:8931/qr`。
Windows 双击 `start.bat` 等价于 `--lan`（端口占用会自动改 8932）。

直接双击 `web/index.html`（`file://`）也能用，但**定位不可用**（浏览器安全限制），且 SW 不注册。

### 5.2 测试

```bash
node scripts/doctor.mjs              # 只读自检，先跑这个
node web/test-standards.mjs          # 标准库：条目完整、取严方向、问答文本（离线，最快）
node web/test-logic.mjs              # 规则引擎，需联网取实时天气
node web/test-logic.mjs --source=open-meteo   # 强制走 Open-Meteo
```

```bash
# 端到端：必须先起服务器（另一个终端），且本机有 Chrome/Edge
node web/server.mjs 8931
node web/e2e.mjs                     # 默认 http://127.0.0.1:8931/，截图输出到 ../screenshots
node web/e2e.mjs https://leeforword.github.io/zhishi-zhinong/ ../screenshots   # 测线上
```

预期：`test-standards` 输出 `通过 164 / 失败 0`；`test-logic` 输出 `通过 271 / 失败 0`（数字随实时数据条数浮动，失败必须为 0）；`e2e` 输出 `pass 117 / fail 0`。e2e 末尾会用 CDP 拦掉天气域名，验证断网错误态仍保留决策骨架与「重新获取」入口。

### 5.3 构建

```bash
node scripts/build-site.mjs
```

做的事：清空 `site/` → 复制运行时文件 → 删掉 `index.html` 里的 `config.local.js` 引用 → 对 `config.js` 二次脱敏（清空 `deepseekKey`、`enableLLM` 置 false）→ 给 `sw.js` 写构建号 → 复制 manifest / 图标 / `.well-known` / APK / 微信验证文件 / 2 张截图 → 写 `.nojekyll` → 自检（泄漏 key、manifest、本地引用、SW 清单、验证文件、体积）。任一自检失败会 `exit 1`。

**注意**：每次构建都会改 `site/sw.js` 的构建号，因此构建后 `git status` 必然有 `M site/sw.js`。这是预期行为，不是脏改动。

### 5.4 部署

```bash
git add -A
git commit -m "…"
git push origin main
```

`.github/workflows/deploy.yml` 会：`checkout` → Node 20 → `node web/test-standards.mjs` → `node web/test-logic.mjs`（任一不过就不发）→ `node scripts/build-site.mjs` → 上传 `site/` → 部署 Pages。也可以在 Actions 页面手动 `workflow_dispatch`。

推送踩过的坑（本机网络）：

```bash
git -c http.sslVerify=false push origin main
# 仍失败时清代理再试
https_proxy= http_proxy= HTTPS_PROXY= HTTP_PROXY= git -c http.sslVerify=false push origin main
```

不要在仓库里持久化 `http.sslVerify=false`。

### 5.5 重打安卓壳（非日常）

```bash
bash android-webview/build.sh
# 产物：android-webview/build/zhishi-zhinong-webview.apk
# 发布：覆盖 web/download/zhishi-zhinong.apk，再跑 build-site
```

前置：Android SDK（build-tools 34.0.0 + `platforms/android-34/android.jar`）、JDK（脚本找 `.build/jdk-*`，可用便携版）。签名用的是**仓库外的** keystore：`C:\Users\axiom\Desktop\知时智农 - Google Play package\signing.keystore`，密码从同目录 `signing-key-info.txt` 读。**这个目录丢了就无法用同一签名覆盖安装**，属于高风险资产。

壳的站点地址在 `MainActivity.java` 顶部：`START = "https://leeforword.github.io/zhishi-zhinong/"`，`HOST = "leeforword.github.io"`（站内链接留在壳内，站外交给系统浏览器）。

---

## 6. 核心模块职责

| 文件 | 对外接口 | 职责 | 依赖 |
|---|---|---|---|
| `config.js` | `window.TIANZHI_CONFIG` | 公开配置：数据源 key、主源选择、超时 | 无 |
| `settings.js` | `window.TianZhiSettings` | 阈值与 AI 配置的读写（localStorage），`applyRules()` 把阈值灌进规则引擎 | `logic.js`（间接） |
| `logic.js` | `window.TianZhi` = `{RULES, evaluateWeather, bestWindow, answerByIntent, answerQuestion, ruleIntent, hoursOf, hourVerdict, growthTrend, feasibility, wgs84ToGcj, gcjToWgs84, compareModels, …}` | 规则引擎、问答模板、坐标转换、城市字典 | 无 |
| `weather.js` | `window.TianZhiWeather` = `{getWeather, hasQWeather, getSource, getStats, _fromQWeather168, _fromOpenMeteo, …}` | 多源天气适配 + 兜底 + 统计 | `config.js` |
| `ensemble.js` | `window.TianZhiEnsemble` = `{parseMembers, hourlyProbability, extractWindows, evaluateDay, levelOf, riskOnDay, delayCost, assemble, assembleBest, …}` | 集合成员解析、置信度、多模型分歧 | 无 |
| `place.js` | `window.TianZhiPlace` = `{resolve, around, searchPoi, cached, precisionText, _pickPlace, _placeKindOf, …}` | 坐标→地名（高德 REST + BigDataCloud + 本地县界），带内存缓存 | `config.js` |
| `llm.js` | `window.TianZhiLLM` = `{isEnabled, classify, refine, refuse, numbersConsistent, …}` | 意图分类、口语化改写、数字一致性校验、超范围拒答 | `settings.js` |
| `content.js` | `window.TianZhiContent` = `{meta, scope, rules, terms, chat, termNote, esc}` | 界面文案：边界、6 条口径、24 节气、问答预设。**13 节作品说明已移出到 `docs/作品说明（参赛材料）.md`** | 无 |
| `kb.js` | `window.TianZhiKB` = `{build, stats, search}` | 本地知识库索引：标准 / 节气 / 口径 / 县级行政区；对话与「依据」弹层共用 | `standards.js`、`content.js`、`hebei-geo.js` |
| `app.js` | 无全局导出（IIFE） | 状态、渲染、图表、地图、模块弹窗、问答交互、视图切换 | 上面全部 |
| `pwa.js` | 无全局导出（IIFE） | 安装引导（安卓/iOS/微信分支）、SW 注册与更新、断网提示 | `sw.js` |
| `sw.js` | Service Worker | 外壳预缓存、导航请求网络优先、静态资源网络优先、**跨域接口完全不碰** | — |
| `server.mjs` | CLI | 本地静态服务 + `/qr` 扫码页 + 目录穿越防护 | `qr.mjs` |
| `e2e.mjs` | CLI | CDP 驱动 Chrome，117 项断言 + 截图（含断网错误态、地图降级态） | Chrome/Edge |
| `test-logic.mjs` | CLI | 用真实天气跑规则引擎与问答分支 | 网络 |
| `standards.js` | `window.TianZhiStandards` = `{LIST, CITIES, effective, forCity, coverage, answer, limitsHtml, sourcesHtml, quotesHtml, …}` | 河北省 / 国家作业标准库：条目、属地合并（取严）、界面与问答文本 | 无 |
| `test-standards.mjs` | CLI | 标准库完整性、取严方向、问答无 undefined（离线） | 无 |

`app.js` 内部关键函数（改 UI 时按名字搜）：

- 数据：`load()`、`fetchWeather()`、`state`、`save()`、`loadStore()`、`activePlot()`
- 渲染（v5.0 决策页）：`sprayDecision()` / `irrDecision()` / `harvDecision()` → `renderDecision()`（L1 决策卡）、`renderWeek()` + `renderDayDetail()`（L2 七天条带）、`bindDecision()`（tab / 作业留痕 / 依据入口）、`renderCharts()` + `renderNowStrip()` + `renderProTable()`（L3 证据层）、`renderAlerts()`、`renderSolarTerm()`、`renderContentLayer()`、`renderError()`
- 图表：`chartW()`、`windChartSvg()`、`heatChartSvg()`、`tempChartSvg()`、`donutSvg()`、`growthSvg()`
- 地图：`loadAMap()`、`initAMap()`、`onMapPick()`、`drawMarker()`、`mapCenterOn()`、`flyToPoint()`、`renderFallbackMap()`
- 地名：`placeLabel()`、`resolveFinePlace()`、`kickFinePlace()`、`locateCounty()`
- 弹窗：`openModal()`、`closeModal()`、`formSearch()`、`formGeo()`、`formSave()`、`refreshNearby()`、`selectNearby()`
- 问答：`ask()`、`respondWith()`、`preAnswer()`、`appendMsg()`、`bindAnswerNotes()`、`openCorrectionForm()`
- 视图：`setView()`、`moveTabPill()`、`bindViews()`、`bindDrawer()`、`lockBody()`
- 阈值：`fillRuleInputs()`、`bindRuleSliders()`、`saveRules()`

---

## 7. 关键配置与环境变量

### 7.1 `web/config.js` 字段

| 字段 | 当前值/状态 | 说明 |
|---|---|---|
| `llmProxyUrl` | `''` | Cloudflare Worker 中转地址；留空则 AI 走直连或关闭 |
| `deepseekKey` | `''` | **公网必须为空**；构建时还会再兜底清一次 |
| `deepseekModel` | `'deepseek-chat'` | |
| `deepseekEndpoint` | `'https://api.deepseek.com/chat/completions'` | |
| `amapKey` | 已配置 | 高德 **Web 端（JS API）** key，需在控制台配域名白名单 |
| `amapSecurityJsCode` | 已配置 | JS API 2.0 安全密钥，与 `amapKey` 必须配对 |
| `amapVersion` | `'2.0'` | |
| `amapWebKey` | 已配置 | 高德 **Web 服务** key，走 `restapi`，逆地理/POI 优先用它 |
| `qweatherKey` | 已配置 | 和风 key，免费额度 |
| `qweatherHost` | 已配置 | **账号专属 API Host**，填错会返回 `Invalid Host` |
| `enableQWeather` | `true` | 关掉可只留 Open-Meteo（降级演示用） |
| `preferSource` | `'qweather'` | `'qweather'` / `'open-meteo'` |
| `openMeteoProxy` | `''` | Worker 的 `/om/` 中转，解决国内直连超时 |
| `enableLLM` | `false` | 公网默认关闭 |
| `timeoutMs` | `9000` | |

### 7.2 私有多少、怎么隔离

- `web/config.local.js`：`Object.assign(window.TIANZHI_CONFIG, { deepseekKey: '…', enableLLM: true })`。已被 `.gitignore` 忽略。
- 三重隔离：① gitignore；② 构建删掉 `index.html` 对它的引用；③ 构建再次清空 `config.js` 的 `deepseekKey`、把 `enableLLM` 置 false；④ 构建自检扫描产物里任何 `sk-` 形式的 key，命中就失败。

### 7.3 Worker 环境变量（`worker/ai-proxy.js`）

| 变量 | 类型 | 作用 |
|---|---|---|
| `DEEPSEEK_KEY` | Secret | 服务端持有的大模型 key，绝不要写成明文变量 |
| `ALLOWED_ORIGINS` | Text | 允许的来源，逗号分隔（如 `https://leeforword.github.io,http://localhost:8931`）。**不填等于开放代理** |

路由：`GET /om/<host>/<path>` 转 Open-Meteo；`POST` 任意路径转发大模型；其余返回说明/405。CORS 预检已处理。

当前 `llmProxyUrl` 与 `openMeteoProxy` 都是空 —— **Worker 是否已部署：未知/需确认**（代码层面当前未使用）。

### 7.4 localStorage 键（只在本机，不上传）

| 键 | 内容 | 写入方 |
|---|---|---|
| `tianzhi.plots.v3` | 地块数组 + `activeId` | `app.js save()` |
| `tianzhi.spray.v1` | 上次打药日期（倒计时用） | `app.js setSprayRecord()` |
| `zhishi.settings.v1` | `{ai:{mode,proxyUrl,key,endpoint,model}, rules:{…}}` | `settings.js` |
| `zz.pwa.installDismissed` | 安装条的「不再提示」 | `pwa.js` |
| `tianzhi.corrections.v1` | 用户纠错记录（最多 50 条） | `app.js openCorrectionForm()` |

### 7.5 阈值现在由标准库决定（v4.4 起）

- 默认 `standard.mode = 'auto'`：`settings.applyRules(city)` 调 `standards.effective(city)`，把合并后的 patch 写进 `RULES`，同时把出处写进 `RULES.meta.source`。
- `logic.js` 与 `settings.js` 的默认值已统一为 `3.4 m/s · 5–30℃ · 9–16 时`，只作为「标准库缺失」时的兜底。
- 手动模式（`standard.mode='manual'`）才使用 `settings.rules`；保存滑轴会自动切到 manual，避免被下次自动重算覆盖。
- 换地块时 `load()` 会比较 `plot.city` 与 `standard.city`，不同则重套标准——石家庄（3.0 m/s）与邯郸（3.4 m/s）在同一页面里会给出不同窗口。

**但这仍是两处状态**：标准库给的是 `patch`，用户覆盖存的是 `rules`。排查「数字和界面不一致」时，先看 `settings.get('standard').mode`。

---

## 8. 主要调用链与数据流

### 8.1 启动链

```
index.html
  → config.js → [config.local.js（仅本地）] → settings.js → llm.js → weather.js
  → hebei-geo.js → place.js → logic.js → content.js → ensemble.js → app.js → pwa.js
app.js IIFE 末尾依次执行：
  bindNearby → bindDrawer → renderSolarTerm → renderContentLayer → bindAnswerNotes
  → moveTabPill → buildPresets（清理旧 DOM）→ bindViews
  → bindMine → bindMapStage（预加载高德 SDK）→ S.applyRules() → renderAiToggle
  → appendMsg(欢迎语) → renderPlots → syncAdv(true)（桌面展开证据层）→ load()
load() 成功后：renderDecision → renderWeek → renderCharts → renderAlerts
             → renderNowStrip → bindDecision → renderSolarTerm
失败走 renderError()：决策骨架保留，顶部给重试按钮
pwa.js boot()：
  注册 SW（scope './'）→ 监听 beforeinstallprompt / appinstalled / offline / online
  → 安装条与「立即更新」
```

### 8.2 天气 → 结论链（核心）

```
load()
  → fetchWeather(plot.lat, plot.lon)            app.js:160
      → TianZhiWeather.getWeather()             weather.js:463
          和风（preferSource=qweather）:
            /v7/weather/168h  +  /v7/weather/7d
            失败 → /v7/weather/24h + /7d（降级）
          并行增强（任一失败返回 null，不阻塞）:
            /v7/minutely/5m            分钟级降水
            /weatheralert/v1/current/{lon}/{lat}  灾害预警
            ensemble-api.open-meteo.com/v1/ensemble   集合成员
            api.open-meteo.com/v1/forecast            多模型
          Open-Meteo 作主源时：api.open-meteo.com/v1/forecast
  → state.raw = w
  → TianZhi.evaluateWeather(w.hourly, w.daily) → result{days[7], weekRain, …}
  → renderDecision（先答今天/现在，不行才给下一次窗口）
  → renderWeek（七天条带，默认选中日与决策卡一致）
  → renderCharts / renderAlerts / renderNowStrip
```

`result.days[i]` 每项含 `date / dow / tmax / tmin / rain / spray{status,why,windows,blocked} / irrigation / harvest`。
`todayRemaining()` 判「今天剩余时段还能不能干」，与逐日判定共用概率、露点、日落截止口径。
集合置信度由 `ensembleEval()` → `TianZhiEnsemble.assemble*()` 供问答使用，按 `lat,lon,首条时次` 缓存；v5 起不再单独渲染置信度卡与推迟代价面板。

### 8.3 问答链

```
ask(text)                                     app.js:2945
  → 无 result → 明确说「还没加载好」，不用旧数据
  → T.ruleIntent(q)                           规则命中 → respondWith(intent)
  → 未命中且 AI 开启 → LLM.classify(q) → respondWith(k)
  → respondWith(intent)                        app.js:2998
      intent === 'out'  → LLM.refuse(…) 或模板拒答
      answerByIntent(intent, result, plot)    数字全部来自规则引擎
      若 AI 开启 → LLM.refine(template, ctx)
          数字一致性校验失败 → 丢弃改写结果，回退模板
  → appendMsg('bot', text, withNote=true)
      回答下方固定挂：依据 / 边界 / 核实 三条 + 「查看判定口径」「记一条纠错」
```

`preAnswer(q)` 覆盖五类**直接回答**：追问「为什么这么判断」、可靠性、节气、纠错、上下文追问。

### 8.4 地块 / 地图 / 地名链

```
openModal()
  → initAMap()            JS API: webapi.amap.com/maps?v=2.0&key=…，securityJsCode 走 _AMapSecurityConfig
      失败 → renderFallbackMap()：本地县界 SVG + 点击换算，仍可用
  → onMapPick(gLng, gLat) 高德返回 GCJ-02
      → drawMarker() → placeLabel()
          placeLabel → TianZhiPlace.resolve(lon, lat)
              → restapi.amap.com/v3/geocode/regeo（amapWebKey）
              → api.bigdatacloud.net/data/reverse-geocode-client（兜底）
              → 本地 hebei-geo.js 点面判断（离线兜底）
          → applyFinePlace() 写地名/精度标签
      → flyToPoint()：mapCenterOn() + setZoomAndCenter(16–18)，620 ms 运镜
  → refreshNearby() → /v3/place/around → renderNearbyList() → selectNearby()
  → formSave() → save() → load() 重新取该点天气
```

坐标约定：存储与天气请求用 WGS-84；高德地图用 GCJ-02；转换函数 `T.wgs84ToGcj / T.gcjToWgs84`。

### 8.5 阈值链（标准自动套用）

```
启动 / 换地块
  → S.applyRules(city)
      → TianZhiStandards.effective(city)
          适用 = 全国 + 河北省 + 本市（排除已废止、非大田对象）
          合并 = 风速取最小、温度上限取最小、下限取最大、时段取交集
          每字段记录来源 id（by）
      → TianZhi.applyRuleOverrides(patch)   // 只接受白名单字段与合法范围
      → TianZhi.setRuleSource(label)        // 写进 RULES.meta.source
  → load() 取数并重算全部窗口

手动覆盖
  → 滑轴 → settings.save('rules') + save('standard',{mode:'manual'})
  → applyRules 走 manual 分支，用 settings.rules
  → 「恢复按标准」= reset('rules') + mode:'auto' + applyRules(city)
```

### 8.6 发布链

```
git push origin main
  → Actions: checkout → node 20 → test-logic（失败即止）
  → build-site（web/ → site/，含自检）
  → upload-pages-artifact(site) → deploy-pages
  → https://leeforword.github.io/zhishi-zhinong/
```

`site/` 同时被提交进仓库，作用是：分支部署兜底、断网/离线交付、可直接拷走托管。

---

## 9. 外部服务与数据依赖

| 服务 | 端点 | 认证 | 失败时表现 |
|---|---|---|---|
| 和风天气（主预报） | `https://{qweatherHost}/v7/weather/168h`、`/7d`、`/24h` | URL `key=` | 降级到 24h/7d，再失败整体退 Open-Meteo |
| 和风 分钟级降水 | `/v7/minutely/5m?location=lon,lat` | 同上 | 该模块隐藏 |
| 和风 灾害预警 | `/weatheralert/v1/current/{lon}/{lat}` | 同上 | 该模块隐藏（旧 `/v7/warning/now` 已废弃，勿用） |
| Open-Meteo 主预报 | `api.open-meteo.com/v1/forecast` | 无 | 若和风可用则不影响；两源都挂则报错页 |
| Open-Meteo 集合 | `ensemble-api.open-meteo.com/v1/ensemble` | 无 | 置信度退化为「按主预报余量估算」 |
| Open-Meteo 多模型 | `api.open-meteo.com/v1/forecast`（多 model 参数） | 无 | 分歧提示隐藏 |
| Open-Meteo 地理编码 | `geocoding-api.open-meteo.com/v1/search` | 无 | 只影响「搜索地点」 |
| 高德 JS API | `webapi.amap.com/maps?v=2.0` | `amapKey` + `amapSecurityJsCode` | 地图区域退化为本地县界示意，仍可选点 |
| 高德 Web 服务 | `restapi.amap.com/v3/geocode/regeo`、`/v3/place/around`、`/v3/place/text` | `amapWebKey` | 地名退到 BigDataCloud / 本地县界 |
| BigDataCloud | `api.bigdatacloud.net/data/reverse-geocode-client` | 无 | 地名退到本地县界 |
| 行政区划 | 无网络请求，`hebei-geo.js` 内置 | — | 永远可用 |
| DeepSeek | `api.deepseek.com/chat/completions` 或 Worker | key / 中转 | AI 关闭时全部走模板，结论与数字不变 |

关键设计：**Service Worker 绝不缓存跨域接口**（`sw.js` 里只处理同源 GET）。宁可显示「取不到」，也不拿昨天的天气当今天的结论。

---

## 10. 常见修改入口（按需求找文件）

| 想改什么 | 改哪里 | 注意 |
|---|---|---|
| 页面文案 / 判定口径 | `web/content.js` | 改完刷新即可；依据弹层只取前 4 条规则 |
| 参赛作品说明（13 节） | `docs/作品说明（参赛材料）.md` | 已从 App 移出，改这里再转 PDF/Word，别再往界面里塞 |
| 问答预设问题、欢迎语、依据提示 | `web/content.js` 的 `C.chat` | 预设改了会自动重渲染，事件委托在 `#qaChips` 上 |
| 阈值 / 作业标准 | `web/standards.js` 的 `LIST`（新增文件就加一条，必须带 code / url / checked） | 只收有原文或官方著录的；没全文的 `limits` 必须 `null`，不许猜数值 |
| 阈值兜底 | `web/settings.js` 的 `defaultRules()` + `web/logic.js` 的 `RULES` | 只在标准库缺失时生效；改标准优先改 standards.js |
| 打药/灌溉/晾晒判定逻辑 | `web/logic.js`：`hourVerdict()`、`findSprayWindows()`、`evaluateWeather()` | 改完必须跑 `test-logic.mjs`，有热力图一致性断言 |
| 首页布局 / 决策卡 | `web/index.html` 的 `.decision` / `.week` / `.adv` + `web/app.js` 的 `renderDecision()` / `renderWeek()` | 三层信息架构：L1 结论、L2 七天窗口、L3 默认收起的证据；改 DOM 后先跑 e2e，删过 `#windTitle` 那次整页报错 |
| 图表尺寸 / 截断 | `web/app.js` 的 `chartW()` 与各 `*Svg()` | 宽度必须按容器实测，别写死 560/620 |
| 地图行为 / 运镜 | `web/app.js` 的 `MAP` 段（`initAMap`/`onMapPick`/`renderFallbackMap`/`__tzPickCenter`） | 高德不可用会自动降级示意图，点选与搜索必须同时可用；e2e 两种态都测（§11.1） |
| 地名规则 | `web/place.js`：`pickPlace()`、`placeKindOf()`、`compose()` | 不要强制归到村；按 `type` 和距离判断 |
| 数据源 / 兜底顺序 | `web/weather.js` 的 `getWeather()` | 保持「任一源挂都不白屏」 |
| 离线缓存范围 | `web/sw.js` 的 `SHELL` + `scripts/build-site.mjs` 的 `JS_FILES` | **加文件必改三处**：`index.html`、`sw.js`、`build-site.mjs` |
| 构建 / 发布规则 | `scripts/build-site.mjs`、`.github/workflows/deploy.yml` | 自检失败会阻断发布，这是特性不是 bug |
| APK 加载地址 | `android-webview/.../MainActivity.java` 的 `START`/`HOST` | 改完要重打包并替换 `web/download/zhishi-zhinong.apk` |
| 赛事说明 / 运行文档 | `docs/`、`README.md` | 与页面内容可能不同步，以 `content.js` 为准 |

**加一个新 JS 文件的完整步骤**（漏一步就出问题）：

1. 写 `web/新文件.js`；
2. `web/index.html` 加 `<script src="新文件.js"></script>`（注意依赖顺序）；
3. `web/sw.js` 的 `SHELL` 加 `'./新文件.js'`；
4. `scripts/build-site.mjs` 的 `JS_FILES` 加 `'新文件.js'`；
5. `node scripts/doctor.mjs` 确认三处一致。

---

## 11. 已知问题与坑

### 11.0 v5.0 决策页重构（当前架构，改动前先读）

**定位**：面向华北平原冬小麦 / 夏玉米种植户，不是天气看板，而是「这件活今天能不能干、几点干」的一屏决策。判断成功的标准是农户不用滚动、不用换算就能做决定。

**三层信息架构**（`web/index.html` + `web/app.js`）：
- L1 `.decision`：结论按动作写（「现在就能打」/「今天不能打」/「这七天都不能打」），先答今天，不行才在原因里给下一次窗口；右侧大号时段、四项可核对指标、`dFrom` 说明条（**未来窗口数值不是今天的实况**）；作业 tab、作业留痕、「为什么是这个时间」入口都在这里。
- L2 `.week`：七天窗口条带，色块位置对应 6–18 时，点某天联动 `renderDayDetail()` 与所有图表；图例随任务切换（打药只有「可作业 / 无窗口」两态）。
- L3 `#basisPanel`：实况 11 项、24 小时逐时表、四张图、判定口径与标准出处，桌面默认展开、手机默认收起；`<details>` 的 `toggle` 事件会重画图表，否则手机展开时图按 0 宽度绘制。

**v5.0 修掉的坑（别再改回去）**：
- 旧 `renderError()` 第一行就写已删除的 `#heroIn`，断网时直接抛错、连「重新获取」都渲染不出来；现在只写 v5 DOM，e2e 第 14 节用 CDP 拦天气域名做真实回归。
- 顶栏 `#todayDate` 原本由旧天象头写入，v5 删掉后天象头后一直显示「—」；现由 `renderDecision()` 负责。
- `#weekRainNote` 原本由已删除的「今日判读」卡写入，七天标题右侧一直空白；现由 `renderWeek()` 负责。
- 高德降级时 `mapMode` 停在「地图加载中…」；现同步为「本地示意地图 · 可点选」，`__tzPickCenter` 在降级态也能取点。
- 清掉了 v4.x 遗留的天象插画、倒计时、置信度/推迟代价、假设分析、七日卡、四宫格等约 750 行从未被调用的死代码。**不要凭旧文档里的函数名去找代码**。

**v5.1 增补（插画层）**：17 张 19 世纪博物志风插画（AI 生成，提示词脚本见 `D:\minimax\v3-prompts.md`）已接入——
- 决策卡右下角水印 `#dArt`：`applyWeatherTheme()` 按 `wx-*` 类映射 `img/weather-*.webp`，`mix-blend-mode:multiply` 融底，加载失败隐藏。**特异性必须写 `.decision > .d-art`**，普通 `.d-art` 会被 `.decision > *` 的 relative 覆盖掉定位（踩过）。
- 物候横幅 `#seasonBanner`：`renderSeasonBanner()` 按月份映射（11–1 越冬 / 2–3 返青 / 4 拔节 / 5–6 成熟，7–10 隐藏）。
- 空态 `renderError()` 带 `empty-offline.webp`；地块行首有作物标本小图；og:image 用 `share-cover.webp`。
- `sw.js` SHELL 预缓存 8 张天气图；`build-site.mjs` §6.8 只复制 webp。换图重压：用 sharp（转换脚本写法见 git 历史或本节描述），PNG → webp q80，方图 512、横幅 1280。

### 11.0.1 v4.7 修掉的问题（别再改回去）

- **`groupByDay` 只搬了 4 个字段**：wind/temp/rain/humid。于是 `hourOk` 里读的 `h.prob`、`h.dew` 恒为 `undefined`——降雨概率拦截和结露判定写了却从未生效，`window.avgProb` 也永远是 null。v4.7 补齐 prob/dir/hum/dew/press/cloud/vis。**加任何"逐时判定"前先确认 `groupByDay` 有那个字段。**
- **界面风向用记录式写法**：16 方位在《地面气象观测规范》里写作「西西南 / 西西北 / 北东北」，念不出来。界面改用同义「偏」式（西南偏西 / 西北偏西），并补角度（252°）与下风向（雾滴飘向东北偏东）。标准号 GB/T 37302-2019 表 A.1 可核。
- **图表参差**：四张图各自有独立 `sec-h` 标题、`padding`、`H`，并排两张底边永远对不齐。v4.7 统一成 `.chart-card` 骨架（卡内标题+图例 / 图 / 一行注脚），并排两张统一 `H=238`，e2e 断言 `Δheight ≤ 1px`。
- **`#windTitle` 被删导致整页报错**：`$('windTitle').textContent` 未做空判断，删 DOM 后 `load()` 抛 "Cannot set properties of null"。改图表结构时先跑 e2e。
- **`mm` 轴标压在第一根雨柱上**、**风速上限标签压在曲线上**：已改为右上角统一单位 + 左端带白色描边的标签。

### 11.0.2 v4.6 修掉的问题（别再改回去）

- **降雨概率漏判**：原实现只看当日/前日雨量，70% 概率仍会给"可作业窗口"。现在逐小时概率 ≥50%、单小时降水 >0.1 mm 都不排窗口，`test-logic.mjs` 有回归用例。
- **夜间风速图像坏掉**：晚上 10 点打开时今天只剩 1 小时数据，图被压成一条竖线；现在 X 轴固定 0–24，且当天剩余作业时段不足 2 小时时自动切到明天。
- **硬编码 6–17 时**：`logic.js` 的提示文案里写死过时段，已全部改成读 `RULES.spray.hours`。
- **能见度假 0 / 日出日落空**：和风 168h 不返回 `vis`，旧代码 `num(undefined)=0` 会显示"能见度 0 km"；现改为缺字段返回 `null` 显示「—」，日出日落兼容 `07:01` 与 ISO 两种格式。
- **具体节气问错**：问「霜降」却回答当前「立冬」，现在先匹配问句里的节气名。
- **顶部白边与方块按钮**：`theme-color` 改为随天气主题变化，顶栏用安全区 padding + 透明图标按钮。

### 11.1 高德在本地不可用（已降级，不再是测试失败项）

`amapKey` 的控制台域名白名单里通常没有 `localhost / 127.0.0.1`，本地起服务时 JS API 报 `INVALID_USER_KEY`/域名不匹配。v5.0 的处理：

- `bindMapStage()` 预加载失败 → `MAP.failed = true` → `updateMapMode()` 把标签改为「本地示意地图 · 可点选」，`renderMap()` 直接画 `renderFallbackMap()`（河北行政区划 SVG，可点选取点）；`__tzPickCenter` 在降级态走 `fallbackSvg` 的点击逻辑。
- 地点搜索、逆地理、附近 POI 与坐标保存都不依赖高德 SDK，降级后照常可用。
- `e2e` 第 5 节同时接受高德与示意图两种模式，并断言标签不再停在「地图加载中…」；当前 117 项全通过。
- `flyToPoint()` 的运镜效果**本机仍无法验证**，只能在线上或真机看；若要验证，把 `localhost`、`127.0.0.1` 加进 `console.amap.com` 白名单。

### 11.2 白名单 key 的额度风险

`amapKey / amapWebKey / qweatherKey` 都在 `config.js` 里，**任何人打开网页都能看到并直接调用**。防护只有域名白名单和免费额度。如果发现额度异常消耗：换 key，并确认高德白名单已配、和风控制台可随时换 key。`amapWebKey` 是给浏览器用的，不能设 IP 白名单。

### 11.3 `site/sw.js` 每次构建都变

构建号是时间戳，写进 `sw.js` 的 `CACHE` 名。这是为了让旧缓存失效，**必须如此**。提交时看到 `M site/sw.js` 不要慌，也不要手动改回。

### 11.4 文档滞后

`README.md` 的目录树是 11-13 写的，**没有 `content.js`**；`docs/运行说明.md` 里还在描述「多气象模式一致性检查」这一节（对应 DOM `consensusBox`，已在改版中删除，`e2e` 有断言 `!document.getElementById('consensusBox')`），界面细节也与当前版本有出入。以代码和 `content.js` 为准；`docs/AI交接文档.md`（本文）是当前最新。

### 11.4.1 精细判定（v4.7）

| 判据 | 阈值 | 作用 | 依据 |
|---|---|---|---|
| 结露 | 气温 − 露点 ≤ 1.5℃ 或 湿度 ≥ 92% | 该小时不排窗口，热力图标「露水」 | 叶面有游离水时药液被稀释、流失；乳油类易药害 |
| 日落收工 | 日落前 1.5 小时 | 当日截止小时取 `min(16, floor(日落−1.5))` | 日落后地面辐射冷却形成逆温，雾滴悬空不落地 |
| 日照时数 | 白昼逐时云量 < 60% 的小时数 | 晾晒：< 3 小时降级为「勉强可晒」 | 晾晒靠日照，不只看气温 |
| 风向 | 16 方位 + 角度 | 首屏给「雾滴飘向 X」，表里给原值 | 飘移方向决定邻地药害风险 |

这些参数在 `logic.js` 的 `RULES.spray`（`dew_gap_min` / `hum_max` / `sunset_margin_h`），「我的 → 作业标准」会读实时值显示，改一处界面自动跟。

**行为变化**：冬季（日落 17:00 前后）可作业时段从 9–16 收紧到 9–15，窗口少 1 小时。这是按逆温常识收紧，不是回归。

### 11.5 标准覆盖的边界（不是 bug，但要说清）

- 县级文件绝大多数是转发省级，本库**不逐县收录**，统一按所属地级市处理。
- 石家庄、唐山有可执行的市级标准；廊坊有市级文件但未获全文，**不按标题猜数值**，回落省级。
- 保定只有市植保站现场会口径（3.3 m/s），属技术口径不是标准，`binding:false`，只展示不参与取严。
- 邢台金银花标准已于 2025-06-01 废止；沧州是林业、张家口是露地蔬菜，均不适用于小麦 / 玉米。
- 标准会更新。`standards.js` 的 `CHECKED` 是查证日期，更新条目时一起改；`test-standards.mjs` 会校验每条有没有编号与链接。

### 11.5.1 首页删减后留下的死代码（v5.0 已清理）

v4.5–v4.7 逐步删界面时，`app.js` 里累积了约 750 行从未被调用的旧渲染代码：`renderHero / renderDays / renderCards / renderSprayRow / bindSprayButtons / paintSky / skyCloud / startCountdown / renderDelayCost / renderCloseCondition / renderWhatIf / computeWhatIf / bindWhatIf / runWhatIf / renderLimits / confStrip / marginEval / windowScore / kpiCell / gbar / bindTaskSwitch` 等。v5.0 已整段移除，同时补回由这些函数负责、但删界面后失联的两处输出：`#todayDate`、`#weekRainNote`。

**接手注意**：旧文档 / 旧脚本里提到的上述函数名在代码中已不存在；改 UI 请按 §6 的 v5 函数索引找。清理后 `node --check`、三套测试与 e2e 全部复跑通过。

### 11.6 `scripts/` 里大量历史脚本

`scripts/` 下有 20+ 个 `test-*.mjs / audit-*.mjs / shot-*.mjs`，是 11-12 至 11-13 开发期的验证工具，**未逐一复测**，其中 `run-all.mjs` 里的断言数量说明（246 条等）已过时。当前可信的只有：`build-site.mjs`、`doctor.mjs`、`web/test-logic.mjs`、`web/test-standards.mjs`、`web/e2e.mjs`。其余按 **需确认** 处理，别把它们当 CI。

### 11.7 `dist/` 是旧产物且有乱码目录

`dist/` 是 11-13 生成的交付包，已 gitignore。里面有两个乱码目录（`鍏綉鐗圽_t4`、`鍏綉鐗圽icons`），是早期 Windows 编码问题留下的。可以直接删，不影响任何链路。

### 11.8 TWA 已弃用但仍有残留

`web/download/zhishi-zhinong-twa.apk`（1.2 MB）和 `web/.well-known/assetlinks.json` 是 TWA 方案留下的。TWA 本质是「借 Chrome 打开网页」，设备没 Chrome 就退回带地址栏的 Custom Tab，所以最终改成了自建 WebView 壳。这两个文件目前不参与任何逻辑，**可以保留也可以清理**；`assetlinks.json` 的包名仍是 `io.github.leeforword.twa`（WebView 壳沿用同一包名与签名，以便覆盖安装）。

### 11.9 微信验证文件不能丢

`web/a48619f8725f122b1ed63073c8f543f5.txt`（内容 `d488f92406f39078b179fdb042c0de54cd658c8c`）是微信「申请恢复访问」的域名验证文件。`build-site.mjs` 会自动把它复制到 `site/` 根，并断言存在。**删了或构建漏了，微信会重新拦截站点。** 另一个同名文件部署在域名根仓库 `leeforword/leeforword.github.io`（不在本工作区，**需确认**是否仍在用）。

### 11.10 单文件 120 KB 的 `index.html`

结构、样式、媒体查询全在一个文件里。改动 UI 时要小步验证，尤其注意：

- 底栏胶囊 `#tabPill` 是按 `getBoundingClientRect()` 实时定位的，**按钮不能有改变几何的 `:active` 变换**（曾经的 `scale(.94)` 导致胶囊错位）。
- 图表宽度依赖容器 `clientWidth`，视图 `display:none` 时量到 0，所以切回内容页要重画（`setView` 里已处理）。
- 手机端 `interactive-widget=resizes-content` 与 `windowSoftInputMode=adjustResize` 配合，弹窗键盘不遮地图。

### 11.11 其他

- AI 在公网默认关闭（无 key），所以线上体验是「纯规则引擎 + 模板回答」，这是设计选择，不是故障。
- 集合预报在多国内网络会 TCP 超时，表现为「暂无法评估置信度」。部署 Worker 的 `/om/` 中转可解决，当前未配。
- `index.html` 顶部 CSS 注释仍写「蓝色为交互主色」，实际主色是 `#3D6B55` 墨绿。纯注释问题，不影响运行。

---

## 12. 待办事项

### 12.1 赛事硬要求（最紧急，11/22 截止）

按 `docs/大赛通知.txt`，A 赛道智能体方向还需：

1. **演示录屏 ≤3 分钟**（16:9 或 9:16，字幕完整）。
2. **关键界面截图 3–5 张**（首页判读、问答依据、地图选点、我的-作业标准、依据弹层）。
3. **运行说明**（`docs/运行说明.md` 已有，但需按当前界面更新）。
4. 通过学院统一提交作品与全部材料。

### 12.2 产品层（影响评审得分，非代码能补）

1. **真实用户试用** 3–5 人（种植户 / 农技专业同学），记录原话与据此做的修改。**不要编数据**——这是评审红线。
2. 单独的《AI 使用声明》文件（页面和 `docs/AI使用声明.md` 已有内容，需导出成交付格式）。
3. 《作品说明书》PDF / Word（正文已在 `docs/作品说明（参赛材料）.md`，转格式即可）。

### 12.3 技术层（按性价比排序）

1. （可选）给 `localhost` 加高德白名单，用于验证真实地图与 `flyToPoint()` 运镜；降级态已可正常工作且被测试覆盖，不再是阻塞项。
2. 接入真实遥感 NDVI，替换长势占位图（当前明确标注「不输出结论」）。
3. 部署 Cloudflare Worker（`llmProxyUrl` + `openMeteoProxy`），解决集合预报超时、让 AI 润色可用且不暴露 key。
4. 补齐未获全文的市级标准（廊坊 DB1310/T 320-2023、石家庄 DB1301/T 518-2024），并逐年复核省站新文件。
5. 把 `content.js` 里的数字与 `standards.js` / `logic.js` 做一致性断言，防止文案与代码漂移。
6. 清理 `dist/`、`_archive/`、TWA 残留；给 `scripts/` 做一次取舍，把不用的移进 `_archive/`。
7. 更新 `README.md` 目录树与 `docs/运行说明.md` 的界面描述。

### 12.4 明确的「不做」

- 不做病虫害图像识别（需要模型与数据集，超出当前范围）。
- 不做用户账号与云端同步（与「数据只存本机」的隐私声明冲突）。
- 不引入前端框架或构建工具（零依赖是可复现性的一部分）。

---

## 13. 安全与合规注意事项

### 13.1 密钥

- **绝不要**把任何 `sk-` 开头的 key 写进 `config.js`、页面、Git 历史或截图。
- `web/config.local.js` 里当前有一把**明文 DeepSeek key**（已被 gitignore）。它不进产物、不进仓库，但存在于本机磁盘，且可能在录屏/截图时暴露。**建议轮换一次**，并把新 key 只放在本地或 Worker Secret 里。
- 高德 key、和风 key 是「前端公开」性质，靠域名白名单 + 免费额度兜底，不属于机密，但被刷会直接影响可用性。
- Worker 的 `DEEPSEEK_KEY` 必须用 Secret，不要用 Plaintext 变量；`ALLOWED_ORIGINS` 必须填，否则等于公开代理。

### 13.2 仓库

- 仓库是**公开**的。任何一次 `git push` 都等于公开发布，包括注释、测试数据、截图。
- 不要提交 `.build/`（含便携 JDK、调试输出）、`.workbuddy/`、`dist/`、`node_modules/`。
- 不要提交 keystore、`signing-key-info.txt`、任何带个人信息的截图。
- 推送 TLS 报错时临时用 `-c http.sslVerify=false`，**不要写进 git config**。

### 13.3 数据与隐私

- 不收集姓名、手机号、通讯录；无后端数据库；无埋点。
- 地块、阈值、AI 配置、纠错记录只存 `localStorage`；定位坐标只用于请求天气与地图。
- 页面文案已如实声明以上内容（`content.js` 的 `p-11`），改功能时不要让声明与实现脱节。

### 13.4 内容合规

- 不编造用户反馈、实验结果、准确率、产量、满意度。
- 未接入的能力（遥感、病虫害）、未做的验证（用户试用），必须在界面和说明书里明确标注「未做」。
- 素材：图标、背景、插画均为程序化生成 / 手绘 SVG；无第三方图片、字体、音乐、人物肖像。
- 农事建议必须保留免责声明：以当地农技部门意见与农药标签为准。

### 13.5 运行安全

- `server.mjs` 默认只绑 `127.0.0.1`，`--lan` 才绑 `0.0.0.0`（宿舍/教室 WiFi 下慎用）。
- 有目录穿越防护（`path.join` + 前缀校验）。
- APK 签名 keystore 在桌面目录，**丢失即无法覆盖升级**，建议单独备份。
- Service Worker 不缓存跨域接口，这是安全设计：防止用过期天气做农事决策。

---

## 14. 交接自检清单

```bash
cd /d/zhishi-zhinong

# 1. 环境与三处清单（只读，必须 0 失败）
node scripts/doctor.mjs

# 2. 规则引擎（需联网）
node web/test-standards.mjs
node web/test-logic.mjs

# 3. 端到端（另开终端起服务；本机预期 65/2）
node web/server.mjs 8931
node web/e2e.mjs

# 4. 构建（预期自检全 OK；之后 site/sw.js 会有构建号 diff）
node scripts/build-site.mjs

# 5. 线上核对
curl -sS -o /dev/null -w "%{http_code}\n" https://leeforword.github.io/zhishi-zhinong/
curl -sS https://leeforword.github.io/zhishi-zhinong/a48619f8725f122b1ed63073c8f543f5.txt
```

接手时的判断标准：

- `doctor` 的 FAIL 必须为 0；WARN 里只应剩「config.local.js 明文 key」和「有未提交改动」。
- `test-logic` 失败数必须为 0。
- `e2e` 失败数 ≤2 且失败项是 `AMap rendered` / `map pick triggered`。
- 构建自检全 OK，产物约 27 个文件 / 2.5 MB。
- 线上返回 200，验证文件返回 40 字节的 hash。

---

## 15. 未知 / 需确认清单

以下内容无法从代码或当前环境确认，接手时若涉及请先问清楚，不要猜：

1. `leeforword/leeforword.github.io` 根仓库现在是否仍在使用（微信验证 + 跳转页），以及谁有权限。
2. 高德控制台里 `amapKey` / `amapWebKey` 当前的域名白名单具体条目、账号剩余配额。
3. 和风天气账号的套餐与剩余额度；`qweatherHost` 是否仍有效。
4. DeepSeek 账号余额；`config.local.js` 里那把 key 是否仍有效、是否已轮换。
5. Cloudflare Worker 是否已部署、`ALLOWED_ORIGINS` 配了哪些域名。
6. 安卓签名 keystore 与 `signing-key-info.txt` 是否仍在原路径、是否有备份。
7. 赛事提交的具体学院流程、材料格式模板（通知只给了大类要求）。
8. `scripts/` 下除 `build-site.mjs`、`doctor.mjs` 外的脚本，哪些还需要保留。
9. 是否有除 `main` 外的协作分支 / 其他贡献者（当前只见单人提交）。
10. iOS 侧只提供 PWA「添加到主屏」路径，没有原生包；是否需要上架或 TestFlight —— 未知。

---

## 16. 最近提交（便于理解演进）

```
ec0a269 内容设计大改：新建内容层，补齐知识依据/资料来源/作品说明，重写问答依据与边界
7f0dbc4 去掉 WebView 点击蓝框，修底栏按压态导致指示块错位
193979b 部署微信域名验证文件，构建时自动复制到站点根
17bed70 地名按真实类型标注，地图点选加运镜
1c9e591 修图表截断与七天硬切，新增地块改微信式全屏选点
f8f0acd 底栏按钮垂直居中，修胶囊上下留白不均
2f71fce 底栏胶囊精确对齐按钮；删首页地块区块与反事实入口
```

一条经验：这个项目的历史 bug 集中在四处 —— **CSS 尺寸靠估算**、**删函数忘了删导出/绑定**、**`fixed` 元素被父级 `transform` 影响**、**图表写死宽度导致截断**。改这四类地方时，优先用实测值（`getBoundingClientRect` / `clientWidth`），改完跑 `e2e`。

---

*本文基于 2026-11-16 的工作区实测。代码变了就更新它，别让它变成第二份滞后文档。*
