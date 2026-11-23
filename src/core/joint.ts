/**
 * 空间域主导的帘纹判定。
 *
 * 为什么以空间域为主：旋转周期纹理在离散像素栅格上必然产生栅格化混叠，
 * 其高频能量可能在频谱里强过真帘纹峰，导致纯频域峰检测被带偏。
 * 而沿条纹法线的旋转投影 + 自相关直接测量空间周期，对栅格化稳健
 * （真帘纹贯穿全图，自相关峰又高又稳；混叠噪声的自相关一致性差）。
 *
 * 流程：
 *  1. 在 0..π 内按固定角步长扫描方向，每个方向做旋转投影；
 *  2. 仅在帘纹物理周期对应的 lag 窗口内求归一化自相关峰；
 *  3. 取自相关强度最高的方向为帘纹法线、对应 lag 为周期；
 *  4. 在胜出方向附近做细角度 + 抛物线插值，得到亚像素周期。
 */
import { parabolaOffset } from './geometry';
import { rotatedProjection } from './projection';
import type { PeakInfo } from './types';

export interface SpatialLaidResult {
  laid: PeakInfo;
  autocorrStrength: number;
}

export interface SpatialOptions {
  n: number;
  mmPerPx: number;
  laidPeriodMmRange: [number, number];
  /** 粗扫描角度步长（弧度），默认 3° */
  coarseStepDeg?: number;
  /** 细扫描半宽（弧度），默认 ±粗步长 */
  fineHalfWidthDeg?: number;
  fineStepDeg?: number;
  orientationHint?: number;
}

interface DirScore {
  angleRad: number;
  strength: number;
  lagPx: number;
}

/**
 * 计算指定方向投影、指定 lag 窗口内的周期自相关峰。
 *
 * 关键：不能只取窗口内自相关最大值——低频云絮/纤维趋势的自相关
 * 单调缓慢衰减，在小 lag 处天然接近 1，会冒充强峰。真正的周期信号
 * 表现为「尖锐局部极大」：峰明显高于其两侧的谷。这里用峰的突出度
 * （峰值减去两侧邻域的较低值）作为打分，并记录归一化强度。
 */
function autocorrInWindow(
  values: Float64Array,
  lagMin: number,
  lagMax: number,
): { strength: number; lagPx: number } {
  let mean = 0;
  for (const v of values) mean += v;
  mean /= values.length;
  const d = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) d[i] = values[i] - mean;
  let e0 = 0;
  for (const v of d) e0 += v * v;
  if (e0 <= 0) return { strength: 0, lagPx: lagMin };

  // 全 lag 自相关曲线（一次算完，供峰形分析）
  const ac = new Float64Array(lagMax + 2);
  for (let lag = 0; lag <= lagMax + 1; lag++) {
    let acc = 0;
    for (let i = 0; i + lag < d.length; i++) acc += d[i] * d[i + lag];
    ac[lag] = acc / e0;
  }

  // 在窗口内找局部极大，综合三项证据打分：
  //  (a) 峰突出度（压制单调趋势）；
  //  (b) 谐波一致性：真周期 P 会在 2P、3P 处再现自相关峰，
  //      长周期假峰通常没有成谐波关系的次级峰；
  //  (c) 绝对峰高（保证峰本身可信）。
  let bestScore = -Infinity;
  let bestLag = Math.round((lagMin + lagMax) / 2);
  const isLocalMaxAt = (lag: number) =>
    lag >= 1 && lag < ac.length - 1 && ac[lag] >= ac[lag - 1] && ac[lag] >= ac[lag + 1];
  for (let lag = lagMin; lag <= lagMax; lag++) {
    if (!isLocalMaxAt(lag)) continue;
    const wing = Math.max(2, Math.round(lag / 3));
    const left = ac[Math.max(0, lag - wing)];
    const right = ac[Math.min(ac.length - 1, lag + wing)];
    const prominence = ac[lag] - 0.5 * (left + right);

    // 谐波一致性：在 2P、3P 附近（±15%）找是否存在正的局部极大
    let harmonicEvidence = 0;
    let harmonicCount = 0;
    for (const mult of [2, 3]) {
      const target = lag * mult;
      if (target >= ac.length - 2) continue;
      const tol = Math.max(2, Math.round(lag * 0.15));
      let found = false;
      for (let h = target - tol; h <= target + tol; h++) {
        if (h >= 1 && h < ac.length - 1 && isLocalMaxAt(h) && ac[h] > 0) {
          found = true;
          break;
        }
      }
      harmonicCount++;
      if (found) harmonicEvidence++;
    }
    const harmonicScore = harmonicCount > 0 ? harmonicEvidence / harmonicCount : 0;

    const score =
      prominence * 0.55 +
      harmonicScore * 0.3 +
      Math.max(0, ac[lag]) * 0.15;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  return { strength: Math.max(0, bestScore), lagPx: bestLag };
}

/** lag 处自相关值（供抛物线插值）。 */
function autocorrAt(values: Float64Array, lag: number): number {
  let mean = 0;
  for (const v of values) mean += v;
  mean /= values.length;
  let e0 = 0;
  let acc = 0;
  for (let i = 0; i < values.length; i++) {
    const di = values[i] - mean;
    e0 += di * di;
    if (i + lag < values.length) acc += di * (values[i + lag] - mean);
  }
  return e0 > 0 ? acc / e0 : 0;
}

