/**
 * GPU 主流水线：与 src/core/pipeline-cpu.ts 数学等价，
 * 但所有逐像素/逐 texel 运算都在 WebGL2 上完成。
 *
 * 原图（任意宽高）只在最开始做一次降采样到 N×N，
 * 因此 6000×8000 与 2048² 的后续计算量完全相同 —— 5 秒预算的关键。
 */
import { normalizedSpectrum } from '../core/spectral';
import {
  decideLaidLineSpatial,
  detectChainSpatial,
} from '../core/joint';
import {
  refinePeriodByAutocorr,
  rotatedProjection,
} from '../core/projection';
import { computeUniformity } from '../core/uniformity';
import { phaseCorrelate } from '../core/registration';
import { downscaleToSquare } from '../core/pipeline-cpu';
import type {
  AnalysisConfig,
  LeafRecord,
  PeakInfo,
  UniformityMetrics,
} from '../core/types';
import { GLContext } from './gl-context';
import { GpuFFT } from './gpu-fft';
import {
  ALL_VERTEX,
  BOX_BLUR_FS,
  DOWNSCALE_FS,
  FREQ_FILTER_FS,
  INK_FS,
  NORMALIZE_FS,
  PREVIEW_FS,
  REAL_PART_FS,
  RESIDUAL_FS,
  SPEC_DOWNSCALE_FS,
  STATS_FS,
} from './shaders';

export interface GpuStageImages {
  alignedReflection: Float32Array;
  paper: Float32Array;
  inkMask: Float32Array;
  laidComponent: Float32Array;
  chainComponent: Float32Array;
  residual: Float32Array;
  normSpec: Float64Array;
}

export interface GpuPipelineResult {
  record: Omit<LeafRecord, 'leafId' | 'timestamp' | 'files'>;
  stages: GpuStageImages;
}

export class GpuPaperPipeline {
  private fft: GpuFFT;
  private fb: WebGLFramebuffer;
  private progs: Record<string, WebGLProgram> = {};

  constructor(private ctx: GLContext) {
    this.fft = new GpuFFT(ctx);
    this.fb = ctx.createFramebuffer();
    const add = (name: string, fs: string) => {
      this.progs[name] = ctx.compileProgram(name, ALL_VERTEX, fs);
    };
    add('downscale', DOWNSCALE_FS);
    add('blur', BOX_BLUR_FS);
    add('stats', STATS_FS);
    add('ink', INK_FS);
    add('normalize', NORMALIZE_FS);
    add('filter', FREQ_FILTER_FS);
    add('real', REAL_PART_FS);
    add('residual', RESIDUAL_FS);
    add('specDown', SPEC_DOWNSCALE_FS);
    add('preview', PREVIEW_FS);
  }

