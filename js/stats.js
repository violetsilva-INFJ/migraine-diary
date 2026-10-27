// 分析引擎：个人头痛日记的统计方法
//
// 1. 每天一行（只取有记录的日子），结局 = 当天是否开始一次发作。
// 2. 多因素：贝叶斯逻辑回归（先验 N(0,1)，MAP + 拉普拉斯近似），得到校正后的风险倍数与可信区间。
//    小样本时先验相当于岭回归惩罚，能避免过拟合和“完美分离”。
// 3. 单因素：同样的模型只放一个因素，并给出原始发作率对照。
// 4. 预测：用分块时间序列交叉验证评估区分度（AUC），只有达到一定水平才展示今日风险。
// 5. 相关性：Spearman 等级相关（睡眠、压力等与当天头痛程度）。
// 6. 趋势：带记录天数偏移量的泊松回归，判断发作频率是否在变化。
// 7. 经期：经期开始前 2 天至后 3 天的窗口分析。

import { dkey, parseKey, shiftKey, todayKey, daysBetween, addMonths, startOfMonth } from './util.js';

export const MIN_DAYS = 21;
export const MIN_ATTACKS = 4;
const PRIOR_VAR = 1;
const INTERCEPT_VAR = 9;

// ---------------- 基础工具 ----------------
export const attackDay = a => dkey(new Date(a.start));

export function indexAttacks(attacks) {
  const m = new Map();
  for (const a of attacks) {
    const k = attackDay(a);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(a);
  }
  return m;
}

export function hasDayData(d) {
  if (!d) return false;
  return d.pain === 0 || d.period != null || d.meals != null || d.caffeine != null || d.alcohol != null ||
    d.sleep != null || d.stress != null || d.exercise != null || (d.meds && d.meds.length > 0);
}

export function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

const sigmoid = x => 1 / (1 + Math.exp(-x));

// ---------------- 线性代数 ----------------
function cholesky(A) {
  const n = A.length, L = A.map(() => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) {
        if (s <= 1e-12) return null;
        L[i][i] = Math.sqrt(s);
      } else L[i][j] = s / L[j][j];
    }
  }
  return L;
}

function cholSolve(L, b) {
  const n = L.length, z = new Array(n), x = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i][k] * z[k];
    z[i] = s / L[i][i];
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = z[i];
    for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k];
    x[i] = s / L[i][i];
  }
  return x;
}

function cholInv(L) {
  const n = L.length, inv = L.map(() => new Array(n).fill(0));
  for (let j = 0; j < n; j++) {
    const e = new Array(n).fill(0);
    e[j] = 1;
    const col = cholSolve(L, e);
    for (let i = 0; i < n; i++) inv[i][j] = col[i];
  }
  return inv;
}

// ---------------- 广义线性模型（MAP 估计） ----------------
// family: 'logit' 或 'poisson'；pv: 每个系数的先验方差（正态先验，均值 0）
function glmMAP(X, y, pv, family, offset) {
  const n = X.length, p = X[0].length, beta = new Array(p).fill(0);
  const gradHess = () => {
    const g = new Array(p).fill(0), H = Array.from({ length: p }, () => new Array(p).fill(0));
    for (let i = 0; i < n; i++) {
      const x = X[i];
      let eta = offset ? offset[i] : 0;
      for (let j = 0; j < p; j++) eta += beta[j] * x[j];
      let mu, w;
      if (family === 'logit') { mu = sigmoid(eta); w = mu * (1 - mu); }
      else { mu = Math.exp(Math.min(eta, 30)); w = mu; }
      const r = y[i] - mu;
      for (let j = 0; j < p; j++) {
        g[j] += r * x[j];
        const wx = w * x[j];
        for (let k = 0; k <= j; k++) H[j][k] += wx * x[k];
      }
    }
    for (let j = 0; j < p; j++) {
      g[j] -= beta[j] / pv[j];
      H[j][j] += 1 / pv[j];
      for (let k = 0; k < j; k++) H[k][j] = H[j][k];
    }
    return { g, H };
  };
  for (let it = 0; it < 100; it++) {
    const { g, H } = gradHess();
    const L = cholesky(H);
    if (!L) return null;
    const step = cholSolve(L, g);
    let mx = 0;
    for (let j = 0; j < p; j++) {
      const s = Math.max(-3, Math.min(3, step[j]));
      beta[j] += s;
      mx = Math.max(mx, Math.abs(s));
    }
    if (mx < 1e-8) break;
  }
  const L = cholesky(gradHess().H);
  if (!L) return null;
  return { beta, cov: cholInv(L) };
}

