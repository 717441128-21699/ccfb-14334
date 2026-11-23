/**
 * 性能计时页：验证「6000×8000 叶子 ≤5 秒」预算。
 * 用合成器在内存造全分辨率叶子（不落盘），分段计时 GPU 流水线。
 */
import { h } from './dom';
import { SYNTHETIC_PRESETS } from '../core/synthetic';
import { DEFAULT_CONFIG } from '../core/types';
import { GLContext } from '../gl/gl-context';
import { GpuPaperPipeline } from '../gl/gpu-pipeline';
import { generateSyntheticPair } from '../core/synthetic';

export function renderTimingPage(): HTMLElement {
  const logBox = h('div', { class: 'log' }, '选择分辨率后运行。');
  const resultBox = h('div');
  const canvas = document.createElement('canvas');
  canvas.width = 2048;
  canvas.height = 2048;
  canvas.style.display = 'none';

  const wInput = h('input', { type: 'number', value: '6000', step: '500' }) as HTMLInputElement;
  const hInput = h('input', { type: 'number', value: '8000', step: '500' }) as HTMLInputElement;
  const fftSel = h('select') as HTMLSelectElement;
  for (const n of [1024, 2048]) fftSel.append(h('option', { value: String(n) }, `FFT ${n}²`));
  fftSel.value = '2048';
  const presetSel = h('select') as HTMLSelectElement;
  for (const p of SYNTHETIC_PRESETS) presetSel.append(h('option', { value: p.name }, p.name));

  function log(m: string): void {
    logBox.textContent += `\n${m}`;
    logBox.scrollTop = logBox.scrollHeight;
  }

  const btn = h('button', {
    class: 'btn',
    onclick: () => {
      const W = Number(wInput.value);
      const H = Number(hInput.value);
      const fftSize = Number(fftSel.value);
      const preset = SYNTHETIC_PRESETS.find((p) => p.name === presetSel.value) ?? SYNTHETIC_PRESETS[1];
      log(`生成 ${W}×${H} 合成叶子（约 ${(W * H * 4 / 1e6).toFixed(0)}MB/通道）…`);
      setTimeout(() => {
        try {
          const tGen0 = performance.now();
          const pair = generateSyntheticPair({
            seed: 20241124, width: W, height: H, dpi: 600, preset,
          });
          const genMs = performance.now() - tGen0;
          log(`合成耗时 ${genMs.toFixed(0)}ms（不计入分析预算）。初始化 GPU…`);

          const ctx = new GLContext(canvas);
          const pipe = new GpuPaperPipeline(ctx);
          // 预热一次（编译/分配）
          log(`GPU：${ctx.caps.renderer}`);

          const runs: number[] = [];
          let last: ReturnType<GpuPaperPipeline['run']> | null = null;
          for (let i = 0; i < 3; i++) {
            const t0 = performance.now();
            last = pipe.run(pair.transmission, pair.reflection, W, H, {
              ...DEFAULT_CONFIG, fftSize,
            });
            runs.push(performance.now() - t0);
          }
          const best = Math.min(...runs);
          const avg = runs.reduce((a, b) => a + b, 0) / runs.length;
          renderTiming(resultBox, W, H, fftSize, runs, best, avg, last!.record);
          log(`三次耗时 ${runs.map((x) => x.toFixed(0)).join(' / ')}ms；最优 ${best.toFixed(0)}ms，` +
            (best <= 5000 ? '✓ 满足 ≤5s 预算' : '✗ 超出 5s 预算'));
        } catch (e) {
          log(`错误：${(e as Error).message}`);
        }
      }, 30);
    },
  }, '运行计时（3 次取最优）');

  return h('div', {},
    h('div', { class: 'card' },
      h('h2', {}, '全分辨率性能计时'),
      h('div', { class: 'row' },
        h('label', { class: 'field' }, '宽(px)', wInput),
        h('label', { class: 'field' }, '高(px)', hInput),
        h('label', { class: 'field' }, 'FFT 工作尺寸', fftSel),
        h('label', { class: 'field' }, '预设', presetSel),
        btn),
      h('p', { class: 'muted small' },
        '原图仅在起始做一次降采样，后续 FFT/滤波在固定 1024² 或 2048² 上进行，因此分析耗时与原图分辨率基本无关。'),
      canvas,
    ),
    h('div', { class: 'card' }, resultBox),
    h('div', { class: 'card' }, h('h2', {}, '日志'), logBox),
  );
}

import type { LeafRecord } from '../core/types';

function renderTiming(
  box: HTMLElement,
  W: number,
  H: number,
  fftSize: number,
  runs: number[],
  best: number,
  avg: number,
  rec: LeafRecord | Omit<LeafRecord, 'leafId' | 'timestamp' | 'files'>,
): void {
  const within = best <= 5000;
  box.replaceChildren(
    h('div', { class: 'metric-grid' },
      metric('输入尺寸', `${W}×${H}`),
      metric('FFT 工作尺寸', `${fftSize}²`),
      metric('最优耗时', `${best.toFixed(0)} ms`, within ? 'good' : 'bad'),
      metric('平均耗时', `${avg.toFixed(0)} ms`),
      metric('5 秒预算', within ? '达标' : '超标', within ? 'good' : 'bad'),
      metric('帘纹间距', `${rec.refinedLaid.periodMm.toFixed(3)} mm`),
    ),
    h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, '运行'), h('th', { class: 'num' }, '耗时(ms)'))),
      h('tbody', {}, ...runs.map((t, i) =>
        h('tr', {}, h('td', {}, `第 ${i + 1} 次`), h('td', { class: 'num' }, t.toFixed(0)))))),
  );
}

function metric(k: string, v: string, tone?: 'good' | 'bad'): HTMLElement {
  return h('div', { class: 'metric' },
    h('div', { class: 'k' }, k),
    h('div', { class: `v ${tone === 'good' ? 'pill good' : tone === 'bad' ? 'pill bad' : ''}` }, v));
}
