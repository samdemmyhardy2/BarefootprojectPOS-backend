import { PNG } from 'pngjs';

export type ThermalMode = 'auto' | 'sharp' | 'photo' | 'strokes';

export type ThermalImage = {
  width: number;
  height: number;
  /** 1 = black, MSB first. Same polarity as GS v 0. */
  bits: Uint8Array;
  mode: Exclude<ThermalMode, 'auto'>;
};

/** Printable head width for the saved printer. 203 DPI Epson heads are 384 or 576 dots. */
export function printableDots(paperWidthMm = 80, dpi = 203) {
  const narrow = paperWidthMm <= 58;
  if (dpi >= 190 && dpi <= 216) return narrow ? 384 : 576;
  const printableMm = narrow ? 48 : 72;
  const raw = Math.round((printableMm / 25.4) * dpi);
  const snapped = Math.max(8, raw - (raw % 8));
  return Math.min(narrow ? 640 : 1200, snapped);
}

/**
 * Grayscale, white background, Lanczos resize, then threshold or dither.
 * Bit 1 stays black. The image is not inverted, mirrored, or rotated.
 */
export function rasterizePng(png: Buffer, targetWidth: number, options?: { mode?: ThermalMode; maxSource?: number }) {
  const decoded = PNG.sync.read(png);
  const limit = options?.maxSource ?? 4000;
  if (!decoded.width || !decoded.height) throw new Error('Image is empty');
  if (decoded.width > limit || decoded.height > limit) throw new Error('Image is too large');
  const width = Math.max(8, targetWidth - (targetWidth % 8));
  const height = Math.max(1, Math.round(decoded.height * (width / decoded.width)));
  if (height > 20000) throw new Error('Image is too tall for the printer');
  const source = flatten(decoded);
  const gray = lanczos(source, decoded.width, decoded.height, width, height);
  const mode = options?.mode && options.mode !== 'auto' ? options.mode : chooseMode(gray);
  const bits = mode === 'photo'
    ? dither(contrast(gray, 1.18, 0), width, height)
    : mode === 'strokes'
      ? adaptive(contrast(gray, 1.35, -6), width, height)
      : threshold(contrast(gray, 1.22, 0), width, height);
  return { width, height, bits, mode } satisfies ThermalImage;
}

function flatten(decoded: PNG) {
  const gray = new Float32Array(decoded.width * decoded.height);
  for (let i = 0; i < gray.length; i += 1) {
    const index = i * 4;
    const alpha = decoded.data[index + 3] / 255;
    const red = decoded.data[index] * alpha + 255 * (1 - alpha);
    const green = decoded.data[index + 1] * alpha + 255 * (1 - alpha);
    const blue = decoded.data[index + 2] * alpha + 255 * (1 - alpha);
    gray[i] = red * 0.299 + green * 0.587 + blue * 0.114;
  }
  return gray;
}

function lanczos(source: Float32Array, srcW: number, srcH: number, dstW: number, dstH: number) {
  const a = 3;
  const tmp = new Float32Array(dstW * srcH);
  const xScale = srcW / dstW;
  for (let y = 0; y < srcH; y += 1) {
    for (let x = 0; x < dstW; x += 1) {
      const srcX = (x + 0.5) * xScale - 0.5;
      const start = Math.floor(srcX) - a + 1;
      const end = Math.floor(srcX) + a;
      let acc = 0;
      let norm = 0;
      for (let ix = start; ix <= end; ix += 1) {
        const weight = lanczosWeight(srcX - ix, a);
        if (!weight) continue;
        const sx = Math.min(srcW - 1, Math.max(0, ix));
        acc += source[y * srcW + sx] * weight;
        norm += weight;
      }
      tmp[y * dstW + x] = norm ? acc / norm : 255;
    }
  }
  const out = new Float32Array(dstW * dstH);
  const yScale = srcH / dstH;
  for (let y = 0; y < dstH; y += 1) {
    const srcY = (y + 0.5) * yScale - 0.5;
    const start = Math.floor(srcY) - a + 1;
    const end = Math.floor(srcY) + a;
    for (let x = 0; x < dstW; x += 1) {
      let acc = 0;
      let norm = 0;
      for (let iy = start; iy <= end; iy += 1) {
        const weight = lanczosWeight(srcY - iy, a);
        if (!weight) continue;
        const sy = Math.min(srcH - 1, Math.max(0, iy));
        acc += tmp[sy * dstW + x] * weight;
        norm += weight;
      }
      const value = norm ? acc / norm : 255;
      out[y * dstW + x] = value < 0 ? 0 : value > 255 ? 255 : value;
    }
  }
  return out;
}

