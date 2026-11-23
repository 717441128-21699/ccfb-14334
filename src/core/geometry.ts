/** 几何与插值小工具。 */

export function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

/** 把角度规范到 (-π, π]。 */
export function normalizeAngle(a: number): number {
  let r = a % (2 * Math.PI);
  if (r <= -Math.PI) r += 2 * Math.PI;
  if (r > Math.PI) r -= 2 * Math.PI;
  return r;
}

/** 两角最小夹角（绝对值 ≤ π）。 */
export function angleDiff(a: number, b: number): number {
  return normalizeAngle(a - b);
}

/**
 * 三点抛物线顶点相对中心点的偏移量。
 * 给定 y[-1], y[0], y[+1]，返回顶点 x*（-1..1）。
 */
export function parabolaOffset(yMinus: number, y0: number, yPlus: number): number {
  const denom = yMinus - 2 * y0 + yPlus;
  if (Math.abs(denom) < 1e-12) return 0;
  return 0.5 * (yMinus - yPlus) / denom;
}

/** Hann 窗（一维）。 */
export function hann1d(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

/** 双线性采样（edge clamp）。 */
export function sampleBilinear(
  img: ArrayLike<number>,
  w: number,
  h: number,
  x: number,
  y: number,
): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const cx = (v: number) => Math.min(Math.max(v, 0), w - 1);
  const cy = (v: number) => Math.min(Math.max(v, 0), h - 1);
  const i00 = cy(y0) * w + cx(x0);
  const i10 = cy(y0) * w + cx(x0 + 1);
  const i01 = cy(y0 + 1) * w + cx(x0);
  const i11 = cy(y0 + 1) * w + cx(x0 + 1);
  const top = img[i00] * (1 - fx) + img[i10] * fx;
  const bot = img[i01] * (1 - fx) + img[i11] * fx;
  return top * (1 - fy) + bot * fy;
}

/** 按平移量 dx/dy 重采样（edge clamp），输出新数组。 */
export function warpShift(
  img: Float32Array,
  w: number,
  h: number,
  dx: number,
  dy: number,
): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      out[y * w + x] = sampleBilinear(img, w, h, x - dx, y - dy);
    }
  }
  return out;
}

/** 均值滤波（可分离盒式，r 为半径），用于局部均值/模糊。 */
export function boxBlur(img: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  // 水平
  for (let y = 0; y < h; y++) {
    let acc = 0;
    const off = y * w;
    for (let x = -r; x <= r; x++) acc += img[off + Math.min(Math.max(x, 0), w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[off + x] = acc / (2 * r + 1);
      const xAdd = Math.min(x + r + 1, w - 1);
      const xSub = Math.max(x - r, 0);
      acc += img[off + xAdd] - img[off + xSub];
    }
  }
  // 垂直
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(Math.max(y, 0), h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / (2 * r + 1);
      const yAdd = Math.min(y + r + 1, h - 1);
      const ySub = Math.max(y - r, 0);
      acc += tmp[yAdd * w + x] - tmp[ySub * w + x];
    }
  }
  return out;
}
