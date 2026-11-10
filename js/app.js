import * as db from './db.js';
import {
  WEEK, dkey, parseKey, shiftKey, todayKey, startOfMonth, addMonths, daysBetween, hhmm, toLocalInput, md, mdw, uid, esc, fmtNum, pct,
  SEVERITY, SYMPTOMS, DURATIONS, durationOf, TRIGGERS, EFFECTS, RELIEF, STRESS, MEALS, DEFAULT_MEDS, icon,
  vasOf, sevOfVas, vasWord, REGIONS, REGION_IDS, LAT_LABEL, laterality, regionSummary, QUALITIES,
  MOOD, MOOD_SHORT, FEELINGS_NEG, FEELINGS_POS, MOOD_FACTORS, stressOf,
  UNCAT, FOOD_CATALOG, EXERCISE_CATALOG, INTENSITY, SCALES, SCALE_OPTIONS, scaleBand, scaleLevel, CAFFEINE_ITEMS,
} from './util.js';
import { headSVG, VIEWS, VIEW_REGIONS } from './headmap.js';
import * as S from './stats.js';

// ======================= 状态 =======================
const state = {
  attacks: [],
  days: {},
  settings: { name: '', meds: DEFAULT_MEDS.map(m => ({ ...m })), customTriggers: [], hideInstall: false },
};
const ui = { tab: 'home', prevTab: null, month: startOfMonth(new Date()), sel: todayKey(), sheet: null, today: null };
let cache = null;
const analysis = () => (cache ||= S.analyze(state));
const invalidate = () => { cache = null; };

const $app = document.getElementById('app');
const $sheet = document.getElementById('sheet-root');
const $toast = document.getElementById('toast');

// ======================= 存取 =======================
// 旧版本的记录没有 VAS、部位图和疼痛性质：读取时补上默认值（不改动已存的数据）
function normalizeAttack(a) {
  return { ...a, vas: vasOf(a), severity: sevOfVas(vasOf(a)), regions: a.regions || [], qualities: a.qualities || [] };
}

async function load() {
  const { attacks, days, meta } = await db.loadAll();
  state.attacks = attacks.map(normalizeAttack).sort((a, b) => b.start.localeCompare(a.start));
  state.days = Object.fromEntries(days.map(d => [d.date, d]));
  const s = meta.find(m => m.key === 'settings');
  if (s) Object.assign(state.settings, s.value);
  // 旧版「AI 记录」的设置（含密钥）已经不用了：读取时顺手删掉
  if (meta.some(m => m.key === 'ai')) db.remove('meta', 'ai');
  try { localStorage.removeItem('qe-draft'); } catch { /* ignore */ }
}

let persistAsked = false;
function afterWrite() {
  invalidate();
  if (!persistAsked) { persistAsked = true; db.requestPersist(); }
}

const saveSettings = () => db.put('meta', { key: 'settings', value: state.settings });

function saveDay(day) {
  if (S.keepDay(day)) {
    state.days[day.date] = day;
    db.put('days', day);
  } else {
    delete state.days[day.date];
    db.remove('days', day.date);
  }
  afterWrite();
}

// 只保存、不重绘（用于输入框打字、拖动滑块），关闭弹层时再刷新主界面
function patchDay(k, fn) {
  const day = structuredClone(state.days[k] || { date: k });
  fn(day);
  saveDay(day);
}

function mutateDay(k, fn) {
  const day = structuredClone(state.days[k] || { date: k });
  fn(day);
  saveDay(day);
  renderSheet();
  render();
}

function upsertAttack(a) {
  const i = state.attacks.findIndex(x => x.id === a.id);
  if (i >= 0) state.attacks[i] = a; else state.attacks.push(a);
  state.attacks.sort((x, y) => y.start.localeCompare(x.start));
  db.put('attacks', a);
  const k = S.attackDay(a);
  if (state.days[k]?.pain === 0) {
    const day = structuredClone(state.days[k]);
    delete day.pain;
    saveDay(day);
  }
  afterWrite();
}

function deleteAttack(id) {
  state.attacks = state.attacks.filter(a => a.id !== id);
  db.remove('attacks', id);
  afterWrite();
}

// ======================= 小工具 =======================
const attacksOn = k => state.attacks.filter(a => S.attackDay(a) === k);
const maxVas = list => list.reduce((m, a) => Math.max(m, vasOf(a)), 0);
function dosesOn(k) {
  const out = [];
  for (const a of attacksOn(k)) for (const m of a.meds || []) out.push(m);
  for (const m of state.days[k]?.meds || []) out.push(m);
  return out;
}
function parseLocal(s) {
  const [d, t = '00:00'] = s.split('T');
  const [y, m, dd] = d.split('-').map(Number), [hh, mm] = t.split(':').map(Number);
  return new Date(y, m - 1, dd, hh || 0, mm || 0);
}
function streakDays() {
  const has = k => S.hasDayData(state.days[k]) || attacksOn(k).length > 0;
  let k = todayKey();
  if (!has(k)) k = shiftKey(k, -1);
  let n = 0;
  while (has(k)) { n++; k = shiftKey(k, -1); }
  return n;
}
const fmtOR = x => x >= 10 ? x.toFixed(0) : x >= 0.995 ? x.toFixed(1) : x.toFixed(2);
const fmtPts = x => Math.abs(x) < 0.05 ? '0.0' : `${x > 0 ? '+' : '−'}${Math.abs(x).toFixed(1)}`;
const mean = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;

let toastTimer;
function toast(msg) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.remove('show'), 2200);
}

const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

// ======================= 渲染 =======================
const TABS = [['home', '今日', 'sunrise'], ['records', '手记', 'book'], ['analysis', '洞察', 'eye'], ['me', '我的', 'user']];

function render() {
  if (ui.island) closeIsland(true);
  const views = { home: viewHome, records: viewRecords, analysis: viewAnalysis, me: viewMe };
  const anim = ui.tab !== ui.prevTab;
  if (anim) window.scrollTo(0, 0);
  ui.prevTab = ui.tab;
  $app.innerHTML = `
    <main class="view v-${ui.tab} ${anim ? 'anim' : ''}">${views[ui.tab]()}</main>
    <nav class="tabbar" aria-label="主导航">
      ${TABS.map(([k, label, ic]) => `<button class="tab ${ui.tab === k ? 'on' : ''} ${ui.tab === k && anim ? 'just' : ''}" data-act="tab" data-tab="${k}" ${ui.tab === k ? 'aria-current="page"' : ''}>${icon(ic, 23, 1.8)}<span>${label}</span></button>`).join('')}
    </nav>`;
  if (anim) countUp($app);
  else popLast($app);
  if (ui.tab === 'me') updatePersistInfo();
  document.documentElement.dataset.tab = ui.tab;
  // 系统自己画状态栏的那些 iOS 版本，状态栏取页面底色：首页让它和画的天顶同色，其他页面用页面底色
  const tc = ui.tab === 'home' ? ['#CAC4F1', '#656284'] : ['#F5F2EC', '#0F1016'];
  document.querySelectorAll('meta[name="theme-color"]').forEach((m, i) => { m.content = tc[i]; });
}

// 轻点反馈：重新渲染后，给刚点过的那个元素加一个弹跳动画
const POP_ACTS = new Set(['c-feel', 'c-factor', 'c-int', 'log-cat', 'log-kind', 'log-sel', 'scale-ans', 'head-view', 'figure', 'a-toggle','a-dur', 'region', 'a-med-effect', 'a-med-relief', 'a-ago', 'c-meal', 'c-ex', 'c-sleep-set', 'c-period', 'sel-day', 'med-kind']);
let lastHit = null;
const hitKey = el => `${el.dataset.act}|${el.dataset.v ?? el.dataset.id ?? el.dataset.i ?? el.dataset.k ?? el.dataset.m ?? ''}`;
function popLast(root) {
  if (!lastHit) return;
  const act = lastHit.split('|')[0];
  root.querySelectorAll(`[data-act="${act}"]`).forEach(el => { if (hitKey(el) === lastHit) el.classList.add('pop'); });
  lastHit = null;
}

// 数字从 0 滚动到目标值
function countUp(root) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  root.querySelectorAll('[data-count]').forEach(el => {
    const target = +el.dataset.count, dec = +(el.dataset.dec || 0), t0 = performance.now(), dur = 900;
    const txt = el.firstChild;
    if (!txt || txt.nodeType !== 3 || !isFinite(target)) return;
    const step = now => {
      const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      txt.textContent = (target * e).toFixed(dec);
      if (p < 1) requestAnimationFrame(step);
    };
    txt.textContent = (0).toFixed(dec);
    requestAnimationFrame(step);
    // 万一动画帧被系统暂停，也保证最后显示的是真实数值
    setTimeout(() => { txt.textContent = target.toFixed(dec); }, dur + 150);
  });
}
const counted = (v, dec = 0) => v == null || !isFinite(v) ? '—' : `<span data-count="${v}" data-dec="${dec}">${Number(v).toFixed(dec)}</span>`;

const header = (eyebrow, title, right = '') => `<header class="top"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1></div>${right}</header>`;

// ----------------------- 今天 -----------------------
const TILES = [
  { k: 'period', label: '经期', ic: 'drop', color: 'var(--t-period)' },
  { k: 'diet', label: '饮食', ic: 'bowl', color: 'var(--t-diet)' },
  { k: 'sleep', label: '睡眠', ic: 'sleep', color: 'var(--t-sleep)' },
  { k: 'mood', label: '心情', ic: 'heart', color: 'var(--t-stress)' },
  { k: 'exercise', label: '运动', ic: 'stretch', color: 'var(--t-exercise)' },
  { k: 'meds', label: '服药', ic: 'pill', color: 'var(--t-meds)' },
];

function tileValue(k, date) {
  const d = state.days[date] || {};
  switch (k) {
    case 'period':
      if (d.period === true) return [true, `第 ${S.periodDayNumber(state.days, date)} 天`];
      return d.period === false ? [true, '不在经期'] : [false, '未记录'];
    case 'diet': {
      const foods = d.foods || [];
      if (!d.meals && d.caffeine == null && d.alcohol == null && !foods.length) return [false, '未记录'];
      const parts = [];
      if (d.meals) { const n = MEALS.filter(([m]) => d.meals[m]).length; parts.push(n ? `${n} 餐` : '漏餐'); }
      if (foods.length) parts.push(foods.length === 1 ? foods[0].item : `${foods.length} 样`);
      else if (S.caffeineOf(d)) parts.push(`咖啡因 ${S.caffeineOf(d)}`);
      if (!parts.length && S.alcoholOf(d)) parts.push('饮酒');
      return [true, parts.join(' · ') || '已记录'];
    }
    case 'sleep': return d.sleep != null ? [true, `${d.sleep} 小时`] : [false, '未记录'];
    case 'mood':
      if (d.mood?.valence) return [true, MOOD_SHORT[d.mood.valence - 1]];
      if (d.mood?.feelings?.length) return [true, d.mood.feelings[0]];
      return d.stress ? [true, `压力${STRESS[d.stress]}`] : [false, '未记录'];
    case 'exercise': {
      const w = d.workouts || [];
      if (d.exercise == null && !w.length) return [false, '未记录'];
      if (d.exercise === 0 && !w.length) return [true, '没有运动'];
      return [true, [d.exercise ? `${d.exercise} 分钟` : '', w[0]?.item].filter(Boolean).join(' · ')];
    }
    case 'meds': { const n = dosesOn(date).length; return n ? [true, `${n} 次`] : [false, '未服药']; }
  }
  return [false, ''];
}

function installBanner() {
  if (!isIOS || isStandalone() || state.settings.hideInstall) return '';
  return `<div class="banner"><span class="li-ic gl">${icon('download', 18, 2)}</span><div class="grow"><b>添加到主屏幕</b>点 Safari 的「分享」按钮，选「添加到主屏幕」。之后从桌面图标打开，像 App 一样使用，数据一直保存在这台手机上。</div>
    <button class="icon-btn" data-act="hide-install" aria-label="不再提示">${icon('x', 18)}</button></div>`;
}

// ----------------------- 今天：一屏记完 -----------------------
// 疼痛程度放最前（0 = 今天没有头痛）；疼了才展开门诊问诊的其余几项：时间和持续、侧别、性质、伴随症状、用药、对日常的影响。
// 下面一组诱因：睡眠、喝了什么、月经、天气。改动先存草稿，点「保存」一次写入；详细记录在「手记」里。
// 首页的点选都在原地更新（不重绘整页），展开、收起和用药的「灵动岛」才有连贯的过渡。
const SIDES = [['L', '左'], ['R', '右'], ['B', '两侧'], ['all', '整个头']];
const SIDE_LOC = { L: '左侧', R: '右侧', B: '双侧' };
const QUICK_Q = [['跳痛 / 搏动感', '跳痛'], ['压迫 / 紧箍感', '紧箍'], ['胀痛', '胀痛'], ['刺痛', '刺痛'], ['钝痛', '钝痛']];
const QUICK_SYM = [['恶心', '恶心'], ['呕吐', '呕吐'], ['畏光', '怕光'], ['畏声', '怕吵'], ['视觉先兆', '闪光']];
const IMPACT = ['没耽误', '有点耽误', '做不了事'];
const IMPACT_SHORT = ['没有', '有点', '做不了事'];
const EFFECT_SHORT = ['无效', '部分', '完全'];
// 喝了什么：[按钮文字, 饮食大类, 记录的项目]；咖啡、茶、奶茶会自动算作咖啡因
const DRINKS = [['咖啡', '饮品', '咖啡'], ['茶', '饮品', '浓茶'], ['奶茶', '饮品', '奶茶'], ['酒', '酒类', '酒']];
const drinkMatch = (f, [label, , item]) => label === '酒' ? f.cat === '酒类' : f.item === item;
const drinkOn = (d, x) => (d.foods || []).some(f => drinkMatch(f, x)) || (x[0] === '酒' && d.alcohol === true);
// 持续多久：几个好点的预设（存的还是原来的时长档位，旧记录照常显示）
const DUR_PRESETS = [['lt2', '不到 2 小时'], ['2-4', '2–4 小时'], ['4-12', '半天'], ['12-24', '一整天'], ['gt24', '超过一天'], ['ongoing', '还在疼']];
const durText = k => DUR_PRESETS.find(x => x[0] === k)?.[1] || '';
const AGO = [[0, '刚刚'], [30, '半小时前'], [60, '1 小时前'], [120, '2 小时前']];
const pad2 = n => String(n).padStart(2, '0');
// 时间选择（开始时间和每种药的服药时间共用）：who 是 '@start' 或药名
const timeOf = (t, who) => who === '@start' ? (t.a.start.split('T')[1] || '') : (t.a.meds.find(m => m.name === who)?.time || '');
function setTimeOf(t, who, time) { const m = t.a.meds.find(x => x.name === who); if (m) m.time = time; }
// 开始时间可以是今天、昨天或前天：过了零点才来记，或者已经疼了一两天的，都能照实记。只有「还没到的时间」不能选
const DAY_WHEEL = ['前天', '昨天', '今天'];
const startOff = t => Math.min(0, daysBetween(t.date, t.a.start.split('T')[0]));
const startLabel = t => { const off = startOff(t), day = t.a.start.split('T')[0]; return `${off === 0 ? '' : off >= -2 ? DAY_WHEEL[off + 2] + ' ' : md(day) + ' '}${timeOf(t, '@start')}`; };
function setStart(t, start) { const now = toLocalInput(new Date()); t.a.start = start > now ? now : start; }
const TODAY_KEY = 'today-draft';

const attackToToday = a => ({
  ...structuredClone(a), start: toLocalInput(new Date(a.start)), impact: a.impact ?? null,
  regions: a.regions || [], qualities: a.qualities || [], symptoms: a.symptoms || [], triggers: a.triggers || [], meds: a.meds || [],
});
// 只选了左右（没画部位图）时存成 locations；选了「整个头」存成全部区域；画过部位图的在部位图里改
function sideOf(a) {
  if (a.regions.length === REGION_IDS.length) return 'all';
  if (a.regions.length) return null;
  const loc = a.locations || [];
  return loc.includes('左侧') ? 'L' : loc.includes('右侧') ? 'R' : loc.includes('双侧') ? 'B' : '';
}
function buildToday() {
  const tk = todayKey(), d = state.days[tk] || {}, atk = attacksOn(tk)[0] || state.attacks.find(a => a.homeDay === tk);
  const drinks = DRINKS.filter(x => drinkOn(d, x)).map(x => x[0]);
  return {
    date: tk, dirty: false, saved: !!atk || S.hasDayData(d), island: null,
    vas: atk ? vasOf(atk) : 0,
    a: atk ? attackToToday(atk) : { ...newAttackDraft(tk), impact: null },
    sleep: d.sleep ?? null,
    drinks: drinks.length ? drinks : d.caffeine === 0 ? ['none'] : [],
    period: !!d.period, weather: !!d.weather,
  };
}
// 没改动时总是按已保存的数据显示；有没保存的改动时保留草稿（也存一份到本机，切走再回来不会丢）
function todayState() {
  const tk = todayKey();
  if (!ui.today || ui.today.date !== tk) {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(TODAY_KEY) || 'null'); } catch { /* ignore */ }
    // 草稿格式不对（比如旧版本留下的）就不用
    const ok = saved && saved.date === tk && saved.dirty && typeof saved.vas === 'number' && saved.a?.start && Array.isArray(saved.a.meds);
    ui.today = ok ? saved : buildToday();
  } else if (!ui.today.dirty) ui.today = buildToday();
  return ui.today;
}
function keepDraft() {
  ui.today.dirty = true;
  try { localStorage.setItem(TODAY_KEY, JSON.stringify(ui.today)); } catch { /* ignore */ }
}
function editToday(fn) {
  fn(ui.today);
  keepDraft();
  syncToday();
}

function todayOn(t, el) {
  const a = t.a, { act, v } = el.dataset;
  switch (act) {
    case 't-side': return sideOf(a) === v;
    case 't-q': return a.qualities.includes(v);
    case 't-sym': return a.symptoms.includes(v);
    case 't-impact': return a.impact === +v;
    case 't-drink': return t.drinks.includes(v);
    case 't-period': return t.period;
    case 't-weather': return t.weather;
    case 't-med': return a.meds.some(m => m.name === v);
    case 't-island': return v === '@dur' ? !!a.duration : null;
    default: return null;
  }
}
const vasLabel = v => v > 0 ? `<b>${v}</b>${vasWord(v)}` : '<b>0</b>没有头痛';
const sleepLabel = v => `<b>${v ?? '–'}</b>小时`;
function periodDay(t) {
  if (!t.period) return 0;
  if (state.days[t.date]?.period) return S.periodDayNumber(state.days, t.date);
  const y = shiftKey(t.date, -1);
  return state.days[y]?.period ? S.periodDayNumber(state.days, y) + 1 : 1;
}
const periodText = t => t.period ? `经期第 ${periodDay(t)} 天` : '不在经期';
const weatherText = t => t.weather ? '变天了' : '没变化';
// ---- 时间滚轮和「灵动岛」面板 ----
// 点一下时间、持续多久或某种药，从那一颗里弹出一块大面板（盖在上面，不挤别的选项）；点别处就弹回去收起。
// 展开、收起只动 transform 和 opacity，不触发重新排版，手机上才跟手。
const ITEM_H = 40;
const HOURS = Array.from({ length: 24 }, (_, i) => String(i)), MINS = Array.from({ length: 60 }, (_, i) => pad2(i));
const DUR_WHEEL = [[null, '说不准'], ...DUR_PRESETS];
const WHEEL_NAME = { day: '哪一天', h: '几点', m: '几分', d: '持续多久' };
const wheel = (name, items, idx, cls = '') => `<div class="wheel ${cls}" data-wheel="${name}" data-i="${idx}" role="group" aria-label="${WHEEL_NAME[name]}"><div class="wh-pad"></div>${
  items.map((l, i) => `<button class="wh-i ${i === idx ? 'on' : ''}" data-act="isl-pick" data-i="${i}">${l}</button>`).join('')}<div class="wh-pad"></div></div>`;
