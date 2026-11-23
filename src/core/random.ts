/** 可复现的随机数与噪声工具（合成数据生成用）。 */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 高斯随机数（Box-Muller），均值 0、标准差 sigma。 */
export function gaussian(rand: () => number, sigma = 1): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * 二维值噪声（周期边界），输出约 [0,1]。
 * 用网格随机顶点 + 双线性平滑，配合多倍频可模拟纸浆云絮/纤维纹理。
 */
export class ValueNoise2D {
  private grid: Float64Array;
  constructor(
    private size: number,
    private period: number,
    rand: () => number,
  ) {
    if (!Number.isInteger(size / period)) {
      throw new Error('size 必须能被 period 整除');
    }
    const cells = size / period;
    this.grid = new Float64Array(cells * cells);
    for (let i = 0; i < this.grid.length; i++) this.grid[i] = rand();
  }

  private cells(): number {
    return this.size / this.period;
  }

  sample(x: number, y: number): number {
    const n = this.cells();
    const gx = ((x % this.size) + this.size) % this.size / this.period;
    const gy = ((y % this.size) + this.size) % this.size / this.period;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = this.smooth(gx - x0);
    const fy = this.smooth(gy - y0);
    const x1 = (x0 + 1) % n;
    const y1 = (y0 + 1) % n;
    const v00 = this.grid[y0 * n + x0];
    const v10 = this.grid[y0 * n + x1];
    const v01 = this.grid[y1 * n + x0];
    const v11 = this.grid[y1 * n + x1];
    const top = v00 + (v10 - v00) * fx;
    const bot = v01 + (v11 - v01) * fx;
    return top + (bot - top) * fy;
  }

  private smooth(t: number): number {
    return t * t * (3 - 2 * t);
  }
}

/** 多倍频值噪声，输出约 [0,1]，amplitude 逐级减半。 */
export function fbm(
  size: number,
  basePeriod: number,
  octaves: number,
  rand: () => number,
): Float32Array {
  const out = new Float32Array(size * size);
  let weightSum = 0;
  let weight = 1;
  for (let o = 0; o < octaves; o++) {
    const period = basePeriod >> o;
    if (period < 2) break;
    const noise = new ValueNoise2D(size, period, rand);
    for (let i = 0; i < out.length; i++) {
      const x = i % size;
      const y = (i / size) | 0;
      out[i] += noise.sample(x, y) * weight;
    }
    weightSum += weight;
    weight *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= weightSum;
  return out;
}
