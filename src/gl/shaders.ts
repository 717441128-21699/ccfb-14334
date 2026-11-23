/**
 * 全部 GLSL ES 3.00 片元着色器（与 FULLSCREEN_VS 配合）。
 * 数据流纹理约定（统一使用可渲染的浮点格式）：
 *   RG32F  —— 灰度（R=数据，G=0）与复数（R=实部，G=虚部）
 *   RGBA8  —— 预览/导出
 */
import { FULLSCREEN_VS } from './gl-context';

/** 任意宽高源图 → N×N 中心方裁 + 区域降采样（edge clamp，双线性近似）。 */
export const DOWNSCALE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
uniform vec2 uSrcSize;
uniform float uN;
uniform vec2 uShift;   // 配准平移（源像素，作用于反射图）
void main() {
  float side = min(uSrcSize.x, uSrcSize.y);
  vec2 off = (uSrcSize - side) * 0.5;
  vec2 dst = vUv * uN;
  vec2 srcPos = off + (dst + 0.5) * (side / uN) - uShift;
  vec2 texel = 1.0 / uSrcSize;
  // 源与目标均为 RG32F，灰度在 R 通道（G/B 为 0），直接采样 .r
  float acc = 0.0;
  acc += texture(uSrc, (srcPos + vec2(-0.25, -0.25)) * texel).r;
  acc += texture(uSrc, (srcPos + vec2( 0.25, -0.25)) * texel).r;
  acc += texture(uSrc, (srcPos + vec2(-0.25,  0.25)) * texel).r;
  acc += texture(uSrc, (srcPos + vec2( 0.25,  0.25)) * texel).r;
  acc *= 0.25;
  // 输出到 RG32F：R=灰度，G=0
  outColor = vec4(clamp(acc, 0.0, 1.0), 0.0, 0.0, 1.0);
}`;

/** 可分离盒式模糊（水平/垂直由 uDir 选择）。 */
export const BOX_BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
uniform float uN;
uniform vec2 uDir;     // (1,0) 水平 / (0,1) 垂直
uniform int uRadius;
void main() {
  float acc = 0.0;
  float wsum = 0.0;
  for (int k = -64; k <= 64; k++) {
    if (k < -uRadius || k > uRadius) continue;
    vec2 uv = vUv + uDir * (float(k) / uN);
    acc += texture(uSrc, uv).r;
    wsum += 1.0;
  }
  outColor = vec4(acc / wsum, 0.0, 0.0, 1.0);
}`;

/** 64×64 平均降采样，用于在 CPU 上做统计与稳健回归。 */
export const STATS_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
uniform float uN;
void main() {
  vec2 dst = vUv * 64.0;
  float bin = uN / 64.0;
  float acc = 0.0;
  vec2 base = (dst + 0.5) * bin / uN;
  for (int iy = 0; iy < 8; iy++) {
    for (int ix = 0; ix < 8; ix++) {
      vec2 uv = base + (vec2(ix, iy) - 3.5) * (bin / 8.0) / uN;
      acc += texture(uSrc, uv).r;
    }
  }
  outColor = vec4(acc / 64.0, 0.0, 0.0, 1.0);
}`;

/**
 * 扣墨：软墨掩码 + 回归校正 + 归一化。
 * 统计量与回归系数在 CPU（64² 数据）上算好后以 uniform 传入。
 */
export const INK_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uT;        // 透光
uniform sampler2D uR;        // 已配准反射
uniform sampler2D uRBlur;    // 反射局部均值
uniform float uRMean;        // 反射全局均值
uniform float uRStd;         // 反射全局标准差
uniform float uSlope;        // Huber 回归斜率
uniform float uRMaskedMean;  // 墨区反射均值
uniform float uThreshold;
void main() {
  float t = texture(uT, vUv).r;
  float r = texture(uR, vUv).r;
  float rb = texture(uRBlur, vUv).r;
  float deficit = rb - r;
  // 与 CPU 版一致：相对局部背景暗度 12%~24% 线性过渡；硬掩码只看局部暗化
  float m = clamp((deficit / max(rb, 1e-3) - 0.12) / 0.12, 0.0, 1.0);
  float correction = uSlope * (r - uRMaskedMean) * m;
  float paper = t - correction;
  // RG32F：R=扣墨纸基，G=软墨掩码（硬掩码在 CPU 端由 m>0.6 重建）
  outColor = vec4(paper, m, 0.0, 1.0);
}`;

