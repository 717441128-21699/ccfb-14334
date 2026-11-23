import './styles.css';
import { h, mount } from './dom';
import { AppStore } from './store';
import { DEFAULT_CONFIG } from '../core/types';
import { GLContext } from '../gl/gl-context';
import { GpuPaperPipeline } from '../gl/gpu-pipeline';
import { renderLeafPage } from './page-leaf';
import { renderSyntheticPage } from './page-synthetic';
import { renderGpuCheckPage } from './page-gpu-check';
import { renderTimingPage } from './page-timing';
import { renderArchivePage } from './page-archive';

const store = new AppStore(DEFAULT_CONFIG);
store.load();

// 全局共享一个离屏 WebGL2 上下文（所有 GPU 页复用）
const glCanvas = document.createElement('canvas');
glCanvas.width = DEFAULT_CONFIG.fftSize;
glCanvas.height = DEFAULT_CONFIG.fftSize;
let gl: { ctx: GLContext; pipe: GpuPaperPipeline } | null = null;
try {
  const ctx = new GLContext(glCanvas);
  const pipe = new GpuPaperPipeline(ctx);
  gl = { ctx, pipe };
} catch (e) {
  console.warn('WebGL2 初始化失败，GPU 页面将报错提示：', e);
}

const tabs: Array<{ id: string; label: string; render: () => HTMLElement }> = [
  { id: 'leaf', label: '实叶分析', render: () => renderLeafPage(store, () => gl) },
  { id: 'synthetic', label: '合成验证', render: renderSyntheticPage },
  { id: 'gpu', label: 'GPU/CPU 校验', render: renderGpuCheckPage },
  { id: 'timing', label: '性能计时', render: renderTimingPage },
  { id: 'archive', label: '书册档案', render: () => renderArchivePage(store) },
];

let active = 'synthetic'; // 默认进合成验证页，打开即可见可运行演示

function renderApp(): void {
  const nav = h('nav', { class: 'tabs' },
    ...tabs.map((t) => h('button', {
      class: t.id === active ? 'active' : '',
      onclick: () => { active = t.id; renderApp(); },
    }, t.label)),
  );
  const current = tabs.find((t) => t.id === active)!;
  const root = h('div', {},
    h('header', { class: 'app' },
      h('h1', {}, '帘纹分析 · 古籍纸张断代辅助系统'),
      h('span', { class: 'sub' }, gl
        ? `WebGL2 就绪 · ${gl.ctx.caps.renderer}`
        : 'WebGL2 不可用（仅 CPU 合成验证可用）')),
    nav,
    h('main', {}, current.render()),
  );
  mount(root);
}

renderApp();
