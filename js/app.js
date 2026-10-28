import * as db from './db.js';
import {
  WEEK, dkey, parseKey, shiftKey, todayKey, startOfMonth, addMonths, hhmm, toLocalInput, md, mdw, uid, esc, fmtNum, pct,
  SEVERITY, SYMPTOMS, DURATIONS, durationOf, TRIGGERS, EFFECTS, RELIEF, STRESS, MEALS, DEFAULT_MEDS, icon,
  vasOf, sevOfVas, vasWord, REGIONS, REGION_IDS, LAT_LABEL, laterality, regionSummary, QUALITIES,
} from './util.js';
import { headSVG, VIEWS, VIEW_REGIONS } from './headmap.js';
import * as S from './stats.js';

// ======================= 状态 =======================
const state = {
  attacks: [],
  days: {},
  settings: { name: '', meds: DEFAULT_MEDS.map(m => ({ ...m })), customTriggers: [], hideInstall: false },
};
const ui = { tab: 'home', prevTab: null, month: startOfMonth(new Date()), sel: todayKey(), sheet: null };
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
}

let persistAsked = false;
function afterWrite() {
  invalidate();
  if (!persistAsked) { persistAsked = true; db.requestPersist(); }
}

const saveSettings = () => db.put('meta', { key: 'settings', value: state.settings });

function saveDay(day) {
  if (S.hasDayData(day)) {
    state.days[day.date] = day;
    db.put('days', day);
  } else {
    delete state.days[day.date];
    db.remove('days', day.date);
  }
  afterWrite();
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
const fmtOR = x => x >= 10 ? x.toFixed(0) : x >= 1 ? x.toFixed(1) : x.toFixed(2);
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
const TABS = [['home', '今天', 'home'], ['records', '记录', 'list'], ['analysis', '分析', 'chart'], ['me', '我的', 'user']];

function render() {
  const views = { home: viewHome, records: viewRecords, analysis: viewAnalysis, me: viewMe };
  const anim = ui.tab !== ui.prevTab;
  if (anim) window.scrollTo(0, 0);
  ui.prevTab = ui.tab;
  $app.innerHTML = `
    <main class="view v-${ui.tab} ${anim ? 'anim' : ''}">${views[ui.tab]()}</main>
    <nav class="tabbar" aria-label="主导航">
      ${TABS.map(([k, label, ic]) => `<button class="tab ${ui.tab === k ? 'on' : ''} ${ui.tab === k && anim ? 'just' : ''}" data-act="tab" data-tab="${k}" ${ui.tab === k ? 'aria-current="page"' : ''}>${icon(ic, 23, ui.tab === k ? 2.1 : 1.8)}<span>${label}</span></button>`).join('')}
    </nav>`;
  ui.heroEnter = false;
  bindTrend();
  if (anim) countUp($app);
  else popLast($app);
  if (ui.tab === 'me') updatePersistInfo();
}

// 轻点反馈：重新渲染后，给刚点过的那个元素加一个弹跳动画
const POP_ACTS = new Set(['head-view', 'figure', 'a-toggle','a-dur', 'region', 'a-med-effect', 'a-med-relief', 'a-ago', 'c-meal', 'c-stress', 'c-ex', 'c-sleep-set', 'c-period', 'c-alc', 'sel-day', 'med-kind']);
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
  { k: 'diet', label: '饮食', ic: 'utensils', color: 'var(--t-diet)' },
  { k: 'sleep', label: '睡眠', ic: 'moon', color: 'var(--t-sleep)' },
  { k: 'stress', label: '压力', ic: 'pulse', color: 'var(--t-stress)' },
  { k: 'exercise', label: '运动', ic: 'dumbbell', color: 'var(--t-exercise)' },
  { k: 'meds', label: '服药', ic: 'pill', color: 'var(--t-meds)' },
];

