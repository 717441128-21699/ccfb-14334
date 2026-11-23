/** 实叶分析页：上传透光/反射两张图，走 GPU 流水线并把记录写入书册档案。 */
import { h } from './dom';
import { imageToGrayFloat } from '../gl/image-utils';
import { GLContext } from '../gl/gl-context';
import { GpuPaperPipeline } from '../gl/gpu-pipeline';
import { DEFAULT_CONFIG, type LeafRecord } from '../core/types';
import type { AppStore } from './store';

interface PickedFile {
  file: File;
  bitmap: ImageBitmap;
}

export function renderLeafPage(store: AppStore, getGl: () => { ctx: GLContext; pipe: GpuPaperPipeline } | null): HTMLElement {
  const logBox = h('div', { class: 'log' }, '先分别选择透光图与反射光图（同尺寸、同朝向）。');
  const resultBox = h('div');
  let transmission: PickedFile | null = null;
  let reflection: PickedFile | null = null;

  const leafIdInput = h('input', { value: `leaf-${String(store.leaves.length + 1).padStart(3, '0')}` }) as HTMLInputElement;
  const dpiInput = h('input', { type: 'number', value: String(store.config.dpi) }) as HTMLInputElement;

  function log(m: string): void {
    logBox.textContent += `\n[${new Date().toLocaleTimeString()}] ${m}`;
    logBox.scrollTop = logBox.scrollHeight;
  }

  async function pick(label: string): Promise<PickedFile | null> {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return resolve(null);
        const bitmap = await createImageBitmap(file);
        log(`${label}：${file.name}（${bitmap.width}×${bitmap.height}）`);
        resolve({ file, bitmap });
      };
      input.click();
    });
  }

  const tBtn = h('button', { class: 'btn secondary', onclick: async () => { transmission = await pick('透光图'); } }, '选择透光图');
  const rBtn = h('button', { class: 'btn secondary', onclick: async () => { reflection = await pick('反射图'); } }, '选择反射光图');

  const runBtn = h('button', {
    class: 'btn',
    onclick: () => {
      if (!transmission || !reflection) {
        log('请先选择两张图。');
        return;
      }
      const gl = getGl();
      if (!gl) {
        log('WebGL2 未就绪。');
        return;
      }
      try {
        const dpi = Number(dpiInput.value) || DEFAULT_CONFIG.dpi;
        const { width, height } = transmission.bitmap;
        log('转灰度并上传 GPU…');
        const tGray = imageToGrayFloat(transmission.bitmap);
        const rGray = imageToGrayFloat(reflection.bitmap);
        const t0 = performance.now();
        const { record } = gl.pipe.run(tGray.data, rGray.data, tGray.width, tGray.height, {
          ...DEFAULT_CONFIG, dpi, fftSize: DEFAULT_CONFIG.fftSize,
        });
        const elapsed = performance.now() - t0;
        const leaf: LeafRecord = {
          ...record,
          leafId: leafIdInput.value || `leaf-${store.leaves.length + 1}`,
          timestamp: new Date().toISOString(),
          files: {
            transmission: transmission.file.name,
            reflection: reflection.file.name,
          },
          elapsedMs: elapsed,
        };
        store.addLeaf(leaf);
        store.save();
        renderResult(resultBox, leaf);
        log(`完成：帘纹 ${leaf.refinedLaid.periodMm.toFixed(3)}mm，纲线 ${leaf.chain ? leaf.chain.periodMm.toFixed(2) : '未检出'}mm，耗时 ${elapsed.toFixed(0)}ms`);
      } catch (e) {
        log(`错误：${(e as Error).message}`);
      }
    },
  }, '分析此叶');

  return h('div', {},
    h('div', { class: 'card' },
      h('h2', {}, '单叶分析'),
      h('div', { class: 'row' },
        h('label', { class: 'field' }, '叶编号', leafIdInput),
        h('label', { class: 'field' }, '扫描 DPI', dpiInput),
        tBtn, rBtn, runBtn),
      h('p', { class: 'muted small' },
        '流程：相位相关配准 → 反射图扣墨 → 空间域帘纹/纲线测定 → 频域分量分离 → 透光均匀度。结果自动存入书册档案。'),
    ),
    h('div', { class: 'card' }, h('h2', {}, '本叶结果'), resultBox),
    h('div', { class: 'card' }, h('h2', {}, '日志'), logBox),
  );
}

function renderResult(box: HTMLElement, rec: LeafRecord): void {
  box.replaceChildren(
    h('div', { class: 'metric-grid' },
      metric('帘纹间距', `${rec.refinedLaid.periodMm.toFixed(3)} mm`),
      metric('纲线间距', rec.chain ? `${rec.chain.periodMm.toFixed(2)} mm` : '未检出'),
      metric('帘纹方向', `${(rec.laid.orientationRad * 180 / Math.PI).toFixed(2)}°`),
      metric('墨覆盖率', `${(rec.inkCoverage * 100).toFixed(1)}%`),
      metric('透光均值', rec.uniformity.meanTransmission.toFixed(3)),
      metric('局部变异 CV', rec.uniformity.localCv.toFixed(3)),
      metric('配准相关', rec.registration.correlation.toFixed(3)),
      metric('耗时', `${rec.elapsedMs.toFixed(0)} ms`),
    ),
  );
}

function metric(k: string, v: string): HTMLElement {
  return h('div', { class: 'metric' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
}