const timeWheels = (time, day = null) => {
  const [h, m] = (/^\d{1,2}:\d{2}$/.test(time || '') ? time : hhmm(new Date())).split(':').map(Number);
  return `<div class="wheels ${day == null ? '' : 'w3'}"><div class="wh-band"></div>${day == null ? '' : wheel('day', DAY_WHEEL, day, 'wday')}${wheel('h', HOURS, h)}<span class="wh-colon">:</span>${wheel('m', MINS, m)}</div>`;
};
const agoOn = (t, v) => !!ui.ago && ui.ago.v === String(v) && ui.ago.start === t.a.start;
function islandHTML(t, k) {
  const head = (title, sub, extra = '') => `<div class="isl-head"><b>${title}</b><span class="isl-sub">${sub}</span>${extra}<button class="isl-ok" data-act="isl-close" aria-label="选好了，收起">${icon('check', 18, 2.6)}</button></div>`;
  if (k === '@start') return `<div class="isl-in">${head('开始时间', '什么时候开始疼的')}${timeWheels(timeOf(t, k), Math.max(0, startOff(t) + 2))}
    <div class="isl-foot">${AGO.map(([m, l]) => `<button class="chip mini ${agoOn(t, m) ? 'on' : ''}" data-act="t-ago" data-v="${m}" aria-pressed="${agoOn(t, m)}">${l}</button>`).join('')}</div></div>`;
  if (k === '@dur') return `<div class="isl-in">${head('持续时间', '疼了多久')}
    <div class="wheels"><div class="wh-band"></div>${wheel('d', DUR_WHEEL.map(x => x[1]), Math.max(0, DUR_WHEEL.findIndex(x => x[0] === t.a.duration)), 'wide')}</div></div>`;
  const m = t.a.meds.find(x => x.name === k), n = esc(k);
  // 时间是选填的：默认「不记时间」，滚一下滚轮才算记了几点
  return `<div class="isl-in">${head(n, '已记上', `<button class="isl-del" data-act="t-med-del" data-v="${n}">移除</button>`)}
    <div class="isl-foot"><span class="isl-l">管用吗</span><div class="mc-eff">${EFFECT_SHORT.map((l, v) => `<button class="${m?.effect === v ? 'on' : ''}" data-act="t-eff" data-m="${n}" data-v="${v}" aria-label="${EFFECTS[v].label}">${l}</button>`).join('')}</div></div>
    <div class="isl-foot"><span class="isl-l">几点吃的</span><span class="isl-hint">滚一下就记上</span><button class="chip mini isl-nt ${m?.time ? '' : 'on'}" data-act="t-med-notime" data-v="${n}" aria-pressed="${!m?.time}">不记时间</button></div>
    ${timeWheels(m?.time).replace('class="wheels"', `class="wheels ${m?.time ? '' : 'off'}"`)}</div>`;
}
const $isl = document.createElement('div');
$isl.className = 'isl';
$isl.hidden = true;
document.body.appendChild($isl);
const SPRING = CSS.supports?.('transition-timing-function', 'linear(0, 1)')
  ? 'linear(0, .2 5%, .55 12%, .84 20%, 1.01 28%, 1.07 35%, 1.075 41%, 1.05 50%, 1.015 62%, .997 76%, 1)' : 'cubic-bezier(.3, 1.3, .5, 1)';
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
let islAnims = [], islandSkip = null, wheelTimer = 0, wheelTouched = false, dayTouched = false, dayAuto = false;
const openerOf = k => [...$app.querySelectorAll('[data-isl]')].find(el => el.dataset.isl === k);
const morph = (from, to) => `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`;

function openIsland(k, opener) {
  const t = todayState();
  islAnims.forEach(a => a.cancel());
  islAnims = [];
  clearTimeout(wheelTimer);
  wheelTouched = dayTouched = dayAuto = false;
  ui.island = k;
  $isl.innerHTML = islandHTML(t, k);
  $isl.hidden = false;
  // 盖在点到的这一行上，和面板一样宽；放不下就往上挪，不压住底部导航
  const card = $app.querySelector('.today').getBoundingClientRect(), c = opener.getBoundingClientRect();
  const w = Math.min(card.width - 12, 400), left = card.left + (card.width - w) / 2;
  $isl.style.width = `${w}px`;
  const h = $isl.offsetHeight, bar = $app.querySelector('.tabbar')?.getBoundingClientRect().top ?? innerHeight;
  const top = Math.max(8, Math.min(c.top - 10, bar - h - 10));
  $isl.style.left = `${left}px`;
  $isl.style.top = `${top}px`;
  $isl.querySelectorAll('.wheel').forEach(el => { el.scrollTop = +el.dataset.i * ITEM_H; });
  if (reduceMotion.matches) return;
  islAnims = [
    $isl.animate([{ transform: morph(c, { left, top, width: w, height: h }), opacity: .5 }, { transform: 'none', opacity: 1 }], { duration: 540, easing: SPRING }),
    $isl.firstElementChild.animate([{ opacity: 0 }, { opacity: 0, offset: .2 }, { opacity: 1 }], { duration: 300, easing: 'ease-out' }),
  ];
}
function closeIsland(instant) {
  const k = ui.island;
  if (!k) return;
  commitWheels();
  ui.island = null;
  islAnims.forEach(a => a.cancel());
  islAnims = [];
  const opener = openerOf(k);
  if (instant || !opener || reduceMotion.matches) { $isl.hidden = true; return; }
  // 缩回点开它的那一颗，那一颗再轻轻弹一下
  const out = $isl.animate([{ transform: 'none' }, { transform: morph(opener.getBoundingClientRect(), $isl.getBoundingClientRect()) }], { duration: 300, easing: 'cubic-bezier(.45, 0, .3, 1)', fill: 'forwards' });
  islAnims = [out,
    $isl.animate([{ opacity: 1 }, { opacity: 1, offset: .55 }, { opacity: 0 }], { duration: 300, fill: 'forwards' }),
    $isl.firstElementChild.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 130, fill: 'forwards' }),
    opener.animate([{ transform: 'scale(.93)' }, { transform: 'scale(1.05)', offset: .5 }, { transform: 'scale(1)' }], { duration: 420, delay: 190, easing: 'cubic-bezier(.3, .7, .3, 1)' }),
  ];
  out.onfinish = () => { $isl.hidden = true; islAnims.forEach(a => a.cancel()); islAnims = []; };
}
// 滚轮停在哪一格，就把那个值写进草稿（今天还没到的时间会被拉回「现在」，滚轮也跟着滚回去）
function commitWheels() {
  clearTimeout(wheelTimer);
  const k = ui.island, t = ui.today;
  if (!k || !t || $isl.hidden) return;
  const val = n => { const w = $isl.querySelector(`[data-wheel="${n}"]`); return +(w?.dataset.to ?? w?.dataset.i ?? 0); };
  if (k === '@dur') {
    const v = DUR_WHEEL[val('d')]?.[0] ?? null;
    if (t.a.duration !== v) editToday(({ a }) => { a.duration = v; });
    return;
  }
  const time = `${pad2(val('h'))}:${pad2(val('m'))}`;
  if (k === '@start') {
    // 「今天」里滚到一个还没到的钟点：没亲手选过哪一天，就当作是昨天的这个钟点（再滚回已经过去的钟点，又回到今天）；
    // 亲手选了「今天」，才把时间拉回现在
    let off = val('day') - 2;
    const late = time > hhmm(new Date());
    if (off === 0 && late && !dayTouched) { off = -1; dayAuto = true; }
    else if (off === -1 && dayAuto && !late) { off = 0; dayAuto = false; }
    const start = `${shiftKey(t.date, off)}T${time}`;
    if (t.a.start !== start) editToday(x => setStart(x, start)); else syncIsland();
    return;
  }
  // 药的时间是选填的：没碰过滚轮、也没记过时间，就保持「不记时间」
  if (!timeOf(t, k) && !wheelTouched) return;
  if (timeOf(t, k) !== time) editToday(x => setTimeOf(x, k, time));
}
function syncIsland() {
  const k = ui.island, t = ui.today;
  if (!k || k === '@dur' || $isl.hidden) return;
  const m = k === '@start' ? null : t.a.meds.find(x => x.name === k);
  if (k !== '@start' && !m) return;
  if (m) {
    $isl.querySelectorAll('.mc-eff button').forEach(b => b.classList.toggle('on', m.effect === +b.dataset.v));
    $isl.querySelector('.wheels').classList.toggle('off', !m.time);
    const nt = $isl.querySelector('.isl-nt');
    nt.classList.toggle('on', !m.time);
    nt.setAttribute('aria-pressed', !m.time);
    if (!m.time) return;
  }
  $isl.querySelectorAll('[data-act="t-ago"]').forEach(b => { const on = agoOn(t, b.dataset.v); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
  const [h, mi] = timeOf(t, k).split(':').map(Number);
  [['day', Math.max(0, startOff(t) + 2)], ['h', h], ['m', mi]].forEach(([n, i]) => {
    const w = $isl.querySelector(`[data-wheel="${n}"]`);
    if (w && +(w.dataset.to ?? w.dataset.i) !== i) { w.dataset.to = i; w.scrollTo({ top: i * ITEM_H, behavior: 'smooth' }); }
  });
}
// 手指（或鼠标滚轮）碰过滚轮，才算用户在选时间；打开面板时程序自己把滚轮摆到位不算
['pointerdown', 'touchstart', 'wheel'].forEach(ev => $isl.addEventListener(ev, e => { const w = e.target.closest?.('.wheel'); if (w) { wheelTouched = true; delete w.dataset.to; if (w.dataset.wheel === 'day') { dayTouched = true; dayAuto = false; } } }, { capture: true, passive: true }));
$isl.addEventListener('scroll', e => {
  const w = e.target;
  if (!w.classList?.contains('wheel')) return;
  const n = w.children.length - 2, i = Math.max(0, Math.min(n - 1, Math.round(w.scrollTop / ITEM_H)));
  if (i !== +w.dataset.i) {
    w.children[+w.dataset.i + 1]?.classList.remove('on');
    w.children[i + 1].classList.add('on');
    w.dataset.i = i;
  }
  if (+w.dataset.to === i) delete w.dataset.to;
  clearTimeout(wheelTimer);
  wheelTimer = setTimeout(commitWheels, 140);
}, { capture: true, passive: true });
// 点到面板外面：收起。点的是别的选项，那个选项照常生效；点的是打开它的那一颗，就只是收起
document.addEventListener('pointerdown', e => {
  islandSkip = null;
  if (!ui.island || e.target.closest?.('.isl')) return;
  if (e.target.closest?.('[data-isl]')?.dataset.isl === ui.island) islandSkip = ui.island;
  closeIsland();
}, true);

function todayCards() {
  const t = todayState(), a = t.a, side = sideOf(a);
  const chip = (act, v, label, aria = '') => {
    const on = todayOn(t, { dataset: { act, v: String(v) } });
    return `<button class="chip mini ${on ? 'on' : ''}" data-act="${act}" data-v="${esc(v)}" aria-pressed="${on}"${aria ? ` aria-label="${esc(aria)}"` : ''}>${label}</button>`;
  };
  const row = (label, body, cls = '') => `<div class="trow ${cls}"><span class="trow-l">${label}</span><div class="trow-c">${body}</div></div>`;
  const presets = state.settings.meds.filter(m => m.kind !== 'preventive');
  // 时间和用药：点一下，从这一颗里弹出滚轮面板
  const startChip = `<button class="chip mini tchip" data-act="t-island" data-isl="@start" data-v="@start" aria-label="开始时间">${icon('clock', 14, 2)}<span class="t-start">${startLabel(t)}</span>开始</button>`;
  const durChip = `<button class="chip mini tchip ${a.duration ? 'on' : ''}" data-act="t-island" data-isl="@dur" data-v="@dur"><span class="t-dur">${a.duration ? `持续 ${durText(a.duration)}` : '持续多久'}</span>${icon('chevD', 13, 2.2)}</button>`;
  const medChip = p => {
    const m = a.meds.find(x => x.name === p.name), n = esc(p.name);
    return `<button class="chip mini mchip ${m ? 'on' : ''}" data-act="t-med" data-isl="${n}" data-v="${n}" data-dose="${esc(p.dose)}" aria-pressed="${!!m}"><span class="mc-n">${n}</span><i class="mc-t">${esc(m?.time || '')}</i></button>`;
  };
  const done = !t.dirty && t.saved;
  return `<section class="card today ${t.vas > 0 ? 'has-pain' : ''}"><div class="today-bg"></div>
    ${row('疼痛', `<div class="vas-wrap"><input class="range" type="range" min="0" max="10" step="any" data-snap="1" data-sv="${t.vas}" value="${t.vas}" data-input="t-vas" aria-label="疼痛程度，0 是没有头痛，10 是能想象的最痛">
      <div class="vas-ends" aria-hidden="true"><span>0 不痛</span><span>10 最痛</span></div></div><span class="t-vas" id="t-vas">${vasLabel(t.vas)}</span>`, 'r-vas')}
    <div class="pain-rows"><div>
      ${row('时间', startChip + durChip)}
      ${row('侧别', side === null ? `<span class="t-note">${esc(regionSummary(a))}</span><button class="link-btn" data-act="t-detail">改</button>` : SIDES.map(([k, l]) => chip('t-side', k, l)).join(''))}
      ${row('性质', QUICK_Q.map(([k, l]) => chip('t-q', k, l, k)).join(''))}
      ${row('伴随', QUICK_SYM.map(([k, l]) => chip('t-sym', k, l, k)).join(''))}
      ${row('用药', presets.length ? `<div class="meds-row">${presets.map(medChip).join('')}</div>` : '<span class="t-note">在「我的」里添加常用药</span>')}
      ${row('耽误', IMPACT_SHORT.map((l, i) => chip('t-impact', i, l, `耽误上班、带孩子：${IMPACT[i]}`)).join(''))}
    </div></div>
    <div class="t-div"><span>诱因</span></div>
    ${row('睡眠', `<input class="range sleep-range ${t.sleep == null ? 'unset' : ''}" type="range" min="3" max="12" step="any" data-snap="0.5" value="${t.sleep ?? 7}" data-input="t-sleep-r" aria-label="昨晚睡了几个小时"><span class="t-vas t-sleep" id="t-sleep">${sleepLabel(t.sleep)}</span>`, 'r-vas r-sleep')}
    ${row('喝了', DRINKS.map(([l]) => chip('t-drink', l, l)).join('') + chip('t-drink', 'none', '没喝'))}
    <div class="tgl-row">
      <button class="tgl ${t.period ? 'on' : ''}" data-act="t-period" aria-pressed="${t.period}"><span class="gl" style="--c:var(--t-period)">${icon('drop', 17, 2)}</span><span class="tgl-t"><b>月经</b><i>${periodText(t)}</i></span></button>
      <button class="tgl ${t.weather ? 'on' : ''}" data-act="t-weather" aria-pressed="${t.weather}"><span class="gl" style="--c:var(--t-meds)">${icon('cloud', 17, 1.9)}</span><span class="tgl-t"><b>天气</b><i>${weatherText(t)}</i></span></button>
      <button class="t-save ${done ? 'done' : ''}" data-act="t-save" aria-label="${done ? '今天已记好' : '保存今天的记录'}">${icon('check', 24, 2.6)}</button>
    </div>
  </section>`;
}

// 疼痛从 0 变成有值（或反过来）时，整张面板要重新排一次。排版只做一次（不逐帧挤压），
// 然后每一行、面板的底、顶上的画各自用 transform 从原来的位置滑到新位置，全程不再重新排版
const FLIP_EASE = 'cubic-bezier(.32, .72, 0, 1)';
function flipPain(root, want) {
  if (reduceMotion.matches) { root.classList.toggle('has-pain', want); return; }
  const view = root.closest('.view'), bg = root.querySelector('.today-bg'), sky = view.querySelector('.sky-art'), pr = root.querySelector('.pain-rows');
  const rows = [...root.children].filter(el => el !== bg && el !== pr);
  const rect = el => el.getBoundingClientRect();
  const r0 = rows.map(rect), bg0 = rect(bg), sky0 = sky && rect(sky), pr0 = rect(pr), card0 = rect(root);
  root.classList.toggle('has-pain', want);
  const opt = { duration: 460, easing: FLIP_EASE };
  rows.forEach((el, i) => {
    const b = rect(el), dy = (r0[i].top + r0[i].height / 2) - (b.top + b.height / 2);
    if (Math.abs(dy) > .5) el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], opt);
  });
  const bg1 = rect(bg);
  bg.animate([{ transform: `translateY(${bg0.bottom - bg1.bottom}px) scaleY(${bg0.height / bg1.height})` }, { transform: 'none' }], opt);
  if (sky) sky.animate([{ transform: `translateY(${sky0.bottom - rect(sky).bottom}px)` }, { transform: 'none' }], opt);
  if (want) {
    // 新出现的几行：从上面一点的位置淡入，一行跟着一行
    pr.querySelectorAll('.trow').forEach((el, i) => el.animate([{ opacity: 0, transform: 'translateY(-18px)' }, { opacity: 1, transform: 'none' }],
      { duration: 380, delay: 30 + i * 22, easing: FLIP_EASE, fill: 'backwards' }));
  } else {
    // 要收起的几行：留在原地淡出（不占位置），下面的行同时滑上来
    const card1 = rect(root);
    Object.assign(pr.style, { position: 'absolute', left: `${pr0.left - card1.left}px`, top: `${pr0.top - card0.top}px`, width: `${pr0.width}px`, height: `${pr0.height}px`, gridTemplateRows: '1fr', opacity: 1, pointerEvents: 'none' });
    const out = pr.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-10px)' }], { duration: 180, easing: 'ease-out', fill: 'forwards' });
    const clear = () => { pr.removeAttribute('style'); out.cancel(); };
    out.onfinish = clear;
    pr._clear = clear;
  }
  if (want && pr._clear) { pr._clear(); pr._clear = null; }
}

// 原地同步：只改 class 和文字，让 CSS 过渡自己完成动画
function syncToday() {
  const t = ui.today, a = t.a, root = $app.querySelector('.today');
  if (!root) return;
  if (root.classList.contains('has-pain') !== t.vas > 0) flipPain(root, t.vas > 0);
  root.querySelectorAll('[data-act]').forEach(el => {
    const on = todayOn(t, el);
    if (on == null) return;
    el.classList.toggle('on', on);
    if (el.hasAttribute('aria-pressed')) el.setAttribute('aria-pressed', on);
  });
  root.querySelectorAll('.mchip').forEach(el => { el.querySelector('.mc-t').textContent = a.meds.find(x => x.name === el.dataset.v)?.time || ''; });
  root.querySelector('.t-start').textContent = startLabel(t);
  root.querySelector('.t-dur').textContent = a.duration ? `持续 ${durText(a.duration)}` : '持续多久';
  root.querySelector('.tgl[data-act="t-period"] i').textContent = periodText(t);
  root.querySelector('.tgl[data-act="t-weather"] i').textContent = weatherText(t);
  const btn = root.querySelector('.t-save'), done = !t.dirty && t.saved;
  btn.classList.toggle('done', done);
  btn.setAttribute('aria-label', done ? '今天已记好' : '保存今天的记录');
  syncIsland();
}

