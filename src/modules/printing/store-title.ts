import { PNG } from 'pngjs';
import { rasterBands } from './escpos';
import { titleFont } from './store-title-font';

type Glyph = { advance: number; left: number; top: number; w: number; h: number; ax: number };

export type StoreTitle = { width: number; height: number; bits: Uint8Array; escpos: Buffer };

const glyphs = new Map<string, Glyph>(titleFont.glyphs.map((glyph) => [glyph.ch, glyph]));
let atlas: PNG | null = null;

function sourceImage() {
  if (!atlas) atlas = PNG.sync.read(Buffer.from(titleFont.png, 'base64'));
  return atlas;
}

/** Raster only the store name. Other receipt text stays on the printer font. */
export function renderStoreTitle(text: string, maxWidth: number, targetHeight: number): StoreTitle | null {
  const clean = text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean || maxWidth < 16 || targetHeight < 12) return null;
  if ([...clean].some((character) => !glyphs.has(character))) return null;
  const source = compose(clean);
  const fitted = fit(source, Math.min(maxWidth, 1200), targetHeight);
  if (!fitted) return null;
  return { ...fitted, escpos: rasterBands(fitted.bits, fitted.width, fitted.height) };
}

function compose(text: string) {
  const image = sourceImage();
  let width = 0;
  let previous = '';
  const placed: Array<{ glyph: Glyph; x: number }> = [];
  for (const character of text) {
    const glyph = glyphs.get(character);
    if (!glyph) continue;
    const kern = titleFont.kern[`${previous}${character}`] ?? 0;
    placed.push({ glyph, x: width + kern });
    width += kern + glyph.advance;
    previous = character;
  }
  const height = titleFont.ascent + titleFont.descent;
  const gray = new Uint8Array(Math.max(1, width) * height).fill(255);
  for (const { glyph, x } of placed) {
    for (let y = 0; y < glyph.h; y += 1) {
      const destY = titleFont.ascent + glyph.top + y;
      if (destY < 0 || destY >= height) continue;
      for (let column = 0; column < glyph.w; column += 1) {
        const destX = x + glyph.left + column;
        if (destX < 0 || destX >= width) continue;
        const ink = image.data[((y * image.width) + glyph.ax + column) * 4];
        const index = destY * width + destX;
        if (ink < gray[index]) gray[index] = ink;
      }
    }
  }
  return { gray, width: Math.max(1, width), height };
}

function fit(source: { gray: Uint8Array; width: number; height: number }, maxWidth: number, targetHeight: number) {
  const trimmed = cropVertical(source.gray, source.width);
  if (!trimmed) return null;
  let scale = targetHeight / trimmed.height;
  if (trimmed.width * scale > maxWidth) scale = maxWidth / trimmed.width;
  const width = Math.max(8, Math.min(maxWidth, Math.round(trimmed.width * scale)));
  const height = Math.max(8, Math.round(trimmed.height * scale));
  return pack(downsample(trimmed.gray, trimmed.width, trimmed.height, width, height), width, height);
}

function downsample(source: Uint8Array, sourceWidth: number, sourceHeight: number, width: number, height: number) {
  const gray = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const top = (y * sourceHeight) / height;
    const bottom = ((y + 1) * sourceHeight) / height;
    for (let x = 0; x < width; x += 1) {
      const left = (x * sourceWidth) / width;
      const right = ((x + 1) * sourceWidth) / width;
      let total = 0;
      let weight = 0;
      for (let sy = Math.floor(top); sy <= Math.min(sourceHeight - 1, Math.ceil(bottom) - 1); sy += 1) {
        const spanY = Math.min(bottom, sy + 1) - Math.max(top, sy);
        if (spanY <= 0) continue;
        for (let sx = Math.floor(left); sx <= Math.min(sourceWidth - 1, Math.ceil(right) - 1); sx += 1) {
          const spanX = Math.min(right, sx + 1) - Math.max(left, sx);
          if (spanX <= 0) continue;
          const area = spanX * spanY;
          total += source[sy * sourceWidth + sx] * area;
          weight += area;
        }
      }
      gray[y * width + x] = weight ? Math.round(total / weight) : 255;
    }
  }
  return gray;
}

function cropVertical(gray: Uint8Array, width: number) {
  const height = gray.length / width;
  let top = 0;
  let bottom = height - 1;
  const blank = (y: number) => {
    for (let x = 0; x < width; x += 1) if (gray[y * width + x] < 230) return false;
    return true;
  };
  while (top < bottom && blank(top)) top += 1;
  while (bottom > top && blank(bottom)) bottom -= 1;
  if (blank(top)) return null;
  top = Math.max(0, top - 1);
  bottom = Math.min(height - 1, bottom + 1);
  const rows = bottom - top + 1;
  return { gray: gray.subarray(top * width, (bottom + 1) * width), width, height: rows };
}

function pack(gray: Uint8Array, width: number, height: number) {
  const padded = width + ((8 - (width % 8)) % 8);
  const inset = Math.floor((padded - width) / 2);
  const bits = new Uint8Array((padded / 8) * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (gray[y * width + x] >= 168) continue;
      const pixel = x + inset;
      bits[(y * (padded / 8)) + (pixel >> 3)] |= 0x80 >> (pixel & 7);
    }
  }
  return { bits, width: padded, height };
}
