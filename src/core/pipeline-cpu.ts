/**
 * CPU 参考流水线：与 GPU 流水线步骤一一对应，
 * 供 Vitest 端到端测试与无 WebGL 环境回退使用。
 */
import { fft2d, powerSpectrum } from './fft';
import { boxBlur, warpShift } from './geometry';
import { removeInk } from './ink';
import { phaseCorrelate } from './registration';
import { normalizedSpectrum } from './spectral';
import { decideLaidLineSpatial, detectChainSpatial } from './joint';
import {
  refinePeriodByAutocorr,
  rotatedProjection,
} from './projection';
import { computeUniformity } from './uniformity';
import { hann1d } from './geometry';
import type {
  AnalysisConfig,
  LeafRecord,
  PeakInfo,
  SyntheticPair,
  UniformityMetrics,
} from './types';

/** 中心裁剪 + 降采样到 N×N（区域平均，抗混叠）。 */
export function downscaleToSquare(
  img: Float32Array,
  w: number,
  h: number,
  n: number,
): Float32Array {
  const side = Math.min(w, h);
  const x0 = ((w - side) / 2) | 0;
  const y0 = ((h - side) / 2) | 0;
  const out = new Float32Array(n * n);
  const bin = side / n;
  for (let oy = 0; oy < n; oy++) {
    for (let ox = 0; ox < n; ox++) {
      const sx0 = x0 + Math.floor(ox * bin);
      const sx1 = Math.max(sx0 + 1, x0 + Math.floor((ox + 1) * bin));
      const sy0 = y0 + Math.floor(oy * bin);
      const sy1 = Math.max(sy0 + 1, y0 + Math.floor((oy + 1) * bin));
      let acc = 0;
      let cnt = 0;
      for (let sy = sy0; sy < Math.min(sy1, h); sy++) {
        for (let sx = sx0; sx < Math.min(sx1, w); sx++) {
          acc += img[sy * w + sx];
          cnt++;
        }
      }
      out[oy * n + ox] = acc / cnt;
    }
  }
  return out;
}

function hanningWindowApply(img: Float64Array, n: number): void {
  const win = hann1d(n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      img[y * n + x] *= win[x] * win[y];
    }
  }
}

export interface CpuPipelineStageImages {
  alignedReflection: Float32Array;
  paper: Float32Array;
  inkMask: Float32Array;
  laidComponent: Float32Array;
  chainComponent: Float32Array;
  residual: Float32Array;
  normSpec: Float64Array;
}

/** 频域高斯掩码逆变换，分离指定峰对应的条纹分量。 */
function inverseFilterComponent(
  paper: Float32Array,
  n: number,
  peakFx: number,
  peakFy: number,
  sigmaBins: number,
): Float32Array {
  const re = new Float64Array(n * n);
  const im = new Float64Array(n * n);
  for (let i = 0; i < paper.length; i++) re[i] = paper[i];
  hanningWindowApply(re, n);
  fft2d(re, im, n, n, false);

  // 峰在 DC 居中坐标中的位置（共轭对 ±(fx,fy)）
  const cx = n / 2 + peakFx;
  const cy = n / 2 + peakFy;
  const twoSigma2 = 2 * sigmaBins * sigmaBins;
  const maskedRe = new Float64Array(n * n);
  const maskedIm = new Float64Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const d1 = (x - cx) ** 2 + (y - cy) ** 2;
      const d2 = (x - (n - cx)) ** 2 + (y - (n - cy)) ** 2;
      const g = Math.exp(-d1 / twoSigma2) + Math.exp(-d2 / twoSigma2);
      const idx = y * n + x;
      maskedRe[idx] = re[idx] * g;
      maskedIm[idx] = im[idx] * g;
    }
  }
  fft2d(maskedRe, maskedIm, n, n, true);
  const out = new Float32Array(n * n);
  for (let i = 0; i < out.length; i++) out[i] = maskedRe[i];
  return out;
}

export interface CpuPipelineResult {
  record: Omit<LeafRecord, 'leafId' | 'timestamp' | 'files'>;
  stages: CpuPipelineStageImages;
}

