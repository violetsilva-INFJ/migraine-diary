// 一段话 → App 里的选项（本地规则，不联网）
// 尽量宽松地认常见说法；拿不准的标成“猜测”（fuzzy），确认页里用虚线显示，交给用户决定。
// 注意：这里不用正则的后行断言（?<=…），旧版 iOS Safari 不支持，会让整个模块加载失败。
import {
  REGIONS, REGION_IDS, QUALITIES, SYMPTOMS, DURATIONS, TRIGGERS, EFFECTS, RELIEF, INTENSITY,
  FOOD_CATALOG, EXERCISE_CATALOG, MOOD_SHORT, FEELINGS_NEG, FEELINGS_POS, MOOD_FACTORS, CAFFEINE_ITEMS,
  UNCAT, dkey, shiftKey, todayKey, hhmm, md,
} from './util.js';

// ---------- 数字 ----------
const N = '(?:\\d+(?:\\.\\d+)?|[零〇一二两俩三四五六七八九十]+)';
const DIG = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 俩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
export function cnNum(s) {
  if (s == null || s === '') return null;
  s = String(s);
  if (s === '半') return 0.5;
  if (/^\d/.test(s)) return parseFloat(s);
  // “七八个小时”“五六分”：取中间
  if (s.length === 2 && DIG[s[0]] != null && DIG[s[1]] === DIG[s[0]] + 1) return DIG[s[0]] + 0.5;
  const i = s.indexOf('十');
  if (i < 0) return s.length === 1 ? (DIG[s] ?? null) : null;
  const tens = i === 0 ? 1 : DIG[s[i - 1]], ones = i === s.length - 1 ? 0 : DIG[s[i + 1]];
  if (tens == null || ones == null || s.length > 3) return null;
  return tens * 10 + ones;
}
// “一个半小时”“两个多小时”这类说法
const hoursOf = (num, half, more) => {
  const v = num === '半' ? 0.5 : cnNum(num);
  return v == null ? null : v + (half ? 0.5 : 0) + (more ? 0.3 : 0);
};

// ---------- 分句与日期 ----------
// 先按标点切；再在“然后 / 后来 / 但是…”前切一刀（语音输入常常一整段没有标点）
const SOFT = /然后|后来|但是|不过|而且|另外|结果|接着/g;
function splitClauses(text) {
  const out = [], re = /[^，,。；;！!？?\n]+/g;
  let m;
  while ((m = re.exec(text))) {
    const t = m[0], cuts = [];
    for (const x of t.matchAll(SOFT)) if (x.index > 0) cuts.push(x.index);
    let prev = 0;
    for (const c of [...cuts, t.length]) {
      if (c > prev) out.push({ s: m.index + prev, e: m.index + c, t: t.slice(prev, c) });
      prev = c;
    }
  }
  return out;
}
// 每一句说的是哪天：说了“昨天 / 前天 / 今天”就切换，没说就沿用上一句；
// “昨晚……，早上起来……” 里的早上是今天
function markDays(cls) {
  let off = 0, night = false;
  for (const c of cls) {
    const t = c.t;
    let o = null, n = false;
    if (/前天|前晚/.test(t)) { o = -2; n = /前晚|前天(晚上|夜里|半夜)/.test(t); }
    else if (/昨/.test(t)) { o = -1; n = /昨(晚|夜)|昨天(晚上|夜里|半夜)/.test(t); }
    else if (/今[天早晚日儿]/.test(t)) o = 0;
    else if (night && !/晚上|夜里|半夜|凌晨|睡/.test(t)) o = off + 1;
    if (o != null) { off = o; night = n; }
    c.off = off;
  }
}

