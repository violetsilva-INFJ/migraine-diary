// AI 返回的结果 → App 里的选项条目（确认页显示、保存时写入）
// 疼痛的比较说法（比昨天轻一点）由 AI 给出参照和变化，这里用她自己的记录换算，过往记录不会发给 AI。
// 注意：这里不用正则的后行断言（?<=…），旧版 iOS Safari 不支持，会让整个模块加载失败。
import {
  REGIONS, REGION_IDS, QUALITIES, SYMPTOMS, DURATIONS, TRIGGERS, EFFECTS, RELIEF, INTENSITY,
  FOOD_CATALOG, EXERCISE_CATALOG, MOOD_SHORT, FEELINGS_NEG, FEELINGS_POS, MOOD_FACTORS, CAFFEINE_ITEMS,
  UNCAT, dkey, shiftKey, todayKey, hhmm, md,
} from './util.js';

class Result {
  constructor(text, now) {
    this.text = text; this.now = now; this.items = []; this.notes = [];
  }
  key(off) { return shiftKey(dkey(this.now), off); }
  add(g, k, v, { fuzzy = false, span = null, date = null } = {}) {
    const same = this.items.find(x => x.g === g && x.k === k && x.date === date && JSON.stringify(x.v) === JSON.stringify(v));
    if (same) {
      if (span) same.spans.push(span);
      same.fuzzy = same.fuzzy && fuzzy;
      return same;
    }
    const it = { g, k, v, fuzzy, on: true, date, spans: span ? [span] : [] };
    this.items.push(it);
    return it;
  }
}

const REF_LABEL = { yesterday: '昨天', dayBefore: '前天', last: '上次', usual: '平时' };
// 参照的那次（或那些）头痛的分数；ctx.attacks 由 App 传入，按时间从新到旧
function refVas(ctx, kind, aDate, today) {
  const list = (ctx.attacks || []).filter(a => a.vas > 0);
  if (kind === 'yesterday' || kind === 'dayBefore') {
    // “昨天 / 前天”按说话的今天算
    const k = shiftKey(today, kind === 'yesterday' ? -1 : -2), vs = list.filter(a => a.day === k).map(a => a.vas);
    return vs.length ? { v: Math.max(...vs), label: REF_LABEL[kind] } : null;
  }
  if (kind === 'last') {
    const a = list.find(x => x.day < aDate);
    return a ? { v: a.vas, label: `${md(a.day)}那次` } : null;
  }
  if (kind === 'usual') {
    const from = shiftKey(aDate, -90), vs = list.filter(a => a.day < aDate && a.day >= from).map(a => a.vas).sort((x, y) => x - y);
    return vs.length >= 3 ? { v: vs[Math.floor(vs.length / 2)], label: '平时' } : null;
  }
  return null;
}
// 和别的时候比：算出大致分数；参照的那天没有记录就提示用户自己选
function vasFromComparison(R, ctx, c, aDate) {
  const ref = refVas(ctx, c.kind, aDate, R.key(0));
  if (!ref) {
    R.notes.push(`说了「${c.phrase}」，但${REF_LABEL[c.kind]}没有可以对照的头痛记录，没法换算，下一步拖动滑块选一下。`);
    return null;
  }
  const v = Math.max(1, Math.min(10, Math.round(ref.v + c.delta)));
  return { v, fuzzy: true, span: c.s != null ? [c.s, c.e] : null, cmp: `${c.phrase}，${ref.label} ${ref.v} 分` };
}
// “比吃药前好点了”：说的是这次吃药的效果，不是新的分数
function applyEarlier(R, ctx, c, aDate) {
  const effect = c.delta < 0 ? 1 : 0;
  const meds = R.items.filter(x => x.k === 'med' && x.g === 'a');
  if (meds.length) {
    const m = meds[meds.length - 1];
    if (m.v.effect == null) { m.v.effect = effect; if (c.s != null) m.spans.push([c.s, c.e]); }
    return;
  }
  const hadMeds = (ctx.attacks || []).some(a => a.day === aDate && a.meds > 0);
  if (hadMeds) R.add('a', 'medeffect', effect, { fuzzy: true, span: c.s != null ? [c.s, c.e] : null }).phrase = c.phrase;
  else R.notes.push(`说了「${c.phrase}」，但没找到这次吃的药；保存前可以在服药记录里选效果。`);
}

