/** 浏览器图像 → R32F 灰度纹理的工具。 */

export interface LoadedImage {
  bitmap: ImageBitmap;
  width: number;
  height: number;
}

export async function loadImageFile(file: File): Promise<LoadedImage> {
  const bitmap = await createImageBitmap(file);
  return { bitmap, width: bitmap.width, height: bitmap.height };
}

/** 用 2D 画布把任意来源转为灰度 Float32Array（配准 CPU 读回用）。 */
export function imageToGrayFloat(img: ImageBitmap, maxSide?: number): {
  data: Float32Array;
  width: number;
  height: number;
} {
  let { width, height } = img;
  if (maxSide && Math.max(width, height) > maxSide) {
    const k = maxSide / Math.max(width, height);
    width = Math.round(width * k);
    height = Math.round(height * k);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx2d = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx2d.drawImage(img, 0, 0, width, height);
  const rgba = ctx2d.getImageData(0, 0, width, height).data;
  const gray = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    gray[i] = (rgba[i * 4] * 0.299 + rgba[i * 4 + 1] * 0.587 + rgba[i * 4 + 2] * 0.114) / 255;
  }
  return { data: gray, width, height };
}
