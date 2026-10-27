import * as db from './db.js';
import {
  WEEK, dkey, parseKey, shiftKey, todayKey, startOfMonth, addMonths, hhmm, toLocalInput, md, mdw, uid, esc, fmtNum, pct,
  SEVERITY, LOCATIONS, SYMPTOMS, DURATIONS, durationOf, TRIGGERS, EFFECTS, RELIEF, STRESS, MEALS, DEFAULT_MEDS, icon,
} from './util.js';
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
async function load() {
  const { attacks, days, meta } = await db.loadAll();
  state.attacks = attacks.sort((a, b) => b.start.localeCompare(a.start));
  state.days = Object.fromEntries(days.map(d => [d.date, d]));
  const s = meta.find(m => m.key === 'settings');
  if (s) Object.assign(state.settings, s.value);
}

let persistAsked = false;
function afterWrite() {
  invalidate();
  if (!persistAsked) { persistAsked = true; db.requestPersist(); }
}

function saveSettings() {
  db.put('meta', { key: 'settings', value: state.settings });
}

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
  // 当天标记过“无痛”的话，去掉这个标记
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
const maxSev = list => list.reduce((m, a) => Math.max(m, a.severity || 0), 0);
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
const sevLabel = s => SEVERITY[s]?.label || '';

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
const TABS = [['home', '首页', 'home'], ['records', '记录', 'list'], ['analysis', '分析', 'chart'], ['me', '我的', 'user']];

function render() {
  const views = { home: viewHome, records: viewRecords, analysis: viewAnalysis, me: viewMe };
  const anim = ui.tab !== ui.prevTab;
  if (anim) window.scrollTo(0, 0);
  ui.prevTab = ui.tab;
  $app.innerHTML = `
    <main class="view v-${ui.tab} ${anim ? 'anim' : ''}">${views[ui.tab]()}</main>
    ${ui.tab === 'home' ? `<button class="fab" data-act="new-attack" aria-label="记录发作">${icon('plus', 28, 2.2)}</button>` : ''}
    <nav class="tabbar" aria-label="主导航">
      ${TABS.map(([k, label, ic]) => `<button class="tab ${ui.tab === k ? 'on' : ''}" data-act="tab" data-tab="${k}" ${ui.tab === k ? 'aria-current="page"' : ''}>${icon(ic, 22)}<span>${label}</span></button>`).join('')}
    </nav>`;
  bindTrend();
  if (ui.tab === 'me') updatePersistInfo();
}

// ----------------------- 首页 -----------------------
const TILES = [
  { k: 'period', label: '经期', ic: 'drop' },
  { k: 'diet', label: '饮食', ic: 'utensils' },
  { k: 'sleep', label: '睡眠', ic: 'moon' },
  { k: 'stress', label: '压力', ic: 'pulse' },
  { k: 'exercise', label: '运动', ic: 'dumbbell' },
  { k: 'meds', label: '服药', ic: 'pill' },
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
    case 'stress': return d.stress ? [true, STRESS[d.stress]] : [false, '未记录'];
    case 'exercise': return d.exercise != null ? [true, d.exercise ? `${d.exercise} 分钟` : '没有运动'] : [false, '未记录'];
    case 'meds': { const n = dosesOn(date).length; return n ? [true, `${n} 次`] : [false, '未服药']; }
  }
}

function installBanner() {
  if (!isIOS || isStandalone() || state.settings.hideInstall) return '';
  return `<div class="banner">${icon('download', 22)}<div class="grow"><b>添加到主屏幕，像 App 一样使用</b><br>点 Safari 的「分享」按钮，选「添加到主屏幕」。之后从桌面图标打开，数据会一直保存在这台手机上。</div>
    <button class="icon-btn" data-act="hide-install" aria-label="不再提示">${icon('x', 18)}</button></div>`;
}

function viewHome() {
  const now = new Date(), tk = todayKey(), day = state.days[tk];
  const todays = attacksOn(tk);
  const h = now.getHours();
  const greet = h < 5 ? '夜深了' : h < 11 ? '早上好' : h < 13 ? '中午好' : h < 18 ? '下午好' : '晚上好';
  const name = (state.settings.name || '').trim();
  const level = todays.length ? maxSev(todays) : day?.pain === 0 ? 0 : null;
  const streak = streakDays();
  const A = analysis();

  let msg;
  if (todays.length) {
    msg = todays.map(a => `<button class="today-attack" data-act="edit-attack" data-id="${a.id}">${icon('flame', 20)}
      <span class="grow">${hhmm(new Date(a.start))} 开始 · ${sevLabel(a.severity)}${a.duration ? ' · ' + durationOf(a.duration).label : ''}${a.meds?.length ? ' · 已服药' : ''}</span>${icon('chevR', 18)}</button>`).join('');
  } else if (level === 0) {
    msg = `<p class="status-msg">${['今天没有发作，好好休息', '今天没有头痛，继续保持', '状态不错，记得按时吃饭、多喝水'][now.getDate() % 3]}</p>`;
  } else {
    msg = `<p class="status-msg">今天感觉怎么样？点一下就能记录</p>`;
  }
  const risk = !todays.length && A.forecast && A.forecast.ratio >= 1.5
    ? `<div class="risk-hint">${icon('info', 20)}<span>根据今天的打卡，发作风险比平时高（约 ${pct(A.forecast.p)}）。可以早点休息、把药带在身边。</span></div>` : '';

  return `
  <header class="top">
    <div><div class="date">${now.getMonth() + 1}月${now.getDate()}日 星期${WEEK[now.getDay()]}</div>
      <h1>${greet}${name ? '，' + esc(name) : ''}</h1></div>
    <button class="avatar" data-act="tab" data-tab="me" aria-label="我的">${name ? esc([...name][0]) : icon('user', 26)}</button>
  </header>
  ${installBanner()}
  <section class="card">
    <div class="card-head"><h2>今日状态</h2>${streak >= 2 ? `<span class="streak">${icon('flame', 16)}已连续记录 ${streak} 天</span>` : ''}</div>
    <div class="seg" role="group" aria-label="今天的头痛程度">
      ${[0, 1, 2, 3].map(v => `<button class="chip ${level === v ? 'on' : ''} ${v && level === v ? 'hot' : ''}" data-act="status" data-v="${v}" aria-pressed="${level === v}">${v ? SEVERITY[v].label : '无痛'}</button>`).join('')}
    </div>
    ${msg}${risk}
  </section>
  <h2 class="section-title">今日打卡</h2>
  <div class="grid3">
    ${TILES.map(t => {
      const [done, text] = tileValue(t.k, tk);
      return `<button class="tile t-${t.k} ${done ? 'done' : ''}" data-act="tile" data-k="${t.k}">
        <span class="ti">${icon(t.ic, 26)}</span><b>${t.label}</b><span>${esc(text)}</span>
        ${done ? `<i class="tick">${icon('check', 12, 3)}</i>` : ''}</button>`;
    }).join('')}
  </div>
  ${trendCard()}`;
}

// 近 30 天：上方为头痛程度柱，下方为睡眠折线（两个面板，各自一条轴）
let trendPts = [];
const TW = 320, TL = 22, TR = 4, TSLOT = (TW - TL - TR) / 30;
const tx = i => TL + TSLOT * i + TSLOT / 2;