// 把系数转成“风险倍数”与证据强度
function effectOf(b, se) {
  const pDir = normCdf(Math.abs(b) / se);
  return {
    or: Math.exp(b),
    lo: Math.exp(b - 1.96 * se),
    hi: Math.exp(b + 1.96 * se),
    pDir,                       // 效应方向为真的后验概率
    dir: b >= 0 ? 1 : -1,
    level: pDir >= 0.95 ? 2 : pDir >= 0.8 ? 1 : 0,
  };
}

// ---------------- 经期 ----------------
export function periodStarts(days) {
  const keys = Object.keys(days).filter(k => days[k]?.period === true).sort();
  const set = new Set(keys);
  return keys.filter(k => {
    for (let i = 1; i <= 10; i++) if (set.has(shiftKey(k, -i))) return false;
    return true;
  });
}

export function periodDayNumber(days, k) {
  let n = 0, c = k;
  while (days[c]?.period === true) { n++; c = shiftKey(c, -1); }
  return n;
}

function periodCtx(k, starts) {
  if (starts.length < 2) return { known: false };
  if (k < shiftKey(starts[0], -10) || k > shiftKey(starts[starts.length - 1], 40)) return { known: false };
  const inWindow = starts.some(s => { const d = daysBetween(s, k); return d >= -2 && d <= 3; });
  return { known: true, inWindow };
}

export function inPeriodWindow(k, starts) {
  return starts.some(s => { const d = daysBetween(s, k); return d >= -2 && d <= 3; });
}

// ---------------- 因素定义（均为 0/1，未知为 null） ----------------
export const FEATURES = [
  { key: 'sleepShort', label: '睡眠不足', desc: '前一晚睡眠少于 6 小时',
    get: d => d?.sleep == null ? null : +(d.sleep < 6) },
  { key: 'sleepLong', label: '睡得太久', desc: '前一晚睡了 9 小时或更久',
    get: d => d?.sleep == null ? null : +(d.sleep >= 9) },
  { key: 'stressHigh', label: '压力大', desc: '当天压力为「高」',
    get: d => d?.stress == null ? null : +(d.stress === 3) },
  { key: 'stressDrop', label: '压力骤降', desc: '压力比前一天低（“放松后头痛”）',
    get: (d, prev) => (d?.stress == null || prev?.stress == null) ? null : +(prev.stress - d.stress >= 1) },
  { key: 'mealSkip', label: '漏餐', desc: '当天至少有一餐没吃',
    get: d => !d?.meals ? null : +(['b', 'l', 'd'].some(m => d.meals[m] === false)) },
  { key: 'caffeineHigh', label: '咖啡因偏多', desc: '咖啡或浓茶 3 杯及以上',
    get: d => d?.caffeine == null ? null : +(d.caffeine >= 3) },
  { key: 'alcohol', label: '饮酒', desc: '当天或前一天喝了酒',
    get: (d, prev) => (d?.alcohol == null && prev?.alcohol == null) ? null : +(!!d?.alcohol || !!prev?.alcohol) },
  { key: 'period', label: '经期前后', desc: '经期开始前 2 天到开始后 3 天',
    get: (d, prev, ctx) => ctx.known ? +ctx.inWindow : null },
  { key: 'exercise', label: '运动', desc: '当天运动 20 分钟以上',
    get: d => d?.exercise == null ? null : +(d.exercise >= 20) },
];
export const featureByKey = k => FEATURES.find(f => f.key === k);

export function featuresFor(state, k, starts) {
  const d = state.days[k], prev = state.days[shiftKey(k, -1)], ctx = periodCtx(k, starts);
  const f = {};
  for (const F of FEATURES) f[F.key] = F.get(d, prev, ctx);
  return f;
}

// ---------------- 数据表 ----------------
export function buildRows(state, { endKey = todayKey(), lookback = 365 } = {}) {
  const byDay = indexAttacks(state.attacks);
  const starts = periodStarts(state.days);
  const keys = [...Object.keys(state.days), ...byDay.keys()].sort();
  if (!keys.length) return [];
  let k = keys[0] > shiftKey(endKey, -lookback) ? keys[0] : shiftKey(endKey, -lookback);
  const rows = [];
  for (; k < endKey; k = shiftKey(k, 1)) {
    const day = state.days[k], atks = byDay.get(k) || [];
    if (!atks.length && !hasDayData(day)) continue;
    // 前一天开始的发作持续超过 24 小时：这一天不算“可能发作的日子”
    const prevAtks = byDay.get(shiftKey(k, -1)) || [];
    if (!atks.length && prevAtks.some(a => a.duration === 'gt24')) continue;
    rows.push({
      key: k,
      y: atks.length ? 1 : 0,
      sev: atks.reduce((m, a) => Math.max(m, a.severity || 0), 0),
      day,
      f: featuresFor(state, k, starts),
    });
  }
  return rows;
}

