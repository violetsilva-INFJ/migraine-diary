// 头部示意图：正面（镜像，屏幕左边 = 自己的左边）和背面，区域可点选或显示热力
import { REGIONS } from './util.js';

const R = (x, y, w, h) => `M${x} ${y}h${w}v${h}h${-w}Z`;

const FRONT_HEAD = 'M70 12C104 12 124 38 124 78C124 112 108 140 84 150Q70 155 56 150C32 140 16 112 16 78C16 38 36 12 70 12Z';
const BACK_HEAD = 'M70 12C104 12 124 38 124 80C124 116 104 142 70 146C36 142 16 116 16 80C16 38 36 12 70 12Z';
const NECK = 'M51 126h38v40H51Z';
const SHOULDERS = 'M14 192C18 174 34 165 52 163H88C106 165 122 174 126 192Z';

const FRONT = [
  ['vertex', R(0, 0, 140, 34)],
  ['forehead-L', R(30, 34, 40, 28)],
  ['forehead-R', R(70, 34, 40, 28)],
  ['temple-L', R(0, 34, 30, 62)],
  ['temple-R', R(110, 34, 30, 62)],
  ['eye-L', R(30, 62, 40, 30)],
  ['eye-R', R(70, 62, 40, 30)],
  ['face-L', 'M0 96H30V92H70V160H0Z'],
  ['face-R', 'M140 96H110V92H70V160H140Z'],
];
const BACK = [
  ['vertex', R(0, 0, 140, 34)],
  ['occiput-L', R(0, 34, 70, 120)],
  ['occiput-R', R(70, 34, 70, 120)],
];
const BACK_NECK = [
  ['neck-L', R(51, 126, 19, 40)],
  ['neck-R', R(70, 126, 19, 40)],
];
const FACE_HINTS = [
  'M38 58Q50 53 62 57', 'M78 57Q90 53 102 58',
  'M42 76Q50 70.5 58 76Q50 80 42 76Z', 'M82 76Q90 70.5 98 76Q90 80 82 76Z',
  'M70 84L66.5 103Q70 106 73.5 103', 'M60 123Q70 128.5 80 123',
];

let n = 0;

export function headSVG(view, { on = new Set(), heat = null, interactive = false } = {}) {
  const id = `hm${++n}`;
  const front = view === 'front';
  const region = ([rid, d], clip) => {
    const sel = on.has(rid), t = heat ? (heat[rid] || 0) : 0;
    const label = REGIONS[rid].label + (heat ? ` ${Math.round(t * 100)}%` : '');
    const attrs = interactive
      ? `data-act="region" data-id="${rid}" role="button" tabindex="0" aria-pressed="${sel}" aria-label="${label}"`
      : `role="img" aria-label="${label}"`;
    return `<g clip-path="url(#${clip})"><path class="region ${sel ? 'on' : ''}" d="${d}" ${attrs}/>
      ${t > 0 ? `<path class="heat" d="${d}" style="fill-opacity:${(0.18 + 0.82 * t).toFixed(2)}"/>` : ''}</g>`;
  };
  return `<svg viewBox="0 0 140 194" class="head ${interactive ? 'interactive' : ''}" role="group" aria-label="${front ? '头部正面' : '头部背面'}">
    <defs>
      <clipPath id="${id}-h"><path d="${front ? FRONT_HEAD : BACK_HEAD}"/></clipPath>
      <clipPath id="${id}-n"><path d="${NECK}"/></clipPath>
    </defs>
    <path class="head-base" d="${SHOULDERS}"/>
    ${front ? `<path class="head-base" d="${NECK}"/>` : BACK_NECK.map(r => region(r, `${id}-n`)).join('')}
    <ellipse class="head-base" cx="15.5" cy="84" rx="6" ry="12"/><ellipse class="head-base" cx="124.5" cy="84" rx="6" ry="12"/>
    ${(front ? FRONT : BACK).map(r => region(r, `${id}-h`)).join('')}
    ${front ? `<g class="head-hint">${FACE_HINTS.map(d => `<path d="${d}"/>`).join('')}</g>` : '<path class="head-hint" d="M70 14V34"/>'}
    <text class="side" x="3" y="11">左</text><text class="side" x="137" y="11" text-anchor="end">右</text>
  </svg>`;
}