function tileValue(k, date) {
  const d = state.days[date] || {};
  switch (k) {
    case 'period':
      if (d.period === true) return [true, `第 ${S.periodDayNumber(state.days, date)} 天`];
      return d.period === false ? [true, '不在经期'] : [false, '未记录'];
    case 'diet': {
      if (!d.meals && d.caffeine == null && d.alcohol == null) return [false, '未记录'];
      const parts = [];
      if (d.meals) parts.push(`${MEALS.filter(([m]) => d.meals[m]).length} 餐`);
      if (d.caffeine) parts.push(`咖啡 ${d.caffeine}`);
      if (!parts.length && d.alcohol) parts.push('饮酒');
      return [true, parts.join(' · ') || '已记录'];
    }
    case 'sleep': return d.sleep != null ? [true, `${d.sleep} 小时`] : [false, '未记录'];
    case 'stress': return d.stress ? [true, `${STRESS[d.stress]}`] : [false, '未记录'];
    case 'exercise': return d.exercise != null ? [true, d.exercise ? `${d.exercise} 分钟` : '没有运动'] : [false, '未记录'];
    case 'meds': { const n = dosesOn(date).length; return n ? [true, `${n} 次`] : [false, '未服药']; }
  }
  return [false, ''];
}

function installBanner() {
  if (!isIOS || isStandalone() || state.settings.hideInstall) return '';
  return `<div class="banner"><span class="li-ic gl">${icon('download', 18, 2)}</span><div class="grow"><b>添加到主屏幕</b>点 Safari 的「分享」按钮，选「添加到主屏幕」。之后从桌面图标打开，像 App 一样使用，数据一直保存在这台手机上。</div>
    <button class="icon-btn" data-act="hide-install" aria-label="不再提示">${icon('x', 18)}</button></div>`;
}

function heroCard() {
  const tk = todayKey(), day = state.days[tk], todays = attacksOn(tk), A = analysis();
  const cls = `hero ${ui.heroEnter ? 'enter' : ''}`;
  if (todays.length) {
    const a = todays[0], v = vasOf(a);
    const meta = [regionSummary(a), a.qualities?.[0], a.meds?.length ? '已服药' : '还没服药'].filter(Boolean);
    return `<section class="${cls}">
      <div class="label">今天 ${hhmm(new Date(a.start))} 开始头痛${todays.length > 1 ? ` · 共 ${todays.length} 次` : ''}</div>
      <div class="vas-big"><b>${counted(v)}</b><span>/10 · ${vasWord(v)}</span></div>
      <div class="meta-line">${meta.map(m => `<span>${esc(m)}</span>`).join('<i>·</i>')}</div>
      <div class="actions"><button class="hbtn" data-act="edit-attack" data-id="${a.id}">${icon('edit', 18)}查看 / 修改</button>
        <button class="hbtn solid" data-act="new-attack">${icon('plus', 18, 2.2)}再记一次</button></div>
    </section>`;
  }
  if (day?.pain === 0) {
    return `<section class="${cls}">
      <div class="label">今天</div><h2>没有头痛 ${icon('checkCircle', 22, 2)}</h2>
      <p>${['继续保持，记得按时吃饭、多喝水', '好好休息，今天也很棒', '状态不错，晚上早点睡'][new Date().getDate() % 3]}</p>
      <button class="link" data-act="new-attack">其实头痛了？记录一下 ${icon('chevR', 16)}</button>
    </section>`;
  }
  const risk = A.forecast && A.forecast.ratio >= 1.5
    ? `<div class="risk">${icon('alert', 18)}<span>根据今天的打卡，发作风险比平时高（约 ${pct(A.forecast.p)}），可以早点休息、把药带在身边。</span></div>` : '';
  return `<section class="${cls}">
    <div class="label">今日状态</div><h2>今天头痛了吗？</h2><p>每天点一下，分析会更准确</p>
    <div class="actions"><button class="hbtn" data-act="no-pain">${icon('check', 18, 2.2)}没有头痛</button>
      <button class="hbtn solid" data-act="new-attack">${icon('plus', 18, 2.2)}记录头痛</button></div>
    ${risk}
  </section>`;
}