function trendCard() {
  const tk = todayKey(), byDay = S.indexAttacks(state.attacks);
  trendPts = [];
  for (let i = 29; i >= 0; i--) {
    const k = shiftKey(tk, -i);
    trendPts.push({ k, sev: maxSev(byDay.get(k) || []), sleep: state.days[k]?.sleep ?? null });
  }
  const monthN = state.attacks.filter(a => S.attackDay(a).startsWith(tk.slice(0, 7))).length;
  const base = 70, unit = 20, bw = 6, r = 2.5;
  let bars = '';
  trendPts.forEach((p, i) => {
    if (!p.sev) return;
    const x0 = tx(i) - bw / 2, y0 = base - p.sev * unit;
    bars += `<path d="M${x0} ${base}V${y0 + r}Q${x0} ${y0} ${x0 + r} ${y0}H${x0 + bw - r}Q${x0 + bw} ${y0} ${x0 + bw} ${y0 + r}V${base}Z" style="fill:var(--sev${p.sev})"/>`;
  });
  const sy = s => 122 - (Math.max(4, Math.min(10, s)) - 4) / 6 * 36;
  let path = '', dots = '';
  trendPts.forEach((p, i) => {
    if (p.sleep == null) return;
    const prev = trendPts[i - 1]?.sleep, next = trendPts[i + 1]?.sleep;
    path += `${prev == null ? 'M' : 'L'}${tx(i).toFixed(1)} ${sy(p.sleep).toFixed(1)}`;
    if (prev == null && next == null) dots += `<circle cx="${tx(i)}" cy="${sy(p.sleep)}" r="3" style="fill:var(--accent)"/>`;
  });
  const last = [...trendPts].reverse().find(p => p.sleep != null);
  const li = last ? trendPts.indexOf(last) : -1;
  if (last) dots += `<circle cx="${tx(li)}" cy="${sy(last.sleep)}" r="4" style="fill:var(--accent);stroke:var(--card);stroke-width:2"/>`;
  const anyAttack = trendPts.some(p => p.sev), anySleep = !!last;
  const mid = trendPts[15].k;
  return `
  <section class="card" style="margin-top:14px">
    <div class="card-head"><h2>近 30 天</h2><span class="link">本月 ${monthN} 次</span></div>
    <div class="chart-wrap" data-chart="trend">
      <svg viewBox="0 0 ${TW} 142" role="img" aria-label="近 30 天头痛程度与睡眠时长">
        ${[1, 2, 3].map(s => `<line class="grid-line" x1="${TL}" x2="${TW - TR}" y1="${base - s * unit}" y2="${base - s * unit}"/><text x="0" y="${base - s * unit + 3}">${['', '轻', '中', '重'][s]}</text>`).join('')}
        <line x1="${TL}" x2="${TW - TR}" y1="${base}" y2="${base}" style="stroke:var(--line-2)"/>
        ${bars}
        ${anyAttack ? '' : `<text x="${(TL + TW) / 2}" y="44" text-anchor="middle">近 30 天没有发作</text>`}
        <line class="grid-line" x1="${TL}" x2="${TW - TR}" y1="${sy(7)}" y2="${sy(7)}"/><text x="0" y="${sy(7) + 3}">7h</text>
        ${anySleep ? `<path d="${path}" fill="none" style="stroke:var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${dots}`
          : `<text x="${(TL + TW) / 2}" y="${sy(7) - 6}" text-anchor="middle">在「睡眠」打卡后显示</text>`}
        <line class="hl" x1="-10" x2="-10" y1="4" y2="124" style="stroke:var(--ink-3)" stroke-width="1" opacity="0"/>
        <text x="${TL}" y="139">${md(trendPts[0].k).replace('月', '/').replace('日', '')}</text>
        <text x="${tx(15)}" y="139" text-anchor="middle">${md(mid).replace('月', '/').replace('日', '')}</text>
        <text x="${TW - TR}" y="139" text-anchor="end">今天</text>
      </svg>
      <div class="tip" role="status"></div>
    </div>
    <div class="legend">
      <span><i class="sw" style="background:var(--sev1)"></i><i class="sw" style="background:var(--sev2);margin-left:-4px"></i><i class="sw" style="background:var(--sev3);margin-left:-4px"></i>发作（轻→重）</span>
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
    const vx = (e.clientX - rect.left) / rect.width * TW;
    const i = Math.floor((vx - TL) / TSLOT);
    if (i < 0 || i > 29) return hide();
    const p = trendPts[i];
    tip.innerHTML = `${md(p.k)}<br>${p.sev ? sevLabel(p.sev) + '发作' : '无发作'}${p.sleep != null ? ` · 睡眠 ${p.sleep}h` : ''}`;
    const pctX = Math.max(22, Math.min(78, tx(i) / TW * 100));
    tip.style.left = pctX + '%';
    tip.classList.add('show');
    hl.setAttribute('x1', tx(i)); hl.setAttribute('x2', tx(i)); hl.setAttribute('opacity', '.5');
    clearTimeout(hideTimer);
  };
  svg.addEventListener('pointermove', show);
  svg.addEventListener('pointerdown', show);
  svg.addEventListener('pointerleave', e => {
    if (e.pointerType === 'mouse') hide(); else hideTimer = setTimeout(hide, 2500);
  });
}

// ----------------------- 记录 -----------------------
function viewRecords() {
  const list = state.attacks;
  const head = `<header class="top"><div><h1>记录</h1><div class="date">${list.length ? `共 ${list.length} 次发作` : '还没有发作记录'}</div></div></header>`;
  if (!list.length) {
    return head + `<div class="empty"><div class="art">${icon('file', 40)}</div><h3>这里会列出每一次发作</h3>
      <p>头痛时点一下「记录发作」，几秒钟就能记下程度、症状和用药。</p>
      <button class="btn primary" data-act="new-attack" style="margin-top:12px">${icon('plus', 18)}记录发作</button></div>`;
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
    html += `<div class="month-label"><span>${y}年${+m}月</span><span>${arr.length} 次</span></div>`;
    html += arr.map(recordCard).join('');
  }
  return html;
}

function recordCard(a) {
  const d = new Date(a.start), k = S.attackDay(a);
  const where = [a.locations?.join('、'), a.symptoms?.join('、')].filter(Boolean).join(' · ');
  return `<button class="card rec" data-act="edit-attack" data-id="${a.id}">
    <div class="date-col"><b>${d.getDate()}</b><span>周${WEEK[d.getDay()]}</span></div>
    <div class="body">
      <div class="line1"><span class="pill sev s${a.severity}">${sevLabel(a.severity)}</span>
        <span class="sub">${hhmm(d)}${a.duration ? ' · ' + durationOf(a.duration).label : ''}</span>
        ${state.days[k]?.period ? `<span class="pill"><i class="dot" style="background:var(--period)"></i>经期</span>` : ''}</div>
      ${where ? `<div class="line2">${esc(where)}</div>` : ''}
      ${a.triggers?.length ? `<div class="kv" style="margin-top:8px">${a.triggers.map(t => `<span class="pill">${esc(t)}</span>`).join('')}</div>` : ''}
      ${a.meds?.length ? `<div class="meds">${a.meds.map(m => `<div>${icon('pill', 16)}${esc(m.name)} ${esc(m.dose || '')}${m.time ? ` · ${esc(m.time)}` : ''}${m.effect != null ? ` · ${EFFECTS[m.effect].label}` : ''}${m.effect > 0 && m.relief ? `（${m.relief < 1 ? '半小时' : m.relief + ' 小时'}）` : ''}</div>`).join('')}</div>` : ''}
      ${a.note ? `<div class="line2 muted">${esc(a.note)}</div>` : ''}
    </div></button>`;
}

