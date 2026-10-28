// 日期、转义、图标与选项常量

export const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

const pad = n => String(n).padStart(2, '0');
export const dkey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const shiftKey = (k, n) => dkey(addDays(parseKey(k), n));
export const todayKey = () => dkey(new Date());
export const startOfMonth = d => new Date(d.getFullYear(), d.getMonth(), 1);
export const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
export const daysBetween = (a, b) => Math.round((parseKey(b) - parseKey(a)) / 86400000);
export const hhmm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const toLocalInput = d => `${dkey(d)}T${hhmm(d)}`;
export const md = k => { const d = parseKey(k); return `${d.getMonth() + 1}月${d.getDate()}日`; };
export const mdw = k => `${md(k)} 周${WEEK[parseKey(k).getDay()]}`;
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

export const fmtNum = (x, digits = 1) => {
  if (x == null || !isFinite(x)) return '—';
  const r = Number(x.toFixed(digits));
  return String(r);
};
export const pct = x => (x == null || !isFinite(x)) ? '—' : `${Math.round(x * 100)}%`;

// ---------- 选项 ----------
export const SEVERITY = {
  1: { label: '轻度', hint: '能正常活动' },
  2: { label: '中度', hint: '影响日常活动' },
  3: { label: '重度', hint: '难以进行日常活动，需要休息' },
};

// 疼痛强度 0–10（VAS / NRS）。旧记录只有 1–3 级时换算成代表值。
export const vasOf = a => a.vas ?? ({ 1: 2, 2: 5, 3: 8 }[a.severity] ?? 0);
export const sevOfVas = v => v <= 0 ? 0 : v <= 3 ? 1 : v <= 6 ? 2 : 3;
export const vasWord = v => v <= 0 ? '无痛' : v <= 3 ? '轻度' : v <= 6 ? '中度' : v <= 9 ? '重度' : '最剧烈';

// 头部区域（正面图按镜像显示：屏幕左边就是自己的左边）
export const REGIONS = {
  vertex: { label: '头顶', area: '头顶', side: 'M' },
  'forehead-L': { label: '左前额', area: '前额', side: 'L' },
  'forehead-R': { label: '右前额', area: '前额', side: 'R' },
  'temple-L': { label: '左太阳穴', area: '太阳穴', side: 'L' },
  'temple-R': { label: '右太阳穴', area: '太阳穴', side: 'R' },
  'parietal-L': { label: '左耳上方', area: '耳上方', side: 'L' },
  'parietal-R': { label: '右耳上方', area: '耳上方', side: 'R' },
  'eye-L': { label: '左眼周', area: '眼周', side: 'L' },
  'eye-R': { label: '右眼周', area: '眼周', side: 'R' },
  'face-L': { label: '左面颊', area: '面颊', side: 'L' },
  'face-R': { label: '右面颊', area: '面颊', side: 'R' },
  'occiput-L': { label: '左后脑', area: '后脑', side: 'L' },
  'occiput-R': { label: '右后脑', area: '后脑', side: 'R' },
  'neck-L': { label: '左后颈', area: '后颈', side: 'L' },
  'neck-R': { label: '右后颈', area: '后颈', side: 'R' },
};
export const REGION_IDS = Object.keys(REGIONS);
export const LAT_LABEL = { L: '左侧', R: '右侧', B: '双侧', M: '头顶' };
export function laterality(a) {
  if (a.regions?.length) {
    const s = new Set(a.regions.map(r => REGIONS[r]?.side));
    const L = s.has('L'), R = s.has('R');
    return L && R ? 'B' : L ? 'L' : R ? 'R' : s.has('M') ? 'M' : null;
  }
  const loc = a.locations || [];
  return loc.includes('双侧') ? 'B' : loc.includes('左侧') ? 'L' : loc.includes('右侧') ? 'R' : null;
}
export function regionSummary(a) {
  if (!a.regions?.length) return (a.locations || []).join('、');
  if (a.regions.length === REGION_IDS.length) return '整个头部';
  const areas = [...new Set(REGION_IDS.filter(id => a.regions.includes(id)).map(id => REGIONS[id].area))];
  const lat = LAT_LABEL[laterality(a)];
  const list = areas.filter(x => x !== lat);
  return [lat, list.slice(0, 3).join('、') + (list.length > 3 ? '等' : '')].filter(Boolean).join(' · ');
}