export function decideLaidLineSpatial(
  paper: Float32Array,
  opts: SpatialOptions,
): SpatialLaidResult {
  const n = opts.n;
  const pxPerMm = 1 / opts.mmPerPx;
  const lagMin = Math.max(4, Math.round(opts.laidPeriodMmRange[0] * pxPerMm));
  const lagMax = Math.min(n / 3, Math.round(opts.laidPeriodMmRange[1] * pxPerMm));

  const coarseStep = (opts.coarseStepDeg ?? 3) * Math.PI / 180;
  const scores: DirScore[] = [];
  const dirCount = Math.ceil(Math.PI / coarseStep);
  for (let k = 0; k < dirCount; k++) {
    const angleRad = k * coarseStep;
    const proj = rotatedProjection(paper, n, angleRad);
    const { strength, lagPx } = autocorrInWindow(proj.values, lagMin, lagMax);
    scores.push({ angleRad, strength, lagPx });
  }

  // 方向先验：若给了提示角度，对邻近方向加权（乘性，不掩盖强证据）
  if (opts.orientationHint !== undefined) {
    for (const s of scores) {
      let d = s.angleRad - opts.orientationHint;
      d = Math.abs(Math.atan2(Math.sin(d), Math.cos(d)));
      d = Math.min(d, Math.abs(Math.PI - d));
      s.strength *= 1 + 0.15 * Math.max(0, 1 - d / (Math.PI / 9));
    }
  }

  scores.sort((a, b) => b.strength - a.strength);
  const coarse = scores[0];

  // 细角度扫描（胜出方向 ±一个粗步长）
  const fineHalf = (opts.fineHalfWidthDeg ?? opts.coarseStepDeg ?? 3) * Math.PI / 180;
  const fineStep = (opts.fineStepDeg ?? 0.5) * Math.PI / 180;
  let bestFine = coarse;
  for (let a = coarse.angleRad - fineHalf; a <= coarse.angleRad + fineHalf + 1e-9; a += fineStep) {
    const angleRad = ((a % Math.PI) + Math.PI) % Math.PI;
    const proj = rotatedProjection(paper, n, angleRad);
    const { strength, lagPx } = autocorrInWindow(proj.values, lagMin, lagMax);
    if (strength > bestFine.strength) {
      bestFine = { angleRad, strength, lagPx };
    }
  }

  // 在胜出方向上对 lag 做抛物线亚像素插值
  const proj = rotatedProjection(paper, n, bestFine.angleRad);
  const lag0 = bestFine.lagPx;
  const aM = autocorrAt(proj.values, lag0 - 1);
  const a0 = autocorrAt(proj.values, lag0);
  const aP = autocorrAt(proj.values, lag0 + 1);
  const lagOffset = parabolaOffset(aM, a0, aP);
  const periodPx = lag0 + lagOffset;
  const periodMm = periodPx * opts.mmPerPx;

  // 由方向反推频谱 bin（与频域 PeakInfo 约定一致，供后续频域分离使用）
  const freqPerPx = 1 / periodPx;
  const binX = n * freqPerPx * Math.cos(bestFine.angleRad);
  const binY = -n * freqPerPx * Math.sin(bestFine.angleRad);

  const laid: PeakInfo = {
    binX,
    binY,
    frequencyPx: freqPerPx,
    orientationRad: bestFine.angleRad,
    periodPx,
    periodMm,
    strength: bestFine.strength,
    confidence: Math.min(1, bestFine.strength),
  };

  return { laid, autocorrStrength: bestFine.strength };
}

/**
 * 纲线空间域检测。
 *
 * 纲线间距大（15~80mm），在工作区内往往只有 2~3 个周期，频域分辨率
 * 不足且被 Hann 窗与 DC 主导；但沿纲线法线的投影在真实周期处仍有
 * 可辨识的自相关峰。因此纲线与帘纹一样走空间域自相关，只是 lag 窗口
 * 对应纲线的物理周期。找不到显著峰时返回 null（纲线本就可能缺失）。
 */
export function detectChainSpatial(
  paper: Float32Array,
  laidOrientationRad: number,
  n: number,
  mmPerPx: number,
  chainPeriodMmRange: [number, number],
): { periodPx: number; periodMm: number; strength: number; orientationRad: number } | null {
  const pxPerMm = 1 / mmPerPx;
  const lagMin = Math.max(8, Math.round(chainPeriodMmRange[0] * pxPerMm));
  const lagMax = Math.min(Math.floor(n / 2), Math.round(chainPeriodMmRange[1] * pxPerMm));
  if (lagMax <= lagMin + 2) return null;

  // 纲线与帘纹正交
  const orientationRad = ((laidOrientationRad + Math.PI / 2) % Math.PI + Math.PI) % Math.PI;
  const proj = rotatedProjection(paper, n, orientationRad);
  const { strength, lagPx } = autocorrInWindow(proj.values, lagMin, lagMax);

  // 纲线峰通常弱于帘纹，给一个显著性下限；低于此视为未检出
  if (strength < 0.08) return null;

  const aM = autocorrAt(proj.values, lagPx - 1);
  const a0 = autocorrAt(proj.values, lagPx);
  const aP = autocorrAt(proj.values, lagPx + 1);
  const periodPx = lagPx + parabolaOffset(aM, a0, aP);
  return {
    periodPx,
    periodMm: periodPx * mmPerPx,
    strength,
    orientationRad,
  };
}
