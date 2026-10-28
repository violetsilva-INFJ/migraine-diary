// 头部示意图：正面（镜像，屏幕左边 = 自己的左边）和背面，区域可点选或显示热力
// 区域按顺序叠放：后画的盖住先画的，每块区域用卡片底色描边形成缝隙，所以边界是平滑曲线。
import { REGIONS } from './util.js';

const FRONT_HEAD = 'M100 18C138 18 164 46 166 86C167 104 165 118 162 130C158 156 146 176 128 188C118 195 109 198 100 198C91 198 82 195 72 188C54 176 42 156 38 130C35 118 33 104 34 86C36 46 62 18 100 18Z';
const BACK_HEAD = 'M100 18C138 18 166 46 166 90C166 128 150 164 126 180C116 186 108 188 100 188C92 188 84 186 74 180C50 164 34 128 34 90C34 46 62 18 100 18Z';
const SHOULDERS = 'M20 240C26 221 50 211 79 207Q100 213 121 207C150 211 174 221 180 240Z';
const NECK = 'M80 168V210Q100 219 120 210V168Z';
const EARS = ['M37 98C27 95 21 104 22 116C23 128 29 138 38 137Z', 'M163 98C173 95 179 104 178 116C177 128 171 138 162 137Z'];
const EAR_IN = ['M33 106C28.5 109 28 117 30.5 125', 'M167 106C171.5 109 172 117 169.5 125'];

const CAP = 'M0 0H200V72C170 54 136 46 100 46C64 46 30 54 0 72Z';
const LEFT = 'M0 0H100V240H0Z', RIGHT = 'M100 0H200V240H100Z';

const FRONT = [
  ['face-L', LEFT], ['face-R', RIGHT],
  ['temple-L', 'M0 48C24 48 52 50 64 56C60 80 60 104 66 128C44 132 20 134 0 134Z'],
  ['temple-R', 'M200 48C176 48 148 50 136 56C140 80 140 104 134 128C156 132 180 134 200 134Z'],
  ['eye-L', 'M64 88C72 83 92 83 100 87V123C92 127 72 127 64 122C60 110 60 100 64 88Z'],
  ['eye-R', 'M136 88C128 83 108 83 100 87V123C108 127 128 127 136 122C140 110 140 100 136 88Z'],
  ['forehead-L', 'M58 26H100V87C92 83 72 83 64 88C60 74 58 56 58 26Z'],
  ['forehead-R', 'M142 26H100V87C108 83 128 83 136 88C140 74 142 56 142 26Z'],
  ['vertex', CAP],
];
const BACK_NECK = [
  ['neck-L', 'M80 166V210Q90 217 100 217V166Z'],
  ['neck-R', 'M120 166V210Q110 217 100 217V166Z'],
];
const BACK = [['occiput-L', LEFT], ['occiput-R', RIGHT], ['vertex', CAP]];

// 安静闭眼的面部线条
const FACE = [
  'M70 93Q81 87.5 92 91', 'M108 91Q119 87.5 130 93',
  'M71 106.5Q81 112 91 106.5', 'M109 106.5Q119 112 129 106.5',
  'M100 113C99 122 96.5 128.5 94.5 132.5Q100 136 105.5 132.5',
  'M89 160Q100 165.5 111 160',
];
const NAPE = 'M74 170Q100 181 126 170';

let n = 0;

export function headSVG(view, { on = new Set(), heat = null, interactive = false } = {}) {
  const id = `hm${++n}`, front = view === 'front';
  const head = front ? FRONT_HEAD : BACK_HEAD;
  const region = ([rid, d]) => {
    const sel = on.has(rid), t = heat ? (heat[rid] || 0) : 0;
    const label = REGIONS[rid].label + (heat ? ` ${Math.round(t * 100)}%` : '');
    const attrs = interactive
      ? `data-act="region" data-id="${rid}" role="button" tabindex="0" aria-pressed="${sel}" aria-label="${label}"`
      : `role="img" aria-label="${label}"`;
    return `<path class="region ${sel ? 'on' : ''}" d="${d}" ${sel ? `style="fill:url(#${id}-p)"` : ''} ${attrs}/>`
      + (t > 0 ? `<path class="heat" d="${d}" style="fill:url(#${id}-p);fill-opacity:${(0.16 + 0.84 * t).toFixed(2)}"/>` : '');
  };
  return `<svg viewBox="14 6 172 234" class="head ${interactive ? 'interactive' : ''}" role="group" aria-label="${front ? '头部正面（镜像）' : '头部背面'}">
    <defs>
      <clipPath id="${id}-h"><path d="${head}"/></clipPath>
      <clipPath id="${id}-n"><path d="${NECK}"/></clipPath>
      <linearGradient id="${id}-p" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--pain-hi)"/><stop offset="1" style="stop-color:var(--pain)"/></linearGradient>
      <radialGradient id="${id}-s" cx=".32" cy=".2" r=".8"><stop offset="0" stop-color="#fff" stop-opacity=".75"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/></radialGradient>
      <linearGradient id="${id}-d" x1="0" y1="0" x2="0" y2="1"><stop offset=".55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".07"/></linearGradient>
    </defs>
    <path class="base" d="${SHOULDERS}"/>
    ${front ? `<path class="base" d="${NECK}"/>` : `<g clip-path="url(#${id}-n)">${BACK_NECK.map(region).join('')}</g>`}
    ${EARS.map(d => `<path class="base" d="${d}"/>`).join('')}
    ${front ? EAR_IN.map(d => `<path class="ear-in" d="${d}"/>`).join('') : ''}
    <g clip-path="url(#${id}-h)">
      ${(front ? FRONT : BACK).map(region).join('')}
      <path class="sheen" d="${head}" fill="url(#${id}-s)"/>
      <path d="${head}" fill="url(#${id}-d)" pointer-events="none"/>
    </g>
    <path class="outline" d="${head}"/>
    ${front ? FACE.map(d => `<path class="feat" d="${d}"/>`).join('') : `<path class="feat" d="${NAPE}" style="opacity:.6"/>`}
    <rect class="side-bg" x="16" y="8" width="20" height="17" rx="8.5"/><text class="side" x="26" y="20.5" text-anchor="middle">左</text>
    <rect class="side-bg" x="164" y="8" width="20" height="17" rx="8.5"/><text class="side" x="174" y="20.5" text-anchor="middle">右</text>
  </svg>`;
}