export const QUALITIES = ['跳痛 / 搏动感', '压迫 / 紧箍感', '胀痛', '刺痛', '钝痛', '灼烧感', '电击样'];
export const LOCATIONS = ['左侧', '右侧', '双侧', '前额', '太阳穴', '眼后', '头顶', '后脑', '后颈'];
export const SYMPTOMS = ['恶心', '呕吐', '畏光', '畏声', '视觉先兆', '头晕', '怕气味', '颈部僵硬', '乏力'];
export const DURATIONS = [
  { k: 'lt2', label: '<2h', h: 1 },
  { k: '2-4', label: '2–4h', h: 3 },
  { k: '4-12', label: '4–12h', h: 8 },
  { k: '12-24', label: '12–24h', h: 18 },
  { k: 'gt24', label: '>24h', h: 36 },
  { k: 'ongoing', label: '还在持续', h: null },
];
export const durationOf = k => DURATIONS.find(d => d.k === k);
export const TRIGGERS = ['睡眠不足', '睡太多', '经期前后', '压力', '漏餐', '咖啡因', '饮酒', '天气变化', '强光/屏幕', '气味', '脱水', '运动过度', '特定食物'];
export const EFFECTS = [
  { v: 0, label: '无效' },
  { v: 1, label: '部分缓解' },
  { v: 2, label: '完全缓解' },
];
export const RELIEF = [0.5, 1, 2, 3, 4];
export const STRESS = { 1: '低', 2: '中等', 3: '高' };

// 心理状态（参考 iOS「健康」的心情记录：7 级愉快程度 + 感受 + 影响因素）
export const MOOD = ['非常不愉快', '不愉快', '有点不愉快', '一般', '有点愉快', '愉快', '非常愉快'];
export const MOOD_SHORT = ['很糟', '不太好', '有点低落', '一般', '还不错', '愉快', '很棒'];
export const FEELINGS_NEG = ['焦虑', '有压力', '担心', '烦躁', '难过', '沮丧', '疲惫', '孤独', '不知所措'];
export const FEELINGS_POS = ['平静', '放松', '满足', '开心', '感恩', '有希望', '自信', '兴奋'];
export const MOOD_FACTORS = ['工作', '学习', '家庭', '伴侣', '朋友', '健康', '睡眠', '天气', '金钱', '时事', '自我照顾'];
// 由心情推算压力等级（兼容旧版只记了“压力 低/中/高”的数据）
export const stressOf = d => {
  if (!d) return null;
  if (d.mood) {
    const f = d.mood.feelings || [];
    if (f.includes('有压力') || f.includes('焦虑') || f.includes('不知所措')) return 3;
    if (d.mood.valence != null) return d.mood.valence <= 3 ? 2 : 1;
  }
  return d.stress ?? null;
};

