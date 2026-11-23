/**
 * 频谱分析：径向背景归一化、帘纹/纲线峰搜索。
 * 频谱约定为「DC 居中」布局：坐标 (x,y) 平移了 N/2。
 */
import { mod, parabolaOffset } from './geometry';
import type { PeakInfo } from './types';

export interface SpectrumLayout {
  n: number;
  /** 每像素毫米数（工作分辨率） */
  mmPerPx: number;
}

/**
 * 可分离盒式背景（在 log 功率谱上）。
 *
 * 不用按半径取中位数的原因：稀疏峰谱中每环绝大多数像素接近 0，
 * 中位数背景退化为 0，归一化随之失效；且每环采样数随半径增大，
 * 噪声极值系统性抬升高频。盒式局部背景在二维邻域内估计连续的
 * 云絮/噪声底，强峰只占极少数像素，不影响邻域均值，对稀疏峰稳健。
 * 边缘用 clamp 填充（不做环绕，避免跨到对面的共轭峰）。
 */
export function boxBackground(src: Float64Array, n: number, halfWidth = 8): Float64Array {
  const tmp = new Float64Array(n * n);
  const out = new Float64Array(n * n);
  const w = halfWidth;
  // 水平：边缘只对实际存在的像素取均值（不 clamp 填充），
  // 否则单点 DC 尖峰会经边缘重复计数泄漏成整条边的高背景/假峰。
  for (let y = 0; y < n; y++) {
    const off = y * n;
    for (let x = 0; x < n; x++) {
      const xLo = Math.max(0, x - w);
      const xHi = Math.min(n - 1, x + w);
      let acc = 0;
      for (let xx = xLo; xx <= xHi; xx++) acc += src[off + xx];
      tmp[off + x] = acc / (xHi - xLo + 1);
    }
  }
  // 垂直：同样按有效像素取均值
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      const yLo = Math.max(0, y - w);
      const yHi = Math.min(n - 1, y + w);
      let acc = 0;
      for (let yy = yLo; yy <= yHi; yy++) acc += tmp[yy * n + x];
      out[y * n + x] = acc / (yHi - yLo + 1);
    }
  }
  return out;
}

/**
 * 归一化频谱：log 功率谱减去盒式局部背景。
 * 输出为对比度谱（峰为显著正值，平坦区接近 0），直流区置零。
 */
export function normalizedSpectrum(spec: Float64Array, n: number, dcCutBins = 2): Float64Array {
  const logSpec = new Float64Array(spec.length);
  for (let i = 0; i < spec.length; i++) logSpec[i] = Math.log1p(spec[i]);
  const bg = boxBackground(logSpec, n);
  const out = new Float64Array(spec.length);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = x - n / 2;
      const dy = y - n / 2;
      const r = Math.hypot(dx, dy);
      out[y * n + x] = r <= dcCutBins ? 0 : logSpec[y * n + x] - bg[y * n + x];
    }
  }
  return out;
}

function makePeak(
  spec: Float64Array,
  n: number,
  x: number,
  y: number,
  mmPerPx: number,
): PeakInfo {
  const fx = x - n / 2;
  const fy = y - n / 2;
  const f = Math.hypot(fx, fy);
  // 峰方向（条纹法线）。atan2 中 y 向下为正，取负转回数学坐标系。
  const orientationRad = Math.atan2(-fy, fx);
  const periodPx = n / f;
  return {
    binX: fx,
    binY: fy,
    frequencyPx: f / n,
    orientationRad,
    periodPx,
    periodMm: periodPx * mmPerPx,
    strength: spec[y * n + x],
    confidence: 0,
  };
}

/** 环带内找最强峰（分数坐标，二维抛物线插值）。 */
function findPeakInAnnulus(
  spec: Float64Array,
  n: number,
  rMin: number,
  rMax: number,
  orientationCenter?: number,
  orientationTolerance?: number,
): { peak: PeakInfo; x: number; y: number } | null {
  const cands = findCandidatePeaks(spec, n, rMin, rMax, 1, orientationCenter, orientationTolerance);
  return cands.length ? cands[0] : null;
}

export interface CandidatePeak {
  peak: PeakInfo;
  x: number;
  y: number;
  /** 归一化谱对比度 */
  score: number;
}

/** 角度是否落在扇形内（方向取 π 周期，自动考虑共轭）。 */
function inOrientationSector(
  dx: number,
  dy: number,
  center: number | undefined,
  tol: number | undefined,
): boolean {
  if (center === undefined || tol === undefined) return true;
  let d = Math.atan2(-dy, dx) - center;
  d = Math.abs(Math.atan2(Math.sin(d), Math.cos(d)));
  d = Math.min(d, Math.abs(Math.PI - d));
  return d <= tol;
}

