import { describe, expect, it } from 'vitest';
import { fft2d, powerSpectrum } from '../src/core/fft';
import { normalizedSpectrum, estimateLaidAndChain } from '../src/core/spectral';
import { hann1d } from '../src/core/geometry';

/** 生成含已知空间频率的二维余弦。 */
function sinusoidImage(n: number, kx: number, ky: number): Float64Array {
  const out = new Float64Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      out[y * n + x] = Math.cos((2 * Math.PI * (kx * x + ky * y)) / n);
    }
  }
  return out;
}

describe('频谱峰检测', () => {
  it('单频余弦的峰位置、周期、方向均正确', () => {
    const n = 128;
    // 选峰落在 hardMax(0.6N) 之内、且完全远离边缘的整数频率
    const kx = 20;
    const ky = 15;
    const img = sinusoidImage(n, kx, ky);
    const win = hann1d(n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) img[y * n + x] *= win[x] * win[y];
    }
    const re = img;
    const im = new Float64Array(n * n);
    fft2d(re, im, n, n, false);
    const norm = normalizedSpectrum(powerSpectrum(re, im), n);

    // FFT 峰在数组 (20,15)，DC-bin 为 (20−64, 15−64)=(-44,-49)
    const trueBinX = kx - n / 2;
    const trueBinY = ky - n / 2;
    const trueR = Math.hypot(trueBinX, trueBinY);
    const truePeriodPx = n / trueR;

    const mmPerPx = 1;
    const truePeriodMm = truePeriodPx;
    const { laid } = estimateLaidAndChain(
      norm, n, mmPerPx,
      [truePeriodMm * 0.5, truePeriodMm * 2],
      [truePeriodMm * 10, truePeriodMm * 100],
    );

    // 峰可能落在 (trueBinX,trueBinY) 或其共轭
    const isConjugate = Math.abs(laid.binX - trueBinX) > 2;
    if (isConjugate) {
      expect(laid.binX).toBeCloseTo(-trueBinX, 0);
      expect(laid.binY).toBeCloseTo(-trueBinY, 0);
    } else {
      expect(laid.binX).toBeCloseTo(trueBinX, 0);
      expect(laid.binY).toBeCloseTo(trueBinY, 0);
    }
    expect(laid.periodPx).toBeCloseTo(truePeriodPx, 0);

    // 方向：atan2(-fy, fx)，共轭方向取 π 周期等价
    const expectedAngle = Math.atan2(-trueBinY, trueBinX);
    let d = Math.abs(laid.orientationRad - expectedAngle);
    d = Math.min(d, Math.PI - d);
    expect(d).toBeLessThan(0.05);
  });

  it('环带内无显著周期峰时抛错而非乱报', () => {
    const n = 64;
    // 白噪声：功率谱近似平坦，不存在突出的周期峰
    let seed = 98765;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const img = new Float64Array(n * n);
    for (let i = 0; i < img.length; i++) img[i] = rand();
    const re = Float64Array.from(img);
    const im = new Float64Array(n * n);
    fft2d(re, im, n, n, false);
    const norm = normalizedSpectrum(powerSpectrum(re, im), n, 2);
    // 白噪声在很窄的高频环带内不应有可信帘纹峰
    expect(() =>
      estimateLaidAndChain(norm, n, 1, [0.5, 0.8], [100, 500]),
    ).toThrow();
  });
});
