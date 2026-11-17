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

  /* 药剂类型识别：先看具体药名/类别词，再看口语 */
  var RE_HERB = new RegExp(TYPES.herbicide.tags.replace(/\s+/g, '|'));
  var RE_INSECT = new RegExp(TYPES.insecticide.tags.replace(/\s+/g, '|'));
  var RE_FUNG = new RegExp(TYPES.fungicide.tags.replace(/\s+/g, '|'));
  var RE_SWITCH = /换成|改成|换成打|如果是|要是打|假如打|打的是/;

  /**
   * 识别问句。prev 是上一轮的 { type, dayIdx }，用于「那明天呢」这类追问。
   * 返回 { kind, type, topic, word, dayIdx }
   */
  function match(q, prev) {
    var s = String(q || '');
    /* 上下文继承只用于追问。若任何新问题都继承上一轮的药种，
       「我家小麦该打什么药？」这种本该拒答的选药问题会被误当成施药判定。 */
    var isFollow = /^(那|接着|再|然后|换|如果|要是)/.test(s) ||
      /^(明天|后天|今天).*(呢|吗|\?|？)/.test(s);
    var m = {
      kind: 'type', type: (isFollow && prev && prev.type) || 'generic',
      topic: null, word: '', dayIdx: 0
    };

    /* 追问里的日期 */
    if (/后天/.test(s)) m.dayIdx = 2;
    else if (/明天|次日/.test(s)) m.dayIdx = 1;
    else if (/今天|现在|这会儿|此刻/.test(s)) m.dayIdx = 0;
    else if (prev && /^(那|接着|再|然后|换|如果|要是)/.test(s)) m.dayIdx = prev.dayIdx;

    /* 追问里换药种 */
    if (RE_SWITCH.test(s) || (/^(那|接着|再|然后)/.test(s) && /除草|杀虫|杀菌|防病/.test(s))) {
      if (RE_HERB.test(s)) { m.type = 'herbicide'; m.word = '除草剂'; }
      else if (RE_INSECT.test(s)) { m.type = 'insecticide'; m.word = '杀虫剂'; }
      else if (RE_FUNG.test(s)) { m.type = 'fungicide'; m.word = '杀菌剂'; }
    } else if (RE_HERB.test(s)) { m.type = 'herbicide'; m.word = '除草剂'; }
    else if (RE_INSECT.test(s)) { m.type = 'insecticide'; m.word = '杀虫剂'; }
    else if (RE_FUNG.test(s)) { m.type = 'fungicide'; m.word = '杀菌剂'; }
    else if (isFollow && prev && prev.type && prev.type !== 'generic') {
      m.type = prev.type;
    }

    /* 话题（可与类型并存） */
    Object.keys(TOPICS).forEach(function (k) {
      if (TOPICS[k].re.test(s) && !m.topic) m.topic = k;
    });

    /* 合规拦截：仅在明确提及时 */
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
    var nowCheck = nowH !== null
      ? checkHour(type, nowHour, { hours: hours, sun: sun, work: [lim.hours[0], cutoff] }, lim)
      : null;
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
      nowH: nowH, nowHour: nowHour, nowCheck: nowCheck,
      dayChecks: dChecks, windows: wins, next: next,
      dateLabel: fmtDate(day.date, dayIdx)
    };
  }

  /* ==========================================================
     6. 作答：brief 只有两行；detail 才展开逐项判定与依据
     ========================================================== */
  function shortBlocker(ev) {
    var bad = [];
    function clip(t) {
      var s = String(t || '').split('，')[0];
      return s.length > 34 ? s.slice(0, 32) + '…' : s;
    }
    if (ev.nowCheck) ev.nowCheck.items.forEach(function (x) {
      if (x.state === 'bad') bad.push(x.name + '：' + clip(x.text));
    });
    ev.dayChecks.forEach(function (x) {
      if (x.state === 'bad') bad.push(x.name + '：' + clip(x.text));
    });
    return bad.slice(0, 2);
  }

  function stateMark(s) { return s === 'bad' ? '×' : (s === 'warn' ? '!' : '√'); }

  var COMPASS = ['北', '东北偏北', '东北', '东北偏东', '东', '东南偏东', '东南', '东南偏南',
    '南', '西南偏南', '西南', '西南偏西', '西', '西北偏西', '西北', '西北偏北'];
  function compass(d) { return COMPASS[Math.round((((d % 360) + 360) % 360) / 22.5) % 16]; }
  function hm(h) {
    if (h === null || h === undefined || isNaN(h)) return '—';
    return pad2(Math.floor(h)) + ':' + pad2(Math.round((h % 1) * 60));
  }

  function detailOf(ev, topic) {
    var L = [];
    var t = ev.lim.type;
    var head = '【' + t.label + ' · ' + ev.dateLabel +
      (ev.nowH !== null ? ' ' + pad2(ev.nowH) + ' 时' : '') +
      (ev.plotName ? ' · ' + ev.plotName : '') + '】';
    L.push(head);
    if (t.key === 'generic') {
      L.push('未指定药种：先按通用喷雾底线判定。除草剂对风速与低温更严、杀菌剂更看雨前时机，点下方「换成除草剂 / 杀虫剂」即可按该类药重算。');
    }

    if (ev.nowCheck) {
      L.push('— 此刻逐项判定 —');
      ev.nowCheck.items.forEach(function (x) { L.push(stateMark(x.state) + ' ' + x.name + '：' + x.text); });
    } else {
      L.push('— 当日逐时判定 —');
      ev.windows.length
        ? L.push('√ 可作业窗口 ' + ev.windows.map(fmtWin).join('、'))
        : L.push('× 当日无满足条件的连续作业窗口');
    }
    if (ev.dayChecks.length) {
      L.push('— 当日 / 未来数日 —');
      ev.dayChecks.forEach(function (x) { L.push(stateMark(x.state) + ' ' + x.name + '：' + x.text); });
    }

    /* 风向/逆温这类问题，光给通用条文没用，要给这块地此刻的方向与时刻 */
    if (topic === 'drift' && ev.nowHour && ev.nowHour.dir !== null &&
      ev.nowHour.dir !== undefined && ev.nowHour.wind !== null) {
      L.push('', '— 此刻雾滴往哪飘 —');
      L.push('风来自 ' + compass(ev.nowHour.dir) + '（' + Math.round(ev.nowHour.dir) + '°），' +
        ev.nowHour.wind + ' m/s；雾滴会飘向 ' + compass(ev.nowHour.dir + 180) + '。' +
        '先确认这个方向有没有邻田敏感作物、果园、蜂场或水源；顺风喷施会把药液带向作业者。');
    }
    if (topic === 'inversion' && ev.sun.sunsetH !== null) {
      L.push('', '— 逆温时段 —');
      L.push('日出 ' + hm(ev.sun.sunriseH) + '、日落 ' + hm(ev.sun.sunsetH) +
        '；日落前 ' + ev.lim.sunset_margin_h + ' 小时起停止喷雾，日出后约 2 小时且风起、升温后再开工。');
    }

    L.push('', '【' + t.short + '还要多看几条】');
    t.notes.forEach(function (n, i) { L.push((i + 1) + '. ' + n); });

    var used = {};
    if (ev.nowCheck) ev.nowCheck.items.forEach(function (x) { x.ids.forEach(function (i) { used[i] = 1; }); });
    ev.dayChecks.forEach(function (x) { x.ids.forEach(function (i) { used[i] = 1; }); });
    (t.ids || []).forEach(function (i) { used[i] = 1; });
    if (topic && TOPICS[topic]) TOPICS[topic].ids.forEach(function (i) { used[i] = 1; });
    ['nyt1276'].forEach(function (i) { used[i] = 1; });

    L.push('', '【依据文件 · 本地离线可核对】');
    SOURCES.forEach(function (s, i) {
      if (!used[s.id]) return;
      L.push('[' + s.code + '] ' + s.issuer + ' · ' + s.clause);
      L.push('    ' + s.point);
      if (s.url) L.push('    ' + s.url);
    });
    L.push('', '查证日期 ' + CHECKED + '。不同文件口径不一致时，按属地标准与本药剂专属条件取严。');
    L.push('【边界】药剂是你已经定好的输入，我只算此刻的气象条件能不能施；不诊断苗情与病虫、不推荐药剂、不给剂量与混配。具体以农药登记标签和当地植保站意见为准。');
    return L.join('\n');
  }

  function answer(m, ctx) {
    if (m.kind === 'banned') {
      return {
        brief: m.banned.brief,
        detail: m.banned.detail + '\n\n【边界】这是合规拦截，不是用药建议。合法替代品种请按当地植保站意见与农药登记标签确定；本系统可继续帮你算「哪天几点适合喷雾作业」。',
        source: m.banned.source, type: 'banned'
      };
    }

    var type = TYPES[m.type] ? m.type : 'generic';
    var ev = evaluate(type, {
      result: ctx.result, raw: ctx.raw, rules: ctx.rules,
      dayIdx: m.dayIdx || 0, now: ctx.now || new Date()
    });
    if (!ev) {
      return {
        brief: '天气数据还没加载好，暂时算不了这块地的施药条件。',
        detail: '联网后我会按逐时风速、气温、露点差与降雨概率逐项判定，并给出可作业时段与依据。',
        source: '本地规则引擎', type: type
      };
    }
    ev.plotName = ctx.plot && (ctx.plot.name || '') || '';

    /* 结论先行：最多两行，最多两个数字 */
    /* 专项话题：先把用户真正问的那个现象摆到结论里，再补其他卡点 */
    var blockers = shortBlocker(ev);
    if (m.topic && TOPICS[m.topic] && ev.nowCheck) {
      var FOCUS = {
        dew: ['叶面'], drift: ['风', '逆温'], rain: ['喷后', '降雨'],
        cold: ['温度'], inversion: ['逆温', '时段'], heat: ['温度', '光照']
      };
      var keys = FOCUS[m.topic] || [];
      var hit = ev.nowCheck.items.filter(function (x) {
        return keys.some(function (k) { return x.name.indexOf(k) === 0; });
      })[0];
      if (hit) {
        /* 同一项不要既当话题结论又当卡点重复出现 */
        blockers = blockers.filter(function (b) { return b.indexOf(hit.name + '：') !== 0; });
        var ft = hit.state === 'ok' ? hit.text : hit.text.split('，')[0];
        if (ft.length > 44) ft = ft.slice(0, 42) + '…';
        blockers.unshift(hit.name + '：' + ft);
      }
      blockers = blockers.slice(0, 2);
    }
    var canNow = ev.nowCheck ? ev.nowCheck.ok : (ev.windows.length > 0);
    var when = ev.dayIdx === 0 ? '现在' : ev.dateLabel;
    var head = type === 'generic'
      ? when + (canNow ? '可以打药' : '不能打药') + '。'
      : ev.lim.type.short + ' · ' + when + (canNow ? '可以打' : '不能打') + '。';
    var why = blockers.length ? blockers.join('；')
      : (canNow ? '当前风速、温度、叶面干湿都在范围内' : '当日整体条件不达标，展开看逐项判定');
    var line2;
    if (ev.windows.length) {
      line2 = '可作业时段 ' + ev.windows.map(fmtWin).join('、') + '（' +
        (ev.windows[0].avgWind !== null ? '平均风速 ' + ev.windows[0].avgWind + ' m/s' : '按逐时判定') + '）。';
    } else if (ev.next) {
      line2 = '下一次窗口 ' + ev.next.label + ' ' + fmtWin(ev.next.win) + '。';
    } else {
      line2 = '后续预报里没有满足条件的连续窗口。';
    }
    if (m.topic && TOPICS[m.topic]) line2 += '（重点看了' + TOPICS[m.topic].name + '）';

    /* 首答恒为两行：第一行结论，第二行卡点/依据值 + 下一步。
       药种未指定等引导语放到展开层与推荐追问里，不占首屏。
       未来日期没有「此刻」判定、也没有卡点时，不要再塞一句含糊的
       「整体条件不达标」，直接给窗口结论。 */
    var showWhy = blockers.length > 0 || canNow;
    var brief = head + '\n' + (showWhy ? why + '；' : '') + line2;

    return {
      brief: brief,
      detail: detailOf(ev, m.topic),
      source: '实时逐时天气 + 属地标准 + 药剂专属阈值（' + SOURCES.length + ' 份依据，本地离线）',
      type: type,
      dayIdx: ev.dayIdx,
      evaluate: ev
    };
  }

  root.TianZhiChem = {
    CHECKED: CHECKED,
    SOURCES: SOURCES,
    TYPES: TYPES,
    TOPICS: TOPICS,
    BANNED: BANNED,
    match: match,
    answer: answer,
    evaluate: evaluate,
    effectiveLimits: effectiveLimits,
    hoursFor: hoursFor,
    checkHour: checkHour,
    cite: cite
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
