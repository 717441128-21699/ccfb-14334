/**
 * 合成测试叶子生成器（纯 TypeScript，无 DOM 依赖）。
 *
 * 同时产出透光图 T 与反射光图 R 两张灰度图（Float32, 0..1），
 * 并附带全部真值（帘纹/纲线周期、方向、人为平移量），供误差测试使用。
 *
 * 分层模型：
 *   纸基 = 均值 + 云絮(fbm) + 定向纤维 + 帘纹余弦 + 纲线宽条
 *   墨字/污渍在 R 中变暗、在 T 中变暗得更厉害（物理上吸光更强）
 *   R 相对 T 加入已知的亚像素平移，用于检验配准
 */
import { fbm, gaussian, mulberry32 } from './random';
import { sampleBilinear } from './geometry';
import type { SyntheticPair } from './types';

export type FiberGrade = 'none' | 'fine' | 'medium' | 'coarse';
export type InkCoverage = 'none' | 'light' | 'medium' | 'heavy';

export interface SyntheticPreset {
  name: string;
  /** 帘纹间距（毫米） */
  laidPeriodMm: number;
  /** 纲线间距（毫米） */
  chainPeriodMm: number;
  fiber: FiberGrade;
  ink: InkCoverage;
}

/** 覆盖常见手工纸帘纹密度的几档预设（含密、中、疏）。 */
export const SYNTHETIC_PRESETS: SyntheticPreset[] = [
  { name: '密帘纹-少墨', laidPeriodMm: 0.8, chainPeriodMm: 22, fiber: 'fine', ink: 'light' },
  { name: '中帘纹-标准', laidPeriodMm: 1.4, chainPeriodMm: 30, fiber: 'medium', ink: 'medium' },
  { name: '疏帘纹-重墨', laidPeriodMm: 2.4, chainPeriodMm: 45, fiber: 'coarse', ink: 'heavy' },
  { name: '极密帘纹-无墨', laidPeriodMm: 0.55, chainPeriodMm: 18, fiber: 'none', ink: 'none' },
];

export interface GeneratorOptions {
  seed?: number;
  width?: number;
  height?: number;
  dpi?: number;
  orientationDeg?: number;
  preset: SyntheticPreset;
  /** 反射图相对透光图的人为平移（原像素，可为亚像素） */
  misalignX?: number;
  misalignY?: number;
}

const FIBER_PARAMS: Record<FiberGrade, { count: number; length: number; contrast: number }> = {
  none: { count: 0, length: 0, contrast: 0 },
  fine: { count: 1400, length: 26, contrast: 0.05 },
  medium: { count: 2600, length: 40, contrast: 0.09 },
  coarse: { count: 4200, length: 64, contrast: 0.14 },
};

const INK_PARAMS: Record<InkCoverage, { blocks: number; strokes: [number, number]; strength: number }> = {
  none: { blocks: 0, strokes: [0, 0], strength: 0 },
  light: { blocks: 120, strokes: [3, 5], strength: 0.75 },
  medium: { blocks: 320, strokes: [4, 7], strength: 0.85 },
  heavy: { blocks: 700, strokes: [5, 9], strength: 0.92 },
};

/** 低分辨率纹理双线性放大到目标尺寸。 */
function upscale(src: Float32Array, srcSize: number, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = (y + 0.5) * srcSize / h - 0.5;
    for (let x = 0; x < w; x++) {
      const sx = (x + 0.5) * srcSize / w - 0.5;
      out[y * w + x] = sampleBilinear(src, srcSize, srcSize, sx, sy);
    }
  }
  return out;
}

function paintSoftRect(
  buf: Float32Array,
  size: number,
  cx: number,
  cy: number,
  len: number,
  thick: number,
  angle: number,
  value: number,
): void {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const reach = Math.ceil(len / 2 + thick);
  const x0 = Math.max(0, ((cx - reach) | 0));
  const x1 = Math.min(size - 1, ((cx + reach) | 0));
  const y0 = Math.max(0, ((cy - reach) | 0));
  const y1 = Math.min(size - 1, ((cy + reach) | 0));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const along = dx * c + dy * s;
      const perp = -dx * s + dy * c;
      // 软笔锋：两端与两侧均余弦衰减
      const ax = Math.max(0, 1 - Math.abs(along) / (len / 2));
      const ay = Math.max(0, 1 - Math.abs(perp) / (thick / 2));
      const wgt = ax * ay;
      if (wgt <= 0) continue;
      const idx = y * size + x;
      buf[idx] += value * wgt;
    }
  }
}

