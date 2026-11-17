/**
 * chem.js — 施药天气适宜性判定（v5.2）
 * -------------------------------------------------------------
 * 这个模块回答的是一个非常具体的问题：
 *   农户已经定好了要打什么药，问「就现在这个天气，这药能不能打」。
 *
 * 它不做三件事：不诊断作物症状、不推荐药剂、不给剂量与配伍。
 * 药剂是输入，不是输出；输出只有「此时此地的气象条件是否允许施用」。
 *
 * 与通用问答 AI 的分工差别（也是本模块存在的理由）：
 *   通用模型能背出「3 级风以下、无露水、避开高温」这类条文，
 *   但它拿不到这块地此刻的逐时风速 / 露点 / 降雨概率 / 日落时刻，
 *   也算不出「今天具体哪两个小时能打、下一次窗口是哪天」。
 *   本模块把公开文件里的判据，逐条套到 state.raw.hourly 的真实数值上，
 *   每条判定都标出处，离线可查。
 *
 * 收录原则（评审会看，别破坏）：
 *   1. 每条依据都带发布机构、条款/章节、原文 URL 与查证日期；
 *   2. 不同文件口径不一致时并列写明，判定按「属地标准 + 药剂专属」取严；
 *   3. 拿不到全文或没有实测数据的项（墒情、虫龄、具体产品 rainfast 时长）
 *      只作提示，不编造数字、不参与硬判定；
 *   4. 不引用未经查证的标准条款号。
 *
 * 挂载：globalThis.TianZhiChem（与 standards.js 同款，node 可直接单测）
 */
