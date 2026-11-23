/**
 * 全局共享类型与默认参数。
 * 所有长度在内部以「工作像素」表示，仅在输出时经 dpi 换算为毫米。
 */

export interface AnalysisConfig {
  /** 拍摄/扫描分辨率（像素/英寸）。毫米 = 像素 × 25.4 / dpi */
  dpi: number;
  /** FFT 工作边长（2 的幂）。原图先降采样到该尺寸再入频域 */
  fftSize: number;
  /** 帘纹间距合理范围（毫米），用于限定自相关 lag 窗口与频谱环带搜索。
   *  手工纸帘纹常见 0.5~3mm；下限放宽到 0.4 以兼容极密帘纹，同时排除
   *  近奈奎斯特的栅格化混叠高频 */
  laidPeriodMmRange: [number, number];
  /** 纲线间距合理范围（毫米） */
  chainPeriodMmRange: [number, number];
  /** 稳健回归 Huber 阈值（残差标准差倍数） */
  huberDelta: number;
  /** 频域分离掩码相对峰宽的高斯 σ（单位：bin） */
  maskSigmaBins: number;
  /** 帘纹方向先验（弧度，可选）。不给则由频谱自动判定 */
  orientationHint?: number;
}

export const DEFAULT_CONFIG: AnalysisConfig = {
  dpi: 600,
  fftSize: 2048,
  laidPeriodMmRange: [0.4, 3.0],
  chainPeriodMmRange: [15, 80],
  huberDelta: 1.345,
  maskSigmaBins: 1.6,
};

/** 频谱峰信息（bin 为插值后的分数坐标，已平移到以 DC 为中心的坐标系） */
export interface PeakInfo {
  binX: number;
  binY: number;
  /** 周/像素 */
  frequencyPx: number;
  /** 峰方向角 = 条纹法线方向（弧度） */
  orientationRad: number;
  periodPx: number;
  periodMm: number;
  /** 径向背景归一化后的峰高 */
  strength: number;
  /** 0..1 的可信程度 */
  confidence: number;
}

export interface UniformityMetrics {
  /** 纸基平均透光（0..1） */
  meanTransmission: number;
  /** 扣墨、去周期分量后的整体标准差 */
  std: number;
  /** 局部变异系数：局部块标准差均值 / 全局均值 */
  localCv: number;
  /** 大尺度不均：模糊后 Sobel 梯度能量均值 */
  gradientEnergy: number;
}

export interface RegistrationResult {
  /** 需要作用于反射图的平移（工作像素） */
  shiftX: number;
  shiftY: number;
  /** 相位相关峰高，0..1 */
  correlation: number;
}

export interface LeafRecord {
  leafId: string;
  files?: { transmission?: string; reflection?: string };
  timestamp: string;
  imageSize: { width: number; height: number };
  registration: RegistrationResult;
  /** 墨字与污渍覆盖比例（0..1） */
  inkCoverage: number;
  laid: PeakInfo;
  chain: PeakInfo | null;
  /** 自相关精修后的帘纹周期（工作像素 / 毫米） */
  refinedLaid: { periodPx: number; periodMm: number; strength: number };
  uniformity: UniformityMetrics;
  effectiveDpi: number;
  fftSize: number;
  elapsedMs: number;
  notes?: string;
}

export interface BatchGroup {
  id: string;
  leafIds: string[];
  meanLaidMm: number;
  stdLaidMm: number;
  meanChainMm: number | null;
  /** 相对主群组是否为离群叶（疑似不同批纸） */
  outlier: boolean;
}

export interface BookArchive {
  bookId: string;
  createdAt: string;
  config: AnalysisConfig;
  leaves: LeafRecord[];
  batchGroups: BatchGroup[];
}

export interface SyntheticGroundTruth {
  seed: number;
  dpi: number;
  width: number;
  height: number;
  /** 生成时的真实帘纹/纲线周期（原始像素）与方向（度） */
  laidPeriodPx: number;
  chainPeriodPx: number;
  orientationDeg: number;
  /** 反射图相对透光图的人为平移（像素） */
  misalignX: number;
  misalignY: number;
  preset: string;
}

export interface SyntheticPair {
  transmission: Float32Array;
  reflection: Float32Array;
  width: number;
  height: number;
  groundTruth: SyntheticGroundTruth;
}