// 饮食与运动：先选大类，再选具体项目，可以补充说明；也能直接填写（归入“未分类”，之后可以再分类）
export const UNCAT = '未分类';
export const FOOD_CATALOG = [
  { cat: '饮品', items: ['咖啡', '奶茶', '浓茶', '碳酸饮料', '能量饮料', '果汁', '代糖饮料'] },
  { cat: '酒类', items: ['红酒', '啤酒', '白酒', '洋酒 / 鸡尾酒'] },
  { cat: '甜食零食', items: ['巧克力', '蛋糕甜点', '冰淇淋 / 冷饮', '糖果', '薯片 / 膨化'] },
  { cat: '乳制品', items: ['奶酪', '牛奶', '酸奶'] },
  { cat: '肉类', items: ['腌制 / 加工肉', '红肉', '禽肉', '海鲜'] },
  { cat: '水果', items: ['柑橘类', '香蕉', '其他水果'] },
  { cat: '调味加工', items: ['味精 / 鸡精', '方便速食', '腌菜 / 发酵食品', '辛辣'] },
  { cat: '主食', items: ['米饭', '面食', '面包', '粥'] },
];
export const EXERCISE_CATALOG = [
  { cat: '有氧', items: ['散步', '跑步', '骑行', '游泳', '跳绳', '爬山 / 爬楼'] },
  { cat: '力量', items: ['器械训练', '自重训练'] },
  { cat: '身心', items: ['瑜伽', '普拉提', '拉伸', '太极'] },
  { cat: '球类', items: ['羽毛球', '乒乓球', '篮球', '网球', '足球'] },
  { cat: '其他运动', items: ['舞蹈', '家务 / 体力活'] },
];
export const INTENSITY = { 1: '轻松', 2: '适中', 3: '剧烈' };
// 常被提到的偏头痛相关食物（模型里的“常见诱发食物”；咖啡因和酒已单独分析，不重复计入）
export const TRIGGER_FOODS = ['代糖饮料', '巧克力', '奶酪', '腌制 / 加工肉', '柑橘类', '味精 / 鸡精', '腌菜 / 发酵食品'];

// GAD-7 / PHQ-9（过去两周），选项计 0–3 分
export const SCALE_OPTIONS = ['完全不会', '好几天', '一半以上的天数', '几乎每天'];
export const SCALES = {
  gad7: {
    name: 'GAD-7', title: '焦虑自评', minutes: 1,
    items: ['感觉紧张、焦虑或急切', '不能够停止或控制担忧', '对各种各样的事情担忧过多', '很难放松下来',
      '由于不安而无法静坐', '变得容易烦恼或急躁', '感到似乎将有可怕的事情发生而害怕'],
    bands: [[4, '基本没有焦虑'], [9, '轻度焦虑'], [14, '中度焦虑'], [21, '重度焦虑']],
  },
  phq9: {
    name: 'PHQ-9', title: '抑郁自评', minutes: 2,
    items: ['做事时提不起劲或没有兴趣', '感到心情低落、沮丧或绝望', '入睡困难、睡不安稳或睡眠过多', '感觉疲倦或没有活力',
      '食欲不振或吃太多', '觉得自己很糟，或觉得自己很失败，或让自己或家人失望', '对事物专注有困难，例如阅读或看电视时',
      '动作或说话速度缓慢到别人已经察觉，或正好相反——烦躁、坐立不安，动来动去的情况比平常更多', '有不如死掉或用某种方式伤害自己的念头'],
    bands: [[4, '基本没有抑郁'], [9, '轻度抑郁'], [14, '中度抑郁'], [19, '中重度抑郁'], [27, '重度抑郁']],
  },
};
export const scaleBand = (key, score) => SCALES[key].bands.find(([max]) => score <= max)[1];
export const scaleLevel = score => score <= 4 ? 0 : score <= 9 ? 1 : score <= 14 ? 2 : 3;
export const MEALS = [['b', '早餐'], ['l', '午餐'], ['d', '晚餐']];
export const DEFAULT_MEDS = [
  { name: '布洛芬', dose: '400mg', kind: 'acute' },
  { name: '对乙酰氨基酚', dose: '500mg', kind: 'acute' },
  { name: '佐米曲普坦', dose: '2.5mg', kind: 'acute' },
];

