import { describe, expect, it } from 'vitest';
import { phaseCorrelate } from '../src/core/registration';
import { warpShift } from '../src/core/geometry';
import { mulberry32 } from '../src/core/random';

/** 带纹理的随机图（纯噪声峰太弱，加入低频结构）。 */
function texturedImage(n: number, seed: number): Float32Array {
  const rand = mulberry32(seed);
  const img = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      img[y * n + x] =
        0.5 +
        0.2 * Math.sin(x * 0.35) * Math.cos(y * 0.27) +
        0.1 * Math.sin((x + y) * 0.11) +
        (rand() - 0.5) * 0.05;
    }
  }
  return img;
}

describe('相位相关配准', () => {
  // 约定：b = warpShift(a, d) 表示 b(x)=a(x-d)，配准应返回 shift=d，
  // 即对 b 再施加 warpShift(b, -d) 即可与 a 重合。
  it('整数平移被准确检出', () => {
    const n = 256;
    const a = texturedImage(n, 7);
    const b = warpShift(a, n, n, 13, -9);
    const r = phaseCorrelate(a, b, n, n, 256);
    expect(r.shiftX).toBeCloseTo(13, 0);
    expect(r.shiftY).toBeCloseTo(-9, 0);
    expect(r.correlation).toBeGreaterThan(0.5);
    // 用检出的反向平移真的能对齐
    const back = warpShift(b, n, n, -r.shiftX, -r.shiftY);
    let err = 0;
    for (let i = 0; i < a.length; i += 37) err += Math.abs(back[i] - a[i]);
    expect(err / (a.length / 37)).toBeLessThan(0.02);
  });

  it('亚像素平移误差小于 0.3 像素', () => {
    const n = 256;
    const a = texturedImage(n, 21);
    const b = warpShift(a, n, n, 4.6, -2.3);
    const r = phaseCorrelate(a, b, n, n, 256);
    expect(Math.abs(r.shiftX - 4.6)).toBeLessThan(0.3);
    expect(Math.abs(r.shiftY + 2.3)).toBeLessThan(0.3);
  });

  it('无平移时相关峰高且位移接近 0', () => {
    const n = 256;
    const a = texturedImage(n, 99);
    const r = phaseCorrelate(a, a, n, n, 256);
    expect(Math.hypot(r.shiftX, r.shiftY)).toBeLessThan(0.5);
    expect(r.correlation).toBeGreaterThan(0.9);
  });
});