export function runCpuPipeline(
  transmission: Float32Array,
  reflection: Float32Array,
  width: number,
  height: number,
  config: AnalysisConfig,
): CpuPipelineResult {
  const t0 = performance.now();
  const n = config.fftSize;

  // 1. 降采样（同一尺寸/同一方式，保持两图对齐）
  const tSmall = downscaleToSquare(transmission, width, height, n);
  const rSmall = downscaleToSquare(reflection, width, height, n);

  // 2. 相位相关配准（在 512² 上做，再按比例放大平移量）
  const regN = 512;
  const reg = phaseCorrelate(tSmall, rSmall, n, n, regN);
  const alignedR = warpShift(rSmall, n, n, reg.shiftX, reg.shiftY);

  // 3. 扣墨
  const ink = removeInk(tSmall, alignedR, n, config.huberDelta);

  // 4. Hann + FFT + 归一化功率谱
  const re = new Float64Array(n * n);
  for (let i = 0; i < ink.paper.length; i++) re[i] = ink.paper[i];
  const im = new Float64Array(n * n);
  hanningWindowApply(re, n);
  fft2d(re, im, n, n, false);
  const spec = powerSpectrum(re, im);
  const normSpec = normalizedSpectrum(spec, n);

  // 5. 帘纹判定：空间域旋转投影 + 自相关方向扫描（对像素栅格化混叠稳健）
  // 工作像素 → 毫米：原图 dpi 下，1 工作像素 = (min(w,h)/n) 原像素
  const origPxPerWorkPx = Math.min(width, height) / n;
  const mmPerPx = (25.4 / config.dpi) * origPxPerWorkPx;
  const decision = decideLaidLineSpatial(ink.paper, {
    n,
    mmPerPx,
    laidPeriodMmRange: config.laidPeriodMmRange,
    orientationHint: config.orientationHint,
  });
  const laid = decision.laid;

  // 纲线：沿正交法线做空间域自相关（频域对这种仅 2~3 个周期的低频结构失效）
  const chainHit = detectChainSpatial(
    ink.paper, laid.orientationRad, n, mmPerPx, config.chainPeriodMmRange,
  );
  const chain: PeakInfo | null = chainHit
    ? (() => {
        const f = 1 / chainHit.periodPx;
        return {
          binX: n * f * Math.cos(chainHit.orientationRad),
          binY: -n * f * Math.sin(chainHit.orientationRad),
          frequencyPx: f,
          orientationRad: chainHit.orientationRad,
          periodPx: chainHit.periodPx,
          periodMm: chainHit.periodMm,
          strength: chainHit.strength,
          confidence: Math.min(1, chainHit.strength),
        };
      })()
    : null;

  // 6. 空间域投影精修帘纹周期（与判定一致，记录精修结果）
  const proj = rotatedProjection(ink.paper, n, laid.orientationRad);
  const refined = refinePeriodByAutocorr(proj, laid.periodPx, mmPerPx);

  // 7. 频域分离帘纹/纲线分量
  const laidComp = inverseFilterComponent(ink.paper, n, laid.binX, laid.binY, config.maskSigmaBins);
  const chainComp = chain
    ? inverseFilterComponent(ink.paper, n, chain.binX, chain.binY, config.maskSigmaBins)
    : new Float32Array(n * n);

  // 8. 残差与均匀度
  const residual = new Float32Array(n * n);
  for (let i = 0; i < residual.length; i++) {
    residual[i] = ink.paper[i] - laidComp[i] - chainComp[i];
  }
  const uniformity: UniformityMetrics = computeUniformity(residual, n);

  const stages: CpuPipelineStageImages = {
    alignedReflection: alignedR,
    paper: ink.paper,
    inkMask: ink.inkMask,
    laidComponent: laidComp,
    chainComponent: chainComp,
    residual,
    normSpec,
  };

  const record = {
    imageSize: { width, height },
    registration: reg,
    inkCoverage: ink.inkCoverage,
    laid,
    chain,
    refinedLaid: refined,
    uniformity,
    effectiveDpi: config.dpi / origPxPerWorkPx,
    fftSize: n,
    elapsedMs: performance.now() - t0,
  };
  return { record, stages };
}

/** 对合成图对运行流水线的便捷封装。 */
export function analyzeSyntheticPair(
  pair: SyntheticPair,
  config: AnalysisConfig,
): CpuPipelineResult {
  return runCpuPipeline(
    pair.transmission, pair.reflection, pair.width, pair.height, config,
  );
}

export { boxBlur };