function viewHome() {
  const now = new Date(), tk = todayKey();
  const h = now.getHours();
  const greet = h < 5 ? '夜深了' : h < 11 ? '早上好' : h < 13 ? '中午好' : h < 18 ? '下午好' : '晚上好';
  const name = (state.settings.name || '').trim();
  const streak = streakDays();
  const done = TILES.filter(t => tileValue(t.k, tk)[0]).length;
  return `
  ${header(`${now.getMonth() + 1}月${now.getDate()}日 星期${WEEK[now.getDay()]}`, `${greet}${name ? '，' + esc(name) : ''}`,
    `<div class="top-actions">${streak >= 2 ? `<span class="streak">${icon('flame', 15, 2)}${streak} 天</span>` : ''}
      <button class="avatar" data-act="tab" data-tab="me" aria-label="我的">${name ? esc([...name][0]) : icon('user', 20, 2)}</button></div>`)}
  ${installBanner()}
  ${heroCard()}
  <div class="sec"><h2>今日打卡</h2>
    <svg class="check-ring" viewBox="0 0 22 22" aria-hidden="true"><circle cx="11" cy="11" r="9" fill="none" style="stroke:var(--fill-2)" stroke-width="3"/>
      ${done ? `<circle class="val" cx="11" cy="11" r="9" fill="none" stroke-width="3" stroke-linecap="round" stroke-dasharray="${(done / 6 * 56.5).toFixed(1)} 56.5"/>` : ''}</svg>
    <span class="progress-text">${done}/6</span></div>
  <div class="grid3">
    ${TILES.map(t => {
      const [ok, text] = tileValue(t.k, tk);
      return `<button class="tile ${ok ? 'done' : ''}" data-act="tile" data-k="${t.k}" aria-label="${t.label}：${esc(text)}">
        <span class="gl" style="--c:${t.color}">${icon(t.ic, 20, 2.1)}</span><b>${t.label}</b><span class="val">${esc(text)}</span>
        ${ok ? `<i class="tick">${icon('check', 12, 3.2)}</i>` : ''}</button>`;
    }).join('')}
  </div>
  <div class="sec"><h2>近 30 天</h2><span class="meta">本月 ${state.attacks.filter(a => S.attackDay(a).startsWith(tk.slice(0, 7))).length} 次</span></div>
  ${trendCard()}`;
}

// 近 30 天：上方为疼痛强度柱（0–10），下方为睡眠折线（两个面板，各自一条轴）
let trendPts = [];
const TW = 320, TL = 22, TR = 4, TSLOT = (TW - TL - TR) / 30;
const tx = i => TL + TSLOT * i + TSLOT / 2;