// ----------------------- 分析 -----------------------
function viewAnalysis() {
  const m0 = ui.month, cur = startOfMonth(new Date());
  const isCur = m0.getTime() >= cur.getTime();
  const mk = dkey(m0).slice(0, 7), pk = dkey(addMonths(m0, -1)).slice(0, 7);
  const inMonth = state.attacks.filter(a => S.attackDay(a).startsWith(mk));
  const prevN = state.attacks.filter(a => S.attackDay(a).startsWith(pk)).length;
  const durs = inMonth.map(a => durationOf(a.duration)?.h).filter(h => h != null);
  const avgDur = durs.length ? durs.reduce((s, h) => s + h, 0) / durs.length : null;
  const nDays = new Date(m0.getFullYear(), m0.getMonth() + 1, 0).getDate();
  let medDays = 0;
  for (let i = 1; i <= nDays; i++) if (dosesOn(dkey(new Date(m0.getFullYear(), m0.getMonth(), i))).length) medDays++;
  const delta = inMonth.length - prevN;

  return `
  <header class="top">
    <div><h1>分析</h1></div>
    <div class="month-nav">
      <button class="icon-btn" data-act="month" data-d="-1" aria-label="上个月">${icon('chevL', 22)}</button>
      <span>${m0.getFullYear()}年${m0.getMonth() + 1}月</span>
      <button class="icon-btn" data-act="month" data-d="1" aria-label="下个月" ${isCur ? 'disabled' : ''}>${icon('chevR', 22)}</button>
    </div>
  </header>
  <section class="card stats">
    <div><div class="v" style="color:var(--attack-text)">${inMonth.length}<small>次</small></div><div class="k">发作</div>
      <div class="d">${delta === 0 ? '与上月持平' : `比上月${delta > 0 ? '多' : '少'} ${Math.abs(delta)} 次`}</div></div>
    <div><div class="v">${avgDur == null ? '—' : fmtNum(avgDur)}<small>${avgDur == null ? '' : 'h'}</small></div><div class="k">平均持续</div><div class="d">按所选时长估算</div></div>
    <div><div class="v">${medDays}<small>天</small></div><div class="k">用药天数</div><div class="d">含预防用药</div></div>
  </section>
  ${calendarCard()}
  ${taggedCard()}
  <h2 class="section-title">${icon('sparkle', 22)}智能分析<button class="icon-btn" data-act="method" aria-label="方法说明" style="margin-left:auto;width:36px;height:36px">${icon('info', 20)}</button></h2>
  ${smartCards()}
  <p class="note" style="text-align:center;margin:18px 12px 0">分析结果只反映记录中的关联，不能替代医生诊断。</p>`;
}

