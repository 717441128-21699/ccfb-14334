import { describe, expect, it } from 'vitest';
import { buildArchive, clusterLeaves, archiveToJson, archiveFromJson } from '../src/core/archive';
import { DEFAULT_CONFIG, type LeafRecord, type PeakInfo } from '../src/core/types';

function makeLeaf(id: string, laidMm: number, chainMm = 30): LeafRecord {
  const peak: PeakInfo = {
    binX: 10, binY: 2, frequencyPx: 0.01, orientationRad: 0.3,
    periodPx: 100, periodMm: laidMm, strength: 3, confidence: 0.9,
  };
  return {
    leafId: id,
    timestamp: new Date(0).toISOString(),
    imageSize: { width: 1024, height: 1024 },
    registration: { shiftX: 0, shiftY: 0, correlation: 0.9 },
    inkCoverage: 0.1,
    laid: peak,
    chain: { ...peak, periodMm: chainMm },
    refinedLaid: { periodPx: laidMm * 24, periodMm: laidMm, strength: 0.8 },
    uniformity: { meanTransmission: 0.5, std: 0.05, localCv: 0.1, gradientEnergy: 0.01 },
    effectiveDpi: 600,
    fftSize: 1024,
    elapsedMs: 100,
  };
}

describe('档案与同批纸聚类', () => {
  it('按 0.1mm 间隙切群，少数群组标记为离群', () => {
    const leaves = [
      makeLeaf('a1', 1.40), makeLeaf('a2', 1.43), makeLeaf('a3', 1.46),
      makeLeaf('a4', 1.42), makeLeaf('a5', 1.45),
      makeLeaf('b1', 2.10), makeLeaf('b2', 2.13),
    ];
    const groups = clusterLeaves(leaves);
    expect(groups).toHaveLength(2);
    const main = groups.find((g) => !g.outlier)!;
    const out = groups.find((g) => g.outlier)!;
    expect(main.leafIds).toContain('a1');
    expect(out.leafIds).toEqual(['b1', 'b2']);
    expect(main.meanLaidMm).toBeCloseTo(1.432, 2);
  });

  it('全部同批时只有一个群组且无离群', () => {
    const leaves = [makeLeaf('a', 1.4), makeLeaf('b', 1.42), makeLeaf('c', 1.41)];
    const groups = clusterLeaves(leaves);
    expect(groups).toHaveLength(1);
    expect(groups[0].outlier).toBe(false);
  });

  it('档案 JSON 可往返序列化', () => {
    const archive = buildArchive('test-book', [makeLeaf('a', 1.4)], DEFAULT_CONFIG);
    const json = archiveToJson(archive);
    const back = archiveFromJson(json);
    expect(back.bookId).toBe('test-book');
    expect(back.leaves[0].refinedLaid.periodMm).toBe(1.4);
    expect(back.batchGroups).toHaveLength(1);
  });
});