function featureMeans(rows, feats) {
  return feats.map(F => {
    let n = 0, s = 0;
    for (const r of rows) { const v = r.f[F.key]; if (v != null) { n++; s += v; } }
    return n ? s / n : 0;
  });
}

export function eligibleFeatures(rows) {
  return FEATURES.filter(F => {
    let n = 0, e = 0;
    for (const r of rows) { const v = r.f[F.key]; if (v != null) { n++; e += v; } }
    return n >= 14 && e >= 3 && n - e >= 3;
  });
}

// 多因素模型：缺失值用该因素的平均值填补（会让效应偏向“无关”，属于保守做法）
export function fitLogit(rows, feats) {
  const means = featureMeans(rows, feats);
  const X = rows.map(r => [1, ...feats.map((F, j) => (r.f[F.key] ?? means[j]) - means[j])]);
  const fit = glmMAP(X, rows.map(r => r.y), [INTERCEPT_VAR, ...feats.map(() => PRIOR_VAR)], 'logit');
  if (!fit) return null;
  const { beta, cov } = fit;
  return {
    feats, means, beta, cov,
    predict(f) {
      let eta = beta[0];
      feats.forEach((F, j) => { eta += beta[j + 1] * ((f[F.key] ?? means[j]) - means[j]); });
      return sigmoid(eta);
    },
  };
}

export function univariate(rows, F) {
  const sub = rows.filter(r => r.f[F.key] != null);
  let nE = 0, aE = 0, nU = 0, aU = 0;
  for (const r of sub) {
    if (r.f[F.key]) { nE++; aE += r.y; } else { nU++; aU += r.y; }
  }
  const res = { nE, aE, nU, aU, rateE: nE ? aE / nE : null, rateU: nU ? aU / nU : null };
  if (nE < 2 || nU < 2) return res;
  const m = nE / (nE + nU);
  const fit = glmMAP(sub.map(r => [1, r.f[F.key] - m]), sub.map(r => r.y), [INTERCEPT_VAR, PRIOR_VAR], 'logit');
  if (fit) Object.assign(res, effectOf(fit.beta[1], Math.sqrt(fit.cov[1][1])));
  return res;
}

function auc(scores, labels) {
  const idx = scores.map((_, i) => i).sort((a, b) => scores[a] - scores[b]);
  const ranks = new Array(scores.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && scores[idx[j + 1]] === scores[idx[i]]) j++;
    for (let t = i; t <= j; t++) ranks[idx[t]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  let nP = 0, nN = 0, sum = 0;
  labels.forEach((l, i) => { if (l) { nP++; sum += ranks[i]; } else nN++; });
  if (!nP || !nN) return null;
  return (sum - nP * (nP + 1) / 2) / (nP * nN);
}

// 分块时间序列交叉验证：按时间切成 k 段，轮流用其余数据训练、预测这一段
export function cvAUC(rows, feats, k = 5) {
  const nPos = rows.reduce((s, r) => s + r.y, 0);
  if (nPos < 6 || rows.length < 30) return null;
  const preds = new Array(rows.length).fill(null);
  for (let fold = 0; fold < k; fold++) {
    const train = [], test = [];
    rows.forEach((r, i) => (Math.floor(i * k / rows.length) === fold ? test : train).push(i));
    const trRows = train.map(i => rows[i]);
    if (trRows.reduce((s, r) => s + r.y, 0) < 3) continue;
    const m = fitLogit(trRows, feats);
    if (!m) continue;
    for (const i of test) preds[i] = m.predict(rows[i].f);
  }
  const s = [], l = [];
  preds.forEach((p, i) => { if (p != null) { s.push(p); l.push(rows[i].y); } });
  return auc(s, l);
}

// ---------------- 相关性 ----------------
function ranks(a) {
  const idx = a.map((_, i) => i).sort((x, y) => a[x] - a[y]);
  const r = new Array(a.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && a[idx[j + 1]] === a[idx[i]]) j++;
    for (let t = i; t <= j; t++) r[idx[t]] = (i + j) / 2;
    i = j + 1;
  }
  return r;
}