function calendarCard() {
  const m0 = ui.month, y = m0.getFullYear(), mo = m0.getMonth();
  const nDays = new Date(y, mo + 1, 0).getDate(), lead = (m0.getDay() + 6) % 7, tk = todayKey();
  let cells = ['一', '二', '三', '四', '五', '六', '日'].map(w => `<div class="wd">${w}</div>`).join('');
  cells += '<div></div>'.repeat(lead);
  for (let i = 1; i <= nDays; i++) {
    const k = dkey(new Date(y, mo, i)), s = maxSev(attacksOn(k)), d = state.days[k];
    const meds = dosesOn(k).length > 0, fut = k > tk;
    const label = [`${mo + 1}月${i}日`, s ? sevLabel(s) + '发作' : '', d?.period ? '经期' : '', meds ? '服药' : ''].filter(Boolean).join('，');
    cells += `<button class="cell ${s ? 's' + s : ''} ${k === tk ? 'today' : ''} ${fut ? 'future' : ''} ${ui.sel === k ? 'sel' : ''}" data-act="sel-day" data-k="${k}" aria-label="${label}" ${fut ? 'disabled' : ''}>
      <span class="n">${i}</span><span class="marks">${d?.period ? '<i class="p"></i>' : ''}${meds ? '<i class="m"></i>' : ''}</span></button>`;
  }
  return `<section class="card">
    <div class="card-head"><h2>发作日历</h2><span class="meta">点日期查看或补记</span></div>
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
  if (d.pain === 0 && !atk.length) pills.push('<span class="pill">无痛</span>');
  if (d.period) pills.push(`<span class="pill"><i class="bar-key" style="background:var(--period)"></i>经期第 ${S.periodDayNumber(state.days, k)} 天</span>`);
  if (d.sleep != null) pills.push(`<span class="pill">睡眠 ${d.sleep}h</span>`);
  if (d.stress) pills.push(`<span class="pill">压力${STRESS[d.stress]}</span>`);
  if (d.meals) pills.push(`<span class="pill">吃了 ${MEALS.filter(([m]) => d.meals[m]).length} 餐</span>`);
  if (d.caffeine) pills.push(`<span class="pill">咖啡 ${d.caffeine} 杯</span>`);
  if (d.alcohol) pills.push('<span class="pill">饮酒</span>');
  if (d.exercise != null) pills.push(`<span class="pill">${d.exercise ? `运动 ${d.exercise} 分钟` : '没运动'}</span>`);
  if (doses.length) pills.push(`<span class="pill"><i class="dot" style="background:var(--med);width:6px;height:6px"></i>${doses.map(m => esc(m.name)).join('、')}</span>`);
  return `<div class="day-detail">
    <h3>${mdw(k)}</h3>
    ${atk.map(a => `<button class="today-attack" data-act="edit-attack" data-id="${a.id}" style="margin:0 0 8px">${icon('flame', 18)}
      <span class="grow">${hhmm(new Date(a.start))} · ${sevLabel(a.severity)}${a.duration ? ' · ' + durationOf(a.duration).label : ''}${a.triggers?.length ? ' · ' + esc(a.triggers.slice(0, 2).join('、')) : ''}</span>${icon('chevR', 16)}</button>`).join('')}
    ${pills.length ? `<div class="kv">${pills.join('')}</div>` : atk.length ? '' : '<p class="muted" style="margin:0;font-size:14px">这天没有记录</p>'}
    <div class="btn-row">
      <button class="btn hot" data-act="new-attack" data-k="${k}">${icon('plus', 18)}补记发作</button>
      <button class="btn" data-act="edit-day" data-k="${k}">${icon('edit', 18)}编辑打卡</button>
    </div></div>`;
}

function taggedCard() {
  const since = shiftKey(todayKey(), -90);
  const recent = state.attacks.filter(a => S.attackDay(a) >= since);
  const tags = S.taggedTriggers(recent).slice(0, 6);
  return `<section class="card">
    <div class="card-head"><h2>你标记的诱因</h2><span class="meta">近 90 天 · ${recent.length} 次发作</span></div>
    ${tags.length ? tags.map(t => `<div class="hbar"><span class="lbl">${esc(t.name)}</span><div class="track"><div class="fill" style="width:${t.share * 100}%"></div></div><span class="val">${pct(t.share)}</span></div>`).join('')
      + '<p class="note">占比 = 标记了该诱因的发作 ÷ 全部发作。这是你自己的判断；下面的「智能分析」会用每天的打卡数据客观验证。</p>'
      : '<p class="muted" style="margin:0;font-size:14px">记录发作时勾选「可能诱因」，这里会显示统计。</p>'}
  </section>`;
}

function smartCards() {
  const A = analysis();
  let html = '';
  if (!A.ready) {
    html += `<section class="card">
      <div class="card-head"><h2>正在积累数据</h2><span class="meta">${A.nDays} 天 · ${A.nAttacks} 次发作</span></div>
      <p class="sub" style="margin:0">${[
        A.needDays ? `再坚持打卡 <b>${A.needDays}</b> 天` : '',
        A.needAttacks ? `累计有 ${S.MIN_ATTACKS} 次发作记录（目前 ${A.nAttacks} 次）` : '',
      ].filter(Boolean).join('，并且')}后，就能开始分析睡眠、压力、经期、饮食等因素和发作的关系。</p>
      <div class="progress" aria-hidden="true"><div style="width:${Math.min(100, A.nDays / S.MIN_DAYS * 100)}%"></div></div>
      <p class="note">每天花 10 秒在首页打卡（即使没头痛），分析会更准确。没打卡的日子不会计入，避免把“忘了记”当成“没发作”。</p>
    </section>`;
  } else {
    html += forecastCard(A) + factorsCard(A) + corrCard(A) + sleepCard(A);
  }
  html += trendMonthsCard() + periodCard(A) + timingCard() + medsCard();
  return html;
}

function forecastCard(A) {
  if (!A.forecast) return '';
  const { p, ratio, drivers } = A.forecast;
  const level = ratio >= 1.5 ? ['high', '偏高'] : ratio <= 0.67 ? ['low', '偏低'] : ['mid', '和平时差不多'];
  const C = 2 * Math.PI * 34;
  return `<section class="card">
    <div class="card-head"><h2>今日发作风险</h2><span class="tag ${level[0]}">${level[1]}</span></div>
    <div class="forecast">
      <div class="ring"><svg viewBox="0 0 84 84"><circle cx="42" cy="42" r="34" fill="none" style="stroke:var(--field)" stroke-width="9"/>
        <circle cx="42" cy="42" r="34" fill="none" style="stroke:var(--attack)" stroke-width="9" stroke-linecap="round" stroke-dasharray="${(p * C).toFixed(1)} ${C.toFixed(1)}"/></svg><b>${pct(p)}</b></div>
      <div class="sub">根据今天的打卡，今天开始一次发作的概率约 <b>${pct(p)}</b>，你平时约 <b>${pct(A.baseRate)}</b>。
        ${drivers.length ? `<br>主要因为：${drivers.map(F => F.label).join('、')}。` : ''}</div>
    </div>
    <p class="note">模型交叉验证的区分能力 AUC = ${A.auc.toFixed(2)}（0.5 相当于随机猜测，1 为完美）。仅供参考。</p>
  </section>`;
}

const fx = v => Math.max(0, Math.min(100, 50 + Math.log2(v) / 3 * 50));
const evText = e => e.level === 0 ? '暂未看出关系' : `${e.level === 2 ? '很可能' : '可能'}${e.dir > 0 ? '增加风险' : '降低风险'}`;
const evClass = e => e.level === 0 ? 'flat' : e.dir > 0 ? 'up' : 'down';

function factorsCard(A) {
  if (!A.effects?.length) {
    return `<section class="card"><div class="card-head"><h2>哪些因素和发作有关</h2></div>
      <p class="sub" style="margin:0">打卡的项目还不够多样。多记录几天睡眠、压力、饮食和经期，这里会给出每个因素的分析。</p></section>`;
  }
  return `<section class="card">
    <div class="card-head"><h2>哪些因素和发作有关</h2><span class="meta">${A.nDays} 天 · ${A.nAttacks} 次</span></div>
    <div class="forest-axis"><span>风险更低</span><span>×1 无差别</span><span>风险更高</span></div>
    ${A.effects.map(e => `<button class="factor" data-act="factor" data-k="${e.F.key}">
      <div class="row1"><span class="name">${e.F.label}</span><span class="ev">${evText(e)}</span><span class="or">×${fmtOR(e.or)}</span></div>
      <div class="row2"><div class="forest" aria-hidden="true"><div class="axis"></div><div class="ref"></div>
        <div class="ci ${evClass(e)}" style="left:${fx(e.lo)}%;width:${Math.max(1, fx(e.hi) - fx(e.lo))}%"></div>
        <div class="pt ${evClass(e)}" style="left:${fx(e.or)}%"></div></div><span class="chev">${icon('chevR', 16)}</span></div>
    </button>`).join('')}
    <p class="note">×数值是同时考虑所有因素后的风险倍数（比值比），横线是 95% 可信区间。${A.auc != null ? `模型区分能力 AUC = ${A.auc.toFixed(2)}。` : ''}点开任一项可看原始数据。</p>
  </section>`;
}

function corrCard(A) {
  const list = S.correlations(A.rows).filter(c => c.rho != null);
  if (!list.length) return '';
  const strength = r => { const a = Math.abs(r); return a < 0.1 ? '几乎无关' : a < 0.3 ? '弱' : a < 0.5 ? '中等' : '较强'; };
  return `<section class="card">
    <div class="card-head"><h2>与头痛程度的相关性</h2><span class="meta">Spearman</span></div>
    ${list.map(c => {
      const w = Math.abs(c.rho) * 50, left = c.rho >= 0 ? 50 : 50 - w;
      return `<div class="corr"><span>${c.label}</span>
        <div class="track"><div class="fill ${c.rho >= 0 ? 'up' : 'down'}" style="left:${left}%;width:${w}%"></div><div class="mid"></div></div>
        <span class="val">${c.rho >= 0 ? '+' : '−'}${Math.abs(c.rho).toFixed(2)}${c.p < 0.05 ? '*' : ''}</span></div>`;
    }).join('')}
    <p class="note">正值：这项越高，当天头痛越重；负值相反。${list.map(c => `${c.label}${strength(c.rho)}`).join('，')}。* 表示 p &lt; 0.05，不太像是巧合。</p>
  </section>`;
}

function sleepCard(A) {
  const { total, buckets } = S.sleepBuckets(A.rows);
  if (total < 14) return '';
  const shown = buckets.filter(b => b.n > 0);
  const max = Math.max(...shown.map(b => b.rate), 0.01);
  return `<section class="card">
    <div class="card-head"><h2>睡眠时长与发作</h2><span class="meta">${total} 天</span></div>
    <div class="cols">${shown.map(b => `<div class="c"><span class="v">${pct(b.rate)}</span><div class="bar" style="height:${Math.round(b.rate / max * 72)}px"></div><span class="l">${b.label}</span></div>`).join('')}</div>
    <p class="note">每组数字 = 前一晚睡这么久的日子里，开始发作的比例。${shown.map(b => `${b.label} ${b.n} 天`).join('，')}。</p>
  </section>`;
}

function trendMonthsCard() {
  const { list, trend } = S.monthlyTrend(state);
  if (!state.attacks.length) return '';
  const max = Math.max(...list.map(m => m.attacks), 1);
  let verdict = '记录满 3 个月（每月至少 7 天有记录）后，会判断发作频率的变化趋势。';
  if (trend) {
    const ch = Math.round(Math.abs(trend.or - 1) * 100);
    verdict = trend.level === 0 ? `发作频率整体比较平稳（每月变化约 ${ch}%，不确定）。`
      : `发作频率${trend.dir < 0 ? '在下降' : '在上升'}，平均每月约 ${trend.dir < 0 ? '−' : '+'}${ch}%（可信度 ${pct(trend.pDir)}）。`;
  }
  return `<section class="card">
    <div class="card-head"><h2>近 6 个月</h2><span class="meta">每月发作次数</span></div>
    <div class="cols">${list.map(m => `<div class="c ${m.recordDays ? '' : 'empty'}"><span class="v">${m.recordDays ? m.attacks : ''}</span>
      <div class="bar ${m.current ? 'cur' : ''}" style="height:${Math.round(m.attacks / max * 72)}px"></div><span class="l">${m.month.getMonth() + 1}月</span></div>`).join('')}</div>
    <p class="note">${verdict}趋势用泊松回归计算，已按每月实际记录天数校正。</p>
  </section>`;
}

function periodCard(A) {
  const P = S.periodAnalysis(state, A.rows);
  if (!P.enough) {
    return `<section class="card insight"><div class="hero"><b>${icon('drop', 30)}</b><span>经期与发作</span></div>
      <p>在首页「经期」打卡，记录满 2 个周期后，这里会分析发作是否集中在经期前后。</p></section>`;
  }
  const hits = P.cycles.filter(c => c.hit).length;
  const u = P.uni;
  return `<section class="card insight">
    <div class="hero"><b>${P.share == null ? '—' : pct(P.share)}</b><span>的发作在经期前后（−2～+3 天）</span></div>
    <p>${P.tot ? `统计了 ${P.tot} 次发作，其中 ${P.inW} 次在经期窗口内。` : ''}${P.cycles.length ? `最近 ${P.cycles.length} 个周期里，有 ${hits} 个在窗口内发作。` : ''}
      ${u.rateE != null && u.rateU != null ? `窗口内每天的发作概率约 ${pct(u.rateE)}，其他日子约 ${pct(u.rateU)}。` : ''}
      ${P.cycles.length >= 2 && hits >= 2 ? '这种规律值得在看诊时告诉医生。' : ''}</p>
    ${P.next ? `<p>平均周期约 ${P.cycleLen} 天，预计下次经期在 <b>${md(P.next)}</b> 前后，可以提前留意。</p>` : ''}
  </section>`;
}

function timingCard() {
  const T = S.timing(state.attacks);
  if (T.total < 3) return '';
  const max = Math.max(...T.bins.map(b => b.n), 1);
  const top = [...T.bins].sort((a, b) => b.n - a.n)[0];
  return `<section class="card">
    <div class="card-head"><h2>发作时段</h2><span class="meta">${T.total} 次</span></div>
    <div class="cols">${T.bins.map(b => `<div class="c"><span class="v">${b.n}</span><div class="bar" style="height:${Math.round(b.n / max * 56)}px"></div><span class="l">${b.label}</span></div>`).join('')}</div>
    <p class="note">最常在${top.label}（${top.sub}）开始。</p>
  </section>`;
}

function medsCard() {
  const M = S.medStats(state, ui.month);
  const mo = ui.month.getMonth() + 1;
  const moh = M.acuteDays >= 10
    ? `<div class="risk-hint" style="margin:0 0 12px">${icon('alert', 20)}<span>${mo}月已有 ${M.acuteDays} 天服用止痛药。每月用药天数较多时，可能出现“药物过度使用性头痛”，建议和医生聊聊。</span></div>` : '';
  if (!M.list.length) {
    return `<section class="card"><div class="card-head"><h2>药物效果</h2></div>${moh}
      <p class="sub" style="margin:0">记录发作时添加用药并标记效果，这里会统计哪种药对你更有效、多久起效。</p></section>`;
  }
  return `<section class="card">
    <div class="card-head"><h2>药物效果</h2><span class="meta">${mo}月止痛药 ${M.acuteDays} 天</span></div>${moh}
    <table class="table"><thead><tr><th>药物</th><th>次数</th><th>有效</th><th>起效</th></tr></thead><tbody>
    ${M.list.map(s => `<tr><td>${esc(s.name)}</td><td>${s.uses}</td><td>${s.rated ? pct((s.full + s.partial) / s.rated) : '—'}</td><td>${s.avgRelief != null ? fmtNum(s.avgRelief) + 'h' : '—'}</td></tr>`).join('')}
    </tbody></table>
    <p class="note">有效 = 标记为部分或完全缓解的比例；起效 = 平均多久后开始缓解。</p>
  </section>`;
}

// ----------------------- 我的 -----------------------
function viewMe() {
  const s = state.settings;
  return `
  <header class="top"><div><h1>我的</h1><div class="date">所有数据只保存在这台设备上</div></div></header>
  <section class="card">
    <div class="list-item"><div class="avatar" style="width:44px;height:44px;box-shadow:none;background:var(--field)">${s.name ? esc([...s.name.trim()][0] || '') : icon('user', 22)}</div>
      <div class="grow"><input class="field" data-input="name" value="${esc(s.name)}" placeholder="怎么称呼你？" maxlength="12" aria-label="称呼"></div></div>
  </section>

  <h2 class="section-title">常用药物</h2>
  <section class="card">
    ${s.meds.length ? s.meds.map((m, i) => `<div class="list-item"><span class="li-ic" style="color:var(--med)">${icon('pill', 20)}</span>
      <div class="grow">${esc(m.name)} <span class="muted">${esc(m.dose)}</span></div>
      <button class="pill" data-act="med-kind" data-i="${i}">${m.kind === 'preventive' ? '预防用药' : '止痛 / 急性'}</button>
      <button class="icon-btn" data-act="med-del" data-i="${i}" aria-label="删除 ${esc(m.name)}">${icon('trash', 18)}</button></div>`).join('')
      : '<p class="muted" style="margin:0">还没有常用药物</p>'}
    <div class="inline-form"><input class="field" id="nm-name" placeholder="药名" autocomplete="off"><input class="field" id="nm-dose" placeholder="剂量"><button class="btn primary" data-act="med-add">添加</button></div>
    <p class="note">常用药物会出现在记录发作和服药打卡里，一点即可添加。点标签可切换「止痛 / 预防」，预防用药不计入止痛药天数。</p>
  </section>

  ${s.customTriggers.length ? `<h2 class="section-title">自定义诱因</h2><section class="card">
    ${s.customTriggers.map((t, i) => `<div class="list-item"><div class="grow">${esc(t)}</div><button class="icon-btn" data-act="trig-del" data-i="${i}" aria-label="删除 ${esc(t)}">${icon('trash', 18)}</button></div>`).join('')}
  </section>` : ''}

  <h2 class="section-title">数据</h2>
  <section class="card">
    <button class="list-item" data-act="report"><span class="li-ic">${icon('file', 20)}</span><div class="grow">就诊摘要<small>近 90 天的发作、用药和规律，看医生时直接给医生看</small></div>${icon('chevR', 18)}</button>
    <button class="list-item" data-act="export-csv"><span class="li-ic">${icon('share', 20)}</span><div class="grow">导出表格（CSV）<small>可用 Excel / Numbers 打开</small></div>${icon('chevR', 18)}</button>
    <button class="list-item" data-act="export-json"><span class="li-ic">${icon('download', 20)}</span><div class="grow">导出备份<small>建议每月备份一次，存到「文件」或发给自己</small></div>${icon('chevR', 18)}</button>
    <button class="list-item" data-act="import-json"><span class="li-ic">${icon('upload', 20)}</span><div class="grow">导入备份<small>与现有记录合并，换手机时使用</small></div>${icon('chevR', 18)}</button>
    <button class="list-item danger" data-act="clear-all"><span class="li-ic" style="color:#C0392B">${icon('trash', 20)}</span><div class="grow" style="color:#C0392B">清除所有数据</div></button>
    <input type="file" id="import-file" accept="application/json,.json" hidden>
  </section>

  <h2 class="section-title">关于</h2>
  <section class="card">
    <div class="list-item"><span class="li-ic">${icon('shield', 20)}</span><div class="grow">数据存储<small id="persist-info">${state.attacks.length} 次发作 · ${Object.keys(state.days).length} 天打卡，保存在本机，不会上传</small></div></div>
    <button class="list-item" data-act="method"><span class="li-ic">${icon('sparkle', 20)}</span><div class="grow">分析方法说明</div>${icon('chevR', 18)}</button>
    <div class="list-item"><span class="li-ic">${icon('info', 20)}</span><div class="grow">本应用仅用于记录和自我观察，不能替代医生的诊断和治疗建议。<small>头痛日记 · v1.0</small></div></div>
  </section>`;
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
const closeBtn = `<button class="icon-btn" data-act="close-sheet" aria-label="关闭">${icon('x', 20)}</button>`;
const spacer = '<span class="sp"></span>';

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
  setTimeout(() => { if (!ui.sheet) $sheet.innerHTML = ''; }, 320);
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
      <div class="sheet-head">${closeBtn}<h2>${spec.title}</h2>${spec.right || spacer}</div>
      <div class="sheet-body">${spec.body}</div>
      ${spec.foot ? `<div class="sheet-foot">${spec.foot}</div>` : ''}
    </div>`;
  if (fresh) {
    $sheet.className = 'sheet-root';
    requestAnimationFrame(() => requestAnimationFrame(() => $sheet.classList.add('open')));
  } else {
    $sheet.className = 'sheet-root open';
    $sheet.querySelector('.sheet-body').scrollTop = prevScroll;
  }
}