function saveToday() {
  const t = todayState(), tk = t.date, a = t.a;
  if (t.vas > 0) {
    const start = parseLocal(a.start);
    if (start > new Date(Date.now() + 5 * 60000)) return toast('开始时间不能晚于现在');
    const rec = {
      id: a.id || uid(), start: start.toISOString(), vas: t.vas, severity: sevOfVas(t.vas),
      regions: a.regions, qualities: a.qualities, symptoms: a.symptoms, duration: a.duration, triggers: a.triggers,
      meds: a.meds.map(({ id, name, dose, time, effect, relief }) => ({ id: id || uid(), name, dose, time, effect, relief })),
      impact: a.impact ?? null, note: (a.note || '').trim(), createdAt: a.createdAt || Date.now(), updatedAt: Date.now(),
    };
    if (!a.regions.length && a.locations?.length) rec.locations = a.locations;
    if (dkey(start) !== tk) rec.homeDay = tk;
    upsertAttack(rec);
  } else if (a.id && state.attacks.some(x => x.id === a.id)) {
    if (!confirm('疼痛选了 0，要删掉今天这次头痛记录吗？')) return;
    deleteAttack(a.id);
  }
  const day = structuredClone(state.days[tk] || { date: tk });
  if (t.vas === 0 && !attacksOn(tk).length) day.pain = 0; else delete day.pain;
  if (t.sleep != null) day.sleep = t.sleep; else delete day.sleep;
  day.period = t.period;
  day.weather = t.weather;
  // 饮品：只增删和这次选择不一致的，饮食记录里写过的备注保留
  day.foods ||= [];
  for (const x of DRINKS) {
    const want = t.drinks.includes(x[0]), has = day.foods.some(f => drinkMatch(f, x));
    if (want && !has) day.foods.push({ id: uid(), cat: x[1], item: x[2], note: '' });
    if (!want && has) day.foods = day.foods.filter(f => !drinkMatch(f, x));
  }
  if (!t.drinks.includes('酒')) delete day.alcohol;
  if (!day.foods.length) delete day.foods;
  if (t.drinks.includes('none')) day.caffeine = 0; else if (day.caffeine === 0) delete day.caffeine;
  saveDay(day);
  ui.today = null;
  try { localStorage.removeItem(TODAY_KEY); } catch { /* ignore */ }
  render();
  toast(t.vas > 0 ? '已保存，好好休息' : '已保存：今天没有头痛');
}

function viewHome() {
  const now = new Date();
  const h = now.getHours();
  const greet = h < 5 ? '夜深了' : h < 11 ? '早安' : h < 14 ? '午安' : h < 18 ? '午后安好' : h < 22 ? '晚风轻柔' : '夜深了';
  const name = (state.settings.name || '').trim();
  const streak = streakDays();
  return `
  <div class="home-sky"><div class="sky-clip" aria-hidden="true"><div class="sky-art"></div></div>
    <header class="top"><div><h1>${greet}${name ? '，' + esc(name) : ''}</h1>
      <div class="home-meta"><span>${now.getMonth() + 1}月${now.getDate()}日 星期${WEEK[now.getDay()]}</span>${streak >= 2 ? `<span class="home-streak">${icon('sun', 13, 2)}连续 ${streak} 天</span>` : ''}</div></div></header></div>
  ${installBanner()}
  ${todayCards()}`;
}

// ----------------------- 记录 -----------------------
function viewRecords() {
  const list = state.attacks;
  const head = header(list.length ? `共 ${list.length} 次头痛` : '还没有头痛记录', '手记');
  // 详细记录：都是选填，不算进首页的「记完」；以前的日子可以在「洞察」的日历里点日期补记
  const row = (act, ic, color, t, sub, data = '') => `<button class="row" data-act="${act}" ${data}><span class="li-ic gl" style="--c:${color}">${icon(ic, 18, 2)}</span>
    <div class="grow"><div class="t">${t}</div><div class="s">${sub}</div></div><span class="chev">${icon('chevR', 18)}</span></button>`;
  const details = `<div class="group-label"><span>详细记录 · 选填</span></div>
    <div class="group">
      ${row('new-attack', 'cloud', 'var(--pain)', '完整头痛记录', '部位图、诱因、备注，也可以补记以前的')}
      ${row('tile', 'heart', 'var(--t-stress)', '心情', '今天的心情，焦虑 / 抑郁自评', 'data-k="mood"')}
      ${row('tile', 'bowl', 'var(--t-diet)', '饮食', '今天吃了什么、三餐', 'data-k="diet"')}
      ${row('tile', 'stretch', 'var(--t-exercise)', '运动', '今天的运动时长、强度', 'data-k="exercise"')}
      ${row('tile', 'pill', 'var(--t-meds)', '日常用药', '预防药等不在头痛时吃的药', 'data-k="meds"')}
    </div>`;
  if (!list.length) return head + details;
  const groups = new Map();
  for (const a of list) {
    const k = S.attackDay(a).slice(0, 7);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }
  let html = head + details;
  for (const [k, arr] of groups) {
    const [y, m] = k.split('-');
    html += `<div class="group-label"><span>${y}年${+m}月</span><span>${arr.length} 次 · 平均 ${fmtNum(mean(arr.map(vasOf)))} 分</span></div>
      <div class="group recs">${arr.map(recordRow).join('')}</div>`;
  }
  return html;
}