function pearson(x, y) {
  const n = x.length, mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

export const CORR_VARS = [
  { key: 'sleep', label: '睡眠时长', get: d => d?.sleep },
  { key: 'stress', label: '压力', get: d => d?.stress },
  { key: 'caffeine', label: '咖啡因', get: d => d?.caffeine },
  { key: 'exercise', label: '运动时长', get: d => d?.exercise },
];

export function correlations(rows) {
  return CORR_VARS.map(V => {
    const xs = [], ys = [];
    for (const r of rows) {
      const v = V.get(r.day);
      if (v != null) { xs.push(v); ys.push(r.sev); }
    }
    const n = xs.length;
    if (n < 14) return { ...V, n, rho: null };
    const rho = pearson(ranks(xs), ranks(ys));
    if (rho == null) return { ...V, n, rho: null };
    const z = Math.atanh(Math.max(-0.999, Math.min(0.999, rho))) * Math.sqrt(n - 3);
    return { ...V, n, rho, p: 2 * (1 - normCdf(Math.abs(z))) };
  });
}

// ---------------- 睡眠分段 ----------------
export function sleepBuckets(rows) {
  const B = [
    { label: '<6h', test: s => s < 6 },
    { label: '6–7h', test: s => s >= 6 && s < 7 },
    { label: '7–8h', test: s => s >= 7 && s < 8 },
    { label: '8–9h', test: s => s >= 8 && s < 9 },
    { label: '≥9h', test: s => s >= 9 },
  ].map(b => ({ ...b, n: 0, a: 0 }));
  let total = 0;
  for (const r of rows) {
    const s = r.day?.sleep;
    if (s == null) continue;
    total++;
    const b = B.find(b => b.test(s));
    b.n++; b.a += r.y;
  }
  return { total, buckets: B.map(b => ({ ...b, rate: b.n ? b.a / b.n : null })) };
}

// ---------------- 趋势（泊松回归，偏移量 = 记录天数） ----------------
export function monthlyTrend(state, months = 6) {
  const today = todayKey(), byDay = indexAttacks(state.attacks);
  const list = [];
  for (let i = months - 1; i >= 0; i--) {
    const m0 = addMonths(startOfMonth(new Date()), -i), m1 = addMonths(m0, 1);
    let attacks = 0, recordDays = 0;
    for (let d = new Date(m0); d < m1; d.setDate(d.getDate() + 1)) {
      const k = dkey(d);
      if (k > today) break;
      const a = byDay.get(k)?.length || 0;
      attacks += a;
      if (a || hasDayData(state.days[k])) recordDays++;
    }
    list.push({ month: m0, attacks, recordDays, idx: months - 1 - i, current: i === 0 });
  }
  const usable = list.filter(m => m.recordDays >= 7);
  let trend = null;
  if (usable.length >= 3 && usable.reduce((s, m) => s + m.attacks, 0) >= 4) {
    const mi = usable.reduce((s, m) => s + m.idx, 0) / usable.length;
    const fit = glmMAP(
      usable.map(m => [1, m.idx - mi]), usable.map(m => m.attacks),
      [100, 1], 'poisson', usable.map(m => Math.log(m.recordDays / 30))
    );
    if (fit) trend = effectOf(fit.beta[1], Math.sqrt(fit.cov[1][1]));
  }
  return { list, trend };
}

// ---------------- 经期分析 ----------------
export function periodAnalysis(state, rows) {
  const starts = periodStarts(state.days);
  if (starts.length < 2) return { starts, enough: false };
  const first = shiftKey(starts[0], -2), last = shiftKey(starts[starts.length - 1], 35);
  let inW = 0, tot = 0;
  for (const a of state.attacks) {
    const k = attackDay(a);
    if (k < first || k > last) continue;
    tot++;
    if (inPeriodWindow(k, starts)) inW++;
  }
  const today = todayKey();
  const cycles = starts.filter(s => shiftKey(s, 3) < today).slice(-3).map(s => ({
    start: s,
    hit: state.attacks.some(a => { const d = daysBetween(s, attackDay(a)); return d >= -2 && d <= 3; }),
  }));
  const gaps = [];
  for (let i = 1; i < starts.length; i++) {
    const g = daysBetween(starts[i - 1], starts[i]);
    if (g >= 15 && g <= 60) gaps.push(g);
  }
  const recent = gaps.slice(-6);
  const cycleLen = recent.length ? Math.round(recent.reduce((s, g) => s + g, 0) / recent.length) : null;
  let next = cycleLen ? shiftKey(starts[starts.length - 1], cycleLen) : null;
  while (next && next < today) next = shiftKey(next, cycleLen);
  const uni = univariate(rows, featureByKey('period'));
  return { starts, enough: true, inW, tot, share: tot ? inW / tot : null, cycles, cycleLen, next, uni };
}

// ---------------- 发作时间规律 ----------------
export function timing(attacks) {
  const bins = [
    { label: '凌晨', sub: '0–6 点', n: 0 },
    { label: '上午', sub: '6–12 点', n: 0 },
    { label: '下午', sub: '12–18 点', n: 0 },
    { label: '晚上', sub: '18–24 点', n: 0 },
  ];
  const week = new Array(7).fill(0);
  for (const a of attacks) {
    const d = new Date(a.start);
    bins[Math.floor(d.getHours() / 6)].n++;
    week[d.getDay()]++;
  }
  return { bins, week, total: attacks.length };
}

// ---------------- 用药 ----------------
export function medStats(state, month) {
  const byName = new Map();
  for (const a of state.attacks) {
    for (const m of a.meds || []) {
      const name = (m.name || '').trim() || '未命名';
      if (!byName.has(name)) byName.set(name, { name, uses: 0, rated: 0, full: 0, partial: 0, none: 0, relief: [] });
      const s = byName.get(name);
      s.uses++;
      if (m.effect != null) {
        s.rated++;
        if (m.effect === 2) s.full++; else if (m.effect === 1) s.partial++; else s.none++;
        if (m.effect > 0 && m.relief != null) s.relief.push(m.relief);
      }
    }
  }
  const list = [...byName.values()].map(s => ({
    ...s, avgRelief: s.relief.length ? s.relief.reduce((x, y) => x + y, 0) / s.relief.length : null,
  })).sort((a, b) => b.uses - a.uses);

  // 本月止痛药（急性用药）天数
  const m0 = dkey(startOfMonth(month)), m1 = dkey(addMonths(month, 1));
  const days = new Set();
  for (const a of state.attacks) {
    const k = attackDay(a);
    if (k >= m0 && k < m1 && (a.meds || []).length) days.add(k);
  }
  for (const [k, d] of Object.entries(state.days)) {
    if (k >= m0 && k < m1 && (d.meds || []).some(m => m.kind !== 'preventive')) days.add(k);
  }
  return { list, acuteDays: days.size };
}

export function taggedTriggers(attacks) {
  const c = new Map();
  for (const a of attacks) for (const t of a.triggers || []) c.set(t, (c.get(t) || 0) + 1);
  return [...c.entries()].map(([name, n]) => ({ name, n, share: n / attacks.length })).sort((a, b) => b.n - a.n);
}

// ---------------- 汇总 ----------------
export function analyze(state) {
  const today = todayKey();
  const rows = buildRows(state, { endKey: today });
  const nDays = rows.length, nAttacks = rows.reduce((s, r) => s + r.y, 0);
  const out = {
    rows, nDays, nAttacks,
    ready: nDays >= MIN_DAYS && nAttacks >= MIN_ATTACKS,
    needDays: Math.max(0, MIN_DAYS - nDays),
    needAttacks: Math.max(0, MIN_ATTACKS - nAttacks),
    baseRate: nDays ? nAttacks / nDays : null,
  };
  if (!out.ready) return out;
  const feats = eligibleFeatures(rows);
  out.feats = feats;
  if (!feats.length) return out;
  const model = fitLogit(rows, feats);
  if (!model) return out;
  out.model = model;
  out.effects = feats.map((F, j) => ({
    F, ...effectOf(model.beta[j + 1], Math.sqrt(model.cov[j + 1][j + 1])), uni: univariate(rows, F),
  })).sort((a, b) => b.level - a.level || Math.abs(Math.log(b.or)) - Math.abs(Math.log(a.or)));
  out.auc = cvAUC(rows, feats);

  if (hasDayData(state.days[today]) && out.auc != null && out.auc >= 0.6) {
    const f = featuresFor(state, today, periodStarts(state.days));
    const p = model.predict(f);
    const drivers = feats.map((F, j) => ({
      F, c: model.beta[j + 1] * ((f[F.key] ?? model.means[j]) - model.means[j]), on: f[F.key] === 1,
    })).filter(d => d.on && d.c > 0.1).sort((a, b) => b.c - a.c).map(d => d.F);
    out.forecast = { p, ratio: p / out.baseRate, drivers };
  }
  return out;
}