const sec = (title, inner, extra = '') => `<section class="card"><h4>${title}${extra}</h4>${inner}</section>`;
const otherMedForm = (act, extra = '') => `<div class="inline-form"><input class="field" id="om-name" placeholder="药名" autocomplete="off"><input class="field" id="om-dose" placeholder="剂量"><button class="btn primary" data-act="${act}">添加</button></div>${extra}`;

const SHEETS = {
  attack: s => ({
    full: true,
    title: s.draft.id ? '编辑发作' : '记录发作',
    right: s.draft.id ? `<button class="icon-btn" data-act="a-delete" aria-label="删除这条记录">${icon('trash', 20)}</button>` : '',
    body: attackBody(s.draft),
    foot: `<button class="btn primary lg block" data-act="a-save">保存记录</button>`,
  }),
  checkin: s => ({
    title: `${TILES.find(t => t.k === s.k).label}${s.date === todayKey() ? '' : ' · ' + md(s.date)}`,
    body: editor(s.k, s.date) + (tileValue(s.k, s.date)[0] && s.k !== 'meds' ? `<button class="clear-link" data-act="c-clear" data-k="${s.k}">清除这项记录</button>` : ''),
    foot: `<button class="btn primary lg block" data-act="close-sheet">完成</button>`,
  }),
  day: s => ({
    full: true,
    title: mdw(s.date),
    body: TILES.map(t => `<h4 style="margin:18px 4px 10px;display:flex;align-items:center;gap:8px">${icon(t.ic, 20)}${t.label}</h4>${editor(t.k, s.date)}`).join(''),
    foot: `<button class="btn primary lg block" data-act="close-sheet">完成</button>`,
  }),
  factor: s => factorSheet(s.k),
  method: () => ({ full: true, title: '分析方法说明', body: methodBody() }),
  report: () => {
    const text = buildReport();
    return {
      full: true, title: '就诊摘要',
      body: `<pre class="report">${esc(text)}</pre>`,
      foot: `<div class="btn-row" style="margin:0"><button class="btn block" data-act="copy-report">${icon('copy', 18)}复制</button><button class="btn primary block" data-act="share-report">${icon('share', 18)}分享</button></div>`,
    };
  },
};