function recordRow(a) {
  const d = new Date(a.start), k = S.attackDay(a), v = vasOf(a);
  const l2 = [regionSummary(a), a.duration ? durationOf(a.duration).label : ''].filter(Boolean).join(' · ');
  const tags = [...(a.qualities || []), ...(a.symptoms || []).slice(0, 2), ...(a.triggers || []).slice(0, 3)];
  return `<button class="row rec" data-act="edit-attack" data-id="${a.id}">
    <div class="vas-badge s${sevOfVas(v)}" aria-label="强度 ${v} 分">${v}</div>
    <div class="grow">
      <div class="t">${md(k)} 周${WEEK[d.getDay()]} · ${hhmm(d)}${state.days[k]?.period ? ' <span class="badge" style="background:var(--period-soft);color:var(--period)">经期</span>' : ''}</div>
      ${l2 ? `<div class="l2">${esc(l2)}</div>` : ''}
      ${tags.length ? `<div class="tags">${tags.map(t => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
      ${a.meds?.length ? `<div class="meds">${a.meds.map(m => `<div>${icon('pill', 15)}${esc(m.name)} ${esc(m.dose || '')}${m.effect != null ? ` · ${EFFECTS[m.effect].label}` : ''}${m.effect > 0 && m.relief ? `（${m.relief < 1 ? '半小时' : m.relief + ' 小时'}）` : ''}</div>`).join('')}</div>` : ''}
      ${a.note ? `<div class="l2 muted">${esc(a.note)}</div>` : ''}
    </div>
    <span class="chev">${icon('chevR', 18)}</span>
  </button>`;
}

// ----------------------- 分析 -----------------------
function viewAnalysis() {
  const m0 = ui.month, cur = startOfMonth(new Date());
  const isCur = m0.getTime() >= cur.getTime();
  const mk = dkey(m0).slice(0, 7), pk = dkey(addMonths(m0, -1)).slice(0, 7);
  const inMonth = state.attacks.filter(a => S.attackDay(a).startsWith(mk));
  const prevN = state.attacks.filter(a => S.attackDay(a).startsWith(pk)).length;
  const durs = inMonth.map(a => durationOf(a.duration)?.h).filter(h => h != null);
  const delta = inMonth.length - prevN;
  const acuteDays = S.medStats(state, m0).acuteDays;
  const all = state.attacks;

  return `
  ${header('偏晴 · 偏头痛日记', '洞察', `<div class="month-nav">
      <button class="icon-btn" data-act="month" data-d="-1" aria-label="上个月">${icon('chevL', 20)}</button>
      <span>${m0.getFullYear()}年${m0.getMonth() + 1}月</span>
      <button class="icon-btn" data-act="month" data-d="1" aria-label="下个月" ${isCur ? 'disabled' : ''}>${icon('chevR', 20)}</button></div>`)}
  <div class="stats">
    <div class="stat"><div class="k">头痛次数</div><div class="v">${counted(inMonth.length)}<small>次</small></div><div class="d">${delta === 0 ? '与上月持平' : `比上月${delta > 0 ? '多' : '少'} ${Math.abs(delta)} 次`}</div></div>
    <div class="stat"><div class="k">平均强度</div><div class="v">${inMonth.length ? counted(Number(fmtNum(mean(inMonth.map(vasOf)))), 1) : '—'}<small>/10</small></div><div class="d">${inMonth.length ? vasWord(Math.round(mean(inMonth.map(vasOf)))) : '本月无记录'}</div></div>
    <div class="stat"><div class="k">平均持续</div><div class="v">${durs.length ? counted(Number(fmtNum(mean(durs))), 1) : '—'}<small>小时</small></div><div class="d">按所选时长估算</div></div>
    <div class="stat"><div class="k">止痛药</div><div class="v">${counted(acuteDays)}<small>天</small></div><div class="d">${acuteDays >= 10 ? '偏多，留意一下' : '本月用药天数'}</div></div>
  </div>
  ${calendarCard()}
  ${forecastCard(analysis())}
  <div class="sec"><h2>头痛特征</h2><span class="meta">全部 ${all.length} 次</span></div>
  ${locationCard(all)}
  ${qualityCard(all)}
  ${timingCard()}
  <div class="sec"><h2>诱因分析</h2><button class="icon-btn" data-act="method" aria-label="分析方法说明" style="margin-left:auto">${icon('info', 20)}</button></div>
  ${triggerCards()}
  <div class="sec"><h2>心理状态</h2></div>
  ${mindCard(analysis())}
  <div class="sec"><h2>规律与趋势</h2></div>
  ${trendMonthsCard()}
  ${periodCard(analysis())}
  <div class="sec"><h2>用药</h2></div>
  ${medsCard()}
  <p class="note" style="text-align:center;margin:20px 12px 0">分析结果只反映记录中的关联，不能替代医生诊断。</p>`;
}

function calendarCard() {
  const m0 = ui.month, y = m0.getFullYear(), mo = m0.getMonth();
  const nDays = new Date(y, mo + 1, 0).getDate(), lead = (m0.getDay() + 6) % 7, tk = todayKey();
  let cells = ['一', '二', '三', '四', '五', '六', '日'].map(w => `<div class="wd">${w}</div>`).join('');
  cells += '<div></div>'.repeat(lead);
  for (let i = 1; i <= nDays; i++) {
    const k = dkey(new Date(y, mo, i)), v = maxVas(attacksOn(k)), s = sevOfVas(v), d = state.days[k];
    const meds = dosesOn(k).length > 0, fut = k > tk;
    const label = [`${mo + 1}月${i}日`, v ? `头痛 ${v} 分` : '', d?.period ? '经期' : '', meds ? '服药' : ''].filter(Boolean).join('，');
    cells += `<button class="cell ${s ? 's' + s : ''} ${k === tk ? 'today' : ''} ${fut ? 'future' : ''} ${ui.sel === k ? 'sel' : ''}" data-act="sel-day" data-k="${k}" aria-label="${label}" ${fut ? 'disabled' : ''}>
      <span class="n">${i}</span><span class="marks">${d?.period ? '<i class="p"></i>' : ''}${meds ? '<i class="m"></i>' : ''}</span></button>`;
  }
  return `<section class="card">
    <div class="card-head"><h3>头痛日历</h3><span class="meta">点日期看这天的全部记录</span></div>
    <div class="cal">${cells}</div>
    <div class="legend">
      <span><i class="dot" style="background:var(--sev1)"></i>轻</span>
      <span><i class="dot" style="background:var(--sev2)"></i>中</span>
      <span><i class="dot" style="background:var(--sev3)"></i>重</span>
      <span><i class="bar-key" style="background:var(--period)"></i>经期</span>
      <span><i class="dot" style="background:var(--med);width:6px;height:6px"></i>服药</span>
    </div>
    ${dayDetail(ui.sel)}
  </section>`;
}

// 点日历上的某一天：列出这天记过的所有内容（兼容各个版本的旧字段）
function dayDetail(k) {
  if (!k || k.slice(0, 7) !== dkey(ui.month).slice(0, 7) || k > todayKey()) return '';
  const atk = attacksOn(k).slice().reverse(), d = state.days[k] || {};
  const kv = (label, value) => value ? `<div class="dd-row"><span>${label}</span><div>${value}</div></div>` : '';
  const list = arr => (arr || []).filter(Boolean).map(esc).join('、');
  const medLine = m => [`${esc(m.name)}${m.dose ? ' ' + esc(m.dose) : ''}`, m.time ? esc(m.time) : '',
    m.effect != null ? EFFECTS[m.effect].label + (m.effect > 0 && m.relief ? `（${m.relief < 1 ? '半小时' : m.relief + ' 小时'}起效）` : '') : ''].filter(Boolean).join(' · ');
  const attacks = atk.map(a => {
    const v = vasOf(a), dur = durationOf(a.duration);
    return `<div class="dd-block">
      <button class="dd-head" data-act="edit-attack" data-id="${a.id}"><span class="vb s${sevOfVas(v)}">${v}</span>
        <b>${hhmm(new Date(a.start))} 开始头痛</b><span class="muted">${vasWord(v)}</span><span class="chev">${icon('chevR', 16)}</span></button>
      ${kv('持续', dur ? esc(dur.label) : '')}
      ${kv('部位', esc(regionSummary(a)))}
      ${kv('性质', list(a.qualities))}
      ${kv('伴随', list(a.symptoms))}
      ${kv('用药', (a.meds || []).map(medLine).join('<br>'))}
      ${kv('影响', a.impact != null ? IMPACT[a.impact] : '')}
      ${kv('诱因', list(a.triggers))}
      ${kv('备注', a.note ? esc(a.note) : '')}
    </div>`;
  }).join('');
  const foods = (d.foods || []).map(f => `${esc(f.item)}${f.note ? `（${esc(f.note)}）` : ''}`).join('、');
  const mood = d.mood ? [d.mood.valence ? MOOD[d.mood.valence - 1] : '', list(d.mood.feelings), d.mood.factors?.length ? `受${list(d.mood.factors)}影响` : ''].filter(Boolean).join(' · ') : '';
  const ex = [d.exercise != null ? (d.exercise ? `${d.exercise} 分钟` : '没有运动') : '', d.exIntensity ? INTENSITY[d.exIntensity] : '', (d.workouts || []).map(w => esc(w.item)).join('、')].filter(Boolean).join(' · ');
  const dayRows = [
    d.pain === 0 && !atk.length ? kv('头痛', '没有头痛') : '',
    kv('睡眠', d.sleep != null ? `${d.sleep} 小时` : ''),
    kv('饮食', foods),
    kv('咖啡因', S.caffeineOf(d) ? `${S.caffeineOf(d)} 杯` : d.caffeine === 0 ? '没有' : ''),
    kv('饮酒', S.alcoholOf(d) && !(d.foods || []).some(f => f.cat === '酒类') ? '喝了酒' : ''),
    kv('三餐', d.meals ? MEALS.map(([m, l]) => `${l}${d.meals[m] ? '吃了' : '没吃'}`).join('，') : ''),
    kv('月经', d.period ? `经期第 ${S.periodDayNumber(state.days, k)} 天` : d.period === false ? '不在经期' : ''),
    kv('天气', d.weather ? '变天了' : d.weather === false ? '没有变化' : ''),
    kv('心情', mood || (d.stress ? `压力${STRESS[d.stress]}` : '')),
    kv('运动', ex),
    kv('日常用药', (d.meds || []).map(medLine).join('<br>')),
    kv('自评', [d.gad7 ? `GAD-7 ${d.gad7.score} 分（${scaleBand('gad7', d.gad7.score)}）` : '', d.phq9 ? `PHQ-9 ${d.phq9.score} 分（${scaleBand('phq9', d.phq9.score)}）` : ''].filter(Boolean).join('<br>')),
  ].join('');
  return `<div class="day-detail">
    <h4>${mdw(k)}</h4>
    ${attacks}
    ${dayRows ? `<div class="dd-block">${dayRows}</div>` : atk.length ? '' : '<p class="muted" style="margin:0;font-size:14px">这天没有记录</p>'}
    <div class="btn-row">
      <button class="btn pain" data-act="new-attack" data-k="${k}">${icon('plus', 18, 2.2)}补记头痛</button>
      <button class="btn tint" data-act="edit-day" data-k="${k}">${icon('edit', 18)}编辑这天</button>
    </div></div>`;
}

function forecastCard(A) {
  if (!A.forecast) return '';
  const { p, ratio, drivers } = A.forecast;
  const level = ratio >= 1.5 ? ['up', '偏高'] : ratio <= 0.67 ? ['down', '偏低'] : ['flat', '和平时差不多'];
  const C = 2 * Math.PI * 34;
  return `<section class="card">
    <div class="card-head"><h3>今日发作风险</h3><span class="badge ${level[0]}">${level[1]}</span></div>
    <div class="forecast">
      <div class="ring"><svg viewBox="0 0 84 84"><circle cx="42" cy="42" r="34" fill="none" style="stroke:var(--fill)" stroke-width="9"/>
        <circle class="val" cx="42" cy="42" r="34" fill="none" style="stroke:var(--pain)" stroke-width="9" stroke-linecap="round" stroke-dasharray="${(p * C).toFixed(1)} ${C.toFixed(1)}"/></svg><b>${counted(Math.round(p * 100))}%</b></div>
      <p class="sub">根据今天的打卡，今天开始一次头痛的概率约 <b>${pct(p)}</b>，你平时约 <b>${pct(A.baseRate)}</b>。${drivers.length ? `<br>主要因为：${drivers.map(F => F.label).join('、')}。` : ''}</p>
    </div>
    <p class="note">模型交叉验证的区分能力 AUC = ${A.auc.toFixed(2)}（0.5 相当于随机猜测，1 为完美）。仅供参考。</p>
  </section>`;
}

function locationCard(list) {
  const R = S.regionStats(list);
  if (!R.n && !R.latN) {
    return `<section class="card"><div class="card-head"><h3>疼痛部位</h3></div>
      <p class="sub">记录头痛时在头部示意图上点选疼痛位置，这里会显示哪些区域最常痛。</p></section>`;
  }
  const latBox = (k, label) => `<div><b>${R.latN ? pct(R.lat[k] / R.latN) : '—'}</b><span>${label} ${R.lat[k]}</span></div>`;
  return `<section class="card">
    <div class="card-head"><h3>疼痛部位</h3><span class="meta">${R.n} 次有部位图</span></div>
    ${R.n ? `<div class="hm-grid">${VIEWS.map(([k, l]) => `<figure><div class="hm-paper">${headSVG(k, { sex: figure(), heat: R.heat })}</div><figcaption>${l}</figcaption></figure>`).join('')}</div>
    <div class="heat-legend"><span>少</span><i></i><span>多</span></div>` : ''}
    <div class="lat">${latBox('L', '左侧')}${latBox('R', '右侧')}${latBox('B', '双侧')}${latBox('M', '头顶')}</div>
    ${R.top.length ? `<div style="margin-top:8px">${R.top.slice(0, 5).map(id => `<div class="hbar"><span class="lbl">${REGIONS[id].label}</span><div class="track"><div class="fill" style="width:${R.heat[id] * 100}%"></div></div><span class="val">${pct(R.heat[id])}</span></div>`).join('')}</div>` : ''}
    ${R.sideLocked ? `<div class="callout">${icon('alert', 18)}<span>最近几次单侧头痛都固定在${LAT_LABEL[R.sideLocked]}。总在同一侧的头痛，建议看诊时告诉医生。</span></div>` : ''}
  </section>`;
}

function qualityCard(list) {
  const Q = S.qualityStats(list);
  if (!Q.n) {
    return `<section class="card"><div class="card-head"><h3>疼痛性质</h3></div>
      <p class="sub">记录时选择疼痛的感觉（跳痛、紧箍感等），这里会统计最常见的类型和各自的平均强度。</p></section>`;
  }
  return `<section class="card">
    <div class="card-head"><h3>疼痛性质</h3><span class="meta">${Q.n} 次 · 平均 ${fmtNum(Q.meanAll)} 分</span></div>
    ${Q.list.map(q => `<div class="hbar"><span class="lbl">${esc(q.name)}<small>平均 ${fmtNum(q.meanVas)} 分</small></span><div class="track"><div class="fill" style="width:${q.share * 100}%"></div></div><span class="val">${pct(q.share)}</span></div>`).join('')}
    <p class="note">占比 = 出现这种感觉的头痛 ÷ 记录了性质的头痛（可多选，合计会超过 100%）。</p>
  </section>`;
}

function timingCard() {
  const T = S.timing(state.attacks);
  if (T.total < 3) return '';
  const max = Math.max(...T.bins.map(b => b.n), 1);
  const top = [...T.bins].sort((a, b) => b.n - a.n)[0];
  return `<section class="card">
    <div class="card-head"><h3>发作时段</h3><span class="meta">最常在${top.label}</span></div>
    <div class="cols">${T.bins.map(b => `<div class="c"><span class="v">${b.n}</span><div class="bar" style="height:${Math.round(b.n / max * 56)}px"></div><span class="l">${b.label}</span></div>`).join('')}</div>
  </section>`;
}

function triggerCards() {
  const A = analysis();
  let html = '';
  if (!A.ready) {
    html += `<section class="card">
      <div class="card-head"><h3>正在积累数据</h3><span class="meta">${A.nDays} 天 · ${A.nAttacks} 次头痛</span></div>
      <p class="sub">${[
        A.needDays ? `再坚持打卡 <b>${A.needDays}</b> 天` : '',
        A.needAttacks ? `累计有 ${S.MIN_ATTACKS} 次头痛记录（目前 ${A.nAttacks} 次）` : '',
      ].filter(Boolean).join('，并且')}后，就能开始分析睡眠、压力、经期、饮食等因素和头痛的关系。</p>
      <div class="progress" aria-hidden="true"><div style="width:${Math.min(100, A.nDays / S.MIN_DAYS * 100)}%"></div></div>
      <p class="note">每天花 10 秒打卡（即使没头痛），分析会更准确。没打卡的日子不计入，避免把“忘了记”当成“没头痛”。</p>
    </section>`;
  } else {
    html += factorsCard(A);
  }
  html += intensityCard();
  html += logAnalysisCard(A);
  if (A.ready) html += corrCard(A) + sleepCard(A);
  html += taggedCard();
  return html;
}

const fx = v => Math.max(0, Math.min(100, 50 + Math.log2(v) / 3 * 50));
const fxPts = v => Math.max(0, Math.min(100, 50 + v / 4 * 50));
const evText = e => e.level === 0 ? '不明显' : `${e.level === 2 ? '很可能' : '可能'}${e.dir > 0 ? '↑' : '↓'}`;
const evClass = e => e.level === 0 ? 'flat' : e.dir > 0 ? 'up' : 'down';

function forestRow(e, act, est, lo, hi, pos) {
  return `<button class="factor" data-act="${act}" data-k="${e.F.key}">
    <div class="row1"><span class="name">${e.F.label}</span><span class="badge ${evClass(e)}">${evText(e)}</span><span class="est">${est}</span></div>
    <div class="row2"><div class="forest" aria-hidden="true"><div class="axis"></div><div class="ref"></div>
      <div class="ci ${evClass(e)}" style="left:${pos(lo)}%;width:${Math.max(1, pos(hi) - pos(lo))}%"></div>
      <div class="pt ${evClass(e)}" style="left:${pos(e.or ?? e.est)}%"></div></div><span class="chev">${icon('chevR', 16)}</span></div>
  </button>`;
}

function factorsCard(A) {
  if (!A.effects?.length) {
    return `<section class="card"><div class="card-head"><h3>哪些因素让头痛更容易发生</h3></div>
      <p class="sub">打卡的项目还不够多样。多记录几天睡眠、压力、饮食和经期，这里会给出每个因素的分析。</p></section>`;
  }
  return `<section class="card">
    <div class="card-head"><h3>哪些因素让头痛更容易发生</h3><span class="meta">${A.nDays} 天</span></div>
    <div class="forest-axis"><span>风险更低</span><span>×1</span><span>风险更高</span></div>
    ${A.effects.map(e => forestRow(e, 'factor', `×${fmtOR(e.or)}`, e.lo, e.hi, fx)).join('')}
    <p class="note">贝叶斯逻辑回归：×数值是同时考虑所有因素后的风险倍数（比值比），横线是 95% 可信区间。${A.auc != null ? `交叉验证 AUC = ${A.auc.toFixed(2)}。` : ''}点开可看原始数据。</p>
  </section>`;
}

// 挑一个来分析：先给原始对比和“只看这一项”，记录够多时再给“同时考虑其他因素”的校正结果
const PICK = {
  food: { label: '饮食', when: '当天或前一天有', meta: '看当天和前一天', empty: '在「饮食」打卡里按大类记下吃了 / 喝了什么，这里就能挑一类来看它和头痛的关系。', hint: '选一个大类或具体项目，看看它和头痛的关系：' },
  ex: { label: '运动', when: '当天做了', meta: '看当天', empty: '在「运动」打卡里按大类记下做了什么运动，这里就能挑一项来看它和头痛的关系。', hint: '选一个大类或具体项目，看看它和头痛的关系：' },
  mood: { label: '心情', when: '前一天有', meta: '看前一天', empty: '在「心情」打卡里选感受和影响因素，这里就能挑一项来看它和第二天头痛的关系。', hint: '选一种感受（上排）或影响因素（下排），看看它和第二天头痛的关系：' },
};
function forestStatic(label, e) {
  return `<div class="factor" style="padding-top:10px">
    <div class="row1"><span class="name" style="font-size:14.5px">${label}</span><span class="badge ${evClass(e)}">${evText(e)}</span><span class="est">×${fmtOR(e.or)}</span></div>
    <div class="row2" style="margin-right:24px"><div class="forest" aria-hidden="true"><div class="axis"></div><div class="ref"></div>
      <div class="ci ${evClass(e)}" style="left:${fx(e.lo)}%;width:${Math.max(1, fx(e.hi) - fx(e.lo))}%"></div>
      <div class="pt ${evClass(e)}" style="left:${fx(e.or)}%"></div></div></div></div>`;
}
function pickResult(A, kind, sel) {
  const P = PICK[kind], r = S.pickEffect(state, A.rows, kind, sel.key), u = r.uni;
  const enough = u.or != null && u.nE >= 3;
  return `<div class="log-result"><b>${esc(sel.label)}</b>
    <p class="sub">${P.when}的日子：${u.nE} 天，其中 ${u.aE} 天头痛（${pct(u.rateE)}）<br>其他有记录的日子：${u.nU} 天，其中 ${u.aU} 天头痛（${pct(u.rateU)}）</p>
    ${enough ? forestStatic('只看这一项', u) : '<p class="note">相关的日子还太少，多记录几次才能判断。</p>'}
    ${r.adj ? forestStatic('同时考虑其他因素', r.adj) + `<p class="note">校正时一起考虑了：${r.adj.with.length ? r.adj.with.join('、') : '暂无其他可用因素'}。${Math.abs(Math.log(r.adj.or / u.or)) > 0.4 ? '两行差别较大，说明“只看这一项”的结果里混进了别的因素，以校正后的为准。' : '两行接近，说明这个关系不太受其他因素影响。'}</p>`
      : enough ? '<p class="note">记录再多一些（至少 21 天、4 次头痛）后，会给出同时考虑睡眠、经期等其他因素的结果。</p>' : ''}
  </div>`;
}
function pickCard(A, kinds, title) {
  const kind = kinds.includes(ui.logKind) ? ui.logKind : kinds[0], P = PICK[kind], O = S.logOptions(state, kind);
  const opts = [...O.cats, ...O.items], sel = opts.find(o => o.key === ui.logSel?.[kind]);
  const seg = kinds.length > 1 ? `<div class="seg-ctl" style="margin-bottom:12px">${kinds.map(k => `<button class="${kind === k ? 'on' : ''}" data-act="log-kind" data-v="${k}">${PICK[k].label}</button>`).join('')}</div>` : '';
  const chip = o => `<button class="chip mini ${sel?.key === o.key ? 'on' : ''}" data-act="log-sel" data-kind="${kind}" data-v="${esc(o.key)}">${esc(o.label)}<span class="muted" style="font-weight:400">${o.days}天</span></button>`;
  const body = !opts.length ? `<p class="sub">${P.empty}</p>`
    : `<p class="sub" style="margin-bottom:10px">${P.hint}</p>
      ${O.cats.length ? `<div class="chips">${O.cats.map(chip).join('')}</div>` : ''}
      ${O.items.length ? `<div class="chips" style="margin-top:8px">${O.items.slice(0, 16).map(chip).join('')}</div>` : ''}
      ${sel ? pickResult(A, kind, sel) : ''}`;
  const unc = O.uncat.length ? `<div class="callout" style="margin-top:12px">${icon('info', 18)}<span>有 ${O.uncat.reduce((t, u) => t + u.count, 0)} 条直接填写的记录还没分类，分好类才能参与分析。
    <button class="link-btn" data-act="categorize">去分类</button></span></div>` : '';
  return `<section class="card"><div class="card-head"><h3>${title}</h3><span class="meta">${P.meta}</span></div>${seg}${body}${unc}</section>`;
}
const logAnalysisCard = A => pickCard(A, ['food', 'ex'], '饮食与运动');

function mindCard(A) {
  const M = S.moodStats(state, A.rows), SV = S.scaleVsHeadache(state);
  const bar = (label, v, n) => v == null ? '' : `<div class="hbar"><span class="lbl">${label}<small>${n} 天</small></span><div class="track"><div class="fill" style="width:${v / 7 * 100}%;background:${MOOD_COLORS[Math.round(v) - 1]}"></div></div><span class="val">${fmtNum(v)}</span></div>`;
  const scale = key => {
    const list = M[key], S0 = SCALES[key];
    if (!list.length) return `<div class="row plain" style="padding:12px 0"><div class="grow"><div class="t">${S0.title}（${S0.name}）</div><div class="s">还没做过 · 约 ${S0.minutes} 分钟</div></div>
      <button class="btn tint" style="min-height:36px" data-act="scale-open" data-k="${key}">去做</button></div>`;
    const [last, ...prev] = list;
    return `<div class="row plain" style="padding:12px 0"><div class="grow"><div class="t">${S0.title}（${S0.name}） <span class="badge lvl-${scaleLevel(last.score)}">${scaleBand(key, last.score)}</span></div>
      <div class="s">${md(last.date)}${prev.length ? ' · 之前 ' + prev.slice(0, 3).map(x => `${x.score}（${md(x.date)}）`).join('、') : ''}</div></div>
      <b class="num" style="font-size:22px">${last.score}</b></div>`;
  };
  const rhoText = ['gad7', 'phq9'].map(k => SV[k].rho != null ? `${SCALES[k].name} 分数和同期头痛天数的相关 ρ = ${SV[k].rho >= 0 ? '+' : '−'}${Math.abs(SV[k].rho).toFixed(2)}（${SV[k].n} 次）` : null).filter(Boolean);
  const compare = SV.rows.length ? `<h4 style="margin:14px 0 4px;font-size:14.5px">分数和同期头痛对照</h4>
    <table class="table"><thead><tr><th>日期</th><th>GAD-7</th><th>PHQ-9</th><th>前两周头痛</th></tr></thead><tbody>
      ${SV.rows.slice(0, 6).map(r => `<tr><td>${md(r.date)}</td><td>${r.gad7 ?? '—'}</td><td>${r.phq9 ?? '—'}</td><td>${r.head} 天${r.rec < 7 ? '*' : ''}</td></tr>`).join('')}</tbody></table>
    <p class="note">${rhoText.length ? rhoText.join('；') + '。次数少时只作参考。' : '做满 4 次量表（且那两周记录不少于 7 天）后，会计算分数和头痛天数的相关。'}${SV.rows.some(r => r.rec < 7) ? ' * 表示那两周记录少于 7 天。' : ''}</p>` : '';
  return `<section class="card">
    <div class="card-head"><h3>心情与头痛</h3><span class="meta">${M.n} 天有心情记录</span></div>
    ${M.n ? `${bar('头痛当天', M.avgOn, M.nOn)}${bar('其他日子', M.avgOff, M.nOff)}
      <p class="note">1 = 非常不愉快，7 = 非常愉快。${M.feelingsOnAttack.length ? `头痛当天最常见的感受：${M.feelingsOnAttack.map(([f, c]) => `${f}（${c}）`).join('、')}。` : ''}头痛本身也会让当天心情变差，所以模型里用的是「前一天情绪低落」。</p>`
      : '<p class="sub">在「今天」页的「心情」打卡，记录满一段时间后，这里会比较头痛日和其他日子的心情。</p>'}
  </section>
  ${pickCard(A, ['mood'], '哪些感受和影响因素与头痛有关')}
  <section class="card"><div class="card-head"><h3>焦虑与抑郁自评</h3><span class="meta">过去两周</span></div>
    ${scale('gad7')}${scale('phq9')}${compare}
    <p class="note">偏头痛常和焦虑、抑郁同时出现，互相影响。量表只用于自我观察，分数 ≥10 建议和医生聊聊。</p></section>`;
}

function intensityCard() {
  const I = S.intensityModel(state);
  if (!I.ready) {
    return `<section class="card"><div class="card-head"><h3>哪些因素让头痛更重</h3><span class="meta">${I.n}/${S.MIN_INTENSITY} 次</span></div>
      <p class="sub">再记录 <b>${I.need}</b> 次头痛后，会分析睡眠、经期、压力等因素对疼痛强度（0–10 分）的影响。</p>
      <div class="progress" aria-hidden="true"><div style="width:${I.n / S.MIN_INTENSITY * 100}%"></div></div></section>`;
  }
  if (!I.effects?.length) {
    return `<section class="card"><div class="card-head"><h3>哪些因素让头痛更重</h3></div>
      <p class="sub">头痛当天的打卡还不够多样，暂时无法比较。</p></section>`;
  }
  return `<section class="card">
    <div class="card-head"><h3>哪些因素让头痛更重</h3><span class="meta">${I.n} 次 · 平均 ${fmtNum(I.mean)} 分</span></div>
    <div class="forest-axis"><span>更轻</span><span>±0</span><span>更重</span></div>
    ${I.effects.map(e => forestRow(e, 'ifactor', `${fmtPts(e.est)} 分`, e.lo, e.hi, fxPts)).join('')}
    <p class="note">贝叶斯线性回归（只看头痛的日子）：数值是同时考虑其他因素后，强度平均高或低多少分，横线是 95% 可信区间。</p>
  </section>`;
}

function corrCard(A) {
  const list = S.correlations(A.rows).filter(c => c.rho != null);
  if (!list.length) return '';
  const strength = r => { const a = Math.abs(r); return a < 0.1 ? '几乎无关' : a < 0.3 ? '弱' : a < 0.5 ? '中等' : '较强'; };
  return `<section class="card">
    <div class="card-head"><h3>与当天头痛强度的相关</h3><span class="meta">Spearman ρ</span></div>
    ${list.map(c => {
      const w = Math.abs(c.rho) * 50, left = c.rho >= 0 ? 50 : 50 - w;
      return `<div class="corr"><span>${c.label}</span>
        <div class="track"><div class="fill ${c.rho >= 0 ? 'up' : 'down'}" style="left:${left}%;width:${w}%"></div><div class="mid"></div></div>
        <span class="val">${c.rho >= 0 ? '+' : '−'}${Math.abs(c.rho).toFixed(2)}${c.p < 0.05 ? '*' : ''}</span></div>`;
    }).join('')}
    <p class="note">正值：这项越高，当天头痛越重（没头痛记 0 分）；负值相反。${list.map(c => `${c.label}${strength(c.rho)}`).join('，')}。* 表示 p &lt; 0.05。</p>
  </section>`;
}

function sleepCard(A) {
  const { total, buckets } = S.sleepBuckets(A.rows);
  if (total < 14) return '';
  const shown = buckets.filter(b => b.n > 0);
  const max = Math.max(...shown.map(b => b.rate), 0.01);
  return `<section class="card">
    <div class="card-head"><h3>睡眠时长与头痛</h3><span class="meta">${total} 天</span></div>
    <div class="cols">${shown.map(b => `<div class="c"><span class="v">${pct(b.rate)}</span><div class="bar" style="height:${Math.round(b.rate / max * 72)}px"></div><span class="l">${b.label}</span></div>`).join('')}</div>
    <p class="note">每组 = 前一晚睡这么久的日子里，开始头痛的比例。${shown.map(b => `${b.label} ${b.n} 天`).join('，')}。</p>
  </section>`;
}

function taggedCard() {
  const since = shiftKey(todayKey(), -90);
  const recent = state.attacks.filter(a => S.attackDay(a) >= since);
  const tags = S.taggedTriggers(recent).slice(0, 6);
  return `<section class="card">
    <div class="card-head"><h3>你标记的诱因</h3><span class="meta">近 90 天 · ${recent.length} 次</span></div>
    ${tags.length ? tags.map(t => `<div class="hbar"><span class="lbl">${esc(t.name)}</span><div class="track"><div class="fill" style="width:${t.share * 100}%"></div></div><span class="val">${pct(t.share)}</span></div>`).join('')
      + '<p class="note">这是你自己的判断；上面的模型用每天打卡的数据来客观验证。</p>'
      : '<p class="sub">记录头痛时勾选「可能诱因」，这里会显示统计。</p>'}
  </section>`;
}

function trendMonthsCard() {
  const { list, trend } = S.monthlyTrend(state);
  if (!state.attacks.length) return '';
  const max = Math.max(...list.map(m => m.attacks), 1);
  let verdict = '记录满 3 个月（每月至少 7 天有记录）后，会判断头痛频率的变化趋势。';
  if (trend) {
    const ch = Math.round(Math.abs(trend.or - 1) * 100);
    verdict = trend.level === 0 ? `头痛频率整体比较平稳（每月变化约 ${ch}%，不确定）。`
      : `头痛频率${trend.dir < 0 ? '在下降' : '在上升'}，平均每月约 ${trend.dir < 0 ? '−' : '+'}${ch}%（可信度 ${pct(trend.pDir)}）。`;
  }
  return `<section class="card">
    <div class="card-head"><h3>近 6 个月头痛次数</h3>${trend && trend.level ? `<span class="badge ${trend.dir < 0 ? 'down' : 'up'}">${trend.dir < 0 ? '在减少' : '在增加'}</span>` : ''}</div>
    <div class="cols">${list.map(m => `<div class="c ${m.recordDays ? '' : 'empty'}"><span class="v">${m.recordDays ? m.attacks : ''}</span>
      <div class="bar ${m.current ? 'cur' : ''}" style="height:${Math.round(m.attacks / max * 72)}px"></div><span class="l">${m.month.getMonth() + 1}月</span></div>`).join('')}</div>
    <p class="note">${verdict}用泊松回归计算，已按每月实际记录天数校正。</p>
  </section>`;
}

function periodCard(A) {
  const P = S.periodAnalysis(state, A.rows);
  if (!P.enough) {
    return `<section class="card insight"><div class="card-head" style="margin-bottom:6px"><h3>经期与头痛</h3></div>
      <p style="margin:0">在「今天」页的「经期」打卡，记录满 2 个周期后，这里会分析头痛是否集中在经期前后。</p></section>`;
  }
  const hits = P.cycles.filter(c => c.hit).length, u = P.uni;
  return `<section class="card insight">
    <div class="hero-num"><b>${P.share == null ? '—' : pct(P.share)}</b><span>的头痛在经期前后（−2～+3 天）</span></div>
    <p>${P.tot ? `统计了 ${P.tot} 次头痛，其中 ${P.inW} 次在经期窗口内。` : ''}${P.cycles.length ? `最近 ${P.cycles.length} 个周期里，有 ${hits} 个在窗口内头痛。` : ''}${u.rateE != null && u.rateU != null ? `窗口内每天的发作概率约 ${pct(u.rateE)}，其他日子约 ${pct(u.rateU)}。` : ''}${P.cycles.length >= 2 && hits >= 2 ? '这种规律值得在看诊时告诉医生。' : ''}</p>
    ${P.next ? `<p>平均周期约 ${P.cycleLen} 天，预计下次经期在 <b style="color:var(--ink)">${md(P.next)}</b> 前后，可以提前留意。</p>` : ''}
  </section>`;
}

function medsCard() {
  const M = S.medStats(state, ui.month);
  const mo = ui.month.getMonth() + 1;
  const moh = M.acuteDays >= 10
    ? `<div class="callout" style="margin:0 0 12px">${icon('alert', 18)}<span>${mo}月已有 ${M.acuteDays} 天服用止痛药。每月用药天数较多时，可能出现“药物过度使用性头痛”，建议和医生聊聊。</span></div>` : '';
  if (!M.list.length) {
    return `<section class="card"><div class="card-head"><h3>药物效果</h3></div>${moh}
      <p class="sub">记录头痛时添加用药并标记效果，这里会统计哪种药对你更有效、多久起效。</p></section>`;
  }
  return `<section class="card">
    <div class="card-head"><h3>药物效果</h3><span class="meta">${mo}月止痛药 ${M.acuteDays} 天</span></div>${moh}
    <table class="table"><thead><tr><th>药物</th><th>次数</th><th>有效</th><th>起效</th></tr></thead><tbody>
    ${M.list.map(s => `<tr><td>${esc(s.name)}</td><td>${s.uses}</td><td>${s.rated ? pct((s.full + s.partial) / s.rated) : '—'}</td><td>${s.avgRelief != null ? fmtNum(s.avgRelief) + 'h' : '—'}</td></tr>`).join('')}
    </tbody></table>
    <p class="note">有效 = 标记为部分或完全缓解的比例；起效 = 平均多久后开始缓解。</p>
  </section>`;
}

// ----------------------- 我的 -----------------------
function viewMe() {
  const s = state.settings;
  const row = (act, ic, color, t, sub = '', cls = '') => `<button class="row ${cls}" data-act="${act}"><span class="li-ic gl" style="--c:${color}">${icon(ic, 18, 2)}</span>
    <div class="grow"><div class="t">${t}</div>${sub ? `<div class="s">${sub}</div>` : ''}</div><span class="chev">${icon('chevR', 18)}</span></button>`;
  return `
  ${header('数据只保存在这台设备上', '我的')}
  <div class="group"><div class="row plain"><span class="avatar" style="width:44px;height:44px;font-size:18px">${s.name?.trim() ? esc([...s.name.trim()][0]) : icon('user', 22, 2)}</span>
    <div class="grow"><input class="field" data-input="name" value="${esc(s.name)}" placeholder="怎么称呼你？" maxlength="12" aria-label="称呼"></div></div></div>

  <div class="group-label"><span>常用药物</span></div>
  <div class="group">
    ${s.meds.map((m, i) => `<div class="row"><span class="li-ic gl" style="--c:var(--med)">${icon('pill', 18, 2)}</span>
      <div class="grow"><div class="t">${esc(m.name)} <span class="muted">${esc(m.dose)}</span></div></div>
      <button class="badge ${m.kind === 'preventive' ? 'accent' : 'flat'}" data-act="med-kind" data-i="${i}" aria-label="切换用药类型">${m.kind === 'preventive' ? '预防' : '止痛'}</button>
      <button class="icon-btn" data-act="med-del" data-i="${i}" aria-label="删除 ${esc(m.name)}">${icon('trash', 18)}</button></div>`).join('')}
    <div class="row plain" style="display:block"><div class="inline-form" style="margin:0"><input class="field" id="nm-name" placeholder="药名" autocomplete="off"><input class="field" id="nm-dose" placeholder="剂量"><button class="btn primary" data-act="med-add">添加</button></div></div>
  </div>
  <p class="note" style="margin:-4px 18px 0">点「止痛 / 预防」可切换类型。预防用药不计入止痛药天数。</p>

  ${s.customTriggers.length ? `<div class="group-label"><span>自定义诱因</span></div><div class="group">
    ${s.customTriggers.map((t, i) => `<div class="row plain"><div class="grow t">${esc(t)}</div><button class="icon-btn" data-act="trig-del" data-i="${i}" aria-label="删除 ${esc(t)}">${icon('trash', 18)}</button></div>`).join('')}
  </div>` : ''}

  <div class="group-label"><span>数据</span></div>
  <div class="group">
    ${row('report', 'file', 'var(--accent)', '就诊摘要', '近 90 天的头痛、用药和规律，看医生时直接给医生看')}
    ${row('export-csv', 'share', 'var(--t-exercise)', '导出表格（CSV）', '可用 Excel / Numbers 打开')}
    ${row('export-json', 'download', 'var(--med)', '导出备份', '建议每月一次，存到「文件」或发给自己')}
    ${row('import-json', 'upload', 'var(--t-diet)', '导入备份', '与现有记录合并，换手机时使用')}
    ${row('clear-all', 'trash', 'var(--danger)', '清除所有数据', '', 'danger')}
  </div>
  <input type="file" id="import-file" accept="application/json,.json" hidden>

  <div class="group-label"><span>关于</span></div>
  <div class="group">
    <div class="row"><span class="li-ic gl" style="--c:var(--ink-3)">${icon('shield', 18, 2)}</span><div class="grow"><div class="t">数据存储</div><div class="s" id="persist-info">${state.attacks.length} 次头痛 · ${Object.keys(state.days).length} 天打卡，保存在本机，不会上传</div></div></div>
    ${row('method', 'sparkle', 'var(--t-sleep)', '分析方法说明')}
    <div class="row"><span class="li-ic gl" style="--c:var(--ink-3)">${icon('info', 18, 2)}</span><div class="grow"><div class="t">仅用于记录和自我观察</div><div class="s">不能替代医生的诊断和治疗建议 · 偏晴 · 偏头痛日记 v1.14</div></div></div>
  </div>`;
}

async function updatePersistInfo() {
  try {
    if (await navigator.storage?.persisted?.()) {
      const el = document.getElementById('persist-info');
      if (el) el.textContent += '（已开启持久保存）';
    }
  } catch { /* ignore */ }
}

// ======================= 弹层 =======================
const closeBtn = `<button class="icon-btn" data-act="close-sheet" aria-label="关闭">${icon('x', 18, 2.2)}</button>`;

function openSheet(s) {
  ui.sheet = s;
  renderSheet(true);
  document.body.classList.add('locked');
}

function closeSheet(force) {
  const s = ui.sheet;
  if (!s) return;
  if (!force && s.dirty && !confirm('放弃未保存的修改？')) return;
  $sheet.classList.remove('open');
  ui.sheet = null;
  document.body.classList.remove('locked');
  setTimeout(() => { if (!ui.sheet) $sheet.innerHTML = ''; }, 340);
  render();
}

function renderSheet(fresh) {
  const s = ui.sheet;
  if (!s) return;
  const spec = SHEETS[s.type](s);
  const prevScroll = $sheet.querySelector('.sheet-body')?.scrollTop || 0;
  $sheet.innerHTML = `<div class="backdrop" data-act="close-sheet"></div>
    <div class="sheet ${spec.full ? 'full' : ''}" role="dialog" aria-modal="true" aria-label="${esc(spec.title)}">
      <div class="grab"></div>
      <div class="sheet-head">${closeBtn}<h2>${spec.title}</h2>${spec.right || '<span class="sp"></span>'}</div>
      <div class="sheet-body">${spec.body}</div>
      ${spec.foot ? `<div class="sheet-foot">${spec.foot}</div>` : ''}
    </div>`;
  if (fresh) {
    $sheet.className = 'sheet-root';
    requestAnimationFrame(() => requestAnimationFrame(() => $sheet.classList.add('open')));
  } else {
    $sheet.className = 'sheet-root open';
    $sheet.querySelector('.sheet-body').scrollTop = prevScroll;
    popLast($sheet);
  }
}

const sec = (title, inner, extra = '') => `<section class="card"><h4>${title}${extra}</h4>${inner}</section>`;
const otherMedForm = (act, extra = '') => `<div class="inline-form"><input class="field" id="om-name" placeholder="药名" autocomplete="off"><input class="field" id="om-dose" placeholder="剂量"><button class="btn primary" data-act="${act}">添加</button></div>${extra}`;
const doneFoot = `<button class="btn primary lg block" data-act="close-sheet">完成</button>`;

const SHEETS = {
  attack: s => ({
    full: true,
    title: s.draft.id ? '编辑头痛记录' : '记录头痛',
    right: s.draft.id ? `<button class="icon-btn" data-act="a-delete" aria-label="删除这条记录">${icon('trash', 18)}</button>` : '',
    body: attackBody(s.draft),
    foot: `<button class="btn primary lg block" data-act="a-save">保存</button>`,
  }),
  checkin: s => ({
    title: `${TILES.find(t => t.k === s.k).label}${s.date === todayKey() ? '' : ' · ' + md(s.date)}`,
    body: editor(s.k, s.date) + (tileValue(s.k, s.date)[0] && s.k !== 'meds' ? `<button class="clear-link" data-act="c-clear" data-k="${s.k}">清除这项记录</button>` : ''),
    foot: doneFoot,
  }),
  day: s => ({
    full: true,
    title: mdw(s.date),
    body: TILES.map(t => `<div class="sheet-sec"><span class="li-ic gl" style="--c:${t.color}">${icon(t.ic, 16, 2)}</span>${t.label}</div>${editor(t.k, s.date)}`).join(''),
    foot: doneFoot,
  }),
  factor: s => factorSheet(s.k),
  scale: s => ({
    full: true, title: `${SCALES[s.k].title} · ${SCALES[s.k].name}`,
    body: scaleBody(s),
    foot: `<button class="btn primary lg block" data-act="scale-save" ${s.answers.every(a => a != null) ? '' : 'disabled style="opacity:.45"'}>保存结果</button>`,
  }),
  categorize: () => ({ full: true, title: '给记录分类', body: categorizeBody(), foot: doneFoot }),
  ifactor: s => ifactorSheet(s.k),
  method: () => ({ full: true, title: '分析方法说明', body: methodBody() }),
  report: () => ({
    full: true, title: '就诊摘要',
    body: `<pre class="report">${esc(buildReport())}</pre>`,
    foot: `<div class="btn-row" style="margin:0"><button class="btn tint" data-act="copy-report">${icon('copy', 18)}复制</button><button class="btn primary" data-act="share-report">${icon('share', 18)}分享</button></div>`,
  }),
};

function vasWidget(v) {
  const set = v != null && v > 0;
  return `<div class="vas ${set ? '' : 'unset'}" id="vas" style="--vas-c:var(--sev${sevOfVas(v || 0) || 1})">
    <div class="vas-head"><span class="vas-num" data-v="${set ? v : 0}">${set ? v : '–'}<small>/10</small></span><span class="vas-word">${set ? vasWord(v) : ''}</span>
      <span class="vas-hint">${set ? SEVERITY[sevOfVas(v)].hint : '拖动滑块选择'}</span></div>
    <input class="range" type="range" min="0" max="10" step="any" data-snap="1" value="${set ? v : 0}" data-input="a-vas" aria-label="疼痛强度，0 到 10 分" aria-valuetext="${set ? `${v} 分，${vasWord(v)}` : '未选择'}">
    <div class="vas-scale">${[0, 2, 4, 6, 8, 10].map(n => `<span>${n}</span>`).join('')}</div>
    <div class="vas-anchors"><span>不痛</span><span>能想象的最痛</span></div>
  </div>`;
}

function updateVasWidget(v) {
  const box = document.getElementById('vas');
  if (!box) return;
  const set = v > 0, num = box.querySelector('.vas-num');
  box.classList.toggle('unset', !set);
  box.style.setProperty('--vas-c', `var(--sev${sevOfVas(v) || 1})`);
  if (num.dataset.v !== String(v)) {
    num.dataset.v = v;
    num.innerHTML = `${set ? v : '–'}<small>/10</small>`;
    num.classList.remove('bump'); void num.offsetWidth; num.classList.add('bump');
  }
  box.querySelector('.vas-word').textContent = set ? vasWord(v) : '';
  box.querySelector('.vas-hint').textContent = set ? SEVERITY[sevOfVas(v)].hint : '拖动滑块选择';
  box.querySelector('.range').setAttribute('aria-valuetext', set ? `${v} 分，${vasWord(v)}` : '未选择');
}

// 开始时间：自绘的日期 / 时间胶囊，上面盖一个透明的原生输入框，点一下弹出系统选择器
const dayLabel = dt => {
  const k = dkey(dt), tk = todayKey();
  const head = k === tk ? '今天' : k === shiftKey(tk, -1) ? '昨天' : `${dt.getMonth() + 1}月${dt.getDate()}日`;
  return `${head} 周${WEEK[dt.getDay()]}`;
};
function startPicker(d) {
  const dt = parseLocal(d.start);
  return `<div class="dt-row">
      <label class="dt-pill">${icon('calendar', 19, 2)}<span class="dt-date">${dayLabel(dt)}</span>
        <input type="date" value="${dkey(dt)}" max="${todayKey()}" data-input="a-date" aria-label="头痛开始的日期"></label>
      <label class="dt-pill">${icon('clock', 19, 2)}<span class="dt-time">${hhmm(dt)}</span>
        <input type="time" value="${hhmm(dt)}" data-input="a-time" aria-label="头痛开始的时间"></label>
    </div>
    <div class="chips" style="margin-top:10px">${[['现在', 0], ['半小时前', 30], ['1 小时前', 60], ['3 小时前', 180]]
      .map(([l, m]) => `<button class="chip mini" data-act="a-ago" data-v="${m}">${l}</button>`).join('')}</div>`;
}
function updateStartPicker() {
  const dt = parseLocal(draft().start);
  const box = $sheet.querySelector('.dt-row');
  if (!box || isNaN(dt)) return;
  box.querySelector('.dt-date').textContent = dayLabel(dt);
  box.querySelector('.dt-time').textContent = hhmm(dt);
}

const VIEW_CAPTION = { front: '正面 · 镜像，左边就是你的左边', left: '从左边看', right: '从右边看', back: '背面 · 左边就是你的左边' };
const figure = () => state.settings.figure || 'female';

function regionPicker(d) {
  const on = new Set(d.regions), view = ui.headView || 'front', sex = figure();
  const legacy = !d.regions.length && d.locations?.length ? `<p class="note" style="margin-top:6px">旧记录的部位：${esc(d.locations.join('、'))}</p>` : '';
  return `<div class="hm-tools">
      <div class="seg-ctl" role="group" aria-label="视角">${VIEWS.map(([k, l]) => `<button class="${view === k ? 'on' : ''}" data-act="head-view" data-v="${k}" aria-pressed="${view === k}">${l}${VIEW_REGIONS[k].some(id => on.has(id)) ? '<i class="dot" aria-label="有选中区域"></i>' : ''}</button>`).join('')}</div>
      <div class="seg-ctl sex" role="group" aria-label="人像">${[['female', '女'], ['male', '男']].map(([k, l]) => `<button class="${sex === k ? 'on' : ''}" data-act="figure" data-v="${k}" aria-pressed="${sex === k}" aria-label="${l}性形象">${l}</button>`).join('')}</div>
    </div>
    <div class="hm-paper">${headSVG(view, { sex, on, interactive: true })}</div>
    <p class="note" style="text-align:center;margin-top:6px">${VIEW_CAPTION[view]}</p>
    <div class="region-summary">
      ${d.regions.length ? `<span class="badge up">${esc(regionSummary(d))}</span>` : '<span class="muted" style="font-size:13.5px">点选疼痛的区域，可多选</span>'}
      <span style="margin-left:auto;display:flex;gap:6px">
        <button class="chip" style="min-height:32px;font-size:13px;padding:0 12px" data-act="region-all">整个头部</button>
        ${d.regions.length ? '<button class="chip" style="min-height:32px;font-size:13px;padding:0 12px" data-act="region-clear">清除</button>' : ''}
      </span>
    </div>${legacy}`;
}

function attackBody(d) {
  const multi = (field, opts, extra = '') => `<div class="chips">${opts.map(o => {
    const on = d[field].includes(o);
    return `<button class="chip ${on ? 'on' : ''}" data-act="a-toggle" data-f="${field}" data-v="${esc(o)}" aria-pressed="${on}">${esc(o)}</button>`;
  }).join('')}${extra}</div>`;
  const custom = state.settings.customTriggers;
  const triggers = [...TRIGGERS, ...custom, ...d.triggers.filter(t => !TRIGGERS.includes(t) && !custom.includes(t))];
  return [
    sec('开始时间', startPicker(d)),
    sec('疼痛强度', vasWidget(d.vas)),
    sec('疼痛部位', regionPicker(d), '<small>可多选，切换视角更好选</small>'),
    sec('疼痛性质', multi('qualities', QUALITIES), '<small>可多选</small>'),
    sec('伴随症状', multi('symptoms', SYMPTOMS), '<small>可多选</small>'),
    sec('持续时间', `<div class="chips">${DURATIONS.map(o => `<button class="chip ${d.duration === o.k ? 'on' : ''}" data-act="a-dur" data-v="${o.k}" aria-pressed="${d.duration === o.k}">${o.label}</button>`).join('')}</div>`),
    sec('可能诱因', multi('triggers', triggers, `<button class="chip add" data-act="a-custom-trigger">${icon('plus', 15, 2.2)}自定义</button>`), '<small>可多选</small>'),
    sec('服药记录', medsEditor(d)),
    sec('备注', `<textarea class="field" data-input="a-note" placeholder="补充记录（可选）：先兆表现、活动情况……">${esc(d.note)}</textarea>`),
  ].join('');
}

function medsEditor(d) {
  const items = d.meds.map((m, i) => `
    <div class="med-item">
      <div class="top-row">${icon('pill', 20)}<b>${esc(m.name)} ${esc(m.dose || '')}</b>
        <input type="time" value="${esc(m.time || '')}" data-input="a-med-time" data-i="${i}" aria-label="服药时间">
        <button class="icon-btn" data-act="a-med-del" data-i="${i}" aria-label="移除 ${esc(m.name)}">${icon('x', 18)}</button></div>
      <div class="opts">
        <span class="lbl">效果怎么样</span>
        <div class="chips">${EFFECTS.map(e => `<button class="chip ${m.effect === e.v ? 'on' : ''}" data-act="a-med-effect" data-i="${i}" data-v="${e.v}">${e.label}</button>`).join('')}</div>
        ${m.effect > 0 ? `<span class="lbl">多久后开始缓解</span>
        <div class="chips">${RELIEF.map(r => `<button class="chip ${m.relief === r ? 'on' : ''}" data-act="a-med-relief" data-i="${i}" data-v="${r}">${r < 1 ? '半小时' : r + ' 小时'}${r === 4 ? '+' : ''}</button>`).join('')}</div>` : ''}
      </div>
    </div>`).join('');
  const presets = state.settings.meds.filter(m => m.kind !== 'preventive');
  return `${items}<div class="chips">
    ${presets.map(m => `<button class="chip add" data-act="a-add-med" data-name="${esc(m.name)}" data-dose="${esc(m.dose)}">${icon('plus', 15, 2.2)}${esc(m.name)} ${esc(m.dose)}</button>`).join('')}
    <button class="chip add" data-act="a-other-med">${icon('plus', 15, 2.2)}其他药物</button></div>
    ${d.addingMed ? otherMedForm('a-add-other') : ''}`;
}

function editor(k, date) {
  const d = state.days[date] || {};
  switch (k) {
    case 'period':
      return `<section class="card"><div class="switch-row"><span>这天在经期</span>
        <button class="switch ${d.period ? 'on' : ''}" role="switch" aria-checked="${!!d.period}" data-act="c-period" aria-label="这天在经期"></button></div>
        ${d.period ? `<p class="note" style="color:var(--ink)">经期第 ${S.periodDayNumber(state.days, date)} 天</p>` : ''}
        <p class="note">经期的每一天都打开这个开关，App 会自动算出第几天和周期长度，并分析头痛与经期的关系。</p></section>`;
    case 'diet': {
      const meals = d.meals || {};
      return `<section class="card"><h4>三餐<small>点选已经吃过的</small></h4>
        <div class="chips">${MEALS.map(([m, l]) => `<button class="chip ${meals[m] ? 'on' : ''}" style="flex:1" data-act="c-meal" data-m="${m}" aria-pressed="${!!meals[m]}">${l}</button>`).join('')}</div>
        ${d.meals ? `<p class="note">${MEALS.some(([m]) => !meals[m]) ? '没选的会被当作「漏餐」，晚点吃了再回来补上就好' : '三餐都吃了'}</p>` : ''}</section>
      <section class="card"><h4>含咖啡因的饮品<small>合计杯数</small></h4><div class="stepper">
        <button data-act="c-caf" data-d="-1" aria-label="减少一杯">−</button><div class="big">${S.caffeineOf(d) ?? 0}<small>杯</small></div>
        <button data-act="c-caf" data-d="1" aria-label="增加一杯">+</button></div>
        <p class="note" style="text-align:center">下面「饮品」里记的咖啡、奶茶、浓茶、能量饮料会自动算进来；喝得比记录的多时再加。</p></section>
      ${logEditor('food', date)}`;
    }
    case 'sleep':
      return `<section class="card"><h4>前一晚睡了多久</h4><div class="stepper">
        <button data-act="c-sleep" data-d="-0.5" aria-label="减少半小时">−</button><div class="big">${d.sleep ?? '–'}<small>小时</small></div>
        <button data-act="c-sleep" data-d="0.5" aria-label="增加半小时">+</button></div>
        <div class="seg-ctl" style="margin-top:14px">${[5, 6, 7, 8, 9].map(v => `<button class="${d.sleep === v ? 'on' : ''}" data-act="c-sleep-set" data-v="${v}">${v}h</button>`).join('')}</div></section>`;
    case 'mood':
      return moodEditor(date);
    case 'exercise':
      return `<section class="card"><h4>运动时长</h4>
        <div class="chips">${[0, 15, 30, 45, 60, 90].map(v => `<button class="chip ${d.exercise === v ? 'on' : ''}" data-act="c-ex" data-v="${v}">${v ? v + ' 分钟' : '没有运动'}</button>`).join('')}</div>
        <h4 style="margin-top:16px">强度</h4>
        <div class="seg-ctl">${[1, 2, 3].map(v => `<button class="${d.exIntensity === v ? 'on' : ''}" data-act="c-int" data-v="${v}" aria-pressed="${d.exIntensity === v}">${INTENSITY[v]}</button>`).join('')}</div></section>
      ${logEditor('ex', date)}`;
    case 'meds':
      return medsDayEditor(date);
  }
  return '';
}

// 饮食 / 运动记录：先选大类 → 再选具体项目（可补充说明），也可以直接填写
const LOGS = {
  food: { field: 'foods', catalog: FOOD_CATALOG, title: '吃了 / 喝了什么', ph: '补充说明，如：三分糖、珍珠', free: '直接写，比如：螺蛳粉' },
  ex: { field: 'workouts', catalog: EXERCISE_CATALOG, title: '做了什么运动', ph: '补充说明，如：5 公里、慢跑', free: '直接写，比如：飞盘' },
};
function logEditor(kind, date) {
  const L = LOGS[kind], list = state.days[date]?.[L.field] || [], s = ui.sheet || {};
  const cat = s[`${kind}Cat`], entry = L.catalog.find(c => c.cat === cat);
  return `<section class="card"><h4>${L.title}<small>先选大类，方便分析</small></h4>
    ${list.map(e => `<div class="log-item">
      <div class="log-head"><span class="badge ${e.cat === UNCAT ? 'flat' : 'accent'}">${esc(e.cat)}</span><b>${esc(e.item)}</b>
        <button class="icon-btn" data-act="log-del" data-kind="${kind}" data-id="${e.id}" aria-label="删除 ${esc(e.item)}">${icon('x', 16)}</button></div>
      <input class="field sm" value="${esc(e.note || '')}" placeholder="${L.ph}" data-input="log-note" data-kind="${kind}" data-id="${e.id}" aria-label="补充说明"></div>`).join('')}
    <div class="chips">${L.catalog.map(c => `<button class="chip mini ${cat === c.cat ? 'on' : ''}" data-act="log-cat" data-kind="${kind}" data-v="${esc(c.cat)}">${esc(c.cat)}</button>`).join('')}
      <button class="chip mini ${cat === UNCAT ? 'on' : ''}" data-act="log-cat" data-kind="${kind}" data-v="${UNCAT}">${icon('edit', 14)}直接填写</button></div>
    ${entry ? `<div class="log-sub"><div class="chips">${entry.items.map(it => `<button class="chip add" data-act="log-add" data-kind="${kind}" data-cat="${esc(entry.cat)}" data-item="${esc(it)}">${icon('plus', 14, 2.2)}${esc(it)}</button>`).join('')}</div>
      <div class="inline-form" style="grid-template-columns:1fr auto"><input class="field" id="log-free-${kind}" placeholder="其他${esc(entry.cat)}，自己填" autocomplete="off"><button class="btn tint" data-act="log-free" data-kind="${kind}" data-cat="${esc(entry.cat)}">添加</button></div></div>` : ''}
    ${cat === UNCAT ? `<div class="log-sub"><div class="inline-form" style="grid-template-columns:1fr auto"><input class="field" id="log-free-${kind}" placeholder="${L.free}" autocomplete="off"><button class="btn tint" data-act="log-free" data-kind="${kind}" data-cat="${UNCAT}">添加</button></div>
      <p class="note">直接填写的会先放进「未分类」，之后在分析页给它选个大类，就能参与分析。</p></div>` : ''}
  </section>`;
}

// 心情：参考 iOS「健康」的心情记录（7 级愉快度 + 感受 + 影响因素），附带 GAD-7 / PHQ-9 自评
const MOOD_COLORS = ['#5B57E0', '#7A72E6', '#9B9AE6', '#8FC1D6', '#F2C14E', '#F9A23F', '#FF8A3D'];
function moodFace(v) {
  const c = v ? MOOD_COLORS[v - 1] : 'var(--fill-2)', k = v ? (v - 4) * 5 : 0;
  return `<svg viewBox="0 0 120 120" class="mood-face" aria-hidden="true">
    <circle cx="60" cy="60" r="54" fill="${c}" opacity=".18"/><circle cx="60" cy="60" r="44" fill="${c}"/>
    <ellipse cx="45" cy="54" rx="4.5" ry="6" fill="#2E2C52"/><ellipse cx="75" cy="54" rx="4.5" ry="6" fill="#2E2C52"/>
    ${v >= 5 ? '<ellipse cx="36" cy="70" rx="7" ry="4.5" fill="#fff" opacity=".35"/><ellipse cx="84" cy="70" rx="7" ry="4.5" fill="#fff" opacity=".35"/>' : ''}
    <path d="M44 ${76 - k / 2}Q60 ${76 + k} 76 ${76 - k / 2}" fill="none" stroke="#2E2C52" stroke-width="4" stroke-linecap="round"/>
  </svg>`;
}
function moodEditor(date) {
  const m = state.days[date]?.mood || {}, v = m.valence || 0;
  const feelings = v && v <= 3 ? [...FEELINGS_NEG, ...FEELINGS_POS] : v >= 5 ? [...FEELINGS_POS, ...FEELINGS_NEG] : [...FEELINGS_NEG, ...FEELINGS_POS];
  const chip = (act, list, x) => `<button class="chip ${list.includes(x) ? 'on' : ''}" data-act="${act}" data-v="${esc(x)}" aria-pressed="${list.includes(x)}">${esc(x)}</button>`;
  const d = state.days[date] || {};
  const scaleRow = key => {
    const S0 = SCALES[key], r = d[key];
    const last = Object.values(state.days).filter(x => x[key]).sort((a, b) => b.date.localeCompare(a.date))[0];
    return `<button class="row" data-act="scale-open" data-k="${key}"><span class="li-ic gl" style="--c:${key === 'gad7' ? 'var(--t-sleep)' : 'var(--t-period)'}">${icon('clipboard', 17, 2)}</span>
      <div class="grow"><div class="t">${S0.title}（${S0.name}）</div><div class="s">${r ? `这天 ${r.score} 分 · ${scaleBand(key, r.score)}` : last ? `上次 ${md(last.date)}：${last[key].score} 分 · ${scaleBand(key, last[key].score)}` : `约 ${S0.minutes} 分钟，还没做过`}</div></div>
      <span class="chev">${icon('chevR', 18)}</span></button>`;
  };
  return `<section class="card mood-card">
      <div class="mood-top" id="mood-top">${moodFace(v)}<div class="mood-word">${v ? MOOD[v - 1] : '此刻感觉怎么样？'}</div></div>
      <input class="range mood-range" type="range" min="1" max="7" step="any" data-snap="1" value="${v || 4}" data-input="c-valence" aria-label="心情，从非常不愉快到非常愉快" aria-valuetext="${v ? MOOD[v - 1] : '未选择'}">
      <div class="vas-anchors"><span>非常不愉快</span><span>非常愉快</span></div>
    </section>
    <section class="card"><h4>哪些词最能形容你的感受<small>可多选</small></h4><div class="chips">${feelings.map(f => chip('c-feel', m.feelings || [], f)).join('')}</div></section>
    <section class="card"><h4>主要受什么影响<small>可多选</small></h4><div class="chips">${MOOD_FACTORS.map(f => chip('c-factor', m.factors || [], f)).join('')}</div></section>
    <section class="card" style="padding:6px 0"><h4 style="margin:10px 16px 2px">量表自评<small>反映过去两周，建议两周做一次</small></h4>
      <div class="group" style="box-shadow:none;border:0;margin:0">${scaleRow('gad7')}${scaleRow('phq9')}</div></section>`;
}
function updateMoodTop(v) {
  const top = $sheet.querySelector('#mood-top');
  if (!top) return;
  top.innerHTML = `${moodFace(v)}<div class="mood-word">${MOOD[v - 1]}</div>`;
  top.querySelector('.mood-face').classList.add('bump');
  $sheet.querySelector('.mood-range')?.setAttribute('aria-valuetext', MOOD[v - 1]);
}

// GAD-7 / PHQ-9 问卷
const CRISIS = `<div class="callout danger-soft">${icon('phone', 18)}<span>谢谢你如实作答。有伤害自己的念头时，请不要一个人扛着——尽快和信任的人聊聊，或联系专业帮助：
  <a href="tel:12356">全国心理援助热线 12356</a>。如果有立即的危险，请拨打 <a href="tel:120">120</a> 或 <a href="tel:110">110</a>。</span></div>`;
function scaleBody(s) {
  const S0 = SCALES[s.k], ans = s.answers, done = ans.every(a => a != null);
  const score = ans.reduce((t, a) => t + (a || 0), 0);
  return `<section class="card"><p class="sub" style="margin:0">在<b>过去两周</b>里，你有多少时候受到以下问题困扰？</p>
      <div class="progress" aria-hidden="true"><div style="width:${ans.filter(a => a != null).length / ans.length * 100}%"></div></div></section>
    ${S0.items.map((q, i) => `<section class="card q-card"><div class="q-text"><span class="q-no">${i + 1}</span>${esc(q)}</div>
      <div class="opt-grid">${SCALE_OPTIONS.map((o, v) => `<button class="chip ${ans[i] === v ? 'on' : ''}" data-act="scale-ans" data-i="${i}" data-v="${v}" aria-pressed="${ans[i] === v}">${o}</button>`).join('')}</div></section>`).join('')}
    ${s.k === 'phq9' && ans[8] > 0 ? CRISIS : ''}
    ${done ? `<section class="card result-card lvl-${scaleLevel(score)}"><div class="hero-num"><b>${score}</b><span>/ ${S0.items.length * 3} · ${scaleBand(s.k, score)}</span></div>
      <p class="sub">${score >= 10 ? '分数提示症状可能比较明显，建议和医生或心理咨询师聊聊。焦虑和抑郁在偏头痛人群里很常见，也都可以治疗。' : score >= 5 ? '有一些轻度的症状。留意休息和作息，两周后可以再测一次看看变化。' : '目前症状很少，继续保持。'}</p>
      <p class="note">自评量表只用于筛查和自我观察，不是诊断。</p></section>` : ''}`;
}

function medsDayEditor(date) {
  const fromAtk = [];
  for (const a of attacksOn(date)) for (const m of a.meds || []) fromAtk.push({ m, a });
  const own = state.days[date]?.meds || [];
  const s = ui.sheet || {};
  return `<section class="card">
    ${!fromAtk.length && !own.length ? '<p class="sub" style="margin-bottom:12px">这天还没有服药记录</p>' : ''}
    ${fromAtk.map(({ m, a }) => `<div class="med-item"><div class="top-row">${icon('pill', 20)}<b>${esc(m.name)} ${esc(m.dose || '')}</b><span class="muted" style="font-size:14px">${esc(m.time || '')}</span></div>
      <p class="note" style="margin-top:4px">记在 ${hhmm(new Date(a.start))} 的头痛里，可在那条记录中修改</p></div>`).join('')}
    ${own.map(m => `<div class="med-item"><div class="top-row">${icon('pill', 20)}<b>${esc(m.name)} ${esc(m.dose || '')}${m.kind === 'preventive' ? ' <span class="badge accent">预防</span>' : ''}</b>
      <span class="muted" style="font-size:14px">${esc(m.time || '')}</span><button class="icon-btn" data-act="c-med-del" data-id="${m.id}" aria-label="删除 ${esc(m.name)}">${icon('x', 18)}</button></div></div>`).join('')}
    <div class="chips">${state.settings.meds.map(p => `<button class="chip add" data-act="c-med-add" data-name="${esc(p.name)}" data-dose="${esc(p.dose)}" data-kind="${p.kind}">${icon('plus', 15, 2.2)}${esc(p.name)} ${esc(p.dose)}</button>`).join('')}
      <button class="chip add" data-act="c-med-other">${icon('plus', 15, 2.2)}其他药物</button></div>
    ${s.addingMed ? otherMedForm('c-med-add-other', `<div class="switch-row" style="margin-top:12px;font-size:15px"><span>这是预防 / 日常用药</span>
      <button class="switch ${s.otherPreventive ? 'on' : ''}" role="switch" aria-checked="${!!s.otherPreventive}" data-act="c-med-prev" aria-label="预防用药"></button></div>`) : ''}
    <p class="note">头痛时吃的药，建议在「记录头痛」里添加，方便统计药效。预防用药不计入止痛药天数。</p>
  </section>`;
}

function categorizeBody() {
  const block = kind => {
    const O = S.logOptions(state, kind), L = LOGS[kind];
    if (!O.uncat.length) return '';
    return `<h4 class="sheet-sec" style="margin-top:6px">${kind === 'food' ? '饮食' : '运动'}</h4>
      ${O.uncat.map(u => `<section class="card"><h4>${esc(u.name)}<small>${u.count} 次</small></h4>
        <div class="chips">${L.catalog.map(c => `<button class="chip mini" data-act="cat-assign" data-kind="${kind}" data-name="${esc(u.name)}" data-cat="${esc(c.cat)}">${esc(c.cat)}</button>`).join('')}</div></section>`).join('')}`;
  };
  const html = block('food') + block('ex');
  return html || '<section class="card"><p class="sub" style="margin:0">所有记录都已经分好类了。</p></section>';
}

function factorSheet(key) {
  const A = analysis();
  const e = A.effects?.find(x => x.F.key === key);
  if (!e) return { title: '因素详情', body: '<p class="sub">暂无数据</p>' };
  const u = e.uni;
  const line = (label, r) => r.or == null ? '' : `<div class="row plain" style="padding:12px 0"><div class="grow"><div class="t">${label}</div><div class="s">95% 区间 ×${fmtOR(r.lo)} – ×${fmtOR(r.hi)} · 可信度 ${pct(r.pDir)}</div></div><b class="num" style="font-size:18px">×${fmtOR(r.or)}</b></div>`;
  let interp;
  if (e.level === 0) interp = '目前看不出它和头痛有明确关系。数据少时这很常见，继续记录，结论会越来越清楚。';
  else if (e.dir > 0) interp = `在你的记录里，「${e.F.desc}」的日子头痛${e.level === 2 ? '明显' : '似乎'}更多。可以试着减少这种情况，观察头痛是否随之减少。`;
  else interp = `在你的记录里，「${e.F.desc}」的日子头痛反而${e.level === 2 ? '明显' : '似乎'}更少，可能对你有帮助。`;
  return {
    title: e.F.label,
    body: `<section class="card"><p class="sub" style="margin-bottom:8px">${esc(e.F.desc)}</p>
      <table class="table"><thead><tr><th></th><th>天数</th><th>头痛</th><th>发生率</th></tr></thead><tbody>
        <tr><td>有这种情况</td><td>${u.nE}</td><td>${u.aE}</td><td>${pct(u.rateE)}</td></tr>
        <tr><td>没有这种情况</td><td>${u.nU}</td><td>${u.aU}</td><td>${pct(u.rateU)}</td></tr></tbody></table></section>
      <section class="card"><h4>模型结果</h4>${line('只看这一项', u)}${line('同时考虑其他因素', e)}
        <p class="note">×1 表示没有差别。区间越窄、离 1 越远，结果越可靠。可信度是“风险确实${e.dir > 0 ? '更高' : '更低'}”的概率。</p></section>
      <section class="card insight"><p style="margin:0;color:var(--ink)">${interp}</p><p>相关不等于因果；不同因素也可能同时出现（比如经期前后睡眠变差），模型会尽量把它们分开。</p></section>`,
    foot: `<button class="btn primary lg block" data-act="close-sheet">知道了</button>`,
  };
}

function ifactorSheet(key) {
  const I = S.intensityModel(state);
  const e = I.effects?.find(x => x.F.key === key);
  if (!e) return { title: '因素详情', body: '<p class="sub">暂无数据</p>' };
  const interp = e.level === 0 ? '目前看不出它会让头痛更重或更轻。'
    : `「${e.F.desc}」时，头痛强度平均${e.dir > 0 ? '高' : '低'}约 ${Math.abs(e.est).toFixed(1)} 分（${e.level === 2 ? '证据较充分' : '有一定迹象'}）。`;
  return {
    title: `${e.F.label} · 强度`,
    body: `<section class="card"><p class="sub" style="margin-bottom:8px">${esc(e.F.desc)}</p>
      <table class="table"><thead><tr><th></th><th>头痛次数</th><th>平均强度</th></tr></thead><tbody>
        <tr><td>有这种情况</td><td>${e.nOn}</td><td>${e.meanOn == null ? '—' : fmtNum(e.meanOn)}</td></tr>
        <tr><td>没有这种情况</td><td>${e.nOff}</td><td>${e.meanOff == null ? '—' : fmtNum(e.meanOff)}</td></tr></tbody></table></section>
      <section class="card"><h4>模型结果</h4><div class="row plain" style="padding:12px 0"><div class="grow"><div class="t">同时考虑其他因素</div>
        <div class="s">95% 区间 ${fmtPts(e.lo)} ~ ${fmtPts(e.hi)} 分 · 可信度 ${pct(e.pDir)}</div></div><b class="num" style="font-size:18px">${fmtPts(e.est)} 分</b></div></section>
      <section class="card insight"><p style="margin:0;color:var(--ink)">${interp}</p></section>`,
    foot: `<button class="btn primary lg block" data-act="close-sheet">知道了</button>`,
  };
}

function methodBody() {
  return `<section class="card method">
    <p><b>数据怎么整理。</b>每一个有记录的日子算一行，看这一天有没有开始一次头痛。没打开 App 的日子不计入，避免把“忘了记”当成“没头痛”。</p>
    <p><b>会不会发作：贝叶斯逻辑回归。</b>结局是“这天有没有头痛”（是 / 否），所以用逻辑回归。睡眠、压力、饮食、咖啡因、饮酒、经期、运动放进同一个模型互相校正。系数用温和的正态先验（相当于岭回归），数据少时结果自动偏向“没关系”，不夸大偶然现象。“×2.1”是比值比，横线是 95% 可信区间，“可信度”是效应方向成立的后验概率。</p>
    <p><b>痛得多重：贝叶斯线性回归。</b>VAS 强度是 0–10 的连续分数，只看头痛的日子，用线性回归估计每个因素让强度平均高或低几分，同样带先验、给出可信区间。严格来说 VAS 有上下限，也可以用有序 logistic，但一个人的数据量下线性模型更稳、也更好理解。</p>
    <p><b>部位和性质：描述统计。</b>它们是头痛的“表现”而不是“原因”，类别多（13 个区域、7 种性质），如果再做多项回归，一个人的数据会严重过拟合。所以用热力图、左右侧比例、各性质的占比和平均强度来呈现。如果最近多次单侧头痛总在同一侧，会提醒你告诉医生。</p>
    <p><b>滞后效应。</b>很多诱因要几小时到一天才起作用，所以部分因素看的是前一天：前一晚的睡眠、压力比前一天下降（“放松后头痛”）、前一天饮酒。</p>
    <p><b>预测与验证。</b>用分块时间序列交叉验证（按时间切成 5 段，轮流留出一段来检验）计算 AUC。只有 AUC ≥ 0.6、模型确实比瞎猜好时，才显示今日风险。</p>
    <p><b>相关性、趋势、经期。</b>Spearman 等级相关看睡眠等指标与当天头痛强度的单调关系；泊松回归（以每月记录天数为偏移量）判断频率趋势；经期窗口按 ICHD-3：经期第 1 天的前 2 天到后 3 天。</p>
    <p><b>饮食与运动。</b>记录按「大类 → 具体项目」保存，这样同一种东西不会因为写法不同被拆开。在分析页可以挑任一大类（如「饮品」）或项目（如「奶茶」），比较有它和没有它的日子的头痛发生率，给出“只看这一项”的风险倍数；记录够多时，再给出把它和睡眠、经期、压力等一起放进逻辑回归后的校正结果（和所选项重叠的因素会先去掉，比如选了「酒类」就不再放「饮酒」）。饮食看当天或前一天（很多食物诱因要隔一段时间才起作用），运动看当天。咖啡因杯数和是否饮酒直接从饮食记录里推算。直接填写的条目归入「未分类」，分好类后才参与分析。</p>
    <p><b>心情与量表。</b>心情按 7 级愉快程度记录（参考 iOS「健康」），头痛本身会让当天心情变差，所以模型里用「前一天情绪低落」，挑感受或影响因素来分析时也看前一天；由感受推算的「压力」也会进入模型。GAD-7（焦虑）和 PHQ-9（抑郁）反映的是过去两周的整体情况，不当作每天的诱因，而是和量表日期前两周的头痛天数做对照，做满 4 次后计算 Spearman 相关。</p>
    <p><b>为什么没用结构方程模型（SEM）。</b>SEM 适合多人、大样本、带潜变量的研究，通常需要几百个以上的观测。一个人几个月的日记远远不够，硬套会得到不稳定甚至误导的结果。</p>
    <p><b>请注意。</b>相关不等于因果，结果只供自我观察和与医生沟通时参考。每天都打卡（即使没头痛），结果会更可靠。</p>
  </section>`;
}

// ======================= 就诊摘要 / 导出 =======================
function buildReport() {
  const tk = todayKey(), since = shiftKey(tk, -89);
  const list = state.attacks.filter(a => S.attackDay(a) >= since).slice().reverse();
  const count = arr => {
    const m = new Map();
    for (const x of arr) m.set(x, (m.get(x) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${k}（${n}）`).join('、') || '—';
  };
  const durs = list.map(a => durationOf(a.duration)?.h).filter(h => h != null);
  const vs = list.map(vasOf);
  const lines = ['偏头痛记录摘要'];
  if (state.settings.name) lines.push(`称呼：${state.settings.name}`);
  lines.push(`时间：${since} 至 ${tk}（近 90 天）`, '');
  lines.push(`· 头痛 ${list.length} 次，${new Set(list.map(S.attackDay)).size} 天（约每月 ${fmtNum(list.length / 3)} 次）`);
  if (vs.length) lines.push(`· 强度（0–10）：平均 ${fmtNum(mean(vs))}，最高 ${Math.max(...vs)}；轻度 ${vs.filter(v => sevOfVas(v) === 1).length}，中度 ${vs.filter(v => sevOfVas(v) === 2).length}，重度 ${vs.filter(v => sevOfVas(v) === 3).length}`);
  if (durs.length) lines.push(`· 平均持续：约 ${fmtNum(mean(durs))} 小时`);
  const R = S.regionStats(list);
  if (R.latN) lines.push(`· 侧别：左侧 ${R.lat.L}，右侧 ${R.lat.R}，双侧 ${R.lat.B}，头顶 ${R.lat.M}${R.sideLocked ? `（近期固定在${LAT_LABEL[R.sideLocked]}）` : ''}`);
  if (R.top.length) lines.push(`· 常见部位：${R.top.slice(0, 5).map(id => `${REGIONS[id].label}（${R.counts[id]}）`).join('、')}`);
  lines.push(`· 疼痛性质：${count(list.flatMap(a => a.qualities || []))}`);
  lines.push(`· 伴随症状：${count(list.flatMap(a => a.symptoms || []))}`);
  lines.push(`· 自己认为的诱因：${count(list.flatMap(a => a.triggers || []))}`);
  const imp = list.filter(a => a.impact != null);
  if (imp.length) lines.push(`· 对日常的影响（上班、带孩子）：${IMPACT.map((l, i) => `${l} ${imp.filter(a => a.impact === i).length}`).join('，')}`);
  const M = S.medStats({ ...state, attacks: list }, new Date());
  if (M.list.length) lines.push('· 用药：' + M.list.map(s => `${s.name} ${s.uses} 次${s.rated ? `，有效 ${s.full + s.partial}/${s.rated}` : ''}`).join('；'));
  lines.push(`· 每月止痛药使用天数：${[2, 1, 0].map(i => { const m = addMonths(startOfMonth(new Date()), -i); return `${m.getMonth() + 1}月 ${S.medStats(state, m).acuteDays} 天`; }).join('，')}`);
  const A = analysis();
  const P = S.periodAnalysis(state, A.rows);
  if (P.enough && P.share != null) lines.push(`· 经期前后（−2～+3 天）头痛占比：${pct(P.share)}`);
  const strong = (A.effects || []).filter(e => e.level >= 1);
  if (strong.length) lines.push('· 数据分析（发生）：' + strong.map(e => `${e.F.label} ×${fmtOR(e.or)}`).join('；'));
  const I = S.intensityModel(state);
  const strongI = (I.effects || []).filter(e => e.level >= 1);
  if (strongI.length) lines.push('· 数据分析（强度）：' + strongI.map(e => `${e.F.label} ${fmtPts(e.est)} 分`).join('；'));
  const MS = S.moodStats(state, A.rows.filter(r => r.key >= since));
  if (MS.n) lines.push(`· 心情（1–7，越高越愉快）：头痛当天平均 ${MS.avgOn == null ? '—' : fmtNum(MS.avgOn)}，其他日子 ${MS.avgOff == null ? '—' : fmtNum(MS.avgOff)}`);
  for (const key of ['gad7', 'phq9']) {
    const list = Object.values(state.days).filter(d => d[key]).sort((a, b) => b.date.localeCompare(a.date));
    if (list.length) lines.push(`· ${SCALES[key].name}：${list[0][key].score} 分（${scaleBand(key, list[0][key].score)}，${list[0].date}）${list.length > 1 ? `；之前 ${list.slice(1, 3).map(d => `${d[key].score} 分（${d.date}）`).join('、')}` : ''}`);
  }
  lines.push('', '头痛明细：');
  for (const a of list) {
    const d = new Date(a.start);
    const meds = (a.meds || []).map(m => `${m.name}${m.dose ? ' ' + m.dose : ''}${m.effect != null ? '，' + EFFECTS[m.effect].label : ''}`).join('；');
    lines.push(`${d.getMonth() + 1}/${d.getDate()} ${hhmm(d)} 强度${vasOf(a)} ${a.duration ? durationOf(a.duration).label : ''} ${regionSummary(a)} ${(a.qualities || []).join('、')} ${(a.symptoms || []).join('、')}${a.impact != null ? ' 影响：' + IMPACT[a.impact] : ''}${meds ? ' | ' + meds : ''}`.replace(/\s+/g, ' ').trim());
  }
  if (!list.length) lines.push('（无）');
  lines.push('', '由「偏晴 · 偏头痛日记」生成，仅供参考。');
  return lines.join('\n');
}

