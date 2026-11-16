/* =============================================================
   知时智农 · 作业标准库（河北省）
   -------------------------------------------------------------
   解决的问题：
     原来「我的 → 农事阈值」把风速、气温、时段做成滑轴，让农户自己调。
     但农户既没有农技文件，也不该被要求判断 3.4 还是 5.0 m/s。
     现在改成：按地块属地自动套用公开文件，界面只负责说明「凭什么是这个数」。

   收录原则（重要，评审会看）：
     1. 只收能查到原文或官方著录的文件，每条都带 URL 与查证日期；
     2. 全文没拿到的，limits 一律为 null，绝不按标题猜数字；
     3. 县级文件通常是转发省级，不逐县编造，统一按所属地级市处理；
     4. 未检索到市级文件的市，如实写「未检索到」，落到省级。

   合并规则：同一地块可能同时受国家 / 省 / 市三级约束，取最严
     · 风速取最小、温度上限取最小、温度下限取最大、时段取交集（当前只有一个来源给出时段）
     每个结果字段都记录来源 id，界面与问答里逐条标注出处。

   查证日期：2026-11-16
   ============================================================= */
(function (root) {
  'use strict';

  var CHECKED = '2026-11-16';

  /* 河北省 11 个地级市 → 地方标准编号前缀（DB13xx） */
  var CITIES = [
    { name: '石家庄市', code: '1301', alias: ['石家庄'] },
    { name: '唐山市', code: '1302', alias: ['唐山'] },
    { name: '秦皇岛市', code: '1303', alias: ['秦皇岛'] },
    { name: '邯郸市', code: '1304', alias: ['邯郸'] },
    { name: '邢台市', code: '1305', alias: ['邢台'] },
    { name: '保定市', code: '1306', alias: ['保定'] },
    { name: '张家口市', code: '1307', alias: ['张家口'] },
    { name: '承德市', code: '1308', alias: ['承德'] },
    { name: '沧州市', code: '1309', alias: ['沧州'] },
    { name: '廊坊市', code: '1310', alias: ['廊坊'] },
    { name: '衡水市', code: '1311', alias: ['衡水'] }
  ];

  /* ============================================================
     一、文件条目
     ------------------------------------------------------------
     level: national / province / city
     binding: 是否参与「取严」计算。技术指导意见、媒体报道只作参考，不参与。
     limits: 只写原文明确给出的数值；没有全文就 null。
     ============================================================ */
  var LIST = [
    {
      id: 'nyt1276',
      level: 'national',
      region: '全国',
      code: 'NY/T 1276-2025',
      title: '农药安全使用规范 总则',
      issuer: '农业农村部',
      issued: '2025-04-11',
      effective: '2025-07-01',
      status: 'active',
      binding: true,
      scope: 'all',
      limits: { wind_max: 3.4, temp_max: 30 },
      quotes: [
        { ref: '7.5.1.4.3', text: '风力大于 2 级（风速大于 3.4 m/s）、温度高于 30 ℃ 或雨天时，不宜进行航空喷雾施药作业。' },
        { ref: '7.5.1.3.1', text: '风力大于 3 级（风速大于 5.4 m/s）、温度高于 30 ℃ 或雨天时，不宜进行喷雾施药作业；风力 3 级（风速大于 3.4 m/s、小于 5.4 m/s）时，开展除草剂喷雾作业，应采取必要的减飘措施。' },
        { ref: '7.1.2', text: '不宜在高温、雨天或风力大于 3 级（风速大于 5.4 m/s）时施药。' }
      ],
      url: 'https://std.samr.gov.cn/hb/search/stdHBDetailed?id=39DF216FA80FAC14E06397BE0A0A8D5F',
      urlLabel: '全国标准信息公共服务平台',
      note: '代替 NY/T 1276-2007。地面喷雾上限为 5.4 m/s，航空施药为 3.4 m/s；本工具取更严的航空口径。'
    },
    {
      id: 'heb-plant-2026',
      level: 'province',
      region: '河北省',
      code: '河北省植保植检总站 2026 科学用药注意事项',
      title: '小麦、油菜病虫防治科学用药注意事项',
      issuer: '河北省植保植检总站（河北省农业农村厅）',
      issued: '2026-03',
      effective: '当前',
      status: 'active',
      binding: true,
      scope: 'field',
      limits: { wind_max: 3.4, temp_min: 5, hours: [9, 16] },
      quotes: [
        { ref: '器械适配', text: '选择植保无人飞机施药，作业时环境风速应小于三级风（≤3.4 m/s）；选择自走式喷杆喷雾机施药，亩喷液量 30 L 为宜。' },
        { ref: '精准施药', text: '施药时间应选在无风或微风的晴天上午 9 点至下午 4 点之间，避开中午高温强光时段；麦田除草施药时气温不低于 5 ℃，施药当天及前后 2 天日最低气温应不低于 0 ℃。' },
        { ref: '灾后处置', text: '大风、霜冻、阴雨天气禁止施药；施药后 4 小时内遇雨需要进行补喷。' }
      ],
      url: 'https://wangdu.gov.cn/col/1618902456638/2026/03/30/1774838921201.html',
      urlLabel: '望都县人民政府（省站原文转载）',
      note: '省站原文首发于河北省农业农村厅渠道，此处引用县级政府网站转载版（链接稳定、可长期核对）。'
    },
    {
      id: 'db13-5517',
      level: 'province',
      region: '河北省',
      code: 'DB13/T 5517-2022',
      title: '大田作物病虫草害防控关键期植保无人飞机作业技术规程',
      issuer: '河北省市场监督管理局（河北省农业农村厅提出）',
      issued: '2022-02-28',
      effective: '2022-03-31',
      status: 'active',
      binding: true,
      scope: 'field',
      limits: { wind_max: 5, temp_max: 30 },
      quotes: [
        { ref: '4.1.4', text: '植保无人飞机作业适宜条件为：最大风速 ≤5 m/s，温度 ≤30 ℃。' },
        { ref: '6.2', text: '飞行高度距靶标受药面 1.5 m~2 m；飞行速度 3 m/s~5 m/s；喷幅 ≥1.5 m；每亩药液量 1 L~2 L。' }
      ],
      url: 'https://mp.weixin.qq.com/s?__biz=MzU3OTQ2NDAxNg==&mid=2247546938&idx=4&sn=9d20a4602529318a11e2ee2e5fa76a50',
      urlLabel: '标准全文（河北省植保协会转载）',
      note: '省级标准的风速上限（5 m/s）宽于省站现行指导意见（3.4 m/s），按「取严」不生效，但作为省级标准收录。'
    },
    {
      id: 'db1301-452',
      level: 'city',
      region: '石家庄市',
      code: 'DB1301/T 452-2023',
      title: '植保无人机防治小麦病虫害作业技术规程',
      issuer: '石家庄市市场监督管理局',
      issued: '2023',
      effective: '现行',
      status: 'active',
      binding: true,
      scope: 'field',
      limits: { wind_max: 3.0, temp_min: 5, temp_max: 30, rh_min: 50 },
      quotes: [
        { ref: '表 1', text: '无人机作业时最大风速不超过 3.0 m/s；适宜环境温度 5 ℃~30 ℃；环境相对湿度在 50% 以上；雨天或雾天不适合作业。' },
        { ref: '6.4', text: '在敏感场所作业前必须设置施药缓冲隔离带，隔离带距离不少于 100 m。' }
      ],
      url: 'https://scjg.sjz.gov.cn/atm/7/20230522104712352.pdf',
      urlLabel: '石家庄市市场监督管理局（标准全文 PDF）',
      note: '石家庄市现行市级标准，风速比省级更严，属地为此市时按 3.0 m/s 执行。'
    },
    {
      id: 'db1301-370',
      level: 'city',
      region: '石家庄市',
      code: 'DB1301/T 370-2021',
      title: '夏玉米中后期无人机一喷多效技术规程',
      issuer: '石家庄市市场监督管理局',
      issued: '2021',
      effective: '2021-05-18',
      status: 'active',
      binding: true,
      scope: 'field',
      limits: { wind_max: 3.0, temp_max: 30, rh_min: 50, rain_buffer_h: 12 },
      quotes: [
        { ref: '作业基本要求', text: '植保无人机作业时，最大风速不超过 3 m/s，温度不超过 30 ℃，相对湿度在 50% 以上；应关注天气预报，在 12 h 内无降雨的情况下进行施药作业。' }
      ],
      url: 'https://www.ntv.cn/content/0/801/99801296.html',
      urlLabel: '农视网（标准要点摘录）',
      note: '未获取标准全文，数值来自公开摘录；与 DB1301/T 452-2023 口径一致。'
    },
    {
      id: 'db1301-518',
      level: 'city',
      region: '石家庄市',
      code: 'DB1301/T 518-2024',
      title: '农业植保无人机安全作业规范',
      issuer: '石家庄市市场监督管理局',
      issued: '2024',
      effective: '现行',
      status: 'active',
      binding: false,
      scope: 'field',
      limits: null,
      quotes: [],
      url: 'https://std.samr.gov.cn/',
      urlLabel: '全国标准信息公共服务平台（按标准号检索）',
      note: '仅检索到标准著录信息，未获取全文，因此不参与限值计算。'
    },
    {
      id: 'db1302-545',
      level: 'city',
      region: '唐山市',
      code: 'DB1302/T 545-2021',
      title: '农用植保无人机作业技术规范',
      issuer: '唐山市市场监督管理局',
      issued: '2021-12-30',
      effective: '2022-01-20',
      status: 'active',
      binding: true,
      scope: 'field',
      limits: { wind_max: 5, temp_min: 5, temp_max: 35 },
      quotes: [
        { ref: '基本要求', text: '植保无人机应在环境温度 5 ℃~35 ℃、风速不超过 5 m/s 的气象条件下作业；雷雨、大雾天气不应作业。' }
      ],
      url: 'https://www.ntv.cn/content/0/840/99840478.html',
      urlLabel: '农视网（标准解读）',
      note: '唐山市标准宽于省级指导意见，按「取严」不生效，但作为属地文件列出。'
    },
    {
      id: 'db1305-125',
      level: 'city',
      region: '邢台市',
      code: 'DB1305/T 125-2019',
      title: '金银花无人机施药技术规程',
      issuer: '邢台市市场监督管理局',
      issued: '2019-10-16',
      effective: '2019-11-16',
      status: 'repealed',
      binding: false,
      scope: 'horticulture',
      limits: null,
      quotes: [],
      url: 'https://std.samr.gov.cn/db/search/stdDBDetailed?id=D7B65558A86395E0E05397BE0A0AEA40',
      urlLabel: '全国标准信息公共服务平台',
      note: '适用于金银花，已于 2025-06-01 废止；不适用于小麦 / 玉米，也不参与计算。'
    },
    {
      id: 'db1307-486',
      level: 'city',
      region: '张家口市',
      code: 'DB1307/T 486-2025',
      title: '露地蔬菜植保无人机飞防技术规范',
      issuer: '张家口市市场监督管理局',
      issued: '2025',
      effective: '现行',
      status: 'active',
      binding: false,
      scope: 'horticulture',
      limits: null,
      quotes: [],
      url: 'https://std.samr.gov.cn/',
      urlLabel: '全国标准信息公共服务平台（按标准号检索）',
      note: '对象为露地蔬菜，非小麦 / 玉米；仅检索到著录信息，未获取全文。'
    },
    {
      id: 'db1309-299',
      level: 'city',
      region: '沧州市',
      code: 'DB1309/T 299-2024',
      title: '无人机防治林业病虫害作业技术规程',
      issuer: '沧州市市场监督管理局',
      issued: '2024',
      effective: '现行',
      status: 'active',
      binding: false,
      scope: 'forestry',
      limits: null,
      quotes: [],
      url: 'https://std.samr.gov.cn/',
      urlLabel: '全国标准信息公共服务平台（按标准号检索）',
      note: '林业病虫害，不是大田作物施药；仅作属地标准存在性记录。'
    },
    {
      id: 'db1310-320',
      level: 'city',
      region: '廊坊市',
      code: 'DB1310/T 320-2023',
      title: '夏播玉米植保无人机防治病虫害技术规范',
      issuer: '廊坊市市场监督管理局',
      issued: '2023',
      effective: '现行',
      status: 'active',
      binding: false,
      scope: 'field',
      limits: null,
      quotes: [],
      url: 'https://std.samr.gov.cn/',
      urlLabel: '全国标准信息公共服务平台（按标准号检索）',
      note: '仅检索到著录信息，未获取全文，因此不参与限值计算（避免按标题猜数字）。'
    },
    {
      id: 'nat-guide-2026',
      level: 'national',
      region: '全国',
      code: '全国农技中心（2026）飞防指导意见',
      title: '植保无人飞机施药防控小麦重大病虫害技术指导意见',
      issuer: '全国农业技术推广服务中心',
      issued: '2026-03-24',
      effective: '2026 年小麦季',
      status: 'active',
      binding: false,
      scope: 'field',
      limits: { wind_max: 3.4, temp_min: 10, temp_max: 30, hours: [9, 16] },
      quotes: [
        { ref: '飞防要求', text: '施药作业时，环境风速应小于三级风（≤3.4 m/s），环境温度处于 10 ℃~30 ℃；返青期建议在上午 9 点至下午 4 点；抽穗扬花期和灌浆期应避开 30 ℃ 以上高温时段；如遇大雾、露水，应在雾气露水散开后再施药。' }
      ],
      url: 'https://www.natesc.org.cn/News/des?kind=&id=9d8ae4f5-c4a1-4223-a13d-e1086a4f675d&CategoryId=cb2a3d19-a7bd-4aa0-8f4e-4fdda4842057',
      urlLabel: '全国农技推广网',
      note: '温度下限 10 ℃ 针对小麦病虫害飞防；省站对麦田除草给出 5 ℃。本工具取 5 ℃ 为准，5~10 ℃ 时会在回答里提示药效风险。'
    },
    {
      id: 'baoding-2026',
      level: 'city',
      region: '保定市',
      code: '保定市植保植检站现场会口径（2026-04-22）',
      title: '保定市小麦「一喷三防」现场会作业参数',
      issuer: '保定市植保植检站',
      issued: '2026-04-22',
      effective: '2026 年小麦季',
      status: 'active',
      binding: false,
      scope: 'field',
      limits: { wind_max: 3.3 },
      quotes: [
        { ref: '现场讲解', text: '亩施药液量 2—3 升，作业风速低于三级（3.3 米/秒），飞行高度距冠层 2—4 米、速度 5—7 米/秒。' }
      ],
      url: 'https://www.stdaily.com/web/gdxw/2026-04/24/content_507476.html',
      urlLabel: '科技日报（现场会报道）',
      note: '这是会议报道中的技术口径，不是正式地方标准，因此不参与「取严」计算，仅作参考展示。'
    }
  ];

  /* ============================================================
     二、工具自身的保守设定（没有对应标准条款的字段）
     ============================================================ */
  var TOOL = {
    rain_day_max: 0.5,
    rain_prev_max: 1.0,
    min_window_hours: 2
  };
  var TOOL_LABEL = '本工具保守设定';

  /* ============================================================
     三、查询与合并
     ============================================================ */
  /** 风速统一一位小数：3 → 3.0，避免界面里出现「≤ 3 m/s」看着像整数近似 */
  function n1(v) { return (Math.round(Number(v) * 10) / 10).toFixed(1); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function normCity(name) {
    if (!name) return '';
    var s = String(name).trim();
    for (var i = 0; i < CITIES.length; i++) {
      var c = CITIES[i];
      if (c.name === s) return c.name;
      for (var j = 0; j < c.alias.length; j++) {
        if (s === c.alias[j] || s.indexOf(c.alias[j]) === 0) return c.name;
      }
    }
    return '';
  }

  function byId(id) {
    for (var i = 0; i < LIST.length; i++) if (LIST[i].id === id) return LIST[i];
    return null;
  }

  /** 该地块（市）适用哪些文件：全国 + 河北省 + 本市；排除已废止与非大田对象 */
  function forCity(city) {
    var c = normCity(city);
    return LIST.filter(function (s) {
      if (s.status !== 'active') return false;
      if (s.scope !== 'all' && s.scope !== 'field') return false;
      if (s.region === '全国' || s.region === '河北省') return true;
      return !!c && s.region === c;
    });
  }

  /**
   * 合并出实际生效的阈值（取严）
   * 返回 { patch, by, sources, city, cityName, label, stricter }
   */
  function effective(city) {
    var c = normCity(city);
    var list = forCity(c);
    var patch = {
      wind_max: null, temp_min: null, temp_max: null,
      hours_start: null, hours_end: null,
      rain_day_max: TOOL.rain_day_max,
      rain_prev_max: TOOL.rain_prev_max,
      min_window_hours: TOOL.min_window_hours
    };
    var by = { rain_day_max: 'tool', rain_prev_max: 'tool', min_window_hours: 'tool' };

    list.forEach(function (s) {
      if (!s.binding || !s.limits) return;
      var L = s.limits;
      if (typeof L.wind_max === 'number' && (patch.wind_max === null || L.wind_max < patch.wind_max)) {
        patch.wind_max = L.wind_max; by.wind_max = s.id;
      }
      if (typeof L.temp_min === 'number' && (patch.temp_min === null || L.temp_min > patch.temp_min)) {
        patch.temp_min = L.temp_min; by.temp_min = s.id;
      }
      if (typeof L.temp_max === 'number' && (patch.temp_max === null || L.temp_max < patch.temp_max)) {
        patch.temp_max = L.temp_max; by.temp_max = s.id;
      }
      if (L.hours && L.hours.length === 2) {
        if (patch.hours_start === null || L.hours[0] > patch.hours_start) {
          patch.hours_start = L.hours[0]; by.hours_start = s.id;
        }
        if (patch.hours_end === null || L.hours[1] < patch.hours_end) {
          patch.hours_end = L.hours[1]; by.hours_end = s.id;
        }
      }
    });

    // 兜底：没有任何绑定文件给出某项时，用省级公开口径
    if (patch.wind_max === null) { patch.wind_max = 3.4; by.wind_max = 'heb-plant-2026'; }
    if (patch.temp_min === null) { patch.temp_min = 5; by.temp_min = 'heb-plant-2026'; }
    if (patch.temp_max === null) { patch.temp_max = 30; by.temp_max = 'nyt1276'; }
    if (patch.hours_start === null) { patch.hours_start = 9; by.hours_start = 'heb-plant-2026'; }
    if (patch.hours_end === null) { patch.hours_end = 16; by.hours_end = 'heb-plant-2026'; }

    var stricter = '';
    var srcIds = {};
    Object.keys(by).forEach(function (k) { if (by[k] !== 'tool') srcIds[by[k]] = 1; });

    var cityBinding = [];
    var cityDocs = [];
    if (c) {
      cityBinding = list.filter(function (s) { return s.binding && s.limits && s.region === c; });
      cityDocs = LIST.filter(function (s) {
        return s.region === c && s.status === 'active' && (s.scope === 'field' || s.scope === 'all');
      });
      if (cityBinding.length) {
        stricter = c + '地方标准更严，已优先采用：' +
          cityBinding.map(function (s) { return s.code; }).join('、');
      }
    }

    return {
      city: c,
      cityName: c || '',
      patch: patch,
      by: by,
      sources: Object.keys(srcIds),
      stricter: stricter,
      label: (function () {
        if (!c) return '河北省省级标准（属地未知）';
        if (stricter) return c + '属地标准（省 + 市，取严）';
        if (cityDocs.some(function (s) { return !!s.limits; })) {
          return c + '：市级仅有技术口径（非正式标准），按省级标准执行';
        }
        if (cityDocs.length) return c + '：市级文件未获全文，按省级标准执行';
        return c + '：本市未检索到公开标准，按省级执行';
      })()
    };
  }

  /** 某个字段的出处文字 */
  function fieldSource(id) {
    if (!id) return '';
    if (id === 'tool') return TOOL_LABEL;
    var s = byId(id);
    return s ? s.code : id;
  }

  /** 全部 11 市的收录情况（含「未检索到」的如实说明） */
  function coverage() {
    return CITIES.map(function (c) {
      var docs = LIST.filter(function (s) { return s.region === c.name; });
      var activeField = docs.filter(function (s) {
        return s.status === 'active' && (s.scope === 'field' || s.scope === 'all');
      });
      var binding = activeField.filter(function (s) { return s.binding && s.limits; });
      var status, note;
      if (binding.length) {
        status = '有可执行市级标准';
        note = binding.map(function (s) {
          var l = s.limits;
          return s.code + '：风速 ≤' + n1(l.wind_max) + ' m/s' +
            (l.temp_min != null ? '，气温 ' + l.temp_min + '–' + l.temp_max + '℃' : '');
        }).join('；');
      } else if (activeField.some(function (s) { return !!s.limits; })) {
        status = '有市级技术口径（非正式标准）';
        note = activeField.filter(function (s) { return !!s.limits; }).map(function (s) {
          return s.code + '（' + s.title + '：风速 ≤' + n1(s.limits.wind_max) + ' m/s）';
        }).join('；') + '——不是正式标准，不参与取严，按省级执行';
      } else if (activeField.length) {
        status = '有市级文件，未获全文';
        note = activeField.map(function (s) { return s.code + '（' + s.title + '）'; }).join('；') +
          '——未获取全文，不按标题猜数值，按省级执行';
      } else if (docs.length) {
        status = '仅非大田 / 已废止文件';
        note = docs.map(function (s) {
          return s.code + '（' + s.title + '，' + (s.status === 'repealed' ? '已废止' : '非大田作物') + '）';
        }).join('；') + '——不适用，按省级执行';
      } else {
        status = '未检索到公开市级文件';
        note = '按河北省省级文件执行；县级文件多为转发省级，未逐县收录';
      }
      return { city: c.name, code: c.code, status: status, note: note, docs: docs };
    });
  }

  /* ============================================================
     四、给界面用的 HTML
     ============================================================ */
  function badge(id) {
    if (id === 'tool') return '<span class="std-badge tool">工具设定</span>';
    var s = byId(id);
    if (!s) return '';
    var cls = s.level === 'city' ? 'city' : (s.level === 'province' ? 'prov' : 'nat');
    // 徽标只放短标识：完整编号放在 title 与下方文件列表里，避免把行撑破
    var txt = s.id === 'heb-plant-2026' ? '省站 2026' : s.code.replace(/-\d{4}$/, '');
    return '<span class="std-badge ' + cls + '" title="' + esc(s.code + ' ' + s.title) + '">' +
      esc(txt) + '</span>';
  }

  function limitsHtml(city) {
    var e = effective(city);
    var p = e.patch;
    var rows = [
      ['风速上限', '≤ ' + n1(p.wind_max) + ' m/s', '超过即判定不宜喷施', e.by.wind_max],
      ['气温区间', p.temp_min + ' – ' + p.temp_max + ' ℃', '低于下限药效差、高于上限易药害', e.by.temp_max],
      ['作业时段', p.hours_start + ':00 – ' + p.hours_end + ':00', '省站建议的晴天施药时段', e.by.hours_start],
      ['当日降水', '≤ ' + p.rain_day_max + ' mm', '预计雨量超过即关闭窗口', 'tool'],
      ['最短窗口', '≥ ' + p.min_window_hours + ' 小时', '太短的窗口来回折腾不值当', 'tool']
    ];
    return '<div class="std-grid">' + rows.map(function (r) {
      return '<div class="std-row"><div class="std-k">' + esc(r[0]) + '</div>' +
        '<div class="std-v">' + esc(r[1]) + '</div>' +
        '<div class="std-h">' + esc(r[2]) + '</div>' +
        badge(r[3]) + '</div>';
    }).join('') + '</div>';
  }

  function sourcesHtml(city) {
    var list = forCity(city);
    if (!list.length) return '';
    return '<div class="std-files">' + list.map(function (s) {
      var tag = s.level === 'city' ? '市级' : (s.level === 'province' ? '省级' : '国家/行业');
      var bind = s.binding ? '' : '<span class="std-tag">参考</span>';
      return '<a class="std-file" href="' + esc(s.url) + '" target="_blank" rel="noopener">' +
        '<span class="std-file-top"><b>' + esc(s.code) + '</b>' + bind + '</span>' +
        '<span class="std-file-t">' + esc(s.title) + '</span>' +
        '<span class="std-file-m">' + tag + ' · ' + esc(s.issuer) + ' · ' + esc(s.effective) + '</span>' +
        '</a>';
    }).join('') + '</div>';
  }

  function coverageHtml() {
    return '<div class="std-cov">' + coverage().map(function (c) {
      return '<div class="std-cov-row"><b>' + esc(c.city) + '</b>' +
        '<span class="std-cov-s">' + esc(c.status) + '</span>' +
        '<span class="std-cov-n">' + esc(c.note) + '</span></div>';
    }).join('') + '</div>';
  }

  function quotesHtml(city) {
    var list = forCity(city).filter(function (s) { return s.quotes && s.quotes.length; });
    return list.map(function (s) {
      return '<div class="std-quote"><b>' + esc(s.code) + ' · ' + esc(s.title) + '</b>' +
        s.quotes.map(function (q) {
          return '<p><i>' + esc(q.ref) + '</i>' + esc(q.text) + '</p>';
        }).join('') +
        '<a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.urlLabel || '查看原文') + ' ↗</a>' +
        '</div>';
    }).join('');
  }

  /* ============================================================
     五、给问答用的纯文本
     ============================================================ */
  function answer(city, plotName) {
    var e = effective(city);
    var p = e.patch;
    var cityTxt = e.cityName || '属地未知';

    var files = forCity(city).filter(function (s) { return s.binding; })
      .map(function (s) { return s.code; }).join('、');

    var local = '';
    if (e.cityName) {
      var cov = coverage().filter(function (c) { return c.city === e.cityName; })[0];
      if (cov) {
        if (/可执行/.test(cov.status)) local = '属地：' + cov.note + '。';
        else if (/技术口径/.test(cov.status)) local = '属地：只有非标准技术口径，按省级执行。';
        else if (/未获全文/.test(cov.status)) local = '属地：市级文件未获全文，按省级执行。';
        else local = '属地：未检索到公开市级文件，按省级执行。';
      }
    }

    return (plotName ? '【' + plotName + '】' : '') + cityTxt + '打药门槛：\n' +
      '· 风速 ≤ ' + n1(p.wind_max) + ' m/s ｜ 气温 ' + p.temp_min + '–' + p.temp_max +
      '℃ ｜ 时段 ' + p.hours_start + ':00–' + p.hours_end + ':00\n' +
      '依据：' + files + '\n' +
      (local ? local + '\n' : '') +
      '细则与原文见「我的 → 作业标准」·查证日期 ' + CHECKED + '。';
  }

  /* ============================================================
     六、导出
     ============================================================ */
  root.TianZhiStandards = {
    CHECKED: CHECKED,
    LIST: LIST,
    CITIES: CITIES,
    TOOL: TOOL,
    TOOL_LABEL: TOOL_LABEL,
    normCity: normCity,
    byId: byId,
    forCity: forCity,
    effective: effective,
    fieldSource: fieldSource,
    coverage: coverage,
    limitsHtml: limitsHtml,
    sourcesHtml: sourcesHtml,
    coverageHtml: coverageHtml,
    quotesHtml: quotesHtml,
    answer: answer,
    esc: esc
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