export function generateSyntheticPair(opts: GeneratorOptions): SyntheticPair {
  const width = opts.width ?? 2048;
  const height = opts.height ?? 2048;
  const dpi = opts.dpi ?? 600;
  const seed = opts.seed ?? 12345;
  const rand = mulberry32(seed);
  const preset = opts.preset;
  const thetaDeg = opts.orientationDeg ?? 3;
  const theta = (thetaDeg * Math.PI) / 180;
  const misalignX = opts.misalignX ?? 1.7;
  const misalignY = opts.misalignY ?? -1.1;

  const mmToPx = (mm: number) => (mm * dpi) / 25.4;
  const laidPeriodPx = mmToPx(preset.laidPeriodMm);
  const chainPeriodPx = mmToPx(preset.chainPeriodMm);

  // 随机纹理在 512² 上生成再放大（云絮/纤维本身是低频结构）
  const texSize = 512;
  const clouds = fbm(texSize, 128, 4, rand);
  const fiberBuf = new Float32Array(texSize * texSize);
  const fp = FIBER_PARAMS[preset.fiber];
  // 真实纸纤维朝向虽大致顺帘纹走，但个体方向高度分散。
  // 这里以帘纹走向为均值、给 ±60° 的宽角分布，使纤维谱能量摊开成
  // 一条方向带而非竞争性尖峰；帘纹仍是图中唯一的强周期信号。
  const fiberMeanAngle = theta + Math.PI / 2;
  for (let k = 0; k < fp.count; k++) {
    const cx = rand() * texSize;
    const cy = rand() * texSize;
    // 近似正态的宽角抖动（两次均匀分布相减）
    const jitter = ((rand() + rand() + rand() - 1.5) / 1.5) * (Math.PI / 3);
    const len = fp.length * (0.4 + rand() * 0.7);
    paintSoftRect(
      fiberBuf, texSize, cx, cy, len, 1.1,
      fiberMeanAngle + jitter, (rand() - 0.5) * 2 * fp.contrast,
    );
  }

  const cloudFull = upscale(clouds, texSize, width, height);
  const fiberFull = upscale(fiberBuf, texSize, width, height);

  // 传感器噪声层：在低分辨率格点上生成再放大，模拟相机去马赛克/抗混叠，
  // 避免逐像素白噪声在奈奎斯特角点形成比真帘纹还强的假峰
  const noiseTex = 128;
  const noiseLow = new Float32Array(noiseTex * noiseTex);
  for (let i = 0; i < noiseLow.length; i++) noiseLow[i] = gaussian(rand, 1);
  const noiseFull = upscale(noiseLow, noiseTex, width, height);

  // 墨字层：网格状「字块」，每块若干横竖笔画；另加圆形污渍
  const inkMask = new Float32Array(width * height);
  const ip = INK_PARAMS[preset.ink];
  const margin = Math.round(width * 0.08);
  const cols = Math.max(1, Math.round(Math.sqrt(ip.blocks * width / height)));
  const rows = Math.max(1, Math.round(ip.blocks / cols));
  const cellW = (width - 2 * margin) / cols;
  const cellH = (height - 2 * margin) / rows;
  const strokeW = Math.max(2, width / 900);
  for (let ry = 0; ry < rows; ry++) {
    for (let rx = 0; rx < cols; rx++) {
      if (rand() > 0.75) continue; // 留出空白，模拟版面疏密
      const bx = margin + rx * cellW + cellW * 0.2 + rand() * cellW * 0.3;
      const by = margin + ry * cellH + cellH * 0.2 + rand() * cellH * 0.3;
      const bw = cellW * (0.45 + rand() * 0.2);
      const bh = cellH * (0.45 + rand() * 0.2);
      const strokeCount = ip.strokes[0] +
        Math.floor(rand() * (ip.strokes[1] - ip.strokes[0] + 1));
      for (let s = 0; s < strokeCount; s++) {
        const horizontal = rand() > 0.45;
        // 笔画位置在字块内充分随机（含亚格点抖动），避免规则网格形成周期假峰
        const cx = bx + rand() * bw + (rand() - 0.5) * cellW * 0.15;
        const cy = by + rand() * bh + (rand() - 0.5) * cellH * 0.15;
        const len = (horizontal ? bw : bh) * (0.4 + rand() * 0.6);
        const angle = horizontal ? (rand() - 0.5) * 0.2 : Math.PI / 2 + (rand() - 0.5) * 0.2;
        paintSoftRect(inkMask, width, cx, cy, len, strokeW * 1.6, angle, 1);
      }
    }
  }
  // 污渍
  const stainCount = preset.ink === 'none' ? 0 : 4 + Math.floor(rand() * 6);
  for (let k = 0; k < stainCount; k++) {
    const cx = rand() * width;
    const cy = rand() * height;
    const radius = width * (0.02 + rand() * 0.05);
    const x0 = Math.max(0, (cx - radius) | 0);
    const x1 = Math.min(width - 1, (cx + radius) | 0);
    const y0 = Math.max(0, (cy - radius) | 0);
    const y1 = Math.min(height - 1, (cy + radius) | 0);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x - cx, y - cy) / radius;
        if (d < 1) inkMask[y * width + x] = Math.max(inkMask[y * width + x], (1 - d) ** 2 * 0.7);
      }
    }
  }
  for (let i = 0; i < inkMask.length; i++) inkMask[i] = Math.min(1, inkMask[i]);

  // 组装全分辨率纸张
  const paper = new Float32Array(width * height);
  const c = Math.cos(theta);
  const sn = Math.sin(theta);
  const laidAmp = 0.07;
  const chainAmp = 0.06;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      // 屏幕坐标 y 向下，法线 (cosθ, sinθ) 对应相位 x·cosθ − y·sinθ
      const phase = x * c - y * sn;
      const laid = laidAmp * Math.cos((2 * Math.PI * phase) / laidPeriodPx);
      const chainPhase = -x * sn - y * c;
      const chain = chainAmp * (0.5 + 0.5 * Math.cos((2 * Math.PI * chainPhase) / chainPeriodPx)) ** 4;
      const v = 0.62
        + (cloudFull[i] - 0.5) * 0.05
        + fiberFull[i] * 0.6
        + laid
        + (chain - chainAmp * 0.3);
      paper[i] = v;
    }
  }

  // 透光图：墨字吸光更强；反射图：墨字吸光较弱，且整体略亮
  const transmission = new Float32Array(width * height);
  const reflection = new Float32Array(width * height);
  const inkStrength = INK_PARAMS[preset.ink].strength;
  for (let i = 0; i < paper.length; i++) {
    const m = inkMask[i];
    const t = paper[i] * (1 - inkStrength * m) + noiseFull[i] * 0.012;
    // 反射图按已知平移采样纸基与墨层
    const rx = (i % width) - misalignX;
    const ry = ((i / width) | 0) - misalignY;
    const pR = sampleBilinear(paper, width, height, rx, ry);
    const mR = sampleBilinear(inkMask, width, height, rx, ry);
    const r = pR * 1.08 * (1 - inkStrength * 0.62 * mR) + noiseFull[i] * 0.015;
    transmission[i] = t;
    reflection[i] = r;
  }
  // 仅做温和的范围保护（clamp），不做逐图 min-max 拉伸 ——
  // 强制归一到 0..1 会把均匀纸张的微弱纹理放大成满幅强对比，
  // 既不符合真实纸张（CV 通常 0.03~0.08），也会让墨掩码失效。
  for (let i = 0; i < transmission.length; i++) {
    transmission[i] = Math.min(1, Math.max(0, transmission[i]));
    reflection[i] = Math.min(1, Math.max(0, reflection[i]));
  }

  return {
    transmission,
    reflection,
    width,
    height,
    groundTruth: {
      seed,
      dpi,
      width,
      height,
      laidPeriodPx,
      chainPeriodPx,
      orientationDeg: thetaDeg,
      misalignX,
      misalignY,
      preset: preset.name,
    },
  };
}