async function shareOrDownload(name, text, type) {
  const file = new File([text], name, { type });
  if (isIOS && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function exportCSV() {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['日期', '强度(0-10)', '开始时间', '持续', '侧别', '部位', '性质', '伴随症状', '诱因', '用药', '影响日常', '睡眠(小时)', '心情(1-7)', '感受', '心情影响因素', '压力', '三餐', '饮食记录', '咖啡因(杯)', '饮酒', '运动(分钟)', '运动强度', '运动记录', '经期', '天气变化', '无头痛', 'GAD-7', 'PHQ-9', '备注'];
  const logText = list => (list || []).map(e => `${e.cat}·${e.item}${e.note ? `（${e.note}）` : ''}`).join('; ');
  const keys = [...new Set([...Object.keys(state.days), ...state.attacks.map(S.attackDay)])].sort();
  const rows = [head.map(q).join(',')];
  for (const k of keys) {
    const d = state.days[k] || {}, atks = attacksOn(k);
    const st = stressOf(d);
    const daily = [d.sleep, d.mood?.valence ?? '', (d.mood?.feelings || []).join('/'), (d.mood?.factors || []).join('/'), st ? STRESS[st] : '',
      d.meals ? MEALS.filter(([m]) => d.meals[m]).map(([, l]) => l).join('/') : '', logText(d.foods),
      S.caffeineOf(d) ?? '', S.alcoholOf(d) == null ? '' : S.alcoholOf(d) ? '是' : '否', d.exercise, d.exIntensity ? INTENSITY[d.exIntensity] : '', logText(d.workouts),
      d.period ? '是' : '', d.weather == null ? '' : d.weather ? '是' : '否', d.pain === 0 ? '是' : '', d.gad7?.score ?? '', d.phq9?.score ?? ''];
    const extraMeds = (d.meds || []).map(m => `${m.name} ${m.dose || ''}${m.time ? ' ' + m.time : ''}`).join('; ');
    if (!atks.length) rows.push([k, '', '', '', '', '', '', '', '', extraMeds, '', ...daily, ''].map(q).join(','));
    for (const a of atks.slice().reverse()) {
      const meds = [...(a.meds || []).map(m => `${m.name} ${m.dose || ''}${m.time ? ' ' + m.time : ''}${m.effect != null ? ' ' + EFFECTS[m.effect].label : ''}`), extraMeds].filter(Boolean).join('; ');
      const regions = a.regions?.length ? a.regions.map(r => REGIONS[r]?.label).join('/') : (a.locations || []).join('/');
      rows.push([k, vasOf(a), hhmm(new Date(a.start)), a.duration ? durationOf(a.duration).label : '', LAT_LABEL[laterality(a)] || '', regions,
        (a.qualities || []).join('/'), (a.symptoms || []).join('/'), (a.triggers || []).join('/'), meds, a.impact != null ? IMPACT[a.impact] : '', ...daily, a.note].map(q).join(','));
    }
  }
  shareOrDownload(`偏晴-偏头痛日记-${todayKey()}.csv`, '﻿' + rows.join('\r\n'), 'text/csv');
}

function exportJSON() {
  const data = { app: 'migraine-diary', version: 2, exportedAt: new Date().toISOString(), attacks: state.attacks, days: Object.values(state.days), settings: state.settings };
  shareOrDownload(`偏晴备份-${todayKey()}.json`, JSON.stringify(data, null, 1), 'application/json');
}

async function importJSON(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { return toast('文件格式不对，无法读取'); }
  if (!data || !Array.isArray(data.attacks) || !Array.isArray(data.days)) return toast('这不是偏晴的备份文件');
  const attacks = data.attacks.filter(a => a && a.id && a.start && (a.vas || a.severity)).map(normalizeAttack);
  const days = data.days.filter(d => d && /^\d{4}-\d{2}-\d{2}$/.test(d.date));
  if (!confirm(`将导入 ${attacks.length} 次头痛、${days.length} 天打卡，并与现有记录合并（相同的记录以备份为准）。继续吗？`)) return;
  for (const a of attacks) {
    const i = state.attacks.findIndex(x => x.id === a.id);
    if (i >= 0) state.attacks[i] = a; else state.attacks.push(a);
  }
  state.attacks.sort((x, y) => y.start.localeCompare(x.start));
  for (const d of days) state.days[d.date] = d;
  if (data.settings) {
    const s = state.settings;
    if (!s.name && data.settings.name) s.name = data.settings.name;
    for (const m of data.settings.meds || []) if (!s.meds.some(x => x.name === m.name && x.dose === m.dose)) s.meds.push(m);
    for (const t of data.settings.customTriggers || []) if (!s.customTriggers.includes(t)) s.customTriggers.push(t);
    saveSettings();
  }
  await db.putMany('attacks', attacks);
  await db.putMany('days', days);
  afterWrite();
  render();
  toast('导入完成');
}

// ======================= 交互 =======================
function newAttackDraft(k) {
  const now = new Date();
  const start = !k || k === todayKey() ? now : (() => { const d = parseKey(k); d.setHours(now.getHours(), now.getMinutes()); return d; })();
  return { start: toLocalInput(start), vas: null, regions: [], qualities: [], symptoms: [], duration: null, triggers: [], meds: [], note: '' };
}
function openAttack(a, k = null) {
  const draft = a ? { ...structuredClone(a), start: toLocalInput(new Date(a.start)) } : newAttackDraft(k);
  draft.note ??= '';
  openSheet({ type: 'attack', draft, dirty: false });
}
const draft = () => ui.sheet.draft;
const touch = () => { ui.sheet.dirty = true; renderSheet(); };

const ACTIONS = {
  tab: el => { ui.tab = el.dataset.tab; render(); },

  'hide-install': () => { state.settings.hideInstall = true; saveSettings(); render(); },

  // ---- 今天（一屏记完）：都在原地更新 ----
  't-side': el => editToday(({ a }) => {
    const v = el.dataset.v, cur = sideOf(a);
    a.regions = []; a.locations = [];
    if (cur === v) return;
    if (v === 'all') a.regions = [...REGION_IDS]; else a.locations = [SIDE_LOC[v]];
  }),
  't-q': el => editToday(t => toggleIn(t.a.qualities, el.dataset.v)),
  't-sym': el => editToday(t => toggleIn(t.a.symptoms, el.dataset.v)),
  't-impact': el => editToday(({ a }) => { const v = +el.dataset.v; a.impact = a.impact === v ? null : v; }),
  // 弹出 / 收起滚轮面板（不算改动）
  't-island': el => { const k = el.dataset.v; if (islandSkip === k) { islandSkip = null; return; } openIsland(k, el); },
  'isl-close': () => closeIsland(),
  'isl-pick': el => { wheelTouched = true; el.parentElement.dataset.to = el.dataset.i; el.parentElement.scrollTo({ top: +el.dataset.i * ITEM_H, behavior: 'smooth' }); },
  // 快捷时间：选中的那颗亮起来，滚轮跟着滚到那个时间（之后再动滚轮，它就灭了）
  't-ago': el => {
    const start = toLocalInput(new Date(Date.now() - +el.dataset.v * 60000));
    clearTimeout(wheelTimer);
    dayTouched = dayAuto = false;
    ui.ago = { v: el.dataset.v, start };
    editToday(t => setStart(t, start));
  },
  // 点一种药：没记过就记上（时间先按现在），然后弹出面板改时间、选效果
  't-med': el => {
    const t = todayState(), n = el.dataset.v;
    if (islandSkip === n) { islandSkip = null; return; }
    if (!t.a.meds.some(m => m.name === n)) editToday(x => x.a.meds.push({ id: uid(), name: n, dose: el.dataset.dose || '', time: '', effect: null, relief: null }));
    openIsland(n, el);
  },
  // 「不记时间」：点一下清掉时间；再点一下按滚轮现在停的位置记上
  't-med-notime': el => {
    const n = el.dataset.v, has = !!timeOf(ui.today, n);
    wheelTouched = !has;
    if (has) editToday(t => { const m = t.a.meds.find(x => x.name === n); if (m) m.time = ''; });
    else commitWheels();
  },
  't-med-del': el => { const n = el.dataset.v; closeIsland(); editToday(t => { t.a.meds = t.a.meds.filter(m => m.name !== n); }); },
  't-eff': el => editToday(t => {
    const m = t.a.meds.find(x => x.name === el.dataset.m), v = +el.dataset.v;
    if (!m) return;
    m.effect = m.effect === v ? null : v;
    if (!(m.effect > 0)) m.relief = null;
  }),
  't-drink': el => editToday(t => {
    const v = el.dataset.v;
    if (v === 'none') { t.drinks = t.drinks.includes('none') ? [] : ['none']; return; }
    t.drinks = t.drinks.filter(x => x !== 'none');
    toggleIn(t.drinks, v);
  }),
  't-period': () => editToday(t => { t.period = !t.period; }),
  't-weather': () => editToday(t => { t.weather = !t.weather; }),
  't-detail': () => {
    const t = todayState();
    openSheet({ type: 'attack', draft: { ...structuredClone(t.a), vas: t.vas || null, note: t.a.note || '' }, dirty: true });
  },
  't-save': () => saveToday(),
  tile: el => openSheet({ type: 'checkin', k: el.dataset.k, date: todayKey() }),
  'new-attack': el => openAttack(null, el.dataset.k || null),
  'edit-attack': el => openAttack(state.attacks.find(a => a.id === el.dataset.id)),
  'edit-day': el => openSheet({ type: 'day', date: el.dataset.k }),
  'close-sheet': () => closeSheet(),

  month: el => {
    ui.month = addMonths(ui.month, +el.dataset.d);
    const cur = startOfMonth(new Date());
    if (ui.month > cur) ui.month = cur;
    ui.sel = ui.month.getTime() === cur.getTime() ? todayKey() : null;
    render();
  },
  'sel-day': el => { ui.sel = ui.sel === el.dataset.k ? null : el.dataset.k; render(); },
  factor: el => openSheet({ type: 'factor', k: el.dataset.k }),
  ifactor: el => openSheet({ type: 'ifactor', k: el.dataset.k }),
  method: () => openSheet({ type: 'method' }),

  // ---- 头痛表单 ----
  'a-ago': el => { draft().start = toLocalInput(new Date(Date.now() - +el.dataset.v * 60000)); touch(); },
  'head-view': el => { ui.headView = el.dataset.v; renderSheet(); },
  figure: el => { state.settings.figure = el.dataset.v; saveSettings(); renderSheet(); },
  region: el => {
    const r = draft().regions, id = el.dataset.id, i = r.indexOf(id);
    if (i >= 0) r.splice(i, 1); else r.push(id);
    touch();
  },
  'region-all': () => { draft().regions = [...REGION_IDS]; touch(); },
  'region-clear': () => { draft().regions = []; touch(); },
  'a-dur': el => { const d = draft(); d.duration = d.duration === el.dataset.v ? null : el.dataset.v; touch(); },
  'a-toggle': el => {
    const arr = draft()[el.dataset.f], v = el.dataset.v, i = arr.indexOf(v);
    if (i >= 0) arr.splice(i, 1); else arr.push(v);
    touch();
  },
  'a-custom-trigger': () => {
    const t = prompt('自定义诱因（例如：熬夜、长时间看屏幕）')?.trim();
    if (!t) return;
    const s = state.settings;
    if (!TRIGGERS.includes(t) && !s.customTriggers.includes(t)) { s.customTriggers.push(t); saveSettings(); }
    if (!draft().triggers.includes(t)) draft().triggers.push(t);
    touch();
  },
  'a-add-med': el => {
    const d = draft(), start = parseLocal(d.start), now = new Date();
    const time = start.toDateString() === now.toDateString() ? hhmm(now) : hhmm(start);
    d.meds.push({ id: uid(), name: el.dataset.name, dose: el.dataset.dose, time, effect: null, relief: null });
    touch();
  },
  'a-other-med': () => { draft().addingMed = !draft().addingMed; renderSheet(); },
  'a-add-other': () => {
    const name = document.getElementById('om-name').value.trim(), dose = document.getElementById('om-dose').value.trim();
    if (!name) return toast('请填写药名');
    const d = draft();
    d.meds.push({ id: uid(), name, dose, time: hhmm(new Date()), effect: null, relief: null });
    d.addingMed = false;
    if (!state.settings.meds.some(m => m.name === name && m.dose === dose)) { state.settings.meds.push({ name, dose, kind: 'acute' }); saveSettings(); }
    touch();
  },
  'a-med-del': el => { draft().meds.splice(+el.dataset.i, 1); touch(); },
  'a-med-effect': el => {
    const m = draft().meds[+el.dataset.i], v = +el.dataset.v;
    m.effect = m.effect === v ? null : v;
    if (!(m.effect > 0)) m.relief = null;
    touch();
  },
  'a-med-relief': el => { const m = draft().meds[+el.dataset.i], v = +el.dataset.v; m.relief = m.relief === v ? null : v; touch(); },
  'a-save': () => {
    const d = draft();
    if (!(d.vas > 0)) {
      document.getElementById('vas')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return toast('请拖动滑块选择疼痛强度');
    }
    const start = parseLocal(d.start);
    if (isNaN(start)) return toast('请填写开始时间');
    if (start > new Date(Date.now() + 5 * 60000)) return toast('开始时间不能晚于现在');
    const a = {
      id: d.id || uid(), start: start.toISOString(), vas: d.vas, severity: sevOfVas(d.vas),
      regions: d.regions, qualities: d.qualities, symptoms: d.symptoms, duration: d.duration, triggers: d.triggers,
      meds: d.meds.map(({ id, name, dose, time, effect, relief }) => ({ id: id || uid(), name, dose, time, effect, relief })),
      impact: d.impact ?? null, note: (d.note || '').trim(), createdAt: d.createdAt || Date.now(), updatedAt: Date.now(),
    };
    if (!d.regions.length && d.locations?.length) a.locations = d.locations;
    if (d.homeDay && d.homeDay !== dkey(start)) a.homeDay = d.homeDay;
    upsertAttack(a);
    // 首页有没保存的草稿时，把这次头痛同步过去；没有草稿的话首页会按保存的数据重新显示
    if (ui.today?.dirty && ui.today.date === S.attackDay(a)) { ui.today.vas = vasOf(a); ui.today.a = attackToToday(a); keepDraft(); }
    closeSheet(true);
    toast(d.id ? '已更新' : '已记录，好好休息');
  },
  'a-delete': () => {
    if (!confirm('删除这条头痛记录？')) return;
    deleteAttack(draft().id);
    closeSheet(true);
    toast('已删除');
  },

  // ---- 打卡 ----
  'c-period': () => mutateDay(ui.sheet.date, d => { d.period = !d.period; }),
  'c-meal': el => mutateDay(ui.sheet.date, d => { d.meals ||= { b: false, l: false, d: false }; d.meals[el.dataset.m] = !d.meals[el.dataset.m]; }),
  'c-caf': el => mutateDay(ui.sheet.date, d => {
    const logged = (d.foods || []).filter(f => CAFFEINE_ITEMS.includes(f.item)).length;
    d.caffeine = Math.max(logged, Math.min(10, (S.caffeineOf(d) ?? 0) + +el.dataset.d));
  }),
  'c-sleep': el => mutateDay(ui.sheet.date, d => { d.sleep = Math.max(0, Math.min(16, (d.sleep ?? 7) + +el.dataset.d)); }),
  'c-sleep-set': el => mutateDay(ui.sheet.date, d => { d.sleep = +el.dataset.v; }),
  'c-feel': el => mutateDay(ui.sheet.date, d => { d.mood ||= { feelings: [], factors: [] }; d.mood.feelings ||= []; toggleIn(d.mood.feelings, el.dataset.v); }),
  'c-factor': el => mutateDay(ui.sheet.date, d => { d.mood ||= { feelings: [], factors: [] }; d.mood.factors ||= []; toggleIn(d.mood.factors, el.dataset.v); }),
  'c-int': el => mutateDay(ui.sheet.date, d => { if (d.exIntensity === +el.dataset.v) delete d.exIntensity; else d.exIntensity = +el.dataset.v; }),
  'log-cat': el => { const key = `${el.dataset.kind}Cat`; ui.sheet[key] = ui.sheet[key] === el.dataset.v ? null : el.dataset.v; renderSheet(); },
  'log-add': el => addLog(el.dataset.kind, el.dataset.cat, el.dataset.item),
  'log-free': el => {
    const input = document.getElementById(`log-free-${el.dataset.kind}`), v = input?.value.trim();
    if (!v) return toast('先写一下是什么');
    addLog(el.dataset.kind, el.dataset.cat, v);
  },
  'log-del': el => mutateDay(ui.sheet.date, d => {
    const f = LOGS[el.dataset.kind].field;
    d[f] = (d[f] || []).filter(e => e.id !== el.dataset.id);
    // 旧版会在记“酒类”时自动打开“喝了酒”；删掉最后一条酒类记录时一并清掉
    if (f === 'foods' && d.alcohol && !d.foods.some(e => e.cat === '酒类')) delete d.alcohol;
  }),
  'scale-open': el => openSheet({ type: 'scale', k: el.dataset.k, date: ui.sheet?.date || todayKey(), answers: new Array(SCALES[el.dataset.k].items.length).fill(null), back: ui.sheet?.type === 'checkin' ? ui.sheet.date : null }),
  'scale-ans': el => { ui.sheet.answers[+el.dataset.i] = +el.dataset.v; ui.sheet.dirty = true; renderSheet(); },
  'scale-save': () => {
    const s = ui.sheet;
    if (!s.answers.every(a => a != null)) return toast('还有题目没选');
    const score = s.answers.reduce((t, a) => t + a, 0);
    patchDay(s.date, d => { d[s.k] = { score, answers: s.answers, at: hhmm(new Date()) }; });
    toast(`已保存：${score} 分 · ${scaleBand(s.k, score)}`);
    if (s.back) openSheet({ type: 'checkin', k: 'mood', date: s.back }); else closeSheet(true);
  },
  'log-kind': el => { ui.logKind = el.dataset.v; render(); },
  'log-sel': el => { ui.logSel ||= {}; const k = el.dataset.kind; ui.logSel[k] = ui.logSel[k] === el.dataset.v ? null : el.dataset.v; render(); },
  categorize: () => openSheet({ type: 'categorize' }),
  'cat-assign': el => {
    const { kind, name, cat } = el.dataset, f = LOGS[kind].field;
    for (const day of Object.values(state.days)) {
      if (!(day[f] || []).some(e => e.cat === UNCAT && e.item === name)) continue;
      const copy = structuredClone(day);
      copy[f] = copy[f].map(e => e.cat === UNCAT && e.item === name ? { ...e, cat } : e);
      saveDay(copy);
    }
    toast(`「${name}」已归入${cat}`);
    renderSheet();
  },
  noop: () => {},
  'c-ex': el => mutateDay(ui.sheet.date, d => { d.exercise = +el.dataset.v; }),
  'c-med-add': el => mutateDay(ui.sheet.date, d => {
    (d.meds ||= []).push({ id: uid(), name: el.dataset.name, dose: el.dataset.dose, kind: el.dataset.kind || 'acute', time: hhmm(new Date()) });
  }),
  'c-med-other': () => { ui.sheet.addingMed = !ui.sheet.addingMed; renderSheet(); },
  'c-med-prev': () => { ui.sheet.otherPreventive = !ui.sheet.otherPreventive; renderSheet(); },
  'c-med-add-other': () => {
    const name = document.getElementById('om-name').value.trim(), dose = document.getElementById('om-dose').value.trim();
    if (!name) return toast('请填写药名');
    const kind = ui.sheet.otherPreventive ? 'preventive' : 'acute';
    ui.sheet.addingMed = false;
    if (!state.settings.meds.some(m => m.name === name && m.dose === dose)) { state.settings.meds.push({ name, dose, kind }); saveSettings(); }
    mutateDay(ui.sheet.date, d => { (d.meds ||= []).push({ id: uid(), name, dose, kind, time: hhmm(new Date()) }); });
  },
  'c-med-del': el => mutateDay(ui.sheet.date, d => { d.meds = (d.meds || []).filter(m => m.id !== el.dataset.id); }),
  'c-clear': el => mutateDay(ui.sheet.date, d => {
    const fields = { period: ['period'], diet: ['meals', 'caffeine', 'alcohol', 'foods'], sleep: ['sleep'], mood: ['mood', 'stress'], exercise: ['exercise', 'exIntensity', 'workouts'] }[el.dataset.k] || [];
    for (const f of fields) delete d[f];
  }),

  // ---- 我的 ----
  'med-add': () => {
    const name = document.getElementById('nm-name').value.trim(), dose = document.getElementById('nm-dose').value.trim();
    if (!name) return toast('请填写药名');
    state.settings.meds.push({ name, dose, kind: 'acute' });
    saveSettings(); render();
  },
  'med-del': el => { state.settings.meds.splice(+el.dataset.i, 1); saveSettings(); render(); },
  'med-kind': el => { const m = state.settings.meds[+el.dataset.i]; m.kind = m.kind === 'preventive' ? 'acute' : 'preventive'; saveSettings(); render(); },
  'trig-del': el => { state.settings.customTriggers.splice(+el.dataset.i, 1); saveSettings(); render(); },
  report: () => openSheet({ type: 'report' }),
  'copy-report': async () => {
    try { await navigator.clipboard.writeText(buildReport()); toast('已复制，可以粘贴到备忘录或发给医生'); }
    catch { toast('复制失败，请长按文字手动复制'); }
  },
  'share-report': async () => {
    const text = buildReport();
    if (navigator.share) { try { await navigator.share({ title: '偏头痛记录摘要', text }); } catch { /* 取消 */ } }
    else ACTIONS['copy-report']();
  },
  'export-csv': exportCSV,
  'export-json': exportJSON,
  'import-json': () => document.getElementById('import-file').click(),
  'clear-all': async () => {
    if (!confirm('确定清除所有数据？这一步无法撤销，建议先「导出备份」。')) return;
    if (!confirm('再确认一次：清除全部头痛记录和打卡？')) return;
    await db.clearAll();
    state.attacks = []; state.days = {};
    state.settings = { name: '', meds: DEFAULT_MEDS.map(m => ({ ...m })), customTriggers: [], hideInstall: state.settings.hideInstall };
    saveSettings(); afterWrite(); render();
    toast('已清除');
  },
};

const toggleIn = (arr, v) => { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); else arr.push(v); };
function addLog(kind, cat, item) {
  const f = LOGS[kind].field;
  mutateDay(ui.sheet.date, d => {
    (d[f] ||= []).push({ id: uid(), cat, item, note: '' });
  });
}

const INPUTS = {
  't-vas': el => {
    const t = todayState(), v = snapVal(el);
    t.vas = v; t.a.vas = v || null;
    $app.querySelector('#t-vas').innerHTML = vasLabel(v);
    keepDraft(); syncToday();
  },
  't-sleep-r': el => {
    const t = todayState();
    t.sleep = snapVal(el);
    el.classList.remove('unset');
    $app.querySelector('#t-sleep').innerHTML = sleepLabel(t.sleep);
    keepDraft(); syncToday();
  },
  'log-note': el => {
    const f = LOGS[el.dataset.kind].field, id = el.dataset.id, v = el.value;
    clearTimeout(INPUTS.ln);
    INPUTS.ln = setTimeout(() => patchDay(ui.sheet.date, d => { const e = (d[f] || []).find(x => x.id === id); if (e) e.note = v; }), 300);
  },
  'c-valence': el => {
    const v = snapVal(el);
    patchDay(ui.sheet.date, d => { d.mood = { feelings: [], factors: [], ...(d.mood || {}), valence: v }; });
    updateMoodTop(v);
  },
  'a-date': el => {
    if (!el.value) return;
    draft().start = `${el.value}T${draft().start.split('T')[1] || '00:00'}`;
    ui.sheet.dirty = true; updateStartPicker();
  },
  'a-time': el => {
    if (!el.value) return;
    draft().start = `${draft().start.split('T')[0]}T${el.value}`;
    ui.sheet.dirty = true; updateStartPicker();
  },
  'a-note': el => { draft().note = el.value; ui.sheet.dirty = true; },
  'a-med-time': el => { draft().meds[+el.dataset.i].time = el.value; ui.sheet.dirty = true; },
  'a-vas': el => { const v = snapVal(el); draft().vas = v > 0 ? v : null; ui.sheet.dirty = true; updateVasWidget(v); },
  name: el => { state.settings.name = el.value; clearTimeout(INPUTS.t); INPUTS.t = setTimeout(saveSettings, 400); },
};

// 内容能不能铺到状态栏（刘海 / 灵动岛）后面：能的话首页那幅画一直画到屏幕顶
function checkBleed() {
  const p = document.createElement('div');
  p.style.cssText = 'position:fixed;top:0;left:0;width:0;height:env(safe-area-inset-top,0px);visibility:hidden';
  document.body.appendChild(p);
  document.documentElement.classList.toggle('bleed', p.offsetHeight >= 20);
  p.remove();
}
checkBleed();
window.addEventListener('resize', () => { checkBleed(); closeIsland(true); });

document.addEventListener('click', e => {
  // 桌面浏览器点透明的日期 / 时间框不会自动弹出选择器，手动打开（iOS 点一下本来就会弹出）
  const picker = e.target.closest('.dt-pill input');
  if (picker && !isIOS) { try { picker.showPicker(); } catch { /* 不支持 */ } }
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = ACTIONS[el.dataset.act];
  if (fn) {
    e.preventDefault();
    if (POP_ACTS.has(el.dataset.act)) lastHit = hitKey(el);
    fn(el, e);
  }
});
// 滑块不分格，拇指一直跟着手指走；值按最近的一格算（格子变了才通知），松手后拇指滑到那一格上
const snapVal = el => { const k = +el.dataset.snap || 1; return Math.round(+el.value / k) * k; };
let settleRaf = 0;
function settleRange(el) {
  const from = +el.value, to = snapVal(el);
  cancelAnimationFrame(settleRaf);
  if (Math.abs(to - from) < 1e-3 || reduceMotion.matches) { el.value = to; return; }
  const t0 = performance.now();
  const step = now => {
    const p = Math.min(1, (now - t0) / 180);
    el.value = from + (to - from) * (1 - (1 - p) ** 3);
    if (p < 1 && el.isConnected) settleRaf = requestAnimationFrame(step);
  };
  settleRaf = requestAnimationFrame(step);
}
document.addEventListener('input', e => {
  const el = e.target.closest('[data-input]');
  if (!el) return;
  if (el.dataset.snap) {
    cancelAnimationFrame(settleRaf);
    const v = String(snapVal(el));
    if (el.dataset.sv === v) return;
    el.dataset.sv = v;
  }
  INPUTS[el.dataset.input]?.(el, e);
});
document.addEventListener('change', e => {
  if (e.target.dataset?.snap) settleRange(e.target);
  if (e.target.id === 'import-file' && e.target.files[0]) { importJSON(e.target.files[0]); e.target.value = ''; }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && ui.island) return closeIsland();
  if (e.key === 'Escape' && ui.sheet) return closeSheet();
  const el = e.target.closest?.('[data-act="region"]');
  if (el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); ACTIONS.region(el); }
});

