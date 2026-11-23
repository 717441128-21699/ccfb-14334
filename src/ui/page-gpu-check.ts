/** GPU/CPU 对拍校验页：同一张合成叶子分别走两条流水线，比较关键指标。 */
import { h } from './dom';
import { SYNTHETIC_PRESETS } from '../core/synthetic';
import { runCpuPipeline } from '../core/pipeline-cpu';
import { DEFAULT_CONFIG } from '../core/types';
import { GLContext } from '../gl/gl-context';
import { GpuPaperPipeline } from '../gl/gpu-pipeline';

export function renderGpuCheckPage(): HTMLElement {
  const logBox = h('div', { class: 'log' }, '此页需要 WebGL2 与 EXT_color_buffer_float 支持。');
  const resultBox = h('div');
  const canvas = document.createElement('canvas');
  canvas.width = 2048;
  canvas.height = 2048;
  canvas.style.display = 'none';

  const presetSel = h('select') as HTMLSelectElement;
  for (const p of SYNTHETIC_PRESETS) presetSel.append(h('option', { value: p.name }, p.name));

  function log(m: string): void {
    logBox.textContent += `\n${m}`;
    logBox.scrollTop = logBox.scrollHeight;
  }

  const btn = h('button', {
    class: 'btn',
    onclick: () => {
      log('初始化 WebGL2…');
      setTimeout(() => {
        (async () => {
          try {
            const preset = SYNTHETIC_PRESETS.find((p) => p.name === presetSel.value) ?? SYNTHETIC_PRESETS[0];
            const size = 1024;
            const pair = generatePair(preset, size);
            const config = { ...DEFAULT_CONFIG, fftSize: size };

            // CPU
            const tCpu = performance.now();
            const cpu = runCpuPipeline(pair.transmission, pair.reflection, size, size, config);
            const cpuMs = performance.now() - tCpu;

            // GPU
            const ctx = new GLContext(canvas);
            log(`GPU：${ctx.caps.renderer}，浮点线性过滤=${ctx.caps.floatLinear ? '支持' : '不支持'}`);
            const pipe = new GpuPaperPipeline(ctx);
            const tGpu = performance.now();
            const gpu = pipe.run(pair.transmission, pair.reflection, size, size, config);
            const gpuMs = performance.now() - tGpu;

            renderCompare(resultBox, cpu.record, gpu.record, cpuMs, gpuMs);
            log(`CPU ${cpuMs.toFixed(0)}ms / GPU ${gpuMs.toFixed(0)}ms；` +
              `帘纹 CPU=${cpu.record.refinedLaid.periodMm.toFixed(3)} GPU=${gpu.record.refinedLaid.periodMm.toFixed(3)}mm`);
          } catch (e) {
            log(`错误：${(e as Error).message}`);
          }
        })();
      }, 30);
    },
  }, '运行 GPU/CPU 对拍');

  return h('div', {},
    h('div', { class: 'card' },
      h('h2', {}, 'GPU 与 CPU 参考实现一致性校验'),
      h('div', { class: 'row' },
        h('label', { class: 'field' }, '预设', presetSel), btn),
      h('p', { class: 'muted small' },
        '同一合成叶子分别走 WebGL2 流水线与 CPU 参考流水线，比对帘纹/纲线周期、墨覆盖率与均匀度，验证 GPU 着色器数学正确。'),
      canvas,
    ),
    h('div', { class: 'card' }, resultBox),
    h('div', { class: 'card' }, h('h2', {}, '日志'), logBox),
  );
}

import { generateSyntheticPair } from '../core/synthetic';
import type { LeafRecord } from '../core/types';

function generatePair(preset: (typeof SYNTHETIC_PRESETS)[number], size: number) {
  return generateSyntheticPair({ seed: 20241124, width: size, height: size, dpi: 600, preset });
}

function renderCompare(
  box: HTMLElement,
  cpu: Omit<LeafRecord, 'leafId' | 'timestamp'>,
  gpu: Omit<LeafRecord, 'leafId' | 'timestamp'>,
  cpuMs: number,
  gpuMs: number,
): void {
  const rows: Array<[string, string, string]> = [
    ['帘纹间距(mm)', cpu.refinedLaid.periodMm.toFixed(3), gpu.refinedLaid.periodMm.toFixed(3)],
    ['FFT 帘纹初值(mm)', cpu.laid.periodMm.toFixed(3), gpu.laid.periodMm.toFixed(3)],
    ['纲线间距(mm)', cpu.chain ? cpu.chain.periodMm.toFixed(2) : '—', gpu.chain ? gpu.chain.periodMm.toFixed(2) : '—'],
    ['墨覆盖率', (cpu.inkCoverage * 100).toFixed(1) + '%', (gpu.inkCoverage * 100).toFixed(1) + '%'],
    ['透光均值', cpu.uniformity.meanTransmission.toFixed(3), gpu.uniformity.meanTransmission.toFixed(3)],
    ['均匀度 std', cpu.uniformity.std.toFixed(4), gpu.uniformity.std.toFixed(4)],
    ['耗时(ms)', cpuMs.toFixed(0), gpuMs.toFixed(0)],
  ];
  box.replaceChildren(
    h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, '指标'), h('th', { class: 'num' }, 'CPU'), h('th', { class: 'num' }, 'GPU'))),
      h('tbody', {}, ...rows.map(([k, a, b]) =>
        h('tr', {}, h('td', {}, k), h('td', { class: 'num' }, a), h('td', { class: 'num' }, b)))),
    ),
  );
}