/** 输出归一化到 0..1（输入 R=paper，G=软掩码，均保留）。 */
export const NORMALIZE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
uniform float uMin;
uniform float uSpan;
void main() {
  vec2 v = texture(uSrc, vUv).rg;
  float paper = clamp((v.x - uMin) / max(uSpan, 1e-6) * 0.98 + 0.01, 0.0, 1.0);
  outColor = vec4(paper, v.y, 0.0, 1.0);
}`;

/** Hann 窗：灰度 RG32F（R 通道）→ 加窗复数 RG32F（虚部 G 置 0）。 */
export const HANN_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
void main() {
  float wx = 0.5 - 0.5 * cos(6.28318530718 * vUv.x);
  float wy = 0.5 - 0.5 * cos(6.28318530718 * vUv.y);
  outColor = vec4(texture(uSrc, vUv).r * wx * wy, 0.0, 0.0, 1.0);
}`;

/**
 * 位反转重排 pass（沿单一轴）。
 * 迭代 Cooley-Tukey DIT 要求输入先按位反转排列；水平/纵向各做一次。
 * uAxis=0 重排 x，uAxis=1 重排 y。
 */
export const FFT_BITREV_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
uniform float uN;
uniform int uAxis;
float bitReverse(float x, float bits) {
  float r = 0.0;
  for (int i = 0; i < 16; i++) {
    if (float(i) >= bits) break;
    r = r * 2.0 + mod(x, 2.0);
    x = floor(x / 2.0);
  }
  return r;
}
void main() {
  vec2 px = floor(vUv * uN);
  float bits = log2(uN);
  vec2 src = px;
  if (uAxis == 0) src.x = bitReverse(px.x, bits);
  else src.y = bitReverse(px.y, bits);
  outColor = vec4(texture(uSrc, (src + 0.5) / uN).rg, 0.0, 1.0);
}`;

/**
 * 迭代 Cooley-Tukey DIT 蝶形单级（输入已经位反转）。
 * uStage=0 对应 len=2，每级 len 翻倍；uDir=-1 正变换 / +1 逆变换。
 * 正变换不归一化（与 CPU 参考一致），逆变换归一化由 FREQ_FILTER 的 uInvN 处理。
 */
export const FFT_STAGE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
uniform float uN;
uniform int uStage;
uniform int uDir;
uniform int uAxis;
void main() {
  vec2 px = floor(vUv * uN);
  float len = exp2(float(uStage) + 1.0);
  float halfLen = len * 0.5;
  float coord = uAxis == 0 ? px.x : px.y;
  vec2 stride = uAxis == 0 ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  float groupStart = floor(coord / len) * len;
  float k = mod(coord, halfLen);
  vec2 uPos = px - stride * (coord - (groupStart + k));
  vec2 vPos = uPos + stride * halfLen;
  vec2 u = texture(uSrc, (uPos + 0.5) / uN).rg;
  vec2 v = texture(uSrc, (vPos + 0.5) / uN).rg;
  float ang = 6.28318530718 * float(uDir) * k / len;
  float co = cos(ang);
  float si = sin(ang);
  vec2 wv = vec2(v.r * co - v.g * si, v.r * si + v.g * co);
  vec2 result = coord < groupStart + halfLen ? (u + wv) : (u - wv);
  outColor = vec4(result, 0.0, 1.0);
}`;