function attackBody(d) {
  const multi = (field, opts, extra = '') => `<div class="chips">${opts.map(o => {
    const on = d[field].includes(o);
    return `<button class="chip sm ${on ? 'on' : ''}" data-act="a-toggle" data-f="${field}" data-v="${esc(o)}" aria-pressed="${on}">${esc(o)}</button>`;
  }).join('')}${extra}</div>`;
  const custom = state.settings.customTriggers;
  const triggers = [...TRIGGERS, ...custom, ...d.triggers.filter(t => !TRIGGERS.includes(t) && !custom.includes(t))];
  return [
    sec('开始时间', `<input class="field" type="datetime-local" value="${d.start}" data-input="a-start" aria-label="开始时间">`),
    sec('头痛程度', `<div class="seg three">${[1, 2, 3].map(v => `<button class="chip ${d.severity === v ? 'on hot' : ''}" data-act="a-sev" data-v="${v}" aria-pressed="${d.severity === v}">${SEVERITY[v].label}</button>`).join('')}</div>
      <p class="note">${d.severity ? SEVERITY[d.severity].hint : '轻度：能正常活动　中度：影响活动　重度：需要卧床'}</p>`),
    sec('发作部位', multi('locations', LOCATIONS), '<small>可多选</small>'),
    sec('伴随症状', multi('symptoms', SYMPTOMS), '<small>可多选</small>'),
    sec('持续时间', `<div class="chips">${DURATIONS.map(o => `<button class="chip sm ${d.duration === o.k ? 'on hot' : ''}" data-act="a-dur" data-v="${o.k}" aria-pressed="${d.duration === o.k}">${o.label}</button>`).join('')}</div>`),
    sec('可能诱因', multi('triggers', triggers, `<button class="chip sm dashed" data-act="a-custom-trigger">${icon('plus', 15)}自定义</button>`), '<small>可多选</small>'),
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
        <div class="chips">${EFFECTS.map(e => `<button class="chip sm ${m.effect === e.v ? 'on' : ''}" data-act="a-med-effect" data-i="${i}" data-v="${e.v}">${e.label}</button>`).join('')}</div>
        ${m.effect > 0 ? `<span class="lbl">多久后开始缓解</span>
        <div class="chips">${RELIEF.map(r => `<button class="chip sm ${m.relief === r ? 'on' : ''}" data-act="a-med-relief" data-i="${i}" data-v="${r}">${r < 1 ? '半小时' : r + ' 小时'}${r === 4 ? '+' : ''}</button>`).join('')}</div>` : ''}
      </div>
    </div>`).join('');
  const presets = state.settings.meds.filter(m => m.kind !== 'preventive');
  return `${items}<div class="add-med"><div class="chips">
    ${presets.map(m => `<button class="chip sm dashed" data-act="a-add-med" data-name="${esc(m.name)}" data-dose="${esc(m.dose)}">${icon('plus', 15)}${esc(m.name)} ${esc(m.dose)}</button>`).join('')}
    <button class="chip sm dashed" data-act="a-other-med">${icon('plus', 15)}其他药物</button></div>
    ${d.addingMed ? otherMedForm('a-add-other') : ''}</div>`;
}

function editor(k, date) {
  const d = state.days[date] || {};
  switch (k) {
    case 'period':
      return `<section class="card"><div class="switch-row"><span>这天在经期</span>
        <button class="switch ${d.period ? 'on' : ''}" role="switch" aria-checked="${!!d.period}" data-act="c-period" aria-label="这天在经期"></button></div>
        ${d.period ? `<p class="note" style="color:var(--ink)">经期第 ${S.periodDayNumber(state.days, date)} 天</p>` : ''}
        <p class="note">经期的每一天都打开这个开关，App 会自动算出第几天和周期长度，并分析发作与经期的关系。</p></section>`;
    case 'diet': {
      const meals = d.meals || {};
      return `<section class="card"><h4>三餐<small>点选已经吃过的</small></h4>
        <div class="seg three">${MEALS.map(([m, l]) => `<button class="chip ${meals[m] ? 'on' : ''}" data-act="c-meal" data-m="${m}" aria-pressed="${!!meals[m]}">${l}</button>`).join('')}</div>
        ${d.meals ? `<p class="note">${MEALS.some(([m]) => !meals[m]) ? '没选的会被当作「漏餐」，晚点吃了再回来补上就好' : '三餐都吃了'}</p>` : ''}</section>
      <section class="card"><h4>咖啡 / 浓茶</h4><div class="stepper">
        <button data-act="c-caf" data-d="-1" aria-label="减少一杯">−</button><div class="big">${d.caffeine ?? 0}<small>杯</small></div>
        <button data-act="c-caf" data-d="1" aria-label="增加一杯">+</button></div></section>
      <section class="card"><div class="switch-row"><span>喝了酒</span>
        <button class="switch ${d.alcohol ? 'on' : ''}" role="switch" aria-checked="${!!d.alcohol}" data-act="c-alc" aria-label="喝了酒"></button></div></section>`;
    }
    case 'sleep':
      return `<section class="card"><h4>前一晚睡了多久</h4><div class="stepper">
        <button data-act="c-sleep" data-d="-0.5" aria-label="减少半小时">−</button><div class="big">${d.sleep ?? '—'}<small>小时</small></div>
        <button data-act="c-sleep" data-d="0.5" aria-label="增加半小时">+</button></div>
        <div class="chips" style="justify-content:center;margin-top:14px">${[5, 6, 7, 8, 9].map(v => `<button class="chip sm ${d.sleep === v ? 'on' : ''}" data-act="c-sleep-set" data-v="${v}">${v} 小时</button>`).join('')}</div></section>`;
    case 'stress':
      return `<section class="card"><h4>今天的压力</h4>
        <div class="seg three">${[1, 2, 3].map(v => `<button class="chip ${d.stress === v ? 'on' : ''}" data-act="c-stress" data-v="${v}" aria-pressed="${d.stress === v}">${STRESS[v]}</button>`).join('')}</div>
        <p class="note">低：放松平静　中等：有点紧张但能应对　高：紧绷、焦虑或非常忙</p></section>`;
    case 'exercise':
      return `<section class="card"><h4>运动时长</h4>
        <div class="chips">${[0, 15, 30, 45, 60, 90].map(v => `<button class="chip sm ${d.exercise === v ? 'on' : ''}" data-act="c-ex" data-v="${v}">${v ? v + ' 分钟' : '没有运动'}</button>`).join('')}</div></section>`;
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
    ${!fromAtk.length && !own.length ? '<p class="muted" style="margin:0 0 12px;font-size:14px">这天还没有服药记录</p>' : ''}
    ${fromAtk.map(({ m, a }) => `<div class="med-item"><div class="top-row">${icon('pill', 20)}<b>${esc(m.name)} ${esc(m.dose || '')}</b><span class="sub">${esc(m.time || '')}</span></div>
      <p class="note" style="margin-top:4px">记在 ${hhmm(new Date(a.start))} 的发作里，可在那条记录中修改</p></div>`).join('')}
    ${own.map(m => `<div class="med-item"><div class="top-row">${icon('pill', 20)}<b>${esc(m.name)} ${esc(m.dose || '')}${m.kind === 'preventive' ? ' <span class="pill">预防</span>' : ''}</b>
      <span class="sub">${esc(m.time || '')}</span><button class="icon-btn" data-act="c-med-del" data-id="${m.id}" aria-label="删除 ${esc(m.name)}">${icon('x', 18)}</button></div></div>`).join('')}
    <div class="chips">${state.settings.meds.map(p => `<button class="chip sm dashed" data-act="c-med-add" data-name="${esc(p.name)}" data-dose="${esc(p.dose)}" data-kind="${p.kind}">${icon('plus', 15)}${esc(p.name)} ${esc(p.dose)}</button>`).join('')}
      <button class="chip sm dashed" data-act="c-med-other">${icon('plus', 15)}其他药物</button></div>
    ${s.addingMed ? otherMedForm('c-med-add-other', `<div class="switch-row" style="margin-top:12px;font-size:15px"><span>这是预防 / 日常用药</span>
      <button class="switch ${s.otherPreventive ? 'on' : ''}" role="switch" aria-checked="${!!s.otherPreventive}" data-act="c-med-prev" aria-label="预防用药"></button></div>`) : ''}
    <p class="note">头痛时吃的药，建议在「记录发作」里添加，方便统计药效。预防用药不计入止痛药天数。</p>
  </section>`;
}

function factorSheet(key) {
  const A = analysis();
  const e = A.effects?.find(x => x.F.key === key);
  if (!e) return { title: '因素详情', body: '<p class="sub">暂无数据</p>' };
  const u = e.uni;
  const line = (label, r) => r.or == null ? '' : `<div class="list-item"><div class="grow">${label}<small>95% 区间 ×${fmtOR(r.lo)} – ×${fmtOR(r.hi)} · 可信度 ${pct(r.pDir)}</small></div><b style="font-family:var(--num);font-size:18px">×${fmtOR(r.or)}</b></div>`;
  let interp;
  if (e.level === 0) interp = '目前看不出它和发作有明确关系。数据少时这很常见，继续记录，结论会越来越清楚。';
  else if (e.dir > 0) interp = `在你的记录里，「${e.F.desc}」的日子发作${e.level === 2 ? '明显' : '似乎'}更多。可以试着减少这种情况，观察发作是否随之减少。`;
  else interp = `在你的记录里，「${e.F.desc}」的日子发作反而${e.level === 2 ? '明显' : '似乎'}更少，可能对你有帮助。`;
  return {
    title: e.F.label,
    body: `<section class="card"><p class="sub" style="margin:0 0 8px">${esc(e.F.desc)}</p>
      <table class="table"><thead><tr><th></th><th>天数</th><th>发作</th><th>发作率</th></tr></thead><tbody>
        <tr><td>有这种情况</td><td>${u.nE}</td><td>${u.aE}</td><td>${pct(u.rateE)}</td></tr>
        <tr><td>没有这种情况</td><td>${u.nU}</td><td>${u.aU}</td><td>${pct(u.rateU)}</td></tr></tbody></table></section>
      <section class="card"><h4>模型结果</h4>
        ${line('只看这一项', u)}${line('同时考虑其他因素', e)}
        <p class="note">×1 表示没有差别。区间越窄、离 1 越远，结果越可靠。可信度是“风险确实${e.dir > 0 ? '更高' : '更低'}”的概率。</p></section>
      <section class="card insight"><p style="margin:0">${interp}</p><p>相关不等于因果；不同因素也可能同时出现（比如经期前后睡眠变差），模型会尽量把它们分开。</p></section>`,
    foot: `<button class="btn primary lg block" data-act="close-sheet">知道了</button>`,
  };
}

function methodBody() {
  return `<section class="card method">
    <p><b>数据怎么整理。</b>每一个有记录的日子算一行，看这一天有没有开始一次发作。没打开 App 的日子不计入，避免把“忘了记”当成“没发作”。</p>
    <p><b>多因素模型：贝叶斯逻辑回归。</b>把睡眠、压力、饮食、咖啡因、饮酒、经期、运动放进同一个模型，互相校正。系数使用温和的正态先验（相当于岭回归），数据少的时候结果会自动偏向“没关系”，避免夸大偶然现象。结果里的“×2.1”是比值比，横线是 95% 可信区间，“可信度”是效应方向成立的后验概率（拉普拉斯近似）。</p>
    <p><b>滞后效应。</b>很多诱因要几小时到一天才起作用，所以部分因素看的是前一天：前一晚的睡眠、压力比前一天下降（“放松后头痛”）、前一天饮酒。</p>
    <p><b>预测与验证。</b>用分块时间序列交叉验证（按时间切成 5 段，轮流留出一段来检验）计算 AUC。只有 AUC ≥ 0.6、模型确实比瞎猜好时，才会显示今日风险。</p>
    <p><b>相关性。</b>Spearman 等级相关，衡量睡眠时长、压力、咖啡因、运动与当天头痛程度（0–3）的单调关系，不要求线性。</p>
    <p><b>趋势。</b>泊松回归，用每月实际记录天数作偏移量，判断发作频率是否在上升或下降。</p>
    <p><b>经期。</b>按国际头痛分类（ICHD-3）对月经相关偏头痛的观察窗口：经期第 1 天的前 2 天到后 3 天。</p>
    <p><b>为什么没用结构方程模型（SEM）。</b>SEM 适合多人、大样本、带潜变量的研究，通常需要几百个以上的观测，每个潜变量还要多个测量指标。一个人几个月的日记远远不够，硬套会得到不稳定甚至误导的结果。对个人日记来说，带先验的回归加交叉验证更稳妥。</p>
    <p><b>请注意。</b>相关不等于因果，结果只供自我观察和与医生沟通时参考。每天都打卡（即使没头痛），结果会更可靠。</p>
  </section>`;
}

// ======================= 就诊摘要 / 导出 =======================
function buildReport() {
  const tk = todayKey(), since = shiftKey(tk, -89);
  const list = state.attacks.filter(a => S.attackDay(a) >= since).slice().reverse();
  const count = (arr) => {
    const m = new Map();
    for (const x of arr) m.set(x, (m.get(x) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${k}（${n}）`).join('、') || '—';
  };
  const durs = list.map(a => durationOf(a.duration)?.h).filter(h => h != null);
  const sev = [1, 2, 3].map(s => list.filter(a => a.severity === s).length);
  const headDays = new Set(list.map(S.attackDay)).size;
  const lines = [];
  lines.push('偏头痛记录摘要');
  if (state.settings.name) lines.push(`称呼：${state.settings.name}`);
  lines.push(`时间：${since} 至 ${tk}（近 90 天）`, '');
  lines.push(`· 发作 ${list.length} 次，头痛 ${headDays} 天（约每月 ${fmtNum(list.length / 3)} 次）`);
  lines.push(`· 程度：轻度 ${sev[0]}，中度 ${sev[1]}，重度 ${sev[2]}`);
  if (durs.length) lines.push(`· 平均持续：约 ${fmtNum(durs.reduce((s, h) => s + h, 0) / durs.length)} 小时`);
  lines.push(`· 常见部位：${count(list.flatMap(a => a.locations || []))}`);
  lines.push(`· 伴随症状：${count(list.flatMap(a => a.symptoms || []))}`);
  lines.push(`· 自己认为的诱因：${count(list.flatMap(a => a.triggers || []))}`);
  const M = S.medStats({ ...state, attacks: list }, new Date());
  if (M.list.length) {
    lines.push('· 用药：' + M.list.map(s => `${s.name} ${s.uses} 次${s.rated ? `，有效 ${s.full + s.partial}/${s.rated}` : ''}`).join('；'));
  }
  const monthsMed = [2, 1, 0].map(i => {
    const m = addMonths(startOfMonth(new Date()), -i);
    return `${m.getMonth() + 1}月 ${S.medStats(state, m).acuteDays} 天`;
  });
  lines.push(`· 每月止痛药使用天数：${monthsMed.join('，')}`);
  const A = analysis();
  const P = S.periodAnalysis(state, A.rows);
  if (P.enough && P.share != null) lines.push(`· 经期前后（−2～+3 天）发作占比：${pct(P.share)}`);
  if (A.effects) {
    const strong = A.effects.filter(e => e.level >= 1);
    if (strong.length) lines.push('· 数据分析发现：' + strong.map(e => `${e.F.label} ×${fmtOR(e.or)}（${evText(e)}）`).join('；'));
  }
  lines.push('', '发作明细：');
  for (const a of list) {
    const d = new Date(a.start);
    const meds = (a.meds || []).map(m => `${m.name}${m.dose ? ' ' + m.dose : ''}${m.effect != null ? '，' + EFFECTS[m.effect].label : ''}`).join('；');
    lines.push(`${d.getMonth() + 1}/${d.getDate()} ${hhmm(d)} ${sevLabel(a.severity)} ${a.duration ? durationOf(a.duration).label : ''} ${(a.locations || []).join('、')} ${(a.symptoms || []).join('、')}${meds ? ' | ' + meds : ''}`.replace(/\s+/g, ' ').trim());
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
  const head = ['日期', '发作程度', '开始时间', '持续', '部位', '伴随症状', '诱因', '用药', '睡眠(小时)', '压力', '三餐', '咖啡因(杯)', '饮酒', '运动(分钟)', '经期', '无痛', '备注'];
  const keys = [...new Set([...Object.keys(state.days), ...state.attacks.map(S.attackDay)])].sort();
  const rows = [head.map(q).join(',')];
  for (const k of keys) {
    const d = state.days[k] || {}, atks = attacksOn(k);
    const daily = [d.sleep, d.stress ? STRESS[d.stress] : '', d.meals ? MEALS.filter(([m]) => d.meals[m]).map(([, l]) => l).join('/') : '',
      d.caffeine, d.alcohol == null ? '' : d.alcohol ? '是' : '否', d.exercise, d.period ? '是' : '', d.pain === 0 ? '是' : ''];
    const extraMeds = (d.meds || []).map(m => `${m.name} ${m.dose || ''}${m.time ? ' ' + m.time : ''}`).join('; ');
    if (!atks.length) rows.push([k, '', '', '', '', '', '', extraMeds, ...daily, ''].map(q).join(','));
    for (const a of atks.slice().reverse()) {
      const meds = [...(a.meds || []).map(m => `${m.name} ${m.dose || ''}${m.time ? ' ' + m.time : ''}${m.effect != null ? ' ' + EFFECTS[m.effect].label : ''}`), extraMeds].filter(Boolean).join('; ');
      rows.push([k, sevLabel(a.severity), hhmm(new Date(a.start)), a.duration ? durationOf(a.duration).label : '', (a.locations || []).join('/'),
        (a.symptoms || []).join('/'), (a.triggers || []).join('/'), meds, ...daily, a.note].map(q).join(','));
    }
  }
  shareOrDownload(`头痛日记-${todayKey()}.csv`, '﻿' + rows.join('\r\n'), 'text/csv');
}

function exportJSON() {
  const data = { app: 'migraine-diary', version: 1, exportedAt: new Date().toISOString(), attacks: state.attacks, days: Object.values(state.days), settings: state.settings };
  shareOrDownload(`头痛日记备份-${todayKey()}.json`, JSON.stringify(data, null, 1), 'application/json');
}

async function importJSON(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { return toast('文件格式不对，无法读取'); }
  if (!data || !Array.isArray(data.attacks) || !Array.isArray(data.days)) return toast('这不是头痛日记的备份文件');
  const attacks = data.attacks.filter(a => a && a.id && a.start && a.severity);
  const days = data.days.filter(d => d && /^\d{4}-\d{2}-\d{2}$/.test(d.date));
  if (!confirm(`将导入 ${attacks.length} 次发作、${days.length} 天打卡，并与现有记录合并（相同的记录以备份为准）。继续吗？`)) return;
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
function newAttackDraft(k, severity = null) {
  const now = new Date();
  const start = !k || k === todayKey() ? now : (() => { const d = parseKey(k); d.setHours(now.getHours(), now.getMinutes()); return d; })();
  return { start: toLocalInput(start), severity, locations: [], symptoms: [], duration: null, triggers: [], meds: [], note: '' };
}
function openAttack(a, overrides = {}, k = null) {
  const draft = a ? { ...structuredClone(a), start: toLocalInput(new Date(a.start)) } : newAttackDraft(k);
  Object.assign(draft, overrides);
  draft.note ??= '';
  openSheet({ type: 'attack', draft, dirty: !!Object.keys(overrides).length });
}
const draft = () => ui.sheet.draft;
const touch = () => { ui.sheet.dirty = true; renderSheet(); };

const ACTIONS = {
  tab: el => { ui.tab = el.dataset.tab; render(); },
  'hide-install': () => { state.settings.hideInstall = true; saveSettings(); render(); },

  status: el => {
    const v = +el.dataset.v, tk = todayKey(), todays = attacksOn(tk);
    if (v === 0) {
      if (todays.length) return toast('今天已有发作记录，可以点下方记录修改');
      const day = structuredClone(state.days[tk] || { date: tk });
      if (day.pain === 0) delete day.pain; else day.pain = 0;
      saveDay(day);
      render();
    } else {
      openAttack(todays[0] || null, { severity: v });
    }
  },
  tile: el => openSheet({ type: 'checkin', k: el.dataset.k, date: todayKey() }),
  'new-attack': el => openAttack(null, {}, el.dataset.k || null),
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
  method: () => openSheet({ type: 'method' }),

  // ---- 发作表单 ----
  'a-sev': el => { draft().severity = +el.dataset.v; touch(); },
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
    if (!d.severity) return toast('请选择头痛程度');
    const start = parseLocal(d.start);
    if (isNaN(start)) return toast('请填写开始时间');
    if (start > new Date(Date.now() + 5 * 60000)) return toast('开始时间不能晚于现在');
    const a = {
      id: d.id || uid(), start: start.toISOString(), severity: d.severity,
      locations: d.locations, symptoms: d.symptoms, duration: d.duration, triggers: d.triggers,
      meds: d.meds.map(({ id, name, dose, time, effect, relief }) => ({ id, name, dose, time, effect, relief })),
      note: (d.note || '').trim(), createdAt: d.createdAt || Date.now(), updatedAt: Date.now(),
    };
    upsertAttack(a);
    closeSheet(true);
    toast(d.id ? '已更新' : '已记录，好好休息');
  },
  'a-delete': () => {
    if (!confirm('删除这条发作记录？')) return;
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
  'c-stress': el => mutateDay(ui.sheet.date, d => { d.stress = d.stress === +el.dataset.v ? undefined : +el.dataset.v; if (d.stress == null) delete d.stress; }),
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
    if (!confirm('再确认一次：清除全部发作记录和打卡？')) return;
    await db.clearAll();
    state.attacks = []; state.days = {};
    state.settings = { name: '', meds: DEFAULT_MEDS.map(m => ({ ...m })), customTriggers: [], hideInstall: state.settings.hideInstall };
    saveSettings(); afterWrite(); render();
    toast('已清除');
  },
};

const INPUTS = {
  'a-start': el => { draft().start = el.value; ui.sheet.dirty = true; },
  'a-note': el => { draft().note = el.value; ui.sheet.dirty = true; },
  'a-med-time': el => { draft().meds[+el.dataset.i].time = el.value; ui.sheet.dirty = true; },
  name: el => { state.settings.name = el.value; clearTimeout(INPUTS.t); INPUTS.t = setTimeout(saveSettings, 400); },
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = ACTIONS[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el, e); }
});
document.addEventListener('input', e => {
  const el = e.target.closest('[data-input]');
  if (el) INPUTS[el.dataset.input]?.(el, e);
});
document.addEventListener('change', e => {
  if (e.target.id === 'import-file' && e.target.files[0]) { importJSON(e.target.files[0]); e.target.value = ''; }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && ui.sheet) closeSheet(); });

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
window.__diary = { state, analysis: () => S.analyze(state) };