function trendCard() {
  const tk = todayKey(), byDay = S.indexAttacks(state.attacks);
  trendPts = [];
  for (let i = 29; i >= 0; i--) {
    const k = shiftKey(tk, -i);
    trendPts.push({ k, vas: maxVas(byDay.get(k) || []), sleep: state.days[k]?.sleep ?? null });
  }
  const base = 70, unit = 6, bw = 6, r = 2.5;
  let bars = '';
  trendPts.forEach((p, i) => {
    if (!p.vas) return;
    const x0 = tx(i) - bw / 2, y0 = base - Math.max(3, p.vas * unit);
    bars += `<path class="bar-anim" d="M${x0} ${base}V${y0 + r}Q${x0} ${y0} ${x0 + r} ${y0}H${x0 + bw - r}Q${x0 + bw} ${y0} ${x0 + bw} ${y0 + r}V${base}Z" style="fill:var(--sev${sevOfVas(p.vas)});animation-delay:${(0.2 + i * 0.015).toFixed(3)}s"/>`;
  });
  const sy = s => 124 - (Math.max(4, Math.min(10, s)) - 4) / 6 * 34;
  let path = '', dots = '';
  trendPts.forEach((p, i) => {
    if (p.sleep == null) return;
    const prev = trendPts[i - 1]?.sleep, next = trendPts[i + 1]?.sleep;
    path += `${prev == null ? 'M' : 'L'}${tx(i).toFixed(1)} ${sy(p.sleep).toFixed(1)}`;
    if (prev == null && next == null) dots += `<circle cx="${tx(i)}" cy="${sy(p.sleep)}" r="3" style="fill:var(--accent)"/>`;
  });
  const last = [...trendPts].reverse().find(p => p.sleep != null);
  if (last) dots += `<circle cx="${tx(trendPts.indexOf(last))}" cy="${sy(last.sleep)}" r="4" style="fill:var(--accent);stroke:var(--card);stroke-width:2"/>`;
  const anyAttack = trendPts.some(p => p.vas), anySleep = !!last;
  const short = k => md(k).replace('月', '/').replace('日', '');
  return `<section class="card">
    <div class="chart-wrap" data-chart="trend">
      <svg viewBox="0 0 ${TW} 144" role="img" aria-label="近 30 天头痛强度与睡眠时长">
        ${[5, 10].map(v => `<line class="grid-line" x1="${TL}" x2="${TW - TR}" y1="${base - v * unit}" y2="${base - v * unit}"/><text x="0" y="${base - v * unit + 3}">${v}</text>`).join('')}
        <line x1="${TL}" x2="${TW - TR}" y1="${base}" y2="${base}" style="stroke:var(--fill-2)"/>
        ${bars}
        ${anyAttack ? '' : `<text x="${(TL + TW) / 2}" y="46" text-anchor="middle">近 30 天没有头痛</text>`}
        <line class="grid-line" x1="${TL}" x2="${TW - TR}" y1="${sy(7)}" y2="${sy(7)}"/><text x="0" y="${sy(7) + 3}">7h</text>
        ${anySleep ? `<path d="${path}" fill="none" style="stroke:var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${dots}`
          : `<text x="${(TL + TW) / 2}" y="${sy(7) - 6}" text-anchor="middle">在「睡眠」打卡后显示</text>`}
        <line class="hl" x1="-10" x2="-10" y1="4" y2="126" style="stroke:var(--ink-3)" stroke-width="1" opacity="0"/>
        <text x="${TL}" y="141">${short(trendPts[0].k)}</text>
        <text x="${tx(15)}" y="141" text-anchor="middle">${short(trendPts[15].k)}</text>
        <text x="${TW - TR}" y="141" text-anchor="end">今天</text>
      </svg>
      <div class="tip" role="status"></div>
    </div>
    <div class="legend">
      <span><i class="sw" style="background:var(--sev1)"></i>轻 1–3</span>
      <span><i class="sw" style="background:var(--sev2)"></i>中 4–6</span>
      <span><i class="sw" style="background:var(--sev3)"></i>重 7–10</span>
      <span><i class="line-key"></i>睡眠时长</span>
    </div>
  </section>`;
}

function bindTrend() {
  const wrap = document.querySelector('[data-chart="trend"]');
  if (!wrap) return;
  const svg = wrap.querySelector('svg'), tip = wrap.querySelector('.tip'), hl = svg.querySelector('.hl');
  let hideTimer;
  const hide = () => { tip.classList.remove('show'); hl.setAttribute('opacity', '0'); };
  const show = e => {
    const rect = svg.getBoundingClientRect();
    const i = Math.floor(((e.clientX - rect.left) / rect.width * TW - TL) / TSLOT);
    if (i < 0 || i > 29) return hide();
    const p = trendPts[i];
    tip.innerHTML = `${md(p.k)}<br>${p.vas ? `头痛 ${p.vas}/10` : '无头痛'}${p.sleep != null ? ` · 睡眠 ${p.sleep}h` : ''}`;
    tip.style.left = Math.max(22, Math.min(78, tx(i) / TW * 100)) + '%';
    tip.classList.add('show');
    hl.setAttribute('x1', tx(i)); hl.setAttribute('x2', tx(i)); hl.setAttribute('opacity', '.5');
    clearTimeout(hideTimer);
  };
  svg.addEventListener('pointermove', show);
  svg.addEventListener('pointerdown', show);
  svg.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') hide(); else hideTimer = setTimeout(hide, 2500); });
}

// ----------------------- 记录 -----------------------
function viewRecords() {
  const list = state.attacks;
  const head = header(list.length ? `共 ${list.length} 次头痛` : '还没有记录', '记录');
  if (!list.length) {
    return head + `<div class="empty"><div class="art">${icon('file', 38)}</div><h3>这里会列出每一次头痛</h3>
      <p>头痛时点「记录头痛」，滑一下强度、点一下部位，几秒钟就能记完。</p>
      <button class="btn primary" data-act="new-attack">${icon('plus', 18, 2.2)}记录头痛</button></div>`;
  }
  const groups = new Map();
  for (const a of list) {
    const k = S.attackDay(a).slice(0, 7);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }
  let html = head;
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
  ${header('头痛日记', '分析', `<div class="month-nav">
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
    <div class="card-head"><h3>头痛日历</h3><span class="meta">点日期查看或补记</span></div>
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