(function (root) {
  'use strict';

  var CHECKED = '2026-11-17';

  /* ==========================================================
     1. 权威依据库（离线内置，问答与「依据」弹层共用）
     level 用于向用户说明证据强度，不作判定权重。
     ========================================================== */
  var SOURCES = [
    {
      id: 'nyt1276', code: 'NY/T 1276 7.1.2', level: '农业行业标准',
      title: '农药安全使用规范 总则', issuer: '农业农村部',
      clause: '第 7.1.2 条',
      point: '不宜在高温、雨天或风力大于 3 级（风速大于 5.4 m/s）时施药；施药适期应结合病虫草发生程度、作物生育期与药剂性能确定。',
      url: 'http://www.aqsc.org/zlbz/bzgg/202504/P020250610329849590871.pdf'
    },
    {
      id: 'hbweed', code: '河北省麦田杂草冬前综合防控技术', level: '省级技术意见',
      title: '河北省麦田杂草冬前综合防控技术', issuer: '河北省农业农村厅',
      clause: '三、注意事项（一）施药时机',
      point: '无风晴天、上午 9 时至下午 4 时施药，日平均气温稳定在 8℃ 以上；强降温前后 5 天、阴雨天、大风天禁施；封闭除草要求墒情适宜。',
      url: 'https://nync.hebei.gov.cn/html/www//nyjds/nyglgzdt/2118527896506937345.html'
    },
    {
      id: 'moa5c', code: '冬前田间管理意见（日均温 5℃）', level: '部委转载省级技术意见',
      title: '2022 年小麦冬前田间管理意见', issuer: '农业农村部转载 · 山西省农业技术推广服务中心',
      clause: '（二）适时化学除草',
      point: '冬前化学除草应选择日均气温高于 5℃ 的无风晴天；日均气温降至 5℃ 以下禁止化学除草，以防药害。',
      url: 'https://www.moa.gov.cn/xw/qg/202212/t20221202_6416536.htm'
    },
    {
      id: 'moa8c', code: '河北专家冬小麦管理建议', level: '部委转载专家意见',
      title: '小麦如何越冬？河北专家建议', issuer: '农业农村部转载',
      clause: '第 2 点 适时开展化学除草',
      point: '日均温度高于 8℃、晴朗无风，上午 10 点后至下午 3 点前化除；最低气温低于 4℃ 不可用药；避免在冷空气入侵阶段用药。',
      url: 'https://www.moa.gov.cn/xw/qg/202011/t20201120_6356587.htm'
    },
    {
      id: 'hljuav', code: '植保无人飞机规范施药技术', level: '省级部门技术规程',
      title: '植保无人飞机规范施药技术', issuer: '黑龙江省农业农村厅',
      clause: '三、合理制定作业计划（气象条件）',
      point: '风速 >3.3 m/s 应停止化学除草作业，>4 m/s 应停止病虫害防治作业；空气相对湿度低于 40% 应停止施药；温度低于 15℃ 或超过 30℃ 不宜作业；避开 10—15 时强光；不可顺风施药。',
      url: 'https://nynct.hlj.gov.cn/nynct/c115393/202606/c00_31949515.shtml'
    },
    {
      id: 'cmawind', code: '中国气象局 · 飞防作业口径', level: '国家级气象科普',
      title: '我和天气打交道丨植保无人机操作员：看天起飞', issuer: '中国气象局',
      clause: '作业人员实操口径',
      point: '因药性不同，杀虫杀菌作业通常要求小于 3 级风，除草剂作业要求小于 2 级风；夏季气温超过 30℃ 不再作业；湿度过低时雾滴蒸发导致药效不佳。',
      url: 'https://www.cma.gov.cn/2011xwzx/ywfw/202404/t20240428_6228616.html'
    },
    {
      id: 'cmadew', code: '中国气象局 · 看天巧施农药', level: '国家级气象科普',
      title: '看天巧施农药', issuer: '中国气象局',
      clause: '雨露 / 风 / 气温 / 日光',
      point: '喷雾宜选晴天无露水时进行，以免露水稀释药液、降低药效；喷粉反而宜在晨昏有露水时；喷后遇降水会冲失药剂；高温使药剂蒸发加快、渗透增强，烈日中午施药易致药害与中毒；部分药剂见光易光解。',
      url: 'https://www.cma.gov.cn/kppd/kppdqxyr/kppdshqx/201301/t20130110_201991.html'
    },
    {
      id: 'fao', code: 'FAO 地面施用农药的正确操作准则', level: '国际组织准则',
      title: '地面施用农药的正确操作准则', issuer: '联合国粮食及农业组织（FAO）',
      clause: '4.2 风速 / 温湿度 / 耐雨水冲刷',
      point: '1~2 m/s 最适合液力喷头作业；静风（<2 km/h）不能喷雾，因逆温会使细雾滴远距离飘移；7—10 km/h 应避免除草剂喷雾；高温低湿使雾滴蒸发萎缩、增加飘失；低温降低药剂生物活性，高温可能致药害；耐雨水冲刷时间以产品标签为准，喷后 2 小时有阵雨不必当然重喷。',
      url: 'https://www.fao.org/4/y2767c/y2767c00.htm'
    },
    {
      id: 'agvic', code: 'Agriculture Victoria · 逆温识别', level: '境外官方指引',
      title: 'Recognising surface temperature inversions', issuer: '澳大利亚维多利亚州农业厅',
      clause: '识别与消散条件',
      point: '地表逆温多发生在日落到日出后 2 小时；出现雾、露、霜、烟尘横向悬浮、夜间风速持续低于 11 km/h 是典型征兆；逆温条件下细雾滴会悬在近地冷层并不可预测地远距离移动，应停止喷雾；通常日出后升温 5℃ 以上且风速 >7 km/h 持续 45 分钟才消散。',
      url: 'https://agriculture.vic.gov.au/farm-management/chemicals/spraying-agricultural-chemicals/managing-spray-drift/recognising-surface-temperature-inversions'
    },
    {
      id: 'grdc', code: 'GRDC · Hazardous inversion', level: '境外官方研究机构',
      title: 'Hazardous inversion', issuer: '澳大利亚谷物研发公司（GRDC）',
      clause: '最佳实践',
      point: '2 米高度风速低于 5 km/h 时不宜喷雾；风向不稳定无论昼夜都不宜喷雾；逆温条件下飘移可在数公里外造成药害。',
      url: 'https://grdc.com.au/resources-and-publications/all-publications/factsheets/2022/hazardous-inversion'
    },
    {
      id: 'pirsabel', code: '南澳 PIRSA · 化学品使用最佳实践', level: '境外官方指引',
      title: 'Chemical use best practice', issuer: '南澳州初级产业与区域发展部（PIRSA）',
      clause: 'Weather conditions for spraying',
      point: '应在稳定轻风 3—20 km/h、且风从敏感区域吹开时喷雾；静风与逆温条件禁止喷雾；激素类除草剂（2,4-D 等）标签另有雾滴粒径、缓冲区与日落前后 1.5 小时禁喷要求。',
      url: 'https://pir.sa.gov.au/biosecurity/rural_chemicals/chemical_use_and_best_practice'
    },
    {
      id: 'bayer', code: 'Bayer · 草甘膦低温与潮湿条件', level: '企业技术资料（机理）',
      title: 'Glyphosate Efficacy and the Effects of Cold and Wet Spring Conditions', issuer: 'Bayer Crop Science',
      clause: '温度 / 降雨 / 霜冻',
      point: '草甘膦需经叶片吸收并随韧皮部传导，低温会减慢杂草生长、吸收与传导；凉爽多云或高湿条件会延长达到耐雨冲刷所需时间；雨前未吸收完全会被稀释或冲刷；霜冻后应待杂草恢复活跃生长再施药；一切以产品标签为准。',
      url: 'https://www.cropscience.bayer.us/articles/bayer/glyphosate-efficacy-in-cold-and-wet-spring-conditions'
    },
    {
      id: 'mndnr', code: 'Minnesota DNR · 林业施药气象条件', level: '境外官方作业规范',
      title: 'Division of Forestry Pesticide Use Guidelines', issuer: '美国明尼苏达州自然资源部',
      clause: 'Wind / Temperature / Relative humidity / Precipitation',
      point: '持续风速不得超过 7 mph，阵风不得超过 10 mph；应避开 0—3 mph 的静风（可能逆温）；相对湿度低于 40% 应谨慎、低于 50% 宜暂停；预报 4 小时内有雨或 2 小时内有雾应停止施药；目标植被上的重露水会降低防效，草甘膦尤其明显，宜等露水消退。',
      url: 'https://files.dnr.state.mn.us/forestry/ecssilviculture/policies/pesticide_use_guidelines.pdf'
    },
    {
      id: 'rainfast', code: '打完药遇雨是否重喷（农技科普）', level: '农技科普（参考，不作硬判定）',
      title: '打完农药就下雨，要不要重新打一遍', issuer: '安徽农网 / 农视网',
      clause: '时间间隔 / 药剂类型 / 雨量',
      point: '内吸渗透强的药剂 1—2 小时可吸收约 70%，内吸性弱的 4—6 小时吸收 60—80%；施药距降雨超过 4 小时一般不必重喷；保护性杀菌剂 4 小时内遇雨需补喷（常为半量）；10 mm 以上降雨且间隔不足 8 小时需考虑补喷；具体以标签为准。',
      url: 'https://www.ahnw.cn/nyqx/Content/374c741d-9fe9-4fbb-abc1-efb2888178f9'
    },
    {
      id: 'tsspray', code: '农业社会化服务 病虫害防控服务规范 5.5.3', level: '地方标准',
      title: '农业社会化服务 病虫害防控服务规范', issuer: '唐山市市场监督管理局（公开文本）',
      clause: '5.5.3',
      point: '高温季节宜早晚施药，雨天及风力大于 3 级的天气不宜施药；农药选择与施用按 NY/T 1276 和 GB/T 8321（所有部分）执行。',
      url: 'http://scjdglj.tangshan.gov.cn//u/cms/gongshangju/202207/14172209v293.pdf'
    }
  ];

  function src(id) {
    for (var i = 0; i < SOURCES.length; i++) if (SOURCES[i].id === id) return SOURCES[i];
    return null;
  }
  function cite(id) {
    var s = src(id);
    return s ? s.code : '';
  }

  /* ==========================================================
     2. 药剂类型：同一套天气，不同的敏感阈值
     wind_stop / temp_min 等是「这一类药」的附加约束；
     运行时还会与属地 RULES.spray 取严（见 effectiveLimits）。
     ========================================================== */
  var TYPES = {
    generic: {
      key: 'generic', label: '喷雾作业（未指定药种）',
      short: '打药', tags: '打药 喷药 喷雾 施药 能打吗 能不能打',
      wind_stop: 5.4, temp_min_hard: null, temp_min_ideal: null, temp_max: 30, rain_free_h: 4,
      ids: ['nyt1276', 'hljuav', 'fao', 'cmadew'],
      notes: [
        '未说明药种时按通用喷雾底线判定；除草剂对风速和低温更敏感，杀菌剂更看雨前时机，点下方追问可切换。',
        '合规红线来自 NY/T 1276 7.1.2：高温、雨天或风力大于 3 级（>5.4 m/s）不宜施药。'
      ]
    },
    herbicide: {
      key: 'herbicide', label: '除草剂（茎叶 / 封闭）',
      short: '除草剂',
      tags: '除草剂 除草 封闭 封地 茎叶处理 化除 草甘膦 草铵膦 苯磺隆 甲基二磺隆 双氟磺草胺 氯氟吡氧乙酸 2甲4氯 二甲四氯 炔草酯 唑啉草酯 异丙隆 氟唑磺隆 啶磺草胺 精噁唑禾草灵 砜吡草唑 吡氟酰草胺',
      wind_stop: 3.3, temp_min_hard: 8, temp_min_ideal: 10, temp_max: 30, rain_free_h: 4,
      ids: ['nyt1276', 'hbweed', 'moa5c', 'moa8c', 'hljuav', 'cmawind', 'fao', 'bayer', 'mndnr', 'pirsabel', 'cmadew'],
      notes: [
        '冬前茎叶化除要求日均温稳定 8℃ 以上、无风晴天 9—16 时；强降温前后 5 天禁施（河北省农业农村厅）。部分省份口径为日均温 5℃ 以下禁止化除，本判定按更严的河北口径。',
        '内吸型（如草甘膦）依赖杂草活跃生长与韧皮部传导，低温、重露水、雨后叶面未干都会削弱吸收；喷后耐雨冲刷时间以标签为准（Bayer / 明尼苏达 DNR）。',
        '激素类（2,4-D、2 甲 4 氯、麦草畏类）还存在蒸气飘移，高温时尤其要看邻田敏感作物与风向；这类药的风速与缓冲区要求比一般喷雾更严。',
        '土壤封闭剂反而需要适宜墒情才能成膜；本系统没有土壤墒情数据，只提示、不参与判定。'
      ]
    },
    insecticide: {
      key: 'insecticide', label: '杀虫剂',
      short: '杀虫剂',
      tags: '杀虫剂 杀虫 治虫 蚜虫 麦蜘蛛 红蜘蛛 吸浆虫 地下害虫 黏虫 吡虫啉 噻虫嗪 啶虫脒 阿维菌素 菊酯 联苯菊酯 氯氟氰菊酯 辛硫磷 乐果 抗蚜威',
      wind_stop: 4, temp_min_hard: null, temp_min_ideal: 15, temp_max: 30, rain_free_h: 2,
      ids: ['nyt1276', 'hljuav', 'cmawind', 'cmadew', 'fao', 'rainfast'],
      notes: [
        '飞防口径：风速 >4 m/s 停止病虫害防治作业；相对湿度 <40% 停止施药（黑龙江省农业农村厅）。',
        '温度直接改变药效：内吸型在低温下吸收传导变慢（乐果 15℃ 以下防蚜效果明显变差），部分拟除虫菊酯属负温度系数；低温不是绝对禁施，但要预期药效偏慢。',
        '触杀型靠雾滴覆盖，风大时叶背与冠层内很难打到；辛硫磷等光敏药剂宜傍晚施用以减少光解（中国气象局）。',
        '避开作物花期与授粉昆虫活动时段；本系统不掌握田间虫情，虫龄与防治指标以当地植保站测报为准。'
      ]
    },
    fungicide: {
      key: 'fungicide', label: '杀菌剂',
      short: '杀菌剂',
      tags: '杀菌剂 杀菌 防病 治病 赤霉病 锈病 白粉病 纹枯病 根腐病 茎基腐病 多菌灵 三唑酮 戊唑醇 丙硫菌唑 氰烯菌酯 嘧菌酯 吡唑醚菌酯 代森锰锌 百菌清 甲基硫菌灵',
      wind_stop: 4, temp_min_hard: null, temp_min_ideal: 15, temp_max: 30, rain_free_h: 4,
      ids: ['nyt1276', 'hljuav', 'rainfast', 'cmadew', 'fao'],
      notes: [
        '保护性杀菌剂要在发病前/雨前形成药膜，喷后 4 小时内遇中雨以上需考虑补喷；内吸治疗型约 2 小时即可进入叶片，受降雨影响较小（农技科普，具体以标签为准）。',
        '高湿连阴雨本身是病害流行信号：小麦扬花期遇阴雨是赤霉病高风险，「见花打药」、雨前抢喷优先级高于等晴天。',
        '杀菌剂要求全株均匀覆盖，风大导致覆盖缺口等于留下侵染点；飞防 >4 m/s 应停止作业。',
        '本系统不判断病征与发病程度，只回答气象条件是否允许施药。'
      ]
    }
  };

  /* 只留一条合规底线：被明确提到时才触发，不占主场景、不进预设问题。
     这是安全拦截，不是用药建议。 */
  var BANNED = [
    {
      name: '百草枯', re: /百草枯|paraquat/i,
      brief: '百草枯在境内已无合法登记产品，任何天气条件下都不能施用。',
      detail: '农业农村部第 1745 号公告：百草枯水剂自 2016 年 7 月 1 日起停止销售使用；第 269 号公告：自 2020 年 11 月 1 日起禁止百草枯可溶胶剂在境内销售使用。',
      source: '农业农村部第 1745 号 / 第 269 号公告'
    },
    {
      name: '甲胺磷等五种高毒有机磷', re: /甲胺磷|对硫磷|甲基对硫磷|久效磷|磷胺/,
      brief: '甲胺磷、对硫磷、甲基对硫磷、久效磷、磷胺已全面禁止在农业上使用。',
      detail: '原农业部第 632 号公告：自 2007 年 1 月 1 日起全面禁止在农业上使用。',
      source: '原农业部第 632 号公告'
    }
  ];

  /* ==========================================================
     3. 专项话题：农户常问的「某一种天气现象」
     这些不是新知识条目，而是把同一套判定聚焦到一个问题上。
     ========================================================== */
  var TOPICS = {
    dew: { re: /露水|结露|叶面.*(湿|干)|露点|潮气|早上.*打/, name: '叶面干湿', ids: ['cmadew', 'mndnr', 'agvic'] },
    drift: { re: /飘移|漂移|飘到|吹到|邻田|下风向|顺风|风大|风这么大/, name: '飘移风险', ids: ['nyt1276', 'hljuav', 'fao', 'pirsabel'] },
    rain: { re: /打完.*雨|喷后.*雨|下雨.*(冲|洗|补喷|重喷)|耐雨|雨前|雨后/, name: '降雨与耐冲刷', ids: ['fao', 'rainfast', 'bayer', 'mndnr'] },
    cold: { re: /低温|降温|寒潮|寒流|霜冻|冷空|冻|温度.{0,4}低|气温.{0,4}低|冷/, name: '低温与寒潮', ids: ['hbweed', 'moa5c', 'moa8c', 'bayer'] },
    inversion: { re: /逆温|静风|无风|傍晚|清晨|早上能打|晚上能打|几点收工|日落/, name: '逆温与时段', ids: ['agvic', 'grdc', 'pirsabel', 'fao'] },
    heat: { re: /高温|中午|太阳|晒|30度|30℃|光解|蒸发/, name: '高温与蒸发', ids: ['cmadew', 'hljuav', 'fao', 'tsspray'] }
  };

  /* ==========================================================
     2b. 药剂档案：农户会直接说药名
     ----------------------------------------------------------
     为什么要有这一层：
       只按「除草剂」一个大类回答，遇到「草甘膦」这种具体药名就会
       答成通用结论，显得什么都不懂。药名在这里只用来
       （a）确认它属于哪一类、（b）补上这类药特有的天气敏感点
       与作物安全提示。仍然是「药已定」的前提，不推荐品种、不给剂量。
     字段：what=它是什么/怎么起作用；weather=天气敏感点；
           warn=按作物区分的风险提示（只提示风险，不替用户选药）。
     ========================================================== */
  var PRODUCTS = [
    {
      key: 'glyphosate', name: '草甘膦', group: 'herbicide', re: /草甘膦|农达|roundup/i,
      mode: '内吸 · 灭生性',
      what: '靠叶片吸收后随韧皮部向下传导，先伤根，见效慢但彻底；杂草必须正在生长才有效。',
      weather: '低温、重露、雨后叶面未干都会明显削弱吸收；耐雨冲刷约 6 小时（以标签为准）。',
      warn: { wheat: '灭生性药：不能喷到小麦叶片上，只用于播前灭茬或行间定向，全田喷雾会伤苗。' },
      ids: ['bayer', 'mndnr', 'fao', 'cmadew']
    },
    {
      key: 'glufosinate', name: '草铵膦', group: 'herbicide', re: /草铵膦|保试达|basta/i,
      mode: '触杀 · 灭生性',
      what: '触杀型，落药处才死，不向下传导；见效比草甘膦快，对多年生宿根效果弱。',
      weather: '靠雾滴覆盖起效，风大、雾滴粗都会漏喷；耐雨冲刷时间较短（约 4 小时，标签为准）。',
      warn: { wheat: '灭生性药：同样不能全田喷到麦苗，只做定向或播前灭茬。' },
      ids: ['bayer', 'fao']
    },
    {
      key: 'm24d', name: '2,4-D / 2甲4氯', group: 'herbicide', re: /2,?\s*4-?d|2\s*甲\s*4\s*氯|2\s*甲四氯|mcpa/i,
      mode: '激素型 · 内吸',
      what: '激素类，微量即可让阔叶杂草扭曲死亡，对禾本科杂草基本无效。',
      weather: '高温（约 28℃ 以上）挥发性与蒸气飘移明显；低温（8℃ 以下）杂草停止生长、效果差。',
      warn: { any: '激素类飘移风险最高的药之一：邻田有棉花、蔬菜、果树时，风速与缓冲区要按标签再收紧。' },
      ids: ['pirsabel', 'fao', 'hbweed']
    },
    {
      key: 'tribenuron', name: '苯磺隆', group: 'herbicide', re: /苯磺隆|巨星|tribenuron/i,
      mode: '磺酰脲 · 内吸',
      what: '内吸传导，主要防播娘蒿、荠菜等阔叶杂草，冬前或早春使用。',
      weather: '低温下吸收传导慢、见效迟，但仍属可施范围；干旱、低温叠加时效果明显打折。',
      warn: { any: '磺酰脲类残效长，后茬敏感作物（如某些蔬菜、豆类）要按标签留够间隔期。' },
      ids: ['hbweed', 'bayer']
    },
    {
      key: 'mesosulfuron', name: '甲基二磺隆', group: 'herbicide', re: /甲基二磺隆|世玛|mesosulfuron/i,
      mode: '磺酰脲 · 内吸',
      what: '专打节节麦、看麦娘等禾本科杂草，是冬前化除里对温度最敏感的一类。',
      weather: '低温、积水、霜冻前后药害风险高；施后遇强降温或大水漫灌容易黄苗。',
      warn: { wheat: '这类药对温度最挑：强降温前后 5 天、田间积水时不要用，麦苗弱时也要缓。' },
      ids: ['hbweed', 'moa8c', 'moa5c']
    },
    {
      key: 'florasulam', name: '双氟磺草胺', group: 'herbicide', re: /双氟磺草胺|麦喜|florasulam/i,
      mode: '内吸 · 阔叶',
      what: '内吸型阔叶除草剂，低温适应性相对较好，常与其它药复配。',
      weather: '低温下仍能起效，但低于 8℃ 整体化除口径仍按禁用处理；露水未干时吸收差。',
      warn: { any: '复配品种多，实际阈值以你手上那瓶的标签为准。' },
      ids: ['hbweed', 'bayer']
    },
    {
      key: 'fluroxypyr', name: '氯氟吡氧乙酸', group: 'herbicide', re: /氯氟吡氧乙酸|使它隆|fluroxypyr/i,
      mode: '激素类 · 内吸',
      what: '防猪殃殃、播娘蒿等阔叶杂草，内吸传导，低温下见效慢。',
      weather: '激素类，高温挥发与飘移风险高于一般除草剂；低温效果差但不造成硬性禁施。',
      warn: { any: '与 2,4-D 同属激素类，邻田敏感作物要看风向。' },
      ids: ['pirsabel', 'fao']
    },
    {
      key: 'carfentrazone', name: '唑草酮', group: 'herbicide', re: /唑草酮|carfentrazone|快灭灵/i,
      mode: '触杀 · 光活化',
      what: '触杀型，见光后产生活性，落药处迅速枯斑，对已出苗阔叶杂草见效快。',
      weather: '强光高温下药害与灼伤风险高，中午施药最不划算；低温阴天则见效慢。',
      warn: { any: '触杀型要求均匀覆盖，重喷、漏喷都会出问题。' },
      ids: ['hljuav', 'cmadew']
    },
    {
      key: 'clodinafop', name: '炔草酯', group: 'herbicide', re: /炔草酯|麦极|clodinafop/i,
      mode: 'ACCase · 内吸',
      what: '专防野燕麦、看麦娘等禾本科杂草，内吸传导，见效偏慢。',
      weather: '低温下吸收慢、药效迟；干旱时效果差，风速按除草剂口径从严。',
      warn: { any: '同一田块连年单用容易产生抗性，轮换用药请听当地植保站。' },
      ids: ['hbweed', 'hljuav']
    },
    {
      key: 'fenoxaprop', name: '精噁唑禾草灵', group: 'herbicide', re: /精噁唑禾草灵|骠马|fenoxaprop/i,
      mode: 'ACCase · 内吸',
      what: '防野燕麦等禾本科杂草，内吸型，低温与干旱都会拖慢见效。',
      weather: '低温下传导慢；喷后遇雨需按标签判断是否补喷。',
      warn: { any: '与阔叶除草剂混配前先看标签，不是所有组合都能混。' },
      ids: ['hbweed', 'rainfast']
    },
    {
      key: 'isoproturon', name: '异丙隆', group: 'herbicide', re: /异丙隆|isoproturon/i,
      mode: '土壤封闭 + 茎叶',
      what: '兼有封闭与茎叶活性，施后靠土壤湿度成膜，也杀已出苗杂草。',
      weather: '低温加积水是药害高发组合；施后遇寒潮、大雨容易伤苗。',
      warn: { wheat: '施后 3—5 天内有强降温或大雨时风险最高，宁可不打。' },
      ids: ['hbweed', 'moa5c']
    },
    {
      key: 'pyroxsulam', name: '啶磺草胺', group: 'herbicide', re: /啶磺草胺|优先|pyroxsulam/i,
      mode: '磺酰脲 · 内吸',
      what: '防看麦娘、雀麦等禾本科及部分阔叶杂草，内吸传导。',
      weather: '低温下见效慢；霜冻前后与积水田块药害风险升高。',
      warn: { any: '磺酰脲类残效与后茬安排要按标签执行。' },
      ids: ['hbweed']
    },
    {
      key: 'nicosulfuron', name: '烟嘧磺隆', group: 'herbicide', re: /烟嘧磺隆|玉农乐|nicosulfuron/i,
      mode: '磺酰脲 · 内吸（玉米）',
      what: '玉米苗后除草，主要在玉米 2—6 叶期使用，防禾本科与部分阔叶杂草。',
      weather: '气温高于约 35℃ 或低于 10℃ 时药害风险明显升高；干旱时效果差。',
      warn: { maize: '玉米苗后使用：前后 7 天不能碰有机磷杀虫剂，混用与时期都要看标签。' },
      ids: ['hljuav']
    },
    {
      key: 'atrazine', name: '莠去津', group: 'herbicide', re: /莠去津|阿特拉津|atrazine/i,
      mode: '土壤封闭 + 茎叶（玉米）',
      what: '玉米田主力除草剂，兼有封闭与苗后活性，常与烟嘧磺隆复配。',
      weather: '高温挥发与飘移风险高；施后大雨易淋溶，砂性土更要注意。',
      warn: { maize: '残效长，后茬种敏感作物要留间隔期；飘移到邻田阔叶作物会出药害。' },
      ids: ['pirsabel', 'fao']
    },
    {
      key: 'mesotrione', name: '硝磺草酮', group: 'herbicide', re: /硝磺草酮|mesotrione/i,
      mode: '触杀 + 内吸（玉米）',
      what: '玉米苗后早期用药，杂草白化后枯死，对阔叶杂草效果好。',
      weather: '苗后早期效果最好，草大后效果下降；强光高温下药害风险升高。',
      warn: { maize: '玉米 3—5 叶期最合适，错过时期效果明显变差。' },
      ids: ['hljuav', 'cmadew']
    },
    {
      key: 'imidacloprid', name: '吡虫啉', group: 'insecticide', re: /吡虫啉|imidacloprid/i,
      mode: '内吸 · 刺吸式口器',
      what: '内吸型杀虫剂，主要防蚜虫、飞虱等刺吸式害虫。',
      weather: '低温下害虫活动弱、传导也慢，药效偏慢但不属禁施；花期对蜜蜂风险高。',
      warn: { any: '作物开花期与蜂场附近要避开，具体按标签与当地通知。' },
      ids: ['hljuav', 'cmawind']
    },
    {
      key: 'lambda', name: '高效氯氟氰菊酯', group: 'insecticide', re: /高效氯氟氰菊酯|氯氟氰菊酯|功夫|lambda-?cyhalothrin/i,
      mode: '触杀 · 胃毒',
      what: '触杀为主，靠雾滴覆盖虫体，对蚜虫、黏虫等见效快。',
      weather: '低温下击倒变慢；风大时叶背与冠层内打不到，覆盖缺口就是漏防。',
      warn: { any: '对水生生物与蜜蜂高风险，靠近水源、花期要按标签避让。' },
      ids: ['hljuav', 'fao']
    },
    {
      key: 'tebuconazole', name: '戊唑醇', group: 'fungicide', re: /戊唑醇|tebuconazole/i,
      mode: '三唑类 · 内吸治疗',
      what: '内吸治疗型杀菌剂，对锈病、白粉病等有治疗与保护作用。',
      weather: '约 2 小时可进入叶片，喷后短时小雨影响相对小；但雨前成膜仍比雨后补救更稳。',
      warn: { any: '三唑类在高剂量、低温弱苗时有抑制生长风险，用量按标签。' },
      ids: ['rainfast', 'hljuav']
    },
    {
      key: 'prothioconazole', name: '丙硫菌唑', group: 'fungicide', re: /丙硫菌唑|prothioconazole/i,
      mode: '内吸治疗',
      what: '内吸型杀菌剂，小麦赤霉病、茎基腐病常用，常与戊唑醇复配。',
      weather: '赤霉病讲「见花打药」：扬花期遇连阴雨，雨前抢喷比等晴天更重要。',
      warn: { wheat: '扬花期是关键窗口，错过花后防效明显下降；具体时期听当地植保站。' },
      ids: ['rainfast', 'hljuav']
    },
    {
      key: 'phenamacril', name: '氰烯菌酯', group: 'fungicide', re: /氰烯菌酯|phenamacril/i,
      mode: '内吸 · 赤霉病',
      what: '专用于小麦赤霉病，内吸传导，扬花期是核心用药窗口。',
      weather: '见花打药、雨前抢喷；喷后 4 小时内遇中雨以上按标签考虑补喷。',
      warn: { wheat: '赤霉病防控窗口很短，宁可按预报提前半天，也别等雨后再打。' },
      ids: ['rainfast', 'fao']
    },
    {
      key: 'pyraclostrobin', name: '吡唑醚菌酯', group: 'fungicide', re: /吡唑醚菌酯|pyraclostrobin/i,
      mode: '甲氧基丙烯酸酯 · 保护 + 治疗',
      what: '保护与治疗兼备，靠叶面成膜阻止孢子萌发，兼有保健作用。',
      weather: '保护性为主，雨前成膜才有意义；喷后 4 小时内中雨以上要考虑补喷。',
      warn: { any: '同一作用机理连年单用易产生抗性，轮换按当地植保意见。' },
      ids: ['rainfast', 'fao']
    }
  ];

  /* 药剂类型识别：先看具体药名/类别词，再看口语 */
  var RE_HERB = new RegExp(TYPES.herbicide.tags.replace(/\s+/g, '|'));
  var RE_INSECT = new RegExp(TYPES.insecticide.tags.replace(/\s+/g, '|'));
  var RE_FUNG = new RegExp(TYPES.fungicide.tags.replace(/\s+/g, '|'));
  var RE_SWITCH = /换成|改成|换成打|如果是|要是打|假如打|打的是/;

  /* ----------------------------------------------------------
     时间范围解析：先认「哪一天」，再认「一周」，最后才是「现在」
     ----------------------------------------------------------
     这是之前答非所问的主因：只把日期词映射成 dayIdx，
     「那哪天能打？」没有日期词就继承上一轮的「明天」，
     于是问「哪天」却答「明天不能打」。
     现在把「时间范围」单独抽出来，范围词永远压过继承值。
     ---------------------------------------------------------- */
  var RE_WEEK = /哪天|哪一天|哪日|这周|本周|这个星期|这礼拜|一周|未来|接下来|下次|什么时候|啥时候|何时|几天/;
  var RE_NOW = /现在|此刻|这会儿|马上|立刻|当前/;
  var RE_FOLLOW = /^(那|那么|接着|再|然后|换|如果|要是|还有|另外|那要是)/;

  /** 问句里的目标日期 → 距今天数；没有明确日期返回 null */
  function dayIndexOf(s) {
    if (/大后天/.test(s)) return 3;
    if (/后天/.test(s)) return 2;
    if (/明天|明日|次日/.test(s)) return 1;
    if (/今天|今日|今晚|白天|上午|下午|傍晚/.test(s)) return 0;

    var m = /(下个?周|下个?星期|周|星期)([一二三四五六日天])/.exec(s);
    if (m) {
      var MAP = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 };
      var now = new Date(); now.setHours(0, 0, 0, 0);
      var diff = (MAP[m[2]] - now.getDay() + 7) % 7;
      if (/^下/.test(m[1])) diff += 7;
      return diff;
    }
    m = /(\d{1,2})\s*[月\/]\s*(\d{1,2})\s*[日号]?/.exec(s);
    if (m) {
      var now2 = new Date(); now2.setHours(0, 0, 0, 0);
      var y = now2.getFullYear();
      var dt = new Date(y, parseInt(m[1], 10) - 1, parseInt(m[2], 10));
      if (dt < now2) dt = new Date(y + 1, parseInt(m[1], 10) - 1, parseInt(m[2], 10));
      return Math.round((dt - now2) / 86400000);
    }
    return null;
  }

  /** 找问句里的具体药名（按档案顺序，长名优先由正则本身保证） */
  function findProduct(s) {
    for (var i = 0; i < PRODUCTS.length; i++) {
      if (PRODUCTS[i].re.test(s)) return PRODUCTS[i];
    }
    return null;
  }

  /** 取药剂对某作物的风险提示；作物不明时退回通用/小麦口径，宁可多提示 */
  function warnOf(p, crop) {
    if (!p || !p.warn) return '';
    return p.warn[crop] || p.warn.any || p.warn.wheat || p.warn.maize || '';
  }

  /**
   * 识别问句。
   * prev 是上一轮的 { type, product, dayIdx, scope, topic }，只用于「那呢」这类省略追问。
   * 返回 { kind, type, product, topic, word, dayIdx, scope, isFollow }
   *   scope: 'now' 现在 | 'day' 指定某天 | 'week' 未来一周
   */
  function match(q, prev) {
    var s = String(q || '');
    /* 省略追问才继承。若任何新问题都继承上一轮的药种，
       「我家小麦该打什么药？」这种本该拒答的选药问题会被误当成施药判定。 */
    var isFollow = RE_FOLLOW.test(s) ||
      /^(明天|后天|今天|那).*(呢|吗|\?|？)/.test(s) ||
      /^(呢|还有呢|然后呢)/.test(s);

    /* 1) 时间范围：范围词优先，其次日期词，最后才用「现在」兜底 */
    var di = dayIndexOf(s);
    var scope;
    if (di !== null) scope = 'day';
    else if (RE_WEEK.test(s)) { scope = 'week'; di = 0; }
    else if (RE_NOW.test(s)) { scope = 'now'; di = 0; }
    else if (isFollow && prev && prev.scope === 'week') { scope = 'week'; di = 0; }
    else if (isFollow && prev && prev.dayIdx) { scope = 'day'; di = prev.dayIdx; }
    else { scope = 'now'; di = 0; }
    if (scope === 'week') di = 0;

    var m = {
      kind: 'type', type: (isFollow && prev && prev.type) || 'generic',
      product: (isFollow && prev && prev.product) || null,
      topic: null, word: '', dayIdx: di, scope: scope, isFollow: isFollow
    };

    /* 2) 药种：具体药名 > 类别词 > 追问继承 */
    var prod = findProduct(s);
    var switchWord = RE_SWITCH.test(s) || (RE_FOLLOW.test(s) && /除草|杀虫|杀菌|防病/.test(s));
    if (prod) {
      m.product = prod;
      m.type = prod.group;
      m.word = prod.name;
    } else if (switchWord) {
      if (RE_HERB.test(s)) { m.type = 'herbicide'; m.word = '除草剂'; m.product = null; }
      else if (RE_INSECT.test(s)) { m.type = 'insecticide'; m.word = '杀虫剂'; m.product = null; }
      else if (RE_FUNG.test(s)) { m.type = 'fungicide'; m.word = '杀菌剂'; m.product = null; }
    } else if (RE_HERB.test(s)) { m.type = 'herbicide'; m.word = '除草剂'; m.product = null; }
    else if (RE_INSECT.test(s)) { m.type = 'insecticide'; m.word = '杀虫剂'; m.product = null; }
    else if (RE_FUNG.test(s)) { m.type = 'fungicide'; m.word = '杀菌剂'; m.product = null; }
    else if (!/什么药|啥药|用什么药|该打什么|推荐/.test(s) && prev &&
      prev.type && prev.type !== 'generic' &&
      (isFollow || (m.topic && /打药|喷药|施药|喷雾|用药/.test(s)))) {
      /* 「有露水能打药吗」这种省掉药种的追问，沿用上一轮药种；
         但「该打什么药」是在问选药，必须留给拒答层，不能继承。 */
      m.type = prev.type;
      m.product = prev.product || null;
    }
    /* 换类别没提药名时，上一轮的具体药名必须丢掉，否则会拿草甘膦去算杀虫剂 */
    if (prod === null && switchWord) m.product = null;

    /* 3) 话题（可与类型并存） */
    Object.keys(TOPICS).forEach(function (k) {
      if (TOPICS[k].re.test(s) && !m.topic) m.topic = k;
    });

    /* 4) 合规拦截：仅在明确提及时 */
    for (var i = 0; i < BANNED.length; i++) {
      if (BANNED[i].re.test(s)) { m.kind = 'banned'; m.banned = BANNED[i]; break; }
    }
    return m;
  }

  /* ==========================================================
     4. 数据辅助：只依赖 raw.hourly / result.days 的纯数据
     ========================================================== */
  function r1(x) { return Math.round(x * 10) / 10; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function num(x) { return (x === null || x === undefined || isNaN(x)) ? null : Number(x); }

  function hoursFor(raw, date) {
    if (!raw || !raw.hourly || !raw.hourly.time) return [];
    var H = raw.hourly, out = [];
    for (var i = 0; i < H.time.length; i++) {
      if (H.time[i].slice(0, 10) !== date) continue;
      out.push({
        hour: parseInt(H.time[i].slice(11, 13), 10),
        wind: num(H.wind_speed_10m && H.wind_speed_10m[i]),
        temp: num(H.temperature_2m && H.temperature_2m[i]),
        rain: num(H.precipitation && H.precipitation[i]),
        prob: num(H.precipitation_probability && H.precipitation_probability[i]),
        hum: num(H.relative_humidity_2m && H.relative_humidity_2m[i]),
        dew: num(H.dew_point_2m && H.dew_point_2m[i]),
        cloud: num(H.cloud_cover && H.cloud_cover[i]),
        dir: num(H.wind_direction_10m && H.wind_direction_10m[i])
      });
    }
    return out;
  }

  function fmtDate(date, dayIdx) {
    var d = new Date(date + 'T00:00:00');
    var now = new Date(); now.setHours(0, 0, 0, 0);
    var diff = Math.round((d - now) / 86400000);
    if (diff === 0) return '今天';
    if (diff === 1) return '明天';
    if (diff === 2) return '后天';
    return (d.getMonth() + 1) + '/' + d.getDate();
  }
  function fmtWin(w) { return pad2(w.start) + ':00–' + pad2(w.end) + ':00'; }
  /** 11/18 这种短日期：对话里比「周2」更容易和手机日历对上 */
  function mmdd(date) {
    var p = String(date || '').split('-');
    return p.length === 3 ? (Number(p[1]) + '/' + Number(p[2])) : String(date || '');
  }

  /** 属地通用底线 + 药剂专属更严条件，逐项取严 */
  function effectiveLimits(type, rules) {
    var t = TYPES[type] || TYPES.generic;
    var r = (rules && rules.spray) || {};
    return {
      type: t,
      wind_stop: Math.min(t.wind_stop, r.wind_max || t.wind_stop),
      wind_ideal_max: Math.min(3.3, r.wind_max || 3.3),
      wind_calm: 0.6,
      temp_min: Math.max(t.temp_min_hard === null || t.temp_min_hard === undefined ? -99 : t.temp_min_hard,
        r.temp_min === undefined ? -99 : r.temp_min),
      temp_ideal: t.temp_min_ideal,
      temp_max: Math.min(t.temp_max, r.temp_max || 99),
      dew_gap_min: r.dew_gap_min || 1.5,
      hum_max: r.hum_max || 92,
      hum_min: 40,
      prob_block: r.prob_block || 50,
      rain_hour_max: r.rain_hour_max === undefined ? 0.1 : r.rain_hour_max,
      hours: r.hours || [9, 16],
      sunset_margin_h: r.sunset_margin_h || 1.5,
      rain_free_h: t.rain_free_h,
      min_window_hours: r.min_window_hours || 2
    };
  }

  /* ==========================================================
     5. 逐项判定：每一项都带实测值、阈值与出处
     state: 'bad' 不可施 | 'warn' 可施但要注意 | 'ok' 通过
     ========================================================== */
  function item(name, state, text, ids) {
    return { name: name, state: state, text: text, ids: ids || [] };
  }

  function checkHour(type, h, ctx, lim) {
    var items = [];
    if (!h) return { items: [item('数据', 'warn', '这一小时没有逐时预报，暂不判定', [])], ok: false, worst: 'warn' };

    /* 夜间或清晨：哪怕风温都合适，也不在允许作业的时段内。
       没有这一条，晚上 20 点会误答「现在可以打药」。 */
    if (ctx.work && (h.hour < ctx.work[0] || h.hour >= ctx.work[1])) {
      items.push(item('时段', 'bad',
        pad2(h.hour) + ' 时不在作业时段 ' + pad2(ctx.work[0]) + '—' + pad2(ctx.work[1]) + ' 时内（省站口径 9—16 时，并按日落提前收工）',
        ['hbweed', 'moa8c', 'tsspray']));
    }

    /* 风：合规红线 5.4 → 药剂专属上限 → 理想区间 → 静风逆温 */
    if (h.wind !== null) {
      if (h.wind > 5.4) items.push(item('风', 'bad', h.wind + ' m/s 超 5.4 m/s（3 级风）与 ' + lim.wind_stop + ' m/s 的' + lim.type.short + '上限，NY/T 1276 明确不宜施药', ['nyt1276', 'hljuav']));
      else if (h.wind > lim.wind_stop) items.push(item('风', 'bad', h.wind + ' m/s 超 ' + lim.wind_stop + ' m/s（' + lim.type.short + '上限）', ['hljuav', 'cmawind']));
      else if (h.wind > lim.wind_ideal_max) items.push(item('风', 'warn', h.wind + ' m/s，需减飘（防飘罩 / 低位喷头 / 粗雾滴）', ['fao', 'pirsabel']));
      else if (h.wind < lim.wind_calm) items.push(item('风', 'warn', h.wind + ' m/s 近乎静风，警惕近地逆温使细雾滴远距离飘移', ['fao', 'agvic', 'grdc']));
      else items.push(item('风', 'ok', h.wind + ' m/s，在 ' + lim.wind_stop + ' m/s 上限内', ['nyt1276', 'hljuav']));
    }

    /* 温度 */
    if (h.temp !== null) {
      if (h.temp < lim.temp_min) items.push(item('温度', 'bad', h.temp + '℃ 低于 ' + lim.temp_min + '℃ 的硬下限' + (type === 'herbicide' ? '（冬前化除易生药害）' : ''), type === 'herbicide' ? ['hbweed', 'moa5c', 'bayer'] : ['hljuav']));
      else if (h.temp > lim.temp_max) items.push(item('温度', 'bad', h.temp + '℃ 高于 ' + lim.temp_max + '℃，雾滴蒸发快且易生药害', ['hljuav', 'cmadew', 'fao']));
      else if (lim.temp_ideal && h.temp < lim.temp_ideal) items.push(item('温度', 'warn', h.temp + '℃ 低于 ' + lim.temp_ideal + '℃ 适温下限，' + (type === 'insecticide' ? '害虫活动与内吸传导变慢、药效偏慢' : '吸收传导变慢') + '（不是禁施）', ['bayer', 'hljuav']));
      else if (h.temp < lim.temp_min + 2) items.push(item('温度', 'warn', h.temp + '℃ 贴近硬下限，药效偏慢', ['bayer']));
      else if (h.temp >= 28) items.push(item('温度', 'warn', h.temp + '℃ 偏高，避开 10—15 时强光、优先早晚', ['hljuav', 'tsspray']));
      else items.push(item('温度', 'ok', h.temp + '℃，在 ' + lim.temp_min + '–' + lim.temp_max + '℃ 内', ['hljuav']));
    }

    /* 叶面干湿：露点差 / 相对湿度 */
    var gap = (h.temp !== null && h.dew !== null) ? r1(h.temp - h.dew) : null;
    var wet = (gap !== null && gap <= lim.dew_gap_min) || (h.hum !== null && h.hum >= lim.hum_max);
    if (wet) {
      items.push(item('叶面', 'bad', '叶面结露/近饱和' + (gap !== null ? '（气温−露点 ' + gap + '℃ ≤ ' + lim.dew_gap_min + '℃）' : '') +
        (h.hum !== null ? '，湿度 ' + h.hum + '%' : '') + '，药液被稀释、易流失', ['cmadew', 'mndnr', 'agvic']));
    } else if (gap !== null && gap <= 3) {
      items.push(item('叶面', 'warn', '气温−露点 ' + gap + '℃，接近结露，宜再等叶面干透', ['cmadew']));
    } else {
      items.push(item('叶面', 'ok', gap !== null ? '气温−露点 ' + gap + '℃，叶面干燥' : '未见结露信号', ['cmadew']));
    }

    /* 空气湿度过低：蒸发 */
    if (h.hum !== null && h.hum > 0 && h.hum < lim.hum_min) {
      items.push(item('湿度', 'bad', '相对湿度 ' + h.hum + '% < 40%，雾滴蒸发萎缩、飘失增加', ['hljuav', 'fao', 'mndnr']));
    } else if (h.hum !== null && h.hum >= lim.hum_min && h.hum < 50) {
      items.push(item('湿度', 'warn', '相对湿度 ' + h.hum + '% 偏低，雾滴干燥偏快', ['fao']));
    }

    /* 当下降雨 / 降雨概率 */
    if ((h.rain !== null && h.rain > lim.rain_hour_max) || (h.prob !== null && h.prob >= lim.prob_block)) {
      items.push(item('降雨', 'bad', '本小时' + (h.rain > lim.rain_hour_max ? '有降水 ' + h.rain + ' mm' : '') +
        (h.prob !== null ? '降雨概率 ' + h.prob + '%' : '') + '，不宜施药', ['nyt1276', 'hbweed']));
    } else if (h.prob !== null && h.prob >= 30) {
      items.push(item('降雨', 'warn', '降雨概率 ' + h.prob + '%，需盯紧喷后窗口', ['fao']));
    }

    /* 喷后耐雨冲刷窗口：往后 N 小时不能有雨 */
    if (ctx.hours) {
      var ahead = ctx.hours.filter(function (x) { return x.hour > h.hour && x.hour <= h.hour + lim.rain_free_h; });
      var wash = ahead.filter(function (x) {
        return (x.rain !== null && x.rain > lim.rain_hour_max) || (x.prob !== null && x.prob >= lim.prob_block);
      });
      if (wash.length) {
        items.push(item('喷后 ' + lim.rain_free_h + ' h', 'bad',
          '喷后 ' + (wash[0].hour - h.hour) + ' 小时内有降雨/高概率，未达耐雨冲刷时间就被冲掉', ['fao', 'rainfast', 'bayer']));
      } else if (ahead.length) {
        items.push(item('喷后 ' + lim.rain_free_h + ' h', 'ok', '喷后 ' + lim.rain_free_h + ' 小时内无有效降雨', ['fao', 'rainfast']));
      }
    }

    /* 逆温时段：日出后 2h 内 / 日落前 1.5h 后 + 静风 + 有露或雾 */
    var sun = ctx.sun || {};
    var nearInversion = (sun.sunriseH !== null && sun.sunriseH !== undefined && h.hour < sun.sunriseH + 2) ||
      (sun.sunsetH !== null && sun.sunsetH !== undefined && h.hour >= sun.sunsetH - lim.sunset_margin_h);
    if (nearInversion && h.wind !== null && h.wind < 1.4) {
      items.push(item('逆温', 'warn',
        (sun.sunsetH !== null && h.hour >= sun.sunsetH - lim.sunset_margin_h ? '临近日落' : '日出后不足 2 小时') +
        '且风速 < 1.4 m/s，是逆温高发条件；雾滴可能悬空并横向远移', ['agvic', 'grdc', 'pirsabel']));
    }

    /* 强光时段 */
    if (h.hour >= 10 && h.hour < 15 && h.temp !== null && h.temp >= 28) {
      items.push(item('光照', 'warn', '10—15 时强光高温，蒸腾与雾滴蒸发加剧、部分药剂光解', ['hljuav', 'cmadew']));
    }

    var worst = 'ok';
    items.forEach(function (x) {
      if (x.state === 'bad') worst = 'bad';
      else if (x.state === 'warn' && worst !== 'bad') worst = 'warn';
    });
    return { items: items, ok: worst !== 'bad', worst: worst, gap: gap, wet: wet };
  }

  /** 日级检查：寒潮、日均温、当日降雨（只对除草剂收紧） */
  function dayChecks(type, day, ctx, lim) {
    var out = [];
    if (!day) return out;
    var mean = (day.tmax + day.tmin) / 2;
    if (type === 'herbicide') {
      if (day.tmin <= 2) out.push(item('低温药害', 'bad', '当日最低温 ' + day.tmin + '℃ ≤ 2℃，冬前茎叶化除易生药害', ['hbweed', 'moa5c']));
      else if (mean < lim.temp_min) out.push(item('日均温', 'bad', '以最高/最低温中值估算日均温约 ' + r1(mean) + '℃，低于 ' + lim.temp_min + '℃ 的化除要求', ['hbweed', 'moa8c']));
      else if (mean < lim.temp_min + 2) out.push(item('日均温', 'warn', '估算日均温约 ' + r1(mean) + '℃，贴近下限', ['hbweed']));
      else out.push(item('日均温', 'ok', '估算日均温约 ' + r1(mean) + '℃，满足 ≥' + lim.temp_min + '℃', ['hbweed']));

      var future = (ctx.result && ctx.result.days) ? ctx.result.days.slice(ctx.dayIdx, ctx.dayIdx + 6) : [];
      var drop = future.filter(function (d) { return d.tmin <= day.tmin - 5; });
      if (drop.length) out.push(item('寒潮', 'bad', '未来数日最低温将比今天低 5℃ 以上，属强降温前后 5 天禁施情形', ['hbweed', 'moa8c']));
      else out.push(item('寒潮', 'ok', '未来数日无明显强降温过程', ['hbweed']));
    }
    var dayRain = day.dayRain === undefined ? 0 : day.dayRain;
    if ((day.dayProb || 0) >= lim.prob_block || dayRain > 0) {
      out.push(item('当日降雨', 'bad', '当日雨量 ' + dayRain + ' mm / 降雨概率 ' + (day.dayProb || 0) + '%，雨日禁施', ['nyt1276', 'hbweed']));
    }
    return out;
  }

  function sunInfo(day) {
    /* evaluateWeather 已把 sunrise/sunset 解析成小数小时，直接复用；
       不要把 ISO 字符串当 "HH:MM" 解析。 */
    var a = day && day.sunriseH, b = day && day.sunsetH;
    return {
      sunriseH: (a === null || a === undefined || isNaN(a)) ? null : Number(a),
      sunsetH: (b === null || b === undefined || isNaN(b)) ? null : Number(b)
    };
  }

  /** 当日截止时刻：9—16 时，并按「日落前 1.5 小时」再收紧（逆温飘移） */
  function cutoffOf(day, lim) {
    var sun = sunInfo(day);
    var cutoff = lim.hours[1];
    if (sun.sunsetH !== null) {
      var c2 = Math.floor(sun.sunsetH - lim.sunset_margin_h);
      if (c2 >= lim.hours[0] + 2) cutoff = Math.min(lim.hours[1], c2);
    }
    return cutoff;
  }

  /** 找出该日所有连续可作业窗口 */
  function windowsOf(hours, ctx, lim, type, day) {
    var sun = sunInfo(day);
    var cutoff = cutoffOf(day, lim);
    var nw = ctx.now || new Date();
    var minH = ctx.dayIdx === 0 ? nw.getHours() : -1;
    var list = hours.filter(function (h) {
      return h.hour >= lim.hours[0] && h.hour < cutoff && h.hour >= minH;
    }).sort(function (a, b) { return a.hour - b.hour; });

    var wins = [], cur = null;
    list.forEach(function (h) {
      var c = checkHour(type, h, { hours: hours, sun: sun }, lim);
      if (c.ok) {
        if (!cur) cur = { start: h.hour, end: h.hour, winds: [], warn: [], items: c.items };
        else cur.end = h.hour;
        if (h.wind !== null) cur.winds.push(h.wind);
        c.items.forEach(function (x) { if (x.state === 'warn' && cur.warn.indexOf(x.name) < 0) cur.warn.push(x.name); });
      } else if (cur) { wins.push(cur); cur = null; }
    });
    if (cur) wins.push(cur);

    return wins.filter(function (w) { return (w.end - w.start + 1) >= lim.min_window_hours; })
      .map(function (w) {
        return {
          start: w.start, end: w.end + 1, hours: w.end - w.start + 1,
          avgWind: w.winds.length ? r1(w.winds.reduce(function (a, b) { return a + b; }, 0) / w.winds.length) : null,
          warn: w.warn, items: w.items
        };
      });
  }

  /** 主判定：先看「现在」，再给今天剩余窗口，最后找下一次窗口 */
  function evaluate(type, ctx) {
    type = TYPES[type] ? type : 'generic';
    var lim = effectiveLimits(type, ctx.rules);
    var result = ctx.result, raw = ctx.raw;
    var dayIdx = Math.max(0, Math.min((result.days || []).length - 1, ctx.dayIdx || 0));
    var day = result.days[dayIdx];
    if (!day) return null;

    var hours = hoursFor(raw, day.date);
    var sun = sunInfo(day);
    var cutoff = cutoffOf(day, lim);
    var now = ctx.now || new Date();
    var nowH = dayIdx === 0 ? now.getHours() : null;
    var nowHour = nowH !== null ? hours.filter(function (h) { return h.hour === nowH; })[0] : null;
    /* 逐时预报偶尔缺当前这一小时（尤其在整点刚过时）。
       以前这里直接放弃判定，于是「现在风大不大」「叶面干不干」都答不出来，
       只剩日级卡点，用户就会觉得答非所问。
       现在退到前后 3 小时内最接近的一小时，并在展开层注明是按哪一小时判的。 */
    var nowApprox = null;
    if (nowH !== null && !nowHour) {
      var near = hours.filter(function (h) { return h.wind !== null || h.temp !== null; });
      if (near.length) {
        var pick = near.reduce(function (a, b) {
          return Math.abs(b.hour - nowH) < Math.abs(a.hour - nowH) ? b : a;
        });
        if (Math.abs(pick.hour - nowH) <= 3) { nowHour = pick; nowApprox = pick.hour; }
      }
    }
    var nowCheck = nowH !== null && nowHour
      ? checkHour(type, nowHour, { hours: hours, sun: sun, work: [lim.hours[0], cutoff] }, lim)
      : null;
    if (nowCheck && nowApprox !== null && nowApprox !== nowH) {
      nowCheck.items.unshift(item('数据', 'warn',
        nowH + ' 时没有逐时预报，改用 ' + pad2(nowApprox) + ':00 的预报值判定（相差 ' +
        Math.abs(nowApprox - nowH) + ' 小时）', ['nyt1276']));
    }
    var dChecks = dayChecks(type, day, { result: result, dayIdx: dayIdx }, lim);
    var wins = windowsOf(hours, { dayIdx: dayIdx, now: now }, lim, type, day);

    /* 今天没有可用窗口时，往后找第一次出现的窗口 */
    var next = null;
    if (!wins.length && result.days) {
      for (var j = dayIdx + 1; j < result.days.length; j++) {
        var d2 = result.days[j], h2 = hoursFor(raw, d2.date);
        var w2 = windowsOf(h2, { dayIdx: 1, now: now }, lim, type, d2);
        if (w2.length) { next = { date: d2.date, label: fmtDate(d2.date, j), win: w2[0] }; break; }
      }
    }

    return {
      type: type, label: lim.type.label, short: lim.type.short, lim: lim,
      dayIdx: dayIdx, day: day, hours: hours, sun: sun,
      nowH: nowH, nowHour: nowHour, nowApprox: nowApprox, nowCheck: nowCheck,
      dayChecks: dChecks, windows: wins, next: next,
      dateLabel: fmtDate(day.date, dayIdx)
    };
  }

  /* ==========================================================
     5b. 未来一周：按药种逐日找窗口
     ----------------------------------------------------------
     「这周哪天能打」和「现在能不能打」是两个问题，
     以前共用一条 dayIdx=0 的路径，才会出现问「哪天」答「现在」。
     ========================================================== */
  function weekPlan(type, ctx) {
    var lim = effectiveLimits(type, ctx.rules);
    var now = ctx.now || new Date();
    var out = [];
    ((ctx.result && ctx.result.days) || []).forEach(function (d, i) {
      var hours = hoursFor(ctx.raw, d.date);
      var wins = windowsOf(hours, { dayIdx: i, now: now }, lim, type, d);
      out.push({ idx: i, date: d.date, day: d, windows: wins });
    });
    return out;
  }

  /** 某天为什么没窗口：取第一条「不可施」的日级或逐时原因 */
  function whyNot(type, ctx, row) {
    var lim = effectiveLimits(type, ctx.rules);
    var sun = sunInfo(row.day);
    var checks = dayChecks(type, row.day, { result: ctx.result, dayIdx: row.idx }, lim);
    var bad = checks.filter(function (x) { return x.state === 'bad'; })[0];
    if (bad) return clip(bad.text);
    var hours = hoursFor(ctx.raw, row.date);
    var inWin = hours.filter(function (h) { return h.hour >= lim.hours[0] && h.hour < cutoffOf(row.day, lim); });
    var nights = 0, winds = 0, dews = 0, rains = 0;
    inWin.forEach(function (h) {
      var c = checkHour(type, h, { hours: hours, sun: sun, work: [lim.hours[0], cutoffOf(row.day, lim)] }, lim);
      if (!c.ok) {
        if (c.items.some(function (x) { return x.name === '风' && x.state === 'bad'; })) winds++;
        else if (c.items.some(function (x) { return x.name === '叶面' && x.state === 'bad'; })) dews++;
        else if (c.items.some(function (x) { return x.name === '降雨' && x.state === 'bad'; })) rains++;
        else nights++;
      }
    });
    if (!inWin.length) return '缺少逐时预报';
    var top = [[winds, '风速超上限'], [dews, '叶面结露'], [rains, '有降雨'], [nights, '气温/湿度不达标']]
      .sort(function (a, b) { return b[0] - a[0]; })[0];
    return top[1] + '（' + top[0] + ' 个小时）';
  }

  /* ==========================================================
     5c. 专项话题：用户问的是「露水 / 飘移 / 雨」，就先答这一项
     ----------------------------------------------------------
     以前不管问什么，结论行永远是「现在不能打药 + 当日降雨」，
     用户问「有露水能打吗」却听到降雨，自然觉得驴唇不对马嘴。
     ========================================================== */
  var FOCUS_NAMES = {
    dew: ['叶面'], drift: ['风', '逆温'], rain: ['降雨', '喷后'],
    cold: ['温度', '低温药害', '日均温'], inversion: ['逆温', '时段'], heat: ['温度', '光照']
  };

  function focusAt(type, h, ev, topic) {
    if (!h) return null;
    var lim = ev.lim;
    var c = checkHour(type, h, { hours: ev.hours, sun: ev.sun, work: [lim.hours[0], cutoffOf(ev.day, lim)] }, lim);
    var keys = FOCUS_NAMES[topic] || [];
    var hits = c.items.filter(function (x) {
      return keys.some(function (k) { return x.name.indexOf(k) === 0; });
    });
    if (!hits.length) return null;
    var bad = hits.filter(function (x) { return x.state === 'bad'; })[0];
    var warn = hits.filter(function (x) { return x.state === 'warn'; })[0];
    var ok = hits.filter(function (x) { return x.state === 'ok'; })[0];
    return { item: bad || warn || ok, bad: !!bad, warn: !!warn, hour: h };
  }

  function topicAnswer(type, ctx, topic) {
    var ev = evaluate(type, ctx);
    if (!ev) return null;
    var lim = ev.lim, short = ev.lim.type.short;
    var cut = cutoffOf(ev.day, lim);
    var head, tail;
    /* 问未来某天时没有「此刻」，就用那天作业时段的第一个小时做探针，
       仍然是逐时预报算出来的，不是拍脑袋。 */
    var firstWork = ev.hours.filter(function (h) {
      return h.hour >= lim.hours[0] && h.hour < cut;
    })[0] || null;
    var cur = ev.nowHour || firstWork;
    var whenTxt = ev.dayIdx === 0 ? '现在' : (ev.dateLabel + ' ' + (cur ? pad2(cur.hour) + ':00' : ''));
    var closed = ev.nowH !== null && ev.nowH >= cut;

    function winLine() {
      if (closed) {
        return '今天已收工（' + pad2(cut) + ':00）；' +
          (ev.next ? '下一次 ' + ev.next.label + ' ' + fmtWin(ev.next.win) + '。' : '后面几天暂无可作业窗口。');
      }
      if (ev.windows.length) {
        return '可作业 ' + ev.windows.map(fmtWin).join('、') + '。';
      }
      if (ev.next) return '下一次窗口 ' + ev.next.label + ' ' + fmtWin(ev.next.win) + '。';
      return '后续 7 天没有连续达标时段。';
    }
    function firstFix(keyNames) {
      var sun = ev.sun;
      for (var i = 0; i < ev.hours.length; i++) {
        var h = ev.hours[i];
        if (h.hour < lim.hours[0] || h.hour >= cut) continue;
        if (ev.nowH !== null && h.hour <= ev.nowH) continue;
        var c = checkHour(type, h, { hours: ev.hours, sun: sun, work: [lim.hours[0], cut] }, lim);
        var bad = c.items.some(function (x) {
          return keyNames.some(function (k) { return x.name.indexOf(k) === 0; }) && x.state === 'bad';
        });
        if (!bad && c.ok) return h.hour;
      }
      return null;
    }

    if (topic === 'dew') {
      if (!cur || cur.temp === null || cur.dew === null) {
        head = '露水：' + (ev.dayIdx === 0 ? '这一小时' : ev.dateLabel) + '没有温湿预报，算不出叶面干湿。';
      } else {
        var gap = r1(cur.temp - cur.dew);
        var wet = gap <= lim.dew_gap_min || (cur.hum !== null && cur.hum >= lim.hum_max);
        if (wet) {
          var fix = firstFix(['叶面']);
          head = '露水：' + whenTxt + '叶面结露（气温−露点 ' + gap + '℃，湿度 ' + cur.hum + '%），露水没干不能打。';
          tail = fix !== null
            ? ('约 ' + pad2(fix) + ':00 后叶面干透；' + winLine())
            : winLine();
        } else {
          head = '露水：' + whenTxt + '叶面是干的（气温−露点 ' + gap + '℃），露水这一项不拦。';
          tail = winLine();
        }
      }
    } else if (topic === 'drift') {
      var f = focusAt(type, cur, ev, 'drift');
      if (!cur || cur.wind === null) {
        head = '飘移：' + (ev.dayIdx === 0 ? '这一小时' : ev.dateLabel) + '没有风速预报，算不出飘移风险。';
      } else {
        var over = cur.wind > lim.wind_stop;
        var dir = cur.dir === null || cur.dir === undefined ? null : compass(cur.dir);
        head = '飘移：' + whenTxt + ' ' + cur.wind + ' m/s，' + (over
          ? '已超 ' + lim.wind_stop + ' m/s 上限，不能打'
          : '在上限 ' + lim.wind_stop + ' m/s 内，风险可控') +
          (dir ? '；风来自' + dir + '，雾滴飘向' + compass(cur.dir + 180) : '') + '。';
        if (over) {
          var fixW = firstFix(['风', '逆温']);
          tail = fixW !== null
            ? ('约 ' + pad2(fixW) + ':00 后风速回落；' + winLine())
            : winLine();
        } else {
          tail = '下风向若有邻田敏感作物、果园或蜂场，仍要留缓冲区；' + winLine();
        }
      }
      if (f && f.warn && !f.bad) tail += '（' + clip(f.item.text, 28) + '）';
    } else if (topic === 'rain') {
      var ahead = (ev.hours || []).filter(function (h) {
        return ev.nowH !== null && h.hour > ev.nowH && h.hour <= ev.nowH + lim.rain_free_h;
      });
      var wetAhead = ahead.filter(function (h) {
        return (h.rain !== null && h.rain > lim.rain_hour_max) || (h.prob !== null && h.prob >= lim.prob_block);
      });
      if (ev.dayIdx !== 0) {
        var dw = ev.windows[0];
        head = '喷后遇雨：' + ev.dateLabel + (dw
          ? ('的 ' + fmtWin(dw) + ' 喷后 ' + lim.rain_free_h + ' 小时内没有有效降雨。')
          : '没有能喷的窗口，谈不到喷后遇雨。');
      } else if (!ahead.length) {
        head = '喷后遇雨：今天剩下的逐时预报不够，判不出 ' + lim.rain_free_h + ' 小时窗口。';
      } else if (wetAhead.length) {
        head = '喷后遇雨：' + pad2(wetAhead[0].hour) + ':00 前后有雨（概率 ' + wetAhead[0].prob + '%），' +
          '达不到 ' + short + ' 要的 ' + lim.rain_free_h + ' 小时无雨。';
      } else {
        head = '喷后遇雨：从现在到 ' + pad2(ev.nowH + lim.rain_free_h) + ':00 没有有效降雨，' +
          short + '的 ' + lim.rain_free_h + ' 小时吸收窗口够。';
      }
      tail = winLine();
    } else if (topic === 'cold') {
      var mean = r1((ev.day.tmax + ev.day.tmin) / 2);
      var coldBad = ev.dayChecks.filter(function (x) {
        return (x.name === '低温药害' || x.name === '日均温') && x.state === 'bad';
      })[0];
      head = '低温：' + ev.dateLabel + '最低 ' + ev.day.tmin + '℃、日均约 ' + mean + '℃，' +
        (coldBad ? '低于' + short + ' ' + lim.temp_min + '℃ 的化除要求，不能打。' : '在可施范围内。');
      tail = winLine() + (type === 'herbicide' ? '强降温前后 5 天不打。' : '');
    } else if (topic === 'inversion') {
      head = '逆温：' + ev.dateLabel + '日落 ' + hm(ev.sun.sunsetH) + '，按日落前 ' + lim.sunset_margin_h +
        ' 小时收工，实际 ' + pad2(cut) + ':00 就得停' +
        (closed ? '（现在已经过了）' : '') + '。';
      tail = '清晨日出后约 2 小时、风起升温再开工；' + winLine();
    } else {
      /* heat */
      var t = cur && cur.temp !== null ? cur.temp : null;
      head = '高温：' + whenTxt + (t !== null ? ' ' + t + '℃，' : '最高 ' + ev.day.tmax + '℃，') +
        (t !== null && t > lim.temp_max ? '超过 ' + lim.temp_max + '℃ 上限，中午打药易药害。'
          : '在 ' + lim.temp_max + '℃ 上限内，但要避开 10—15 时强光。');
      tail = winLine();
    }

    return {
      brief: head + '\n' + tail,
      ev: ev
    };
  }

  /** 「明天和后天哪天更好」按当前药种比，而不是一律用通用口径 */
  function compareDays(type, ctx, idxs) {
    var lim = effectiveLimits(type, ctx.rules);
    var now = ctx.now || new Date();
    var rows = [];
    idxs.forEach(function (i) {
      var d = ctx.result.days[i];
      if (!d) return;
      var wins = windowsOf(hoursFor(ctx.raw, d.date), { dayIdx: i, now: now }, lim, type, d);
      rows.push({ i: i, day: d, wins: wins });
    });
    if (!rows.length) return null;
    var lines = rows.map(function (r) {
      var w = r.wins.slice().sort(function (a, b) { return b.hours - a.hours; })[0];
      return r.day.dow + '：' + (w
        ? ('可作业 ' + fmtWin(w) + '（' + w.hours + ' 小时，均风 ' + w.avgWind + ' m/s）')
        : ('不打：' + whyNot(type, ctx, r)));
    });
    var withWin = rows.filter(function (r) { return r.wins.length; });
    var verdict;
    if (!withWin.length) verdict = '两天都不合适，等下一轮天气过程。';
    else {
      var best = withWin.sort(function (a, b) {
        var ha = Math.max.apply(null, a.wins.map(function (w) { return w.hours; }));
        var hb = Math.max.apply(null, b.wins.map(function (w) { return w.hours; }));
        return hb - ha;
      })[0];
      verdict = '优先选' + best.day.dow + '，窗口更长。';
    }
    return {
      brief: rows[0].day.dow + '与' + rows[rows.length - 1].day.dow + '比：' + verdict + '\n' + lines.join('；') + '。',
      lines: lines, verdict: verdict, type: type
    };
  }

  /* ==========================================================
     6. 作答：brief 只有两行；detail 才展开逐项判定与依据
     ========================================================== */
  function shortBlocker(ev) {
    var bad = [];
    if (ev.nowCheck) ev.nowCheck.items.forEach(function (x) {
      if (x.state === 'bad') bad.push(x.name + '：' + clip(x.text, 34));
    });
    ev.dayChecks.forEach(function (x) {
      if (x.state === 'bad') bad.push(x.name + '：' + clip(x.text, 34));
    });
    return bad.slice(0, 2);
  }

  /* 截断到第一个逗号，再按字数收口：结论行只用最硬的那个数 */
  function clip(t, max) {
    var s = String(t || '').split('，')[0];
    max = max || 34;
    return s.length > max ? s.slice(0, max - 2) + '…' : s;
  }

  function stateMark(s) { return s === 'bad' ? '×' : (s === 'warn' ? '!' : '√'); }

  var COMPASS = ['北', '东北偏北', '东北', '东北偏东', '东', '东南偏东', '东南', '东南偏南',
    '南', '西南偏南', '西南', '西南偏西', '西', '西北偏西', '西北', '西北偏北'];
  function compass(d) { return COMPASS[Math.round((((d % 360) + 360) % 360) / 22.5) % 16]; }
  function hm(h) {
    if (h === null || h === undefined || isNaN(h)) return '—';
    return pad2(Math.floor(h)) + ':' + pad2(Math.round((h % 1) * 60));
  }

  /**
   * 展开层分四段，而不是把十几份依据全文一次摊开：
   *   ① 为什么这么判（默认可见，看得到理由）
   *   ② 逐项判定（折叠：数字明细，想核对才点开）
   *   ③ 这类药还要注意（折叠：药剂档案）
   *   ④ 依据与边界（折叠：只列编号，原文在「我的 → 施药依据库」）
   */
  function sectionsOf(ev, m, extra) {
    var t = ev.lim.type;
    var prod = m && m.product;
    var S = [];

    var why = [];
    if (m && m.scope === 'week' && extra && extra.plan) {
      extra.plan.forEach(function (r) {
        var w = r.windows.slice().sort(function (a, b) { return b.hours - a.hours; })[0];
        why.push((w ? '√ ' : '× ') + r.day.dow + ' ' + mmdd(r.date) + '：' +
          (w ? ('可作业 ' + fmtWin(w) + '，' + w.hours + ' 小时，均风 ' + w.avgWind + ' m/s')
            : ('不打，' + whyNot(ev.type, extra.ctx, r))));
      });
    } else {
      ev.dayChecks.forEach(function (x) {
        if (x.state !== 'ok') why.push(stateMark(x.state) + ' ' + x.name + '：' + x.text);
      });
      if (ev.nowCheck) {
        ev.nowCheck.items.forEach(function (x) {
          if (x.state === 'bad') why.push('× ' + x.name + '：' + x.text);
        });
      }
      if (!why.length) {
        why.push(ev.windows.length
          ? '√ ' + ev.dateLabel + '可作业 ' + ev.windows.map(fmtWin).join('、') + '，风速、气温、叶面干湿都在阈值内'
          : '× ' + ev.dateLabel + '没有连续达标时段');
      }
    }
    S.push({ title: '为什么这么判', body: why.join('\n') });

    var items = [];
    if (ev.nowCheck) {
      ev.nowCheck.items.forEach(function (x) { items.push(stateMark(x.state) + ' ' + x.name + '：' + x.text); });
    } else {
      items.push('（问的是未来某天，没有「此刻」判定）');
    }
    items.push(ev.windows.length
      ? '√ 可作业窗口 ' + ev.windows.map(fmtWin).join('、')
      : (ev.nowCheck ? '× 今天到收工前没有连续达标的时段' : '× 当日无满足条件的连续作业窗口'));
    S.push({
      title: '逐项判定 · ' + ev.dateLabel +
        (ev.nowHour ? ' ' + pad2(ev.nowHour.hour) + ' 时' : (ev.nowH !== null ? ' ' + pad2(ev.nowH) + ' 时' : '')),
      body: items.join('\n')
    });

    if (prod) {
      S.push({
        title: prod.name + ' · ' + prod.mode,
        body: [prod.what, prod.weather,
          warnOf(prod, extra && extra.crop)
        ].filter(Boolean).join('\n')
      });
    }
    S.push({
      title: t.short + '还要多看几条',
      body: t.notes.map(function (n, i) { return (i + 1) + '. ' + n; }).join('\n')
    });

    /* 风向这类问题，光给通用条文没用，要给这块地此刻的方向与时刻 */
    if (m && m.topic === 'drift' && ev.nowHour && ev.nowHour.dir !== null &&
      ev.nowHour.dir !== undefined && ev.nowHour.wind !== null) {
      S.push({
        title: '此刻雾滴往哪飘',
        body: '风来自 ' + compass(ev.nowHour.dir) + '（' + Math.round(ev.nowHour.dir) + '°），' +
          ev.nowHour.wind + ' m/s；雾滴会飘向 ' + compass(ev.nowHour.dir + 180) + '。' +
          '先确认这个方向有没有邻田敏感作物、果园、蜂场或水源；顺风喷施会把药液带向作业者。'
      });
    }

    /* 依据只留编号与结论，不再把十几份全文和 URL 铺在对话里 */
    var used = {};
    if (ev.nowCheck) ev.nowCheck.items.forEach(function (x) { x.ids.forEach(function (i) { used[i] = 1; }); });
    ev.dayChecks.forEach(function (x) { x.ids.forEach(function (i) { used[i] = 1; }); });
    (t.ids || []).forEach(function (i) { used[i] = 1; });
    if (prod) (prod.ids || []).forEach(function (i) { used[i] = 1; });
    if (m && m.topic && TOPICS[m.topic]) TOPICS[m.topic].ids.forEach(function (i) { used[i] = 1; });
    used.nyt1276 = 1;
    var codes = SOURCES.filter(function (s) { return used[s.id]; }).map(function (s) { return s.code; });
    S.push({
      title: '依据与边界（' + codes.length + ' 份）',
      body: '依据 ' + codes.length + ' 份：' + codes.slice(0, 4).join('；') +
        (codes.length > 4 ? ' 等' : '') +
        '\n查证日期 ' + CHECKED + '；口径不一致时按属地标准与本药剂条件取严。原文链接在「我的 → 施药依据库」。' +
        '\n【边界】药剂是你已经定好的输入，我只算此刻的气象条件能不能施；不诊断苗情与病虫、不推荐药剂、不给剂量与混配。具体以农药登记标签和当地植保站意见为准。'
    });

    return S;
  }

  function detailText(S) {
    return S.map(function (s) { return '【' + s.title + '】\n' + s.body; }).join('\n\n');
  }

  function answer(m, ctx) {
    if (m.kind === 'banned') {
      var bS = [{
        title: '依据',
        body: m.banned.detail + '\n【边界】这是合规拦截，不是用药建议。合法替代品种请按当地植保站意见与农药登记标签确定；本系统可继续帮你算「哪天几点适合喷雾作业」。'
      }];
      return {
        brief: m.banned.brief,
        detail: detailText(bS),
        sections: bS,
        source: m.banned.source, type: 'banned', scope: 'now', dayIdx: 0
      };
    }

    var type = TYPES[m.type] ? m.type : 'generic';
    var prod = m.product || null;
    var now = ctx.now || new Date();
    var baseCtx = { result: ctx.result, raw: ctx.raw, rules: ctx.rules, now: now };
    var shortName = TYPES[type].short;
    var modeTail = prod ? String(prod.mode || '').split('·').pop().trim() : '';
    var label = prod ? (shortName + '（' + prod.name + (modeTail ? '·' + modeTail : '') + '）') : shortName;

    if (!ctx.result || !ctx.result.days || !ctx.result.days.length) {
      return {
        brief: '天气数据还没加载好，暂时算不了这块地的施药条件。',
        detail: '联网后我会按逐时风速、气温、露点差与降雨概率逐项判定，并给出可作业时段与依据。',
        sections: [],
        source: '本地规则引擎', type: type, scope: m.scope, dayIdx: 0
      };
    }

    /* ---------- 一、问的是「这周哪天」：给窗口清单，不是「现在不能打」 ---------- */
    if (m.scope === 'week') {
      var plan = weekPlan(type, baseCtx);
      var days = plan.filter(function (p) { return p.windows.length; });
      var brief, evD, S;
      if (!days.length) {
        var freq = {};
        plan.forEach(function (p) {
          var r = whyNot(type, baseCtx, p);
          freq[r] = (freq[r] || 0) + 1;
        });
        var top = Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a]; }).slice(0, 2);
        brief = label + ' · 未来 7 天没有可打的窗口。\n' +
          (top.length ? top.join('；') + '。' : '逐时条件都不达标。');
        evD = evaluate(type, Object.assign({}, baseCtx, { dayIdx: 0 }));
      } else {
        var first = days[0];
        var w0 = first.windows.slice().sort(function (a, b) { return b.hours - a.hours; })[0];
        var others = days.slice(1).map(function (d) { return mmdd(d.date); }).slice(0, 3);
        brief = label + ' · 未来 7 天有 ' + days.length + ' 天能打。\n' +
          '最早 ' + mmdd(first.date) + ' ' + first.day.dow + ' ' + fmtWin(w0) +
          '（' + w0.hours + ' 小时，均风 ' + w0.avgWind + ' m/s）' +
          (others.length ? '；还有 ' + others.join('、') : '') + '。';
        evD = evaluate(type, Object.assign({}, baseCtx, { dayIdx: first.idx }));
      }
      if (!evD) return null;
      evD.plotName = (ctx.plot && ctx.plot.name) || '';
      S = sectionsOf(evD, m, { plan: plan, ctx: baseCtx, crop: ctx.plot && ctx.plot.crop });
      return {
        brief: brief,
        detail: detailText(S),
        sections: S,
        source: '实时逐时天气 + 属地标准 + 药剂阈值（本地离线）',
        type: type, product: prod ? prod.key : null,
        scope: 'week', dayIdx: 0,
        plan: plan, evaluate: evD
      };
    }

    /* ---------- 二、专项话题：先答用户问的那个现象 ---------- */
    var dayIdx = Math.max(0, Math.min(ctx.result.days.length - 1, m.dayIdx || 0));
    var ev = evaluate(type, Object.assign({}, baseCtx, { dayIdx: dayIdx }));
    if (!ev) return null;
    ev.plotName = (ctx.plot && ctx.plot.name) || '';

    var brief2;
    if (m.topic && TOPICS[m.topic]) {
      var ta = topicAnswer(type, Object.assign({}, baseCtx, { dayIdx: dayIdx }), m.topic);
      brief2 = ta ? ta.brief : null;
    }

    /* ---------- 三、指定某天 / 现在 ---------- */
    if (!brief2) {
      var blockers = shortBlocker(ev);
      var canNow = ev.nowCheck ? ev.nowCheck.ok : ev.windows.length > 0;
      var when = ev.dayIdx === 0 ? '现在' : ev.dateLabel;
      var head;
      if (ev.dayIdx === 0 && !ev.nowCheck) {
        head = label + ' · 这一小时没有逐时预报，只能先给今天的窗口。';
      } else {
        head = label + ' · ' + when + (canNow ? '可以打' : '不能打') + '。';
      }
      var why, line2;
      /* 首屏只放一条最硬的理由：两条并列会把第二行挤成三行，
         其余卡点在展开层的「为什么这么判」里逐条列。 */
      if (blockers.length) why = blockers[0];
      else if (canNow) why = '风速、气温、叶面干湿都在范围内';
      else why = '当日整体条件不达标，展开看逐项判定';
      if (ev.windows.length) {
        line2 = '可作业时段 ' + ev.windows.map(fmtWin).join('、') + '（' +
          (ev.windows[0].avgWind !== null ? '平均风速 ' + ev.windows[0].avgWind + ' m/s' : '按逐时判定') + '）。';
      } else if (ev.next) {
        line2 = '下一次窗口 ' + ev.next.label + ' ' + fmtWin(ev.next.win) + '。';
      } else {
        line2 = '后续预报里没有满足条件的连续窗口。';
      }
      /* 首答恒为两行：结论 + 卡点/下一步。未来日期没有卡点时不再硬塞
         「整体条件不达标」，直接给窗口。 */
      var showWhy = blockers.length > 0 || canNow;
      brief2 = head + '\n' + (showWhy ? why + '；' : '') + line2;
    }

    var S2 = sectionsOf(ev, m, { crop: ctx.plot && ctx.plot.crop, ctx: baseCtx });
    return {
      brief: brief2,
      detail: detailText(S2),
      sections: S2,
      source: '实时逐时天气 + 属地标准 + 药剂阈值（本地离线）',
      type: type, product: prod ? prod.key : null,
      scope: m.scope, dayIdx: ev.dayIdx,
      evaluate: ev
    };
  }

  root.TianZhiChem = {
    CHECKED: CHECKED,
    SOURCES: SOURCES,
    TYPES: TYPES,
    TOPICS: TOPICS,
    BANNED: BANNED,
    PRODUCTS: PRODUCTS,
    match: match,
    answer: answer,
    warnOf: warnOf,
    evaluate: evaluate,
    weekPlan: weekPlan,
    topicAnswer: topicAnswer,
    compareDays: compareDays,
    whyNot: whyNot,
    dayIndexOf: dayIndexOf,
    findProduct: findProduct,
    effectiveLimits: effectiveLimits,
    hoursFor: hoursFor,
    checkHour: checkHour,
    cite: cite
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
