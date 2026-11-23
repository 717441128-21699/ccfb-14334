/**
 * 浏览器端 GPU 集成测试：真正创建 WebGL2 上下文、编译全部 GLSL 着色器，
 * 跑通 GPU FFT 与完整 GPU 流水线，并与 CPU 参考实现对拍。
 * Node 环境无 WebGL，这部分只能在浏览器里验证。
 */
import { test, expect, type Page } from '@playwright/test';

interface E2eApi {
  GLContext: typeof import('../src/gl/gl-context').GLContext;
  GpuPaperPipeline: typeof import('../src/gl/gpu-pipeline').GpuPaperPipeline;
  runCpuPipeline: typeof import('../src/core/pipeline-cpu').runCpuPipeline;
  generateSyntheticPair: typeof import('../src/core/synthetic').generateSyntheticPair;
  SYNTHETIC_PRESETS: typeof import('../src/core/synthetic').SYNTHETIC_PRESETS;
  DEFAULT_CONFIG: typeof import('../src/core/types').DEFAULT_CONFIG;
  fft2d: typeof import('../src/core/fft').fft2d;
  powerSpectrum: typeof import('../src/core/fft').powerSpectrum;
}

async function getApi(page: Page): Promise<E2eApi> {
  await page.goto('/e2e.html');
  await page.waitForFunction(() => (window as unknown as { paperlineE2e?: E2eApi }).paperlineE2e !== undefined);
  return page.evaluate(() => (window as unknown as { paperlineE2e: E2eApi }).paperlineE2e);
}

test('WebGL2 上下文与浮点纹理可用', async ({ page }) => {
  const hasGl = await page.evaluate(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return false;
    return !!gl.getExtension('EXT_color_buffer_float');
  });
  expect(hasGl).toBe(true);
});

test('GPU FFT 与完整流水线在真实 WebGL2 上正确', async ({ page }) => {
  await getApi(page);
  // 注意：不能把含类构造函数的 API 作为参数传入 evaluate（结构化克隆会丢失），
  // 因此在浏览器上下文内直接读取 window.paperlineE2e。
  const r = await page.evaluate(() => {
    const A = (window as unknown as { paperlineE2e: E2eApi }).paperlineE2e;
    const results: Record<string, unknown> = { checks: [] as unknown[] };
    const ok = (name: string, pass: boolean, detail = '') =>
      (results.checks as unknown[]).push({ name, pass, detail });

    try {
      const n = 16;
      const canvas = document.createElement('canvas');
      canvas.width = n;
      canvas.height = n;
      const ctx = new A.GLContext(canvas);
      results.renderer = ctx.caps.renderer;
      const gl = ctx.gl;

      // CPU 参考功率谱（不加窗，纯 FFT 核对，排除窗函数差异）
      const reCpu = new Float64Array(n * n);
      for (let i = 0; i < n * n; i++) reCpu[i] = Math.sin(i * 0.31) + 0.5;
      const reRef = Float64Array.from(reCpu);
      const imRef = new Float64Array(n * n);
      A.fft2d(reRef, imRef, n, n, false);
      const cpuPower = A.powerSpectrum(reRef, imRef);

      // GPU FFT（同样不加窗：uploadGrayTexture 后直接 fft2d）
      const pipe = new A.GpuPaperPipeline(ctx);
      const fft = (pipe as unknown as {
        fft: {
          fft2d: (a: WebGLTexture, b: WebGLTexture, n: number, d: -1 | 1) => void;
          powerSpectrum: (s: WebGLTexture, d: WebGLTexture, n: number) => void;
        };
      }).fft;
      const input = new Float32Array(n * n);
      for (let i = 0; i < n * n; i++) input[i] = reCpu[i];
      const tex = ctx.uploadGrayTexture(input, n, n);
      const scratch = ctx.createFloatTexture(n);
      const specTex = ctx.createFloatTexture(n);
      fft.fft2d(tex, scratch, n, -1);
      fft.powerSpectrum(tex, specTex, n); // 内部已把 specTex 绑为当前渲染目标
      const gpuPower = ctx.readRed(n);
      // GPU 纹理行序与 CPU 数组一致，无需 Y 翻转
      let maxRel = 0;
      for (let i = 0; i < n * n; i++) {
        maxRel = Math.max(maxRel, Math.abs(gpuPower[i] - cpuPower[i]) / Math.max(1e-3, cpuPower[i]));
      }
      ok('GPU FFT 功率谱 vs CPU（相对误差<5%）', maxRel < 0.05, `maxRel=${maxRel.toExponential(2)}`);

      // 完整流水线四档预设（1024 工作尺寸，与 CPU 精度测试同口径）
      const W = 1024;
      const config = { ...A.DEFAULT_CONFIG, fftSize: W };
      const presetResults: unknown[] = [];
      for (const preset of A.SYNTHETIC_PRESETS) {
        const pair = A.generateSyntheticPair({ seed: 20241124, width: W, height: W, dpi: 600, preset });
        const gpuRes = pipe.run(pair.transmission, pair.reflection, W, W, config);
        const cpuRes = A.runCpuPipeline(pair.transmission, pair.reflection, W, W, config);
        const gtMm = pair.groundTruth.laidPeriodPx * 25.4 / 600;
        presetResults.push({
          preset: preset.name,
          gtMm: Number(gtMm.toFixed(3)),
          gpuMm: Number(gpuRes.record.refinedLaid.periodMm.toFixed(3)),
          cpuMm: Number(cpuRes.record.refinedLaid.periodMm.toFixed(3)),
          gpuErrMm: Number(Math.abs(gpuRes.record.refinedLaid.periodMm - gtMm).toFixed(4)),
        });
      }
      results.presets = presetResults;
      const allWithin = (presetResults as Array<{ gpuErrMm: number }>).every((p) => p.gpuErrMm <= 0.1);
      ok('四档预设 GPU 帘纹误差均 ≤0.1mm', allWithin);

      // 耗时（1024 工作尺寸）
      const pair = A.generateSyntheticPair({ seed: 1, width: W, height: W, dpi: 600, preset: A.SYNTHETIC_PRESETS[1] });
      const t0 = performance.now();
      pipe.run(pair.transmission, pair.reflection, W, W, config);
      results.gpuElapsedMs = Number((performance.now() - t0).toFixed(1));
      ok('GPU 单叶耗时 < 5000ms', results.gpuElapsedMs as number < 5000, `${results.gpuElapsedMs}ms`);

      results.allPassed = (results.checks as Array<{ pass: boolean }>).every((c) => c.pass);
    } catch (e) {
      results.error = (e as Error).message;
      results.allPassed = false;
    }
    return results;
  });

  console.log(JSON.stringify(r, null, 2));
  if (r.error) throw new Error(r.error);
  for (const c of r.checks as Array<{ name: string; pass: boolean; detail: string }>) {
    expect(c.pass, `${c.name} ${c.detail}`).toBe(true);
  }
  expect(r.allPassed).toBe(true);
});
