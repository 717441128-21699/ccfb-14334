/**
 * 相位相关配准（CPU FFT 实现，用于 512² 降采样图）。
 * 返回「应作用于第二张图（反射图）的平移量」，即 warp 时采样 (x-dx, y-dy)。
 */
import { fft2d } from './fft';
import { hann1d, parabolaOffset } from './geometry';
import type { RegistrationResult } from './types';

function windowedCrop(img: Float32Array, w: number, h: number, n: number): Float64Array {
  const out = new Float64Array(n * n);
  const x0 = Math.max(0, ((w - n) / 2) | 0);
  const y0 = Math.max(0, ((h - n) / 2) | 0);
  const winX = hann1d(n);
  const winY = hann1d(n);
  for (let y = 0; y < n; y++) {
    const sy = Math.min(y0 + y, h - 1);
    for (let x = 0; x < n; x++) {
      const sx = Math.min(x0 + x, w - 1);
      out[y * n + x] = img[sy * w + sx] * winX[x] * winY[y];
    }
  }
  return out;
}

/**
 * 频域白化：除以 |F| 并做高通（对周期纸纹尤其关键，
 * 否则纸纹的强峰会压制真正的平移峰）。
 * 在已经 FFT 过的数组上原地处理，返回供相位相关使用的白化谱。
 */
function whiten(re: Float64Array, im: Float64Array, n: number): void {
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = x > n / 2 ? x - n : x;
      const dy = y > n / 2 ? y - n : y;
      const r = Math.hypot(dx, dy);
      const mag = Math.hypot(re[y * n + x], im[y * n + x]);
      // r<3 的直流/极低频直接置零
      const hp = r < 3 ? 0 : 1;
      const denom = mag + 1e-6;
      const idx = y * n + x;
      re[idx] = (re[idx] / denom) * hp;
      im[idx] = (im[idx] / denom) * hp;
    }
  }
}

/**
 * 相位相关。a、b 为同尺寸灰度图（任意尺寸，内部中心裁剪到 n×n），
 * n 为 2 的幂。
 *
 * 位移约定与 geometry.warpShift 一致：若 b(x) = a(x − d)，
 * 本函数返回 shift = d，即对 b 调用 warpShift(b, -shift) 可对齐到 a。
 */
export function phaseCorrelate(
  a: Float32Array,
  b: Float32Array,
  w: number,
  h: number,
  n = 512,
): RegistrationResult {
  const reA = windowedCrop(a, w, h, n);
  const reB = windowedCrop(b, w, h, n);
  const imA = new Float64Array(n * n);
  const imB = new Float64Array(n * n);
  fft2d(reA, imA, n, n, false);
  fft2d(reB, imB, n, n, false);
  whiten(reA, imA, n);
  whiten(reB, imB, n);

  // 互功率谱 R = conj(A)·B / |conj(A)·B|（白化后两谱模≈1）
  const rRe = new Float64Array(n * n);
  const rIm = new Float64Array(n * n);
  for (let i = 0; i < n * n; i++) {
    const cr = reA[i] * reB[i] + imA[i] * imB[i];
    const ci = reA[i] * imB[i] - imA[i] * reB[i];
    const mag = Math.hypot(cr, ci);
    if (mag > 1e-12) {
      rRe[i] = cr / mag;
      rIm[i] = ci / mag;
    }
  }
  fft2d(rRe, rIm, n, n, true);

  // 找峰并做亚像素抛物线插值
  let peak = -Infinity;
  let px = 0;
  let py = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const v = rRe[y * n + x];
      if (v > peak) {
        peak = v;
        px = x;
        py = y;
      }
    }
  }
  const at = (x: number, y: number) =>
    rRe[((y + n) % n) * n + ((x + n) % n)];
  const subX = parabolaOffset(at(px - 1, py), at(px, py), at(px + 1, py));
  const subY = parabolaOffset(at(px, py - 1), at(px, py), at(px, py + 1));
  let shiftX = px + subX;
  let shiftY = py + subY;
  if (shiftX > n / 2) shiftX -= n;
  if (shiftY > n / 2) shiftY -= n;

  return { shiftX, shiftY, correlation: Math.max(0, Math.min(1, peak)) };
}
