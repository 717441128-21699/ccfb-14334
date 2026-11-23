/**
 * 扣墨（CPU 参考实现，GPU 着色器与其数学一致）。
 *
 * 模型：在墨字/污渍区域，透光 T 与反射 R 呈近似线性关系
 *   T = a·R + b + ε
 * 用 Huber 加权稳健回归估 (a,b)，从 T 中减去 a·(R−Rmean)，
 * 保留纸浆云絮等低频结构（这些在 R、T 中并不共享同一回归系数，
 * 且回归仅对 ink mask 内像素拟合，纸张本体不参与）。
 */
import { boxBlur } from './geometry';

export interface InkRemovalResult {
  /** 扣墨后的纸基图（已归一到约 0..1） */
  paper: Float32Array;
  /** 墨字/污渍掩码 0..1 */
  inkMask: Float32Array;
  /** 墨字覆盖比例（mask > 0.5） */
  inkCoverage: number;
  slope: number;
  intercept: number;
}

function robustRegression(
  xs: Float32Array,
  ys: Float32Array,
  mask: Uint8Array,
  huberDelta: number,
): { slope: number; intercept: number } {
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) {
      sumX += xs[i];
      sumY += ys[i];
      count++;
    }
  }
  if (count < 16) return { slope: 0, intercept: sumY / Math.max(1, count) };
  const mx = sumX / count;
  const my = sumY / count;

  // 初值：普通最小二乘
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const dx = xs[i] - mx;
    sxx += dx * dx;
    sxy += dx * (ys[i] - my);
  }
  let slope = sxx > 1e-12 ? sxy / sxx : 0;
  let intercept = my - slope * mx;

  // 两轮 Huber 加权重估
  for (let iter = 0; iter < 2; iter++) {
    let residSq = 0;
    let wsum = 0;
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const r = ys[i] - (slope * xs[i] + intercept);
      residSq += r * r;
      wsum++;
    }
    const sigma = Math.sqrt(residSq / Math.max(1, wsum)) + 1e-9;
    let wmx = 0;
    let wmy = 0;
    let w = 0;
    let wsxx = 0;
    let wsxy = 0;
    const weights = new Float32Array(mask.length);
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const r = ys[i] - (slope * xs[i] + intercept);
      const t = Math.abs(r) / sigma;
      weights[i] = t <= huberDelta ? 1 : huberDelta / t;
      wmx += weights[i] * xs[i];
      wmy += weights[i] * ys[i];
      w += weights[i];
    }
    wmx /= w;
    wmy /= w;
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const dx = xs[i] - wmx;
      wsxx += weights[i] * dx * dx;
      wsxy += weights[i] * dx * (ys[i] - wmy);
    }
    slope = wsxx > 1e-12 ? wsxy / wsxx : 0;
    intercept = wmy - slope * wmx;
  }
  return { slope, intercept };
}

export function removeInk(
  transmission: Float32Array,
  reflectionAligned: Float32Array,
  n: number,
  huberDelta: number,
): InkRemovalResult {
  // 反射图局部均值估计背景；R 低于背景的部分即墨字/污渍
  const blurRadius = Math.max(8, Math.round(n / 64));
  const localMean = boxBlur(reflectionAligned, n, n, blurRadius);
  const inkMask = new Float32Array(n * n);
  const hardMask = new Uint8Array(n * n);
  let coverage = 0;
  for (let i = 0; i < inkMask.length; i++) {
    // 局部背景自身的尺度：对模糊图做小半径再模糊估计局部均值水平
    const deficit = localMean[i] - reflectionAligned[i];
    // 相对暗度门槛 12%（纸浆云絮的局部起伏通常 <8%，墨字 >20%），线性过渡到 24%
    const m = Math.min(1, Math.max(0, (deficit / Math.max(1e-3, localMean[i]) - 0.12) / 0.12));
    inkMask[i] = m;
    // 硬掩码完全基于「相对局部背景的暗化程度」，不使用全局绝对阈值
    // （天然纸纹在全局可能很暗，但相对其自身局部背景并不暗）
    if (m > 0.6) {
      hardMask[i] = 1;
      coverage++;
    }
  }
  coverage /= inkMask.length;

  const { slope, intercept } = robustRegression(
    reflectionAligned, transmission, hardMask, huberDelta,
  );

  let rMeanMasked = 0;
  let cnt = 0;
  for (let i = 0; i < hardMask.length; i++) {
    if (hardMask[i]) {
      rMeanMasked += reflectionAligned[i];
      cnt++;
    }
  }
  if (cnt === 0) {
    // 无墨区时退化为全图均值，校正项随之趋零
    let sum = 0;
    for (const v of reflectionAligned) sum += v;
    rMeanMasked = sum / reflectionAligned.length;
  } else {
    rMeanMasked /= cnt;
  }

  const paper = new Float32Array(n * n);
  for (let i = 0; i < paper.length; i++) {
    // 仅在墨字区域减回归项；干净纸面保持原值，避免纸浆纹理被误伤
    const correction = slope * (reflectionAligned[i] - rMeanMasked) * inkMask[i];
    paper[i] = transmission[i] - correction;
  }
  // 归一到 0..1（保留 1% 余量）
  let pmin = Infinity;
  let pmax = -Infinity;
  for (const v of paper) {
    pmin = Math.min(pmin, v);
    pmax = Math.max(pmax, v);
  }
  const span = Math.max(1e-6, pmax - pmin);
  for (let i = 0; i < paper.length; i++) paper[i] = (paper[i] - pmin) / span * 0.98 + 0.01;

  return { paper, inkMask, inkCoverage: coverage, slope, intercept };
}
