/**
 * CPU 端 FFT 参考实现（radix-2 Cooley-Tukey，Float64 原地运算）。
 * 用途：
 *  1. 相位相关配准（512² 级别，CPU 足够快）；
 *  2. 与 GPU FFT 对拍的基准（应用内校验页 + Vitest 与朴素 DFT 对拍）；
 *  3. CPU 参考流水线，保证测试不依赖 WebGL。
 */

export function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

/** 一维 FFT/IFFT，原地。inverse=true 时输出已除以 N。 */
export function fft1d(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  if (!isPowerOfTwo(n)) throw new Error(`FFT 长度必须是 2 的幂，收到 ${n}`);
  if (im.length !== n) throw new Error('虚实部长度不一致');

  // 位反转置换
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }

  const sign = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = (2 * Math.PI / len) * sign;
    const wBaseR = Math.cos(ang);
    const wBaseI = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wR = 1;
      let wI = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const vR = re[b] * wR - im[b] * wI;
        const vI = re[b] * wI + im[b] * wR;
        const uR = re[a];
        const uI = im[a];
        re[a] = uR + vR;
        im[a] = uI + vI;
        re[b] = uR - vR;
        im[b] = uI - vI;
        const nextR = wR * wBaseR - wI * wBaseI;
        wI = wR * wBaseI + wI * wBaseR;
        wR = nextR;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/** 二维 FFT：先行后列，原地。输入输出均为行主序 length = w*h。 */
export function fft2d(
  re: Float64Array,
  im: Float64Array,
  w: number,
  h: number,
  inverse: boolean,
): void {
  if (!isPowerOfTwo(w) || !isPowerOfTwo(h)) throw new Error('FFT 宽高必须是 2 的幂');
  const rowRe = new Float64Array(w);
  const rowIm = new Float64Array(w);
  for (let y = 0; y < h; y++) {
    const off = y * w;
    for (let x = 0; x < w; x++) {
      rowRe[x] = re[off + x];
      rowIm[x] = im[off + x];
    }
    fft1d(rowRe, rowIm, inverse);
    for (let x = 0; x < w; x++) {
      re[off + x] = rowRe[x];
      im[off + x] = rowIm[x];
    }
  }
  const colRe = new Float64Array(h);
  const colIm = new Float64Array(h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      colRe[y] = re[y * w + x];
      colIm[y] = im[y * w + x];
    }
    fft1d(colRe, colIm, inverse);
    for (let y = 0; y < h; y++) {
      re[y * w + x] = colRe[y];
      im[y * w + x] = colIm[y];
    }
  }
}

/** 功率谱 |F|²，行主序。 */
export function powerSpectrum(re: ArrayLike<number>, im: ArrayLike<number>): Float64Array {
  const n = re.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = re[i] * re[i] + im[i] * im[i];
  return out;
}

/** 朴素一维 DFT，仅用于测试对拍（O(N²)）。 */
export function naiveDft1d(re: ArrayLike<number>, im: ArrayLike<number>, inverse: boolean) {
  const n = re.length;
  const outR = new Float64Array(n);
  const outI = new Float64Array(n);
  const sign = inverse ? 1 : -1;
  for (let k = 0; k < n; k++) {
    let sr = 0;
    let si = 0;
    for (let t = 0; t < n; t++) {
      const ang = sign * 2 * Math.PI * k * t / n;
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      sr += re[t] * c - im[t] * s;
      si += re[t] * s + im[t] * c;
    }
    if (inverse) { sr /= n; si /= n; }
    outR[k] = sr;
    outI[k] = si;
  }
  return { re: outR, im: outI };
}
