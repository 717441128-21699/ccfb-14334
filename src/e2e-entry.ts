/**
 * E2E 专用入口：把需要在真实浏览器里验证的 GPU/CPU 能力挂到 window，
 * 由 Playwright 通过 page.evaluate 调用。仅被 e2e.html 引用。
 */
import { GLContext } from './gl/gl-context';
import { GpuPaperPipeline } from './gl/gpu-pipeline';
import { runCpuPipeline } from './core/pipeline-cpu';
import { generateSyntheticPair, SYNTHETIC_PRESETS } from './core/synthetic';
import { DEFAULT_CONFIG } from './core/types';
import { fft2d, powerSpectrum } from './core/fft';

declare global {
  interface Window {
    paperlineE2e: {
      GLContext: typeof GLContext;
      GpuPaperPipeline: typeof GpuPaperPipeline;
      runCpuPipeline: typeof runCpuPipeline;
      generateSyntheticPair: typeof generateSyntheticPair;
      SYNTHETIC_PRESETS: typeof SYNTHETIC_PRESETS;
      DEFAULT_CONFIG: typeof DEFAULT_CONFIG;
      fft2d: typeof fft2d;
      powerSpectrum: typeof powerSpectrum;
    };
  }
}

window.paperlineE2e = {
  GLContext,
  GpuPaperPipeline,
  runCpuPipeline,
  generateSyntheticPair,
  SYNTHETIC_PRESETS,
  DEFAULT_CONFIG,
  fft2d,
  powerSpectrum,
};