// 常见药名（别名 → 通用名），把 AI 返回的品牌名对上用户的常用药
const MED_ALIASES = [
  ['布洛芬', '布洛芬|芬必得|美林|ibuprofen|Ibuprofen|advil|Advil'],
  ['对乙酰氨基酚', '对乙酰氨基酚|扑热息痛|泰诺|必理通|百服宁|对乙酰|tylenol|Tylenol|panadol|Panadol'],
  ['佐米曲普坦', '佐米曲普坦|佐米格|佐米|zomig|Zomig'],
  ['利扎曲普坦', '利扎曲普坦|利扎|欧立停|maxalt|Maxalt'],
  ['舒马普坦', '舒马普坦|舒马曲坦|英明格'],
  ['依来曲普坦', '依来曲普坦|依来|relpax|Relpax'],
  ['阿司匹林', '阿司匹林|阿斯匹林|aspirin|Aspirin'],
  ['萘普生', '萘普生'], ['洛索洛芬', '洛索洛芬|乐松'], ['双氯芬酸', '双氯芬酸|扶他林'], ['塞来昔布', '塞来昔布|西乐葆'],
  ['散利痛', '散利痛'], ['去痛片', '去痛片'], ['正天丸', '正天丸'], ['头痛宁', '头痛宁'], ['天麻头痛片', '天麻头痛片|天麻'],
  ['川芎茶调散', '川芎茶调'], ['氟桂利嗪', '氟桂利嗪|西比灵'], ['普萘洛尔', '普萘洛尔|心得安'], ['托吡酯', '托吡酯|妥泰'],
  ['瑞美吉泮', '瑞美吉泮|nurtec|Nurtec'], ['甲氧氯普胺', '甲氧氯普胺|胃复安'], ['多潘立酮', '多潘立酮|吗丁啉'],
];
// AI 只给了原话、没给分数时的兜底：常见说法 → 大致分数（越具体的放越前）
const PHRASE_VAS = [[9, '受不了|要命|疼死|痛死|炸裂|最疼'], [8, '不行|特别严重|非常严重'], [6, '比较严重|挺严重|很不舒服'], [2, '一点点|微微|几乎不'], [3, '有点|轻微|轻度|不太|还好'], [4, '有些|有一些'], [5, '挺|比较|蛮|中度|难受'], [7, '很|好疼|好痛|非常|特别|严重|厉害|剧烈|太疼|太痛']];
const vasOfPhrase = t => PHRASE_VAS.find(([, re]) => new RegExp(re).test(t))?.[0] ?? null;
const nearestRelief = h => RELIEF.reduce((b, r) => Math.abs(r - h) < Math.abs(b - h) ? r : b, RELIEF[0]);

