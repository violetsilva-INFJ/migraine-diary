// 头部示意图：现代可爱风的小女孩 / 小男孩，四个视角：正面（镜像，屏幕左边 = 自己的左边）、左侧、右侧、背面。
// 扁平色块，没有描边；可点区域是透明的，选中后在对应位置晕染一层柔和的珊瑚色。
import { REGIONS } from './util.js';

const W = 240;

// 绝对坐标路径的水平镜像
function mirror(d) {
  const tok = d.match(/[a-zA-Z]|-?\d*\.?\d+/g), out = [];
  const arity = { M: 2, L: 2, C: 6, Q: 4, S: 4, T: 2, H: 1, V: 1, A: 7, Z: 0 };
  let cmd = '', k = 0;
  for (const t of tok) {
    if (/[a-zA-Z]/.test(t)) { cmd = t; k = 0; out.push(t); continue; }
    const n = arity[cmd], pos = k++ % n;
    let v = +t;
    if (cmd === 'H' || ('MLCQST'.includes(cmd) && pos % 2 === 0) || (cmd === 'A' && pos === 5)) v = W - v;
    if (cmd === 'A' && pos === 4) v = 1 - v;
    out.push(+v.toFixed(2));
  }
  return out.join(' ');
}
const ell = (cx, cy, rx, ry) => `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
const pair = (cls, d) => [[cls, d], [cls, mirror(d)]];

// ---------------- 头部几何 ----------------
const HEAD = ell(120, 118, 74, 68);
const HEAD_P = HEAD + ell(186, 132, 8, 8);
const NECK = 'M106 176H134V214H106Z';

const HALF_L = 'M0 0H120V300H0Z', HALF_R = 'M120 0H240V300H120Z';
const T_L = 'M0 66C24 66 52 70 70 76C66 100 66 124 70 148C48 150 24 152 0 152Z';
const E_L = 'M70 112C84 106 108 106 120 110V150C108 154 84 154 70 150C66 138 66 124 70 112Z';
const F_L = 'M64 40H120V110C108 106 84 106 70 112C68 92 64 66 64 40Z';
const P_L = 'M0 60C26 62 54 66 74 74C68 96 68 120 74 142C50 146 24 148 0 148Z';

const REG = {
  front: [
    ['face-L', HALF_L], ['face-R', HALF_R], ['temple-L', T_L], ['temple-R', mirror(T_L)],
    ['eye-L', E_L], ['eye-R', mirror(E_L)], ['forehead-L', F_L], ['forehead-R', mirror(F_L)],
    ['vertex', 'M0 0H240V74C204 60 164 54 120 54C76 54 36 60 0 74Z'],
  ],
  profile: S => [
    [`face-${S}`, 'M122 134H240V240H122Z'],
    [`occiput-${S}`, 'M0 0H90C88 60 86 130 94 240H0Z'],
    [`parietal-${S}`, 'M86 54H140V110C126 106 110 106 96 112C92 92 88 72 86 54Z'],
    [`forehead-${S}`, 'M138 48H240V108H138Z'],
    [`temple-${S}`, 'M126 90H146C144 104 144 120 148 134H126C124 120 124 104 126 90Z'],
    [`eye-${S}`, 'M144 108C156 104 176 104 190 110L192 142C178 148 158 148 144 144C142 132 142 120 144 108Z'],
    ['vertex', 'M0 0H240V66C200 58 160 56 120 58C90 60 60 66 30 80L0 94Z'],
  ],
  profileNeck: S => [[`neck-${S}`, 'M40 160H120V300H40Z']],
  back: [
    ['occiput-L', HALF_L], ['occiput-R', HALF_R], ['parietal-L', P_L], ['parietal-R', mirror(P_L)],
    ['vertex', 'M0 0H240V84C204 66 164 58 120 58C76 58 36 66 0 84Z'],
  ],
  backNeck: [['neck-L', HALF_L], ['neck-R', HALF_R]],
};

// ---------------- 角色 ----------------
// 每层：[类名, 路径]。under 画在晕染之下，over（五官、腮红）画在晕染之上
const FACE_FRONT = [
  ['ink', ell(94, 132, 6.5, 8)], ['ink', ell(146, 132, 6.5, 8)],
  ['shine', ell(96.2, 128.5, 2.2, 2.2)], ['shine', ell(148.2, 128.5, 2.2, 2.2)],
  ['blush', ell(78, 150, 11, 6.5)], ['blush', ell(162, 150, 11, 6.5)],
  ['mouth', 'M113 152C116.5 156.5 123.5 156.5 127 152'],
];
const FACE_SIDE = [
  ['ink', ell(166, 130, 5.5, 7.5)], ['shine', ell(167.8, 127, 1.9, 1.9)],
  ['blush', ell(158, 150, 10, 6)], ['mouth', 'M174 156C177 158.5 181 158 183 155'],
];
const EARS_FRONT = [['skin', ell(48, 132, 12, 13)], ['skin', ell(192, 132, 12, 13)], ['skin-d', ell(49, 132, 6, 7)], ['skin-d', ell(191, 132, 6, 7)]];
const EAR_SIDE = [['skin', ell(110, 134, 11, 14)], ['skin-d', 'M112 126C106 127 104 133 106 139C107 142 110 143 112 141']];
const EARS_BACK = [['skin', ell(46, 130, 12, 13)], ['skin', ell(194, 130, 12, 13)]];
const BODY = 'M58 300C58 240 84 208 120 208C156 208 182 240 182 300Z';
const BODY_SIDE = 'M66 300C66 242 88 208 116 208C144 208 166 242 166 300Z';

const KIDS = {
  female: {
    front: {
      under: [
        ['cloth', BODY], ...pair('white', 'M120 212C110 210 98 214 95 223C101 231 114 231 120 220Z'),
        ['skin', NECK],
        ['hair', 'M40 120C40 70 76 40 120 40C164 40 200 70 200 120V180C200 192 190 198 178 194H62C50 198 40 192 40 180Z'],
        ['hair', ell(120, 34, 18, 16)], ['tie', 'M106 46C112 50 128 50 134 46L132 52C126 55 114 55 108 52Z'],
        ...EARS_FRONT, ['skin', HEAD],
        ['hair', 'M46 118C46 72 80 46 120 46C160 46 194 72 194 118C188 106 178 98 166 96C160 104 148 108 136 104C128 110 112 110 104 104C92 108 80 106 74 98C62 102 52 108 46 118Z'],
      ],
      over: FACE_FRONT,
    },
    profile: {
      under: [
        ['cloth', BODY_SIDE], ['white', 'M116 212C126 210 140 214 144 222C138 230 124 230 116 220Z'],
        ['skin', NECK],
        ['hair', 'M44 118C44 70 76 44 118 44C152 44 176 62 184 92C170 88 156 92 148 100C138 106 128 106 120 104C114 112 112 122 114 132V182C114 192 106 198 96 198H64C52 198 44 190 44 178Z'],
        ['hair', ell(98, 40, 17, 15)], ['tie', 'M86 50C92 55 106 55 112 50L111 56C105 60 93 60 87 56Z'],
        ['skin', HEAD_P],
        ['hair', 'M44 118C44 70 76 46 118 46C152 46 176 64 184 92C170 88 156 92 148 100C138 106 128 106 120 106C110 110 102 120 100 134C98 150 100 168 104 186C90 186 72 182 60 170C50 158 44 140 44 118Z'],
        ...EAR_SIDE,
      ],
      over: FACE_SIDE,
    },
    back: {
      under: [
        ['cloth', BODY], ['skin', NECK], ...EARS_BACK, ['skin', HEAD],
        ['hair', 'M44 120C44 70 78 42 120 42C162 42 196 70 196 120V180C196 192 186 198 174 196H66C54 198 44 192 44 180Z'],
        ['hair', ell(120, 34, 18, 16)], ['tie', 'M106 46C112 50 128 50 134 46L132 52C126 55 114 55 108 52Z'],
      ],
      over: [['hair-line', 'M120 56V188'], ['hair-line', 'M96 60C88 100 88 150 94 188'], ['hair-line', 'M144 60C152 100 152 150 146 188']],
    },
  },
  male: {
    front: {
      under: [
        ['coat', BODY], ['coat-d', 'M90 214C94 204 106 198 120 198C134 198 146 204 150 214C140 210 100 210 90 214Z'],
        ['skin', NECK],
        ...EARS_FRONT, ['skin', HEAD],
        ['hair', 'M44 118C42 70 78 42 122 42C166 42 198 70 196 118C190 108 182 100 172 96C168 104 160 106 152 102C140 96 120 92 100 96C88 98 76 104 68 106C58 108 50 112 44 118Z'],
        ['hair', 'M114 44C110 32 118 22 130 24C123 29 123 37 128 44Z'],
      ],
      over: [...FACE_FRONT, ['string', 'M112 216V240'], ['string', 'M128 216V240'], ['shine', ell(112, 242, 2.6, 2.6)], ['shine', ell(128, 242, 2.6, 2.6)]],
    },
    profile: {
      under: [
        ['coat', BODY_SIDE], ['coat-d', 'M88 220C90 206 100 198 112 198C124 198 132 204 136 214C122 210 100 212 88 220Z'],
        ['skin', NECK], ['skin', HEAD_P],
        ['hair', 'M46 120C44 72 78 44 120 44C152 44 174 60 182 90C174 88 166 90 160 96C150 102 140 102 132 100C124 104 116 110 108 116C100 124 98 140 100 156C101 166 100 174 96 182C82 180 66 170 56 156C49 146 46 134 46 120Z'],
        ['hair', 'M112 46C108 34 116 24 128 26C121 31 121 39 126 46Z'],
        ...EAR_SIDE,
      ],
      over: FACE_SIDE,
    },
    back: {
      under: [
        ['coat', BODY], ['coat-d', 'M84 222C86 206 102 196 120 196C138 196 154 206 156 222C142 214 98 214 84 222Z'],
        ['skin', NECK], ...EARS_BACK, ['skin', HEAD],
        ['hair', 'M46 122C46 72 80 42 120 42C160 42 194 72 194 122C194 150 182 172 160 182C148 186 134 188 120 188C106 188 92 186 80 182C58 172 46 150 46 122Z'],
        ['hair', 'M114 44C110 32 118 22 130 24C123 29 123 37 128 44Z'],
      ],
      over: [['hair-line', 'M120 52C116 64 116 76 122 86']],
    },
  },
};

export const VIEWS = [['front', '正面'], ['left', '左侧'], ['right', '右侧'], ['back', '背面']];
export const VIEW_REGIONS = {
  front: ['vertex', 'forehead-L', 'forehead-R', 'temple-L', 'temple-R', 'eye-L', 'eye-R', 'face-L', 'face-R'],
  left: ['vertex', 'forehead-L', 'temple-L', 'eye-L', 'face-L', 'parietal-L', 'occiput-L', 'neck-L'],
  right: ['vertex', 'forehead-R', 'temple-R', 'eye-R', 'face-R', 'parietal-R', 'occiput-R', 'neck-R'],
  back: ['vertex', 'parietal-L', 'parietal-R', 'occiput-L', 'occiput-R', 'neck-L', 'neck-R'],
};

let n = 0;

export function headSVG(view, { sex = 'female', on = new Set(), heat = null, interactive = false } = {}) {
  const id = `hm${++n}`, kid = KIDS[sex] || KIDS.female;
  const side = view === 'left' ? 'L' : 'R', profile = view === 'left' || view === 'right';
  const art = kid[profile ? 'profile' : view];
  const head = profile ? HEAD_P : HEAD;
  const regs = profile ? REG.profile(side) : REG[view];
  const neckRegs = profile ? REG.profileNeck(side) : view === 'back' ? REG.backNeck : [];

  // 晕染：选中区域或热力，统一轻微模糊，边缘柔和
  const tint = ([rid, d]) => {
    const t = heat ? (heat[rid] || 0) : on.has(rid) ? 1 : 0;
    return t > 0 ? `<path d="${d}" style="opacity:${heat ? (0.2 + 0.7 * t).toFixed(2) : 1}"/>` : '';
  };
  const wash = (list, clip) => {
    const inner = list.map(tint).join('');
    return inner ? `<g clip-path="url(#${id}-${clip})"><g class="wash" filter="url(#${id}-b)">${inner}</g></g>` : '';
  };
  const hit = ([rid, d]) => {
    const label = REGIONS[rid].label + (heat ? ` ${Math.round((heat[rid] || 0) * 100)}%` : '');
    return interactive
      ? `<path class="hit" d="${d}" data-act="region" data-id="${rid}" role="button" tabindex="0" aria-pressed="${on.has(rid)}" aria-label="${label}"/>`
      : `<path class="hit" d="${d}" role="img" aria-label="${label}"/>`;
  };
  const layer = list => list.map(([c, d]) => `<path class="k-${c}" d="${d}"/>`).join('');
  const flip = view === 'left' ? ' transform="matrix(-1 0 0 1 240 0)"' : '';
  const sides = profile ? '' : `<g class="side-tags"><rect x="10" y="12" width="22" height="17" rx="8.5"/><text x="21" y="24.5">左</text>
    <rect x="208" y="12" width="22" height="17" rx="8.5"/><text x="219" y="24.5">右</text></g>`;

  return `<svg viewBox="0 0 240 300" class="head kid-${KIDS[sex] ? sex : 'female'} ${interactive ? 'interactive' : ''}" role="group" aria-label="头部${VIEWS.find(v => v[0] === view)[1]}">
    <defs>
      <clipPath id="${id}-h"><path d="${head}"/></clipPath>
      <clipPath id="${id}-n"><path d="${NECK}"/></clipPath>
      <filter id="${id}-b" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2.5"/></filter>
    </defs>
    <circle class="medal" cx="120" cy="128" r="104"/>
    <g${flip}>
      ${layer(art.under)}
      ${wash(regs, 'h')}${wash(neckRegs, 'n')}
      ${layer(art.over)}
      ${neckRegs.length ? `<g clip-path="url(#${id}-n)">${neckRegs.map(hit).join('')}</g>` : ''}
      <g clip-path="url(#${id}-h)">${regs.map(hit).join('')}</g>
    </g>
    ${sides}
  </svg>`;
}