function dayDetail(k) {
  if (!k || k.slice(0, 7) !== dkey(ui.month).slice(0, 7) || k > todayKey()) return '';
  const atk = attacksOn(k), d = state.days[k] || {}, doses = dosesOn(k);
  const pills = [];
  if (d.pain === 0 && !atk.length) pills.push('<span class="pill">没有头痛</span>');
  if (d.period) pills.push(`<span class="pill"><i class="bar-key" style="background:var(--period)"></i>经期第 ${S.periodDayNumber(state.days, k)} 天</span>`);
  if (d.sleep != null) pills.push(`<span class="pill">睡眠 ${d.sleep}h</span>`);
  if (d.stress) pills.push(`<span class="pill">压力${STRESS[d.stress]}</span>`);
  if (d.meals) pills.push(`<span class="pill">吃了 ${MEALS.filter(([m]) => d.meals[m]).length} 餐</span>`);
  if (d.caffeine) pills.push(`<span class="pill">咖啡 ${d.caffeine} 杯</span>`);
  if (d.alcohol) pills.push('<span class="pill">饮酒</span>');
  if (d.exercise != null) pills.push(`<span class="pill">${d.exercise ? `运动 ${d.exercise} 分钟` : '没运动'}</span>`);
  if (doses.length) pills.push(`<span class="pill"><i class="dot" style="background:var(--med);width:6px;height:6px"></i>${doses.map(m => esc(m.name)).join('、')}</span>`);
  return `<div class="day-detail">
    <h4>${mdw(k)}</h4>
    ${atk.map(a => `<button class="mini-rec" data-act="edit-attack" data-id="${a.id}"><span class="vb s${sevOfVas(vasOf(a))}">${vasOf(a)}</span>
      <span class="grow">${hhmm(new Date(a.start))} · ${esc([regionSummary(a), a.qualities?.[0], a.duration ? durationOf(a.duration).label : ''].filter(Boolean).join(' · ') || vasWord(vasOf(a)))}</span>
      <span class="chev">${icon('chevR', 16)}</span></button>`).join('')}
    ${pills.length ? `<div class="kv">${pills.join('')}</div>` : atk.length ? '' : '<p class="muted" style="margin:0;font-size:14px">这天没有记录</p>'}
    <div class="btn-row">
      <button class="btn pain" data-act="new-attack" data-k="${k}">${icon('plus', 18, 2.2)}补记头痛</button>
      <button class="btn tint" data-act="edit-day" data-k="${k}">${icon('edit', 18)}编辑打卡</button>
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
    <div class="row"><span class="li-ic gl" style="--c:var(--ink-3)">${icon('info', 18, 2)}</span><div class="grow"><div class="t">仅用于记录和自我观察</div><div class="s">不能替代医生的诊断和治疗建议 · 头痛日记 v1.3</div></div></div>
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
    <input class="range" type="range" min="0" max="10" step="1" value="${set ? v : 0}" data-input="a-vas" aria-label="疼痛强度，0 到 10 分" aria-valuetext="${set ? `${v} 分，${vasWord(v)}` : '未选择'}">
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
      <section class="card"><h4>咖啡 / 浓茶</h4><div class="stepper">
        <button data-act="c-caf" data-d="-1" aria-label="减少一杯">−</button><div class="big">${d.caffeine ?? 0}<small>杯</small></div>
        <button data-act="c-caf" data-d="1" aria-label="增加一杯">+</button></div></section>
      <section class="card"><div class="switch-row"><span>喝了酒</span>
        <button class="switch ${d.alcohol ? 'on' : ''}" role="switch" aria-checked="${!!d.alcohol}" data-act="c-alc" aria-label="喝了酒"></button></div></section>`;
    }
    case 'sleep':
      return `<section class="card"><h4>前一晚睡了多久</h4><div class="stepper">
        <button data-act="c-sleep" data-d="-0.5" aria-label="减少半小时">−</button><div class="big">${d.sleep ?? '–'}<small>小时</small></div>
        <button data-act="c-sleep" data-d="0.5" aria-label="增加半小时">+</button></div>
        <div class="seg-ctl" style="margin-top:14px">${[5, 6, 7, 8, 9].map(v => `<button class="${d.sleep === v ? 'on' : ''}" data-act="c-sleep-set" data-v="${v}">${v}h</button>`).join('')}</div></section>`;
    case 'stress':
      return `<section class="card"><h4>今天的压力</h4>
        <div class="seg-ctl">${[1, 2, 3].map(v => `<button class="${d.stress === v ? 'on' : ''}" data-act="c-stress" data-v="${v}" aria-pressed="${d.stress === v}">${STRESS[v]}</button>`).join('')}</div>
        <p class="note">低：放松平静　中等：有点紧张但能应对　高：紧绷、焦虑或非常忙</p></section>`;
    case 'exercise':
      return `<section class="card"><h4>运动时长</h4>
        <div class="chips">${[0, 15, 30, 45, 60, 90].map(v => `<button class="chip ${d.exercise === v ? 'on' : ''}" data-act="c-ex" data-v="${v}">${v ? v + ' 分钟' : '没有运动'}</button>`).join('')}</div></section>`;
    case 'meds':
      return medsDayEditor(date);
  }
  return '';
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
  lines.push('', '头痛明细：');
  for (const a of list) {
    const d = new Date(a.start);
    const meds = (a.meds || []).map(m => `${m.name}${m.dose ? ' ' + m.dose : ''}${m.effect != null ? '，' + EFFECTS[m.effect].label : ''}`).join('；');
    lines.push(`${d.getMonth() + 1}/${d.getDate()} ${hhmm(d)} 强度${vasOf(a)} ${a.duration ? durationOf(a.duration).label : ''} ${regionSummary(a)} ${(a.qualities || []).join('、')} ${(a.symptoms || []).join('、')}${meds ? ' | ' + meds : ''}`.replace(/\s+/g, ' ').trim());
  }
  if (!list.length) lines.push('（无）');
  lines.push('', '由「头痛日记」生成，仅供参考。');
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
  const head = ['日期', '强度(0-10)', '开始时间', '持续', '侧别', '部位', '性质', '伴随症状', '诱因', '用药', '睡眠(小时)', '压力', '三餐', '咖啡因(杯)', '饮酒', '运动(分钟)', '经期', '无头痛', '备注'];
  const keys = [...new Set([...Object.keys(state.days), ...state.attacks.map(S.attackDay)])].sort();
  const rows = [head.map(q).join(',')];
  for (const k of keys) {
    const d = state.days[k] || {}, atks = attacksOn(k);
    const daily = [d.sleep, d.stress ? STRESS[d.stress] : '', d.meals ? MEALS.filter(([m]) => d.meals[m]).map(([, l]) => l).join('/') : '',
      d.caffeine, d.alcohol == null ? '' : d.alcohol ? '是' : '否', d.exercise, d.period ? '是' : '', d.pain === 0 ? '是' : ''];
    const extraMeds = (d.meds || []).map(m => `${m.name} ${m.dose || ''}${m.time ? ' ' + m.time : ''}`).join('; ');
    if (!atks.length) rows.push([k, '', '', '', '', '', '', '', '', extraMeds, ...daily, ''].map(q).join(','));
    for (const a of atks.slice().reverse()) {
      const meds = [...(a.meds || []).map(m => `${m.name} ${m.dose || ''}${m.time ? ' ' + m.time : ''}${m.effect != null ? ' ' + EFFECTS[m.effect].label : ''}`), extraMeds].filter(Boolean).join('; ');
      const regions = a.regions?.length ? a.regions.map(r => REGIONS[r]?.label).join('/') : (a.locations || []).join('/');
      rows.push([k, vasOf(a), hhmm(new Date(a.start)), a.duration ? durationOf(a.duration).label : '', LAT_LABEL[laterality(a)] || '', regions,
        (a.qualities || []).join('/'), (a.symptoms || []).join('/'), (a.triggers || []).join('/'), meds, ...daily, a.note].map(q).join(','));
    }
  }
  shareOrDownload(`头痛日记-${todayKey()}.csv`, '﻿' + rows.join('\r\n'), 'text/csv');
}