const pickIn = (list, v) => list.includes(v) ? v : null;
export function fromAI(J, text, ctx = {}) {
  const now = ctx.now || new Date();
  const R = new Result(text, now);
  if (!J || typeof J !== 'object') return R;
  const unsure = new Set(Array.isArray(J.uncertain) ? J.uncertain : []);
  const key = off => R.key(Math.max(-7, Math.min(0, Math.round(+off || 0))));
  const H = J.headache;
  const hasAttack = !!(H && H.present);
  if (hasAttack) {
    R.add('a', 'head', true);
    const off = Math.max(-7, Math.min(0, Math.round(+H.start_day_offset || 0)));
    if (H.start_time && /^\d{1,2}:\d{2}$/.test(H.start_time)) {
      const [h, m] = H.start_time.split(':').map(Number);
      const d = new Date(now); d.setDate(d.getDate() + off); d.setHours(h, m, 0, 0);
      const future = +d > +now + 5 * 60000;
      if (future) d.setDate(d.getDate() - 1); // 早上说“下午三点”：多半是昨天
      R.add('a', 'start', `${dkey(d)}T${hhmm(d)}`, { fuzzy: future || unsure.has('start') });
    } else if (off !== 0) {
      const d = new Date(now); d.setDate(d.getDate() + off);
      R.add('a', 'start', `${dkey(d)}T${hhmm(d)}`, { fuzzy: true }).noTime = true;
    }
    const aDate = R.key(off);
    const kind = { yesterday: 'yesterday', day_before: 'dayBefore', last: 'last', usual: 'usual', before_meds: 'earlier' }[H.vas_comparison?.reference];
    const delta = Math.max(-3, Math.min(3, Math.round(+H.vas_comparison?.change || 0)));
    const phrase = typeof H.vas_phrase === 'string' ? H.vas_phrase.trim().slice(0, 24) : '';
    const vas = Math.round(+H.vas);
    let cv = null;
    if (kind && kind !== 'earlier' && !(vas >= 1 && vas <= 10 && !unsure.has('vas'))) cv = vasFromComparison(R, ctx, { kind, delta, phrase: phrase || `比${REF_LABEL[kind]}${delta < 0 ? '轻' : delta > 0 ? '重' : '差不多'}` }, aDate);
    if (cv) Object.assign(R.add('a', 'vas', cv.v, { fuzzy: true }), { cmp: cv.cmp });
    else if (vas >= 1 && vas <= 10) Object.assign(R.add('a', 'vas', vas, { fuzzy: unsure.has('vas') || !!phrase }), { phrase });
    else if (phrase && vasOfPhrase(phrase)) Object.assign(R.add('a', 'vas', vasOfPhrase(phrase), { fuzzy: true }), { phrase });
    const regions = (H.regions || []).filter(r => REGION_IDS.includes(r));
    if (regions.length) R.add('a', 'region', regions, { fuzzy: unsure.has('regions') });
    for (const q of H.qualities || []) if (pickIn(QUALITIES, q)) R.add('a', 'quality', q, { fuzzy: unsure.has('qualities') });
    for (const q of H.symptoms || []) if (pickIn(SYMPTOMS, q)) R.add('a', 'symptom', q, { fuzzy: unsure.has('symptoms') });
    if (DURATIONS.some(d => d.k === H.duration)) R.add('a', 'duration', H.duration, { fuzzy: unsure.has('duration') });
    for (const t of H.triggers || []) if (typeof t === 'string' && t.trim()) R.add('a', 'trigger', t.trim().slice(0, 20), { fuzzy: unsure.has('triggers') || !TRIGGERS.includes(t) && !(ctx.customTriggers || []).includes(t) });
  }
  const presets = ctx.meds || [];
  for (const m of (hasAttack ? H.meds : J.meds_without_headache) || []) {
    if (!m || typeof m.name !== 'string' || !m.name.trim()) continue;
    const canon = MED_ALIASES.find(([, re]) => new RegExp(`^(?:${re})$`).test(m.name.trim()))?.[0] || m.name.trim();
    const p = presets.find(x => x.name === m.name) || presets.find(x => x.name.includes(canon) || canon.includes(x.name));
    const time = typeof m.time === 'string' && /^\d{1,2}:\d{2}$/.test(m.time) ? m.time.padStart(5, '0') : null;
    const effect = [0, 1, 2].includes(m.effect) ? m.effect : null;
    R.add(hasAttack ? 'a' : 'd', 'med', {
      name: p ? p.name : canon.slice(0, 20), dose: (typeof m.dose === 'string' && m.dose.trim()) || p?.dose || '', kind: p?.kind || 'acute',
      time, effect, relief: effect > 0 && +m.relief_hours > 0 ? nearestRelief(+m.relief_hours) : null, generic: false,
    }, { date: hasAttack ? null : R.key(0), fuzzy: unsure.has('meds') });
  }
  if (hasAttack && H.vas_comparison?.reference === 'before_meds') {
    applyEarlier(R, ctx, { delta: Math.round(+H.vas_comparison.change || 0), phrase: (typeof H.vas_phrase === 'string' && H.vas_phrase.trim()) || '比吃药前' }, R.key(Math.max(-7, Math.min(0, Math.round(+H.start_day_offset || 0)))));
  }
  if (!hasAttack && J.no_headache_today) R.add('d', 'nopain', true, { date: R.key(0) });

  const FOODCATS = FOOD_CATALOG.map(c => c.cat), EXCATS = EXERCISE_CATALOG.map(c => c.cat);
  for (const D of Array.isArray(J.days) ? J.days : []) {
    if (!D) continue;
    const date = key(D.day_offset), f = k => unsure.has(k);
    if (+D.sleep_hours > 0 && +D.sleep_hours <= 16) R.add('d', 'sleep', Math.round(+D.sleep_hours * 2) / 2, { date, fuzzy: f('sleep') });
    const meals = D.meals || {};
    for (const [m, k] of [['b', 'breakfast'], ['l', 'lunch'], ['d', 'dinner']]) if (typeof meals[k] === 'boolean') R.add('d', 'meal', { m, ate: meals[k] }, { date, fuzzy: f('meals') });
    for (const x of D.foods || []) {
      if (!x || typeof x.item !== 'string' || !x.item.trim()) continue;
      const cat = FOODCATS.includes(x.category) ? x.category : UNCAT;
      const qty = Math.max(1, Math.round(+x.quantity || 1));
      const note = [typeof x.note === 'string' ? x.note.trim() : '', qty > 1 ? `${qty}${CAFFEINE_ITEMS.includes(x.item) ? '杯' : '份'}` : ''].filter(Boolean).join(' ');
      R.add('d', 'food', { cat, item: x.item.trim().slice(0, 20), note, qty }, { date, fuzzy: f('foods') || cat === UNCAT });
    }
    for (const x of D.exercises || []) {
      if (!x || typeof x.item !== 'string' || !x.item.trim()) continue;
      const cat = EXCATS.includes(x.category) ? x.category : UNCAT;
      R.add('d', 'ex', { cat, item: x.item.trim().slice(0, 20), note: typeof x.note === 'string' ? x.note.trim() : '' }, { date, fuzzy: f('exercises') || cat === UNCAT });
    }
    if (+D.exercise_minutes > 0) R.add('d', 'exmin', Math.min(600, Math.round(+D.exercise_minutes)), { date, fuzzy: f('exercise_minutes') });
    if ([1, 2, 3].includes(D.exercise_intensity)) R.add('d', 'exint', D.exercise_intensity, { date, fuzzy: f('exercise_intensity') });
    if (D.no_exercise === true && !(D.exercises || []).length) R.add('d', 'noex', true, { date });
    const v = Math.round(+D.mood_valence);
    if (v >= 1 && v <= 7) R.add('d', 'valence', v, { date, fuzzy: f('mood') });
    for (const x of D.feelings || []) if (pickIn([...FEELINGS_NEG, ...FEELINGS_POS], x)) R.add('d', 'feel', x, { date, fuzzy: f('mood') });
    for (const x of D.mood_factors || []) if (pickIn(MOOD_FACTORS, x)) R.add('d', 'factor', x, { date, fuzzy: f('mood') });
    if (typeof D.period === 'boolean') R.add('d', 'period', D.period, { date, fuzzy: f('period') });
  }
  if (hasAttack) R.add('a', 'note', text.trim(), {});
  return R;
}

