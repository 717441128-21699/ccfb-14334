/**
 * GPU FFT 执行器：迭代 Cooley-Tukey radix-2 DIT，
 * 复数存于 RG32F 纹理。每个轴先做位反转重排，再跑 log2(N) 个蝶形 pass，
 * 水平、纵向各一轮，纹理间 ping-pong 交换。
 */
import { GLContext } from './gl-context';
import {
  ALL_VERTEX,
  FFT_BITREV_FS,
  FFT_STAGE_FS,
  HANN_FS,
  POWER_FS,
} from './shaders';

export class GpuFFT {
  private programHann: WebGLProgram;
  private programBitrev: WebGLProgram;
  private programStage: WebGLProgram;
  private programPower: WebGLProgram;
  private fb: WebGLFramebuffer;

  constructor(private ctx: GLContext) {
    this.programHann = ctx.compileProgram('hann', ALL_VERTEX, HANN_FS);
    this.programBitrev = ctx.compileProgram('fft-bitrev', ALL_VERTEX, FFT_BITREV_FS);
    this.programStage = ctx.compileProgram('fft-stage', ALL_VERTEX, FFT_STAGE_FS);
    this.programPower = ctx.compileProgram('power', ALL_VERTEX, POWER_FS);
    this.fb = ctx.createFramebuffer();
  }

  private bindTarget(tex: WebGLTexture, n: number): void {
    const gl = this.ctx.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, n, n);
  }

  /** 灰度 RG32F（R 通道）→ Hann 加窗后的复数 RG32F（虚部 G 置 0）。 */
  applyHann(src: WebGLTexture, dst: WebGLTexture, n: number): void {
    this.bindTarget(dst, n);
    this.ctx.draw(this.programHann, [{ tex: src, unit: 0, name: 'uSrc' }]);
  }

  /**
   * 二维 FFT（原地语义：输入 inTex，结果写回 inTex）。
   * @param dir -1 正变换（不归一化，与 CPU 一致）/ +1 逆变换（归一化由调用方处理）
   */
  fft2d(
    inTex: WebGLTexture,
    scratch: WebGLTexture,
    n: number,
    dir: -1 | 1,
  ): void {
    const gl = this.ctx.gl;
    const stages = Math.log2(n);
    let src = inTex;
    let dst = scratch;
    const swap = (): void => {
      const t = src;
      src = dst;
      dst = t;
    };

    for (let axis = 0; axis < 2; axis++) {
      // 位反转重排（1 个 pass）
      this.bindTarget(dst, n);
      gl.useProgram(this.programBitrev);
      this.ctx.draw(
        this.programBitrev,
        [{ tex: src, unit: 0, name: 'uSrc' }],
        (loc) => {
          gl.uniform1f(loc('uN'), n);
          gl.uniform1i(loc('uAxis'), axis);
        },
      );
      swap();

      // 蝶形级
      for (let stage = 0; stage < stages; stage++) {
        this.bindTarget(dst, n);
        gl.useProgram(this.programStage);
        this.ctx.draw(
          this.programStage,
          [{ tex: src, unit: 0, name: 'uSrc' }],
          (loc) => {
            gl.uniform1f(loc('uN'), n);
            gl.uniform1i(loc('uStage'), stage);
            gl.uniform1i(loc('uDir'), dir);
            gl.uniform1i(loc('uAxis'), axis);
          },
        );
        swap();
      }
    }
    // 每轴 (1 + stages) 个 pass，两轴共偶数次交换，结果回到 inTex
    if (src !== inTex) {
      throw new Error('FFT ping-pong 交换计数异常');
    }
  }

  /** 功率谱：复数 RG32F → RG32F（R=功率，G=0）。 */
  powerSpectrum(src: WebGLTexture, dst: WebGLTexture, n: number): void {
    this.bindTarget(dst, n);
    this.ctx.draw(this.programPower, [{ tex: src, unit: 0, name: 'uSrc' }]);
  }
}