function exportJSON() {
  const data = { app: 'migraine-diary', version: 2, exportedAt: new Date().toISOString(), attacks: state.attacks, days: Object.values(state.days), settings: state.settings };
  shareOrDownload(`头痛日记备份-${todayKey()}.json`, JSON.stringify(data, null, 1), 'application/json');
}

async function importJSON(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { return toast('文件格式不对，无法读取'); }
  if (!data || !Array.isArray(data.attacks) || !Array.isArray(data.days)) return toast('这不是头痛日记的备份文件');
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

  'no-pain': () => {
    const tk = todayKey();
    if (attacksOn(tk).length) return toast('今天已有头痛记录');
    const day = structuredClone(state.days[tk] || { date: tk });
    day.pain = 0;
    saveDay(day);
    ui.heroEnter = true;
    render();
    toast('已记录：今天没有头痛');
  },
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
      meds: d.meds.map(({ id, name, dose, time, effect, relief }) => ({ id, name, dose, time, effect, relief })),
      note: (d.note || '').trim(), createdAt: d.createdAt || Date.now(), updatedAt: Date.now(),
    };
    if (!d.regions.length && d.locations?.length) a.locations = d.locations;
    upsertAttack(a);
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
  'c-caf': el => mutateDay(ui.sheet.date, d => { d.caffeine = Math.max(0, Math.min(10, (d.caffeine ?? 0) + +el.dataset.d)); }),
  'c-alc': () => mutateDay(ui.sheet.date, d => { d.alcohol = !d.alcohol; }),
  'c-sleep': el => mutateDay(ui.sheet.date, d => { d.sleep = Math.max(0, Math.min(16, (d.sleep ?? 7) + +el.dataset.d)); }),
  'c-sleep-set': el => mutateDay(ui.sheet.date, d => { d.sleep = +el.dataset.v; }),
  'c-stress': el => mutateDay(ui.sheet.date, d => { if (d.stress === +el.dataset.v) delete d.stress; else d.stress = +el.dataset.v; }),
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
    const fields = { period: ['period'], diet: ['meals', 'caffeine', 'alcohol'], sleep: ['sleep'], stress: ['stress'], exercise: ['exercise'] }[el.dataset.k] || [];
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

const INPUTS = {
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
  'a-vas': el => { const v = +el.value; draft().vas = v > 0 ? v : null; ui.sheet.dirty = true; updateVasWidget(v); },
  name: el => { state.settings.name = el.value; clearTimeout(INPUTS.t); INPUTS.t = setTimeout(saveSettings, 400); },
};

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
document.addEventListener('input', e => {
  const el = e.target.closest('[data-input]');
  if (el) INPUTS[el.dataset.input]?.(el, e);
});
document.addEventListener('change', e => {
  if (e.target.id === 'import-file' && e.target.files[0]) { importJSON(e.target.files[0]); e.target.value = ''; }
});
document.addEventListener('keydown', e => {
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