/**
 * 多候选峰搜索：非极大值抑制后返回环带内最强的若干个峰。
 * 抑制半径 minSepBins 保证候选在频率/方向上彼此分开。
 */
export function findCandidatePeaks(
  spec: Float64Array,
  n: number,
  rMin: number,
  rMax: number,
  topK: number,
  orientationCenter?: number,
  orientationTolerance?: number,
  minSepBins = 6,
): CandidatePeak[] {
  // 收集局部极大值（8 邻域）
  const maxima: Array<{ x: number; y: number; v: number }> = [];
  for (let y = 1; y < n - 1; y++) {
    for (let x = 1; x < n - 1; x++) {
      const dx = x - n / 2;
      const dy = y - n / 2;
      const r = Math.hypot(dx, dy);
      if (r < rMin || r > rMax) continue;
      if (!inOrientationSector(dx, dy, orientationCenter, orientationTolerance)) continue;
      const v = spec[y * n + x];
      if (
        v >= spec[y * n + x - 1] &&
        v >= spec[y * n + x + 1] &&
        v >= spec[(y - 1) * n + x] &&
        v >= spec[(y + 1) * n + x] &&
        v >= spec[(y - 1) * n + x - 1] &&
        v >= spec[(y - 1) * n + x + 1] &&
        v >= spec[(y + 1) * n + x - 1] &&
        v >= spec[(y + 1) * n + x + 1]
      ) {
        maxima.push({ x, y, v });
      }
    }
  }
  maxima.sort((a, b) => b.v - a.v);

  // 非极大值抑制
  const kept: Array<{ x: number; y: number; v: number }> = [];
  for (const m of maxima) {
    if (kept.every((k) => Math.hypot(k.x - m.x, k.y - m.y) >= minSepBins)) {
      kept.push(m);
      if (kept.length >= topK) break;
    }
  }

  const at = (x: number, y: number) => spec[mod(y, n) * n + mod(x, n)];
  return kept.map((m) => {
    const ox = parabolaOffset(at(m.x - 1, m.y), at(m.x, m.y), at(m.x + 1, m.y));
    const oy = parabolaOffset(at(m.x, m.y - 1), at(m.x, m.y), at(m.x, m.y + 1));
    const fx = m.x + ox;
    const fy = m.y + oy;
    const peak = makePeak(spec, n, fx, fy, 0);
    return { peak, x: fx, y: fy, score: m.v };
  });
}

/** 峰附近 3×3 局部能量占比，作为可信度参考。 */
function localDominance(spec: Float64Array, n: number, x: number, y: number): number {
  let local = 0;
  let total = 0;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const v = spec[mod(((y | 0) + dy), n) * n + mod(((x | 0) + dx), n)];
      local += v;
    }
  }
  for (let i = 0; i < spec.length; i++) total += spec[i];
  return total > 0 ? local / total : 0;
}

export interface LaidChainResult {
  laid: PeakInfo;
  chain: PeakInfo | null;
}

/**
 * 主入口：在归一化频谱上先找帘纹（细密、强峰），
 * 再在其正交扇形内找纲线（稀疏、弱峰）。
 */
export function estimateLaidAndChain(
  normSpec: Float64Array,
  n: number,
  mmPerPx: number,
  laidRangeMm: [number, number],
  chainRangeMm: [number, number],
  orientationHint?: number,
): LaidChainResult {
  const pxPerMm = 1 / mmPerPx;
  // 周期 mm → 频谱半径 bin：r = N / (周期mm × px/mm)。
  // 硬性上限取 Nyquist 的 60%，把角点高频噪声区彻底排除在峰搜索之外。
  const hardMax = n * 0.6;
  const rLaidMax = Math.min(hardMax, n / (laidRangeMm[0] * pxPerMm));
  const rLaidMin = Math.max(3, n / (laidRangeMm[1] * pxPerMm));

  const laidHit = findPeakInAnnulus(
    normSpec, n, rLaidMin, rLaidMax,
    orientationHint, orientationHint !== undefined ? Math.PI / 9 : undefined,
  );
  if (!laidHit) throw new Error('帘纹峰搜索失败：环带内未找到显著周期分量');
  const laid = laidHit.peak;
  laid.periodMm = laid.periodPx * mmPerPx;
  laid.confidence = Math.min(1, 0.5 * Math.min(2.5, laid.strength / 2) + 0.5 * Math.min(1, localDominance(normSpec, n, laidHit.x, laidHit.y) * 40));

  // 纲线与帘纹正交：在法线 ±20° 扇形（含反向共轭）内搜索
  const chainNormal = laid.orientationRad + Math.PI / 2;
  const rChainMax = Math.min(n / 2 - 2, n / (chainRangeMm[0] * pxPerMm));
  const rChainMin = Math.max(2, n / (chainRangeMm[1] * pxPerMm));
  const chainHit = findPeakInAnnulus(normSpec, n, rChainMin, rChainMax, chainNormal, Math.PI / 9);
  let chain: PeakInfo | null = null;
  if (chainHit) {
    chain = chainHit.peak;
    chain.periodMm = chain.periodPx * mmPerPx;
    chain.confidence = Math.min(1, 0.5 * Math.min(2.5, chain.strength / 2) + 0.5 * Math.min(1, localDominance(normSpec, n, chainHit.x, chainHit.y) * 40));
  }

  return { laid, chain };
}

