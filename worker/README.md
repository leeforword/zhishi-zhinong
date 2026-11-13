# AI 中转部署 · 手把手

> 目的：让网站能用大模型，但**源码里不出现 key**；
> 顺带把国内打不开的 Open-Meteo 转出去，保住"置信度"这块功能。
> 全程免费，大约 10 分钟。

---

## 为什么要多这一层

网站是纯静态的，源码全网可见。如果把 DeepSeek key 写进前端：

```
任何人都能：右键 → 查看网页源代码 → 复制你的 key → 刷到欠费
```

所以把 key 放在 Cloudflare 的服务端（就是下面这个 Worker 里），
前端只知道一个地址，**拿不到钥匙**：

```
浏览器  ──POST──▶  Worker（key 在这里）──▶  DeepSeek
  ↑ 没有 key                    ↑ 有 key
```

---

## 一、注册并创建 Worker（网页操作，不用装东西）

1. 打开 <https://dash.cloudflare.com> 注册（邮箱即可，不需要信用卡）
2. 左侧菜单 **Workers & Pages** → **Create** → **Start with Hello World!** → **Deploy**
3. 部署完点 **Edit code**
4. 把编辑器里全部内容删掉，粘贴本目录 `ai-proxy.js` 的完整内容
5. 右上角 **Deploy**

此时你已经有一个 Worker 了，地址形如：

```
https://zhishi-ai.你的账号名.workers.dev
```

浏览器直接打开这个地址，应该看到：

```json
{ "ok": true, "service": "知时智农 · AI 中转", "configured": false }
```

`configured: false` 表示还没配 key，正常，下一步就配。

---

## 二、配置 key 和来源白名单

在 Worker 页面 → **Settings** → **Variables and Secrets**：

| 名称 | 类型 | 值 | 说明 |
|---|---|---|---|
| `DEEPSEEK_KEY` | **Secret** | `sk-...` | 你的模型 key。**必须用 Secret，不要用 Plaintext** |
| `ALLOWED_ORIGINS` | Text | `https://leeforword.github.io,http://localhost:8931` | 只允许这两个来源调用 |
| `MODEL` | Text | `deepseek-chat` | 选填 |

点 **Save and deploy**。

> **`ALLOWED_ORIGINS` 一定要填。** 不填的话任何人都能拿你的 Worker 当免费代理刷，
> 烧的是你的额度。填了之后，别的网站调用会直接 403。

再打开 Worker 地址，`configured` 应该变成 `true`。

---

## 三、把地址填进网站

两个位置任选一个（推荐第一种，改完立刻生效）：

**A. 页面里填（推荐）**

打开网站 → 底部/左侧 **我的** → 找到「AI 对话」→ 模式选 **中转** →
在「中转地址」里粘贴你的 Worker 地址 → **保存** → 点 **测试连接**。

看到「连接正常，模型返回类别：spray」就成功了。

> 这样填的值存在**你这台设备**的浏览器里，不写进代码。
> 换设备要再填一次。

**B. 写进代码（让所有访客都能用）**

把地址填到 `web/config.js`：

```js
llmProxyUrl: 'https://zhishi-ai.你的账号名.workers.dev',
```

提交推送即可。地址是公开的没关系——**key 不在里面**。

---

## 三·五、顺带解决：Open-Meteo 直连超时

和风负责主预报，但**集合预报（置信度）和多模式分歧只有 Open-Meteo 有**。
而 `api.open-meteo.com` 在国内多数网络（校园网尤其明显）是 TCP 超时，
直连时页面只能显示「主预报余量评估」，拿不到真置信度。

同一个 Worker 已经带了一条中转路由，不用额外配置、不用再加 key：

```
浏览器 ──GET──▶ Worker /om/api.open-meteo.com/v1/forecast?... ──▶ Open-Meteo
```

部署好之后，把地址填进 `web/config.js`：

```js
openMeteoProxy: 'https://zhishi-ai.你的账号名.workers.dev',
```

- 只放行 `api.open-meteo.com`、`ensemble-api.open-meteo.com` 等白名单主机，
  不会变成谁都能用的开放代理
- 响应缓存 5 分钟，少吃上游额度
- 留空就是直连，行为和没配完全一样
- **这条路由不需要 `DEEPSEEK_KEY`**，只想要置信度、不要 AI 的话，环境变量可以只填 `ALLOWED_ORIGINS`

---

## 四、安全边界（如实说明）

| 项目 | 状态 |
|---|---|
| key 存在哪 | Cloudflare 服务端 Secret，前端读不到 |
| 谁能调用你的 Worker | 只有 `ALLOWED_ORIGINS` 里列的域名 |
| 额度被刷风险 | 大幅降低，但不是零：别人可以伪造 Origin 头。真正的护栏是 Cloudflare 你自己的用量告警 |
| 建议做 | Cloudflare 后台开一个用量提醒；DeepSeek 后台设置余额上限 |

Worker 本身也做了几道限制：单次请求最多 24 条消息、总共 12000 字符、
`max_tokens` 上限 800、只接受 `system/user/assistant` 三种角色、
不把上游报错的细节透出去。

---

## 五、不想用 Cloudflare 的替代方案

同样的代码（`ai-proxy.js` 用的是标准 Workers 语法）可以放在：

- **Vercel**：改写成 `api/chat.js`，`export default async function handler(req, res)`，key 放环境变量
- **Netlify Functions**：改写成 `netlify/functions/chat.js`
- **自己的服务器**：任何能跑 Node 的地方

只要满足两个条件：① 服务端持有 key ② 有 CORS 且限制来源。

---

## 六、关于"关闭 AI"

页面 **我的 → AI 对话 → 模式选「关闭」**，或者把 `config.js` 里的
`llmProxyUrl` 留空。

关掉后问答仍然可用——所有结论和数字本来就由规则引擎算出，
大模型只负责把话说顺。界面会显示「纯规则引擎模式」。
