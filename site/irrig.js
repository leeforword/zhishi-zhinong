/* =============================================================
   农时窗 · 灌溉决策层（v6.0）
   -------------------------------------------------------------
   为什么单开一层：
     原来的灌溉判定只看「未来 7 天雨量 < 15mm」——同一个数字对七天里
     每一天都一样，既不区分生育期，也分不清"该浇"和"浇多少"。
     冬小麦拔节期缺水会直接减产，而越冬期少水反而能蹲苗；
     同一块地在不同月份，"要不要浇"的答案完全不同。

   这一层做四件事：
     1. 按日期 + 作物定位生育期（冬小麦 / 夏玉米，河北一年两熟）
     2. 用 FAO-56 的参考蒸散（Hargreaves）+ 有效降水，估算 0–40cm 墒情
     3. 拿各生育期的土壤相对含水量下限（来自官方指导意见）判"该不该浇"
     4. 给出灌水定额区间与作业时机（避开正午高温、大风、封冻）

   红线：
     · 不替代实测墒情。没有传感器时这是估算值，误差可能 ±10%，
       界面上必须写明「估算」，不能伪装成实测。
     · 数字只来自「公式 + 阈值表」，不经过任何语言模型。
     · 每条阈值都能追到文件（见 SOURCES）。
   ============================================================= */
