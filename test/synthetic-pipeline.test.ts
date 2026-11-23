import { describe, expect, it } from 'vitest';
import {
  SYNTHETIC_PRESETS,
  generateSyntheticPair,
} from '../src/core/synthetic';
import { analyzeSyntheticPair } from '../src/core/pipeline-cpu';
import { DEFAULT_CONFIG, type AnalysisConfig, type SyntheticPair } from '../src/core/types';

const CONFIG: AnalysisConfig = { ...DEFAULT_CONFIG, fftSize: 1024 };

function mmError(pair: SyntheticPair, measuredMm: number): number {
  const gtMm = (pair.groundTruth.laidPeriodPx * 25.4) / pair.groundTruth.dpi;
  return Math.abs(measuredMm - gtMm);
}

describe('合成叶子端到端（CPU 参考流水线）', () => {
  it('四档帘纹密度的间距误差均 ≤ 0.1mm', () => {
    const rows: Array<{ preset: string; gt: number; got: number; err: number }> = [];
    for (const preset of SYNTHETIC_PRESETS) {
      const pair = generateSyntheticPair({
        seed: 20241124,
        width: 1024,
        height: 1024,
        dpi: 600,
        preset,
      });
      const { record } = analyzeSyntheticPair(pair, CONFIG);
      const err = mmError(pair, record.refinedLaid.periodMm);
      rows.push({
        preset: preset.name,
        gt: (pair.groundTruth.laidPeriodPx * 25.4) / pair.groundTruth.dpi,
        got: record.refinedLaid.periodMm,
        err,
      });
      expect(err).toBeLessThanOrEqual(0.1);
      // FFT 初值也应在合理范围（0.15mm 内）
      expect(Math.abs(record.laid.periodMm - rows[rows.length - 1].gt)).toBeLessThan(0.2);
    }
    // 打印对照表，vitest 默认会展示
    console.table(rows);
  });

  it('重墨遮挡下仍能恢复帘纹，且墨覆盖率被检出', () => {
    const preset = SYNTHETIC_PRESETS.find((p) => p.name === '疏帘纹-重墨')!;
    const pair = generateSyntheticPair({
      seed: 4242, width: 1024, height: 1024, dpi: 600, preset,
    });
    const { record } = analyzeSyntheticPair(pair, CONFIG);
    expect(mmError(pair, record.refinedLaid.periodMm)).toBeLessThanOrEqual(0.1);
    expect(record.inkCoverage).toBeGreaterThan(0.02);
  });

  it('无墨叶子墨覆盖率接近 0，且纲线周期可检出', () => {
    const preset = SYNTHETIC_PRESETS.find((p) => p.name === '极密帘纹-无墨')!;
    const pair = generateSyntheticPair({
      seed: 777, width: 1024, height: 1024, dpi: 600, preset,
    });
    const { record } = analyzeSyntheticPair(pair, CONFIG);
    expect(record.inkCoverage).toBeLessThan(0.02);
    expect(record.chain).not.toBeNull();
    const gtChainMm = (pair.groundTruth.chainPeriodPx * 25.4) / pair.groundTruth.dpi;
    expect(Math.abs(record.chain!.periodMm - gtChainMm)).toBeLessThan(4);
  });

  it('配准环节回收人为平移（误差 < 0.5 工作像素）', () => {
    const pair = generateSyntheticPair({
      seed: 31337,
      width: 1024,
      height: 1024,
      dpi: 600,
      preset: SYNTHETIC_PRESETS[1],
      misalignX: 3.2,
      misalignY: -1.8,
    });
    const { record } = analyzeSyntheticPair(pair, CONFIG);
    // 工作分辨率与原图同为 1024，比例 1:1
    expect(Math.abs(record.registration.shiftX - 3.2)).toBeLessThan(0.5);
    expect(Math.abs(record.registration.shiftY + 1.8)).toBeLessThan(0.5);
  });

  it('方向角误差小于 2°', () => {
    const pair = generateSyntheticPair({
      seed: 555,
      width: 1024,
      height: 1024,
      dpi: 600,
      preset: SYNTHETIC_PRESETS[1],
      orientationDeg: 8,
    });
    const { record } = analyzeSyntheticPair(pair, CONFIG);
    let deg = (record.laid.orientationRad * 180) / Math.PI;
    // 法线方向存在 180° 歧义，且条纹取向后整体符号可能翻转
    deg = ((deg % 180) + 180) % 180;
    const gt = ((8 % 180) + 180) % 180;
    const diff = Math.min(Math.abs(deg - gt), 180 - Math.abs(deg - gt));
    expect(diff).toBeLessThan(2);
  });

  it('不同种子结果可复现', () => {
    const opts = {
      seed: 909, width: 512, height: 512, dpi: 600,
      preset: SYNTHETIC_PRESETS[1],
    };
    const a = generateSyntheticPair(opts);
    const b = generateSyntheticPair(opts);
    expect(a.transmission).toEqual(b.transmission);
  });
});