// 下拉关闭弹层
let drag = null;
$sheet.addEventListener('touchstart', e => {
  if (!e.target.closest('.grab, .sheet-head') || e.target.closest('button')) return;
  const el = $sheet.querySelector('.sheet');
  drag = { y: e.touches[0].clientY, el, dy: 0 };
  el.style.transition = 'none';
}, { passive: true });
$sheet.addEventListener('touchmove', e => {
  if (!drag) return;
  drag.dy = Math.max(0, e.touches[0].clientY - drag.y);
  drag.el.style.transform = `translate(-50%, ${drag.dy}px)`;
}, { passive: true });
$sheet.addEventListener('touchend', () => {
  if (!drag) return;
  const { el, dy } = drag;
  drag = null;
  el.style.transition = '';
  el.style.transform = '';
  if (dy > 110) closeSheet();
});

// 回到前台时刷新（日期可能已经变了）
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  invalidate();
  if (ui.sel && ui.sel < dkey(startOfMonth(new Date())) && ui.month.getTime() === startOfMonth(new Date()).getTime()) ui.sel = todayKey();
  render();
});

// ======================= 启动 =======================
(async function init() {
  await load();
  render();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
})();

// 方便调试：在控制台查看分析结果
window.__diary = { state, analysis: () => S.analyze(state), intensity: () => S.intensityModel(state) };
