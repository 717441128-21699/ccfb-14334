import { describe, expect, it } from 'vitest';
import { fft1d, fft2d, isPowerOfTwo, naiveDft1d, powerSpectrum } from '../src/core/fft';

describe('fft1d 与朴素 DFT 对拍', () => {
  it('正变换在 N=16/64/256 上与朴素 DFT 一致', () => {
    for (const n of [16, 64, 256]) {
      const re = new Float64Array(n).map((_, i) => Math.sin(i * 0.7) + 0.5 * Math.cos(i * 1.9));
      const im = new Float64Array(n);
      const ref = naiveDft1d(re, im, false);
      fft1d(re, im, false);
      for (let k = 0; k < n; k++) {
        expect(re[k]).toBeCloseTo(ref.re[k], 8);
        expect(im[k]).toBeCloseTo(ref.im[k], 8);
      }
    }
  });

  it('逆变换还原输入（含非零虚部）', () => {
    const n = 64;
    const orig = new Float64Array(n).map((_, i) => Math.sin(i * 0.31) * (1 + 0.2 * Math.cos(i)));
    const re = Float64Array.from(orig);
    const im = new Float64Array(n).map((_, i) => 0.3 * Math.cos(i * 1.1));
    const origIm = Float64Array.from(im);
    fft1d(re, im, false);
    fft1d(re, im, true);
    for (let i = 0; i < n; i++) {
      expect(re[i]).toBeCloseTo(orig[i], 10);
      expect(im[i]).toBeCloseTo(origIm[i], 10);
    }
  });

  it('2D FFT 正逆变换往返一致', () => {
    const n = 32;
    const re = new Float64Array(n * n);
    const im = new Float64Array(n * n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        re[y * n + x] = Math.sin(x * 0.5) * Math.cos(y * 0.35) + 0.2;
      }
    }
    const orig = Float64Array.from(re);
    fft2d(re, im, n, n, false);
    const spec = powerSpectrum(re, im);
    expect(spec[0]).toBeGreaterThan(0);
    fft2d(re, im, n, n, true);
    for (let i = 0; i < re.length; i++) expect(re[i]).toBeCloseTo(orig[i], 9);
  });

  it('非 2 的幂抛错', () => {
    expect(isPowerOfTwo(100)).toBe(false);
    expect(() => fft1d(new Float64Array(3), new Float64Array(3), false)).toThrow();
  });
});