/** 功率谱 |F|²（写入 RG32F 的 R 通道，G=0），自然序。 */
export const POWER_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
void main() {
  vec2 z = texture(uSrc, vUv).rg;
  outColor = vec4(dot(z, z), 0.0, 0.0, 1.0);
}`;

/** 频谱任意分辨率平均降采样（供 CPU 峰检测读回）。
 *  uCenter=1 时先做 N/2 象限平移，使输出为 DC 居中布局（与 CPU 约定一致）。 */
export const SPEC_DOWNSCALE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
uniform float uN;
uniform float uOut;
uniform int uCenter;
void main() {
  float bin = uN / uOut;
  vec2 dst = floor(vUv * uOut);
  // 输出（DC 居中）坐标 → 源（自然序）坐标：加 N/2 后回绕
  vec2 srcCoord = uCenter == 1
    ? mod((dst + 0.5) * bin + uN * 0.5, uN)
    : (dst + 0.5) * bin;
  vec2 base = srcCoord / uN;
  float acc = 0.0;
  for (int iy = 0; iy < 4; iy++) {
    for (int ix = 0; ix < 4; ix++) {
      vec2 uv = base + (vec2(ix, iy) - 1.5) * (bin / 4.0) / uN;
      acc += texture(uSrc, fract(uv)).r;
    }
  }
  outColor = vec4(acc / 16.0, 0.0, 0.0, 1.0);
}`;

/**
 * 频域高斯带通滤波 + 逆 FFT 归一化。
 * 峰坐标为 DC 居中系分数 bin（fx,fy）；同时保留共轭对。
 * uInvN = 1/N²（二维逆 FFT 归一化）。
 */
export const FREQ_FILTER_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
uniform float uN;
uniform vec2 uPeak1;   // DC 居中系
uniform vec2 uPeak2;   // 共轭
uniform float uSigma;
uniform float uInvN;
void main() {
  vec2 px = floor(vUv * uN);
  // uPeak1/uPeak2 均为 DC 居中系；本纹理是自然序，转到同一坐标系比较
  vec2 dc = mod(px + uN * 0.5, uN);
  float d1 = dot(dc - uPeak1, dc - uPeak1);
  float d2 = dot(dc - uPeak2, dc - uPeak2);
  float g = exp(-d1 / (2.0 * uSigma * uSigma))
          + exp(-d2 / (2.0 * uSigma * uSigma));
  vec2 z = texture(uSrc, vUv).rg;
  outColor = vec4(z * g * uInvN, 0.0, 1.0);
}`;

/** 复纹理取实部（R 通道），仍写 RG32F（G=0）。 */
export const REAL_PART_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
void main() {
  outColor = vec4(texture(uSrc, vUv).r, 0.0, 0.0, 1.0);
}`;

/** 残差：paper − laid − chain。 */
export const RESIDUAL_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uPaper;
uniform sampler2D uLaid;
uniform sampler2D uChain;
void main() {
  float v = texture(uPaper, vUv).r
          - texture(uLaid, vUv).r
          - texture(uChain, vUv).r;
  outColor = vec4(v, 0.0, 0.0, 1.0);
}`;

/** 浮点灰度 → RGBA8 预览（可选对数压缩与色带）。 */
export const PREVIEW_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
uniform int uMode;   // 0 线性灰度 1 对数频谱 2 掩码
uniform float uGain;
void main() {
  float v = texture(uSrc, vUv).r;
  if (uMode == 1) {
    v = log(v + 1e-9);
    v = (v - uGain) * 1.2 + 0.5;
  } else if (uMode == 2) {
    v = clamp(v, 0.0, 1.0);
  } else {
    v = clamp(v * uGain, 0.0, 1.0);
  }
  outColor = vec4(vec3(v), 1.0);
}`;

export const ALL_VERTEX = FULLSCREEN_VS;
