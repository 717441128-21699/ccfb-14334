/** 书册档案页：逐叶记录表格、同批纸聚类、JSON 导入导出。 */
import { h } from './dom';
import { archiveFromJson, archiveSummary, archiveToJson } from '../core/archive';
import type { AppStore } from './store';

export function renderArchivePage(store: AppStore): HTMLElement {
  const tableBox = h('div');
  const summaryBox = h('div');

  function refresh(): void {
    const archive = store.buildArchive();
    const summary = archiveSummary(archive);

    summaryBox.replaceChildren(
      h('div', { class: 'metric-grid' },
        metric('叶子数', String(summary.leafCount)),
        metric('纸张批次数', String(summary.groupCount)),
        metric('全书均帘纹', summary.meanLaidMm ? `${summary.meanLaidMm.toFixed(3)} mm` : '—'),
        metric('全书均纲线', summary.meanChainMm ? `${summary.meanChainMm.toFixed(2)} mm` : '—'),
        metric('离群叶数', String(summary.outlierLeaves.length), summary.outlierLeaves.length ? 'bad' : 'good'),
      ),
    );

    if (store.leaves.length === 0) {
      tableBox.replaceChildren(h('p', { class: 'muted' }, '尚无叶子记录。'));
      return;
    }

    const rows = store.leaves.map((leaf) => {
      const group = archive.batchGroups.find((g) => g.leafIds.includes(leaf.leafId));
      return h('tr', {},
        h('td', {}, leaf.leafId),
        h('td', { class: 'num' }, leaf.refinedLaid.periodMm.toFixed(3)),
        h('td', { class: 'num' }, leaf.chain ? leaf.chain.periodMm.toFixed(2) : '—'),
        h('td', { class: 'num' }, (leaf.laid.orientationRad * 180 / Math.PI).toFixed(1)),
        h('td', { class: 'num' }, (leaf.inkCoverage * 100).toFixed(1) + '%'),
        h('td', { class: 'num' }, leaf.uniformity.localCv.toFixed(3)),
        h('td', {}, h('span', { class: `pill ${group?.outlier ? 'bad' : 'good'}` }, group?.id ?? '—')),
        h('td', {}, h('button', {
          class: 'btn secondary small',
          onclick: () => store.removeLeaf(leaf.leafId),
        }, '删除')),
      );
    });

    tableBox.replaceChildren(
      h('table', {},
        h('thead', {}, h('tr', {},
          h('th', {}, '叶编号'),
          h('th', { class: 'num' }, '帘纹(mm)'),
          h('th', { class: 'num' }, '纲线(mm)'),
          h('th', { class: 'num' }, '方向(°)'),
          h('th', { class: 'num' }, '墨覆盖'),
          h('th', { class: 'num' }, '透光CV'),
          h('th', {}, '批次判定'),
          h('th', {}, ''))),
        h('tbody', {}, ...rows)),
      h('h3', { class: 'small' }, '批次说明'),
      h('p', { class: 'muted small' },
        '按帘纹间距排序后做自然断点聚类（相邻间隙 >0.1mm 切群）。最大群组为主批次，其余标记为离群，提示该叶可能换用了不同批的纸。'),
    );
  }

  store.subscribe(refresh);

  const exportBtn = h('button', {
    class: 'btn secondary',
    onclick: () => {
      const blob = new Blob([archiveToJson(store.buildArchive())], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${store.bookId || 'book'}-archive.json`;
      a.click();
      URL.revokeObjectURL(url);
    },
  }, '导出档案 JSON');

  const importBtn = h('button', {
    class: 'btn secondary',
    onclick: () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json';
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) return;
        file.text().then((txt) => {
          const obj = archiveFromJson(txt);
          store.bookId = obj.bookId;
          store.leaves = obj.leaves;
          store.config = obj.config;
          store.save();
          refresh();
        });
      };
      input.click();
    },
  }, '导入档案');

  const clearBtn = h('button', { class: 'btn secondary', onclick: () => store.clear() }, '清空');

  refresh();

  return h('div', {},
    h('div', { class: 'card' },
      h('h2', {}, '全书汇总'),
      summaryBox,
      h('div', { class: 'row', style: 'margin-top:14px' }, exportBtn, importBtn, clearBtn)),
    h('div', { class: 'card' }, h('h2', {}, '逐叶记录与同批纸判定'), tableBox),
  );
}

function metric(k: string, v: string, tone?: 'good' | 'bad'): HTMLElement {
  return h('div', { class: 'metric' },
    h('div', { class: 'k' }, k),
    h('div', { class: `v ${tone === 'good' ? 'pill good' : tone === 'bad' ? 'pill bad' : ''}` }, v));
}
