// 可选：用用户自己的 AI 服务理解一段话，返回和本地识别同样结构的 JSON（再由 parse.js 的 fromAI 过滤）。
// 只在用户开启并填好密钥时使用；发送的只有输入的那段话和选项清单，不含任何已有记录。
import {
  REGIONS, REGION_IDS, QUALITIES, SYMPTOMS, DURATIONS, TRIGGERS, FOOD_CATALOG, EXERCISE_CATALOG,
  MOOD, FEELINGS_NEG, FEELINGS_POS, MOOD_FACTORS, UNCAT, WEEK, dkey, hhmm,
} from './util.js';

export const AI_PRESETS = {
  claude: { label: 'Claude', kind: 'anthropic', url: 'https://api.anthropic.com', model: 'claude-opus-5-5', hint: '在 console.anthropic.com 创建 API 密钥。需要能访问 Anthropic 的网络。' },
  deepseek: { label: 'DeepSeek', kind: 'openai', url: 'https://api.deepseek.com', model: 'deepseek-chat', hint: '在 platform.deepseek.com 创建 API 密钥。' },
  qwen: { label: '通义千问', kind: 'openai', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', hint: '在阿里云百炼控制台创建 API Key。' },
  custom: { label: '其他', kind: 'openai', url: '', model: '', hint: '兼容 OpenAI 接口的服务：填地址（通常以 /v1 结尾）和模型名。服务需要允许网页直接调用，否则会提示连不上。' },
};
// 合成当前使用的配置（每个服务的密钥分开保存，切换服务不会丢）
export function aiConf(ai) {
  const P = AI_PRESETS[ai?.preset];
  if (!P) return null;
  const c = ai.cfg?.[ai.preset] || {};
  return { kind: P.kind, label: P.label, url: (c.url ?? P.url).trim(), key: (c.key || '').trim(), model: (c.model ?? P.model).trim() };
}
export const aiReady = c => !!(c && c.key && c.url && c.model);

// ---------- 输出结构 ----------
const nul = t => ({ anyOf: [t, { type: 'null' }] });
const strs = list => ({ type: 'array', items: { type: 'string', enum: list } });
const obj = props => ({ type: 'object', additionalProperties: false, required: Object.keys(props), properties: props });
const MED = obj({
  name: { type: 'string' }, dose: nul({ type: 'string' }), time: nul({ type: 'string' }),
  effect: nul({ type: 'integer', enum: [0, 1, 2] }), relief_hours: nul({ type: 'number' }),
});
const LOG = cats => ({ type: 'array', items: obj({ category: { type: 'string', enum: [...cats, UNCAT] }, item: { type: 'string' }, note: nul({ type: 'string' }), quantity: nul({ type: 'integer' }) }) });
const UNSURE = ['start', 'vas', 'regions', 'qualities', 'symptoms', 'duration', 'triggers', 'meds', 'sleep', 'meals', 'foods', 'exercises', 'exercise_minutes', 'exercise_intensity', 'mood', 'period'];
export const SCHEMA = obj({
  headache: obj({
    present: { type: 'boolean' },
    start_day_offset: nul({ type: 'integer' }),
    start_time: nul({ type: 'string' }),
    vas: nul({ type: 'integer' }),
    vas_phrase: nul({ type: 'string' }),
    vas_comparison: nul(obj({ reference: { type: 'string', enum: ['yesterday', 'day_before', 'last', 'usual', 'before_meds'] }, change: { type: 'integer', enum: [-3, -2, -1, 0, 1, 2, 3] } })),
    regions: strs(REGION_IDS),
    qualities: strs(QUALITIES),
    symptoms: strs(SYMPTOMS),
    duration: nul({ type: 'string', enum: DURATIONS.map(d => d.k) }),
    triggers: { type: 'array', items: { type: 'string' } },
    meds: { type: 'array', items: MED },
  }),
  no_headache_today: { type: 'boolean' },
  meds_without_headache: { type: 'array', items: MED },
  days: {
    type: 'array', items: obj({
      day_offset: { type: 'integer' },
      sleep_hours: nul({ type: 'number' }),
      meals: obj({ breakfast: nul({ type: 'boolean' }), lunch: nul({ type: 'boolean' }), dinner: nul({ type: 'boolean' }) }),
      foods: LOG(FOOD_CATALOG.map(c => c.cat)),
      exercises: LOG(EXERCISE_CATALOG.map(c => c.cat)),
      exercise_minutes: nul({ type: 'integer' }),
      exercise_intensity: nul({ type: 'integer', enum: [1, 2, 3] }),
      no_exercise: { type: 'boolean' },
      mood_valence: nul({ type: 'integer', enum: [1, 2, 3, 4, 5, 6, 7] }),
      feelings: strs([...FEELINGS_NEG, ...FEELINGS_POS]),
      mood_factors: strs(MOOD_FACTORS),
      period: nul({ type: 'boolean' }),
    }),
  },
  uncertain: strs(UNSURE),
});

function systemPrompt(ctx) {
  const now = ctx.now || new Date();
  const meds = (ctx.meds || []).map(m => m.name).join('、') || '（无）';
  const cat = list => list.map(c => `${c.cat}：${c.items.join('、')}`).join('；');
  return `你是偏头痛日记 App 的录入助手。用户会用口语描述头痛和当天的情况，常常是语音转文字，可能有错别字、没有标点。请把内容对应到 App 里的选项，按给定结构输出 JSON。

现在是 ${dkey(now)} 周${WEEK[now.getDay()]} ${hhmm(now)}。日期一律用相对今天的天数：今天 0，昨天 -1，前天 -2。

规则：
- 宽松理解口语和模糊的说法（如“脑壳疼”“一跳一跳的”“疼得想撞墙”“姨妈来了”），但不要编造没提到的内容。拿不准的照样填上最可能的选项，并把对应字段名放进 uncertain。没提到的字段填 null 或空数组。
- headache.present：这段话里有一次头痛发作时为 true。start_day_offset 和 start_time（24 小时制 HH:MM）是开始时间；只说“早上 / 下午”这类时，取一个代表时间并标记 start。
- vas：疼痛强度 1–10。用户很少直接说分数，多半是“有点疼”“比较痛”“疼得受不了”这类说法。说了分数就用；只有文字描述时按 一点点≈2、有点/轻微≈3、有些疼≈4、挺疼/比较痛≈5、比较严重≈6、很疼≈7、疼得不行≈8、疼得受不了≈9 估计，把描述强度的原话放进 vas_phrase，并标记 vas。
- 用户拿别的时候做比较时（比昨天轻一点、没有上次那么疼、跟平时差不多、比吃药前好点了），不要自己猜分数：vas_comparison 填 reference（yesterday=昨天，day_before=前天，last=上一次头痛，usual=平时，before_meds=这次吃药前或更早的时候）和 change（轻一点 -1，轻很多 -2，重一点 1，重很多 2，差不多 0），原话放进 vas_phrase，vas 填 null（除非她同时说了具体分数）。App 会用她自己的记录换算。
- regions 只能用这些 id：${REGION_IDS.map(id => `${id}=${REGIONS[id].label}`).join('，')}。只说“左边 / 右边头疼”时选那一侧的太阳穴和耳上方并标记 regions；成对部位没说哪一侧就两侧都选。“整个头”选全部。
- qualities 只能选：${QUALITIES.join('、')}。symptoms 只能选：${SYMPTOMS.join('、')}。
- duration：lt2=不到2小时，2-4，4-12，12-24，gt24=超过24小时，ongoing=现在还在疼。
- triggers 只记用户认为可能导致头痛的原因，优先用这些说法：${[...TRIGGERS, ...(ctx.customTriggers || [])].join('、')}；其他原因用不超过 6 个字的中文。
- 药物 name 尽量写成用户常用药里的名字：${meds}（品牌名换成对应的药，如 芬必得→布洛芬）。effect：0 无效，1 部分缓解，2 完全缓解；relief_hours 是吃药后多久开始缓解。和这次头痛无关的用药放进 meds_without_headache。
- 每个提到的日期在 days 里写一项。睡眠记在醒来的那天：“昨晚睡了 6 小时”是 day_offset 0 的 sleep_hours 6。
- meals：明确说吃了为 true，说没吃为 false，没提到为 null。
- foods：category 从 ${FOOD_CATALOG.map(c => c.cat).join('、')} 里选，item 优先用这些项目（${cat(FOOD_CATALOG)}），具体说法放进 note（如 拿铁、三分糖）；实在归不了类的 category 填“${UNCAT}”。quantity 是杯数或份数。
- exercises：category 从 ${EXERCISE_CATALOG.map(c => c.cat).join('、')} 里选，item 优先用（${cat(EXERCISE_CATALOG)}）。exercise_minutes 是这天运动的总分钟数；exercise_intensity：1 轻松，2 适中，3 剧烈。明确说没运动时 no_exercise 为 true。
- mood_valence：1–7，依次是 ${MOOD.join('、')}。feelings 只能选：${[...FEELINGS_NEG, ...FEELINGS_POS].join('、')}。mood_factors 只能选：${MOOD_FACTORS.join('、')}。只说了疼、没说心情时不要填心情。
- period：说在经期或来月经为 true，说经期结束或没来为 false，没提到为 null。
- no_headache_today：明确说今天没有头痛时为 true。`;
}

// OpenAI 兼容接口没有结构约束，用一个示例告诉它字段
const JSON_HINT = `

只输出一个 JSON 对象，不要其他文字。结构示例（字段都要有，没提到的用 null 或空数组）：
{"headache":{"present":true,"start_day_offset":0,"start_time":"15:00","vas":null,"vas_phrase":"比昨天轻一点","vas_comparison":{"reference":"yesterday","change":-1},"regions":["temple-L"],"qualities":["跳痛 / 搏动感"],"symptoms":["恶心"],"duration":"ongoing","triggers":["睡眠不足"],"meds":[{"name":"布洛芬","dose":null,"time":"15:30","effect":1,"relief_hours":1}]},"no_headache_today":false,"meds_without_headache":[],"days":[{"day_offset":0,"sleep_hours":5,"meals":{"breakfast":false,"lunch":true,"dinner":null},"foods":[{"category":"饮品","item":"奶茶","note":null,"quantity":1}],"exercises":[],"exercise_minutes":null,"exercise_intensity":null,"no_exercise":false,"mood_valence":3,"feelings":["疲惫"],"mood_factors":["工作"],"period":null}],"uncertain":["vas"]}`;

// ---------- 调用 ----------
// Claude：用官方 SDK（按需从 CDN 加载固定版本，只有选了 Claude 才会下载）
const SDK_URL = 'https://esm.sh/@anthropic-ai/sdk@1.3.0';
let sdkPromise = null;
const loadSDK = () => (sdkPromise ||= import(SDK_URL).then(m => m.default).catch(e => { sdkPromise = null; throw e; }));
// 支持 effort / 拒答回退的新模型
const NEW_CLAUDE = /^claude-(?:opus-5|sonnet-5|haiku-5|fable-5|opus-4-[678]|sonnet-4-6)/;
const FALLBACK_OK = /^claude-(?:opus-5|sonnet-5-5|fable-5-1)/;

async function callClaude(c, system, text, signal) {
  let Anthropic;
  try { Anthropic = await loadSDK(); } catch { throw new Error('加载 Claude 组件失败，请检查网络'); }
  const client = new Anthropic({ apiKey: c.key, baseURL: c.url || undefined, dangerouslyAllowBrowser: true, maxRetries: 1, timeout: 60000 });
  const params = {
    model: c.model, max_tokens: 16000, system,
    messages: [{ role: 'user', content: text }],
    output_config: { ...(NEW_CLAUDE.test(c.model) ? { effort: 'low' } : {}), format: { type: 'json_schema', schema: SCHEMA } },
  };
  let res;
  try {
    // 模型因安全规则拒答时，由服务端自动换一个模型重试
    res = FALLBACK_OK.test(c.model)
      ? await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, { signal })
      : await client.messages.create(params, { signal });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error('密钥不对，请检查');
    if (e instanceof Anthropic.PermissionDeniedError) throw new Error('这个密钥没有权限使用该模型');
    if (e instanceof Anthropic.NotFoundError) throw new Error('模型名不对，请检查');
    if (e instanceof Anthropic.RateLimitError) throw new Error('请求太频繁或额度不足，稍后再试');
    if (e instanceof Anthropic.APIConnectionTimeoutError) throw new Error('等太久没有回应，请稍后再试');
    if (e instanceof Anthropic.APIConnectionError) throw new Error('连不上 Claude，请检查网络');
    if (e instanceof Anthropic.APIUserAbortError) throw new Error('等太久没有回应，请稍后再试');
    if (e instanceof Anthropic.APIError) {
      const msg = e.error?.error?.message;
      throw new Error(`Claude 返回错误（${e.status ?? '未知'}）${msg ? '：' + String(msg).slice(0, 120) : ''}`);
    }
    throw e;
  }
  if (res.stop_reason === 'refusal') throw new Error('AI 没有处理这段话，已改用本地识别');
  if (res.stop_reason === 'max_tokens') throw new Error('AI 的回答被截断了，请把话分成两段再试');
  return JSON.parse(res.content.filter(b => b.type === 'text').map(b => b.text).join(''));
}