function lanczosWeight(distance: number, radius: number) {
  const x = Math.abs(distance);
  if (x >= radius) return 0;
  if (x < 1e-6) return 1;
  const pix = Math.PI * x;
  return (Math.sin(pix) / pix) * (Math.sin(pix / radius) / (pix / radius));
}

function contrast(gray: Float32Array, amount: number, brightness: number) {
  const out = new Float32Array(gray.length);
  for (let i = 0; i < gray.length; i += 1) {
    const value = (gray[i] - 128) * amount + 128 + brightness;
    out[i] = value < 0 ? 0 : value > 255 ? 255 : value;
  }
  return out;
}

function chooseMode(gray: Float32Array): Exclude<ThermalMode, 'auto'> {
  let mid = 0;
  let dark = 0;
  for (const value of gray) {
    if (value < 50) dark += 1;
    else if (value < 205) mid += 1;
  }
  const total = gray.length || 1;
  if (mid / total > 0.22) return 'photo';
  if (dark / total < 0.08 && mid / total > 0 && mid / total < 0.2) return 'strokes';
  return 'sharp';
}

function threshold(gray: Float32Array, width: number, height: number) {
  const level = Math.min(236, otsu(gray) + 6);
  const bits = new Uint8Array((width / 8) * height);
  for (let i = 0; i < gray.length; i += 1) if (gray[i] <= level) bits[i >> 3] |= 0x80 >> (i & 7);
  return bits;
}

function otsu(gray: Float32Array) {
  const hist = new Array<number>(256).fill(0);
  for (const value of gray) hist[Math.max(0, Math.min(255, Math.round(value)))] += 1;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i += 1) sum += i * hist[i];
  let sumB = 0;
  let weightB = 0;
  let max = 0;
  let level = 128;
  for (let i = 0; i < 256; i += 1) {
    weightB += hist[i];
    if (!weightB) continue;
    const weightF = total - weightB;
    if (!weightF) break;
    sumB += i * hist[i];
    const meanB = sumB / weightB;
    const meanF = (sum - sumB) / weightF;
    const between = weightB * weightF * (meanB - meanF) ** 2;
    if (between > max) {
      max = between;
      level = i;
    }
  }
  return level;
}

function adaptive(gray: Float32Array, width: number, height: number) {
  const window = 21;
  const bias = 8;
  const stride = width + 1;
  const integral = new Float64Array(stride * (height + 1));
  for (let y = 1; y <= height; y += 1) {
    let row = 0;
    for (let x = 1; x <= width; x += 1) {
      row += gray[(y - 1) * width + (x - 1)];
      integral[y * stride + x] = integral[(y - 1) * stride + x] + row;
    }
  }
  const bits = new Uint8Array((width / 8) * height);
  const radius = (window - 1) >> 1;
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum = integral[(y1 + 1) * stride + (x1 + 1)] - integral[y0 * stride + (x1 + 1)] - integral[(y1 + 1) * stride + x0] + integral[y0 * stride + x0];
      if (gray[y * width + x] < sum / area - bias) bits[(y * width + x) >> 3] |= 0x80 >> ((y * width + x) & 7);
    }
  }
  return bits;
}

function dither(gray: Float32Array, width: number, height: number) {
  const work = Float32Array.from(gray);
  const bits = new Uint8Array((width / 8) * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const old = work[index];
      const black = old < 128;
      if (black) bits[index >> 3] |= 0x80 >> (index & 7);
      const error = old - (black ? 0 : 255);
      spread(work, width, height, x + 1, y, error * 7 / 16);
      spread(work, width, height, x - 1, y + 1, error * 3 / 16);
      spread(work, width, height, x, y + 1, error * 5 / 16);
      spread(work, width, height, x + 1, y + 1, error * 1 / 16);
    }
  }
  return bits;
}

function spread(work: Float32Array, width: number, height: number, x: number, y: number, amount: number) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const index = y * width + x;
  const value = work[index] + amount;
  work[index] = value < 0 ? 0 : value > 255 ? 255 : value;
}