// ======================= 显示用的文字 =======================
export function dayWord(k) {
  const tk = todayKey();
  return k === tk ? '今天' : k === shiftKey(tk, -1) ? '昨天' : k === shiftKey(tk, -2) ? '前天' : md(k);
}
const MEAL_NAME = { b: '早餐', l: '午餐', d: '晚餐' };
export function itemText(it) {
  const v = it.v;
  switch (it.k) {
    case 'start': { const [d, t] = v.split('T'); return it.noTime ? `${dayWord(d)}（几点没说）` : `${dayWord(d)} ${t} 开始`; }
    case 'vas': return it.cmp ? `疼痛约 ${v}/10 · ${it.cmp}` : it.phrase ? `疼痛约 ${v}/10 · “${it.phrase}”` : `疼痛 ${v}/10`;
    case 'medeffect': return `药效：${EFFECTS[v].label}${it.phrase ? `（${it.phrase}）` : ''}`;
    case 'region': return v.length === REGION_IDS.length ? '整个头部' : v.map(id => REGIONS[id].label).join('、');
    case 'duration': return v === 'ongoing' ? '还在持续' : `持续 ${DURATIONS.find(d => d.k === v).label}`;
    case 'med': return [`${v.name}${v.dose ? ' ' + v.dose : ''}`, v.time, v.effect != null ? EFFECTS[v.effect].label : '', v.relief ? `${v.relief < 1 ? '半小时' : v.relief + ' 小时'}起效` : ''].filter(Boolean).join(' · ');
    case 'note': return '原话存进备注';
    case 'sleep': return `睡了 ${v} 小时`;
    case 'meal': return `${MEAL_NAME[v.m]}${v.ate ? '吃了' : '没吃'}`;
    case 'food': case 'ex': return `${v.item}${v.note ? ` · ${v.note}` : ''}`;
    case 'exmin': return `运动 ${v} 分钟`;
    case 'exint': return `强度${INTENSITY[v]}`;
    case 'noex': return '没有运动';
    case 'valence': return `心情：${MOOD_SHORT[v - 1]}`;
    case 'factor': return `受${v}影响`;
    case 'period': return v ? '在经期' : '不在经期';
    case 'nopain': return '没有头痛';
    default: return String(v);
  }
}