// ---------- 图标（24×24 线性） ----------
const P = {
  home: '<path d="M4 10.2 12 4l8 6.2V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z"/>',
  list: '<rect x="5" y="3.5" width="14" height="17" rx="2.5"/><path d="M9 8.5h6M9 12h6M9 15.5h3.5"/>',
  chart: '<path d="M6 20v-8M12 20V5M18 20v-5"/>',
  user: '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.8 20c1.3-3.6 4-5.5 7.2-5.5s5.9 1.9 7.2 5.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevL: '<path d="m14.5 6-6 6 6 6"/>',
  chevR: '<path d="m9.5 6 6 6-6 6"/>',
  x: '<path d="M17.5 6.5l-11 11M6.5 6.5l11 11"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  trash: '<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l.9 12.2a1 1 0 0 0 1 .8h7.2a1 1 0 0 0 1-.8L17.5 7"/>',
  flame: '<path d="M12 3.5c.6 2.6 4.5 4.6 4.5 9.1a4.5 4.5 0 0 1-9 0c0-1.9.9-3.3 2-4.2.1 1.6.8 2.6 1.9 2.9-.3-2.5-.5-5.2.6-7.8z"/>',
  drop: '<path d="M12 3.5s6 6.4 6 10.8a6 6 0 0 1-12 0C6 9.9 12 3.5 12 3.5z"/>',
  utensils: '<path d="M7 3.5v17M4.5 3.5v4.8a2.5 2.5 0 0 0 5 0V3.5M17 20.5V3.5c-1.9.6-3 2.8-3 5.5 0 2.2.9 3.6 3 3.9"/>',
  moon: '<path d="M19.5 14.6A7.8 7.8 0 0 1 9.4 4.5a7.8 7.8 0 1 0 10.1 10.1z"/>',
  pulse: '<path d="M3 12h3.8l2.4-5.5 4.6 11 2.4-5.5H21"/>',
  dumbbell: '<path d="M6.5 7v10M17.5 7v10M3.5 9.5v5M20.5 9.5v5M6.5 12h11"/>',
  pill: '<rect x="3" y="8.5" width="18" height="7" rx="3.5"/><path d="M12 8.5v7"/>',
  download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/>',
  upload: '<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M5 19.5h14"/>',
  file: '<path d="M7 3.5h7l4 4v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z"/><path d="M14 3.5v4h4M9 12.5h6M9 16h6"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8v.01"/>',
  sparkle: '<path d="M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2L5 10.5l5.2-1.8z"/><path d="M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  share: '<path d="M12 4v11M8 7.5 12 3.5l4 4M6 11H5.5a1 1 0 0 0-1 1v7.5a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1V12a1 1 0 0 0-1-1H18"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V5.5a1 1 0 0 0-1-1h-9a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3"/>',
  shield: '<path d="M12 3.5 5 6v5.5c0 4.2 2.9 7.6 7 9 4.1-1.4 7-4.8 7-9V6z"/>',
  alert: '<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.5M12 17v.01"/>',
  edit: '<path d="M4.5 19.5h4l10-10-4-4-10 10z"/><path d="M13 7l4 4"/>',
  calendar: '<rect x="4" y="5.5" width="16" height="14.5" rx="2.5"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
  checkCircle: '<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.2 2.4 2.4 4.6-4.8"/>',
  bolt: '<path d="M13 3.5 5.5 13.5h6l-1 7 7.5-10h-6z"/>',
  chevD: '<path d="m6 9.5 6 6 6-6"/>',
  smile: '<circle cx="12" cy="12" r="8.5"/><path d="M8.6 14.2c1.8 2.2 5 2.2 6.8 0"/><path d="M9.3 9.6v.6M14.7 9.6v.6"/>',
  clipboard: '<rect x="5.5" y="4.5" width="13" height="16" rx="2.5"/><path d="M9.5 4.5V3.6c0-.6.4-1.1 1-1.1h3c.6 0 1 .5 1 1.1v.9M9 10h6M9 13.5h6M9 17h3.5"/>',
  phone: '<path d="M6.5 3.5h3l1.5 4-2 1.3a10 10 0 0 0 5.2 5.2l1.3-2 4 1.5v3a2 2 0 0 1-2.2 2A15.8 15.8 0 0 1 4.5 5.7a2 2 0 0 1 2-2.2z"/>',
};
export const icon = (name, size = 22, sw = 1.8) =>
  `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
