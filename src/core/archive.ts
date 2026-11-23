/**
 * 书册档案：按帘纹/纲线间距对叶子聚类，判断是否同批纸。
 * 档案为纯 JSON，可导出/导入长期保存。
 */
import type { BatchGroup, BookArchive, LeafRecord } from './types';

/**
 * 一维间隙聚类（Jenks 式的自然断点）：
 * 按帘纹间距排序，相邻间隙超过阈值即切群。
 * @param gapMm 切群阈值（毫米），默认 0.1mm —— 与测量误差同量级
 */
export function clusterLeaves(
  leaves: LeafRecord[],
  gapMm = 0.1,
  chainGapMm = 3,
): BatchGroup[] {
  if (leaves.length === 0) return [];
  const indexed = leaves
    .map((leaf, idx) => ({ leaf, idx, laid: leaf.refinedLaid.periodMm }))
    .sort((a, b) => a.laid - b.laid);

  const groups: Array<typeof indexed> = [];
  let current: typeof indexed = [indexed[0]];
  for (let i = 1; i < indexed.length; i++) {
    const gap = indexed[i].laid - indexed[i - 1].laid;
    if (gap > gapMm) {
      groups.push(current);
      current = [];
    }
    current.push(indexed[i]);
  }
  groups.push(current);

  // 最大群组为主批次；其余标记为离群（疑似换纸）
  const mainGroup = groups.reduce((a, b) => (b.length > a.length ? b : a));

  return groups.map((g, gi) => {
    const laidValues = g.map((e) => e.laid);
    const meanLaid = laidValues.reduce((s, v) => s + v, 0) / g.length;
    const stdLaid = Math.sqrt(
      laidValues.reduce((s, v) => s + (v - meanLaid) ** 2, 0) / g.length,
    );
    const chainValues = g
      .map((e) => e.leaf.chain?.periodMm)
      .filter((v): v is number => typeof v === 'number');
    const meanChain = chainValues.length
      ? chainValues.reduce((s, v) => s + v, 0) / chainValues.length
      : null;
    void chainGapMm;
    return {
      id: `批次-${gi + 1}`,
      leafIds: g.map((e) => e.leaf.leafId),
      meanLaidMm: meanLaid,
      stdLaidMm: stdLaid,
      meanChainMm: meanChain,
      outlier: g !== mainGroup,
    };
  });
}

export function buildArchive(
  bookId: string,
  leaves: LeafRecord[],
  config: BookArchive['config'],
): BookArchive {
  return {
    bookId,
    createdAt: new Date().toISOString(),
    config,
    leaves,
    batchGroups: clusterLeaves(leaves),
  };
}

export function archiveToJson(archive: BookArchive): string {
  return JSON.stringify(archive, null, 2);
}

export function archiveFromJson(json: string): BookArchive {
  const obj = JSON.parse(json) as BookArchive;
  if (!Array.isArray(obj.leaves)) throw new Error('档案格式无效：缺少 leaves 数组');
  return obj;
}

/** 全书汇总统计，供 UI 展示。 */
export function archiveSummary(archive: BookArchive): {
  leafCount: number;
  groupCount: number;
  outlierLeaves: string[];
  meanLaidMm: number | null;
  meanChainMm: number | null;
} {
  const leaves = archive.leaves;
  if (!leaves.length) {
    return { leafCount: 0, groupCount: 0, outlierLeaves: [], meanLaidMm: null, meanChainMm: null };
  }
  const meanLaid = leaves.reduce((s, l) => s + l.refinedLaid.periodMm, 0) / leaves.length;
  const chains = leaves.map((l) => l.chain?.periodMm).filter((v): v is number => v != null);
  const meanChain = chains.length ? chains.reduce((s, v) => s + v, 0) / chains.length : null;
  return {
    leafCount: leaves.length,
    groupCount: archive.batchGroups.length,
    outlierLeaves: archive.batchGroups.filter((g) => g.outlier).flatMap((g) => g.leafIds),
    meanLaidMm: meanLaid,
    meanChainMm: meanChain,
  };
}