// ---------- 结果 ----------
class Result {
  constructor(text, now) {
    this.text = text; this.now = now; this.items = []; this.masks = {};
  }
  key(off) { return shiftKey(dkey(this.now), off); }
  mask(fam) { return (this.masks[fam] ||= new Uint8Array(this.text.length)); }
  free(fam, s, e) { const m = this.mask(fam); for (let i = s; i < e; i++) if (m[i]) return false; return true; }
  take(fam, s, e) { const m = this.mask(fam); for (let i = s; i < e; i++) m[i] = 1; }
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

// 把顶层的“甲|乙|丙”按长度从长到短排，让“麻辣烫”先于“麻辣”匹配
function longestFirst(src) {
  const parts = [];
  let depth = 0, cur = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') { cur += ch + src[++i]; continue; }
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === '|' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  return parts.sort((a, b) => b.length - a.length).join('|');
}
const sorted = new Map();
// 在整段文字里找，返回 [起点, 终点, match]；fam 相同的匹配不能重叠（先到先得，所以把具体的说法放前面）
function* scan(R, fam, re, within = null) {
  const src = typeof re === 'string' ? (sorted.get(re) || sorted.set(re, longestFirst(re)).get(re)) : re.source;
  const g = new RegExp(src, 'g');
  for (const m of R.text.matchAll(g)) {
    const s = m.index, e = s + m[0].length;
    if (!m[0] || (within && (s < within.s || e > within.e))) continue;
    if (fam && !R.free(fam, s, e)) continue;
    if (fam) R.take(fam, s, e);
    yield [s, e, m];
  }
}
const clauseAt = (cls, i) => cls.find(c => i >= c.s && i < c.e) || cls[cls.length - 1];
const before = (text, i, n = 4) => text.slice(Math.max(0, i - n), i);
const NEG_TAIL = /(没|没有|不|无|未|别|不再|戒了?|并没有?)(喝|吃|做|去|再|怎么)?\s*$/;

// ---------- 头痛 ----------
const HEAD_RE = new RegExp(`偏头痛|头痛|头疼|(?:头|脑袋|脑壳|脑仁|脑子|太阳穴|后脑勺?|额头|前额|头顶|眼眶|偏头)[^，,。；;！!？?\\n]{0,8}?(?:疼|痛|胀|炸|裂开|难受|不舒服|发作)|(?:疼痛|痛感|疼痛程度)\\s*(?:是|有|大概|约)?\\s*${N}\\s*分|(?:头|脑袋)(?:很|好|有点|特别)?(?:沉|重|闷|胀)`);
const PAINY = /疼|痛|胀|跳|酸|紧|压|难受|不舒服|炸|裂|晕|沉/;

// 疼痛强度（文字说法，都算“猜测”）
const VAS_WORDS = [
  [3, '有点疼|有点痛|有点头疼|有点头痛|有一点|一点点|轻微|轻度|隐隐|微微|稍微|不太疼|不太痛|不怎么疼|不怎么痛|还好|能忍|小疼|闷闷'],
  [9, '疼死|痛死|要命|炸裂|裂开|爆炸|受不了|撞墙|最疼|最痛|从没这么|剧痛|疼哭|痛哭|疼得哭|打滚|动不了|起不来'],
  [7, '很疼|很痛|好疼|好痛|非常疼|非常痛|特别疼|特别痛|超疼|超痛|巨疼|巨痛|疼得厉害|痛得厉害|严重|重度|剧烈|十分疼|十分痛|厉害|难以忍受|没法上班|没法工作|疼醒|痛醒|疼得想吐|太疼|太痛|疼得睡不着|痛得睡不着'],
  [5, '挺疼|挺痛|蛮疼|蛮痛|比较疼|比较痛|中度|还挺|有些疼|有些痛|影响(?:工作|上班|做事|学习)'],
];

const REGION_SYN = [
  [['vertex'], '头顶|天灵盖|颅顶'],
  [['forehead-L', 'forehead-R'], '额头|前额|脑门|额角|眉心|眉间'],
  [['temple-L', 'temple-R'], '太阳穴|鬓角'],
  [['parietal-L', 'parietal-R'], '耳朵?上方|耳朵?上面|耳朵?上边|头的?两侧|头的?侧面|头侧|偏头(?!痛)'],
  [['eye-L', 'eye-R'], '眼眶|眼窝|眼睛后面|眼球后|眼后|眼睛周围|眼周|眉骨|眼睛(?:疼|痛|胀)'],
  [['face-L', 'face-R'], '面颊|脸颊|颧骨|牙齿?(?:疼|痛)|下巴|腮|上颌|鼻窦|半边脸|脸(?:疼|痛)'],
  [['occiput-L', 'occiput-R'], '后脑勺?|枕部|脑后|后头|后枕'],
  [['neck-L', 'neck-R'], '后颈|脖子|颈部|颈椎|脖颈|颈后|肩颈'],
];
const SIDE_OF = t => /左/.test(t) && /右/.test(t) ? 'B' : /两边|两侧|双侧|两半/.test(t) ? 'B' : /左/.test(t) ? 'L' : /右/.test(t) ? 'R' : null;

const QUALITY_SYN = [
  ['跳痛 / 搏动感', '跳痛|跳着(?:疼|痛)|一跳一跳|跳跳的|突突|嘣嘣|砰砰|咚咚|搏动|一抽一抽|抽着(?:疼|痛)|抽痛|血管.{0,2}跳|跟着心跳|随着心跳|蹦蹦'],
  ['压迫 / 紧箍感', '压迫|压着|被压|紧箍|箍着|箍住|勒着|勒紧|绷着|紧绷|发紧|很紧|好紧|夹着|被夹|沉甸甸|沉重|重重的|头很重|头好重|头重'],
  ['胀痛', '胀|涨痛|涨涨|鼓鼓|要炸'],
  ['刺痛', '刺痛|针扎|针刺|扎着|像针|锥子|锥着|戳着|一刺一刺|尖锐'],
  ['钝痛', '钝痛|钝钝|闷痛|闷疼|闷闷|隐隐|隐痛|昏沉|沉沉|木木'],
  ['灼烧感', '灼|火烧|烧着|烧得|火辣辣|热辣辣|发烫'],
  ['电击样', '电击|过电|触电|像电|电一下|放电|闪电'],
];
const SYMPTOM_SYN = [
  ['呕吐', '吐了|呕吐|吐出|狂吐|一直吐|吐得'],
  ['恶心', '恶心|想吐|反胃|作呕|干呕|犯呕|胃里翻'],
  ['畏光', '怕光|畏光|刺眼|见不得光|不敢看光|光线刺|受不了光|怕亮|拉上窗帘|戴墨镜'],
  ['畏声', '怕吵|怕声音|畏声|声音刺耳|受不了声音|听不得|怕噪音|受不了吵|吵得'],
  ['视觉先兆', '先兆|闪光|锯齿|眼前发黑|冒金星|看不清|视线模糊|视物模糊|眼花|盲点|眼前有光|亮点|闪烁|半边看不见'],
  ['头晕', '头晕|晕乎|眩晕|天旋地转|头昏|晕晕|发晕|有点晕|很晕|好晕'],
  ['怕气味', '怕味道|怕气味|闻不了|闻不得|闻到.{0,4}(?:恶心|难受|想吐)|味道刺鼻|怕闻'],
  ['颈部僵硬', '脖子(?:也|都|还)?(?:很|好|有点|有些|特别)?(?:僵|硬|酸|紧)|颈部僵|颈椎(?:不舒服|酸|僵)|落枕|肩颈(?:僵|酸|紧)'],
  ['乏力', '乏力|没力气|没劲|浑身无力|四肢无力|软绵绵|虚脱|全身无力'],
];

// 诱因：说了“因为 / 可能 / 估计……”才算；天气、屏幕这类本身就是在说诱因，没说原因也先猜上
const CAUSAL = /因为|由于|可能|估计|应该是|大概是|怀疑|导致|引起|诱发|害得|搞得|所以|是不是|感觉是|有关|原因/;
const TRIGGER_SYN = [
  ['睡眠不足', '熬夜|没睡好|睡得少|睡太少|失眠|睡眠不足|没睡够|缺觉|通宵|晚睡|睡得晚|睡得不好', false],
  ['睡太多', '睡太多|睡多了|睡过头|睡太久|补觉|赖床|睡到中午|睡了一整天', false],
  ['经期前后', '月经|姨妈|例假|生理期|经期|来事|经前', false],
  ['压力', '压力|加班|ddl|DDL|deadline|赶工|赶稿|考试|焦虑|紧张|吵架|生气|太忙', false],
  ['漏餐', '没吃饭|没吃早|没吃午|没吃晚|饿着?|空腹|漏餐|没顾上吃|忘了吃', false],
  ['咖啡因', '咖啡|奶茶|浓茶|咖啡因|红牛|戒咖啡', false],
  ['饮酒', '喝酒|喝了酒|酒|宿醉|喝多', false],
  ['天气变化', '天气|变天|下雨|降温|升温|台风|气压|闷热|太热|太冷|吹了?风|空调|阴天|雷雨', true],
  ['强光/屏幕', '看手机|玩手机|盯着?手机|盯着?电脑|看电脑|屏幕|晒太阳|太阳太?大|强光|打游戏|刷剧|追剧', true],
  ['气味', '香水|油烟|烟味|二手烟|装修味|甲醛|刺鼻', true],
  ['脱水', '没喝水|喝水少|脱水|口渴|没怎么喝水|喝水太少', true],
  ['运动过度', '运动过度|运动太猛|练太狠|练猛了|运动太多|跑太多|练太久', true],
];

// 常见药名（别名 → 通用名）；用户在「我的」里添加的药按原名匹配
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
const GENERIC_MED = '止痛药|止疼药|止痛片|止疼片|镇痛药|吃了药|吃药了|吃了点药|吃了片药|吃了一片|吃了两片|吃了一粒|吃了两粒|吃了一颗';
const EFFECT_SYN = [
  [0, '没用|没效|无效|不管用|没缓解|没有缓解|没什么用|没啥用|一点用|白吃|还是(?:很|一样)?(?:疼|痛)|不见好'],
  [1, '好一点|好点了|好些了|好了一些|好了一点|缓解了一点|缓解一些|缓解了一些|轻了|减轻|有点用|稍微好|没那么(?:疼|痛)|好多了|缓解不少'],
  [2, '完全好|彻底好|不疼了|不痛了|好了|消失|没事了|管用|很有效|立马好|见效|缓解了|(?:才|就|总算|终于|慢慢|逐渐)缓解'],
  [1, '缓解'],
];

// 饮食：大类 / 具体项目 / 说法（越具体越靠前；item 为 null 时用说出来的词作为项目名）
const FOOD_SYN = [
  ['饮品', '代糖饮料', '(?:无糖|零度|零卡|0糖|零糖|代糖|健怡)\\s*(?:可乐|雪碧|汽水|饮料|气泡水|苏打水)|元气森林|代糖饮料'],
  ['饮品', '奶茶', '奶茶|喜茶|奈雪|蜜雪冰城|蜜雪|茶百道|霸王茶姬|古茗|书亦|沪上阿姨|茶颜悦色|乐乐茶|奶绿|奶盖|珍珠奶'],
  ['饮品', '咖啡', '咖啡|拿铁|美式|卡布奇诺|摩卡|冷萃|澳白|馥芮白|星巴克|瑞幸|库迪|manner|Manner|dirty|Dirty'],
  ['饮品', '能量饮料', '红牛|魔爪|东鹏特饮|东鹏|战马|乐虎|能量饮料|功能饮料'],
  ['饮品', '浓茶', '浓茶|绿茶|红茶|乌龙|普洱|铁观音|龙井|大红袍|白茶|岩茶|单丛|抹茶|柠檬茶|喝茶|泡茶|喝了茶|茶水|杯茶'],
  ['饮品', '碳酸饮料', '可乐|雪碧|汽水|芬达|碳酸饮料|气泡水|苏打水|七喜|美年达'],
  ['饮品', '果汁', '果汁|橙汁|苹果汁|葡萄汁|西瓜汁|椰汁|椰子水|鲜榨'],
  ['酒类', '红酒', '红酒|葡萄酒|干红|干白|起泡酒|香槟'],
  ['酒类', '啤酒', '啤酒|扎啤|精酿|鲜啤'],
  ['酒类', '白酒', '白酒|二锅头|茅台|五粮液|汾酒|烧酒|高粱酒'],
  ['酒类', '洋酒 / 鸡尾酒', '威士忌|伏特加|鸡尾酒|洋酒|朗姆|金酒|龙舌兰|白兰地|嗨棒|highball|莫吉托'],
  ['酒类', null, '黄酒|米酒|清酒|梅酒|果酒|梅子酒|烧酎'],
  ['酒类', '饮酒', '喝酒|喝了酒|喝了点酒|小酌|喝多了|宿醉|喝醉|喝了几杯|应酬'],
  ['甜食零食', '巧克力', '巧克力|德芙|费列罗|脆香米|士力架'],
  ['甜食零食', '冰淇淋 / 冷饮', '冰淇淋|冰激凌|雪糕|冰棍|冰棒|冷饮|哈根达斯|甜筒|圣代|冰沙'],
  ['甜食零食', '蛋糕甜点', '蛋糕|甜点|甜品|蛋挞|马卡龙|提拉米苏|甜甜圈|泡芙|慕斯|布丁|月饼|糕点|点心'],
  ['甜食零食', '糖果', '糖果|棒棒糖|软糖|硬糖|奶糖|口香糖|吃了?糖'],
  ['甜食零食', '薯片 / 膨化', '薯片|膨化|辣条|爆米花|虾条|锅巴|妙脆角'],
  ['甜食零食', null, '饼干|曲奇|威化|零食|坚果'],
  ['乳制品', '奶酪', '奶酪|芝士|起司|乳酪|cheese|披萨'],
  ['乳制品', '酸奶', '酸奶|优格|养乐多|乳酸菌'],
  ['乳制品', '牛奶', '牛奶|纯奶|鲜奶|喝奶|一杯奶|盒奶'],
  ['调味加工', '味精 / 鸡精', '味精|鸡精'],
  ['调味加工', '方便速食', '方便面|泡面|速食|自热火锅|自热|螺蛳粉|酸辣粉|速冻'],
  ['调味加工', '腌菜 / 发酵食品', '泡菜|酸菜|腌菜|咸菜|榨菜|豆豉|腐乳|臭豆腐|纳豆|酸笋|梅干菜|雪菜|老坛'],
  ['调味加工', '辛辣', '火锅|麻辣|辣椒|吃辣|辣的|很辣|特辣|川菜|湘菜|麻辣烫|串串|冒菜|烧烤|撸串|水煮鱼|香锅'],
  ['肉类', '腌制 / 加工肉', '腊肉|腊肠|香肠|火腿|培根|午餐肉|咸肉|熏肉|烤肠|热狗|肉松|腊味|肉干'],
  ['肉类', '红肉', '牛肉|羊肉|猪肉|牛排|红烧肉|排骨|五花肉|肥牛|羊排|猪蹄|肉夹馍'],
  ['肉类', '禽肉', '鸡肉|鸡腿|鸡翅|炸鸡|鸡胸|鸭肉|烤鸭|鸭脖|鹅肉|烧鹅|鸡块|宫保鸡丁|大盘鸡|黄焖鸡|白切鸡|口水鸡'],
  ['肉类', '海鲜', '海鲜|小龙虾|螃蟹|生蚝|扇贝|三文鱼|鱿鱼|章鱼|海参|蛤蜊|花甲|鱼|虾|蟹'],
  ['水果', '柑橘类', '橙子|橘子|桔子|柑橘|柚子|柠檬|砂糖橘|耙耙柑|沃柑|丑橘|金桔'],
  ['水果', '香蕉', '香蕉'],
  ['水果', '其他水果', '水果|苹果|葡萄|西瓜|草莓|芒果|桃子|荔枝|榴莲|蓝莓|樱桃|车厘子|猕猴桃|菠萝|哈密瓜|火龙果|山竹|龙眼|桂圆|杨梅|李子|柿子|石榴'],
  ['主食', '面包', '面包|吐司|三明治|汉堡|贝果|可颂|牛角包'],
  ['主食', '粥', '粥|稀饭'],
  ['主食', '面食', '面条|拉面|吃面|一碗面|汤面|拌面|炒面|热干面|刀削面|米线|米粉|河粉|饺子|包子|馄饨|云吞|馒头|煎饼|花卷|烧麦'],
  ['主食', '米饭', '米饭|白饭|炒饭|盖饭|盖浇饭|拌饭|饭团|寿司|煲仔饭|咖喱饭|一碗饭'],
];
const EX_SYN = [
  ['有氧', '散步', `散步|走路|遛弯|遛狗|步行|快走|走了\\s*${N}\\s*[万千]?步|万步|逛街|逛公园`],
  ['有氧', '跑步', '跑步|慢跑|夜跑|晨跑|跑了|跑步机|长跑|马拉松'],
  ['有氧', '骑行', '骑行|骑车|单车|骑自行车|动感单车'],
  ['有氧', '游泳', '游泳|游了'],
  ['有氧', '跳绳', '跳绳'],
  ['有氧', '爬山 / 爬楼', '爬山|徒步|登山|爬楼'],
  ['力量', '器械训练', '健身房|撸铁|器械|练腿|练背|练胸|力量训练|举铁|深蹲|硬拉|卧推|健身'],
  ['力量', '自重训练', '俯卧撑|平板支撑|仰卧起坐|自重|帕梅拉|HIIT|hiit|开合跳|波比跳|keep|Keep|跟练|卷腹'],
  ['身心', '瑜伽', '瑜伽|瑜珈'],
  ['身心', '普拉提', '普拉提'],
  ['身心', '拉伸', '拉伸|拉筋|泡沫轴'],
  ['身心', '太极', '太极|八段锦|气功'],
  ['球类', '羽毛球', '羽毛球'], ['球类', '乒乓球', '乒乓'], ['球类', '篮球', '篮球'], ['球类', '网球', '网球'], ['球类', '足球', '足球'],
  ['球类', null, '排球|飞盘|高尔夫|台球|保龄球|匹克球|棒球'],
  ['其他运动', '舞蹈', '跳舞|舞蹈|广场舞|尊巴|爵士舞|街舞|芭蕾'],
  ['其他运动', '家务 / 体力活', '家务|大扫除|搬家|搬东西|打扫|拖地|体力活'],
  ['其他运动', null, '滑雪|攀岩|拳击|滑板|划船|骑马|冲浪|溜冰|轮滑'],
];
const EX_INT = [[3, '剧烈|高强度|累死|大汗|狠狠|拼命|练爆|练废|好累|很累|暴汗|累瘫|累趴'], [1, '轻松|慢慢|随便|散散|轻度|溜达|慢走'], [2, '适中|中等强度|一般强度']];

// 心情：先查否定和程度更具体的说法（有点不开心 → 不开心 → 开心）
const VALENCE_SYN = [
  [1, '崩溃|绝望|糟透|糟糕透|痛不欲生|特别难过|极差|超级差|太难了'],
  [3, '有点(?:烦|丧|低落|郁闷|不开心|难过|不爽|不好)|不太好|一般般|没什么精神'],
  [2, '心情(?:很|特别|非常|超)?(?:不好|差|糟)|郁闷|不开心|不高兴|不爽|难过|伤心|低落|很丧|emo|抑郁|心累|烦死|好烦|很烦|沮丧|失落'],
  [7, '超开心|特别开心|非常开心|超级开心|太开心|很开心|很高兴|幸福|心情超好|心情特别好|开心死了'],
  [5, '心情不错|心情还不错|心情挺好|心情还可以|情绪不错|心情蛮好'],
  [4, '心情一般|情绪一般|心情还行|情绪还行|心情平平|心情平静|情绪平稳|心情普通'],
  [6, '开心|高兴|愉快|快乐|心情好|心情很好|美滋滋'],
];
const FEEL_SYN = [
  ['焦虑', '焦虑|焦躁|心慌|慌张|紧张|不安'],
  ['有压力', '压力|喘不过气|ddl|DDL|deadline|事情好多|好多事'],
  ['担心', '担心|担忧|害怕|忧心|顾虑'],
  ['烦躁', '烦躁|烦死|好烦|很烦|心烦|暴躁|生气|火大|气死|恼火|不耐烦|有点烦'],
  ['难过', '难过|伤心|想哭|哭了|委屈|心酸|失望'],
  ['沮丧', '沮丧|失落|挫败|很丧|有点丧|emo|低落|无助|提不起劲'],
  ['疲惫', '累|疲惫|疲劳|困|没精神|没精打采|心累'],
  ['孤独', '孤独|孤单|寂寞'],
  ['不知所措', '不知所措|手足无措|一团乱|一团糟|乱糟糟'],
  ['平静', '平静|淡定|安心|心静|平和'],
  ['放松', '放松|轻松|悠闲|惬意'],
  ['满足', '满足|满意|充实|踏实|成就感'],
  ['开心', '开心|高兴|快乐|愉快|哈哈'],
  ['感恩', '感恩|感激|幸运'],
  ['有希望', '有希望|期待|乐观|有盼头'],
  ['自信', '自信|有信心|有底气'],
  ['兴奋', '兴奋|激动'],
];
const FACTOR_SYN = [
  ['工作', '工作|上班|加班|同事|老板|领导|项目|开会|客户'],
  ['学习', '学习|考试|作业|论文|上课|复习|考研|答辩|写报告'],
  ['家庭', '家里|家人|爸|妈|父母|孩子|娃|家庭|婆婆|公公'],
  ['伴侣', '男朋友|女朋友|对象|老公|老婆|伴侣|另一半|男友|女友|恋爱|分手'],
  ['朋友', '朋友|闺蜜|兄弟|聚会|同学'],
  ['健康', '生病|身体|健康|看病|医院|感冒'],
  ['睡眠', '睡眠|没睡好|失眠|睡不着'],
  ['天气', '天气|下雨|阴天|太热|闷热|降温|台风|雾霾'],
  ['金钱', '钱|工资|房租|花钱|还款|房贷|基金|股票|理财'],
  ['时事', '新闻|时事|热搜'],
  ['自我照顾', '自我照顾|泡澡|护肤|按摩|冥想|休息日|放假'],
];

// ---------- 时间 ----------
const PERIOD_H = { 凌晨: 3, 清晨: 6.5, 一早: 7, 早上: 7.5, 早晨: 7.5, 起床: 7.5, 醒来: 7.5, 睡醒: 7.5, 一醒: 7.5, 上午: 10, 中午: 12.5, 午饭后: 13, 午睡后: 14.5, 下午: 15, 下班: 18.5, 放学: 17, 傍晚: 18, 晚上: 20, 晚饭后: 19.5, 夜里: 23, 半夜: 23.5, 深夜: 23.5 };
const PERIOD_RE = '凌晨|清晨|一早|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|半夜|深夜';
const CLOCK_RE = new RegExp(`(${PERIOD_RE})?\\s*(?:的)?\\s*(${N})\\s*(?:点|:|：|时)(?:\\s*(半)|\\s*(一刻)|\\s*(三刻)|\\s*(${N})\\s*分?)?\\s*(多|左右)?`, 'g');
const AGO_RE = new RegExp(`(${N}|半)\\s*个?\\s*(半)?\\s*(多)?\\s*(小时|钟头|分钟)\\s*(?:之|以)?前`, 'g');
const PERIOD_ONLY_RE = new RegExp(`${Object.keys(PERIOD_H).sort((a, b) => b.length - a.length).join('|')}`, 'g');

// 某天（相对今天 off 天）的几点；没说上下午时取“已经过去、离现在最近”的那个
function atClock(now, off, H, M, amb) {
  const make = h => { const d = new Date(now); d.setDate(d.getDate() + off); d.setHours(Math.floor(h), M + Math.round((h % 1) * 60), 0, 0); return d; };
  const cands = amb ? [H, H === 12 ? 0 : H + 12] : [H];
  const limit = +now + 5 * 60000;
  if (off < 0) {
    // 过去的某天：1–6 点更可能是下午
    return { at: make(amb && H >= 1 && H <= 6 ? H + 12 : H), fuzzy: amb };
  }
  const past = cands.map(make).filter(d => +d <= limit).sort((a, b) => b - a);
  if (past.length) return { at: past[0], fuzzy: amb && past.length > 1 };
  // 说的时间还没到（早上说“下午三点”）：多半是昨天
  const prev = cands.map(make).map(d => { d.setDate(d.getDate() - 1); return d; }).sort((a, b) => b - a);
  return { at: prev[0], fuzzy: true };
}
// 在一句话里找时间（几点 / 多久以前 / 早上下午这类）
function findTime(R, c) {
  const t = c.t, now = R.now;
  for (const m of t.matchAll(CLOCK_RE)) {
    const raw = m[2], after = t.slice(m.index + m[0].length, m.index + m[0].length + 2), prev = t.slice(Math.max(0, m.index - 1), m.index);
    if (!m[1] && raw === '一' && !m[3] && !m[6] && !/^钟/.test(after)) continue; // “有一点”“好一点”不是一点钟
    if (/^[点儿]/.test(after)) continue;
    if (/^(?:睡|起|醒)/.test(after.replace(/^才/, ''))) continue; // “12 点睡 / 7 点起”是作息
    if (/[第]/.test(prev)) continue;
    const h = cnNum(raw);
    if (h == null || h > 24) continue;
    const min = m[3] ? 30 : m[4] ? 15 : m[5] ? 45 : m[6] ? cnNum(m[6]) : 0;
    if (min == null || min >= 60) continue;
    let H = h;
    const p = m[1];
    if (p && /下午|傍晚|晚上|夜里|深夜/.test(p) && H < 12) H += 12;
    if (p === '中午' && H < 6) H += 12;
    if (H >= 24) H = 23.99;
    const r = atClock(now, c.off, H, min, !p && h >= 1 && h <= 12);
    return { ...r, span: [c.s + m.index, c.s + m.index + m[0].length], fuzzy: r.fuzzy || !!m[7] };
  }
  for (const m of t.matchAll(AGO_RE)) {
    const h = hoursOf(m[1], m[2], m[3]);
    if (h == null) continue;
    const mins = m[4] === '分钟' ? (m[1] === '半' ? 30 : cnNum(m[1])) : h * 60;
    return { at: new Date(+now - mins * 60000), fuzzy: !!m[3], span: [c.s + m.index, c.s + m.index + m[0].length] };
  }
  const j = t.search(/刚刚|刚才|刚开始/);
  if (j >= 0) return { at: new Date(now), fuzzy: false, span: [c.s + j, c.s + j + 2] };
  for (const m of t.matchAll(PERIOD_ONLY_RE)) {
    const r = atClock(now, c.off, PERIOD_H[m[0]], 0, false);
    return { at: r.at, fuzzy: true, span: [c.s + m.index, c.s + m.index + m[0].length] };
  }
  return null;
}
const durKey = h => h < 2 ? 'lt2' : h < 4 ? '2-4' : h < 12 ? '4-12' : h < 24 ? '12-24' : 'gt24';
const nearestRelief = h => RELIEF.reduce((b, r) => Math.abs(r - h) < Math.abs(b - h) ? r : b, RELIEF[0]);

// ======================= 主函数 =======================
// ctx: { now, meds: 用户的常用药, customTriggers }
export function parseText(text, ctx = {}) {
  const now = ctx.now || new Date();
  const R = new Result(text, now);
  const cls = splitClauses(text);
  if (!cls.length) return R;
  markDays(cls);
  const T = text;

  // ---- 头痛：有没有 ----
  const heads = [];
  let negHead = null, mild = false;
  for (const [s, e, m] of scan(R, 'head', HEAD_RE)) {
    const inner = m[0], pre = before(T, s, 3);
    if (/(没|没有|不|无|未|别|不再)$/.test(pre) || /^(?:头|脑袋|脑壳)(?:也|都|就|还)?(?:没|不)(?!太|怎么|是很|算)/.test(inner)) {
      negHead ||= { s, e, c: clauseAt(cls, s) };
      continue;
    }
    if (/不(?:太|怎么|是很|算)/.test(inner)) mild = true;
    heads.push({ s, e, c: clauseAt(cls, s) });
  }
  const hasAttack = heads.length > 0;
  const aOff = hasAttack ? heads[0].c.off : 0;
  const headClauses = new Set(heads.map(h => h.c));
  for (const h of heads) R.add('a', 'head', true, { span: [h.s, h.e] });
  if (!negHead) {
    const m = /(?:没|没有)(?:犯病|犯偏头痛|发作|再疼|再痛)|一点(?:都|也)不(?:疼|痛)|一天都没(?:疼|痛)|今天(?:都|也)?(?:没|不)(?:疼|痛)/.exec(T);
    if (m) negHead = { s: m.index, e: m.index + m[0].length, c: clauseAt(cls, m.index) };
  }
  if (negHead && (!hasAttack || negHead.c.off !== aOff)) R.add('d', 'nopain', true, { span: [negHead.s, negHead.e], date: R.key(negHead.c.off) });

  // 和疼痛有关的句子（部位 / 性质 / 强度只在这些句子里找，免得“压力”“刺眼”被当成疼痛描述）
  const painCls = cls.filter(c => headClauses.has(c) || (hasAttack && PAINY.test(c.t)));
  const inPain = (s) => painCls.some(c => s >= c.s && s < c.e);

  if (hasAttack) {
    // ---- 开始时间 ----
    let start = null;
    for (const h of heads) {
      const i = cls.indexOf(h.c);
      if (/减轻|缓解|好了|好多了|好些|不疼|不痛/.test(h.c.t)) continue;
      start = findTime(R, h.c) || (i > 0 && !headClauses.has(cls[i - 1]) && !MED_ANY.test(cls[i - 1].t) ? findTime(R, cls[i - 1]) : null);
      if (start) break;
    }
    if (!start && /醒来就|一起床就|起床就|早上起来就|疼醒|痛醒/.test(T)) {
      start = { at: atClock(now, aOff, 7.5, 0, false).at, fuzzy: true, span: null };
    }
    if (start) {
      if (+start.at > +now) start.at = new Date(now);
      R.add('a', 'start', `${dkey(start.at)}T${hhmm(start.at)}`, { fuzzy: start.fuzzy, span: start.span });
    } else if (aOff !== 0) {
      // 只说了“昨天头疼”，没说几点
      const d = new Date(now); d.setDate(d.getDate() + aOff);
      R.add('a', 'start', `${dkey(d)}T${hhmm(d)}`, { fuzzy: true, span: null }).noTime = true;
    }

    // ---- 疼痛强度 ----
    let vas = null;
    const numRe = new RegExp(`(${N})\\s*分(?!钟|之)`, 'g');
    for (const [s, e, m] of scan(R, 'num', numRe)) {
      const pre = before(T, s, 1), post = T.slice(e, e + 1);
      if (/[点:：\d.]/.test(pre)) continue;
      if (m[1] === '十' && /[疼痛难不严厉剧的了累]/.test(post)) { vas = { v: 7, fuzzy: true, span: [s, e + 1] }; continue; }
      const v = cnNum(m[1]);
      if (v == null || v > 10) continue;
      vas = { v: Math.round(v), fuzzy: v % 1 !== 0, span: [s, e] };
    }
    for (const [s, e, m] of scan(R, 'num', /(\d+(?:\.\d)?)\s*\/\s*10/)) {
      const v = parseFloat(m[1]);
      if (v <= 10) vas = { v: Math.round(v), fuzzy: false, span: [s, e] };
    }
    for (const [s, e, m] of scan(R, 'num', new RegExp(`(?:强度|程度|评分|打分|疼痛|痛感|VAS|vas|NRS)\\s*(?:是|有|大概|约|在|差不多)?\\s*(${N})(?!\\s*(?:点|小时|分钟|个|天|次|号))`))) {
      const v = cnNum(m[1]);
      if (v != null && v <= 10) vas = { v: Math.round(v), fuzzy: false, span: [s, e] };
    }
    if (!vas) {
      let best = null;
      for (const [lvl, re] of VAS_WORDS) {
        for (const [s, e] of scan(R, 'vasw', re)) {
          if (!inPain(s)) continue;
          if (!best || lvl > best.v) best = { v: lvl, fuzzy: true, span: [s, e] };
        }
      }
      if (!best && mild) best = { v: 3, fuzzy: true, span: [heads[0].s, heads[0].e] };
      vas = best;
    }
    if (vas) R.add('a', 'vas', Math.max(1, vas.v), { fuzzy: vas.fuzzy, span: vas.span });

    // ---- 部位 ----
    for (const c of cls) {
      const pc = painCls.includes(c);
      if (pc && /整个(?:头|脑袋)|全头|满头|整颗头|整个脑子|全部都(?:疼|痛)/.test(c.t)) {
        const j = c.t.search(/整个|全头|满头|整颗|全部/);
        R.add('a', 'region', [...REGION_IDS], { span: [c.s + j, c.s + j + 2] });
        continue;
      }
      let found = false;
      for (const [ids, re] of REGION_SYN) {
        for (const [s, e] of scan(R, 'region', re, c)) {
          found = true;
          const near = SIDE_OF(before(T, s, 4)), side = near || SIDE_OF(c.t);
          const pick = ids.length === 1 ? ids : side === 'L' ? [ids[0]] : side === 'R' ? [ids[1]] : ids;
          R.add('a', 'region', pick, { fuzzy: !pc || (ids.length > 1 && !side), span: [s, e] });
        }
      }
      // 只说了左边 / 右边头疼：先猜太阳穴和耳上方
      const side = SIDE_OF(c.t);
      const prevHead = headClauses.has(cls[cls.indexOf(c) - 1]) && c.t.trim().length <= 6;
      if (!found && side && (headClauses.has(c) || prevHead) && !/[左右]手|[左右]腿|[左右]脚|左右$/.test(c.t)) {
        const j = c.t.search(/左|右|两边|两侧|双侧/);
        const pick = side === 'B' ? ['temple-L', 'temple-R', 'parietal-L', 'parietal-R'] : [`temple-${side}`, `parietal-${side}`];
        R.add('a', 'region', pick, { fuzzy: true, span: [c.s + j, c.s + j + 2] });
      }
    }

    // ---- 性质 / 症状 ----
    for (const [q, re] of QUALITY_SYN) {
      for (const [s, e] of scan(R, 'quality', re)) {
        if (NEG_TAIL.test(before(T, s))) continue;
        // “胀 / 灼 / 发紧”在别处也常见（肚子胀），不在说疼的句子里就只算猜测
        if (!inPain(s) && /^(?:胀|灼|发紧|很紧|好紧)$/.test(T.slice(s, e))) continue;
        R.add('a', 'quality', q, { span: [s, e], fuzzy: !inPain(s) });
      }
    }
    for (const [q, re] of SYMPTOM_SYN) {
      for (const [s, e] of scan(R, 'symptom', re)) {
        if (/吐槽/.test(T.slice(s, s + 2))) continue;
        if (NEG_TAIL.test(before(T, s, 3))) continue;
        R.add('a', 'symptom', q, { span: [s, e] });
      }
    }

    // ---- 持续时间 ----
    const ongoing = T.match(/还在(?:疼|痛)|现在还|到现在|还没好|仍然(?:疼|痛)|还疼|还痛|还有点(?:疼|痛)|一直没好|持续中/);
    if (ongoing) R.add('a', 'duration', 'ongoing', { span: [ongoing.index, ongoing.index + ongoing[0].length] });
    else {
      const hm = new RegExp(`(?:疼|痛|持续|难受|发作)了?\\s*(?:大概|差不多|将近|快|约|整整)?\\s*(${N})\\s*个?\\s*(半)?\\s*(多)?\\s*(小时|钟头)`).exec(T);
      const dm = /(?:疼|痛|持续|难受)了?\s*(?:一|整)?整天|(?:疼|痛|持续)了?\s*一天/.exec(T);
      const multi = /(?:疼|痛|持续)了?\s*(?:两|三|好几|几)天|(?:两|三|好几)天了/.exec(T);
      const half = /半天|一上午|一下午|一晚上|一整晚|一个上午|一个下午/.exec(T);
      const short = new RegExp(`一会儿?就|一下就|没多久就|很快就好|几分钟|(${N})\\s*分钟就`).exec(T);
      if (hm) { const h = hoursOf(hm[1], hm[2], hm[3]); if (h != null) R.add('a', 'duration', durKey(h), { span: [hm.index, hm.index + hm[0].length], fuzzy: !!hm[3] }); }
      else if (multi) R.add('a', 'duration', 'gt24', { span: [multi.index, multi.index + multi[0].length] });
      else if (dm) R.add('a', 'duration', '12-24', { span: [dm.index, dm.index + dm[0].length], fuzzy: true });
      else if (half) R.add('a', 'duration', '4-12', { span: [half.index, half.index + half[0].length], fuzzy: true });
      else if (short) R.add('a', 'duration', 'lt2', { span: [short.index, short.index + short[0].length], fuzzy: true });
    }

    // ---- 诱因 ----
    const custom = (ctx.customTriggers || []).map(t => [t, t.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'), false]);
    for (const [t, re, inherent] of [...TRIGGER_SYN, ...custom]) {
      for (const [s, e] of scan(R, `trig-${t}`, re)) {
        const c = clauseAt(cls, s), i = cls.indexOf(c);
        const cue = CAUSAL.test(c.t) || (i > 0 && /因为|由于|可能是|估计是|应该是/.test(cls[i - 1].t));
        if (!cue && !inherent) continue;
        if (NEG_TAIL.test(before(T, s, 3)) && t !== '漏餐') continue;
        R.add('a', 'trigger', t, { fuzzy: !cue, span: [s, e] });
        break;
      }
    }
  }

  // ---- 药 ----
  parseMeds(R, cls, ctx, hasAttack, headClauses);

  // ---- 睡眠 ----
  parseSleep(R, cls);

  // ---- 三餐 / 饮食 ----
  parseMeals(R, cls);
  parseFoods(R, cls);

  // ---- 运动 ----
  parseExercise(R, cls);

  // ---- 心情 ----
  parseMood(R, cls);

  // ---- 经期 ----
  for (const [s, e] of scan(R, 'period', /(?:月经|大姨妈|姨妈|例假)(?:走了|结束|完了|干净了?)|经期结束|不在经期|没来(?:月经|姨妈|例假)/)) {
    R.add('d', 'period', false, { span: [s, e], date: R.key(clauseAt(cls, s).off) });
  }
  for (const [s, e, m] of scan(R, 'period', /来了?(?:月经|大姨妈|姨妈|例假)|(?:月经|大姨妈|姨妈|例假)(?:来了|期间|中|第\s*[0-9一二三四五六七八九十]+\s*天)|经期第|生理期|来事了|姨妈痛|痛经|经期/)) {
    const pre = before(T, s, 3);
    if (/没|不/.test(pre)) continue;
    R.add('d', 'period', true, { span: [s, e], date: R.key(clauseAt(cls, s).off), fuzzy: /痛经|姨妈痛/.test(m[0]) });
  }
  if (hasAttack) {
    for (const [s, e] of scan(R, 'period', /(?:月经|姨妈|例假)(?:快|要)来|经前|月经前/)) R.add('a', 'trigger', '经期前后', { fuzzy: true, span: [s, e] });
  }

  // 有头痛时，默认把原话存进备注
  if (hasAttack) R.add('a', 'note', text.trim(), {});
  return R;
}

const MED_ANY = new RegExp(`${MED_ALIASES.map(m => m[1]).join('|')}|${GENERIC_MED}|吃.{0,3}药`);

function parseMeds(R, cls, ctx, hasAttack, headClauses) {
  const T = R.text, presets = ctx.meds || [];
  // 用户自己的药（原名）优先；常见别名映射到通用名，再对上用户的药
  const table = [];
  for (const p of presets) table.push([p, p.name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')]);
  for (const [canon, re] of MED_ALIASES) {
    const p = presets.find(x => x.name.includes(canon) || canon.includes(x.name)) || { name: canon, dose: '', kind: 'acute' };
    table.push([p, re]);
  }
  const found = [];
  for (const [p, re] of table) {
    for (const [s, e] of scan(R, 'med', re)) {
      if (NEG_TAIL.test(before(T, s, 4)) && !/吃了/.test(before(T, s, 4))) continue;
      found.push({ s, e, p, generic: false });
    }
  }
  for (const [s, e] of scan(R, 'med', GENERIC_MED)) {
    if (/没|不/.test(before(T, s, 2))) continue;
    const c = clauseAt(cls, s);
    if (found.some(f => clauseAt(cls, f.s) === c)) continue;
    const p = presets.find(x => x.kind !== 'preventive') || { name: '止痛药', dose: '', kind: 'acute' };
    found.push({ s, e, p, generic: true });
  }
  found.sort((a, b) => a.s - b.s);
  const meds = [];
  for (const f of found) {
    const c = clauseAt(cls, f.s), after = T.slice(f.e, Math.min(c.e, f.e + 8)), pre = T.slice(Math.max(c.s, f.s - 6), f.s);
    let dose = f.p.dose || '';
    const mg = new RegExp(`(${N})\\s*(mg|毫克|MG)`).exec(after) || new RegExp(`(${N})\\s*(mg|毫克|MG)`).exec(pre);
    const pcs = new RegExp(`(${N})\\s*(片|粒|颗|袋|包)`).exec(pre + after);
    if (mg) dose = `${cnNum(mg[1])}mg`;
    else if (pcs && cnNum(pcs[1]) > 1) dose = dose ? `${dose} ×${cnNum(pcs[1])}` : `${cnNum(pcs[1])}${pcs[2]}`;
    // 吃药的时间：这句不是在说头痛时才用（否则“三点头疼吃了药”里的三点归头痛）
    let time = null;
    if (!headClauses.has(c)) { const t = findTime(R, c); if (t) time = hhmm(t.at); }
    const it = R.add(hasAttack ? 'a' : 'd', 'med', { name: f.p.name, dose, kind: f.p.kind || 'acute', time, effect: null, relief: null, generic: f.generic }, { span: [f.s, f.e], fuzzy: f.generic, date: hasAttack ? null : R.key(c.off) });
    meds.push({ it, s: f.s, c });
  }
  if (!meds.length) return;
  // 药效：在吃药的这句和后面两句里找“好了 / 好一点 / 没用”，记到前面最近的那种药上；说了好几次时以最后一次为准
  const effects = [];
  for (const [v, re] of EFFECT_SYN) for (const [s, e] of scan(R, 'effect', re)) effects.push({ v, s, e });
  effects.sort((a, b) => a.s - b.s);
  for (const { v, s, e } of effects) {
    {
      const owner = [...meds].reverse().find(m => m.s < s && cls.indexOf(clauseAt(cls, s)) - cls.indexOf(m.c) <= 2);
      if (!owner) continue;
      owner.it.v.effect = v;
      owner.it.spans.push([s, e]);
      if (v > 0) {
        const c = clauseAt(cls, s);
        const rm = new RegExp(`(${N}|半)\\s*个?\\s*(半)?\\s*(多)?\\s*(小时|钟头|分钟)`).exec(T.slice(owner.s, c.e));
        if (rm) {
          const h = rm[4] === '分钟' ? (cnNum(rm[1]) || 0) / 60 : hoursOf(rm[1], rm[2], rm[3]);
          if (h) owner.it.v.relief = nearestRelief(h);
        }
      } else owner.it.v.relief = null;
    }
  }
}

function parseSleep(R, cls) {
  const T = R.text;
  const add = (v, c, span, fuzzy) => {
    // “昨晚睡了 6 小时”记在今天（App 里每天记的是前一晚的睡眠）
    const off = Math.min(0, c.off + 1);
    if (/今晚|今天晚上/.test(c.t) && !/昨/.test(c.t)) return;
    R.add('d', 'sleep', Math.max(0, Math.min(16, Math.round(v * 2) / 2)), { span, fuzzy, date: R.key(off) });
  };
  const hm = new RegExp(`(?:睡了?|睡眠|睡觉)(?:时间)?\\s*(?:只有|大概|差不多|只|才|不到|将近|快|约|有)?\\s*(${N})\\s*个?\\s*(半)?\\s*(多)?\\s*(?:小时|钟头|个钟|钟|h|H)`, 'g');
  for (const [s, e, m] of scan(R, 'sleep', hm)) {
    const v = hoursOf(m[1], m[2], m[3]);
    if (v == null || v > 16) continue;
    const less = /不到/.test(m[0]);
    add(less ? v - 0.5 : v, clauseAt(cls, s), [s, e], less || !!m[3]);
  }
  if (R.items.some(x => x.k === 'sleep')) return;
  // “12 点睡 7 点起” → 算出来
  const bed = new RegExp(`(${N})\\s*点\\s*(半)?\\s*(?:多)?\\s*(?:才|就)?\\s*(?:睡|上床|躺下)`).exec(T);
  const wake = new RegExp(`(${N})\\s*点\\s*(半)?\\s*(?:多)?\\s*(?:就|才)?\\s*(?:起|醒)`).exec(T);
  if (bed && wake) {
    let b = cnNum(bed[1]) + (bed[2] ? 0.5 : 0), w = cnNum(wake[1]) + (wake[2] ? 0.5 : 0);
    if (b != null && w != null) {
      if (b === 12 || b === 24) b = 0;
      else if (b >= 7 && b < 12) b += 12;
      const h = ((w - b) % 24 + 24) % 24;
      if (h > 0 && h <= 14) { add(h, clauseAt(cls, bed.index), [Math.min(bed.index, wake.index), Math.max(bed.index + bed[0].length, wake.index + wake[0].length)], true); return; }
    }
  }
  // 没说时长的说法：先给个大概，用户再调
  const VAGUE = [[1, '通宵|一夜没睡|整晚没睡|一晚上没睡'], [5, '熬夜|没睡好|睡得不好|睡得很差|失眠|睡不着|老醒|半夜醒|睡得少|没睡够|睡眠不足|缺觉|睡得晚|晚睡'], [8, '睡得很好|睡得不错|睡得挺好|睡饱|睡够|睡得香|一觉到天亮|睡得很香'], [10, '睡太多|睡了一整天|睡到中午|睡过头']];
  for (const [v, re] of VAGUE) {
    for (const [s, e] of scan(R, 'sleep', re)) { add(v, clauseAt(cls, s), [s, e], true); return; }
  }
  if (bed) {
    const b = cnNum(bed[1]);
    if (b != null && b >= 1 && b <= 5) add(Math.max(3, 8 - b), clauseAt(cls, bed.index), [bed.index, bed.index + bed[0].length], true);
  }
}

function parseMeals(R, cls) {
  const M = [['b', '早饭|早餐|早点|早上饭'], ['l', '午饭|午餐|中饭|中午饭'], ['d', '晚饭|晚餐|夜饭|晚上饭']];
  const T = R.text;
  const set = (m, ate, s, e, fuzzy = false) => R.add('d', 'meal', { m, ate }, { span: [s, e], date: R.key(clauseAt(cls, s).off), fuzzy });
  for (const [s, e] of scan(R, 'meal', /一天(?:都)?没吃饭|一整天没吃|一天没怎么吃|三餐都没吃/)) for (const [m] of M) set(m, false, s, e);
  for (const [s, e] of scan(R, 'meal', /三餐都吃了|三顿都吃了|按时吃饭|三餐正常|正常吃饭/)) for (const [m] of M) set(m, true, s, e);
  const ANY = M.map(x => x[1]).join('|'), which = w => M.find(([, re]) => new RegExp(`^(?:${re})$`).test(w))[0];
  const LIST = `(?:${ANY})(?:\\s*(?:和|跟|、|还有|与)\\s*(?:${ANY}))*`;
  const each = (s, e, ate) => { for (const w of T.slice(s, e).matchAll(new RegExp(ANY, 'g'))) set(which(w[0]), ate, s + w.index, s + w.index + w[0].length); };
  for (const [s, e] of scan(R, 'meal', `(?:没吃|不吃|跳过|忘了吃|没顾上吃|没来得及吃)${LIST}|${LIST}(?:也|都)?(?:没吃|没顾上|跳过了|省了)`)) each(s, e, false);
  for (const [s, e] of scan(R, 'meal', `(?:吃了|吃过)${LIST}|${LIST}(?:吃了|吃的|吃过|按时吃)`)) each(s, e, true);
  for (const [s, e, x] of scan(R, 'meal', /早上没吃东西|中午没吃东西|晚上没吃东西/)) set({ 早: 'b', 中: 'l', 晚: 'd' }[x[0][0]], false, s, e);
  for (const [s, e, x] of scan(R, 'meal', /(早上|中午|晚上)吃了/)) {
    if (/药|片|粒/.test(T.slice(e, e + 6)) || MED_ANY.test(T.slice(e, e + 6))) continue;
    set({ 早上: 'b', 中午: 'l', 晚上: 'd' }[x[1]], true, s, e, true);
  }
}

const CUP = '杯|瓶|罐|听|碗|块|片|个|根|份|包|袋|盒|串|颗|口|盘';
function parseFoods(R, cls) {
  const T = R.text;
  const hits = [];
  for (const [cat, item, re] of FOOD_SYN) {
    for (const [s, e, m] of scan(R, 'food', re)) hits.push({ cat, item, s, e, word: m[0] });
  }
  hits.sort((a, b) => a.s - b.s);
  let last = null;
  for (const { cat, item, s, e, word } of hits) {
    {
      const pre = before(T, s, 5);
      if (NEG_TAIL.test(pre)) continue;
      const it = item || word;
      // “瑞幸生椰拿铁”：品牌和饮品挨着说的是同一杯
      if (last && last.v.item === it && s - last.e <= 3) {
        const full = T.slice(last.s0, e);
        last.v.note = [full, last.v.qty > 1 ? last.v.note.split(' ').pop() : ''].filter(Boolean).join(' ');
        last.spans.push([last.e, e]);
        last.e = e;
        continue;
      }
      const q = new RegExp(`(${N})\\s*(?:大|小|中)?\\s*(${CUP})\\s*$`).exec(pre);
      const qty = q ? cnNum(q[1]) : 1;
      const note = [word !== it && !/^(?:喝|吃|了|杯|一)/.test(word) ? word : '', qty > 1 ? `${qty}${q[2]}` : ''].filter(Boolean).join(' ');
      last = R.add('d', 'food', { cat, item: it, note, qty: qty || 1 }, { span: [q ? s - q[0].length : s, e], date: R.key(clauseAt(cls, s).off) });
      last.s0 = s; last.e = e;
    }
  }
  // 没认出来的“吃了 / 喝了 X”：放进「未分类」，先猜着
  const STOP = /^(?:饭|东西|药|止痛药|止疼药|早饭|午饭|晚饭|早餐|午餐|晚餐|夜宵|宵夜|口|个|了|的|啥|什么|水|白开水|热水|温水|亏|苦|饱|太多|太少|好多|不少|很多)$/;
  for (const [s, e, m] of scan(R, null, /(?:吃了|喝了|吃的是|喝的是|吃过)([^，,。；;！!？?\s和跟与还就也又再]{1,6})/)) {
    const gs = s + m[0].length - m[1].length;
    for (const part of m[1].split(/、/)) {
      const word = part.replace(new RegExp(`^(?:${N})?\\s*(?:${CUP})?`), '').replace(/^(?:很多|好多|不少|一点儿?|一些|点儿?|些|大量|几)/, '').replace(/[了的啊呀吧呢]+$/, '');
      const ps = T.indexOf(word, gs);
      if (!word || STOP.test(word) || ps < 0 || !R.free('food', ps, ps + word.length) || !R.free('med', ps, ps + word.length) || MED_ANY.test(word)) continue;
      R.take('food', ps, ps + word.length);
      R.add('d', 'food', { cat: UNCAT, item: word, note: '', qty: 1 }, { span: [ps, ps + word.length], date: R.key(clauseAt(cls, s).off), fuzzy: true });
    }
  }
}

function parseExercise(R, cls) {
  const T = R.text;
  for (const [s, e] of scan(R, 'ex', /没(?:有)?(?:运动|锻炼|去健身|健身)|没动|一天没动/)) {
    R.add('d', 'noex', true, { span: [s, e], date: R.key(clauseAt(cls, s).off) });
  }
  const hits = [];
  for (const [cat, item, re] of EX_SYN) {
    for (const [s, e, m] of scan(R, 'ex', re)) {
      if (NEG_TAIL.test(before(T, s, 3))) continue;
      const c = clauseAt(cls, s);
      const it = R.add('d', 'ex', { cat, item: item || m[0], note: item && m[0] !== item && !/了$/.test(m[0]) ? m[0] : '' }, { span: [s, e], date: R.key(c.off), fuzzy: /跑了|游了|健身$/.test(m[0]) });
      hits.push({ it, c, s });
    }
  }
  if (!hits.length) return;
  // 时长和强度：在说运动的那句里找
  const total = {};
  const seen = new Set();
  for (const h of hits) {
    if (seen.has(h.c)) continue;
    seen.add(h.c);
    const t = h.c.t;
    const hm = new RegExp(`(${N}|半)\\s*个?\\s*(半)?\\s*(多)?\\s*(小时|钟头|h|H)(?!\\s*(?:前|以前|之前))`).exec(t);
    const mm = new RegExp(`(${N})\\s*(?:分钟|min)(?!\\s*(?:前|以前|之前))`).exec(t);
    const mins = hm ? hoursOf(hm[1], hm[2], hm[3]) * 60 : mm ? cnNum(mm[1]) : null;
    const km = new RegExp(`(${N})\\s*(?:公里|千米|km|K|k)`).exec(t);
    if (km && !h.it.v.note) h.it.v.note = `${cnNum(km[1])} 公里`;
    if (mins) {
      const sum = Math.min(600, Math.round((total[h.it.date] || 0) + mins)), m0 = hm || mm;
      total[h.it.date] = sum;
      R.items = R.items.filter(x => !(x.k === 'exmin' && x.date === h.it.date));
      R.add('d', 'exmin', sum, { span: [h.c.s + m0.index, h.c.s + m0.index + m0[0].length], date: h.it.date });
    }
    for (const [v, re] of EX_INT) {
      const x = new RegExp(re).exec(t);
      if (x) { R.add('d', 'exint', v, { span: [h.c.s + x.index, h.c.s + x.index + x[0].length], date: h.it.date, fuzzy: true }); break; }
    }
  }
  // 说了运动就不算“没运动”
  R.items = R.items.filter(x => !(x.k === 'noex' && hits.some(h => h.it.date === x.date)));
}

function parseMood(R, cls) {
  const T = R.text;
  const vals = [];
  for (const [v, re] of VALENCE_SYN) {
    for (const [s, e] of scan(R, 'valence', re)) {
      const c = clauseAt(cls, s);
      vals.push({ v, s, e, c });
    }
  }
  vals.sort((a, b) => a.s - b.s);
  const moodCls = new Set(vals.map(x => x.c));
  const feels = [];
  for (const [f, re] of FEEL_SYN) {
    for (const [s, e] of scan(R, 'feel', re)) {
      const pre = before(T, s, 2);
      if (/(?:不|没|没有|别再)$/.test(pre)) continue;
      // “累”很常见：只在说心情 / 状态的句子里，或者带“好 / 很 / 太”时才算
      if (f === '疲惫' && /^(?:累|困)$/.test(T.slice(s, e)) && !/[好很太超特别有点]$/.test(pre) && !moodCls.has(clauseAt(cls, s))) continue;
      // “紧张 / 压力”在说头痛诱因时也会出现，照样记成感受（标为猜测）
      feels.push({ f, s, e, c: clauseAt(cls, s), fuzzy: /^(?:累|困|轻松|紧张|激动|期待)$/.test(T.slice(s, e)) });
    }
  }
  for (const x of feels) moodCls.add(x.c);
  if (!vals.length && !feels.length) return;
  // 愉快程度：取最后一次说的（最接近现在的状态）
  if (vals.length) {
    const last = vals[vals.length - 1];
    R.add('d', 'valence', last.v, { span: [last.s, last.e], date: R.key(last.c.off), fuzzy: new Set(vals.map(x => x.v)).size > 1 });
  }
  for (const x of feels) R.add('d', 'feel', x.f, { span: [x.s, x.e], date: R.key(x.c.off), fuzzy: x.fuzzy });
  if (!vals.length && feels.length) {
    // 只说了感受：按正负面先猜一个愉快程度
    const neg = feels.filter(x => FEELINGS_NEG.includes(x.f)).length, pos = feels.length - neg;
    R.add('d', 'valence', neg && !pos ? 3 : pos && !neg ? 5 : 4, { date: R.key(feels[0].c.off), fuzzy: true });
  }
  // 影响因素：只在说心情的句子及其前后一句里找
  const near = new Set();
  for (const c of moodCls) { const i = cls.indexOf(c); for (const j of [i - 1, i, i + 1]) if (cls[j]) near.add(cls[j]); }
  for (const [f, re] of FACTOR_SYN) {
    for (const [s, e] of scan(R, 'factor', re)) {
      const c = clauseAt(cls, s);
      if (!near.has(c)) continue;
      R.add('d', 'factor', f, { span: [s, e], date: R.key(c.off), fuzzy: !moodCls.has(c) });
      break;
    }
  }
}

// ======================= AI 结果 → 同样的条目 =======================
// AI 只能从给定的选项里选；这里再按 App 的选项过滤一遍，防止出现不认识的值
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
    const vas = Math.round(+H.vas);
    if (vas >= 1 && vas <= 10) R.add('a', 'vas', vas, { fuzzy: unsure.has('vas') });
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
    case 'vas': return `疼痛 ${v}/10`;
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
