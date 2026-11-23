/** 纸张透光均匀度指标。输入为扣墨并去除周期分量后的纸基残差（0..1 尺度）。 */
import type { UniformityMetrics } from './types';

export function computeUniformity(
  residual: Float32Array,
  n: number,
  block = 64,
): UniformityMetrics {
  let mean = 0;
  for (const v of residual) mean += v;
  mean /= residual.length;
  let sq = 0;
  for (const v of residual) {
    const d = v - mean;
    sq += d * d;
  }
  const std = Math.sqrt(sq / residual.length);

  // 分块局部变异系数
  const blocksX = Math.max(1, Math.floor(n / block));
  const bs = n / blocksX;
  let cvSum = 0;
  let cvCount = 0;
  for (let by = 0; by < blocksX; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      let bm = 0;
      let bsq = 0;
      let cnt = 0;
      const x0 = Math.round(bx * bs);
      const x1 = Math.round((bx + 1) * bs);
      const y0 = Math.round(by * bs);
      const y1 = Math.round((by + 1) * bs);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const v = residual[y * n + x];
          bm += v;
          bsq += v * v;
          cnt++;
        }
      }
      bm /= cnt;
      const bstd = Math.sqrt(Math.max(0, bsq / cnt - bm * bm));
      if (bm > 1e-6) {
        cvSum += bstd / bm;
        cvCount++;
      }
    }
  }
  const localCv = cvCount ? cvSum / cvCount : 0;

  // Sobel 梯度能量（大尺度不均）
  let grad = 0;
  for (let y = 1; y < n - 1; y++) {
    for (let x = 1; x < n - 1; x++) {
      const i = y * n + x;
      const gx =
        -residual[i - n - 1] + residual[i - n + 1]
        - 2 * residual[i - 1] + 2 * residual[i + 1]
        - residual[i + n - 1] + residual[i + n + 1];
      const gy =
        -residual[i - n - 1] - 2 * residual[i - n] - residual[i - n + 1]
        + residual[i + n - 1] + 2 * residual[i + n] + residual[i + n + 1];
      grad += gx * gx + gy * gy;
    }
  }
  grad /= (n - 2) * (n - 2);

  return {
    meanTransmission: mean,
    std,
    localCv,
    gradientEnergy: grad,
  };
}
