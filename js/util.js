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
  3: { label: '重度', hint: '需要卧床休息' },
};
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
};
export const icon = (name, size = 22, sw = 1.8) =>
  `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
