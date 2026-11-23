/**
 * 空间域投影与周期精修：
 * 沿条纹法线把二维残差压成一维信号，自相关找周期并做抛物线插值，
 * 得到亚像素级帘纹间距（最终毫米误差的主要保障）。
 */
import { mod, parabolaOffset } from './geometry';

export interface Projection {
  values: Float64Array;
  /** 每个 bin 在原图坐标系下的步长（= 1 工作像素，旋转不改变尺度） */
  binSizePx: number;
}

/**
 * 旋转投影。orientationRad 为条纹法线角（数学坐标系，y 向上）。
 * 法线单位向量 n=(cosθ, sinθ)；屏幕坐标 y 向下，故 u = x·cosθ − y·sinθ。
 */
export function rotatedProjection(
  img: Float32Array,
  n: number,
  orientationRad: number,
): Projection {
  const c = Math.cos(orientationRad);
  const s = Math.sin(orientationRad);
  // 预估 u 的取值范围
  const corners = [
    0, n * c, -n * s, n * c - n * s,
    n * c, 0, -n * s, n * c - n * s,
  ];
  let uMin = Infinity;
  let uMax = -Infinity;
  for (const u of corners) {
    uMin = Math.min(uMin, u);
    uMax = Math.max(uMax, u);
  }
  const bins = Math.ceil(uMax - uMin) + 1;
  const sums = new Float64Array(bins);
  const counts = new Float64Array(bins);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = x * c - y * s - uMin;
      const i0 = Math.floor(u);
      const f = u - i0;
      const v = img[y * n + x];
      sums[i0] += v * (1 - f);
      counts[i0] += 1 - f;
      if (i0 + 1 < bins) {
        sums[i0 + 1] += v * f;
        counts[i0 + 1] += f;
      }
    }
  }
  for (let i = 0; i < bins; i++) sums[i] = counts[i] > 0 ? sums[i] / counts[i] : 0;
  return { values: sums, binSizePx: 1 };
}

/** 去均值（供自相关使用）。 */
function detrend(sig: Float64Array): Float64Array {
  let mean = 0;
  for (const v of sig) mean += v;
  mean /= sig.length;
  const out = new Float64Array(sig.length);
  for (let i = 0; i < sig.length; i++) out[i] = sig[i] - mean;
  return out;
}

export interface RefinedPeriod {
  periodPx: number;
  periodMm: number;
  /** 自相关峰归一化强度 0..1 */
  strength: number;
}

/**
 * 在期望周期附近用自相关精修。
 * @param expectedPx FFT 给出的周期初值（工作像素）
 */
export function refinePeriodByAutocorr(
  proj: Projection,
  expectedPx: number,
  mmPerPx: number,
  searchFraction = 0.15,
): RefinedPeriod {
  const x = detrend(proj.values);
  const L = x.length;
  const lagMin = Math.max(3, Math.round(expectedPx * (1 - searchFraction)));
  const lagMax = Math.min(L - 2, Math.round(expectedPx * (1 + searchFraction)));
  if (lagMax <= lagMin) {
    return { periodPx: expectedPx, periodMm: expectedPx * mmPerPx, strength: 0 };
  }
  let e0 = 0;
  for (const v of x) e0 += v * v;
  let best = -Infinity;
  let bestLag = Math.round(expectedPx);
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let acc = 0;
    for (let i = 0; i + lag < L; i++) acc += x[i] * x[i + lag];
    if (acc > best) {
      best = acc;
      bestLag = lag;
    }
  }
  const ac = (lag: number): number => {
    let acc = 0;
    for (let i = 0; i + lag < L; i++) acc += x[i] * x[i + lag];
    return acc;
  };
  const offset = parabolaOffset(ac(bestLag - 1), ac(bestLag), ac(bestLag + 1));
  const periodPx = bestLag + offset;
  return {
    periodPx,
    periodMm: periodPx * mmPerPx,
    strength: e0 > 0 ? Math.max(0, best / e0) : 0,
  };
}

/** 沿法线方向的一维谱投影（可选的第二意见，当前主流程未使用）。 */
export function radialSpectrumProfile(
  normSpec: Float64Array,
  n: number,
  orientationRad: number,
  halfWidthBins = 2,
): Float64Array {
  const c = Math.cos(orientationRad);
  const s = Math.sin(orientationRad);
  const maxR = (n / 2) | 0;
  const profile = new Float64Array(maxR + 1);
  const counts = new Float64Array(maxR + 1);
  for (let r = 1; r <= maxR; r++) {
    for (let d = -halfWidthBins; d <= halfWidthBins; d++) {
      // 沿法线 r、切向 d 取样
      const wx = n / 2 + r * c - d * s;
      const wy = n / 2 - r * s - d * c; // 屏幕 y 翻转
      const x = mod(Math.round(wx), n);
      const y = mod(Math.round(wy), n);
      profile[r] += normSpec[y * n + x];
      counts[r] += 1;
    }
  }
  for (let r = 0; r <= maxR; r++) profile[r] = counts[r] ? profile[r] / counts[r] : 0;
  return profile;
}