/**
 * 纲线峰独立检测。
 *
 * 纲线间距大（15~80mm），在频谱上是紧邻 DC 的极低频峰（r 常仅 2~5 bin），
 * 任何二维局部背景窗都会把它连同 DC 一起抹掉。因此这里不走归一化谱，
 * 而是在原始功率谱上、沿帘纹法线的正交方向取一条窄径向剖面，
 * 对剖面做一维线性去趋势后找峰，避开 DC 主导。
 */
export function findChainPeak(
  normSpec: Float64Array,
  n: number,
  mmPerPx: number,
  laidOrientationRad: number,
  chainRangeMm: [number, number],
  rawSpec?: Float64Array,
): PeakInfo | null {
  const pxPerMm = 1 / mmPerPx;
  const chainNormal = laidOrientationRad + Math.PI / 2;
  const rMin = Math.max(2, Math.floor(n / (chainRangeMm[1] * pxPerMm)));
  const rMax = Math.min(n * 0.6, n / (chainRangeMm[0] * pxPerMm));
  if (rMax <= rMin) return null;

  // 优先用原始功率谱；缺省时退回归一化谱
  const spec = rawSpec ?? normSpec;
  const c = Math.cos(chainNormal);
  const s = Math.sin(chainNormal);
  const halfWidth = 1;
  const maxR = Math.ceil(rMax) + 1;
  const profile = new Float64Array(maxR + 1);
  const counts = new Float64Array(maxR + 1);
  for (let r = 1; r <= maxR; r++) {
    let acc = 0;
    let cnt = 0;
    for (let d = -halfWidth; d <= halfWidth; d++) {
      // 屏幕 y 向下，链法线数学角转屏幕坐标时 y 分量取负
      const wx = n / 2 + r * c - d * s;
      const wy = n / 2 - (r * s + d * c);
      const x = mod(Math.round(wx), n);
      const y = mod(Math.round(wy), n);
      acc += spec[y * n + x];
      cnt++;
    }
    profile[r] = acc / cnt;
    counts[r] = cnt;
  }

  // 一维线性去趋势（log 域），压制 DC 衰减斜坡
  const logP = new Float64Array(maxR + 1);
  for (let r = 0; r <= maxR; r++) logP[r] = Math.log1p(profile[r]);
  const v0 = logP[rMin];
  const v1 = logP[maxR];
  const detrended = new Float64Array(maxR + 1);
  for (let r = rMin; r <= maxR; r++) {
    const line = v0 + ((v1 - v0) * (r - rMin)) / Math.max(1, maxR - rMin);
    detrended[r] = logP[r] - line;
  }

  // 找去趋势剖面的局部极大
  let bestR = -1;
  let bestV = -Infinity;
  for (let r = rMin; r <= maxR; r++) {
    const left = r > 0 ? detrended[r - 1] : detrended[r];
    const right = r < maxR ? detrended[r + 1] : detrended[r];
    if (detrended[r] >= left && detrended[r] >= right && detrended[r] > bestV) {
      bestV = detrended[r];
      bestR = r;
    }
  }
  if (bestR < 0 || bestV <= 0) return null;

  // 抛物线亚 bin 插值
  const ox = parabolaOffset(detrended[bestR - 1] ?? 0, detrended[bestR], detrended[bestR + 1] ?? 0);
  const rFrac = bestR + ox;
  const binX = rFrac * c;
  const binY = -rFrac * s;
  const periodPx = n / rFrac;
  const peak: PeakInfo = {
    binX,
    binY,
    frequencyPx: rFrac / n,
    orientationRad: chainNormal,
    periodPx,
    periodMm: periodPx * mmPerPx,
    strength: bestV,
    confidence: Math.min(1, bestV / 2),
  };
  return peak;
}