(function (root) {
  'use strict';

  var CHECKED = '2026-11-18';

  /* 依据：只列能打开原文的官方/公开文件 */
  var SOURCES = [
    {
      id: 'irr-wheat-micro',
      code: '河北农技总站 2025',
      title: '华北黄淮冬小麦微喷灌水肥一体化技术模式',
      issuer: '河北省农业技术推广总站（农民日报客户端）',
      url: 'https://www.farmer.com.cn/2025/05/24/wap_99987917.html',
      note: '各生育期 0–40/60/80cm 土壤相对含水量下限、灌水定额 15–30 方/亩、灌溉定额 75–130 方'
    },
    {
      id: 'irr-wheat-mfe',
      code: '全国农技中心 小麦水肥',
      title: '小麦水肥一体化单产提升技术方案',
      issuer: '全国农技推广服务中心 / 农业农村部节水农业专家指导组',
      url: 'https://nync.ln.gov.cn/nync/index/rdzt/lnkph/zzy/2026080615161643736/index.shtml',
      note: '华北黄淮冬麦区全生育期灌水 6 次、每次 15–30 方；相对含水量低于 70%/65% 时灌'
    },
    {
      id: 'irr-winterwater-sd',
      code: '山东厅 2026 冬前',
      title: '2026 年全省小麦冬前管理技术指导意见',
      issuer: '山东省农业农村厅 / 省农业技术推广中心',
      url: 'http://nync.shandong.gov.cn/zwgk/tzgg/tfwj/202611/t20261109_5027946.html',
      note: '越冬水在日均温 3–5℃、土壤夜冻昼消时浇；浇后当天渗完、及时划锄'
    },
    {
      id: 'irr-winterwater-nx',
      code: '宁夏厅 2026 冬播',
      title: '2026 年冬小麦播种及冬前田间管理技术指导意见',
      issuer: '宁夏回族自治区农业农村厅',
      url: 'https://nynct.nx.gov.cn/zzb/zwdt_67876/202609/t20260930_5363595.html',
      note: '冬灌亩灌水 50–60 方、当天渗完、严禁冰层盖苗；墒情适宜苗壮的可免浇'
    },
    {
      id: 'irr-winterwater-nercita',
      code: '农技平台 冬灌',
      title: '冬灌最佳时间与判断标准',
      issuer: '中国农技推广信息服务平台',
      url: 'https://njtg.nercita.org.cn/tech/question/detail.shtml?quesId=36453821',
      note: '日均温连续多日 3–5℃；浇后 3 天无强降温；水分可下渗 20–30cm'
    },
    {
      id: 'irr-wheat-water',
      code: '科普中国 冬小麦',
      title: '冬小麦需水规律与灌溉技术',
      issuer: '科普中国（中国科协）',
      url: 'https://m.kepuchina.cn/tuwendetail?id=340458',
      note: '拔节—抽穗为需水临界期（挑旗最敏感）、开花—灌浆为第二临界期；各期适宜含水量 55%–80%'
    },
    {
      id: 'irr-maize-2026',
      code: '全国农技中心 2026 夏玉米',
      title: '2026 年夏玉米科学灌溉技术指导意见',
      issuer: '全国农技推广服务中心 / 农业农村部节水农业专家指导组',
      url: 'https://nongye.yantai.gov.cn/col/col107463/art/2026/art_cc6d0d04c75a476689a86b9e48844d08.html',
      note: '拔节—吐丝 0–20cm<70%、吐丝—灌浆中期 0–40cm<75%、灌浆后期 0–60cm<65% 时灌溉；滴灌 15–25 方/亩'
    },
    {
      id: 'irr-maize-drip',
      code: '河北农技总站 2025 玉米',
      title: '华北黄淮夏玉米滴灌水肥一体化技术模式',
      issuer: '河北省农业技术推广总站（农民日报客户端）',
      url: 'https://www.farmer.com.cn/2025/05/28/wap_99988288.html',
      note: '拔节 0–40cm<65% 灌 20 方、大喇叭口 0–60cm<70% 灌 20–25 方、灌浆 0–60cm<65% 灌 20 方'
    },
    {
      id: 'irr-maize-nx',
      code: '漯河 2026 大喇叭口',
      title: '夏玉米大喇叭口期田间管理技术要点',
      issuer: '漯河市农业农村局',
      url: 'https://ra.luohe.gov.cn/nykj/content_1058826',
      note: '大喇叭口期为需水临界期；沟灌 40–50 方/亩、湿到 30cm；避开正午高温'
    },
    {
      id: 'irr-fao56',
      code: 'FAO-56',
      title: 'Crop evapotranspiration — Guidelines for computing crop water requirements',
      issuer: 'FAO Irrigation and Drainage Paper 56',
      url: 'https://www.fao.org/3/x0490e/x0490e00.htm',
      note: '参考蒸散 ET0（Hargreaves 缺资料法）与作物系数 Kc 的方法来源'
    }
  ];

  /* ---------------- 土壤与水量平衡参数 ----------------
     0–40cm 根层，壤土：田间持水量 32%（体积含水率），凋萎点 12%，
     有效水 = (32−12)% × 400mm = 80mm。砂土/黏土会偏，界面已注明是估算。 */
  var SOIL = { fc: 32, wp: 12, depth: 400 };

  function fcMm() { return SOIL.fc / 100 * SOIL.depth; }
  function wpMm() { return SOIL.wp / 100 * SOIL.depth; }

  /* ---------------- 生育期表 ----------------
     from/to 用 MM-DD；kc 参考 FAO-56 分段作物系数；
     thr 是该生育期「0–40cm 土壤相对含水量」的下限，取自上面各份指导意见。 */
  var CROPS = {
    wheat: {
      name: '冬小麦',
      stages: [
        { key: 'sow', name: '播种—出苗', from: '09-25', to: '10-12', kc: 0.45, thr: 75, tip: '足墒播种，播后镇压保墒' },
        { key: 'tiller', name: '分蘖—越冬前', from: '10-13', to: '11-30', kc: 0.55, thr: 70, tip: '苗期尽量不浇水，促根下扎；旺长田推迟冬灌' },
        { key: 'winter', name: '越冬期', from: '12-01', to: '02-20', kc: 0.40, thr: 60, tip: '封冻后不再灌水；墒情差的地块靠镇压、覆盖保墒' },
        { key: 'greening', name: '返青—起身', from: '02-21', to: '03-31', kc: 0.70, thr: 70, tip: '返青起身一般不浇，锄划保墒；弱苗可提前' },
        { key: 'jointing', name: '拔节—孕穗', from: '04-01', to: '04-30', kc: 1.05, thr: 65, critical: true, tip: '需水临界期，缺水直接减穗粒数' },
        { key: 'heading', name: '抽穗—开花', from: '05-01', to: '05-20', kc: 1.15, thr: 70, critical: true, tip: '第二临界期，挑旗期对水分最敏感' },
        { key: 'filling', name: '灌浆—成熟', from: '05-21', to: '06-20', kc: 0.95, thr: 65, tip: '灌浆水别晚于乳熟，防倒伏与贪青' }
      ]
    },
    maize: {
      name: '夏玉米',
      stages: [
        { key: 'sow', name: '播种—出苗', from: '06-10', to: '06-25', kc: 0.40, thr: 70, tip: '播后补浇蒙头水，保证齐苗' },
        { key: 'seedling', name: '苗期', from: '06-26', to: '07-10', kc: 0.55, thr: 65, tip: '蹲苗控水促根；高温时小水降温' },
        { key: 'jointing', name: '拔节', from: '07-11', to: '07-25', kc: 0.90, thr: 65, tip: '拔节水配合追肥，沟灌湿到 30cm' },
        { key: 'bell', name: '大喇叭口', from: '07-26', to: '08-10', kc: 1.10, thr: 70, critical: true, tip: '需水临界期，缺水会「卡脖旱」，秃尖空秆' },
        { key: 'tassel', name: '抽雄—吐丝', from: '08-11', to: '08-25', kc: 1.15, thr: 75, critical: true, tip: '最敏感的一段，土壤含水量要守在 75% 以上' },
        { key: 'filling', name: '灌浆', from: '08-26', to: '09-20', kc: 1.00, thr: 65, tip: '灌浆水促粒重，后期别大水漫灌' },
        { key: 'mature', name: '成熟', from: '09-21', to: '10-10', kc: 0.60, thr: 60, tip: '适期晚收，收前 10 天停水' }
      ]
    }
  };

  /* 灌水定额（m³/亩）：按「生育期 × 灌溉方式」，数字全部来自上面文件 */
  var QUOTA = {
    wheat: {
      tiller:   { flood: [50, 60], sprinkler: [15, 25], drip: [15, 20] },   // 越冬水：宁夏 50–60；河北微喷 15–25
      winter:   { flood: [50, 60], sprinkler: [15, 25], drip: [15, 20] },   // 宁夏 50–60；河北微喷 15–25
      greening: { flood: [40, 50], sprinkler: [25, 30], drip: [20, 25] },
      jointing: { flood: [40, 50], sprinkler: [25, 30], drip: [20, 25] },
      heading:  { flood: [40, 50], sprinkler: [20, 25], drip: [20, 25] },
      filling:  { flood: [35, 45], sprinkler: [15, 20], drip: [15, 20] }
    },
    maize: {
      sow:      { flood: [30, 40], sprinkler: [25, 30], drip: [15, 25] },
      seedling: { flood: [30, 40], sprinkler: [20, 25], drip: [15, 20] },
      jointing: { flood: [40, 50], sprinkler: [25, 30], drip: [15, 25] },
      bell:     { flood: [40, 50], sprinkler: [25, 30], drip: [20, 25] },
      tassel:   { flood: [40, 50], sprinkler: [25, 30], drip: [20, 25] },
      filling:  { flood: [35, 45], sprinkler: [20, 25], drip: [15, 20] },
      mature:   { flood: [30, 40], sprinkler: [20, 25], drip: [15, 20] }
    }
  };
  var METHOD_NAME = { flood: '畦灌 / 沟灌', sprinkler: '喷灌 / 微喷', drip: '滴灌' };

  /* ---------------- 小工具 ---------------- */
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function mdOf(dateStr) { return dateStr.slice(5); }        // '2026-04-12' → '04-12'
  function round1(v) { return Math.round(v * 10) / 10; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function stageOf(crop, dateStr) {
    var c = CROPS[crop === 'maize' ? 'maize' : 'wheat'];
    var md = mdOf(dateStr);
    for (var i = 0; i < c.stages.length; i++) {
      var s = c.stages[i];
      if (s.from <= s.to) { if (md >= s.from && md <= s.to) return s; }
      else { if (md >= s.from || md <= s.to) return s; }      // 跨年（越冬期）
    }
    return { key: 'off', name: '非主要生育期', kc: 0.7, thr: 65, tip: '按常年农时估算，具体以田间长势为准' };
  }

  /* ---------------- 参考蒸散 ET0（Hargreaves） ----------------
     FAO-56 在只有气温资料时推荐的替代法：
       ET0 = 0.0023 × (Tmean + 17.8) × √(Tmax − Tmin) × Ra
     Ra 为天顶辐射（换算成 mm/d）。纬度取地块纬度，日序取当天。 */
  function extraterrestrial(latDeg, doy) {
    var GSC = 0.0820;                       // MJ m-2 min-1
    var phi = latDeg * Math.PI / 180;
    var dr = 1 + 0.033 * Math.cos(2 * Math.PI * doy / 365);
    var dec = 0.409 * Math.sin(2 * Math.PI * doy / 365 - 1.39);
    var x = clamp(-Math.tan(phi) * Math.tan(dec), -1, 1);
    var ws = Math.acos(x);
    var ra = (24 * 60 / Math.PI) * GSC * dr *
      (ws * Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.sin(ws));
    return ra * 0.408;                      // MJ → mm/d
  }

  function doyOf(dateStr) {
    var d = new Date(dateStr + 'T00:00:00');
    if (isNaN(d.getTime())) return 180;
    return Math.floor((d - new Date(d.getFullYear() + '-01-01T00:00:00')) / 86400000) + 1;
  }

  function et0Of(dateStr, tmax, tmin, lat) {
    var tmean = (tmax + tmin) / 2;
    var range = Math.max(1, tmax - tmin);
    var ra = extraterrestrial(lat || 38.9, doyOf(dateStr));
    var v = 0.0023 * (tmean + 17.8) * Math.sqrt(range) * ra;
    return Math.max(0.2, round1(v));
  }

  /* ---------------- 墒情估算（0–40cm 相对含水量 %） ----------------
     初始墒情没有实测，只能按近几天的雨量给一个起点：
       近 3 天累计 ≥15mm → 85%，5–15mm → 75%，<5mm → 65%。
     之后逐日做水量平衡：SM += 有效降水 − ETc。
     有效降水系数 0.85（小雨按 0.6），这是常用的经验折减，属工具设定。 */
  function initSM(leadRain) {
    if (leadRain >= 15) return 85;
    if (leadRain >= 5) return 75;
    return 65;
  }

  function effectiveRain(mm) {
    if (!mm || mm <= 0) return 0;
    return mm * (mm < 5 ? 0.6 : 0.85);
  }

  /**
   * @param {Object} ctx {crop, lat, days:[{date,tmin,tmax,dayRain,dayProb}], leadRain}
   * @returns {Array} 逐日灌溉判定
   */
  function plan(ctx) {
    ctx = ctx || {};
    var crop = ctx.crop === 'maize' ? 'maize' : 'wheat';
    var days = ctx.days || [];
    var smMm = initSM(ctx.leadRain || 0) / 100 * fcMm();
    var out = [];

    for (var i = 0; i < days.length; i++) {
      var d = days[i];
      var stage = stageOf(crop, d.date);
      var et0 = et0Of(d.date, d.tmax, d.tmin, ctx.lat);
      var etc = et0 * (stage.kc || 0.7);
      var pe = effectiveRain(d.dayRain);

      /* 今天这一天的墒情，是「昨天结余 + 今天的雨 − 今天的蒸散」 */
      smMm = smMm + pe - etc;
      smMm = clamp(smMm, wpMm() * 0.9, fcMm() * 1.18);
      var sm = Math.round(smMm / fcMm() * 100);

      var q = (QUOTA[crop] && QUOTA[crop][stage.key]) || { flood: [30, 40], sprinkler: [20, 25], drip: [15, 20] };
      var res = verdict(crop, stage, d, sm, q);

      out.push({
        date: d.date, stage: stage, sm: sm, et0: et0, etc: round1(etc),
        pe: round1(pe), quota: q, status: res.status, why: res.why, tip: res.tip,
        need: res.need
      });
    }
    return out;
  }

  /* 判定：先看天（有雨不浇），再看期（越冬/蹲苗有专门的规矩），最后看墒 */
  function verdict(crop, stage, d, sm, q) {
    var thr = stage.thr || 65;
    var tmean = round1((d.tmax + d.tmin) / 2);
    var rainy = (d.dayRain >= 10) || (d.dayProb >= 70);
    if (rainy) {
      return {
        status: 'bad', need: false,
        why: '当天预计降水 ' + d.dayRain + ' mm、概率 ' + d.dayProb + '%，此时灌溉等于白浇，等雨后再看',
        tip: '雨后 2–3 天再查墒；若雨量不足 10mm，按下面定额补'
      };
    }

    /* 越冬期：土壤封冻，灌下去只会在表层结冰，伤根死苗 */
    if (stage.key === 'winter') {
      return {
        status: 'ok', need: false,
        why: '越冬期土壤封冻，不再灌水；墒情约 ' + sm + '%，靠镇压、秸秆覆盖保墒即可',
        tip: '开春返青后再按墒情定；封冻前浇过越冬水的地块一般不用管'
      };
    }

    /* 分蘖—越冬前：先看温度再决定，这是「冬灌」而不是「旱了浇」 */
    if (stage.key === 'tiller') {
      if (tmean > 5.5) {
        if (sm < 50) {
          return {
            status: 'warn', need: true,
            why: '墒情已降到约 ' + sm + '%，可小水补墒 ' + q.sprinkler[0] + '–' + q.sprinkler[1] + ' 方/亩，别大水漫灌',
            tip: '补完及时划锄；旺长田宁可不浇，防止冬前旺长'
          };
        }
        return {
          status: 'ok', need: false,
          why: '日均温 ' + tmean + '℃，还在蹲苗期，墒情约 ' + sm + '%，暂不浇水；' +
            '等日均温降到 3–5℃、夜冻昼消再浇越冬水',
          tip: '苗期适度控水促根下扎；旺长田推迟或不浇'
        };
      }
      if (tmean >= 2.5) {
        return {
          status: 'warn', need: true,
          why: '日均温 ' + tmean + '℃，已进入 3–5℃ 越冬水适期；墒情约 ' + sm + '%，' +
            '建议浇 ' + q.sprinkler[0] + '–' + q.sprinkler[1] + ' 方/亩（微喷/管灌），畦灌 ' +
            q.flood[0] + '–' + q.flood[1] + ' 方/亩',
          tip: '选晴天上午，当天渗完、不留积水；浇后划锄防裂'
        };
      }
      return {
        status: 'ok', need: false,
        why: '日均温 ' + tmean + '℃，土壤接近封冻，此时再灌容易结冰盖苗，不要再浇',
        tip: '封冻前只做镇压、覆盖保墒'
      };
    }

    if (sm < thr - 12) {
      return {
        status: 'warn', need: true,
        why: '0–40cm 相对含水量约 ' + sm + '%，明显低于' + stage.name + '下限 ' + thr + '%；' +
          '建议灌水 ' + q.flood[0] + '–' + q.flood[1] + ' 方/亩（畦灌），滴灌 ' + q.drip[0] + '–' + q.drip[1] + ' 方/亩',
        tip: stage.tip
      };
    }
    if (sm < thr) {
      return {
        status: 'warn', need: true,
        why: '0–40cm 相对含水量约 ' + sm + '%，已到' + stage.name + '下限 ' + thr + '% 附近；' +
          '可以安排一次小水，' + q.sprinkler[0] + '–' + q.sprinkler[1] + ' 方/亩（喷灌/微喷）',
        tip: stage.tip
      };
    }
    if (sm > thr + 18) {
      return {
        status: 'ok', need: false,
        why: '0–40cm 相对含水量约 ' + sm + '%，高于' + stage.name + '下限 ' + thr + '%，墒情偏足，不必浇',
        tip: '水多也会沤根、贪青，趁墒情好把功夫放在划锄或化控上'
      };
    }
    return {
      status: 'ok', need: false,
      why: '0–40cm 相对含水量约 ' + sm + '%，仍在' + stage.name + '下限 ' + thr + '% 之上，暂不需要灌溉',
      tip: stage.tip
    };
  }

  /* 越冬水窗口：日均温 3–5℃、夜冻昼消、未来 3 天无强降温 */
  function winterWindow(days) {
    var d = (days || [])[0];
    if (!d) return null;
    var tmean = (d.tmax + d.tmin) / 2;
    var inRange = tmean <= 5.5 && tmean >= 2.5;
    var coldSoon = (days.slice(1, 4) || []).some(function (x) { return x.tmin <= -6; });
    return { tmean: round1(tmean), inRange: inRange, coldSoon: coldSoon };
  }

  /* ---------------- 给问答用的两行结论 ---------------- */
  function answer(ctx) {
    var p = plan(ctx);
    if (!p.length) return null;
    var today = p[0];
    var cname = (CROPS[ctx.crop === 'maize' ? 'maize' : 'wheat'] || CROPS.wheat).name;
    var head = cname + ' · ' + today.stage.name + ' · ' + (today.status === 'ok' ? '暂不需要灌溉'
      : (today.status === 'bad' ? '今天不宜灌溉' : '该安排灌溉了'));

    var brief = head + '。\n' + today.why + '。';

    var L = [];
    L.push('0–40cm 墒情（估算）约 ' + today.sm + '%（' + today.stage.name + '下限 ' + today.stage.thr + '%）');
    L.push('参考蒸散 ET0 ' + today.et0 + ' mm/日，作物系数 Kc ' + today.stage.kc + '，日耗水约 ' + today.etc + ' mm');
    L.push('灌水定额：畦灌/沟灌 ' + today.quota.flood.join('–') + ' 方/亩；喷灌 ' +
      today.quota.sprinkler.join('–') + '；滴灌 ' + today.quota.drip.join('–'));
    L.push('作业时机：上午 10 点前或下午 3 点后，避开正午高温；喷灌避开 4 级以上风');
    var nw = winterWindow(ctx.days);
    if (nw && (ctx.crop !== 'maize')) {
      L.push('越冬水窗口：日均温 ' + nw.tmean + '℃' + (nw.inRange ? '，已进入 3–5℃ 适期' : '，尚未到 3–5℃') +
        (nw.coldSoon ? '；未来几天有强降温，别抢灌' : ''));
    }
    return {
      brief: brief,
      detail: L.join('；') + '。',
      stage: today.stage, today: today, days: p
    };
  }

  root.TianZhiIrrig = {
    CHECKED: CHECKED,
    SOURCES: SOURCES,
    CROPS: CROPS,
    QUOTA: QUOTA,
    METHOD_NAME: METHOD_NAME,
    SOIL: SOIL,
    stageOf: stageOf,
    et0Of: et0Of,
    plan: plan,
    answer: answer,
    winterWindow: winterWindow,
    quotaText: function (q) {
      return '畦灌 ' + q.flood.join('–') + ' / 喷灌 ' + q.sprinkler.join('–') + ' / 滴灌 ' + q.drip.join('–') + ' 方/亩';
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