function httpError(status, body) {
  let msg = '';
  try { const j = JSON.parse(body); msg = j.error?.message || j.message || ''; } catch { msg = /</.test(body) ? '' : body; }
  if (status === 401 || status === 403) return new Error('密钥不对或没有权限，请检查');
  if (status === 402) return new Error('账户余额不足');
  if (status === 404) return new Error('接口地址或模型名不对，请检查');
  if (status === 429) return new Error('请求太频繁或额度不足，稍后再试');
  return new Error(`服务返回错误（${status}）${msg ? '：' + String(msg).slice(0, 120) : ''}`);
}
const looseJSON = s => {
  const m = String(s || '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('AI 没有返回可用的结果');
  return JSON.parse(m[0]);
};

async function callOpenAI(c, system, text, signal) {
  const base = c.url.replace(/\/+$/, '');
  const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
  const body = { model: c.model, messages: [{ role: 'system', content: system + JSON_HINT }, { role: 'user', content: text }], response_format: { type: 'json_object' } };
  const send = () => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.key}` }, body: JSON.stringify(body), signal });
  let res;
  try {
    res = await send();
    // 个别服务不支持 JSON 模式：去掉再试一次
    if (res.status === 400) {
      const t = await res.text();
      if (!/response_format|json_object|json mode/i.test(t)) throw httpError(400, t);
      delete body.response_format;
      res = await send();
    }
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('等太久没有回应，请稍后再试');
    if (e instanceof TypeError) throw new Error('连不上这个服务：网络问题，或它不允许网页直接调用');
    throw e;
  }
  if (!res.ok) throw httpError(res.status, await res.text());
  const data = await res.json();
  return looseJSON(data?.choices?.[0]?.message?.content);
}

// 返回 AI 给出的 JSON（未过滤）；出错时抛出带中文说明的 Error
export async function aiParse(c, text, ctx) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 60000);
  try {
    const system = systemPrompt(ctx);
    return c.kind === 'anthropic' ? await callClaude(c, system, text, ctl.signal) : await callOpenAI(c, system, text, ctl.signal);
  } catch (e) {
    if (e instanceof SyntaxError) throw new Error('AI 返回的内容格式不对');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