  private target(tex: WebGLTexture, n: number): void {
    const gl = this.ctx.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, n, n);
  }

  private statsOf(img: Float32Array): { mean: number; std: number; min: number; max: number } {
    let mean = 0;
    for (const v of img) mean += v;
    mean /= img.length;
    let sq = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const v of img) {
      sq += (v - mean) ** 2;
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    return { mean, std: Math.sqrt(sq / img.length), min, max };
  }

  /** 在 64² 统计数据上做 Huber 稳健回归（与 CPU 版同算法）。 */
  private robustRegression64(
    r64: Float32Array,
    t64: Float32Array,
    m64: Float32Array,
    delta: number,
  ): { slope: number; intercept: number; maskedMean: number; coverage: number } {
    const mask = new Uint8Array(m64.length);
    let coverage = 0;
    for (let i = 0; i < mask.length; i++) {
      if (m64[i] > 0.5) {
        mask[i] = 1;
        coverage++;
      }
    }
    coverage /= mask.length;
    let mx = 0;
    let my = 0;
    let cnt = 0;
    for (let i = 0; i < mask.length; i++) {
      if (mask[i]) {
        mx += r64[i];
        my += t64[i];
        cnt++;
      }
    }
    if (cnt < 8) return { slope: 0, intercept: my / Math.max(1, cnt), maskedMean: mx / Math.max(1, cnt), coverage };
    mx /= cnt;
    my /= cnt;
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      sxx += (r64[i] - mx) ** 2;
      sxy += (r64[i] - mx) * (t64[i] - my);
    }
    let slope = sxx > 1e-12 ? sxy / sxx : 0;
    let intercept = my - slope * mx;
    for (let iter = 0; iter < 2; iter++) {
      let residSq = 0;
      for (let i = 0; i < mask.length; i++) {
        if (!mask[i]) continue;
        residSq += (t64[i] - (slope * r64[i] + intercept)) ** 2;
      }
      const sigma = Math.sqrt(residSq / cnt) + 1e-9;
      let wmx = 0;
      let wmy = 0;
      let w = 0;
      const weights = new Float32Array(mask.length);
      for (let i = 0; i < mask.length; i++) {
        if (!mask[i]) continue;
        const r = Math.abs(t64[i] - (slope * r64[i] + intercept)) / sigma;
        weights[i] = r <= delta ? 1 : delta / r;
        wmx += weights[i] * r64[i];
        wmy += weights[i] * t64[i];
        w += weights[i];
      }
      wmx /= w;
      wmy /= w;
      let wsxx = 0;
      let wsxy = 0;
      for (let i = 0; i < mask.length; i++) {
        if (!mask[i]) continue;
        wsxx += weights[i] * (r64[i] - wmx) ** 2;
        wsxy += weights[i] * (r64[i] - wmx) * (t64[i] - wmy);
      }
      slope = wsxx > 1e-12 ? wsxy / wsxx : 0;
      intercept = wmy - slope * wmx;
    }
    let maskedMean = 0;
    let mc = 0;
    for (let i = 0; i < mask.length; i++) {
      if (mask[i]) {
        maskedMean += r64[i];
        mc++;
      }
    }
    return { slope, intercept, maskedMean: mc ? maskedMean / mc : mx, coverage };
  }

  /**
   * 主入口。transmission/reflection 为同尺寸灰度 Float32（0..1，行主序首行在上）。
   */
  run(
    transmission: Float32Array,
    reflection: Float32Array,
    width: number,
    height: number,
    config: AnalysisConfig,
  ): GpuPipelineResult {
    const t0 = performance.now();
    const gl = this.ctx.gl;
    const n = config.fftSize;
    if (n > this.ctx.caps.maxTextureSize) {
      throw new Error(`FFT 尺寸 ${n} 超过 GPU 纹理上限 ${this.ctx.caps.maxTextureSize}`);
    }

    // ---------- 1. 配准（CPU 相位相关，512² 降采样） ----------
    const regN = 512;
    const tReg = downscaleToSquare(transmission, width, height, regN);
    const rReg = downscaleToSquare(reflection, width, height, regN);
    const reg = phaseCorrelate(tReg, rReg, regN, regN, regN);

    // ---------- 2. 上传原图并 GPU 降采样到 N×N（反射图同时施加配准平移） ----------
    const srcT = this.ctx.uploadGrayTexture(transmission, width, height);
    const srcR = this.ctx.uploadGrayTexture(reflection, width, height);
    const texT = this.ctx.createFloatTexture(n);
    const texR = this.ctx.createFloatTexture(n);
    const origPxPerWorkPx = Math.min(width, height) / n;
    const shiftWorkX = reg.shiftX * origPxPerWorkPx;
    const shiftWorkY = reg.shiftY * origPxPerWorkPx;

    this.target(texT, n);
    this.ctx.draw(this.progs.downscale, [{ tex: srcT, unit: 0, name: 'uSrc' }], (loc) => {
      gl.uniform2f(loc('uSrcSize'), width, height);
      gl.uniform1f(loc('uN'), n);
      gl.uniform2f(loc('uShift'), 0, 0);
    });
    this.target(texR, n);
    this.ctx.draw(this.progs.downscale, [{ tex: srcR, unit: 0, name: 'uSrc' }], (loc) => {
      gl.uniform2f(loc('uSrcSize'), width, height);
      gl.uniform1f(loc('uN'), n);
      gl.uniform2f(loc('uShift'), shiftWorkX, shiftWorkY);
    });
    this.ctx.destroyTexture(srcT);
    this.ctx.destroyTexture(srcR);

    // ---------- 3. 反射图局部均值（两遍盒式模糊） ----------
    const texBlurA = this.ctx.createFloatTexture(n);
    const texBlurB = this.ctx.createFloatTexture(n);
    const radius = Math.max(8, Math.round(n / 64));
    this.target(texBlurA, n);
    this.ctx.draw(this.progs.blur, [{ tex: texR, unit: 0, name: 'uSrc' }], (loc) => {
      gl.uniform1f(loc('uN'), n);
      gl.uniform2f(loc('uDir'), 1, 0);
      gl.uniform1i(loc('uRadius'), radius);
    });
    this.target(texBlurB, n);
    this.ctx.draw(this.progs.blur, [{ tex: texBlurA, unit: 0, name: 'uSrc' }], (loc) => {
      gl.uniform1f(loc('uN'), n);
      gl.uniform2f(loc('uDir'), 0, 1);
      gl.uniform1i(loc('uRadius'), radius);
    });

    // ---------- 4. 64² 统计：均值/标准差/墨掩码/稳健回归 ----------
    const statT = this.ctx.createFloatTexture(64);
    const statR = this.ctx.createFloatTexture(64);
    const statB = this.ctx.createFloatTexture(64);
    const drawStats = (src: WebGLTexture, dst: WebGLTexture) => {
      this.target(dst, 64);
      this.ctx.draw(this.progs.stats, [{ tex: src, unit: 0, name: 'uSrc' }], (loc) => {
        gl.uniform1f(loc('uN'), n);
      });
    };
    drawStats(texT, statT);
    drawStats(texR, statR);
    drawStats(texBlurB, statB);
    // 每次读回前必须重新绑定对应纹理：drawStats 会切换 framebuffer，
    // 否则三次 readRed 读到的都是最后绑定的 statB。
    const readStat = (tex: WebGLTexture): Float32Array => {
      this.target(tex, 64);
      return this.ctx.readRed(64);
    };
    const t64 = readStat(statT);
    const r64 = readStat(statR);
    const b64 = readStat(statB);
    const rStats = this.statsOf(r64);
    // 与 CPU 版一致：硬掩码完全基于相对局部背景的暗化程度
    const threshold = rStats.mean; // 仅用于 uniform 兼容，着色器不再依赖
    const m64 = new Float32Array(64 * 64);
    for (let i = 0; i < m64.length; i++) {
      const deficit = b64[i] - r64[i];
      const m = Math.min(1, Math.max(0, (deficit / Math.max(1e-3, b64[i]) - 0.12) / 0.12));
      m64[i] = m > 0.6 ? 1 : 0;
    }
    const reg2 = this.robustRegression64(r64, t64, m64, config.huberDelta);

    // ---------- 5. 扣墨（GPU） ----------
    const texInk = this.ctx.createFloatTexture(n);
    this.target(texInk, n);
    this.ctx.draw(
      this.progs.ink,
      [
        { tex: texT, unit: 0, name: 'uT' },
        { tex: texR, unit: 1, name: 'uR' },
        { tex: texBlurB, unit: 2, name: 'uRBlur' },
      ],
      (loc) => {
        gl.uniform1f(loc('uRMean'), rStats.mean);
        gl.uniform1f(loc('uRStd'), rStats.std);
        gl.uniform1f(loc('uSlope'), reg2.slope);
        gl.uniform1f(loc('uRMaskedMean'), reg2.maskedMean);
        gl.uniform1f(loc('uThreshold'), threshold);
      },
    );
    const inkRead = this.ctx.readRed(n);
    const inkStats = this.statsOf(inkRead);
    const texPaper = this.ctx.createFloatTexture(n);
    this.target(texPaper, n);
    this.ctx.draw(this.progs.normalize, [{ tex: texInk, unit: 0, name: 'uSrc' }], (loc) => {
      gl.uniform1f(loc('uMin'), inkStats.min);
      gl.uniform1f(loc('uSpan'), inkStats.max - inkStats.min);
    });

    // ---------- 6. Hann + 二维 FFT + 功率谱 ----------
    const texComplexA = this.ctx.createFloatTexture(n);
    const texComplexB = this.ctx.createFloatTexture(n);
    const texSpec = this.ctx.createFloatTexture(n);
    this.fft.applyHann(texPaper, texComplexA, n);
    this.fft.fft2d(texComplexA, texComplexB, n, -1);
    this.fft.powerSpectrum(texComplexA, texSpec, n);

    // 频谱降到 512² 读回，仅用于产出归一化谱（诊断/可视化）与频域分量分离
    const specN = 512;
    const texSpecSmall = this.ctx.createFloatTexture(specN);
    this.target(texSpecSmall, specN);
    this.ctx.draw(this.progs.specDown, [{ tex: texSpec, unit: 0, name: 'uSrc' }], (loc) => {
      gl.uniform1f(loc('uN'), n);
      gl.uniform1f(loc('uOut'), specN);
      gl.uniform1i(loc('uCenter'), 1);
    });
    const specSmall = this.ctx.readRed(specN);
    const normSpecSmall = normalizedSpectrum(
      Float64Array.from(specSmall), specN,
    );
    const mmPerPx = (25.4 / config.dpi) * origPxPerWorkPx;

    // ---------- 7. 空间域帘纹/纲线判定（与 CPU 流水线同一套函数，保证一致）---
    // 读纸基前必须重新绑定 texPaper：上面的频谱降采样已把 framebuffer 切到 512² 纹理
    this.target(texPaper, n);
    const paperCpu = this.ctx.readRed(n);
    const decision = decideLaidLineSpatial(paperCpu, {
      n,
      mmPerPx,
      laidPeriodMmRange: config.laidPeriodMmRange,
      orientationHint: config.orientationHint,
    });
    const laid = decision.laid;
    const chainHit = detectChainSpatial(
      paperCpu, laid.orientationRad, n, mmPerPx, config.chainPeriodMmRange,
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
    const laidBinX = laid.binX;
    const laidBinY = laid.binY;
    const chainBinX = chain ? chain.binX : 0;
    const chainBinY = chain ? chain.binY : 0;

    // ---------- 8. 空间域投影精修 ----------
    const proj = rotatedProjection(paperCpu, n, laid.orientationRad);
    const refined = refinePeriodByAutocorr(proj, laid.periodPx, mmPerPx);

    // ---------- 8. 频域分离帘纹/纲线（逆 FFT） ----------
    const extractComponent = (
      binX: number,
      binY: number,
    ): WebGLTexture => {
      const texFiltered = this.ctx.createFloatTexture(n);
      const texOut = this.ctx.createFloatTexture(n);
      // texComplexA 为自然序频谱；binX/binY 是 DC 居中坐标，着色器内部换算
      this.target(texFiltered, n);
      const peak1 = [binX, binY];
      const peak2 = [-binX, -binY];
      this.ctx.draw(this.progs.filter, [{ tex: texComplexA, unit: 0, name: 'uSrc' }], (loc) => {
        gl.uniform1f(loc('uN'), n);
        gl.uniform2f(loc('uPeak1'), peak1[0], peak1[1]);
        gl.uniform2f(loc('uPeak2'), peak2[0], peak2[1]);
        gl.uniform1f(loc('uSigma'), config.maskSigmaBins);
        // 逆 FFT 每个方向需除一次 N；FREQ_FILTER 在二维逆变换前统一乘 1/N，
        // 水平、纵向两个方向的逆 DIT 合起来即 1/N² 归一化。
        gl.uniform1f(loc('uInvN'), 1 / n);
      });
      this.fft.fft2d(texFiltered, texComplexB, n, 1);
      this.target(texOut, n);
      this.ctx.draw(this.progs.real, [{ tex: texFiltered, unit: 0, name: 'uSrc' }]);
      this.ctx.destroyTexture(texFiltered);
      return texOut;
    };
    const texLaid = extractComponent(laidBinX, laidBinY);
    const texChain = chain
      ? extractComponent(chainBinX, chainBinY)
      : (() => { const t = this.ctx.createFloatTexture(n); return t; })();

    // ---------- 9. 残差与均匀度 ----------
    const texResidual = this.ctx.createFloatTexture(n);
    this.target(texResidual, n);
    this.ctx.draw(
      this.progs.residual,
      [
        { tex: texPaper, unit: 0, name: 'uPaper' },
        { tex: texLaid, unit: 1, name: 'uLaid' },
        { tex: texChain, unit: 2, name: 'uChain' },
      ],
    );

    // 每个结果纹理单独绑定后读回（readRed 不会自动切换 framebuffer）
    const readTex = (tex: WebGLTexture): Float32Array => {
      this.target(tex, n);
      return this.ctx.readRed(n);
    };
    const laidCpu = readTex(texLaid);
    const chainCpu = readTex(texChain);
    const residualCpu = readTex(texResidual);
    const alignedRCpu = readTex(texR);
    // 墨掩码从 ink 纹理 G 通道读
    this.target(texInk, n);
    const inkRG = this.ctx.readRG(n);
    const inkMaskCpu = new Float32Array(n * n);
    for (let i = 0; i < n * n; i++) inkMaskCpu[i] = inkRG[i * 2 + 1];

    const uniformity: UniformityMetrics = computeUniformity(residualCpu, n);

    const stages: GpuStageImages = {
      alignedReflection: alignedRCpu,
      paper: paperCpu,
      inkMask: inkMaskCpu,
      laidComponent: laidCpu,
      chainComponent: chainCpu,
      residual: residualCpu,
      normSpec: normSpecSmall,
    };

    const record = {
      imageSize: { width, height },
      registration: reg,
      inkCoverage: reg2.coverage,
      laid,
      chain,
      refinedLaid: refined,
      uniformity,
      effectiveDpi: config.dpi / origPxPerWorkPx,
      fftSize: n,
      elapsedMs: performance.now() - t0,
    };

    // 释放本叶计算纹理（画布与上下文保留）
    [
      texT, texR, texBlurA, texBlurB, statT, statR, statB,
      texInk, texPaper, texComplexA, texComplexB, texSpec,
      texSpecSmall, texLaid, texChain, texResidual,
    ].forEach((t) => this.ctx.destroyTexture(t));

    return { record, stages };
  }

  /** 把某张 R32F 结果编码到 RGBA8 画布供 UI 展示。 */
  renderPreview(
    tex: WebGLTexture,
    targetCanvas: HTMLCanvasElement,
    mode: 0 | 1 | 2,
    gain = 1,
  ): void {
    const gl = this.ctx.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, targetCanvas.width, targetCanvas.height);
    this.ctx.draw(this.progs.preview, [{ tex, unit: 0, name: 'uSrc' }], (loc) => {
      gl.uniform1i(loc('uMode'), mode);
      gl.uniform1f(loc('uGain'), gain);
    });
  }
}
