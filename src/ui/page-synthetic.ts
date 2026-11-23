/** 合成数据验证页：选预设 → 生成透光/反射对 → CPU 流水线 → 对照真值。 */
import { h } from './dom';
import { SYNTHETIC_PRESETS, type SyntheticPreset } from '../core/synthetic';
import { runCpuPipeline } from '../core/pipeline-cpu';
import { DEFAULT_CONFIG } from '../core/types';
import type { SyntheticPair } from '../core/types';

function grayToCanvas(img: Float32Array, w: number, h: number, size = 220): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = Math.round(size * (h / w));
  const ctx = cv.getContext('2d')!;
  const out = ctx.createImageData(cv.width, cv.height);
  for (let oy = 0; oy < cv.height; oy++) {
    for (let ox = 0; ox < cv.width; ox++) {
      const sx = Math.min(w - 1, Math.floor((ox / cv.width) * w));
      const sy = Math.min(h - 1, Math.floor((oy / cv.height) * h));
      const v = Math.round(Math.min(1, Math.max(0, img[sy * w + sx])) * 255);
      const i = (oy * cv.width + ox) * 4;
      out.data[i] = out.data[i + 1] = out.data[i + 2] = v;
      out.data[i + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  return cv;
}

export function renderSyntheticPage(): HTMLElement {
  const logBox = h('div', { class: 'log' }, '选择预设后点击「生成并分析」。');
  const imgBox = h('div', { class: 'flex-two' });
  const resultBox = h('div');

  const presetSel = h('select') as HTMLSelectElement;
  for (const p of SYNTHETIC_PRESETS) {
    presetSel.append(h('option', { value: p.name }, p.name));
  }
  const dpiInput = h('input', { type: 'number', value: '600', min: '100', step: '50' }) as HTMLInputElement;
  const sizeInput = h('input', { type: 'number', value: '1024', min: '256', step: '256' }) as HTMLInputElement;
  const seedInput = h('input', { type: 'number', value: '20241124' }) as HTMLInputElement;

  function log(msg: string): void {
    logBox.textContent += `\n${msg}`;
    logBox.scrollTop = logBox.scrollHeight;
  }

  const runBtn = h('button', {
    class: 'btn',
    onclick: () => {
      const preset: SyntheticPreset =
        SYNTHETIC_PRESETS.find((p) => p.name === presetSel.value) ?? SYNTHETIC_PRESETS[0];
      const dpi = Number(dpiInput.value);
      const size = Number(sizeInput.value);
      const seed = Number(seedInput.value);
      logBox.textContent = `[${new Date().toLocaleTimeString()}] 生成 ${preset.name}（${size}², ${dpi}dpi, seed=${seed}）…`;
      setTimeout(() => {
        try {
          const pair: SyntheticPair = generatePair(preset, dpi, size, seed);
          imgBox.replaceChildren(
            wrapCanvas('透光图（灯箱）', grayToCanvas(pair.transmission, size, size)),
            wrapCanvas('反射光图', grayToCanvas(pair.reflection, size, size)),
          );
          const t0 = performance.now();
          const { record } = runCpuPipeline(
            pair.transmission, pair.reflection, size, size,
            { ...DEFAULT_CONFIG, fftSize: size, dpi },
          );
          const elapsed = performance.now() - t0;
          renderResult(resultBox, pair, record, elapsed);
          log(`完成，CPU 耗时 ${elapsed.toFixed(0)} ms；` +
            `帘纹 ${record.refinedLaid.periodMm.toFixed(3)}mm（真值 ${(pair.groundTruth.laidPeriodPx * 25.4 / dpi).toFixed(3)}mm）`);
        } catch (e) {
          log(`错误：${(e as Error).message}`);
        }
      }, 30);
    },
  }, '生成并分析');

  function generatePair(preset: SyntheticPreset, dpi: number, size: number, seed: number): SyntheticPair {
    return generateSynthetic({ seed, width: size, height: size, dpi, preset });
  }

  return h('div', {},
    h('div', { class: 'card' },
      h('h2', {}, '合成测试叶子'),
      h('div', { class: 'row' },
        h('label', { class: 'field' }, '预设', presetSel),
        h('label', { class: 'field' }, 'DPI', dpiInput),
        h('label', { class: 'field' }, '边长(px)', sizeInput),
        h('label', { class: 'field' }, '随机种子', seedInput),
        runBtn,
      ),
      h('p', { class: 'muted small' },
        '合成器同时产出透光/反射两张图，附全部真值（帘纹/纲线周期、方向、人为平移），用于检验测量误差。'),
    ),
    h('div', { class: 'card' }, h('h2', {}, '输入图像'), imgBox),
    h('div', { class: 'card' }, h('h2', {}, '测量结果 vs 真值'), resultBox),
    h('div', { class: 'card' }, h('h2', {}, '运行日志'), logBox),
  );
}

import { generateSyntheticPair as generateSynthetic } from '../core/synthetic';
import type { CpuPipelineResult } from '../core/pipeline-cpu';

function wrapCanvas(title: string, cv: HTMLCanvasElement): HTMLElement {
  return h('div', {}, h('div', { class: 'muted small' }, title), cv);
}

function renderResult(box: HTMLElement, pair: SyntheticPair, rec: CpuPipelineResult['record'], elapsed: number): void {
  const gtLaid = pair.groundTruth.laidPeriodPx * 25.4 / pair.groundTruth.dpi;
  const gtChain = pair.groundTruth.chainPeriodPx * 25.4 / pair.groundTruth.dpi;
  const laidErr = Math.abs(rec.refinedLaid.periodMm - gtLaid);
  const ok = laidErr <= 0.1;
  box.replaceChildren(
    h('div', { class: 'metric-grid' },
      metric('帘纹间距(mm)', rec.refinedLaid.periodMm.toFixed(3)),
      metric('帘纹真值(mm)', gtLaid.toFixed(3)),
      metric('误差(mm)', laidErr.toFixed(4), ok ? 'good' : 'bad'),
      metric('纲线间距(mm)', rec.chain ? rec.chain.periodMm.toFixed(2) : '未检出'),
      metric('纲线真值(mm)', gtChain.toFixed(2)),
      metric('方向角(°)', (rec.laid.orientationRad * 180 / Math.PI).toFixed(2)),
      metric('墨覆盖率', (rec.inkCoverage * 100).toFixed(1) + '%'),
      metric('配准相关', rec.registration.correlation.toFixed(3)),
      metric('CPU 耗时(ms)', elapsed.toFixed(0)),
    ),
    h('p', { class: 'small' },
      ok ? '✓ 帘纹间距误差 ≤ 0.1mm，达到人工精量精度要求。' : '✗ 误差超过 0.1mm，需检查图像质量或参数。'),
  );
}

function metric(k: string, v: string, tone?: 'good' | 'bad'): HTMLElement {
  return h('div', { class: 'metric' },
    h('div', { class: 'k' }, k),
    h('div', { class: `v ${tone === 'good' ? 'pill good' : tone === 'bad' ? 'pill bad' : ''}` }, v),
  );
}
